import type { NotificationService } from './notifications.js';
import type { Ctx } from './context.js';
import { fail, invalid, newId } from './context.js';
import { nowIso, type DocRecord, type ResourceGrant } from './repo.js';
import { permissionFlags, resourceRole, validateGrant, type ResourceRole } from './resource-access.js';
import { SPACE, toResourceRole, wikiPageOf, wikiRole } from './wiki-access.js';

export async function docGrant(ctx: Ctx, doc: DocRecord): Promise<ResourceGrant> {
  return (await ctx.repo.getResourceGrant('doc', doc.doc_id)) ?? {
    resource_type: 'doc', resource_id: doc.doc_id, owner_id: doc.created_by,
    visibility: 'org_view', members: [], version: 0,
  };
}
/** 不考虑回收站的真实权限（只给回收站列表、恢复、彻底删除用）。 */
export async function rawDocAccess(ctx: Ctx, doc: DocRecord, userId: string) {
  const grant = await docGrant(ctx, doc);
  let role = await resourceRole(ctx.repo, userId, grant);
  // 知识库页面：权限继承空间，文档自己的协作者不生效，只保留链接分享（R-WK-03）
  const page = await wikiPageOf(ctx, doc.doc_id);
  if (page) {
    const ranks: Record<ResourceRole, number> = { viewer: 1, commenter: 2, editor: 3, manager: 4 };
    const w = await wikiRole(ctx, page.space_id, userId);
    const user = await ctx.repo.getUser(userId);
    const link: ResourceRole | null = !user || user.disabled || user.role === 'bot' ? null : grant.visibility === 'org_edit' ? 'editor' : grant.visibility === 'org_view' ? 'viewer' : null;
    const sys: ResourceRole | null = user?.role === 'admin' ? 'manager' : null;
    role = [w ? toResourceRole(w) : null, link, sys].reduce<ResourceRole | null>((a, b) => (b && (!a || ranks[b] > ranks[a]) ? b : a), null);
  }
  return { owner_id: grant.owner_id, my_role: role, permissions: permissionFlags(role), can_edit: permissionFlags(role).can_edit };
}
/** 文档权限；在回收站里的文档对所有人都视为无权访问。 */
export async function docAccess(ctx: Ctx, doc: DocRecord, userId: string) {
  if (await ctx.repo.getEntity('doc_trash', doc.doc_id)) {
    return { owner_id: (await docGrant(ctx, doc)).owner_id, my_role: null, permissions: permissionFlags(null), can_edit: false };
  }
  return rawDocAccess(ctx, doc, userId);
}

export function registerDocAccessRoutes(ctx: Ctx, notifications: NotificationService) {
  // 事件只含文档 ID，不含正文；给修改前后有权访问的人发通知，撤权者也能及时退出。
  const changed = async (doc: DocRecord, before: ResourceGrant, after: ResourceGrant) => {
    ctx.collabHub.closeRoom(doc.doc_id, 4410, 'permissions changed');
    const audience: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await ctx.repo.listUsers({ limit: 200, offset });
      for (const u of page.items) {
        if (await resourceRole(ctx.repo, u.user_id, before) || await resourceRole(ctx.repo, u.user_id, after)) audience.push(u.user_id);
      }
      if (offset + page.items.length >= page.total || !page.items.length) break;
    }
    ctx.publish('doc.permission_changed', { doc_id: doc.doc_id, user_ids: [] }, audience, { user_only: true });
  };
  ctx.app.post('/api/v1/docs/:doc_id/transfer', async (req, reply) => {
    const me = await ctx.requireUser(req, reply); if (!me) return;
    const doc = await ctx.repo.getDoc((req.params as { doc_id: string }).doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    const grant = await docGrant(ctx, doc);
    if (grant.owner_id !== me.sub) return fail(reply, 403, '只有所有者可以转移文档', { code: 'FORBIDDEN' });
    const owner = (req.body as { owner_id?: unknown } | null)?.owner_id;
    if (typeof owner !== 'string' || !owner.trim()) return invalid(reply, [{ field: 'owner_id', message: '请选择新的所有者' }]);
    if (owner === grant.owner_id) return { owner_id: owner };
    const next: ResourceGrant = { ...grant, owner_id: owner, members: grant.members.filter(m => !(m.member_type === 'user' && [owner, me.sub].includes(m.member_id))) };
    next.members.push({ member_type: 'user', member_id: me.sub, role: 'manager' });
    const errors = await validateGrant(ctx.repo, next); if (errors.length) return invalid(reply, errors);
    if (!await ctx.repo.saveResourceGrant(next, grant.version)) return fail(reply, 409, '权限已变更，请刷新后重试', { code: 'VERSION_CONFLICT' });
    await changed(doc, grant, next);
    await notifications.notify({ user_id: owner, actor_id: me.sub, type: 'doc.transferred', title: '文档所有权已转移给你', target: { type: 'doc', id: doc.doc_id } });
    return { owner_id: owner };
  });
  ctx.app.post('/api/v1/docs/:doc_id/access-requests', async (req, reply) => {
    const me = await ctx.requireUser(req, reply); if (!me) return;
    const doc = await ctx.repo.getDoc((req.params as { doc_id: string }).doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    const body = (req.body ?? {}) as { role?: unknown; note?: unknown };
    if (!['viewer', 'commenter', 'editor'].includes(String(body.role))) return invalid(reply, [{ field: 'role', message: '只能申请阅读、评论或编辑权限' }]);
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) return invalid(reply, [{ field: 'note', message: '备注必须是最多 2000 字的文本' }]);
    const grant = await docGrant(ctx, doc);
    const role = await resourceRole(ctx.repo, me.sub, grant);
    const ranks = { viewer: 1, commenter: 2, editor: 3, manager: 4 };
    if (role && ranks[role] >= ranks[body.role as 'viewer' | 'commenter' | 'editor']) return fail(reply, 409, '你已经拥有此权限', { code: 'ACCESS_ALREADY_GRANTED' });
    const request = { request_id: newId('dar'), doc_id: doc.doc_id, user_id: me.sub, role: body.role as 'viewer' | 'commenter' | 'editor', note: (body.note as string | undefined) ?? '', status: 'pending' as const, created_at: nowIso() };
    if (!await ctx.repo.saveDocAccessRequest(request)) return fail(reply, 409, '已有待处理的权限申请', { code: 'ACCESS_REQUEST_PENDING' });
    await notifications.notify({ user_id: grant.owner_id, actor_id: me.sub, type: 'doc.access_request', title: '有人申请文档访问权限', summary: request.note, target: { type: 'access_request', doc_id: doc.doc_id, request_id: request.request_id } });
    return reply.code(201).send(request);
  });
  for (const action of ['approve', 'reject'] as const) {
    ctx.app.post(`/api/v1/docs/:doc_id/access-requests/:request_id/${action}`, async (req, reply) => {
      const me = await ctx.requireUser(req, reply); if (!me) return;
      const params = req.params as { doc_id: string; request_id: string };
      const doc = await ctx.repo.getDoc(params.doc_id); if (!doc) return fail(reply, 404, '文档不存在');
      const grant = await docGrant(ctx, doc);
      if (grant.owner_id !== me.sub) return fail(reply, 403, '只有所有者可以处理申请', { code: 'FORBIDDEN' });
      const request = await ctx.repo.getDocAccessRequest(params.request_id);
      if (!request || request.doc_id !== doc.doc_id) return fail(reply, 404, '申请不存在');
      if (request.status !== 'pending') return fail(reply, 409, '申请已经处理', { code: 'VERSION_CONFLICT' });
      const next = structuredClone(grant);
      if (action === 'approve') {
        const member = next.members.find(m => m.member_type === 'user' && m.member_id === request.user_id);
        const rank = { viewer: 1, commenter: 2, editor: 3, manager: 4 };
        if (member) { if (rank[member.role] < rank[request.role]) member.role = request.role; }
        else if (request.user_id !== grant.owner_id) next.members.push({ member_type: 'user', member_id: request.user_id, role: request.role });
        const errors = await validateGrant(ctx.repo, next); if (errors.length) return invalid(reply, errors);
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      if (!await ctx.repo.resolveDocAccessRequest(request.request_id, status, next)) return fail(reply, 409, '申请或权限已变更，请刷新', { code: 'VERSION_CONFLICT' });
      if (action === 'approve') await changed(doc, grant, next);
      await notifications.notify({ user_id: request.user_id, actor_id: me.sub, type: 'doc.access_result', title: action === 'approve' ? '文档权限申请已通过' : '文档权限申请未通过', target: { type: 'doc', id: doc.doc_id } });
      return { request_id: request.request_id, status };
    });
  }

  const json = (g: ResourceGrant) => ({ owner_id: g.owner_id, link_share: g.visibility, members: g.members, version: g.version });
  ctx.topicAuthorizers.set('doc', async (user, id) => {
    const doc = await ctx.repo.getDoc(id);
    return !doc ? 'NOT_FOUND' : (await docAccess(ctx, doc, user.sub)).permissions.can_view ? null : 'FORBIDDEN';
  });
  ctx.app.get('/api/v1/docs/:doc_id/permissions', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const doc = await ctx.repo.getDoc((req.params as { doc_id: string }).doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    if (!(await docAccess(ctx, doc, me.sub)).permissions.can_view) return fail(reply, 403, '没有权限访问', { code: 'FORBIDDEN' });
    const page = await wikiPageOf(ctx, doc.doc_id);
    if (page) {
      const space = await ctx.repo.getEntity(SPACE, page.space_id);
      return { ...json(await docGrant(ctx, doc)), members: [], inherited_from: { space_id: page.space_id, name: space ? String(space.data.name) : '' } };
    }
    return json(await docGrant(ctx, doc));
  });
  ctx.app.put('/api/v1/docs/:doc_id/permissions', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const doc = await ctx.repo.getDoc((req.params as { doc_id: string }).doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    const grant = await docGrant(ctx, doc);
    const page = await wikiPageOf(ctx, doc.doc_id);
    // 知识库页面：空间管理员可以改链接分享，协作者继承空间、不能单独设
    if (page ? (await rawDocAccess(ctx, doc, me.sub)).my_role !== 'manager' : !(await resourceRole(ctx.repo, me.sub, grant) === 'manager')) return fail(reply, 403, '需要管理权限', { code: 'FORBIDDEN' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = { ...grant, visibility: body.link_share, members: page ? grant.members : body.members } as ResourceGrant;
    const errors = await validateGrant(ctx.repo, next);
    if (errors.length) return invalid(reply, errors);
    if (body.version !== undefined && body.version !== grant.version) return fail(reply, 409, '权限已被修改，请刷新', { code: 'VERSION_CONFLICT' });
    if (!(await ctx.repo.saveResourceGrant(next, grant.version))) return fail(reply, 409, '权限已被修改，请刷新', { code: 'VERSION_CONFLICT' });
    await changed(doc, grant, next);
    return json({ ...next, version: grant.version + 1 });
  });
}
