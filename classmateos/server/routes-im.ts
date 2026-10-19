/**
 * 消息（IM）与机器人网关（《前端接口需求文档》第 5 节）。
 */

import type { FastifyReply } from 'fastify';
import {
  BOT_ID,
  fail,
  invalid,
  newId,
  pageOffset,
  pageResult,
  pageSize,
  type AuthedUser,
  type Ctx,
  type FieldError,
} from './context.js';
import { nowIso, p2pKeyOf, publicMessage, type ChatRecord, type MessageRecord } from './repo.js';

const USER_MSG_TYPES = new Set(['text', 'post', 'image', 'file']);
const BOT_MSG_TYPES = new Set(['text', 'post', 'image', 'file', 'interactive_card']);
const MAX_TEXT = 5000;
const RECALL_WINDOW_MS = 2 * 60_000;
export const DRIVE_CHAT_NAME = '我的云盘';

export function registerImRoutes(ctx: Ctx): void {
  const { app, repo } = ctx;

  /**
   * 校验并规范化消息内容。返回错误列表（空 = 通过）。
   * image / file：file_key 必须存在且已上传完成；用户发送时还必须有权访问该文件。
   */
  const checkContent = async (
    msgType: unknown,
    content: unknown,
    sender: AuthedUser | 'bot',
  ): Promise<{ errors: FieldError[]; content?: Record<string, unknown> }> => {
    const allowed = sender === 'bot' ? BOT_MSG_TYPES : USER_MSG_TYPES;
    if (typeof msgType !== 'string' || !allowed.has(msgType)) {
      return { errors: [{ field: 'msg_type', message: `必须是以下之一：${[...allowed].join('、')}` }] };
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return { errors: [{ field: 'content', message: '必须是对象' }] };
    }
    const c = { ...(content as Record<string, unknown>) };
    const errors: FieldError[] = [];
    switch (msgType) {
      case 'text': {
        if (typeof c.text !== 'string' || !c.text.trim()) errors.push({ field: 'content.text', message: '不能为空' });
        else if (c.text.length > MAX_TEXT) errors.push({ field: 'content.text', message: `不能超过 ${MAX_TEXT} 字` });
        if (c.mentions !== undefined) {
          if (!Array.isArray(c.mentions) || c.mentions.some((m) => !m || typeof (m as { user_id?: unknown }).user_id !== 'string')) {
            errors.push({ field: 'content.mentions', message: '必须是 [{ user_id, name }] 列表' });
          }
        }
        break;
      }
      case 'post': {
        const hasText = typeof c.text === 'string' && c.text.trim();
        const hasTitle = typeof c.title === 'string' && c.title.trim();
        if (!hasText && !hasTitle) errors.push({ field: 'content.text', message: '标题和正文不能都为空' });
        break;
      }
      case 'image':
      case 'file': {
        const key = c.file_key ?? c.file_token;
        if (typeof key !== 'string' || !key) {
          errors.push({ field: 'content.file_key', message: '不能为空' });
          break;
        }
        const file = await repo.getFile(key);
        if (!file || !file.uploaded_at) {
          errors.push({ field: 'content.file_key', message: '文件不存在或还没有上传完成' });
          break;
        }
        if (sender !== 'bot' && !(await ctx.canAccessFile(sender, file))) {
          errors.push({ field: 'content.file_key', message: '文件不存在或还没有上传完成' });
          break;
        }
        c.file_key = file.file_key;
        c.file_name = typeof c.file_name === 'string' && c.file_name ? c.file_name : (typeof c.name === 'string' && c.name) || file.file_name;
        c.size = file.size;
        c.content_type = file.content_type;
        break;
      }
      case 'interactive_card': {
        if (typeof c.card_id !== 'string' || !c.card_id) errors.push({ field: 'content.card_id', message: '不能为空' });
        if (typeof c.question !== 'string' && typeof c.title !== 'string') {
          errors.push({ field: 'content.question', message: '不能为空' });
        }
        if (c.options !== undefined && !Array.isArray(c.options)) {
          errors.push({ field: 'content.options', message: '必须是列表' });
        }
        break;
      }
    }
    return { errors, content: c };
  };

  const viewJson = async (chatId: string, userId: string) => {
    const v = await repo.getChatView(chatId, userId);
    return v ? ctx.chatJson(v) : undefined;
  };

  const names = async (ids: string[]) => (await Promise.all(ids.map((id) => ctx.userName(id)))).join('、');

  // ---------------- 会话 ----------------

  app.get('/api/v1/chats', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { page_size?: string; page_token?: string };
    const limit = pageSize(q.page_size, 100, 200);
    const offset = pageOffset(q.page_token);
    const page = await repo.listChatViews(me.sub, { limit, offset });
    return pageResult(page.items.map((v) => ctx.chatJson(v)), page.total, offset);
  });

  app.post('/api/v1/chats', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const memberIds = body.member_ids ?? [];
    if (!Array.isArray(memberIds) || memberIds.some((m) => typeof m !== 'string')) {
      errors.push({ field: 'member_ids', message: '必须是 user_id 列表' });
    }
    if (body.chat_type !== undefined && body.chat_type !== 'p2p' && body.chat_type !== 'group') {
      errors.push({ field: 'chat_type', message: '必须是 p2p 或 group' });
    }
    if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
      errors.push({ field: 'name', message: '必须是文本' });
    }
    if (body.kind !== undefined && body.kind !== 'normal' && body.kind !== 'drive') {
      errors.push({ field: 'kind', message: '必须是 normal 或 drive' });
    }
    if (errors.length) return invalid(reply, errors);
    const others = [...new Set(memberIds as string[])].filter((id) => id !== me.sub);
    const missing = await ctx.missingUsers(others);
    if (missing.length) return invalid(reply, [{ field: 'member_ids', message: `用户不存在：${missing.join('、')}` }]);

    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    const description = typeof body.description === 'string' ? body.description : null;
    const now = nowIso();
    const base = { chat_id: newId('chat'), name, description, created_at: now, updated_at: now };

    let chat: ChatRecord;
    const isDrive = body.kind === 'drive' || (body.chat_type === undefined && others.length === 0 && name === DRIVE_CHAT_NAME);
    if (isDrive) {
      chat = { ...base, chat_type: 'p2p', owner_id: me.sub, kind: 'drive', p2p_key: `drive:${me.sub}`, member_ids: [me.sub] };
    } else {
      const type = (body.chat_type as 'p2p' | 'group' | undefined) ?? (others.length + 1 > 2 ? 'group' : 'p2p');
      if (type === 'p2p') {
        if (body.chat_type === 'p2p' && others.length !== 1) {
          return invalid(reply, [{ field: 'member_ids', message: '单聊必须恰好有 1 位对方成员' }]);
        }
        // 两人单聊去重；兼容旧调用：不传 chat_type 且带名字的两人会话不去重
        const dedupe = others.length === 1 && (body.chat_type === 'p2p' || !name);
        chat = {
          ...base,
          name: body.chat_type === 'p2p' ? null : name,
          chat_type: 'p2p',
          owner_id: null,
          kind: 'normal',
          p2p_key: dedupe ? p2pKeyOf(me.sub, others[0]) : null,
          member_ids: [me.sub, ...others],
        };
      } else {
        chat = { ...base, chat_type: 'group', owner_id: me.sub, kind: 'normal', p2p_key: null, member_ids: [me.sub, ...others] };
      }
    }

    const res = await repo.createChat(chat);
    if (!res.created) {
      if (!res.chat.member_ids.includes(me.sub)) await repo.addMembers(res.chat.chat_id, [me.sub], now);
      return reply.code(200).send(await viewJson(res.chat.chat_id, me.sub));
    }
    if (res.chat.chat_type === 'group') await ctx.postSystemMessage(res.chat, `${me.name} 创建了群聊`);
    const fresh = (await repo.getChat(res.chat.chat_id))!;
    ctx.publish('chat.created', { chat: ctx.chatBaseJson(fresh) }, fresh.member_ids);
    return reply.code(201).send(await viewJson(fresh.chat_id, me.sub));
  });

  app.get('/api/v1/chats/:chat_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id } = req.params as { chat_id: string };
    if (!(await ctx.memberChat(reply, chat_id, me.sub))) return;
    return viewJson(chat_id, me.sub);
  });

  app.patch('/api/v1/chats/:chat_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id } = req.params as { chat_id: string };
    const chat = await ctx.memberChat(reply, chat_id, me.sub);
    if (!chat) return;
    if (chat.chat_type !== 'group') return invalid(reply, [{ field: 'chat_type', message: '单聊不能修改群信息' }]);
    if (chat.owner_id !== me.sub && me.role !== 'admin') return fail(reply, 403, '只有群主或管理员可以修改群信息');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 64)) {
      errors.push({ field: 'name', message: '群名不能为空，且不超过 64 字' });
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      errors.push({ field: 'description', message: '必须是文本' });
    }
    if (errors.length) return invalid(reply, errors);
    const newName = typeof body.name === 'string' ? body.name.trim() : undefined;
    const updated = await repo.updateChat(chat_id, {
      name: newName,
      description: body.description === undefined ? undefined : (body.description as string | null),
    });
    if (newName !== undefined && newName !== chat.name) {
      await ctx.postSystemMessage(updated!, `${me.name} 将群名修改为「${newName}」`);
    } else if (body.description !== undefined && body.description !== chat.description) {
      await ctx.postSystemMessage(updated!, `${me.name} 修改了群公告`);
    }
    const fresh = (await repo.getChat(chat_id))!;
    ctx.publish('chat.updated', { chat: ctx.chatBaseJson(fresh) }, fresh.member_ids);
    return viewJson(chat_id, me.sub);
  });

  app.post('/api/v1/chats/:chat_id/members', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id } = req.params as { chat_id: string };
    const chat = await ctx.memberChat(reply, chat_id, me.sub);
    if (!chat) return;
    if (chat.chat_type !== 'group') return invalid(reply, [{ field: 'chat_type', message: '单聊不能加人，请新建群聊' }]);
    const { member_ids } = (req.body ?? {}) as { member_ids?: unknown };
    if (!Array.isArray(member_ids) || member_ids.length === 0 || member_ids.some((m) => typeof m !== 'string')) {
      return invalid(reply, [{ field: 'member_ids', message: '必须是非空的 user_id 列表' }]);
    }
    const missing = await ctx.missingUsers(member_ids as string[]);
    if (missing.length) return invalid(reply, [{ field: 'member_ids', message: `用户不存在：${missing.join('、')}` }]);
    const added = await repo.addMembers(chat_id, member_ids as string[], nowIso());
    if (added.length > 0) {
      const after = (await repo.getChat(chat_id))!;
      await ctx.postSystemMessage(after, `${me.name} 邀请 ${await names(added)} 加入了群聊`);
      const fresh = (await repo.getChat(chat_id))!;
      ctx.publish('chat.member_added', { chat: ctx.chatBaseJson(fresh), user_ids: added }, fresh.member_ids);
    }
    return viewJson(chat_id, me.sub);
  });

  app.delete('/api/v1/chats/:chat_id/members/:user_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id, user_id } = req.params as { chat_id: string; user_id: string };
    const chat = await ctx.memberChat(reply, chat_id, me.sub);
    if (!chat) return;
    if (chat.chat_type !== 'group') return invalid(reply, [{ field: 'chat_type', message: '单聊不能退出或移除成员' }]);
    const self = user_id === me.sub;
    if (!self && chat.owner_id !== me.sub && me.role !== 'admin') {
      return fail(reply, 403, '只有群主或管理员可以移除成员');
    }
    if (!chat.member_ids.includes(user_id)) return fail(reply, 404, '该用户不在群里');
    await repo.removeMember(chat_id, user_id);
    let after = (await repo.getChat(chat_id))!;
    // 群主退群：自动转给最早加入的成员
    if (chat.owner_id === user_id && after.member_ids.length > 0) {
      const next = after.member_ids.find((id) => id !== BOT_ID) ?? after.member_ids[0];
      after = (await repo.updateChat(chat_id, { owner_id: next }))!;
    }
    const who = await ctx.userName(user_id);
    if (after.member_ids.length > 0) {
      await ctx.postSystemMessage(after, self ? `${who} 退出了群聊` : `${me.name} 将 ${who} 移出了群聊`);
    }
    const fresh = (await repo.getChat(chat_id))!;
    ctx.publish(
      'chat.member_removed',
      { chat: ctx.chatBaseJson(fresh), user_id },
      [...fresh.member_ids, user_id],
    );
    return reply.code(204).send();
  });

  app.patch('/api/v1/chats/:chat_id/settings', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id } = req.params as { chat_id: string };
    if (!(await ctx.memberChat(reply, chat_id, me.sub))) return;
    const { pinned, muted } = (req.body ?? {}) as { pinned?: unknown; muted?: unknown };
    const errors: FieldError[] = [];
    if (pinned !== undefined && typeof pinned !== 'boolean') errors.push({ field: 'pinned', message: '必须是 true / false' });
    if (muted !== undefined && typeof muted !== 'boolean') errors.push({ field: 'muted', message: '必须是 true / false' });
    if (errors.length) return invalid(reply, errors);
    await repo.updateMemberSettings(chat_id, me.sub, { pinned: pinned as boolean | undefined, muted: muted as boolean | undefined });
    return viewJson(chat_id, me.sub);
  });

  // ---------------- 消息 ----------------

  app.get('/api/v1/chats/:chat_id/messages', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id } = req.params as { chat_id: string };
    if (!(await ctx.memberChat(reply, chat_id, me.sub))) return;
    const q = req.query as { page_size?: string; before_message_id?: string; after_message_id?: string };
    if (q.before_message_id && q.after_message_id) {
      return invalid(reply, [{ field: 'after_message_id', message: '不能和 before_message_id 同时使用' }]);
    }
    // 过渡期云盘页需要一次取 500 条
    const limit = pageSize(q.page_size, 50, 500);
    const res = await repo.listMessages(chat_id, {
      limit,
      beforeId: q.before_message_id || undefined,
      afterId: q.after_message_id || undefined,
    });
    if (!res) return fail(reply, 404, '游标消息不存在', { code: 'CURSOR_NOT_FOUND' });
    return { items: res.items.map(publicMessage), has_more: res.has_more };
  });

  app.post('/api/v1/chats/:chat_id/messages', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id } = req.params as { chat_id: string };
    const chat = await ctx.memberChat(reply, chat_id, me.sub);
    if (!chat) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.msg_type === undefined || body.content === undefined) {
      return fail(reply, 400, '缺少 msg_type 或 content');
    }
    const checked = await checkContent(body.msg_type, body.content, me);
    const errors = checked.errors;
    const clientMsgId = body.client_msg_id;
    if (clientMsgId != null && (typeof clientMsgId !== 'string' || clientMsgId.length > 128)) {
      errors.push({ field: 'client_msg_id', message: '必须是不超过 128 位的文本' });
    }
    const replyTo = body.reply_to_message_id;
    if (replyTo != null) {
      const target = typeof replyTo === 'string' ? await repo.getMessage(replyTo) : undefined;
      if (!target || target.chat_id !== chat_id) errors.push({ field: 'reply_to_message_id', message: '引用的消息不存在' });
    }
    if (errors.length) return invalid(reply, errors, '消息内容不合法');
    const res = await ctx.postMessage(chat, me.sub, body.msg_type as string, checked.content!, {
      replyTo: (replyTo as string | null | undefined) ?? null,
      clientMsgId: (clientMsgId as string | null | undefined) ?? null,
    });
    return reply.code(res.duplicate ? 200 : 201).send(publicMessage(res.message));
  });

  app.post('/api/v1/chats/:chat_id/read', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { chat_id } = req.params as { chat_id: string };
    if (!(await ctx.memberChat(reply, chat_id, me.sub))) return;
    const { message_id } = (req.body ?? {}) as { message_id?: unknown };
    if (message_id != null && typeof message_id !== 'string') {
      return invalid(reply, [{ field: 'message_id', message: '必须是文本' }]);
    }
    const res = await repo.markRead(chat_id, me.sub, (message_id as string | null | undefined) ?? undefined);
    if (!res) return fail(reply, 404, '消息不存在');
    if (res.changed) {
      ctx.publish('message.read', { read: { chat_id, user_id: me.sub, message_id: res.message_id } }, [me.sub]);
    }
    return reply.code(204).send();
  });

  // ---------------- 撤回 / 编辑 / 搜索（P2） ----------------

  const ownMessage = async (reply: FastifyReply, messageId: string, me: AuthedUser) => {
    const msg = await repo.getMessage(messageId);
    if (!msg) {
      fail(reply, 404, '消息不存在');
      return undefined;
    }
    if (!(await ctx.memberChat(reply, msg.chat_id, me.sub))) return undefined;
    return msg;
  };

  const broadcastUpdated = async (msg: MessageRecord) => {
    const chat = await repo.getChat(msg.chat_id);
    ctx.publish('message.updated', { message: publicMessage(msg) }, chat?.member_ids ?? []);
  };

  app.post('/api/v1/messages/:message_id/recall', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { message_id } = req.params as { message_id: string };
    const msg = await ownMessage(reply, message_id, me);
    if (!msg) return;
    if (msg.sender_id !== me.sub && me.role !== 'admin') return fail(reply, 403, '只能撤回自己发的消息');
    if (me.role !== 'admin' && Date.now() - Date.parse(msg.created_at) > RECALL_WINDOW_MS) {
      return fail(reply, 409, '超过 2 分钟的消息不能撤回');
    }
    if (msg.recalled) return publicMessage(msg);
    const updated = (await repo.updateMessage(message_id, { content: {}, recalled: true, updated_at: nowIso() }))!;
    await broadcastUpdated(updated);
    return publicMessage(updated);
  });

  app.patch('/api/v1/messages/:message_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { message_id } = req.params as { message_id: string };
    const msg = await ownMessage(reply, message_id, me);
    if (!msg) return;
    if (msg.sender_id !== me.sub) return fail(reply, 403, '只能编辑自己发的消息');
    if (msg.msg_type !== 'text' || msg.recalled) return invalid(reply, [{ field: 'msg_type', message: '只能编辑文本消息' }]);
    const { content } = (req.body ?? {}) as { content?: { text?: unknown } };
    const text = content?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
      return invalid(reply, [{ field: 'content.text', message: `不能为空，且不超过 ${MAX_TEXT} 字` }]);
    }
    const updated = (await repo.updateMessage(message_id, { content: { ...msg.content, text }, updated_at: nowIso() }))!;
    await broadcastUpdated(updated);
    return publicMessage(updated);
  });

  app.get('/api/v1/messages/search', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { keyword?: string; chat_id?: string; page_size?: string; page_token?: string };
    const keyword = q.keyword?.trim();
    if (!keyword) return fail(reply, 400, '请输入搜索关键词');
    const limit = pageSize(q.page_size, 20, 100);
    const offset = pageOffset(q.page_token);
    const res = await repo.searchMessages(me.sub, { keyword, chatId: q.chat_id || undefined, limit, offset });
    const items = res.items.map((m) => {
      const text = [m.content.text, m.content.title, m.content.file_name].find(
        (v): v is string => typeof v === 'string' && v.toLowerCase().includes(keyword.toLowerCase()),
      );
      let highlight: string | undefined;
      if (text) {
        const i = text.toLowerCase().indexOf(keyword.toLowerCase());
        const start = Math.max(0, i - 20);
        highlight = (start > 0 ? '…' : '') + text.slice(start, i + keyword.length + 40);
      }
      return { ...publicMessage(m), highlight };
    });
    return { items, has_more: res.has_more, ...(res.has_more ? { page_token: String(offset + limit) } : {}) };
  });

  // ---------------- 机器人卡片 ----------------

  app.post('/api/v1/cards/:card_id/actions', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { card_id } = req.params as { card_id: string };
    const { action, form_values } = (req.body ?? {}) as { action?: unknown; form_values?: Record<string, unknown> };
    if (typeof action !== 'string' || !action) return fail(reply, 400, '缺少 action');
    const msg = await repo.findMessageByCardId(card_id);
    if (!msg) return fail(reply, 404, '卡片不存在');
    if (!(await ctx.memberChat(reply, msg.chat_id, me.sub))) return;
    if (msg.content.expired === true) return fail(reply, 409, '这张卡片已过期', { code: 'CARD_EXPIRED' });
    if (msg.content.answer != null) {
      return fail(reply, 409, '这张卡片已经回答过了', { code: 'CARD_ANSWERED', answer: msg.content.answer });
    }
    const now = nowIso();
    const answer = { user_id: me.sub, action, answered_at: now };
    const updated = await repo.answerCard(msg.message_id, answer, now);
    if (!updated) {
      const latest = await repo.getMessage(msg.message_id);
      return fail(reply, 409, '这张卡片已经回答过了', { code: 'CARD_ANSWERED', answer: latest?.content.answer ?? null });
    }
    // 机器人大脑（bot WS）收 card.action；会话成员收 message.updated
    ctx.publish('card.action', { card_action: { card_id, user_id: me.sub, action, form_values } });
    await broadcastUpdated(updated);
    return reply.code(202).send({ accepted: true });
  });

  // ---------------- bot 网关 ----------------

  app.post('/api/v1/bot/messages', async (req, reply) => {
    if (!ctx.isBot(req)) return fail(reply, 401, 'invalid bot token');
    const body = (req.body ?? {}) as {
      receive_id?: string;
      receive_id_type?: string;
      msg_type?: string;
      content?: Record<string, unknown>;
      reply_to?: string;
      reply_to_message_id?: string;
    };
    if (!body.receive_id || !body.msg_type || !body.content) {
      return fail(reply, 400, '缺少 receive_id、msg_type 或 content');
    }
    const checked = await checkContent(body.msg_type, body.content, 'bot');
    if (checked.errors.length) return invalid(reply, checked.errors, '消息内容不合法');

    let chat: ChatRecord | undefined;
    if (body.receive_id_type === 'user_id') {
      if ((await ctx.missingUsers([body.receive_id])).length) return fail(reply, 404, '用户不存在');
      // 机器人私聊：复用 bot 与该用户的单聊，没有就新建
      const now = nowIso();
      const res = await repo.createChat({
        chat_id: newId('chat'),
        chat_type: 'p2p',
        name: null,
        description: null,
        owner_id: null,
        kind: 'normal',
        p2p_key: p2pKeyOf(BOT_ID, body.receive_id),
        member_ids: [BOT_ID, body.receive_id],
        created_at: now,
        updated_at: now,
      });
      chat = res.chat;
      if (res.created) ctx.publish('chat.created', { chat: ctx.chatBaseJson(chat) }, chat.member_ids);
    } else {
      chat = await repo.getChat(body.receive_id);
    }
    if (!chat) return fail(reply, 404, '会话不存在');
    const replyTo = body.reply_to_message_id ?? body.reply_to ?? null;
    const res = await ctx.postMessage(chat, BOT_ID, body.msg_type, checked.content!, { replyTo });
    return reply.code(201).send(publicMessage(res.message));
  });

  /** 机器人不再等待某张卡片时标记过期（P2）。 */
  app.post('/api/v1/bot/cards/:card_id/expire', async (req, reply) => {
    if (!ctx.isBot(req)) return fail(reply, 401, 'invalid bot token');
    const { card_id } = req.params as { card_id: string };
    const msg = await repo.findMessageByCardId(card_id);
    if (!msg) return fail(reply, 404, '卡片不存在');
    if (msg.content.answer != null || msg.content.expired === true) return publicMessage(msg);
    const updated = (await repo.updateMessage(msg.message_id, {
      content: { ...msg.content, expired: true },
      updated_at: nowIso(),
    }))!;
    await broadcastUpdated(updated);
    return publicMessage(updated);
  });
}
