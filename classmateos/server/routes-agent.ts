/**
 * 机器人大脑专用接口（AGENT_PLAN M2），只认纯 bot 令牌（不带 X-On-Behalf-Of）：
 *
 *   GET/PUT/DELETE /api/v1/bot/sessions/:session_id   会话记忆（历史 + 摘要 + 最近对象），存仓库（Memory / PG）
 *   PATCH /api/v1/bot/messages/:message_id            编辑机器人自己发的文本消息（进度消息）
 *   POST  /api/v1/bot/cards/:card_id/answer           同学用文字回复「确认 / 取消」时，凭这条消息替卡片记下答案
 *
 * 文字确认也要可核验：服务端检查那条消息确实是被询问的同学在卡片之后、在同一个会话里发的，
 * 内容是明确的同意 / 拒绝词。机器人不能凭空「确认」。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { CONFIRM_NO, CONFIRM_YES, confirmWordOf, headerStr } from './agent-principal.js';
import { BOT_ID, fail, invalid, type Ctx } from './context.js';
import { nowIso, publicMessage, type MessageRecord } from './repo.js';

const SESSION_KIND = 'agent_session';
const MAX_SESSION_BYTES = 512 * 1024;
const MAX_TEXT = 5000;

export function registerAgentRoutes(ctx: Ctx): void {
  const { app, repo } = ctx;

  const pureBot = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!ctx.isBot(req) || headerStr(req, 'x-on-behalf-of')) {
      fail(reply, 401, 'invalid bot token');
      return false;
    }
    return true;
  };

  const broadcastUpdated = async (msg: MessageRecord) => {
    const chat = await repo.getChat(msg.chat_id);
    await ctx.publishMessage('message.updated', msg, chat?.member_ids ?? []);
  };

  // ---------------- 会话记忆 ----------------

  app.get('/api/v1/bot/sessions/:session_id', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const { session_id } = req.params as { session_id: string };
    const rec = await repo.getEntity(SESSION_KIND, session_id);
    return rec ? { session_id, ...rec.data, updated_at: rec.updated_at } : { session_id, history: [], recent: [], summary: null };
  });

  app.put('/api/v1/bot/sessions/:session_id', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const { session_id } = req.params as { session_id: string };
    if (session_id.length > 300) return invalid(reply, [{ field: 'session_id', message: '太长' }]);
    const body = (req.body ?? {}) as { history?: unknown; recent?: unknown; summary?: unknown };
    if (!Array.isArray(body.history) || !Array.isArray(body.recent)) {
      return invalid(reply, [{ field: 'history', message: 'history 和 recent 必须是数组' }]);
    }
    if (body.summary != null && typeof body.summary !== 'string') return invalid(reply, [{ field: 'summary', message: '必须是字符串' }]);
    const data = { history: body.history, recent: body.recent, summary: (body.summary as string | null | undefined) ?? null };
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_SESSION_BYTES) return invalid(reply, [{ field: 'history', message: '会话太大，请先压缩' }]);
    const now = nowIso();
    // 同一会话由网关串行写；冲突时重读版本再写一次
    for (let i = 0; i < 3; i++) {
      const cur = await repo.getEntity(SESSION_KIND, session_id);
      const ok = await repo.saveEntity(
        { kind: SESSION_KIND, id: session_id, scope: '', data, version: cur?.version ?? 0, created_at: cur?.created_at ?? now, updated_at: now },
        cur?.version ?? 0,
      );
      if (ok) return { ok: true };
    }
    return fail(reply, 409, '会话正在被其他请求修改', { code: 'CONFLICT' });
  });

  app.delete('/api/v1/bot/sessions/:session_id', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const { session_id } = req.params as { session_id: string };
    await repo.deleteEntity(SESSION_KIND, session_id);
    return reply.code(204).send();
  });

  // ---------------- 进度消息 ----------------

  app.patch('/api/v1/bot/messages/:message_id', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const { message_id } = req.params as { message_id: string };
    const msg = await repo.getMessage(message_id);
    if (!msg || msg.sender_id !== BOT_ID) return fail(reply, 404, '消息不存在');
    if (msg.msg_type !== 'text' || msg.recalled) return invalid(reply, [{ field: 'msg_type', message: '只能编辑文本消息' }]);
    const text = ((req.body ?? {}) as { content?: { text?: unknown } }).content?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
      return invalid(reply, [{ field: 'content.text', message: `不能为空，且不超过 ${MAX_TEXT} 字` }]);
    }
    const updated = (await repo.updateMessage(message_id, { content: { ...msg.content, text }, updated_at: nowIso() }))!;
    await broadcastUpdated(updated);
    return publicMessage(updated);
  });

  // ---------------- 文字确认 ----------------

  app.post('/api/v1/bot/cards/:card_id/answer', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const { card_id } = req.params as { card_id: string };
    const { message_id } = (req.body ?? {}) as { message_id?: unknown };
    if (typeof message_id !== 'string' || !message_id) return invalid(reply, [{ field: 'message_id', message: '不能为空' }]);
    const card = await repo.findMessageByCardId(card_id);
    if (!card || card.sender_id !== BOT_ID) return fail(reply, 404, '卡片不存在');
    if (card.content.expired === true) return fail(reply, 409, '这张卡片已过期', { code: 'CARD_EXPIRED' });
    if (card.content.answer != null) return fail(reply, 409, '这张卡片已经回答过了', { code: 'CARD_ANSWERED', answer: card.content.answer });
    const m = await repo.getMessage(message_id);
    const allowed = Array.isArray(card.content.answerable_by) ? (card.content.answerable_by as string[]) : undefined;
    if (
      !m ||
      m.chat_id !== card.chat_id ||
      m.msg_type !== 'text' ||
      m.recalled ||
      m.sender_id === BOT_ID ||
      (allowed && !allowed.includes(m.sender_id)) ||
      m.created_at < card.created_at
    ) {
      return fail(reply, 422, '这条消息不能作为这张卡片的回答', { code: 'CARD_ANSWER_INVALID' });
    }
    const word = confirmWordOf(String(m.content.text ?? ''));
    if (!word) return fail(reply, 422, '回复不是明确的确认或取消', { code: 'CARD_ANSWER_UNCLEAR' });
    const options = Array.isArray(card.content.options) ? (card.content.options as string[]) : [CONFIRM_YES, CONFIRM_NO];
    if (!options.includes(word)) return fail(reply, 422, '这张卡片没有这个选项', { code: 'CARD_ANSWER_UNCLEAR' });
    const now = nowIso();
    const updated = await repo.answerCard(card.message_id, { user_id: m.sender_id, action: word, answered_at: now, via: 'text', message_id }, now);
    if (!updated) return fail(reply, 409, '这张卡片已经回答过了', { code: 'CARD_ANSWERED' });
    await broadcastUpdated(updated);
    return { action: word, user_id: m.sender_id };
  });
}
