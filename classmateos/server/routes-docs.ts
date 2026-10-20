import type { NotificationService } from './notifications.js';
import { bindReferencedFiles, registerDocExtraRoutes, type DocVersions } from './doc-extras.js';
/**
 * 云文档（《前端接口需求文档》第 9 节）+ Yjs 协同 WS。
 */

import { verifyToken } from './auth.js';
import { docAccess, registerDocAccessRoutes } from './doc-access.js';
import { fail, invalid, newId, pageOffset, pageResult, pageSize, type AuthedUser, type Ctx, type FieldError } from './context.js';
import { nowIso, type DocRecord } from './repo.js';

const MAX_TITLE = 200;
const MAX_MARKDOWN = 2_000_000;

function summaryOf(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+\s\d.]+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function canEditDoc(user: { sub: string }, doc: DocRecord): boolean {
  return doc.created_by === user.sub;
}

function docJson(doc: DocRecord, me: AuthedUser, withMarkdown: boolean, access?: Awaited<ReturnType<typeof docAccess>>) {
  return {
    doc_id: doc.doc_id,
    title: doc.title,
    ...(withMarkdown ? { markdown: doc.markdown } : {}),
    summary: summaryOf(doc.markdown),
    created_by: doc.created_by,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    updated_by: doc.updated_by,
    can_edit: access?.can_edit ?? canEditDoc(me, doc),
    ...(access ? { owner_id: access.owner_id, my_role: access.my_role, permissions: access.permissions } : {}),
    url: `/api/v1/docs/${doc.doc_id}`,
  };
}

export function registerDocRoutes(ctx: Ctx, notifications: NotificationService, versions: DocVersions): void {
  const { app, repo, collabHub } = ctx;
  registerDocAccessRoutes(ctx, notifications);
  registerDocExtraRoutes(ctx, notifications, versions);
  const shaped = async (doc: DocRecord, me: AuthedUser, withMarkdown: boolean) => docJson(doc, me, withMarkdown, await docAccess(ctx, doc, me.sub));

  // 协同编辑 WS：/api/v1/docs/:doc_id/collab?token=<access_token>
  // 正文共享类型：Y.Text，key = "markdown"；无编辑权限的连接只读（能收不能发），awareness 照常转发（doc.presence）。
  app.get('/api/v1/docs/:doc_id/collab', { websocket: true }, (socket, req) => {
    const { doc_id } = req.params as { doc_id: string };
    const { token } = req.query as { token?: string };
    const p = token ? verifyToken(token, ctx.secret, 'access') : undefined;
    if (!p) {
      socket.close(4401, 'invalid token');
      return;
    }
    const authP = ctx.verifyWsToken(token);
    const userP = authP.then((r) => ('user' in r ? r.user : undefined));
    const identity = userP.then((u) => (u ? { user_id: u.user_id, name: u.name } : undefined));
    const offRevoke = ctx.auth.onRevoke(p.sid, () => socket.close(4401, 'session revoked'));
    socket.on('close', offRevoke);
    const readOnly = (async () => {
      const [r, doc] = await Promise.all([authP, repo.getDoc(doc_id)]);
      if ('close' in r) {
        socket.close(r.close, r.close === 4403 ? 'account disabled' : 'invalid token');
        return true;
      }
      if (!doc) { socket.close(4404, 'doc not found'); return true; }
      const access = await docAccess(ctx, doc, p.sub);
      if (!access.permissions.can_view) { socket.close(4410, 'permission revoked'); return true; }
      return !access.permissions.can_edit;
    })();
    void collabHub.handleConnection(doc_id, socket, { readOnly, identity }).catch(() => socket.close(1011, 'server error'));
  });

  app.get('/api/v1/docs', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { scope?: string; keyword?: string; page_size?: string; page_token?: string };
    const scope = q.scope === 'mine' || q.scope === 'shared' ? q.scope : 'all';
    const limit = pageSize(q.page_size, 50, 200);
    const offset = pageOffset(q.page_token);
    const visible = [];
    for (let at = 0; ; at += 200) {
      const page = await repo.listDocs({ userId: me.sub, scope, keyword: q.keyword, limit: 200, offset: at });
      for (const d of page.items) { const access = await docAccess(ctx, d, me.sub); if (access.permissions.can_view) visible.push(docJson(d, me, false, access)); }
      if (at + page.items.length >= page.total || page.items.length === 0) break;
    }
    return pageResult(visible.slice(offset, offset + limit), visible.length, offset);
  });

  app.get('/api/v1/docs/:doc_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    const access = await docAccess(ctx, doc, me.sub);
    if (!access.permissions.can_view) return fail(reply, 403, '没有权限访问，申请权限', { code: 'FORBIDDEN' });
    return docJson(doc, me, true, access);
  });

  app.post('/api/v1/docs', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { title, markdown } = (req.body ?? {}) as { title?: unknown; markdown?: unknown };
    const errors: FieldError[] = [];
    if (typeof title !== 'string' || !title.trim()) errors.push({ field: 'title', message: '不能为空' });
    else if (title.length > MAX_TITLE) errors.push({ field: 'title', message: `不能超过 ${MAX_TITLE} 字` });
    if (markdown !== undefined && typeof markdown !== 'string') errors.push({ field: 'markdown', message: '必须是文本' });
    else if (typeof markdown === 'string' && markdown.length > MAX_MARKDOWN) errors.push({ field: 'markdown', message: '正文太长' });
    if (errors.length) {
      // 兼容旧行为：缺字段返回 400
      if (title === undefined) return fail(reply, 400, '缺少 title', { code: 'VALIDATION_FAILED', errors });
      return invalid(reply, errors);
    }
    const now = nowIso();
    const doc: DocRecord = {
      doc_id: newId('doc'),
      title: (title as string).trim(),
      markdown: (markdown as string | undefined) ?? '',
      created_by: me.sub,
      created_at: now,
      updated_at: now,
      updated_by: me.sub,
      yjs_update: null,
    };
    await repo.createDoc(doc);
    await versions.snapshot(doc, me.sub, true);
    await bindReferencedFiles(ctx, me, doc);
    return reply.code(201).send(await shaped(doc, me, true));
  });

  app.patch('/api/v1/docs/:doc_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    const access = await docAccess(ctx, doc, me.sub);
    if (!access.permissions.can_view) return fail(reply, 403, '没有权限访问', { code: 'FORBIDDEN' });
    if (!access.permissions.can_edit) return fail(reply, 403, '没有编辑权限', { code: 'FORBIDDEN' });
    const { title, markdown, base_updated_at } = (req.body ?? {}) as {
      title?: unknown;
      markdown?: unknown;
      base_updated_at?: unknown;
    };
    const errors: FieldError[] = [];
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE)) {
      errors.push({ field: 'title', message: `不能为空，且不超过 ${MAX_TITLE} 字` });
    }
    if (markdown !== undefined && (typeof markdown !== 'string' || markdown.length > MAX_MARKDOWN)) {
      errors.push({ field: 'markdown', message: '必须是文本' });
    }
    if (base_updated_at !== undefined && base_updated_at !== null && typeof base_updated_at !== 'string') {
      errors.push({ field: 'base_updated_at', message: '必须是上次拿到的 updated_at' });
    }
    if (errors.length) return invalid(reply, errors);

    const base = typeof base_updated_at === 'string' ? normalizeIso(base_updated_at) : undefined;
    if (base !== undefined && base !== doc.updated_at) {
      return fail(reply, 409, '文档已被他人修改', { code: 'DOC_CONFLICT', doc: docJson(doc, me, true, access) });
    }
    const next: DocRecord = {
      ...doc,
      title: typeof title === 'string' ? title.trim() : doc.title,
      updated_at: nowIso(),
      updated_by: me.sub,
    };
    if (typeof markdown === 'string') {
      next.markdown = markdown;
      // REST 直改 markdown 后旧的协同态作废（下次协同会话从新 markdown 播种）
      next.yjs_update = null;
    }
    // 保证 updated_at 严格递增（同一毫秒内连续保存也能区分）
    if (next.updated_at <= doc.updated_at) next.updated_at = new Date(Date.parse(doc.updated_at) + 1).toISOString();
    const ok = await repo.updateDoc(next, doc.updated_at);
    if (!ok) {
      const latest = await repo.getDoc(doc_id);
      if (!latest) return fail(reply, 404, '文档不存在');
      return fail(reply, 409, '文档已被他人修改', { code: 'DOC_CONFLICT', doc: await shaped(latest, me, true) });
    }
    if (typeof markdown === 'string') {
      collabHub.closeRoom(doc_id, 4409, 'doc replaced');
      await bindReferencedFiles(ctx, me, next);
      versions.touch(doc_id, me.sub);
    }
    return docJson(next, me, true, access);
  });

  app.delete('/api/v1/docs/:doc_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    if (!(await docAccess(ctx, doc, me.sub)).permissions.can_delete) return fail(reply, 403, '没有删除权限', { code: 'FORBIDDEN' });
    await repo.deleteDoc(doc_id);
    collabHub.closeRoom(doc_id, 4404, 'doc deleted');
    return reply.code(204).send();
  });
}

function normalizeIso(s: string): string {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}
