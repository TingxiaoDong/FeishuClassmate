/**
 * 二期迭代 4：消息增强（《二期迭代4_前端接口需求与进度.md》第 3、5、6 节）。
 *   R-IM-01 已读回执   R-IM-02 话题   R-IM-03 表情回应   R-IM-04 转发
 *   R-IM-05 加急       R-IM-06 收藏 / Pin   R-IM-07 链接预览（发送时由 routes-im 触发）
 *
 * 小记录统一存在关系表（repo.rel*）：
 *   react   k1=message_id k2=emoji   k3=user_id
 *   tfollow k1=root_id    k2=user_id               data {chat_id}
 *   tread   k1=user_id    k2=root_id               data {seq}       话题已读位置
 *   urgent  k1=message_id k2=user_id               data {from_user_id, chat_id, type, acked_at}
 *   fav     k1=user_id    k2=message_id            data {favorite_id, chat_id}
 *   pin     k1=chat_id    k2=message_id            data {pinned_by}
 *   idem    k1=user_id    k2=<scope>:<client_request_id>  data {status, message_ids}
 */

import type { FastifyReply } from 'fastify';
import { BOT_ID, SYSTEM_SENDER, fail, invalid, newId, pageOffset, pageSize, type AuthedUser, type Ctx } from './context.js';
import type { NotificationService } from './notifications.js';
import { isThreadOnly, nowIso, publicMessage, type ChatRecord, type MessageRecord } from './repo.js';

const EMOJI_RE = /^[A-Za-z0-9_]{1,32}$/;
const FORWARDABLE = new Set(['text', 'post', 'image', 'file', 'merge_forward']);
const MAX_FORWARD_CHATS = 10;
const MAX_FORWARD_MESSAGES = 100;
const MAX_PINS = 10;

/** 每个 key 在时间窗内最多 n 次。 */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly n: number, private readonly windowMs: number) {}
  allow(key: string): boolean {
    const t = Date.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.n) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    return true;
  }
}

/** 消息文字摘要（加急横幅、通知用）。 */
export function messagePreview(m: MessageRecord): string {
  if (m.recalled) return '[消息已撤回]';
  const c = m.content;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (m.msg_type) {
    case 'text': return s(c.text).slice(0, 80);
    case 'post': return (s(c.title) || s(c.markdown) || s(c.text)).slice(0, 80);
    case 'image': return '[图片]';
    case 'file': return `[文件] ${s(c.file_name)}`.trim();
    case 'merge_forward': return `[聊天记录] ${s(c.title)}`.trim();
    case 'interactive_card': return `[卡片] ${s(c.title) || s(c.question)}`.trim();
    default: return s(c.text).slice(0, 80);
  }
}

/** 内容里引用的全部文件（含合并转发里嵌套的）。 */
function fileKeysOf(msgType: string, content: Record<string, unknown>, out: string[] = []): string[] {
  if ((msgType === 'image' || msgType === 'file') && typeof content.file_key === 'string') out.push(content.file_key);
  if (msgType === 'merge_forward' && Array.isArray(content.messages)) {
    for (const x of content.messages as Array<{ msg_type?: string; content?: Record<string, unknown> }>) {
      if (x && typeof x.msg_type === 'string' && x.content && typeof x.content === 'object') fileKeysOf(x.msg_type, x.content, out);
    }
  }
  return out;
}

export function registerImPlusRoutes(ctx: Ctx, deps: { notifications?: NotificationService }): {
  chatExtras(chats: ChatRecord[], userId: string): Promise<Map<string, Record<string, unknown>>>;
} {
  const { app, repo } = ctx;
  const urgentLimiter = new RateLimiter(10, 60_000);
  const reactionLimiter = new RateLimiter(60, 60_000);

  const realMembers = (chat: ChatRecord) => chat.member_ids.filter((id) => id !== BOT_ID && id !== SYSTEM_SENDER);

  // ---------------- 按用户视角补充字段 ----------------

  const decorate = async (msgs: MessageRecord[], me: string): Promise<Record<string, unknown>[]> => {
    if (!msgs.length) return [];
    const ids = msgs.map((m) => m.message_id);
    const rootIds = msgs.filter((m) => !m.thread_root_id).map((m) => m.message_id);
    const [stats, follows, reacts] = await Promise.all([
      repo.threadStats(rootIds),
      rootIds.length ? repo.relList('tfollow', { k1: rootIds, k2: me }) : Promise.resolve({ items: [], total: 0 }),
      repo.relList('react', { k1: ids }, { order: 'asc' }),
    ]);
    const followed = new Set(follows.items.map((r) => r.k1));
    const own = msgs.filter((m) => m.sender_id === me && !isThreadOnly(m) && m.msg_type !== 'system');
    const urgents = own.length ? (await repo.relList('urgent', { k1: own.map((m) => m.message_id) }, { order: 'asc' })).items : [];
    const chats = new Map<string, { chat?: ChatRecord; reads: Map<string, number> }>();
    for (const m of own) {
      if (chats.has(m.chat_id)) continue;
      const chat = await repo.getChat(m.chat_id);
      const reads = new Map((await repo.chatReadStates(m.chat_id)).map((r) => [r.user_id, r.last_read_seq]));
      chats.set(m.chat_id, { chat, reads });
    }
    return msgs.map((m) => {
      const out: Record<string, unknown> = { ...publicMessage(m) };
      // 表情（撤回后不显示）
      const byEmoji = new Map<string, string[]>();
      if (!m.recalled) for (const r of reacts.items) if (r.k1 === m.message_id) byEmoji.set(r.k2, [...(byEmoji.get(r.k2) ?? []), r.k3]);
      out.reactions = [...byEmoji].map(([emoji, user_ids]) => ({ emoji, count: user_ids.length, user_ids, reacted_by_me: user_ids.includes(me) }));
      // 话题摘要：只在根消息上
      if (!m.thread_root_id) {
        const st = stats.get(m.message_id);
        if (st || followed.has(m.message_id)) {
          out.thread = {
            reply_count: st?.reply_count ?? 0,
            last_reply_at: st?.last_reply_at ?? null,
            participants: st?.participants ?? [],
            followed: followed.has(m.message_id),
          };
        }
      }
      // 已读回执 + 加急：只给发送人
      if (m.sender_id === me && !isThreadOnly(m) && m.msg_type !== 'system') {
        const c = chats.get(m.chat_id);
        if (c?.chat) {
          const others = realMembers(c.chat).filter((id) => id !== me);
          out.member_count = others.length;
          out.read_count = others.filter((id) => (c.reads.get(id) ?? 0) >= m.seq).length;
        }
        const u = urgents.filter((r) => r.k1 === m.message_id);
        if (u.length) out.urgent = { user_ids: u.map((r) => r.k2), ack_user_ids: u.filter((r) => r.data.acked_at).map((r) => r.k2) };
      }
      return out;
    });
  };
  ctx.decorateMessages = decorate;

  /** 会话对象补充：话题模式、话题未读数、Pin 的消息。 */
  const chatExtras = async (chats: ChatRecord[], me: string) => {
    const out = new Map<string, Record<string, unknown>>();
    if (!chats.length) return out;
    const ids = chats.map((c) => c.chat_id);
    const pins = await repo.relList('pin', { k1: ids }, { order: 'asc' });
    const follows = (await repo.relList('tfollow', { k2: me })).items.filter((r) => ids.includes(String(r.data.chat_id)));
    const stats = await repo.threadStats(follows.map((r) => r.k1));
    const reads = new Map((await repo.relList('tread', { k1: me })).items.map((r) => [r.k2, Number(r.data.seq ?? 0)]));
    for (const c of chats) {
      let unread = 0;
      for (const f of follows) {
        if (f.data.chat_id !== c.chat_id) continue;
        const st = stats.get(f.k1);
        if (st && st.last_seq > (reads.get(f.k1) ?? 0)) unread++;
      }
      out.set(c.chat_id, {
        thread_mode: !!c.thread_mode,
        thread_unread_count: unread,
        pinned_message_ids: pins.items.filter((p) => p.k1 === c.chat_id).map((p) => p.k2),
      });
    }
    return out;
  };

  const publishChatUpdated = async (chatId: string) => {
    const chat = await repo.getChat(chatId);
    if (!chat) return;
    const pins = await repo.relList('pin', { k1: chatId }, { order: 'asc' });
    ctx.publish('chat.updated', { chat: { ...ctx.chatBaseJson(chat), pinned_message_ids: pins.items.map((p) => p.k2) } }, chat.member_ids);
  };

  /** 消息存在且我是它所在会话的成员。 */
  const visibleMessage = async (reply: FastifyReply, messageId: string, me: AuthedUser) => {
    const msg = await repo.getMessage(messageId);
    if (!msg) {
      fail(reply, 404, '消息不存在');
      return undefined;
    }
    const chat = await ctx.memberChat(reply, msg.chat_id, me.sub);
    if (!chat) return undefined;
    return { msg, chat };
  };

  const one = async (msg: MessageRecord, me: string) => (await decorate([msg], me))[0];

  // ---------------- R-IM-01 已读名单 ----------------

  app.get('/api/v1/messages/:message_id/read-users', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const v = await visibleMessage(reply, (req.params as { message_id: string }).message_id, me);
    if (!v) return;
    if (v.msg.sender_id !== me.sub) return fail(reply, 403, '只有发送人可以查看已读名单');
    const reads = new Map((await repo.chatReadStates(v.chat.chat_id)).map((r) => [r.user_id, r.last_read_seq]));
    const others = realMembers(v.chat).filter((id) => id !== me.sub);
    return {
      read: others.filter((id) => (reads.get(id) ?? 0) >= v.msg.seq),
      unread: others.filter((id) => (reads.get(id) ?? 0) < v.msg.seq),
    };
  });

  // ---------------- R-IM-02 话题 ----------------

  app.get('/api/v1/messages/:message_id/thread', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const v = await visibleMessage(reply, (req.params as { message_id: string }).message_id, me);
    if (!v) return;
    if (v.msg.thread_root_id) return invalid(reply, [{ field: 'message_id', message: '这是一条话题回复，请打开它所在的话题' }]);
    const q = req.query as { page_size?: string; page_token?: string };
    const limit = pageSize(q.page_size, 50, 200);
    const afterSeq = q.page_token ? Number(q.page_token) : 0;
    if (!Number.isFinite(afterSeq) || afterSeq < 0) return invalid(reply, [{ field: 'page_token', message: '无效的分页游标' }]);
    const res = await repo.listThreadReplies(v.msg.message_id, { afterSeq, limit });
    const last = res.items[res.items.length - 1];
    // 看过的回复记为已读
    if (last) {
      const cur = await repo.relGet('tread', me.sub, v.msg.message_id);
      if (!cur || Number(cur.data.seq ?? 0) < last.seq) {
        await repo.relPut({ kind: 'tread', k1: me.sub, k2: v.msg.message_id, k3: '', data: { seq: last.seq, chat_id: v.chat.chat_id }, at: nowIso() }, { upsert: true });
      }
    }
    return {
      items: await decorate(res.items, me.sub),
      has_more: res.has_more,
      ...(res.has_more && last ? { page_token: String(last.seq) } : {}),
    };
  });

  const setFollow = async (req: { params: unknown; headers: Record<string, unknown> }, reply: FastifyReply, follow: boolean) => {
    const me = await ctx.requireUser(req as never, reply);
    if (!me) return;
    const v = await visibleMessage(reply, (req.params as { message_id: string }).message_id, me);
    if (!v) return;
    if (v.msg.thread_root_id) return invalid(reply, [{ field: 'message_id', message: '只能关注话题的第一条消息' }]);
    if (follow) await repo.relPut({ kind: 'tfollow', k1: v.msg.message_id, k2: me.sub, k3: '', data: { chat_id: v.chat.chat_id }, at: nowIso() });
    else await repo.relDelete('tfollow', v.msg.message_id, me.sub);
    return one(v.msg, me.sub);
  };
  app.post('/api/v1/messages/:message_id/thread/follow', (req, reply) => setFollow(req, reply, true));
  app.delete('/api/v1/messages/:message_id/thread/follow', (req, reply) => setFollow(req, reply, false));

  // ---------------- R-IM-03 表情回应 ----------------

  const react = async (req: { params: unknown; body: unknown; headers: Record<string, unknown> }, reply: FastifyReply, add: boolean) => {
    const me = await ctx.requireUser(req as never, reply);
    if (!me) return;
    const params = req.params as { message_id: string; emoji?: string };
    const emoji = add ? (req.body as { emoji?: unknown } | undefined)?.emoji : params.emoji;
    if (typeof emoji !== 'string' || !EMOJI_RE.test(emoji)) return invalid(reply, [{ field: 'emoji', message: '表情 key 只能是 1～32 位字母、数字或下划线' }]);
    const v = await visibleMessage(reply, params.message_id, me);
    if (!v) return;
    if (v.msg.recalled || v.msg.msg_type === 'system') return invalid(reply, [{ field: 'message_id', message: '这条消息不能回应' }]);
    if (!reactionLimiter.allow(me.sub)) return fail(reply, 429, '操作太频繁，请稍后再试', { code: 'RATE_LIMITED' });
    let changed: boolean;
    if (add) {
      const kinds = await repo.relList('react', { k1: v.msg.message_id });
      if (!kinds.items.some((r) => r.k2 === emoji) && new Set(kinds.items.map((r) => r.k2)).size >= 50) {
        return invalid(reply, [{ field: 'emoji', message: '这条消息的表情种类已达上限' }]);
      }
      changed = (await repo.relPut({ kind: 'react', k1: v.msg.message_id, k2: emoji, k3: me.sub, data: {}, at: nowIso() })) === 'inserted';
    } else {
      changed = (await repo.relDelete('react', v.msg.message_id, emoji, me.sub)) > 0;
    }
    if (changed) await ctx.publishMessage('message.updated', v.msg, v.chat.member_ids);
    return one(v.msg, me.sub);
  };
  app.post('/api/v1/messages/:message_id/reactions', (req, reply) => react(req, reply, true));
  app.delete('/api/v1/messages/:message_id/reactions/:emoji', (req, reply) => react(req, reply, false));

  // ---------------- R-IM-04 转发 ----------------

  const chatLabel = async (chat: ChatRecord, viewer: string) => {
    if (chat.name) return chat.name;
    const others = realMembers(chat).filter((id) => id !== viewer);
    const names = await Promise.all((others.length ? others : [viewer]).map((id) => ctx.userName(id)));
    return chat.chat_type === 'p2p' ? `与${names.join('、')}的单聊` : names.join('、');
  };

  app.post('/api/v1/messages/forward', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: Array<{ field: string; message: string }> = [];
    const { message_ids, chat_ids, mode, note, client_request_id } = body;
    if (!Array.isArray(message_ids) || !message_ids.length || message_ids.length > MAX_FORWARD_MESSAGES || message_ids.some((x) => typeof x !== 'string')) {
      errors.push({ field: 'message_ids', message: `必须是 1～${MAX_FORWARD_MESSAGES} 条消息 ID` });
    }
    if (!Array.isArray(chat_ids) || !chat_ids.length || chat_ids.some((x) => typeof x !== 'string')) errors.push({ field: 'chat_ids', message: '至少选择一个会话' });
    else if (new Set(chat_ids).size > MAX_FORWARD_CHATS) errors.push({ field: 'chat_ids', message: `一次最多转发到 ${MAX_FORWARD_CHATS} 个会话` });
    if (mode !== undefined && mode !== 'single' && mode !== 'merge') errors.push({ field: 'mode', message: '必须是 single 或 merge' });
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 5000)) errors.push({ field: 'note', message: '留言必须是不超过 5000 字的文本' });
    if (client_request_id !== undefined && (typeof client_request_id !== 'string' || !client_request_id || client_request_id.length > 128)) {
      errors.push({ field: 'client_request_id', message: '必须是不超过 128 位的文本' });
    }
    if (errors.length) return invalid(reply, errors);

    // 防重复提交：同一个 client_request_id 只执行一次
    const idemKey = typeof client_request_id === 'string' ? `forward:${client_request_id}` : null;
    if (idemKey) {
      const put = await repo.relPut({ kind: 'idem', k1: me.sub, k2: idemKey, k3: '', data: { status: 'pending' }, at: nowIso() });
      if (put === 'exists') {
        const prev = await repo.relGet('idem', me.sub, idemKey);
        if (prev?.data.status !== 'done') return fail(reply, 409, '这次转发正在处理，请稍候', { code: 'REQUEST_IN_PROGRESS' });
        const msgs = (await Promise.all((prev.data.message_ids as string[]).map((id) => repo.getMessage(id)))).filter((m): m is MessageRecord => !!m);
        return reply.code(200).send({ items: await decorate(msgs, me.sub) });
      }
    }
    const release = async () => { if (idemKey) await repo.relDelete('idem', me.sub, idemKey); };

    // 源消息：都要存在、我能看到、可以转发
    const sources: Array<{ msg: MessageRecord; chat: ChatRecord }> = [];
    for (const [i, id] of [...new Set(message_ids as string[])].entries()) {
      const msg = await repo.getMessage(id);
      const chat = msg ? await repo.getChat(msg.chat_id) : undefined;
      if (!msg || !chat || !chat.member_ids.includes(me.sub)) {
        await release();
        return invalid(reply, [{ field: `message_ids[${i}]`, message: '消息不存在' }]);
      }
      if (msg.recalled || !FORWARDABLE.has(msg.msg_type)) {
        await release();
        return invalid(reply, [{ field: `message_ids[${i}]`, message: '这条消息不能转发' }]);
      }
      sources.push({ msg, chat });
    }
    sources.sort((a, b) => a.msg.seq - b.msg.seq);
    const targets: ChatRecord[] = [];
    for (const [i, id] of [...new Set(chat_ids as string[])].entries()) {
      const chat = await repo.getChat(id);
      if (!chat || !chat.member_ids.includes(me.sub)) {
        await release();
        return invalid(reply, [{ field: `chat_ids[${i}]`, message: '会话不存在或你不在会话里' }]);
      }
      targets.push(chat);
    }

    const created: MessageRecord[] = [];
    try {
      /** 让接收方能下载转发出去的图片 / 文件。 */
      const linkFiles = async (m: MessageRecord) => {
        for (const key of new Set(fileKeysOf(m.msg_type, m.content))) {
          if (m.msg_type === 'image' || m.msg_type === 'file') continue; // postMessage 已登记
          if (!(await repo.getFile(key))) continue;
          await repo.addFileLink({ file_key: key, source_type: 'chat', chat_id: m.chat_id, message_id: m.message_id, table_key: null, record_id: null, created_at: m.created_at });
        }
      };
      for (const target of targets) {
        if (mode === 'merge') {
          const first = sources[0].chat;
          const sameChat = sources.every((s) => s.chat.chat_id === first.chat_id);
          const title = sameChat ? `${await chatLabel(first, me.sub)}的聊天记录` : '聊天记录';
          const snapshots = [];
          for (const s of sources) {
            const { answer: _a, ...content } = s.msg.content;
            snapshots.push({ message_id: s.msg.message_id, sender_id: s.msg.sender_id, sender_name: await ctx.userName(s.msg.sender_id), msg_type: s.msg.msg_type, content, created_at: s.msg.created_at });
          }
          const res = await ctx.postMessage(target, me.sub, 'merge_forward', { title, messages: snapshots });
          await linkFiles(res.message);
          created.push(res.message);
        } else {
          for (const s of sources) {
            const forwardedFrom = { chat_id: s.chat.chat_id, chat_name: await chatLabel(s.chat, me.sub), sender_id: s.msg.sender_id, message_id: s.msg.message_id };
            const res = await ctx.postMessage(target, me.sub, s.msg.msg_type, { ...s.msg.content }, { forwardedFrom });
            await linkFiles(res.message);
            created.push(res.message);
          }
        }
        if (typeof note === 'string' && note.trim()) created.push((await ctx.postMessage(target, me.sub, 'text', { text: note })).message);
      }
    } catch (e) {
      await release();
      throw e;
    }
    if (idemKey) await repo.relPut({ kind: 'idem', k1: me.sub, k2: idemKey, k3: '', data: { status: 'done', message_ids: created.map((m) => m.message_id) }, at: nowIso() }, { upsert: true });
    return reply.code(201).send({ items: await decorate(created, me.sub) });
  });

  // ---------------- R-IM-05 加急 ----------------

  app.get('/api/v1/messages/urgent/pending', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const rows = (await repo.relList('urgent', { k2: me.sub }, { order: 'desc', limit: 200 })).items.filter((r) => !r.data.acked_at);
    const items = [];
    for (const r of rows) {
      const msg = await repo.getMessage(r.k1);
      if (!msg || msg.recalled) continue;
      const chat = await repo.getChat(msg.chat_id);
      if (!chat?.member_ids.includes(me.sub)) continue;
      items.push({ message_id: msg.message_id, chat_id: msg.chat_id, from_user_id: String(r.data.from_user_id), preview: messagePreview(msg), urged_at: r.updated_at });
    }
    return { items };
  });

  app.post('/api/v1/messages/:message_id/urgent', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const v = await visibleMessage(reply, (req.params as { message_id: string }).message_id, me);
    if (!v) return;
    if (v.msg.sender_id !== me.sub) return fail(reply, 403, '只能加急自己发的消息');
    if (v.msg.recalled || v.msg.msg_type === 'system') return invalid(reply, [{ field: 'message_id', message: '这条消息不能加急' }]);
    const { user_ids, type } = (req.body ?? {}) as { user_ids?: unknown; type?: unknown };
    const errors: Array<{ field: string; message: string }> = [];
    if (!Array.isArray(user_ids) || !user_ids.length || user_ids.some((x) => typeof x !== 'string')) errors.push({ field: 'user_ids', message: '至少选择一位成员' });
    else {
      const bad = (user_ids as string[]).filter((id) => id === me.sub || !realMembers(v.chat).includes(id));
      if (bad.length) errors.push({ field: 'user_ids', message: `不在会话里或不能加急：${bad.join('、')}` });
    }
    if (type !== undefined && type !== 'app' && type !== 'push') errors.push({ field: 'type', message: '必须是 app 或 push' });
    if (errors.length) return invalid(reply, errors);
    if (!urgentLimiter.allow(me.sub)) return fail(reply, 429, '加急太频繁，请稍后再试', { code: 'URGENT_TOO_FREQUENT' });
    const at = nowIso();
    const fresh: string[] = [];
    for (const uid of new Set(user_ids as string[])) {
      const r = await repo.relPut({ kind: 'urgent', k1: v.msg.message_id, k2: uid, k3: '', data: { from_user_id: me.sub, chat_id: v.chat.chat_id, type: type ?? 'app', acked_at: null }, at });
      if (r === 'inserted') fresh.push(uid);
    }
    // 每人每条只能加急一次
    if (!fresh.length) return fail(reply, 429, '已经加急过这些成员了', { code: 'URGENT_TOO_FREQUENT' });
    const preview = messagePreview(v.msg);
    for (const uid of fresh) {
      ctx.publish('message.urgent', { message_id: v.msg.message_id, chat_id: v.chat.chat_id, from_user_id: me.sub, preview }, [uid], { user_only: true });
      if (type === 'push' && deps.notifications) {
        await deps.notifications.notify({
          user_id: uid, type: 'message.urgent', actor_id: me.sub,
          title: `${me.name} 给你发了一条加急消息`, summary: preview,
          target: { type: 'message', id: v.msg.message_id, chat_id: v.chat.chat_id },
        });
      }
    }
    return one(v.msg, me.sub);
  });

  app.post('/api/v1/messages/:message_id/urgent/ack', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const v = await visibleMessage(reply, (req.params as { message_id: string }).message_id, me);
    if (!v) return;
    const cur = await repo.relGet('urgent', v.msg.message_id, me.sub);
    if (!cur) return fail(reply, 404, '这条消息没有加急你');
    if (!cur.data.acked_at) {
      await repo.relPut({ kind: 'urgent', k1: v.msg.message_id, k2: me.sub, k3: '', data: { ...cur.data, acked_at: nowIso() }, at: cur.updated_at }, { upsert: true });
      ctx.publish('message.urgent_acked', { message_id: v.msg.message_id, user_id: me.sub }, [me.sub, v.msg.sender_id], { user_only: true });
    }
    return reply.code(204).send();
  });

  // ---------------- R-IM-06 收藏 ----------------

  app.post('/api/v1/messages/:message_id/favorite', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const v = await visibleMessage(reply, (req.params as { message_id: string }).message_id, me);
    if (!v) return;
    if (v.msg.recalled || v.msg.msg_type === 'system') return invalid(reply, [{ field: 'message_id', message: '这条消息不能收藏' }]);
    await repo.relPut({ kind: 'fav', k1: me.sub, k2: v.msg.message_id, k3: '', data: { favorite_id: newId('fav'), chat_id: v.chat.chat_id }, at: nowIso() });
    return reply.code(204).send();
  });

  app.delete('/api/v1/messages/:message_id/favorite', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    // 退群或消息已删除也允许取消收藏
    await repo.relDelete('fav', me.sub, (req.params as { message_id: string }).message_id);
    return reply.code(204).send();
  });

  app.get('/api/v1/favorites', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { page_size?: string; page_token?: string };
    const limit = pageSize(q.page_size, 30, 100);
    const offset = pageOffset(q.page_token);
    const page = await repo.relList('fav', { k1: me.sub }, { order: 'desc', limit, offset });
    const items = [];
    for (const r of page.items) {
      const msg = await repo.getMessage(r.k2);
      const chat = msg ? await repo.getChat(msg.chat_id) : undefined;
      // 消息被删 / 撤回、或我已不在会话里：不返回正文
      if (!msg || msg.recalled || !chat?.member_ids.includes(me.sub)) continue;
      items.push({ favorite_id: String(r.data.favorite_id ?? `fav_${r.k2}`), message: (await decorate([msg], me.sub))[0], chat_name: await chatLabel(chat, me.sub), created_at: r.created_at });
    }
    const hasMore = offset + limit < page.total;
    return { items, has_more: hasMore, ...(hasMore ? { page_token: String(offset + limit) } : {}) };
  });

  // ---------------- R-IM-06 Pin ----------------

  app.get('/api/v1/chats/:chat_id/pins', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const chat = await ctx.memberChat(reply, (req.params as { chat_id: string }).chat_id, me.sub);
    if (!chat) return;
    const rows = (await repo.relList('pin', { k1: chat.chat_id }, { order: 'asc' })).items;
    const items = [];
    for (const r of rows) {
      const msg = await repo.getMessage(r.k2);
      if (!msg || msg.recalled) continue;
      items.push({ message: (await decorate([msg], me.sub))[0], pinned_by: String(r.data.pinned_by), pinned_at: r.created_at });
    }
    return { items };
  });

  app.post('/api/v1/chats/:chat_id/pins/:message_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id, message_id } = req.params as { chat_id: string; message_id: string };
    const chat = await ctx.memberChat(reply, chat_id, me.sub);
    if (!chat) return;
    const msg = await repo.getMessage(message_id);
    if (!msg || msg.chat_id !== chat_id) return fail(reply, 404, '消息不存在');
    if (msg.recalled || msg.msg_type === 'system') return invalid(reply, [{ field: 'message_id', message: '这条消息不能固定' }]);
    const r = await repo.relPut({ kind: 'pin', k1: chat_id, k2: message_id, k3: '', data: { pinned_by: me.sub }, at: nowIso() }, { maxPerK1: MAX_PINS });
    if (r === 'limit') return fail(reply, 409, `每个会话最多固定 ${MAX_PINS} 条消息`, { code: 'PIN_LIMIT' });
    if (r === 'inserted') {
      await ctx.postSystemMessage(chat, `${me.name} 固定了一条消息`);
      await publishChatUpdated(chat_id);
    }
    return reply.code(204).send();
  });

  app.delete('/api/v1/chats/:chat_id/pins/:message_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id, message_id } = req.params as { chat_id: string; message_id: string };
    const chat = await ctx.memberChat(reply, chat_id, me.sub);
    if (!chat) return;
    if ((await repo.relDelete('pin', chat_id, message_id)) > 0) await publishChatUpdated(chat_id);
    return reply.code(204).send();
  });

  return { chatExtras };
}
