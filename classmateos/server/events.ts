/**
 * Bot 事件总线（PLAN §2.4）：平台事件 → 大脑 runtime。
 *
 * 服务端：内存事件总线 + WebSocket 推送（@fastify/websocket）。
 * 事件类型对齐 openapi.yaml components.schemas.BotEvent：
 *   message.receive / card.action / message.read / chat.member_added
 *
 * 大脑侧经 src/pal/bot-events.ts 的 WsBotEventSource 订阅。
 */

import { randomUUID } from 'node:crypto';

export interface BotEvent {
  event_id: string;
  event_type: 'message.receive' | 'card.action' | 'message.read' | 'chat.member_added';
  created_at: string;
  message?: Record<string, unknown>;
  card_action?: {
    card_id: string;
    user_id: string;
    action: string;
    form_values?: Record<string, unknown>;
  };
}

type Listener = (event: BotEvent) => void;

export class BotEventBus {
  private readonly listeners = new Set<Listener>();
  /** 近期事件缓冲：WS 重连后补发（P1 简单实现，最多保留 200 条）。 */
  private readonly recent: BotEvent[] = [];

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
    if (this.recent.length > 200) this.recent.shift();
    for (const fn of this.listeners) {
      try {
        fn(full);
      } catch {
        // 订阅者异常不影响总线
      }
    }
    return full;
  }

  replay(sinceEventId: string | undefined, fn: Listener): void {
    if (!sinceEventId) return;
    const idx = this.recent.findIndex((e) => e.event_id === sinceEventId);
    if (idx < 0) return;
    for (const e of this.recent.slice(idx + 1)) fn(e);
  }
}
