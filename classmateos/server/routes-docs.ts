import type { NotificationService } from './notifications.js';
import { bindReferencedFiles, registerDocExtraRoutes, type DocVersions } from './doc-extras.js';
/**
 * 云文档（《前端接口需求文档》第 9 节）+ Yjs 协同 WS。
 */

import { verifyToken } from './auth.js';
import { docAccess, rawDocAccess, registerDocAccessRoutes } from './doc-access.js';
import { DocLibrary, LibraryError, TRASH_KEEP_DAYS } from './doc-library.js';
import { WIKI_DOC } from './wiki-access.js';
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

/** 文件夹 / 收藏 / 回收站相关的列表字段（doc.folders）。 */
interface DocExtras { folder_id: string | null; starred: boolean; deleted_at: string | null; last_viewed_at: string | null; wiki_space_id: string | null; wiki_node_id: string | null }

const DOC_SCOPES = new Set(['all', 'mine', 'shared', 'recent', 'starred', 'trash']);

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

  const lib = new DocLibrary(ctx);
  const libFail = (reply: Parameters<typeof fail>[0], e: unknown) => {
    if (e instanceof LibraryError) return fail(reply, e.status, e.message, { code: e.code });
    throw e;
  };
  /** 当前用户最近打开的文档：doc_id → 打开时间（由 routes-search 的「最近访问」记录）。 */
  const recentMap = async (uid: string) => {
    const rows = (await repo.relList('recent', { k1: uid }, { order: 'desc', limit: 200 })).items;
    const out = new Map<string, string>();
    for (const r of rows) if (r.data.type === 'doc' && !out.has(String(r.data.id))) out.set(String(r.data.id), r.updated_at);
    return out;
  };
  const wikiOf = async (docId: string) => {
    const w = await repo.getEntity(WIKI_DOC, docId);
    return { wiki_space_id: w ? String(w.data.space_id) : null, wiki_node_id: w ? String(w.data.node_id) : null };
  };
  const extrasFor = async (uid: string, docId: string): Promise<DocExtras> => ({
    ...(await wikiOf(docId)),
    folder_id: await lib.folderOfDoc(uid, docId),
    starred: (await lib.starredMap(uid)).has(docId),
    deleted_at: (await lib.trashInfo(docId))?.deleted_at ?? null,
    last_viewed_at: (await recentMap(uid)).get(docId) ?? null,
  });
  const full = async (doc: DocRecord, me: AuthedUser, withMarkdown: boolean, access?: Awaited<ReturnType<typeof docAccess>>) =>
    ({ ...docJson(doc, me, withMarkdown, access ?? await docAccess(ctx, doc, me.sub)), ...(await extrasFor(me.sub, doc.doc_id)) });
  /** 彻底删除：文档、协同房间、收藏 / 位置 / 回收站标记。 */
  const purge = async (docId: string) => {
    await repo.deleteDoc(docId);
    await lib.forget(docId);
    collabHub.closeRoom(docId, 4404, 'doc deleted');
  };

  /**
   * scope：all（默认）| mine | shared | recent | starred | trash。
   *   mine：所有者是自己；带 folder_id 列该文件夹，不带时只列根目录（带 keyword 时不限文件夹）。
   *   recent：按最近打开时间倒序；starred：按收藏时间倒序；trash：自己能删除的回收站文档，按删除时间倒序。
   */
  app.get('/api/v1/docs', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { scope?: string; keyword?: string; folder_id?: string; page_size?: string; page_token?: string };
    const scope = DOC_SCOPES.has(q.scope ?? '') ? q.scope! : 'all';
    const limit = pageSize(q.page_size, 50, 200);
    const offset = pageOffset(q.page_token);
    const folderId = q.folder_id && q.folder_id !== 'root' ? q.folder_id : null;
    if (folderId) {
      try { await lib.ownFolder(me.sub, folderId); } catch (e) { return libFail(reply, e); }
    }
    const kw = q.keyword?.trim() || undefined;
    if (scope === 'trash') {
      // 超过保留期的先彻底删除
      const expire = Date.now() - TRASH_KEEP_DAYS * 86_400_000;
      for (const [id, t] of await lib.trashMap()) if (Date.parse(t.deleted_at) < expire) await purge(id);
    }
    const [trash, stars, places, recent] = await Promise.all([lib.trashMap(), lib.starredMap(me.sub), lib.placementMap(me.sub), recentMap(me.sub)]);
    // 知识库页面不出现在「我的空间 / 共享给我」，最近、收藏、回收站里照常出现
    const wiki = new Map((await repo.listEntities(WIKI_DOC)).map((w) => [w.id, w.data as { space_id: string; node_id: string }]));
    const rows: { json: Record<string, unknown>; sort: string }[] = [];
    for (let at = 0; ; at += 200) {
      const page = await repo.listDocs({ userId: me.sub, scope: 'all', keyword: kw, limit: 200, offset: at });
      for (const d of page.items) {
        const t = trash.get(d.doc_id);
        if ((scope === 'trash') !== !!t) continue;
        if (scope === 'starred' && !stars.has(d.doc_id)) continue;
        if (scope === 'recent' && !recent.has(d.doc_id)) continue;
        const wk = wiki.get(d.doc_id);
        if (wk && (scope === 'mine' || scope === 'shared')) continue;
        const access = scope === 'trash' ? await rawDocAccess(ctx, d, me.sub) : await docAccess(ctx, d, me.sub);
        if (scope === 'trash' ? !access.permissions.can_delete : !access.permissions.can_view) continue;
        if (scope === 'mine') {
          if (access.owner_id !== me.sub) continue;
          const place = places.get(d.doc_id) ?? null;
          if (folderId ? place !== folderId : !kw && place !== null) continue;
        }
        if (scope === 'shared' && access.owner_id === me.sub) continue;
        const extras: DocExtras = { wiki_space_id: wk?.space_id ?? null, wiki_node_id: wk?.node_id ?? null, folder_id: places.get(d.doc_id) ?? null, starred: stars.has(d.doc_id), deleted_at: t?.deleted_at ?? null, last_viewed_at: recent.get(d.doc_id) ?? null };
        const sort = scope === 'trash' ? extras.deleted_at! : scope === 'recent' ? extras.last_viewed_at! : scope === 'starred' ? stars.get(d.doc_id)! : d.updated_at;
        rows.push({ json: { ...docJson(d, me, false, access), ...extras }, sort });
      }
      if (at + page.items.length >= page.total || page.items.length === 0) break;
    }
    // listDocs 已按 updated_at 倒序；其他范围按各自时间倒序（稳定排序）
    if (scope === 'trash' || scope === 'recent' || scope === 'starred') rows.sort((a, b) => b.sort.localeCompare(a.sort));
    const items = rows.map((r) => r.json);
    return pageResult(items.slice(offset, offset + limit), items.length, offset);
  });

  app.get('/api/v1/docs/:doc_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    if (await lib.trashInfo(doc_id)) return fail(reply, 404, '文档已在回收站', { code: 'DOC_IN_TRASH' });
    const access = await docAccess(ctx, doc, me.sub);
    if (!access.permissions.can_view) return fail(reply, 403, '没有权限访问，申请权限', { code: 'FORBIDDEN' });
    return full(doc, me, true, access);
  });

  app.post('/api/v1/docs', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { title, markdown, folder_id } = (req.body ?? {}) as { title?: unknown; markdown?: unknown; folder_id?: unknown };
    const errors: FieldError[] = [];
    if (folder_id !== undefined && folder_id !== null && typeof folder_id !== 'string') errors.push({ field: 'folder_id', message: '必须是文件夹 ID 或 null' });
    else if (typeof folder_id === 'string') {
      try { await lib.ownFolder(me.sub, folder_id); } catch (e) { return libFail(reply, e); }
    }
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
    if (typeof folder_id === 'string') await lib.place(me.sub, doc.doc_id, folder_id);
    return reply.code(201).send({ ...(await shaped(doc, me, true)), ...(await extrasFor(me.sub, doc.doc_id)) });
  });

  app.patch('/api/v1/docs/:doc_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    if (await lib.trashInfo(doc_id)) return fail(reply, 404, '文档已在回收站', { code: 'DOC_IN_TRASH' });
    const access = await docAccess(ctx, doc, me.sub);
    if (!access.permissions.can_view) return fail(reply, 403, '没有权限访问', { code: 'FORBIDDEN' });
    const { title, markdown, base_updated_at, folder_id } = (req.body ?? {}) as {
      title?: unknown;
      markdown?: unknown;
      base_updated_at?: unknown;
      folder_id?: unknown;
    };
    // 只移动文件夹：文件夹是所有者的「我的空间」，只有所有者能移动，不改 updated_at
    if (folder_id !== undefined) {
      if (folder_id !== null && typeof folder_id !== 'string') return invalid(reply, [{ field: 'folder_id', message: '必须是文件夹 ID 或 null' }]);
      if (access.owner_id !== me.sub) return fail(reply, 403, '只有所有者可以移动文档', { code: 'FORBIDDEN' });
      try { await lib.place(me.sub, doc_id, (folder_id as string | null) === 'root' ? null : folder_id as string | null); } catch (e) { return libFail(reply, e); }
      if (title === undefined && markdown === undefined) return full(doc, me, true, access);
    }
    if (!access.permissions.can_edit) return fail(reply, 403, '没有编辑权限', { code: 'FORBIDDEN' });
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
    return full(next, me, true, access);
  });

  app.delete('/api/v1/docs/:doc_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    // 默认进回收站；permanent=true 彻底删除（回收站里的也可以）
    const permanent = (req.query as { permanent?: string }).permanent === 'true';
    if (!(await rawDocAccess(ctx, doc, me.sub)).permissions.can_delete) return fail(reply, 403, '没有删除权限', { code: 'FORBIDDEN' });
    if (permanent) await purge(doc_id);
    else {
      await lib.trash(doc_id, me.sub);
      collabHub.closeRoom(doc_id, 4404, 'doc deleted');
    }
    return reply.code(204).send();
  });

  app.post('/api/v1/docs/:doc_id/restore', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在');
    const raw = await rawDocAccess(ctx, doc, me.sub);
    if (!raw.permissions.can_delete) return fail(reply, 403, '没有恢复权限', { code: 'FORBIDDEN' });
    if (!(await lib.trashInfo(doc_id))) return fail(reply, 409, '文档不在回收站', { code: 'NOT_IN_TRASH' });
    await lib.restore(doc_id);
    // 原文件夹已删除时放回根目录
    const place = await lib.folderOfDoc(me.sub, doc_id);
    if (place) { try { await lib.ownFolder(me.sub, place); } catch { await lib.place(me.sub, doc_id, null); } }
    return full(doc, me, false);
  });

  for (const method of ['POST', 'DELETE'] as const) {
    app.route({ method, url: '/api/v1/docs/:doc_id/star', handler: async (req, reply) => {
      const me = await ctx.requireUser(req, reply);
      if (!me) return;
      const { doc_id } = req.params as { doc_id: string };
      if (method === 'POST') {
        const doc = await repo.getDoc(doc_id);
        if (!doc) return fail(reply, 404, '文档不存在');
        if (!(await docAccess(ctx, doc, me.sub)).permissions.can_view) return fail(reply, 403, '没有权限访问', { code: 'FORBIDDEN' });
      }
      await lib.star(me.sub, doc_id, method === 'POST');
      return reply.code(204).send();
    } });
  }

  // ---------------- 文件夹（个人「我的空间」） ----------------
  app.get('/api/v1/folders', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { parent_id?: string };
    const parent = q.parent_id && q.parent_id !== 'root' ? q.parent_id : null;
    if (parent) { try { await lib.ownFolder(me.sub, parent); } catch (e) { return libFail(reply, e); } }
    const items = (await lib.folders(me.sub)).filter((f) => f.parent_id === parent)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.folder_id.localeCompare(b.folder_id));
    return pageResult(items, items.length, 0);
  });

  app.post('/api/v1/folders', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    try { return reply.code(201).send(await lib.createFolder(me.sub, (req.body ?? {}) as Record<string, unknown>)); } catch (e) { return libFail(reply, e); }
  });

  app.patch('/api/v1/folders/:folder_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { folder_id } = req.params as { folder_id: string };
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    if (body.parent_id === 'root') body.parent_id = null;
    try { return await lib.updateFolder(me.sub, folder_id, body); } catch (e) { return libFail(reply, e); }
  });

  /** 删除文件夹：下级文件夹一起删，里面自己能删的文档进回收站，其余放回根目录。 */
  app.delete('/api/v1/folders/:folder_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { folder_id } = req.params as { folder_id: string };
    let docIds: string[];
    try { docIds = await lib.deleteFolder(me.sub, folder_id); } catch (e) { return libFail(reply, e); }
    for (const id of docIds) {
      const doc = await repo.getDoc(id);
      if (doc && (await rawDocAccess(ctx, doc, me.sub)).permissions.can_delete) {
        await lib.trash(id, me.sub);
        collabHub.closeRoom(id, 4404, 'doc deleted');
      }
    }
    return reply.code(204).send();
  });
}

function normalizeIso(s: string): string {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}
