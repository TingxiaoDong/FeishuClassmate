import type { RoleService } from './roles.js';
import type { OrganizationService } from './organization.js';
import type { AuditLogService } from './audit-log.js';
/**
 * 路由共享上下文：鉴权、统一错误、序列化、发消息（含事件推送 / 文件登记）、文件权限。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { TableDef } from '../../src/bitable/schema.js';
import { verifyToken, type TokenPayload } from './auth.js';
import type { AuthService } from './auth-service.js';
import { isChatEvent, type BotEventBus, type BotEventType, type EventScope } from './events.js';
import type { LocalFileStore } from './files.js';
import type { CollabHub } from './collab.js';
import { canAccessRecord } from './row-access.js';
import { agentMarkOf, confirmCardStatus, headerStr, markAgentRequest, requestActionOf, routeOf, type AgentAuditLog, type BotScopePolicy } from './agent-principal.js';
import { agentState } from './agent-context.js';
import type { TableStore } from './store.js';
import {
  nowIso,
  publicMessage,
  isThreadOnly,
  type ChatRecord,
  type ChatView,
  type CustomTableRecord,
  type FileRecord,
  type MessageRecord,
  type Repo,
  type UserRecord,
} from './repo.js';

export const BOT_ID = 'bot';
/** 确认卡片使用记录（一张卡只能放行一次，代码审查 B3）。 */
export const CONFIRM_USE_KIND = 'confirm_card_use';
export const SYSTEM_SENDER = 'system';

export interface AuthedUser extends TokenPayload {
  user: UserRecord;
  /** 机器人代该同学发起的请求（X-Bot-Token + X-On-Behalf-Of）。 */
  via_bot?: boolean;
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
  /** 机器人代办作用域（黑名单）。 */
  botPolicy: BotScopePolicy;
  /** 机器人代办审计。 */
  agentAudit: AgentAuditLog;
  /** 内置表 + 已注册的自定义表（运行时可增加）。 */
  tableDefs: Map<string, TableDef>;
  /** 自定义数据表定义（POST /tables 创建），key 同 tableDefs。 */
  customTables: Map<string, CustomTableRecord>;
  maxFileSize: number;
  driveQuota: number;
  /** 登录设备会话、安全设置、账号锁定状态（迭代 5 批次 1）。 */
  auth: AuthService;
  /** 角色与权限点（迭代 5 批次 2）。 */
  roles: RoleService;
  /** 部门树与成员归属（迭代 5 批次 2）。 */
  org: OrganizationService;
  /** 操作日志（迭代 5 批次 2）。 */
  auditLog: AuditLogService;
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthedUser | undefined>;
  /**
   * WS 用：校验 access 令牌 + 会话 + 账号。失败返回关闭码（4401 令牌无效 / 会话已失效，4403 账号停用）。
   */
  verifyWsToken(token: string | undefined): Promise<{ payload: TokenPayload; user: UserRecord } | { close: 4401 | 4403 }>;
  invalidateUser(userId: string): void;
  isBot(req: FastifyRequest): boolean;
  /** 返回不存在的 user_id（bot 视为存在）。 */
  missingUsers(ids: string[]): Promise<string[]>;
  userName(userId: string): Promise<string>;
  /** 会话成员校验：会话不存在 404，非成员 403；通过返回会话。 */
  memberChat(reply: FastifyReply, chatId: string, userId: string): Promise<ChatRecord | undefined>;
  chatJson(view: ChatView): Record<string, unknown>;
  chatBaseJson(chat: ChatRecord): Record<string, unknown>;
  publish(type: BotEventType, payload: Record<string, unknown>, audience?: string[], scope?: EventScope): void;
  /**
   * WS 订阅主题鉴权（如 table:<key>）：返回 null 表示允许，否则返回错误码（FORBIDDEN / NOT_FOUND）。
   * 各模块注册时设置；默认全部拒绝。
   */
  authorizeTopic(user: { sub: string; role: string }, topic: string): Promise<string | null>;
  /** 主题授权器：前缀（如 'table'）→ 鉴权函数。 */
  topicAuthorizers: Map<string, (user: { sub: string; role: string }, id: string) => Promise<string | null>>;
  postMessage(
    chat: ChatRecord,
    senderId: string,
    msgType: string,
    content: Record<string, unknown>,
    opts?: {
      replyTo?: string | null;
      clientMsgId?: string | null;
      threadRootId?: string | null;
      alsoSendToChat?: boolean;
      forwardedFrom?: Record<string, unknown> | null;
    },
  ): Promise<{ message: MessageRecord; duplicate: boolean }>;
  /**
   * 迭代 4：按用户视角补充消息字段（已读数、表情、话题摘要、加急）。由消息增强模块设置；
   * 没设置时原样返回 publicMessage。
   */
  decorateMessages?: (msgs: MessageRecord[], userId: string) => Promise<Record<string, unknown>[]>;
  /** 推送消息事件：大脑 WS 收原始消息，每个用户收按自己视角补充过的消息。 */
  publishMessage(type: 'message.receive' | 'message.updated', msg: MessageRecord, audience: string[]): Promise<void>;
  postSystemMessage(chat: ChatRecord, text: string): Promise<MessageRecord>;
  canAccessFile(user: AuthedUser, file: FileRecord): Promise<boolean>;
  /** 各模块追加的文件访问规则（如文档附件：能看文档就能看）。 */
  extraFileAccess: Array<(user: AuthedUser, file: FileRecord) => Promise<boolean>>;
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
      // 机器人代办：X-Bot-Token + X-On-Behalf-Of（AGENT_PLAN §2.2）
      const obo = headerStr(req, 'x-on-behalf-of');
      if (obo || req.headers['x-bot-token'] !== undefined) {
        if (token || !obo) {
          fail(reply, 401, '代办请求必须仅使用机器人令牌及代办身份', { code: 'UNAUTHORIZED' });
          return undefined;
        }
        if (!ctx.isBot(req)) {
          fail(reply, 401, '机器人令牌无效', { code: 'UNAUTHORIZED' });
          return undefined;
        }
        const denied = base.botPolicy.check(req.method, routeOf(req));
        // 删除类规则：同学在确认卡片上点过「确认」就放行（AGENT_PLAN M2）
        const confirmCard = headerStr(req, 'x-agent-confirm');
        let confirmedBy: string | null = null;
        // 同一个请求里鉴权可能走两次（权限钩子 + 处理函数）：这次请求已经占用过这张卡就直接放行
        const prevMark = agentMarkOf(req);
        if (denied && confirmCard && prevMark?.confirm_card === confirmCard && prevMark.on_behalf_of === obo) {
          confirmedBy = confirmCard;
        } else if (denied && confirmCard && base.botPolicy.isDestructiveRule(denied) && obo !== BOT_ID) {
          // 代码审查 B3：卡片必须绑定的就是这次请求（方法 + 路由 + 对象），且只能用一次
          const cardMsg = await repo.findMessageByCardId(confirmCard);
          const st = confirmCardStatus(cardMsg, obo, BOT_ID, requestActionOf(req));
          if (st === 'mismatch' || st === 'unbound') {
            fail(reply, 403, '确认卡片确认的不是这个操作，请重新确认', { code: 'BOT_CONFIRM_MISMATCH', rule: denied });
            return undefined;
          }
          if (st === 'ok') {
            const now = nowIso();
            const claimed = await repo.saveEntity(
              { kind: CONFIRM_USE_KIND, id: confirmCard, scope: obo, data: { card_id: confirmCard, user_id: obo, method: req.method, url: req.url.slice(0, 500), used_at: now }, version: 0, created_at: now, updated_at: now },
              0,
            );
            if (!claimed) {
              fail(reply, 409, '这张确认卡片已经用过了，请重新确认', { code: 'CARD_CONSUMED' });
              return undefined;
            }
            // 卡片上也标记一下（前端可显示「已执行」）；失败不影响放行
            if (cardMsg) await repo.updateMessage(cardMsg.message_id, { content: { ...cardMsg.content, consumed_at: now }, updated_at: now }).catch(() => undefined);
            confirmedBy = confirmCard;
          } else if (st === 'consumed') {
            fail(reply, 409, '这张确认卡片已经用过了，请重新确认', { code: 'CARD_CONSUMED' });
            return undefined;
          }
        }
        if (denied && !confirmedBy) {
          const destructive = base.botPolicy.isDestructiveRule(denied);
          fail(
            reply,
            403,
            destructive
              ? '删除类操作需要同学在确认卡片上点「确认」后才能代办'
              : '这个操作不允许由机器人代办，请本人在 App 里操作',
            { code: destructive ? 'BOT_CONFIRM_REQUIRED' : 'BOT_SCOPE_DENIED', rule: denied },
          );
          return undefined;
        }
        const user = obo === BOT_ID ? undefined : await getUserCached(obo);
        if (!user || user.role === 'bot') {
          fail(reply, 403, '代办对象不存在', { code: 'ON_BEHALF_OF_INVALID' });
          return undefined;
        }
        if (user.disabled) {
          fail(reply, 403, '账号已被禁用', { code: 'ACCOUNT_DISABLED' });
          return undefined;
        }
        markAgentRequest(req, {
          on_behalf_of: user.user_id,
          session_id: headerStr(req, 'x-agent-session'),
          tool_call_id: headerStr(req, 'x-agent-tool-call'),
          confirm_card: confirmedBy,
        });
        const st = agentState();
        if (st) {
          st.via_bot = true;
          st.on_behalf_of = user.user_id;
          st.confirm_card = confirmedBy;
        }
        return {
          sub: user.user_id,
          name: user.name,
          role: user.role,
          typ: 'access',
          exp: Date.now() + 60_000,
          user,
          via_bot: true,
        };
      }
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
      // 迭代 5：设备被踢 / 改密 / 空闲超时后令牌立即失效
      const check = await base.auth.checkAccess(p);
      if (check !== 'ok') {
        fail(reply, 401, check === 'idle' ? '长时间未操作，请重新登录' : '登录已失效，请重新登录', {
          code: check === 'idle' ? 'SESSION_IDLE_TIMEOUT' : 'SESSION_REVOKED',
        });
        return undefined;
      }
      const state = await base.auth.getState(p.sub);
      if (state.must_change_password && (await base.auth.getSecurity()).force_change_on_first_login) {
        const path = req.url.split('?')[0];
        if (!['/api/v1/users/me', '/api/v1/users/me/password', '/api/v1/users/me/sessions', '/api/v1/users/me/logout-all'].includes(path) && !path.startsWith('/api/v1/users/me/sessions/')) {
          fail(reply, 403, '请先修改初始密码', { code: 'PASSWORD_CHANGE_REQUIRED' });
          return undefined;
        }
      }
      return { ...p, name: user.name, role: user.role, user };
    },

    async verifyWsToken(token) {
      const p = token ? verifyToken(token, base.secret, 'access') : undefined;
      if (!p) return { close: 4401 };
      const user = await repo.getUser(p.sub);
      if (!user) return { close: 4401 };
      if (user.disabled) return { close: 4403 };
      if ((await base.auth.checkAccess(p)) !== 'ok') return { close: 4401 };
      if ((await base.auth.getState(p.sub)).must_change_password && (await base.auth.getSecurity()).force_change_on_first_login) return { close: 4401 };
      return { payload: p, user };
    },

    invalidateUser(userId) {
      userCache.delete(userId);
    },

    isBot(req) {
      // 代码审查 B2：定长比较，避免按耗时猜令牌
      const got = req.headers['x-bot-token'];
      if (!base.botToken || typeof got !== 'string') return false;
      const a = Buffer.from(got), b = Buffer.from(base.botToken);
      return a.length === b.length && timingSafeEqual(a, b);
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
        thread_mode: !!chat.thread_mode,
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

    publish(type, payload, audience, scope) {
      // 代码审查 B1：会话事件的接收人不含机器人 → 大脑 WS 不收（audience 为 [] 的大脑专用副本由 publishMessage 自己标）
      if (Array.isArray(audience) && audience.length && !audience.includes(BOT_ID) && !scope?.no_bot && isChatEvent(type, payload)) {
        scope = { ...scope, no_bot: true };
      }
      eventBus.publish({ event_type: type, ...payload, ...(agentState()?.via_bot ? { via_bot: true } : {}), audience, ...(scope ? { scope } : {}) });
    },

    topicAuthorizers: new Map(),
    extraFileAccess: [],

    async authorizeTopic(user, topic) {
      const i = topic.indexOf(':');
      if (i <= 0) return 'NOT_FOUND';
      const fn = ctx.topicAuthorizers.get(topic.slice(0, i));
      return fn ? fn(user, topic.slice(i + 1)) : 'NOT_FOUND';
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
        thread_root_id: opts.threadRootId ?? null,
        also_send_to_chat: !!opts.alsoSendToChat,
        forwarded_from: opts.forwardedFrom ?? null,
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
      // 发送者自己读到这条（只在话题里的回复不推进主会话的已读位置，否则会把之前的未读消息跳过）
      if (chat.member_ids.includes(senderId) && !isThreadOnly(msg)) await repo.markRead(chat.chat_id, senderId, msg.message_id);

      await ctx.publishMessage('message.receive', msg, chat.member_ids);
      return res;
    },

    async publishMessage(type, msg, audience) {
      if (!ctx.decorateMessages) {
        ctx.publish(type, { message: publicMessage(msg) }, audience);
        return;
      }
      // 大脑 WS：原始消息（audience 为空，用户端不会收到这一份）；机器人不在会话里就不发
      if (audience.includes(BOT_ID)) ctx.publish(type, { message: publicMessage(msg) }, []);
      for (const uid of new Set(audience)) {
        if (uid === BOT_ID || uid === SYSTEM_SENDER) continue;
        const [m] = await ctx.decorateMessages([msg], uid);
        ctx.publish(type, { message: m }, [uid], { user_only: true });
      }
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
      for (const check of ctx.extraFileAccess) if (await check(user, file).catch(() => false)) return true;
      return false;
    },
  };
  return ctx;
}

type CtxHelpers = Pick<
  Ctx,
  | 'requireUser'
  | 'verifyWsToken'
  | 'invalidateUser'
  | 'isBot'
  | 'missingUsers'
  | 'userName'
  | 'memberChat'
  | 'chatJson'
  | 'chatBaseJson'
  | 'publish'
  | 'postMessage'
  | 'publishMessage'
  | 'postSystemMessage'
  | 'canAccessFile'
  | 'authorizeTopic'
  | 'topicAuthorizers'
  | 'extraFileAccess'
>;
