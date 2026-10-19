/**
 * 实时事件（《前端接口需求文档》第 6 节）+ 设备注册与推送。
 *
 *   GET /api/v1/events/ws?token=&since=     用户 WS：按 audience 过滤，since 断点续传，30 秒心跳
 *   GET /api/v1/bot/events/ws               大脑 WS（X-Bot-Token），收全部事件
 *   POST/GET/DELETE /api/v1/devices         推送设备
 */

import type { WebSocket } from 'ws';
import { verifyToken } from './auth.js';
import { fail, newId, type Ctx } from './context.js';
import { serializeEvent, type BotEvent } from './events.js';
import { nowIso } from './repo.js';
import type { PushProvider } from './push.js';

const HEARTBEAT_MS = 30_000;

/** 用户 WS 能收到的事件：有 audience 且包含本人；card.action 永远不下发。 */
function visibleTo(e: BotEvent, userId: string): boolean {
  if (e.event_type === 'card.action') return false;
  return Array.isArray(e.audience) && e.audience.includes(userId);
}

function safeSend(socket: WebSocket, data: string): void {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(data);
    } catch {
      // 连接已断
    }
  }
}

export function registerRealtimeRoutes(ctx: Ctx, opts: { pushProvider: PushProvider; heartbeatMs?: number }): void {
  const { app, repo, eventBus } = ctx;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

  // ---------------- 用户 WS ----------------

  app.get('/api/v1/events/ws', { websocket: true }, (socket, req) => {
    const { token, since } = req.query as { token?: string; since?: string };
    const payload = token ? verifyToken(token, ctx.secret, 'access') : undefined;
    if (!payload) {
      socket.close(4401, 'invalid token');
      return;
    }
    // 订阅先同步注册（鉴权查库期间的事件先排队），避免握手与查库之间漏事件
    let ready = false;
    let closed = false;
    const queue: BotEvent[] = [];
    const deliver = (e: BotEvent) => {
      if (visibleTo(e, payload.sub)) safeSend(socket, serializeEvent(e));
    };
    const unsubscribe = eventBus.subscribe((e) => {
      if (!ready) queue.push(e);
      else deliver(e);
    });

    // 客户端文本帧：{"type":"ping"} 回 pong，其他忽略（不断开）
    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as { type?: string };
        if (msg?.type === 'ping') safeSend(socket, JSON.stringify({ event_type: 'pong' }));
      } catch {
        // 非 JSON 忽略
      }
    });

    const timer = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      // 令牌过期后按 4401 关闭，前端刷新令牌重连
      if (payload.exp < Date.now()) {
        socket.close(4401, 'token expired');
        return;
      }
      try {
        socket.ping();
      } catch {
        // ignore
      }
      safeSend(socket, JSON.stringify({ event_type: 'ping', created_at: nowIso() }));
    }, heartbeatMs);
    timer.unref?.();

    socket.on('close', () => {
      closed = true;
      clearInterval(timer);
      unsubscribe();
    });

    void repo
      .getUser(payload.sub)
      .then((user) => {
        if (closed) return;
        if (!user) {
          socket.close(4401, 'invalid token');
          return;
        }
        if (user.disabled) {
          socket.close(4403, 'account disabled');
          return;
        }
        // 断点续传：since 之后本人有权看到的事件；找不到 since → resync.required
        const replayed: string[] = [];
        const ok = eventBus.replay(since, (e) => {
          if (visibleTo(e, payload.sub)) {
            replayed.push(e.event_id);
            safeSend(socket, serializeEvent(e));
          }
        });
        if (!ok) safeSend(socket, JSON.stringify({ event_type: 'resync.required', created_at: nowIso() }));
        // 排队期间的事件：replay 已补发过的跳过
        const seen = new Set(replayed);
        for (const e of queue.splice(0)) if (!seen.has(e.event_id)) deliver(e);
        ready = true;
      })
      .catch(() => socket.close(1011, 'server error'));
  });

  // ---------------- 大脑 WS ----------------

  app.get(
    '/api/v1/bot/events/ws',
    {
      websocket: true,
      // 握手前校验 bot 令牌：错误令牌直接 401，而不是升级后再 close。
      preValidation: async (req, reply) => {
        if (!ctx.isBot(req)) await reply.code(401).send({ message: 'invalid bot token' });
      },
    },
    (socket, req) => {
      const { since } = req.query as { since?: string };
      const ok = eventBus.replay(since, (e) => safeSend(socket, serializeEvent(e)));
      if (!ok) safeSend(socket, JSON.stringify({ event_type: 'resync.required', created_at: nowIso() }));
      const unsubscribe = eventBus.subscribe((e) => safeSend(socket, serializeEvent(e)));
      const timer = setInterval(() => {
        try {
          if (socket.readyState === socket.OPEN) socket.ping();
        } catch {
          // ignore
        }
      }, heartbeatMs);
      timer.unref?.();
      socket.on('close', () => {
        clearInterval(timer);
        unsubscribe();
      });
    },
  );

  // ---------------- 设备注册 ----------------

  app.post('/api/v1/devices', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { platform, device_token } = (req.body ?? {}) as { platform?: unknown; device_token?: unknown };
    if ((platform !== 'ios' && platform !== 'android') || typeof device_token !== 'string' || !device_token) {
      return fail(reply, 400, '需要 platform（ios / android）和 device_token');
    }
    const deviceId = newId('dev');
    const device = await repo.upsertDevice({
      device_id: deviceId,
      user_id: me.sub,
      platform,
      device_token,
      created_at: nowIso(),
    });
    // 同一 token 重复注册 → 幂等更新归属（换绑账号场景），返回原设备
    return reply.code(device.device_id === deviceId ? 201 : 200).send(device);
  });

  app.get('/api/v1/devices', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    return { items: await repo.listDevices([me.sub]) };
  });

  app.delete('/api/v1/devices/:device_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { device_id } = req.params as { device_id: string };
    const device = await repo.getDevice(device_id);
    if (!device) return fail(reply, 404, '设备不存在');
    if (device.user_id !== me.sub && me.role !== 'admin') return fail(reply, 403, '只能注销自己的设备');
    await repo.deleteDevice(device_id);
    return reply.code(204).send();
  });

  // ---------------- 推送：message.receive → 会话其他成员（未免打扰）的设备 ----------------

  eventBus.subscribe((e) => {
    if (e.event_type !== 'message.receive' || !e.message) return;
    const m = e.message as { chat_id?: string; sender_id?: string; msg_type?: string; message_id?: string; content?: Record<string, unknown> };
    if (!m.chat_id || !m.sender_id || m.sender_id === 'system') return;
    const targets = (e.audience ?? []).filter((id) => id !== m.sender_id && id !== 'bot');
    if (targets.length === 0) return;
    void (async () => {
      const chat = await repo.getChat(m.chat_id!);
      if (!chat) return;
      const senderName = await ctx.userName(m.sender_id!);
      const text =
        m.msg_type === 'text' && typeof m.content?.text === 'string'
          ? m.content.text
          : m.msg_type === 'image'
            ? '[图片]'
            : m.msg_type === 'file'
              ? `[文件] ${String(m.content?.file_name ?? '')}`
              : m.msg_type === 'interactive_card'
                ? '[卡片]'
                : `[${m.msg_type}]`;
      const recipients: string[] = [];
      for (const uid of targets) {
        const view = await repo.getChatView(chat.chat_id, uid);
        if (view && !view.muted) recipients.push(uid);
      }
      if (recipients.length === 0) return;
      for (const d of await repo.listDevices(recipients)) {
        void opts.pushProvider
          .send(d.device_token, d.platform, {
            title: chat.name ?? senderName,
            body: `${senderName}: ${text}`.slice(0, 200),
            data: { chat_id: chat.chat_id, message_id: String(m.message_id ?? '') },
          })
          .catch(() => undefined);
      }
    })().catch(() => undefined);
  });
}
