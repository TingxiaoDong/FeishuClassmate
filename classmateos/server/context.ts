/**
 * 路由共享上下文：鉴权、统一错误、序列化、发消息（含事件推送 / 文件登记）、文件权限。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { TableDef } from '../../src/bitable/schema.js';
import { verifyToken, type TokenPayload } from './auth.js';
import type { BotEventBus, BotEventType } from './events.js';
import type { LocalFileStore } from './files.js';
import type { CollabHub } from './collab.js';
import { canAccessRecord } from './row-access.js';
import type { TableStore } from './store.js';
import {
  nowIso,
  publicMessage,
  type ChatRecord,
  type ChatView,
  type FileRecord,
  type MessageRecord,
  type Repo,
  type UserRecord,
} from './repo.js';

export const BOT_ID = 'bot';
export const SYSTEM_SENDER = 'system';

export interface AuthedUser extends TokenPayload {
  user: UserRecord;
}

export interface FieldError {
  field: string;
  message: string;
}

export interface Ctx {
  app: FastifyInstance;
  repo: Repo;
  store: TableStore;
  eventBus: BotEventBus;
  fileStore: LocalFileStore;
  collabHub: CollabHub;
  secret: string;
  botToken?: string;
  tableDefs: Map<string, TableDef>;
  maxFileSize: number;
  driveQuota: number;
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthedUser | undefined>;
  invalidateUser(userId: string): void;
  isBot(req: FastifyRequest): boolean;
  /** 返回不存在的 user_id（bot 视为存在）。 */
  missingUsers(ids: string[]): Promise<string[]>;
  userName(userId: string): Promise<string>;
  /** 会话成员校验：会话不存在 404，非成员 403；通过返回会话。 */
  memberChat(reply: FastifyReply, chatId: string, userId: string): Promise<ChatRecord | undefined>;
  chatJson(view: ChatView): Record<string, unknown>;
  chatBaseJson(chat: ChatRecord): Record<string, unknown>;
  publish(type: BotEventType, payload: Record<string, unknown>, audience?: string[]): void;
  postMessage(
    chat: ChatRecord,
    senderId: string,
    msgType: string,
    content: Record<string, unknown>,
    opts?: { replyTo?: string | null; clientMsgId?: string | null },
  ): Promise<{ message: MessageRecord; duplicate: boolean }>;
  postSystemMessage(chat: ChatRecord, text: string): Promise<MessageRecord>;
  canAccessFile(user: AuthedUser, file: FileRecord): Promise<boolean>;
}

// ---------------- 错误与参数 ----------------

export function fail(
  reply: FastifyReply,
  status: number,
  message: string,
  extra: { code?: string; errors?: FieldError[]; [k: string]: unknown } = {},
) {
  return reply.code(status).send({ message, ...extra });
}

export function invalid(reply: FastifyReply, errors: FieldError[], message = '参数校验失败') {
  return fail(reply, 422, message, { code: 'VALIDATION_FAILED', errors });
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export function pageSize(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

export function pageOffset(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function pageResult<T>(items: T[], total: number, offset: number) {
  const next = offset + items.length;
  const hasMore = next < total;
  return { items, has_more: hasMore, ...(hasMore ? { page_token: String(next) } : {}), total };
}

export const newId = (prefix: string) => `${prefix}_${randomUUID()}`;

export function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/** 可选文本字段：undefined 不改；null 清空；其余必须是字符串。 */
export function optText(
  body: Record<string, unknown>,
  key: string,
  errors: FieldError[],
  maxLen = 2000,
): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') {
    errors.push({ field: key, message: '必须是文本' });
    return undefined;
  }
  if (v.length > maxLen) {
    errors.push({ field: key, message: `不能超过 ${maxLen} 字` });
    return undefined;
  }
  return v;
}

// ---------------- 上下文构建 ----------------

export function createCtx(base: Omit<Ctx, keyof CtxHelpers>): Ctx {
  const { repo, eventBus } = base;
  const userCache = new Map<string, { user: UserRecord | undefined; at: number }>();
  const CACHE_MS = 5_000;

  const getUserCached = async (id: string) => {
    const hit = userCache.get(id);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
    const user = await repo.getUser(id);
    userCache.set(id, { user, at: Date.now() });
    return user;
  };

  const ctx: Ctx = {
    ...base,

    async requireUser(req, reply) {
      const token = bearer(req);
      const p = token ? verifyToken(token, base.secret, 'access') : undefined;
      if (!p) {
        fail(reply, 401, '未登录或登录已过期', { code: 'UNAUTHORIZED' });
        return undefined;
      }
      const user = await getUserCached(p.sub);
      if (!user) {
        fail(reply, 401, '未登录或登录已过期', { code: 'UNAUTHORIZED' });
        return undefined;
      }
      if (user.disabled) {
        fail(reply, 403, '账号已被禁用', { code: 'ACCOUNT_DISABLED' });
        return undefined;
      }
      return { ...p, name: user.name, role: user.role, user };
    },

    invalidateUser(userId) {
      userCache.delete(userId);
    },

    isBot(req) {
      return !!base.botToken && req.headers['x-bot-token'] === base.botToken;
    },

    async missingUsers(ids) {
      const missing: string[] = [];
      for (const id of new Set(ids)) {
        if (id === BOT_ID) continue;
        if (!(await getUserCached(id))) missing.push(id);
      }
      return missing;
    },

    async userName(userId) {
      if (userId === BOT_ID) return '飞书同学';
      return (await getUserCached(userId))?.name ?? userId;
    },

    async memberChat(reply, chatId, userId) {
      const chat = await repo.getChat(chatId);
      if (!chat) {
        fail(reply, 404, '会话不存在', { code: 'CHAT_NOT_FOUND' });
        return undefined;
      }
      if (!chat.member_ids.includes(userId)) {
        fail(reply, 403, '你不是这个会话的成员', { code: 'CHAT_NOT_MEMBER' });
        return undefined;
      }
      return chat;
    },

    chatBaseJson(chat) {
      return {
        chat_id: chat.chat_id,
        chat_type: chat.chat_type,
        name: chat.name,
        member_ids: chat.member_ids,
        owner_id: chat.owner_id,
        description: chat.description,
        kind: chat.kind,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
      };
    },

    chatJson(view) {
      return {
        ...ctx.chatBaseJson(view.chat),
        unread_count: view.unread_count,
        last_message: view.last_message ? publicMessage(view.last_message) : null,
        last_read_message_id: view.last_read_message_id,
        pinned: view.pinned,
        muted: view.muted,
      };
    },

    publish(type, payload, audience) {
      eventBus.publish({ event_type: type, ...payload, audience });
    },

    async postMessage(chat, senderId, msgType, content, opts = {}) {
      const body = { ...content };
      let cardId: string | null = null;
      if (msgType === 'interactive_card') {
        cardId = typeof body.card_id === 'string' ? body.card_id : null;
        if (body.answer === undefined) body.answer = null;
      }
      const res = await repo.insertMessage({
        message_id: newId('msg'),
        chat_id: chat.chat_id,
        sender_id: senderId,
        msg_type: msgType,
        content: body,
        created_at: nowIso(),
        reply_to_message_id: opts.replyTo ?? null,
        client_msg_id: opts.clientMsgId ?? null,
        card_id: cardId,
      });
      if (res.duplicate) return res;
      const msg = res.message;

      // 文件 / 图片：登记来源，供云盘列表和下载权限使用
      if ((msgType === 'image' || msgType === 'file') && typeof body.file_key === 'string') {
        const file = await repo.getFile(body.file_key);
        if (file) {
          await repo.addFileLink({
            file_key: file.file_key,
            source_type: 'chat',
            chat_id: chat.chat_id,
            message_id: msg.message_id,
            table_key: null,
            record_id: null,
            created_at: msg.created_at,
          });
          // 过渡期「我的云盘」会话：发进去的自己的文件即登记到云盘
          if (chat.kind === 'drive' && file.uploader_id === senderId) {
            await repo.setFileDrive(file.file_key, true, msg.created_at);
          }
        }
      }
      // 发送者自己读到这条
      if (chat.member_ids.includes(senderId)) await repo.markRead(chat.chat_id, senderId, msg.message_id);

      ctx.publish('message.receive', { message: publicMessage(msg) }, chat.member_ids);
      return res;
    },

    async postSystemMessage(chat, text) {
      return (await ctx.postMessage(chat, SYSTEM_SENDER, 'system', { text })).message;
    },

    async canAccessFile(user, file) {
      if (file.uploader_id === user.sub) return true;
      for (const link of await repo.listFileLinks(file.file_key)) {
        if (link.source_type === 'chat' && link.chat_id) {
          const chat = await repo.getChat(link.chat_id);
          if (chat?.member_ids.includes(user.sub)) return true;
        } else if (link.source_type === 'table' && link.table_key && link.record_id) {
          const def = base.tableDefs.get(link.table_key);
          if (!def) continue;
          const rec = await base.store.get(link.table_key, link.record_id).catch(() => undefined);
          if (rec && canAccessRecord(user, def, rec)) return true;
        }
      }
      return false;
    },
  };
  return ctx;
}

type CtxHelpers = Pick<
  Ctx,
  | 'requireUser'
  | 'invalidateUser'
  | 'isBot'
  | 'missingUsers'
  | 'userName'
  | 'memberChat'
  | 'chatJson'
  | 'chatBaseJson'
  | 'publish'
  | 'postMessage'
  | 'postSystemMessage'
  | 'canAccessFile'
>;
