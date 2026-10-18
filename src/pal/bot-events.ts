/**
 * 大脑侧 Bot 事件订阅（PLAN §2.4）：平台 WS → runtime 会话。
 *
 * WsBotEventSource 连接 GET /bot/events/ws（X-Bot-Token），把
 * message.receive / card.action 事件回调给订阅者（Bot 网关 / askUser）。
 */

import WebSocket from 'ws';

export interface BotEventPayload {
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

export type BotEventHandler = (event: BotEventPayload) => void;

export interface BotEventSource {
  connect(): Promise<void>;
  close(): void;
  onEvent(fn: BotEventHandler): () => void;
}

export interface WsBotEventSourceOptions {
  /** http(s)://host/api/v1 — 自动转 ws(s) 并拼路径。 */
  baseUrl: string;
  botToken: string;
  /** 断线重连间隔 ms，默认 3000；0 = 不重连。 */
  reconnectMs?: number;
  /** 断点续传：自动带最后一次收到的 event_id。 */
  resume?: boolean;
}

export class WsBotEventSource implements BotEventSource {
  private ws?: WebSocket;
  private readonly handlers = new Set<BotEventHandler>();
  private lastEventId?: string;
  private closed = false;

  constructor(private readonly opts: WsBotEventSourceOptions) {}

  onEvent(fn: BotEventHandler): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  connect(): Promise<void> {
    this.closed = false;
    return new Promise((resolve, reject) => {
      const base = this.opts.baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
      const since = this.opts.resume !== false && this.lastEventId ? `?since=${this.lastEventId}` : '';
      const ws = new WebSocket(`${base}/bot/events/ws${since}`, {
        headers: { 'X-Bot-Token': this.opts.botToken },
      });
      this.ws = ws;

      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      ws.on('message', (data) => {
        try {
          const event = JSON.parse(String(data)) as BotEventPayload;
          this.lastEventId = event.event_id;
          for (const fn of this.handlers) fn(event);
        } catch {
          // 忽略坏帧
        }
      });
      ws.on('close', () => {
        if (!this.closed && (this.opts.reconnectMs ?? 3000) > 0) {
          setTimeout(() => {
            if (!this.closed) void this.connect().catch(() => {});
          }, this.opts.reconnectMs ?? 3000);
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
