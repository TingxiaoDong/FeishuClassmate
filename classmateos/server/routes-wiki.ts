/**
 * 知识库（二期 R-WK-01 ~ 04，开关 wiki）。
 *
 * 空间
 *   GET    /wiki/spaces                       我能看到的空间
 *   POST   /wiki/spaces                       {name, description?, icon?, color?, visibility?}；权限点 wiki.create，创建人是管理员
 *   GET    /wiki/spaces/:space_id
 *   PATCH  /wiki/spaces/:space_id             空间管理员
 *   DELETE /wiki/spaces/:space_id             空间管理员；里面的页面文档进回收站（之后按普通文档恢复）
 *   GET    /wiki/spaces/:space_id/members     {owner_id, visibility: org | members, members: [{member_type, member_id, role: admin | editor | viewer}]}
 *   PUT    /wiki/spaces/:space_id/members     空间管理员
 * 页面（页面 = 一篇云文档，标题以文档为准）
 *   GET    /wiki/spaces/:space_id/nodes?parent_id=    子节点，按 order
 *   POST   /wiki/spaces/:space_id/nodes               {parent_id, title, obj_type: doc, after_node_id?}；可编辑
 *   POST   /wiki/spaces/:space_id/import              {doc_id, parent_id}；把自己能管理的云文档挂进来
 *   GET    /wiki/nodes/:node_id
 *   PATCH  /wiki/nodes/:node_id                       {title}
 *   POST   /wiki/nodes/:node_id/move                  {space_id, parent_id, after_node_id}（null = 放第一个），可跨空间
 *   POST   /wiki/nodes/:node_id/copy                  {with_children?, title?}
 *   DELETE /wiki/nodes/:node_id                       子页面一起删，文档进回收站
 *   GET    /wiki/nodes/:node_id/ancestors             面包屑（从根到父节点，不含自己）
 *   POST / DELETE /wiki/nodes/:node_id/star
 *   GET    /wiki/recent、/wiki/starred
 * 实时：订阅 wiki:<space_id> 收 wiki.node_changed {space_id, node_id, parent_id, action, to_space_id?}；
 *       空间设置 / 成员变化推 wiki.space_changed {space_id} 给能看到的人。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fail, invalid, newId, pageResult, type AuthedUser, type Ctx, type FieldError } from './context.js';
import { DocLibrary } from './doc-library.js';
import { docAccess, docGrant } from './doc-access.js';
import { nowIso, type DocRecord, type EntityRecord, type ResourceGrant } from './repo.js';
import { validateGrant } from './resource-access.js';
import { NODE, SPACE, WIKI_DOC, atLeast, fromResourceRole, spaceGrant, wikiRole, type WikiRole } from './wiki-access.js';

const STAR = 'wiki_star';
const ICONS_MAX = 32;
const COLORS = new Set(['blue', 'green', 'orange', 'red', 'purple', 'turquoise', 'yellow', 'carmine', 'wathet', 'gray', 'indigo', 'violet']);
const GAP = 1024;
const MAX_COPY = 500;

class WikiError extends Error { constructor(public status: number, message: string, public code = 'BAD_REQUEST') { super(message); } }

export function registerWikiRoutes(ctx: Ctx): void {
  const { app, repo } = ctx;
  const lib = new DocLibrary(ctx);

  // ------------------------------------------------------------ 工具

  const headersOf = (req: FastifyRequest) => {
    const h: Record<string, string> = {};
    for (const k of ['authorization', 'x-bot-token', 'x-on-behalf-of']) { const v = req.headers[k]; if (typeof v === 'string') h[k] = v; }
    return h;
  };
  /** 以本人身份调用已有接口（建文档、改标题：版本、引用文件绑定都复用）。 */
  const callApi = async (req: FastifyRequest, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: headersOf(req), ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Record<string, unknown> = {};
    try { body = r.json(); } catch { /* 204 */ }
    return { status: r.statusCode, body };
  };

  async function save(rec: Omit<EntityRecord, 'version' | 'created_at' | 'updated_at'> & { created_at?: string }) {
    const now = nowIso();
    for (let i = 0; i < 5; i++) {
      const cur = await repo.getEntity(rec.kind, rec.id);
      if (await repo.saveEntity({ ...rec, version: cur?.version ?? 0, created_at: cur?.created_at ?? rec.created_at ?? now, updated_at: now }, cur?.version ?? 0)) return;
    }
    throw new WikiError(409, '数据已被修改，请重试', 'CONFLICT');
  }

  async function space(id: string): Promise<EntityRecord> {
    const s = await repo.getEntity(SPACE, id);
    if (!s) throw new WikiError(404, '知识空间不存在', 'NOT_FOUND');
    return s;
  }
  /** 空间 + 我的角色；至少 need。看不到时 403（不存在 404）。 */
  async function spaceFor(me: AuthedUser, id: string, need: WikiRole = 'viewer') {
    const s = await space(id);
    const grant = await spaceGrant(ctx, s);
    const role = await wikiRole(ctx, id, me.sub, s, grant);
    if (!role) throw new WikiError(403, '没有权限访问这个知识空间', 'FORBIDDEN');
    if (!atLeast(role, need)) throw new WikiError(403, need === 'admin' ? '只有空间管理员可以执行这个操作' : '没有编辑这个知识空间的权限', 'FORBIDDEN');
    return { s, grant, role };
  }
  async function node(id: string): Promise<EntityRecord> {
    const n = await repo.getEntity(NODE, id);
    if (!n) throw new WikiError(404, '页面不存在', 'NOT_FOUND');
    return n;
  }
  const nodesOf = (spaceId: string) => repo.listEntities(NODE, spaceId);
  const parentOf = (n: EntityRecord) => (n.data.parent_id as string | null) ?? null;
  const orderOf = (n: EntityRecord) => Number(n.data.order ?? 0);

  /** 节点及全部子孙（广度优先）。 */
  function subtree(all: EntityRecord[], rootId: string): EntityRecord[] {
    const byParent = new Map<string, EntityRecord[]>();
    for (const n of all) { const p = parentOf(n); if (p) byParent.set(p, [...(byParent.get(p) ?? []), n]); }
    const out: EntityRecord[] = [];
    const root = all.find((n) => n.id === rootId);
    if (!root) return out;
    const queue = [root];
    while (queue.length) { const n = queue.shift()!; out.push(n); queue.push(...(byParent.get(n.id) ?? []).sort((a, b) => orderOf(a) - orderOf(b))); }
    return out;
  }

  /** 新位置的 order：afterId = null 放第一个，否则放在它后面。 */
  function orderAt(siblings: EntityRecord[], afterId: string | null | undefined, self?: string): number {
    const list = siblings.filter((n) => n.id !== self).sort((a, b) => orderOf(a) - orderOf(b));
    if (afterId === undefined) return list.length ? orderOf(list[list.length - 1]) + GAP : GAP; // 没给：放最后
    if (afterId === null) return list.length ? orderOf(list[0]) - GAP : GAP;
    const i = list.findIndex((n) => n.id === afterId);
    if (i < 0) throw new WikiError(422, 'after_node_id 不在目标位置下', 'VALIDATION_FAILED');
    return i === list.length - 1 ? orderOf(list[i]) + GAP : (orderOf(list[i]) + orderOf(list[i + 1])) / 2;
  }

  const spaceName = async (id: string) => String((await repo.getEntity(SPACE, id))?.data.name ?? '');

  async function nodeJson(n: EntityRecord, me: AuthedUser, opts: { all?: EntityRecord[]; stars?: Set<string>; names?: Map<string, string> } = {}) {
    const doc = await repo.getDoc(String(n.data.obj_id));
    const all = opts.all ?? (await nodesOf(n.scope));
    const stars = opts.stars ?? new Set((await repo.listEntities(STAR, me.sub)).map((s) => String(s.data.node_id)));
    return {
      node_id: n.id,
      space_id: n.scope,
      parent_id: parentOf(n),
      title: doc?.title ?? String(n.data.title ?? ''),
      obj_type: String(n.data.obj_type ?? 'doc'),
      obj_id: String(n.data.obj_id ?? ''),
      has_children: all.some((x) => parentOf(x) === n.id),
      order: orderOf(n),
      updated_at: doc && doc.updated_at > n.updated_at ? doc.updated_at : n.updated_at,
      updated_by: doc?.updated_by ?? String(n.data.updated_by ?? ''),
      starred: stars.has(n.id),
      space_name: opts.names?.get(n.scope) ?? (await spaceName(n.scope)),
    };
  }

  async function spaceJson(s: EntityRecord, role: WikiRole, grant: ResourceGrant) {
    const nodes = await nodesOf(s.id);
    const latest = nodes.reduce((m, n) => (n.updated_at > m ? n.updated_at : m), s.updated_at);
    return {
      space_id: s.id,
      name: String(s.data.name),
      description: String(s.data.description ?? ''),
      icon: String(s.data.icon ?? 'book'),
      color: String(s.data.color ?? 'blue'),
      visibility: grant.visibility === 'all' ? 'org' : 'members',
      my_role: role,
      page_count: nodes.length,
      owner_id: grant.owner_id,
      created_at: s.created_at,
      updated_at: latest,
    };
  }

  const membersJson = (g: ResourceGrant) => ({
    owner_id: g.owner_id,
    visibility: g.visibility === 'all' ? 'org' : 'members',
    members: g.members.map((m) => ({ ...m, role: fromResourceRole(m.role) })),
    version: g.version,
  });

  /** 能看到空间的人（推 wiki.space_changed 用）。 */
  async function audienceOf(spaceId: string, extraGrant?: ResourceGrant): Promise<string[]> {
    const out: string[] = [];
    const s = await repo.getEntity(SPACE, spaceId);
    for (const u of (await repo.listUsers({ limit: 1_000_000, offset: 0 })).items) {
      if (u.disabled || u.role === 'bot') continue;
      if ((s && (await wikiRole(ctx, spaceId, u.user_id, s))) || (extraGrant && (await wikiRole(ctx, spaceId, u.user_id, s ?? undefined, extraGrant)))) out.push(u.user_id);
    }
    return out;
  }
  const nodeChanged = (spaceId: string, nodeId: string, parentId: string | null, action: string, extra: Record<string, unknown> = {}) =>
    ctx.publish('wiki.node_changed', { space_id: spaceId, node_id: nodeId, parent_id: parentId, action, ...extra }, undefined, { topic: `wiki:${spaceId}`, all: true, user_only: true });

  ctx.topicAuthorizers.set('wiki', async (user, id) => {
    if (!(await repo.getEntity(SPACE, id))) return 'NOT_FOUND';
    return (await wikiRole(ctx, id, user.sub)) ? null : 'FORBIDDEN';
  });

  const wrap = (fn: (req: FastifyRequest, reply: FastifyReply, me: AuthedUser) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    try {
      return await fn(req, reply, me);
    } catch (e) {
      if (e instanceof WikiError) return fail(reply, e.status, e.message, { code: e.code });
      throw e;
    }
  };

  const parseSpaceFields = (b: Record<string, unknown>, errors: FieldError[], partial: boolean) => {
    const out: Record<string, unknown> = {};
    if (b.name !== undefined || !partial) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 50) errors.push({ field: 'name', message: '不能为空，且不超过 50 字' });
      else out.name = b.name.trim();
    }
    if (b.description !== undefined) {
      if (b.description !== null && (typeof b.description !== 'string' || b.description.length > 500)) errors.push({ field: 'description', message: '不超过 500 字' });
      else out.description = typeof b.description === 'string' ? b.description.trim() : '';
    }
    if (b.icon !== undefined) {
      if (typeof b.icon !== 'string' || !b.icon.trim() || b.icon.length > ICONS_MAX) errors.push({ field: 'icon', message: '图标不能为空' });
      else out.icon = b.icon.trim();
    }
    if (b.color !== undefined) {
      if (typeof b.color !== 'string' || !COLORS.has(b.color)) errors.push({ field: 'color', message: `可选：${[...COLORS].join('、')}` });
      else out.color = b.color;
    }
    if (b.visibility !== undefined && b.visibility !== 'org' && b.visibility !== 'members') errors.push({ field: 'visibility', message: '只能是 org 或 members' });
    return out;
  };

  /** 前端成员结构 → 授权。 */
  async function grantFrom(base: ResourceGrant, body: { visibility?: unknown; members?: unknown }, errors: FieldError[]): Promise<ResourceGrant> {
    const next: ResourceGrant = { ...base };
    if (body.visibility !== undefined) next.visibility = body.visibility === 'org' ? 'all' : 'members';
    if (body.members !== undefined) {
      if (!Array.isArray(body.members)) { errors.push({ field: 'members', message: '必须是数组' }); return next; }
      const roles: Record<string, ResourceGrant['members'][number]['role']> = { admin: 'manager', editor: 'editor', viewer: 'viewer' };
      next.members = body.members.map((m, i) => {
        const x = (m ?? {}) as Record<string, unknown>;
        if (!roles[String(x.role)]) errors.push({ field: `members[${i}].role`, message: '只能是 admin、editor、viewer' });
        return { member_type: x.member_type as 'user', member_id: String(x.member_id ?? ''), role: roles[String(x.role)] ?? 'viewer' };
      });
    }
    errors.push(...(await validateGrant(repo, next)));
    return next;
  }

  // ------------------------------------------------------------ 空间

  app.get('/api/v1/wiki/spaces', wrap(async (_req, _reply, me) => {
    const items = [];
    for (const s of await repo.listEntities(SPACE)) {
      const grant = await spaceGrant(ctx, s);
      const role = await wikiRole(ctx, s.id, me.sub, s, grant);
      if (role) items.push(await spaceJson(s, role, grant));
    }
    items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return pageResult(items, items.length, 0);
  }));

  app.post('/api/v1/wiki/spaces', wrap(async (req, reply, me) => {
    if (me.via_bot) throw new WikiError(403, '这个操作不允许由机器人代办', 'BOT_SCOPE_DENIED');
    if (!(await ctx.roles.has(me.user, 'wiki.create'))) throw new WikiError(403, '没有新建知识空间的权限', 'FORBIDDEN');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const fields = parseSpaceFields(b, errors, false);
    if (errors.length) return invalid(reply, errors, errors[0].message);
    if ((await repo.listEntities(SPACE)).some((s) => String(s.data.name).toLowerCase() === String(fields.name).toLowerCase())) throw new WikiError(409, '已经有同名的知识空间了', 'CONFLICT');
    const id = newId('wks');
    const rec = { kind: SPACE, id, scope: 'global', data: { icon: 'book', color: 'blue', description: '', ...fields, created_by: me.sub } };
    await save(rec);
    const s = await space(id);
    const base = await spaceGrant(ctx, s);
    const grant = await grantFrom(base, { visibility: b.visibility ?? 'org', members: b.members ?? [] }, errors);
    if (errors.length) { await repo.deleteEntity(SPACE, id); return invalid(reply, errors, errors[0].message); }
    await repo.saveResourceGrant(grant, 0);
    const saved = (await repo.getResourceGrant('wiki', id)) ?? grant;
    ctx.publish('wiki.space_changed', { space_id: id }, await audienceOf(id), { user_only: true });
    return reply.code(201).send(await spaceJson(s, 'admin', saved));
  }));

  app.get('/api/v1/wiki/spaces/:space_id', wrap(async (req, _reply, me) => {
    const { s, grant, role } = await spaceFor(me, (req.params as { space_id: string }).space_id);
    return spaceJson(s, role, grant);
  }));

  app.patch('/api/v1/wiki/spaces/:space_id', wrap(async (req, reply, me) => {
    const id = (req.params as { space_id: string }).space_id;
    const { s, grant } = await spaceFor(me, id, 'admin');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const fields = parseSpaceFields(b, errors, true);
    let next = grant;
    if (b.visibility !== undefined) next = await grantFrom(grant, { visibility: b.visibility }, errors);
    if (errors.length) return invalid(reply, errors, errors[0].message);
    if (fields.name && (await repo.listEntities(SPACE)).some((x) => x.id !== id && String(x.data.name).toLowerCase() === String(fields.name).toLowerCase())) throw new WikiError(409, '已经有同名的知识空间了', 'CONFLICT');
    const before = await audienceOf(id);
    await save({ kind: SPACE, id, scope: s.scope, data: { ...s.data, ...fields }, created_at: s.created_at });
    if (next !== grant && !(await repo.saveResourceGrant(next, grant.version))) throw new WikiError(409, '空间设置已被别人修改，请刷新后重试', 'VERSION_CONFLICT');
    const after = await audienceOf(id);
    ctx.publish('wiki.space_changed', { space_id: id }, [...new Set([...before, ...after])], { user_only: true });
    const fresh = await space(id);
    return spaceJson(fresh, (await wikiRole(ctx, id, me.sub))!, await spaceGrant(ctx, fresh));
  }));

  app.delete('/api/v1/wiki/spaces/:space_id', wrap(async (req, reply, me) => {
    const id = (req.params as { space_id: string }).space_id;
    const { s } = await spaceFor(me, id, 'admin');
    const audience = await audienceOf(id);
    for (const n of await nodesOf(id)) {
      const docId = String(n.data.obj_id);
      await repo.deleteEntity(WIKI_DOC, docId);
      if (await repo.getDoc(docId)) { await lib.trash(docId, me.sub); ctx.collabHub.closeRoom(docId, 4404, 'doc deleted'); }
      await repo.deleteEntity(NODE, n.id);
    }
    for (const st of await repo.listEntities(STAR)) if (String(st.data.space_id) === id) await repo.deleteEntity(STAR, st.id);
    await repo.deleteEntity(SPACE, id);
    await ctx.auditLog.record({ req, operator_id: me.sub, operator_name: me.user.name, action: 'wiki.space_delete', target_type: 'wiki_space', target_id: id, target_name: String(s.data.name), detail: null });
    ctx.publish('wiki.space_changed', { space_id: id, deleted: true }, audience, { user_only: true });
    return reply.code(204).send();
  }));

  app.get('/api/v1/wiki/spaces/:space_id/members', wrap(async (req, _reply, me) => {
    const { grant } = await spaceFor(me, (req.params as { space_id: string }).space_id);
    return membersJson(grant);
  }));

  app.put('/api/v1/wiki/spaces/:space_id/members', wrap(async (req, reply, me) => {
    const id = (req.params as { space_id: string }).space_id;
    if (me.via_bot) throw new WikiError(403, '这个操作不允许由机器人代办', 'BOT_SCOPE_DENIED');
    const { grant } = await spaceFor(me, id, 'admin');
    const b = (req.body ?? {}) as { visibility?: unknown; members?: unknown; version?: unknown };
    if (b.version !== undefined && b.version !== grant.version) throw new WikiError(409, '成员已被别人修改，请刷新后重试', 'VERSION_CONFLICT');
    const errors: FieldError[] = [];
    const next = await grantFrom(grant, b, errors);
    if (errors.length) return invalid(reply, errors, errors[0].message);
    // 不能把自己降成非管理员后没人管：所有者始终是管理员
    const before = await audienceOf(id);
    if (!(await repo.saveResourceGrant(next, grant.version))) throw new WikiError(409, '成员已被别人修改，请刷新后重试', 'VERSION_CONFLICT');
    const saved = (await repo.getResourceGrant('wiki', id))!;
    const after = await audienceOf(id);
    ctx.publish('wiki.space_changed', { space_id: id }, [...new Set([...before, ...after])], { user_only: true });
    // 页面权限继承空间：在线协同里被降权的人重新连接时按新权限
    for (const n of await nodesOf(id)) ctx.collabHub.closeRoom(String(n.data.obj_id), 4410, 'permissions changed');
    return membersJson(saved);
  }));

  // ------------------------------------------------------------ 页面

  app.get('/api/v1/wiki/spaces/:space_id/nodes', wrap(async (req, _reply, me) => {
    const id = (req.params as { space_id: string }).space_id;
    await spaceFor(me, id);
    const q = req.query as { parent_id?: string };
    const parent = q.parent_id && q.parent_id !== 'root' ? q.parent_id : null;
    const all = await nodesOf(id);
    if (parent && !all.some((n) => n.id === parent)) throw new WikiError(404, '父页面不存在', 'NOT_FOUND');
    const stars = new Set((await repo.listEntities(STAR, me.sub)).map((s) => String(s.data.node_id)));
    const names = new Map([[id, await spaceName(id)]]);
    const kids = all.filter((n) => parentOf(n) === parent).sort((a, b) => orderOf(a) - orderOf(b) || a.created_at.localeCompare(b.created_at));
    const items = [];
    for (const n of kids) items.push(await nodeJson(n, me, { all, stars, names }));
    return pageResult(items, items.length, 0);
  }));

  async function checkParent(spaceId: string, parent: unknown): Promise<string | null> {
    if (parent === null || parent === undefined || parent === 'root') return null;
    if (typeof parent !== 'string') throw new WikiError(422, 'parent_id 必须是页面 ID 或 null', 'VALIDATION_FAILED');
    const p = await repo.getEntity(NODE, parent);
    if (!p || p.scope !== spaceId) throw new WikiError(404, '父页面不存在', 'NOT_FOUND');
    return parent;
  }

  async function attach(me: AuthedUser, spaceId: string, docId: string, parent: string | null, after: string | null | undefined, title: string): Promise<EntityRecord> {
    const siblings = (await nodesOf(spaceId)).filter((n) => parentOf(n) === parent);
    const id = newId('wkn');
    await save({ kind: NODE, id, scope: spaceId, data: { parent_id: parent, title, obj_type: 'doc', obj_id: docId, order: orderAt(siblings, after), created_by: me.sub, updated_by: me.sub } });
    await save({ kind: WIKI_DOC, id: docId, scope: spaceId, data: { space_id: spaceId, node_id: id } });
    // 页面权限只继承空间：进知识库时关掉文档的链接分享（空间管理员之后可以在页面上再打开）
    const doc = await repo.getDoc(docId);
    if (doc) {
      const g = await docGrant(ctx, doc);
      if (g.visibility !== 'off') await repo.saveResourceGrant({ ...g, visibility: 'off' }, g.version);
    }
    nodeChanged(spaceId, id, parent, 'created');
    return node(id);
  }

  app.post('/api/v1/wiki/spaces/:space_id/nodes', wrap(async (req, reply, me) => {
    const spaceId = (req.params as { space_id: string }).space_id;
    await spaceFor(me, spaceId, 'editor');
    const b = (req.body ?? {}) as { parent_id?: unknown; title?: unknown; obj_type?: unknown; after_node_id?: unknown };
    if (b.obj_type !== undefined && b.obj_type !== 'doc') throw new WikiError(422, '目前只支持新建文档页面', 'VALIDATION_FAILED');
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : '未命名页面';
    const parent = await checkParent(spaceId, b.parent_id);
    if (b.after_node_id !== undefined && b.after_node_id !== null && typeof b.after_node_id !== 'string') throw new WikiError(422, 'after_node_id 必须是页面 ID', 'VALIDATION_FAILED');
    const created = await callApi(req, 'POST', '/docs', { title, markdown: '' });
    if (created.status !== 201) throw new WikiError(created.status, String(created.body.message ?? '新建页面失败'), String(created.body.code ?? 'BAD_REQUEST'));
    const n = await attach(me, spaceId, String(created.body.doc_id), parent, b.after_node_id as string | null | undefined, title);
    return reply.code(201).send(await nodeJson(n, me));
  }));

  app.post('/api/v1/wiki/spaces/:space_id/import', wrap(async (req, reply, me) => {
    const spaceId = (req.params as { space_id: string }).space_id;
    await spaceFor(me, spaceId, 'editor');
    const b = (req.body ?? {}) as { doc_id?: unknown; parent_id?: unknown };
    if (typeof b.doc_id !== 'string') throw new WikiError(422, '请选择要移入的文档', 'VALIDATION_FAILED');
    const doc = await repo.getDoc(b.doc_id);
    if (!doc) throw new WikiError(404, '文档不存在', 'NOT_FOUND');
    if (await repo.getEntity(WIKI_DOC, doc.doc_id)) throw new WikiError(409, '这篇文档已经在知识库里了', 'ALREADY_IN_WIKI');
    if (await lib.trashInfo(doc.doc_id)) throw new WikiError(409, '文档在回收站里，请先恢复', 'DOC_IN_TRASH');
    if (!(await docAccess(ctx, doc, me.sub)).permissions.can_manage) throw new WikiError(403, '只有文档的管理者可以把它移入知识库', 'FORBIDDEN');
    const parent = await checkParent(spaceId, b.parent_id);
    const n = await attach(me, spaceId, doc.doc_id, parent, undefined, doc.title);
    // 文档进了知识库：从各人的文件夹里移走
    for (const it of await repo.listEntities('doc_folder_item')) if (it.data.doc_id === doc.doc_id) await repo.deleteEntity('doc_folder_item', it.id);
    return reply.code(201).send(await nodeJson(n, me));
  }));

  /** 节点 + 所在空间的角色检查。 */
  async function nodeFor(me: AuthedUser, nodeId: string, need: WikiRole = 'viewer') {
    const n = await node(nodeId);
    const sp = await spaceFor(me, n.scope, need);
    return { n, ...sp };
  }

  app.get('/api/v1/wiki/nodes/:node_id', wrap(async (req, _reply, me) => {
    const { n } = await nodeFor(me, (req.params as { node_id: string }).node_id);
    return nodeJson(n, me);
  }));

  app.patch('/api/v1/wiki/nodes/:node_id', wrap(async (req, reply, me) => {
    const { n } = await nodeFor(me, (req.params as { node_id: string }).node_id, 'editor');
    const title = (req.body as { title?: unknown } | null)?.title;
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) return invalid(reply, [{ field: 'title', message: '不能为空，且不超过 200 字' }]);
    const r = await callApi(req, 'PATCH', `/docs/${encodeURIComponent(String(n.data.obj_id))}`, { title: title.trim() });
    if (r.status !== 200) throw new WikiError(r.status, String(r.body.message ?? '重命名失败'), String(r.body.code ?? 'BAD_REQUEST'));
    await save({ kind: NODE, id: n.id, scope: n.scope, data: { ...n.data, title: title.trim(), updated_by: me.sub }, created_at: n.created_at });
    nodeChanged(n.scope, n.id, parentOf(n), 'updated');
    return nodeJson(await node(n.id), me);
  }));

  app.post('/api/v1/wiki/nodes/:node_id/move', wrap(async (req, _reply, me) => {
    const { n } = await nodeFor(me, (req.params as { node_id: string }).node_id, 'editor');
    const b = (req.body ?? {}) as { space_id?: unknown; parent_id?: unknown; after_node_id?: unknown };
    const target = typeof b.space_id === 'string' && b.space_id ? b.space_id : n.scope;
    if (target !== n.scope) await spaceFor(me, target, 'editor');
    const parent = await checkParent(target, b.parent_id);
    const fromAll = await nodesOf(n.scope);
    const moving = subtree(fromAll, n.id);
    if (parent && moving.some((x) => x.id === parent)) throw new WikiError(400, '不能把页面移动到它自己或子页面下面', 'BAD_REQUEST');
    if (b.after_node_id !== undefined && b.after_node_id !== null && typeof b.after_node_id !== 'string') throw new WikiError(422, 'after_node_id 必须是页面 ID 或 null', 'VALIDATION_FAILED');
    const siblings = (target === n.scope ? fromAll : await nodesOf(target)).filter((x) => parentOf(x) === parent);
    const order = orderAt(siblings, (b.after_node_id as string | null | undefined) ?? null, n.id);
    const oldParent = parentOf(n);
    await save({ kind: NODE, id: n.id, scope: target, data: { ...n.data, parent_id: parent, order, updated_by: me.sub }, created_at: n.created_at });
    if (target !== n.scope) {
      // 跨空间：整棵子树换空间，页面权限随之继承新空间
      for (const x of moving.slice(1)) await save({ kind: NODE, id: x.id, scope: target, data: x.data, created_at: x.created_at });
      for (const x of moving) {
        await save({ kind: WIKI_DOC, id: String(x.data.obj_id), scope: target, data: { space_id: target, node_id: x.id } });
        ctx.collabHub.closeRoom(String(x.data.obj_id), 4410, 'permissions changed');
      }
      for (const st of await repo.listEntities(STAR)) if (moving.some((x) => x.id === st.data.node_id)) await save({ kind: STAR, id: st.id, scope: st.scope, data: { ...st.data, space_id: target }, created_at: st.created_at });
      nodeChanged(n.scope, n.id, oldParent, 'moved', { to_space_id: target });
      nodeChanged(target, n.id, parent, 'moved', { to_space_id: target });
    } else nodeChanged(n.scope, n.id, parent, 'moved', { old_parent_id: oldParent });
    return nodeJson(await node(n.id), me);
  }));

  app.post('/api/v1/wiki/nodes/:node_id/copy', wrap(async (req, reply, me) => {
    const { n } = await nodeFor(me, (req.params as { node_id: string }).node_id, 'editor');
    const b = (req.body ?? {}) as { with_children?: unknown; title?: unknown };
    const all = await nodesOf(n.scope);
    const list = b.with_children === true ? subtree(all, n.id) : [n];
    if (list.length > MAX_COPY) throw new WikiError(422, `一次最多复制 ${MAX_COPY} 个页面`, 'VALIDATION_FAILED');
    const mapping = new Map<string, string>();
    let rootCopy: EntityRecord | undefined;
    for (const [i, src] of list.entries()) {
      const doc = await repo.getDoc(String(src.data.obj_id));
      const title = i === 0 ? (typeof b.title === 'string' && b.title.trim() ? b.title.trim() : `${doc?.title ?? src.data.title} 副本`) : (doc?.title ?? String(src.data.title));
      const created = await callApi(req, 'POST', '/docs', { title: title.slice(0, 200), markdown: doc?.markdown ?? '' });
      if (created.status !== 201) throw new WikiError(created.status, String(created.body.message ?? '复制失败'), String(created.body.code ?? 'BAD_REQUEST'));
      const parent = i === 0 ? parentOf(n) : mapping.get(parentOf(src)!) ?? null;
      // 第一个放在原页面后面；子页面保持原顺序
      const after = i === 0 ? n.id : undefined;
      const copy = await attach(me, n.scope, String(created.body.doc_id), parent, after, title);
      mapping.set(src.id, copy.id);
      if (i === 0) rootCopy = copy;
    }
    return reply.code(201).send(await nodeJson(rootCopy!, me));
  }));

  app.delete('/api/v1/wiki/nodes/:node_id', wrap(async (req, reply, me) => {
    const { n } = await nodeFor(me, (req.params as { node_id: string }).node_id, 'editor');
    const list = subtree(await nodesOf(n.scope), n.id);
    for (const x of list) {
      const docId = String(x.data.obj_id);
      await repo.deleteEntity(WIKI_DOC, docId);
      if (await repo.getDoc(docId)) { await lib.trash(docId, me.sub); ctx.collabHub.closeRoom(docId, 4404, 'doc deleted'); }
      await repo.deleteEntity(NODE, x.id);
    }
    for (const st of await repo.listEntities(STAR)) if (list.some((x) => x.id === st.data.node_id)) await repo.deleteEntity(STAR, st.id);
    nodeChanged(n.scope, n.id, parentOf(n), 'deleted');
    return reply.code(204).send();
  }));

  app.get('/api/v1/wiki/nodes/:node_id/ancestors', wrap(async (req, _reply, me) => {
    const { n } = await nodeFor(me, (req.params as { node_id: string }).node_id);
    const all = await nodesOf(n.scope);
    const byId = new Map(all.map((x) => [x.id, x]));
    const chain: EntityRecord[] = [];
    for (let p = parentOf(n); p && chain.length < 100; ) { const x = byId.get(p); if (!x) break; chain.unshift(x); p = parentOf(x); }
    const items = [];
    for (const x of chain) items.push(await nodeJson(x, me, { all }));
    return pageResult(items, items.length, 0);
  }));

  for (const method of ['POST', 'DELETE'] as const) {
    app.route({ method, url: '/api/v1/wiki/nodes/:node_id/star', handler: wrap(async (req, reply, me) => {
      const nodeId = (req.params as { node_id: string }).node_id;
      const id = `${me.sub}:${nodeId}`;
      if (method === 'DELETE') { await repo.deleteEntity(STAR, id); return reply.code(204).send(); }
      const { n } = await nodeFor(me, nodeId);
      if (!(await repo.getEntity(STAR, id))) await save({ kind: STAR, id, scope: me.sub, data: { node_id: n.id, space_id: n.scope } });
      return reply.code(204).send();
    }) });
  }

  /** 列出节点（跳过已删除或已看不到的）。 */
  async function visibleNodes(me: AuthedUser, ids: string[]) {
    const roles = new Map<string, WikiRole | null>();
    const names = new Map<string, string>();
    const stars = new Set((await repo.listEntities(STAR, me.sub)).map((s) => String(s.data.node_id)));
    const out = [];
    for (const id of ids) {
      const n = await repo.getEntity(NODE, id);
      if (!n) continue;
      if (!roles.has(n.scope)) { roles.set(n.scope, await wikiRole(ctx, n.scope, me.sub)); names.set(n.scope, await spaceName(n.scope)); }
      if (!roles.get(n.scope)) continue;
      out.push(await nodeJson(n, me, { stars, names }));
    }
    return out;
  }

  app.get('/api/v1/wiki/starred', wrap(async (_req, _reply, me) => {
    const ids = (await repo.listEntities(STAR, me.sub)).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((s) => String(s.data.node_id));
    const items = await visibleNodes(me, ids);
    return pageResult(items, items.length, 0);
  }));

  /** 最近访问：打开过的页面文档（全局搜索「最近访问」里 type = doc 的记录）。 */
  app.get('/api/v1/wiki/recent', wrap(async (_req, _reply, me) => {
    const rows = (await repo.relList('recent', { k1: me.sub }, { order: 'desc', limit: 200 })).items;
    const ids: string[] = [];
    for (const r of rows) {
      if (r.data.type !== 'doc') continue;
      const m = await repo.getEntity(WIKI_DOC, String(r.data.id));
      if (m && !ids.includes(String(m.data.node_id))) ids.push(String(m.data.node_id));
      if (ids.length >= 20) break;
    }
    const items = await visibleNodes(me, ids);
    return pageResult(items, items.length, 0);
  }));
}

/** 全局搜索 / 空间内搜索里的 wiki 分组：搜页面标题和正文。 */
export async function searchWikiNodes(ctx: Ctx, me: AuthedUser, terms: string[], spaceId?: string): Promise<Array<{ id: string; title: string; markdown: string; doc: DocRecord; space_id: string; space_name: string; path: string; updated_at: string }>> {
  const out = [];
  const spaces = spaceId ? [await ctx.repo.getEntity(SPACE, spaceId)].filter((x): x is EntityRecord => !!x) : await ctx.repo.listEntities(SPACE);
  for (const s of spaces) {
    if (!(await wikiRole(ctx, s.id, me.sub, s))) continue;
    const nodes = await ctx.repo.listEntities(NODE, s.id);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const doc = await ctx.repo.getDoc(String(n.data.obj_id));
      if (!doc) continue;
      const text = `${doc.title}\n${doc.markdown}`.toLowerCase();
      if (!terms.every((t) => text.includes(t.toLowerCase()))) continue;
      const names: string[] = [];
      for (let p = (n.data.parent_id as string | null) ?? null; p && names.length < 20; ) { const x = byId.get(p); if (!x) break; names.unshift(String((await ctx.repo.getDoc(String(x.data.obj_id)))?.title ?? x.data.title)); p = (x.data.parent_id as string | null) ?? null; }
      out.push({ id: n.id, title: doc.title, markdown: doc.markdown, doc, space_id: s.id, space_name: String(s.data.name), path: [String(s.data.name), ...names].join(' / '), updated_at: doc.updated_at });
    }
  }
  return out;
}

