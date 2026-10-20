/**
 * 平台事件总线：平台事件 → 大脑 runtime（bot WS）+ 四端用户（用户 WS）。
 *
 * 事件类型见《前端接口需求文档》第 6 节：
 *   message.receive / message.updated / message.read / card.action
 *   chat.created / chat.updated / chat.member_added / chat.member_removed
 *   task.assigned / calendar.invited
 *
 * `audience` 是服务端内部字段：有权收到该事件的 user_id 列表。用户 WS 按它过滤，
 * 发给客户端前会去掉。card.action 不设 audience（只给 bot WS）。
 *
 * 近期事件环形缓冲用于 `?since=<event_id>` 断点续传；找不到 since（太旧 / 服务重启）时
 * replay 返回 false，由调用方发 resync.required。
 */

import { randomUUID } from 'node:crypto';

export type BotEventType =
  | 'message.receive'
  | 'message.updated'
  | 'message.read'
  | 'card.action'
  | 'chat.created'
  | 'chat.updated'
  | 'chat.member_added'
  | 'chat.member_removed'
  | 'task.assigned'
  | 'calendar.invited'
  // 二期迭代 1（只推用户 WS，不推大脑 WS）
  | 'record.changed'
  | 'table.schema_changed'
  | 'table.view_changed'
  | 'table.created'
  | 'table.deleted'
  | 'wiki.node_changed'
  | 'wiki.space_changed'
  | 'notification.new'
  | 'notification.read'
  | 'capabilities.changed'
  | 'doc.permission_changed'
  | 'doc.comment_changed'
  // 二期迭代 3
  | 'task.created'
  | 'task.updated'
  | 'task.deleted'
  | 'task.comment_changed'
  | 'tasklist.updated'
  | 'tasklist.deleted'
  // 二期迭代 4
  | 'message.urgent'
  | 'message.urgent_acked'
  // AGENT_PLAN M3：后台任务进度（只推用户）、触发器变更（只推大脑）
  | 'job.updated'
  | 'trigger.changed'
  | 'department.changed'
  // 二期迭代 5：成员资料变更、本人权限变更（只推用户 WS）
  | 'user.updated'
  | 'permissions.changed'
  // AGENT_PLAN M4：App 一键急停（只推大脑）
  | 'robot.estop';

/**
 * 只推用户端的事件里，大脑也要收到的（AGENT_PLAN M3 触发器）。
 * 大脑是可信的服务端进程；触发器以建它的同学身份重新读取数据，不直接把事件内容给模型。
 */
export const AGENT_SUBSCRIBED_EVENTS: ReadonlySet<BotEventType> = new Set<BotEventType>([
  'record.changed',
  'task.updated',
  'doc.comment_changed',
]);

/**
 * 推送范围（服务端内部，不下发）：
 *   - topic：需要客户端订阅了这个主题（如 table:projects）才收；
 *   - all：所有已登录用户（仍受 topic 限制）；
 *   - audience：只给这些用户；admins：管理员也能收；
 *   - deny / deny_admins：排除这些用户 / 管理员（优先级最高）；
 *   - user_only：不发给大脑 WS。
 *   - no_bot：和会话有关、但机器人不在这个会话里（代码审查 B1），一律不发给大脑 WS（优先于 AGENT_SUBSCRIBED_EVENTS）。
 */
export interface EventScope {
  topic?: string;
  all?: boolean;
  admins?: boolean;
  deny?: string[];
  deny_admins?: boolean;
  user_only?: boolean;
  no_bot?: boolean;
}

export interface BotEvent {
  event_id: string;
  event_type: BotEventType;
  created_at: string;
  message?: Record<string, unknown>;
  chat?: Record<string, unknown>;
  read?: { chat_id: string; user_id: string; message_id: string | null };
  user_id?: string;
  task?: Record<string, unknown>;
  event?: Record<string, unknown>;
  card_action?: {
    card_id: string;
    user_id: string;
    action: string;
    form_values?: Record<string, unknown>;
  };
  /** 内部：可接收该事件的用户；不下发给客户端。 */
  audience?: string[];
  /** 内部：推送范围（见 EventScope）；不下发给客户端。 */
  scope?: EventScope;
  /** 其他事件字段（table_key、notification 等）。 */
  [extra: string]: unknown;
}

/** 用户 WS 是否该收到这条事件。 */
export function eventVisibleTo(
  e: BotEvent,
  user: { id: string; role: string },
  topics: ReadonlySet<string>,
): boolean {
  if (e.event_type === 'card.action' || e.event_type === 'robot.estop') return false;
  const s = e.scope;
  if (s?.topic && !topics.has(s.topic)) return false;
  if (s?.deny?.includes(user.id)) return false;
  if (s?.deny_admins && user.role === 'admin') return false;
  if (s?.all) return true;
  if (s?.admins && user.role === 'admin') return true;
  return Array.isArray(e.audience) && e.audience.includes(user.id);
}

type Listener = (event: BotEvent) => void;

export class BotEventBus {
  private readonly listeners = new Set<Listener>();
  private readonly recent: BotEvent[] = [];

  constructor(private readonly capacity = 5000) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(event: Omit<BotEvent, 'event_id' | 'created_at'> & { event_type: BotEventType }): BotEvent {
    const full: BotEvent = {
      ...event,
      event_id: `evt_${randomUUID()}`,
      created_at: new Date().toISOString(),
    };
    this.recent.push(full);
    if (this.recent.length > this.capacity) this.recent.shift();
    for (const fn of this.listeners) {
      try {
        fn(full);
      } catch {
        // 订阅者异常不影响总线
      }
    }
    return full;
  }

  /**
   * 补发 since 之后的事件。没有 since 返回 true（无需补发）；
   * since 不在缓冲里返回 false（调用方应要求客户端全量重拉）。
   */
  replay(sinceEventId: string | undefined, fn: Listener): boolean {
    if (!sinceEventId) return true;
    const idx = this.recent.findIndex((e) => e.event_id === sinceEventId);
    if (idx < 0) return false;
    for (const e of this.recent.slice(idx + 1)) fn(e);
    return true;
  }
}

/** 去掉内部字段后序列化，给客户端。 */
export function serializeEvent(e: BotEvent): string {
  const { audience: _a, scope: _s, ...rest } = e;
  return JSON.stringify(rest);
}

/**
 * 发给大脑 WS 的界面事件（AGENT_SUBSCRIBED_EVENTS）只留 id 和动作：
 * 内容由触发器以「建规则的同学」身份重新读取，避免保密记录经事件流到大脑。
 */
/**
 * 和会话有关的事件（消息、会话、已读、加急等）：给了会话成员当 audience、但机器人不在里面时，
 * 不能推给大脑 WS（同学之间的私聊、机器人不在的群）。
 */
export function isChatEvent(type: string, payload: Record<string, unknown>): boolean {
  return type.startsWith('message.') || type.startsWith('chat.') || type.startsWith('reaction.') || 'chat_id' in payload || 'chat' in payload || 'read' in payload;
}

/** 大脑 WS 是否该收到这条事件。 */
export function eventVisibleToBot(e: BotEvent): boolean {
  if (e.scope?.no_bot) return false;
  return !e.scope?.user_only || AGENT_SUBSCRIBED_EVENTS.has(e.event_type);
}

export function serializeEventForBot(e: BotEvent): string {
  if (!e.scope?.user_only) return serializeEvent(e);
  const { audience: _a, scope: _s, record: _r, ...rest } = e as BotEvent & { record?: unknown };
  return JSON.stringify(rest);
}
