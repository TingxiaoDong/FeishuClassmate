/**
 * 二期迭代 4 R-SR-01：全局搜索与最近访问（《二期迭代4_前端接口需求与进度.md》第 4 节）。
 *
 * GET /search?q=&types=user,chat,message,doc,wiki,record,task,event&page_size=&page_token=
 *   筛选：chat_id / sender_id / start_ms（消息）、owner_id / start_ms（文档）、table_key（记录）。
 *   每组返回准确的 total；page_token 是不透明字符串（目前是偏移量）。结果全部按权限过滤。
 *   匹配：不区分大小写的子串匹配，空格分隔的多个词要全部出现（中文不需要分词也能搜到任意连续片段）；
 *   高亮只用 <em>…</em>。
 *   知识库（wiki）还没实现，请求 wiki 时返回空分组。
 * GET /recent?page_size= ：最近访问的文档 / 表格 / 记录（打开详情时自动记录），返回前重新校验权限。
 */

import type { FastifyRequest } from 'fastify';
import { fail, invalid, pageSize, type AuthedUser, type Ctx } from './context.js';
import { docAccess } from './doc-access.js';
import { nowIso, type ChatRecord, type MessageRecord } from './repo.js';
import { canAccessRecord, hasRowAccessRule } from './row-access.js';
import { occurrences, parseRRule } from './rrule.js';
import { TaskAccess } from './task-access.js';

export const SEARCH_TYPES = ['user', 'chat', 'message', 'doc', 'wiki', 'record', 'task', 'event'] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

interface Hit {
  id: string;
  title: string;
  snippet: string;
  updated_at: string | null;
  extra?: Record<string, unknown>;
}

const MAX_SCAN = 5000;
const RECENT_KEEP = 100;

/** 去掉原文里的 <em> 标签，避免被当成高亮。 */
const clean = (s: string) => s.replace(/<\/?em>/gi, '');

export function highlight(text: string, terms: string[]): string {
  const t = clean(text);
  if (!terms.length) return t;
  const lower = t.toLowerCase();
  const marks: Array<[number, number]> = [];
  for (const term of terms) {
    const k = term.toLowerCase();
    for (let i = lower.indexOf(k); i >= 0; i = lower.indexOf(k, i + k.length)) marks.push([i, i + k.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m]);
  }
  let out = '';
  let at = 0;
  for (const [a, b] of merged) {
    out += `${t.slice(at, a)}<em>${t.slice(a, b)}</em>`;
    at = b;
  }
  return out + t.slice(at);
}

/** 关键词附近的一段（前 30 字、后 60 字），并高亮。 */
export function snippetOf(text: string, terms: string[], width = 90): string {
  const t = clean(text).replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();
  const i = Math.min(...terms.map((k) => lower.indexOf(k.toLowerCase())).filter((x) => x >= 0), Infinity);
  if (!Number.isFinite(i)) return highlight(t.slice(0, width), terms);
  const start = Math.max(0, i - 30);
  const part = t.slice(start, start + width);
  return (start > 0 ? '…' : '') + highlight(part, terms) + (start + width < t.length ? '…' : '');
}

const matchesAll = (texts: unknown[], terms: string[]) => {
  const joined = texts.filter((x) => typeof x === 'string').join('\n').toLowerCase();
  return terms.every((k) => joined.includes(k.toLowerCase()));
};

const fieldText = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? String((x as Record<string, unknown>).name ?? (x as Record<string, unknown>).text ?? '') : fieldText(x))).join('、');
  if (typeof v === 'object') return String((v as Record<string, unknown>).text ?? (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).link ?? '');
  return '';
};

export function registerSearchRoutes(ctx: Ctx, opts: { defaultZone: () => string | number; now?: () => number }): void {
  const { app, repo } = ctx;
  const now = opts.now ?? Date.now;

  // ---------------- 最近访问：打开详情成功时记录 ----------------
  // 让 onSend 能拿到已登录用户（不改变 requireUser 的行为）
  const origRequire = ctx.requireUser.bind(ctx);
  ctx.requireUser = async (req, reply) => {
    const u = await origRequire(req, reply);
    if (u) (req as FastifyRequest & { cosUser?: AuthedUser }).cosUser = u;
    return u;
  };

  const tableTitle = (key: string) => ctx.tableDefs.get(key)?.name ?? key;
  const primaryOf = (key: string) => {
    const custom = ctx.customTables?.get?.(key) as { primary_field?: string } | undefined;
    return custom?.primary_field ?? ctx.tableDefs.get(key)?.fields[0]?.field_name;
  };
  const recordTitle = (key: string, fields: Record<string, unknown>) => {
    const p = primaryOf(key);
    return (p ? fieldText(fields[p]) : '') || '未命名记录';
  };

  const remember = async (userId: string, type: 'doc' | 'table' | 'record', id: string, title: string, extra: Record<string, unknown> = {}) => {
    // 先删再插：同一毫秒内重复打开时也能靠插入顺序排到最前
    await repo.relDelete('recent', userId, `${type}:${id}`);
    await repo.relPut({ kind: 'recent', k1: userId, k2: `${type}:${id}`, k3: '', data: { type, id, title, extra }, at: nowIso() }, { upsert: true });
    const old = await repo.relList('recent', { k1: userId }, { order: 'desc', offset: RECENT_KEEP });
    for (const r of old.items) await repo.relDelete('recent', userId, r.k2);
  };

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'GET' || reply.statusCode !== 200) return payload;
    const user = (req as FastifyRequest & { cosUser?: AuthedUser }).cosUser;
    if (!user) return payload;
    const route = req.routeOptions?.url;
    const p = req.params as Record<string, string>;
    try {
      if (route === '/api/v1/docs/:doc_id') {
        const doc = await repo.getDoc(p.doc_id);
        if (doc) await remember(user.sub, 'doc', doc.doc_id, doc.title);
      } else if (route === '/api/v1/tables/:table_key' && ctx.tableDefs.has(p.table_key)) {
        await remember(user.sub, 'table', p.table_key, tableTitle(p.table_key), { table_key: p.table_key });
      } else if (route === '/api/v1/tables/:table_key/records/:record_id') {
        const rec = await ctx.store.get(p.table_key, p.record_id).catch(() => undefined);
        if (rec) await remember(user.sub, 'record', rec.record_id, recordTitle(p.table_key, rec.fields), { table_key: p.table_key, table_name: tableTitle(p.table_key) });
      }
    } catch {
      // 记录最近访问失败不影响请求
    }
    return payload;
  });

  app.get('/api/v1/recent', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const limit = pageSize((req.query as { page_size?: string }).page_size, 10, 50);
    const rows = (await repo.relList('recent', { k1: me.sub }, { order: 'desc', limit: RECENT_KEEP })).items;
    const items = [];
    for (const r of rows) {
      if (items.length >= limit) break;
      const type = String(r.data.type);
      const id = String(r.data.id);
      const extra = (r.data.extra ?? {}) as Record<string, unknown>;
      // 重新校验权限、刷新标题；已删除或没有权限的不返回
      if (type === 'doc') {
        const doc = await repo.getDoc(id);
        if (!doc || !(await docAccess(ctx, doc, me.sub)).permissions.can_view) continue;
        items.push({ type, id, title: doc.title, visited_at: r.updated_at, extra: { owner_id: (await docAccess(ctx, doc, me.sub)).owner_id } });
      } else if (type === 'table') {
        if (!ctx.tableDefs.has(id)) continue;
        items.push({ type, id, title: tableTitle(id), visited_at: r.updated_at, extra });
      } else if (type === 'record') {
        const key = String(extra.table_key);
        const def = ctx.tableDefs.get(key);
        const rec = def ? await ctx.store.get(key, id).catch(() => undefined) : undefined;
        if (!def || !rec || !canAccessRecord(me, def, rec)) continue;
        items.push({ type, id, title: recordTitle(key, rec.fields), visited_at: r.updated_at, extra: { table_key: key, table_name: def.name } });
      }
    }
    return { items };
  });

  // ---------------- 全局搜索 ----------------

  type Page = { total: number; items: Hit[] };
  type Params = { terms: string[]; limit: number; offset: number; q: Record<string, string | undefined>; sinceIso?: string; sinceMs?: number };
  const paged = (all: Hit[], p: Params): Page => ({ total: all.length, items: all.slice(p.offset, p.offset + p.limit) });

  const searchUsers = async (me: AuthedUser, p: Params): Promise<Page> => {
    const all: Hit[] = [];
    for (let at = 0; at < MAX_SCAN; at += 200) {
      const page = await repo.listUsers({ keyword: p.terms[0], limit: 200, offset: at });
      for (const u of page.items) {
        if (u.disabled || u.role === 'bot' || !matchesAll([u.name, u.user_id, u.email], p.terms)) continue;
        all.push({ id: u.user_id, title: highlight(u.name, p.terms), snippet: u.department ? clean(u.department) : '', updated_at: null, extra: { department: u.department ?? null } });
      }
      if (at + page.items.length >= page.total || !page.items.length) break;
    }
    return paged(all, p);
  };

  const chatName = async (chat: ChatRecord, me: string) => {
    if (chat.name) return chat.name;
    const others = chat.member_ids.filter((id) => id !== me && id !== 'bot' && id !== 'system');
    return (await Promise.all(others.map((id) => ctx.userName(id)))).join('、');
  };

  const searchChats = async (me: AuthedUser, p: Params): Promise<Page> => {
    const all: Hit[] = [];
    for (let at = 0; at < MAX_SCAN; at += 200) {
      const page = await repo.listChatViews(me.sub, { limit: 200, offset: at });
      for (const v of page.items) {
        if (v.chat.chat_type !== 'group' || v.chat.kind === 'drive') continue; // 单聊通过「联系人」搜索
        const name = await chatName(v.chat, me.sub);
        if (!matchesAll([name], p.terms)) continue;
        all.push({ id: v.chat.chat_id, title: highlight(name, p.terms), snippet: '', updated_at: v.chat.updated_at, extra: { member_count: v.chat.member_ids.length } });
      }
      if (at + page.items.length >= page.total || !page.items.length) break;
    }
    return paged(all, p);
  };

  const msgText = (m: MessageRecord) =>
    [m.content.text, m.content.title, m.content.markdown, m.content.file_name].filter((x): x is string => typeof x === 'string').join(' ');

  const searchMessages = async (me: AuthedUser, p: Params): Promise<Page> => {
    const base = { chatId: p.q.chat_id || undefined, senderId: p.q.sender_id || undefined, sinceIso: p.sinceIso };
    const toHit = (m: MessageRecord): Hit => ({
      id: m.message_id,
      title: snippetOf(msgText(m), p.terms),
      snippet: '',
      updated_at: m.created_at,
      extra: { chat_id: m.chat_id, sender_id: m.sender_id, thread_root_id: m.thread_root_id ?? null },
    });
    if (p.terms.length === 1) {
      const res = await repo.searchMessages(me.sub, { keyword: p.terms[0], ...base, limit: p.limit, offset: p.offset });
      return { total: res.total, items: res.items.map(toHit) };
    }
    // 多个词：用最长的词在库里筛，其余在内存里过滤
    const longest = [...p.terms].sort((a, b) => b.length - a.length)[0];
    const res = await repo.searchMessages(me.sub, { keyword: longest, ...base, limit: MAX_SCAN, offset: 0 });
    const hits = res.items.filter((m) => matchesAll([msgText(m)], p.terms)).map(toHit);
    return paged(hits, p);
  };

  const searchDocs = async (me: AuthedUser, p: Params): Promise<Page> => {
    const longest = [...p.terms].sort((a, b) => b.length - a.length)[0];
    const docs = await repo.searchDocs({ keyword: longest, sinceIso: p.sinceIso, limit: MAX_SCAN });
    const all: Hit[] = [];
    for (const d of docs) {
      if (!matchesAll([d.title, d.markdown], p.terms)) continue;
      const access = await docAccess(ctx, d, me.sub);
      if (!access.permissions.can_view) continue;
      if (p.q.owner_id && access.owner_id !== p.q.owner_id) continue;
      const inTitle = matchesAll([d.title], p.terms);
      all.push({
        id: d.doc_id,
        title: highlight(d.title || '未命名文档', p.terms),
        snippet: inTitle && !matchesAll([d.markdown], p.terms.slice(0, 1)) ? clean(d.markdown).slice(0, 90) : snippetOf(d.markdown, p.terms),
        updated_at: d.updated_at,
        extra: { owner_id: access.owner_id },
      });
    }
    return paged(all, p);
  };

  const searchRecords = async (me: AuthedUser, p: Params): Promise<Page> => {
    const all: Hit[] = [];
    const keys = p.q.table_key ? [p.q.table_key] : [...ctx.tableDefs.keys()];
    for (const key of keys) {
      const def = ctx.tableDefs.get(key);
      if (!def) continue;
      const confidentialFor = hasRowAccessRule(def) && me.role !== 'admin' ? me.sub : undefined;
      let token: string | undefined;
      for (let n = 0; n < MAX_SCAN; n += 500) {
        const res = await ctx.store.list(key, { keyword: p.terms[0], pageSize: 500, pageToken: token, confidentialFor });
        for (const rec of res.items) {
          if (!canAccessRecord(me, def, rec)) continue;
          const texts = def.fields.map((f) => fieldText(rec.fields[f.field_name]));
          if (!matchesAll(texts, p.terms)) continue;
          const title = recordTitle(key, rec.fields);
          const hitField = def.fields.find((f) => matchesAll([fieldText(rec.fields[f.field_name])], p.terms.slice(0, 1)));
          const snippet = hitField && hitField.field_name !== primaryOf(key) ? `${hitField.field_name}：${snippetOf(fieldText(rec.fields[hitField.field_name]), p.terms, 60)}` : '';
          all.push({ id: rec.record_id, title: highlight(title, p.terms), snippet, updated_at: rec.updated_at, extra: { table_key: key, table_name: def.name } });
        }
        if (!res.has_more || !res.page_token) break;
        token = res.page_token;
      }
    }
    all.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return paged(all, p);
  };

  const searchTasks = async (me: AuthedUser, p: Params): Promise<Page> => {
    const access = new TaskAccess(ctx, me.sub);
    const tasks = await repo.listTasks(me.sub, { extra_ids: await access.taskIdsInMyLists() });
    const all: Hit[] = [];
    for (const t of tasks) {
      if (!matchesAll([t.title, t.description], p.terms)) continue;
      access.remember(t);
      if (!(await access.role(t))) continue;
      all.push({
        id: t.task_id,
        title: highlight(t.title, p.terms),
        snippet: t.description && matchesAll([t.description], p.terms.slice(0, 1)) ? snippetOf(t.description, p.terms) : '',
        updated_at: t.updated_at,
        extra: { status: t.status, due_ms: t.due_ms ?? null, parent_id: t.parent_id ?? null },
      });
    }
    all.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return paged(all, p);
  };

  const searchEvents = async (me: AuthedUser, p: Params): Promise<Page> => {
    const singles = await repo.listEvents(me.sub, -8.64e15, 8.64e15);
    const series = await repo.listRecurringEvents(me.sub, 8.64e15);
    const all: Array<Hit & { _t: number }> = [];
    const t0 = now();
    for (const ev of [...singles, ...series]) {
      if (!matchesAll([ev.title, ev.description, ev.location], p.terms)) continue;
      // 重复日程：定位到下一次（没有下一次就用最后能找到的那次之前的首次）
      let start = ev.start_ms;
      if (ev.recurrence) {
        try {
          const zone = ev.timezone ?? opts.defaultZone();
          const next = occurrences(parseRRule(ev.recurrence, zone), ev.start_ms, zone, Infinity, t0 - (ev.end_ms - ev.start_ms));
          for (const x of next) {
            if (x + (ev.end_ms - ev.start_ms) > t0 && !(ev.exdates ?? []).includes(x)) { start = x; break; }
          }
        } catch {
          // 规则损坏时用首次
        }
      }
      all.push({
        id: ev.event_id,
        title: highlight(ev.title, p.terms),
        snippet: ev.location ? clean(ev.location) : '',
        updated_at: ev.updated_at,
        extra: { start_ms: start, end_ms: start + (ev.end_ms - ev.start_ms), all_day: ev.all_day, recurring_event_id: ev.recurring_event_id ?? (ev.recurrence ? ev.event_id : null) },
        _t: start,
      });
    }
    // 离现在近的在前
    all.sort((a, b) => Math.abs(a._t - t0) - Math.abs(b._t - t0));
    return { total: all.length, items: all.slice(p.offset, p.offset + p.limit).map(({ _t: _drop, ...h }) => h) };
  };

  const searchers: Record<SearchType, (me: AuthedUser, p: Params) => Promise<Page>> = {
    user: searchUsers,
    chat: searchChats,
    message: searchMessages,
    doc: searchDocs,
    wiki: async () => ({ total: 0, items: [] }), // 知识库尚未实现
    record: searchRecords,
    task: searchTasks,
    event: searchEvents,
  };

  app.get('/api/v1/search', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as Record<string, string | undefined>;
    const raw = (q.q ?? q.keyword ?? '').trim();
    if (!raw) return fail(reply, 400, '请输入搜索关键词');
    if (raw.length > 100) return invalid(reply, [{ field: 'q', message: '关键词不能超过 100 字' }]);
    const terms = [...new Set(raw.split(/\s+/).filter(Boolean))].slice(0, 5);
    let types: SearchType[];
    if (q.types) {
      const list = q.types.split(',').map((x) => x.trim()).filter(Boolean);
      const bad = list.filter((x) => !(SEARCH_TYPES as readonly string[]).includes(x));
      if (bad.length) return invalid(reply, [{ field: 'types', message: `不支持的类型：${bad.join('、')}` }]);
      types = [...new Set(list)] as SearchType[];
    } else if (q.scope === 'wiki') types = ['wiki'];
    else types = SEARCH_TYPES.filter((t) => t !== 'wiki');
    const limit = pageSize(q.page_size, types.length > 1 ? 3 : 20, 50);
    // page_token 只在单类型时有意义
    const offset = types.length === 1 && q.page_token ? Number(q.page_token) : 0;
    if (!Number.isInteger(offset) || offset < 0) return invalid(reply, [{ field: 'page_token', message: '无效的分页游标' }]);
    let sinceMs: number | undefined;
    if (q.start_ms !== undefined) {
      sinceMs = Number(q.start_ms);
      if (!Number.isFinite(sinceMs)) return invalid(reply, [{ field: 'start_ms', message: '必须是毫秒时间戳' }]);
    }
    const p: Params = { terms, limit, offset, q, sinceMs, sinceIso: sinceMs !== undefined ? new Date(sinceMs).toISOString() : undefined };
    const groups = await Promise.all(types.map(async (type) => {
      const page = await searchers[type](me, p);
      const next = offset + page.items.length;
      return { type, total: page.total, items: page.items, ...(next < page.total ? { page_token: String(next) } : {}) };
    }));
    return { groups };
  });
}
