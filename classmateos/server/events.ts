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
  | 'calendar.invited';

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
}

type Listener = (event: BotEvent) => void;

export class BotEventBus {
  private readonly listeners = new Set<Listener>();
  private readonly recent: BotEvent[] = [];

  constructor(private readonly capacity = 2000) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(event: Omit<BotEvent, 'event_id' | 'created_at'>): BotEvent {
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
  const { audience: _a, ...rest } = e;
  return JSON.stringify(rest);
}
