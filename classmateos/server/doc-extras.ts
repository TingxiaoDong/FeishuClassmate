/**
 * 二期迭代 2：文档评论（R-DC-02）、历史版本（R-DC-03）、图片 / 附件绑定（R-DC-04）。
 * 数据存在 Repo 的通用对象表（cos_entities）：
 *   doc_comment  scope = doc_id
 *   doc_version  scope = doc_id
 *   doc_file     scope = file_key，id = file_key|doc_id
 */

import { docAccess } from './doc-access.js';
import { viaBotFor } from './agent-context.js';
import { fail, invalid, newId, pageOffset, pageResult, pageSize, type AuthedUser, type Ctx, type FieldError } from './context.js';
import type { NotificationService } from './notifications.js';
import { nowIso, type DocRecord, type EntityRecord } from './repo.js';

const VERSION_GAP_MS = 30 * 60_000;
const MAX_TEXT = 5000;

interface Mention { user_id: string; name: string; offset: number; length: number }
interface RichText { text: string; mentions: Mention[] }
interface Reply { reply_id: string; user_id: string; content: RichText; created_at: string; updated_at: string | null }
interface CommentData {
  doc_id: string;
  quote: string | null;
  anchor: Record<string, unknown>;
  is_whole: boolean;
  solved: boolean;
  replies: Reply[];
  created_by: string;
}
interface VersionData { doc_id: string; markdown: string; title: string; name: string | null; created_by: string; added: number; removed: number; via_bot?: boolean }

/** 前后缀对齐的改动字数（用于版本列表「改了多少字」）。 */
export function diffCount(prev: string, next: string): { added: number; removed: number } {
  let p = 0;
  while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
  let s = 0;
  while (s < prev.length - p && s < next.length - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  return { added: next.length - p - s, removed: prev.length - p - s };
}

export function parseRichText(raw: unknown, field: string, errors: FieldError[]): RichText | undefined {
  if (typeof raw === 'string') raw = { text: raw, mentions: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ field, message: '必须是 { text, mentions } 对象' });
    return undefined;
  }
  const { text, mentions } = raw as { text?: unknown; mentions?: unknown };
  if (typeof text !== 'string' || !text.trim()) errors.push({ field: `${field}.text`, message: '不能为空' });
  else if (text.length > MAX_TEXT) errors.push({ field: `${field}.text`, message: `不能超过 ${MAX_TEXT} 字` });
  const out: Mention[] = [];
  if (mentions !== undefined && mentions !== null) {
    if (!Array.isArray(mentions) || mentions.length > 50) errors.push({ field: `${field}.mentions`, message: '必须是数组，最多 50 项' });
    else
      for (const [i, m] of mentions.entries()) {
        const x = m as Partial<Mention>;
        if (!x || typeof x.user_id !== 'string' || !x.user_id) {
          errors.push({ field: `${field}.mentions[${i}]`, message: '缺少 user_id' });
          continue;
        }
        out.push({ user_id: x.user_id, name: typeof x.name === 'string' ? x.name : '', offset: Number(x.offset) || 0, length: Number(x.length) || 0 });
      }
  }
  return errors.length ? undefined : { text: text as string, mentions: out };
}

/** 文档历史版本：首次创建、距上一版 30 分钟、停止编辑 idleMs 后、还原前后各存一版。 */
export class DocVersions {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  constructor(private readonly ctx: Ctx, private readonly idleMs = 2 * 60_000) {}

  async latest(docId: string): Promise<EntityRecord | undefined> {
    const list = await this.ctx.repo.listEntities('doc_version', docId);
    return list[list.length - 1];
  }

  async snapshot(doc: DocRecord, by: string, force = false): Promise<EntityRecord | undefined> {
    const last = await this.latest(doc.doc_id);
    const prev = (last?.data as VersionData | undefined)?.markdown ?? '';
    if (last && !force && prev === doc.markdown) return undefined;
    const now = nowIso();
    const rec: EntityRecord = {
      kind: 'doc_version',
      id: newId('ver'),
      scope: doc.doc_id,
      data: { doc_id: doc.doc_id, markdown: doc.markdown, title: doc.title, name: null, created_by: by, ...diffCount(prev, doc.markdown), ...(viaBotFor(by) ? { via_bot: true } : {}) } satisfies VersionData,
      version: 0,
      created_at: last && now <= last.created_at ? new Date(Date.parse(last.created_at) + 1).toISOString() : now,
      updated_at: now,
    };
    await this.ctx.repo.saveEntity(rec, 0);
    return rec;
  }

  /** 文档被保存后调用：距上一版超过 30 分钟立即存一版；并重置「停止编辑」计时。 */
  touch(docId: string, by: string | null): void {
    const run = async () => {
      const doc = await this.ctx.repo.getDoc(docId);
      if (doc) await this.snapshot(doc, by ?? doc.updated_by);
    };
    void (async () => {
      const last = await this.latest(docId);
      if (!last || Date.now() - Date.parse(last.created_at) >= VERSION_GAP_MS) await run();
    })().catch(() => undefined);
    clearTimeout(this.timers.get(docId));
    const t = setTimeout(() => {
      this.timers.delete(docId);
      void run().catch(() => undefined);
    }, this.idleMs);
    t.unref?.();
    this.timers.set(docId, t);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

const COS_FILE_RE = /cos-file:\/\/([A-Za-z0-9_\-.]+)/g;
export function cosFileKeys(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(COS_FILE_RE)].map((m) => m[1]))];
}

export async function bindDocFile(ctx: Ctx, fileKey: string, docId: string): Promise<void> {
  const now = nowIso();
  await ctx.repo.saveEntity({ kind: 'doc_file', id: `${fileKey}|${docId}`, scope: fileKey, data: { doc_id: docId }, version: 0, created_at: now, updated_at: now }, 0);
}

/** 正文里引用了自己能访问的文件，就绑定到文档（同事打开文档也能看图）。 */
export async function bindReferencedFiles(ctx: Ctx, me: AuthedUser, doc: DocRecord): Promise<void> {
  for (const key of cosFileKeys(doc.markdown).slice(0, 200)) {
    if (await ctx.repo.getEntity('doc_file', `${key}|${doc.doc_id}`)) continue;
    const file = await ctx.repo.getFile(key);
    if (file && (await ctx.canAccessFile(me, file))) await bindDocFile(ctx, key, doc.doc_id);
  }
}

export function registerDocExtraRoutes(ctx: Ctx, notifications: NotificationService, versions: DocVersions): void {
  const { app, repo } = ctx;

  // 附件跟文档走：能看文档的人就能下载文档里的图片 / 附件
  ctx.extraFileAccess.push(async (user, file) => {
    for (const link of await repo.listEntities('doc_file', file.file_key)) {
      const doc = await repo.getDoc(String(link.data.doc_id));
      if (doc && (await docAccess(ctx, doc, user.sub)).permissions.can_view) return true;
    }
    return false;
  });

  const load = async (req: { params: unknown }, reply: Parameters<typeof fail>[0], me: AuthedUser) => {
    const doc = await repo.getDoc((req.params as { doc_id: string }).doc_id);
    if (!doc) {
      fail(reply, 404, '文档不存在');
      return undefined;
    }
    const access = await docAccess(ctx, doc, me.sub);
    if (!access.permissions.can_view) {
      fail(reply, 403, '没有权限访问，申请权限', { code: 'FORBIDDEN' });
      return undefined;
    }
    return { doc, access };
  };

  const commentEvent = (docId: string, commentId: string, action: string) =>
    ctx.publish('doc.comment_changed', { doc_id: docId, comment_id: commentId, action }, undefined, { topic: `doc:${docId}`, all: true, user_only: true });

  const commentJson = (c: EntityRecord, doc: DocRecord) => {
    const d = c.data as unknown as CommentData;
    return {
      comment_id: c.id,
      doc_id: d.doc_id,
      quote: d.quote,
      anchor: d.anchor,
      is_whole: d.is_whole,
      solved: d.solved,
      replies: d.replies,
      created_by: d.created_by,
      created_at: c.created_at,
      updated_at: c.updated_at,
      quote_deleted: !d.is_whole && !!d.quote && !doc.markdown.includes(d.quote),
    };
  };

  /** 被 @ 的人（能看文档的）收 doc.mention；文档所有者、评论发起人收 doc.comment。 */
  const notifyComment = async (doc: DocRecord, actor: string, content: RichText, extra: string[], commentId: string) => {
    const name = await ctx.userName(actor);
    const mentioned = new Set(content.mentions.map((m) => m.user_id));
    const target = { type: 'doc', id: doc.doc_id, doc_id: doc.doc_id, comment_id: commentId };
    for (const uid of mentioned) {
      if (uid === actor || !(await docAccess(ctx, doc, uid)).permissions.can_view) continue;
      await notifications.notify({ user_id: uid, type: 'doc.mention', actor_id: actor, title: `${name} 在「${doc.title}」的评论里提到了你`, summary: content.text.slice(0, 80), target });
    }
    for (const uid of new Set(extra)) {
      if (uid === actor || mentioned.has(uid) || !(await docAccess(ctx, doc, uid)).permissions.can_view) continue;
      await notifications.notify({ user_id: uid, type: 'doc.comment', actor_id: actor, title: `${name} 评论了「${doc.title}」`, summary: content.text.slice(0, 80), target });
    }
  };

  /** 读 - 改 - 按版本写，冲突重试。 */
  const mutateComment = async (id: string, docId: string, fn: (d: CommentData) => CommentData | string) => {
    for (let i = 0; i < 5; i++) {
      const cur = await repo.getEntity('doc_comment', id);
      if (!cur || cur.scope !== docId) return { error: 404 as const };
      const next = fn(structuredClone(cur.data as unknown as CommentData));
      if (typeof next === 'string') return { error: next };
      const rec = { ...cur, data: next as unknown as Record<string, unknown>, updated_at: nowIso() };
      if (await repo.saveEntity(rec, cur.version)) return { rec: { ...rec, version: cur.version + 1 } };
    }
    return { error: 409 as const };
  };

  // ---------------- 评论 ----------------

  app.get('/api/v1/docs/:doc_id/comments', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    const q = req.query as { solved?: string; page_size?: string; page_token?: string };
    let list = await repo.listEntities('doc_comment', l.doc.doc_id);
    if (q.solved === 'true' || q.solved === 'false') list = list.filter((c) => (c.data as unknown as CommentData).solved === (q.solved === 'true'));
    const offset = pageOffset(q.page_token);
    const limit = pageSize(q.page_size, 50, 200);
    return pageResult(list.slice(offset, offset + limit).map((c) => commentJson(c, l.doc)), list.length, offset);
  });

  app.post('/api/v1/docs/:doc_id/comments', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    if (!l.access.permissions.can_comment) return fail(reply, 403, '没有评论权限', { code: 'FORBIDDEN' });
    const body = (req.body ?? {}) as { is_whole?: unknown; quote?: unknown; anchor?: unknown; content?: unknown };
    const errors: FieldError[] = [];
    const isWhole = body.is_whole === true;
    if (body.quote !== undefined && body.quote !== null && (typeof body.quote !== 'string' || body.quote.length > 2000)) errors.push({ field: 'quote', message: '必须是最多 2000 字的文本' });
    if (!isWhole && (typeof body.quote !== 'string' || !body.quote)) errors.push({ field: 'quote', message: '划词评论需要带被选中的原文' });
    if (body.anchor !== undefined && body.anchor !== null && (typeof body.anchor !== 'object' || Array.isArray(body.anchor) || JSON.stringify(body.anchor).length > 4000)) {
      errors.push({ field: 'anchor', message: '必须是对象' });
    }
    const content = parseRichText(body.content, 'content', errors);
    if (errors.length || !content) return invalid(reply, errors);
    const now = nowIso();
    const data: CommentData = {
      doc_id: l.doc.doc_id,
      quote: isWhole ? null : (body.quote as string),
      anchor: (body.anchor as Record<string, unknown> | undefined) ?? {}, // 原样保存（前端暂用 offset / length）
      is_whole: isWhole,
      solved: false,
      replies: [{ reply_id: newId('rpl'), user_id: me.sub, content, created_at: now, updated_at: null }],
      created_by: me.sub,
    };
    const rec: EntityRecord = { kind: 'doc_comment', id: newId('cmt'), scope: l.doc.doc_id, data: data as unknown as Record<string, unknown>, version: 0, created_at: now, updated_at: now };
    await repo.saveEntity(rec, 0);
    commentEvent(l.doc.doc_id, rec.id, 'created');
    await notifyComment(l.doc, me.sub, content, [l.access.owner_id], rec.id);
    return reply.code(201).send(commentJson(rec, l.doc));
  });

  app.post('/api/v1/docs/:doc_id/comments/:comment_id/replies', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    if (!l.access.permissions.can_comment) return fail(reply, 403, '没有评论权限', { code: 'FORBIDDEN' });
    const errors: FieldError[] = [];
    const content = parseRichText((req.body as { content?: unknown } | null)?.content, 'content', errors);
    if (!content) return invalid(reply, errors);
    const r: Reply = { reply_id: newId('rpl'), user_id: me.sub, content, created_at: nowIso(), updated_at: null };
    const { comment_id } = req.params as { comment_id: string };
    const out = await mutateComment(comment_id, l.doc.doc_id, (d) => {
      if (d.replies.length >= 500) return '回复太多了';
      d.replies.push(r);
      d.solved = false;
      return d;
    });
    if (out.error === 404) return fail(reply, 404, '评论不存在');
    if (out.error) return fail(reply, out.error === 409 ? 409 : 422, out.error === 409 ? '评论刚被修改，请重试' : out.error, { code: out.error === 409 ? 'VERSION_CONFLICT' : 'VALIDATION_FAILED' });
    const d = out.rec!.data as unknown as CommentData;
    commentEvent(l.doc.doc_id, comment_id, 'updated');
    await notifyComment(l.doc, me.sub, content, [d.created_by, l.access.owner_id], comment_id);
    return reply.code(201).send(r);
  });

  app.patch('/api/v1/docs/:doc_id/comments/:comment_id/replies/:reply_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    const errors: FieldError[] = [];
    const content = parseRichText((req.body as { content?: unknown } | null)?.content, 'content', errors);
    if (!content) return invalid(reply, errors);
    const { comment_id, reply_id } = req.params as { comment_id: string; reply_id: string };
    let updated: Reply | undefined;
    const out = await mutateComment(comment_id, l.doc.doc_id, (d) => {
      const r = d.replies.find((x) => x.reply_id === reply_id);
      if (!r) return 'NOT_FOUND';
      if (r.user_id !== me.sub) return 'FORBIDDEN';
      r.content = content;
      r.updated_at = nowIso();
      updated = r;
      return d;
    });
    if (out.error === 404 || out.error === 'NOT_FOUND') return fail(reply, 404, '回复不存在');
    if (out.error === 'FORBIDDEN') return fail(reply, 403, '只能修改自己的回复', { code: 'FORBIDDEN' });
    if (out.error) return fail(reply, 409, '评论刚被修改，请重试', { code: 'VERSION_CONFLICT' });
    commentEvent(l.doc.doc_id, comment_id, 'updated');
    return updated;
  });

  app.delete('/api/v1/docs/:doc_id/comments/:comment_id/replies/:reply_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    const { comment_id, reply_id } = req.params as { comment_id: string; reply_id: string };
    const out = await mutateComment(comment_id, l.doc.doc_id, (d) => {
      const r = d.replies.find((x) => x.reply_id === reply_id);
      if (!r) return 'NOT_FOUND';
      if (r.user_id !== me.sub) return 'FORBIDDEN';
      d.replies = d.replies.filter((x) => x !== r);
      return d;
    });
    if (out.error === 404 || out.error === 'NOT_FOUND') return fail(reply, 404, '回复不存在');
    if (out.error === 'FORBIDDEN') return fail(reply, 403, '只能删除自己的回复', { code: 'FORBIDDEN' });
    if (out.error) return fail(reply, 409, '评论刚被修改，请重试', { code: 'VERSION_CONFLICT' });
    // 最后一条回复删掉后整条评论消失
    if ((out.rec!.data as unknown as CommentData).replies.length === 0) {
      await repo.deleteEntity('doc_comment', comment_id);
      commentEvent(l.doc.doc_id, comment_id, 'deleted');
    } else commentEvent(l.doc.doc_id, comment_id, 'updated');
    return reply.code(204).send();
  });

  app.patch('/api/v1/docs/:doc_id/comments/:comment_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    if (!l.access.permissions.can_comment) return fail(reply, 403, '没有评论权限', { code: 'FORBIDDEN' });
    const solved = (req.body as { solved?: unknown } | null)?.solved;
    if (typeof solved !== 'boolean') return invalid(reply, [{ field: 'solved', message: '必须是 true 或 false' }]);
    const { comment_id } = req.params as { comment_id: string };
    const out = await mutateComment(comment_id, l.doc.doc_id, (d) => ({ ...d, solved }));
    if (out.error === 404) return fail(reply, 404, '评论不存在');
    if (out.error) return fail(reply, 409, '评论刚被修改，请重试', { code: 'VERSION_CONFLICT' });
    commentEvent(l.doc.doc_id, comment_id, solved ? 'solved' : 'reopened');
    return commentJson(out.rec!, l.doc);
  });

  // ---------------- 历史版本 ----------------

  const versionJson = (v: EntityRecord) => {
    const d = v.data as unknown as VersionData;
    return { version_id: v.id, name: d.name, created_by: d.created_by, created_at: v.created_at, added: d.added, removed: d.removed, ...(d.via_bot ? { via_bot: true } : {}) };
  };
  const getVersion = async (docId: string, id: string) => {
    const v = await repo.getEntity('doc_version', id);
    return v && v.scope === docId ? v : undefined;
  };

  app.get('/api/v1/docs/:doc_id/versions', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    const q = req.query as { page_size?: string; page_token?: string };
    const list = (await repo.listEntities('doc_version', l.doc.doc_id)).reverse();
    const offset = pageOffset(q.page_token);
    return pageResult(list.slice(offset, offset + pageSize(q.page_size, 50, 200)).map(versionJson), list.length, offset);
  });

  app.get('/api/v1/docs/:doc_id/versions/:version_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    const v = await getVersion(l.doc.doc_id, (req.params as { version_id: string }).version_id);
    if (!v) return fail(reply, 404, '版本不存在');
    const d = v.data as unknown as VersionData;
    return { ...versionJson(v), title: d.title, markdown: d.markdown };
  });

  app.patch('/api/v1/docs/:doc_id/versions/:version_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    if (!l.access.permissions.can_edit) return fail(reply, 403, '没有编辑权限', { code: 'FORBIDDEN' });
    const name = (req.body as { name?: unknown } | null)?.name;
    if (name !== null && (typeof name !== 'string' || name.length > 50)) return invalid(reply, [{ field: 'name', message: '版本名最多 50 字' }]);
    const v = await getVersion(l.doc.doc_id, (req.params as { version_id: string }).version_id);
    if (!v) return fail(reply, 404, '版本不存在');
    const next = { ...v, data: { ...v.data, name: typeof name === 'string' && name.trim() ? name.trim() : null }, updated_at: nowIso() };
    if (!(await repo.saveEntity(next, v.version))) return fail(reply, 409, '版本刚被修改，请重试', { code: 'VERSION_CONFLICT' });
    return versionJson(next);
  });

  app.post('/api/v1/docs/:doc_id/versions/:version_id/restore', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const l = await load(req, reply, me);
    if (!l) return;
    if (!l.access.permissions.can_edit) return fail(reply, 403, '没有编辑权限', { code: 'FORBIDDEN' });
    const v = await getVersion(l.doc.doc_id, (req.params as { version_id: string }).version_id);
    if (!v) return fail(reply, 404, '版本不存在');
    // 还原前先把当前内容存一版，避免丢失
    await versions.snapshot(l.doc, l.doc.updated_by);
    let updatedAt = nowIso();
    if (updatedAt <= l.doc.updated_at) updatedAt = new Date(Date.parse(l.doc.updated_at) + 1).toISOString();
    const next: DocRecord = { ...l.doc, markdown: (v.data as unknown as VersionData).markdown, yjs_update: null, updated_at: updatedAt, updated_by: me.sub };
    if (!(await repo.updateDoc(next, l.doc.updated_at))) return fail(reply, 409, '文档已被他人修改，请重试', { code: 'DOC_CONFLICT' });
    ctx.collabHub.closeRoom(next.doc_id, 4409, 'doc replaced');
    const created = await versions.snapshot(next, me.sub, true);
    return { doc_id: next.doc_id, updated_at: next.updated_at, version: created ? versionJson(created) : null };
  });
}
