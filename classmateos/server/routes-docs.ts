/**
 * 云文档（《前端接口需求文档》第 9 节）+ Yjs 协同 WS。
 */

import { verifyToken } from './auth.js';
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

function docJson(doc: DocRecord, me: AuthedUser, withMarkdown: boolean) {
  return {
    doc_id: doc.doc_id,
    title: doc.title,
    ...(withMarkdown ? { markdown: doc.markdown } : {}),
    summary: summaryOf(doc.markdown),
    created_by: doc.created_by,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    updated_by: doc.updated_by,
    can_edit: canEditDoc(me, doc),
    url: `/api/v1/docs/${doc.doc_id}`,
  };
}

export function registerDocRoutes(ctx: Ctx): void {
  const { app, repo, collabHub } = ctx;

  // 协同编辑 WS：/api/v1/docs/:doc_id/collab?token=<access_token>
  // 正文共享类型：Y.Text，key = "markdown"；非创建者只读（能收不能发）。
  app.get('/api/v1/docs/:doc_id/collab', { websocket: true }, (socket, req) => {
    const { doc_id } = req.params as { doc_id: string };
    const { token } = req.query as { token?: string };
    const p = token ? verifyToken(token, ctx.secret, 'access') : undefined;
    if (!p) {
      socket.close(4401, 'invalid token');
      return;
    }
    const readOnly = (async () => {
      const [user, doc] = await Promise.all([repo.getUser(p.sub), repo.getDoc(doc_id)]);
      if (!user) {
        socket.close(4401, 'invalid token');
        return true;
      }
      if (user.disabled) {
        socket.close(4403, 'account disabled');
        return true;
      }
      return !doc || !canEditDoc(p, doc);
    })();
    void collabHub.handleConnection(doc_id, socket, { readOnly }).catch(() => socket.close(1011, 'server error'));
  });

  app.get('/api/v1/docs', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { scope?: string; keyword?: string; page_size?: string; page_token?: string };
    const scope = q.scope === 'mine' || q.scope === 'shared' ? q.scope : 'all';
    const limit = pageSize(q.page_size, 50, 200);
    const offset = pageOffset(q.page_token);
    const page = await repo.listDocs({ userId: me.sub, scope, keyword: q.keyword, limit, offset });
    return pageResult(page.items.map((d) => docJson(d, me, false)), page.total, offset);
  });

  app.get('/api/v1/docs/:doc_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    return docJson(doc, me, true);
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
    return reply.code(201).send(docJson(doc, me, true));
  });

  app.patch('/api/v1/docs/:doc_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    if (!canEditDoc(me, doc)) return fail(reply, 403, '只有创建者可以编辑');
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
      return fail(reply, 409, '文档已被他人修改', { code: 'DOC_CONFLICT', doc: docJson(doc, me, true) });
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
      return fail(reply, 409, '文档已被他人修改', { code: 'DOC_CONFLICT', doc: docJson(latest, me, true) });
    }
    if (typeof markdown === 'string') collabHub.closeRoom(doc_id, 4409, 'doc replaced');
    return docJson(next, me, true);
  });

  app.delete('/api/v1/docs/:doc_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    if (doc.created_by !== me.sub && me.role !== 'admin') return fail(reply, 403, '只有创建者或管理员可以删除');
    await repo.deleteDoc(doc_id);
    collabHub.closeRoom(doc_id, 4404, 'doc deleted');
    return reply.code(204).send();
  });
}

function normalizeIso(s: string): string {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}
