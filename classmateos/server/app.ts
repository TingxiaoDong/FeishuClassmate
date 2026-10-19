/**
 * ClassmateOS backend MVP (PLAN §3-P1): Fastify app implementing the P1
 * slice of classmateos/openapi.yaml —
 *   auth:  POST /auth/login, GET /users/me, GET /users
 *   im:    POST /chats, GET/POST /chats/:id/messages（内存存储）
 *   bot:   POST /bot/messages（X-Bot-Token）
 *   table: GET /tables, records CRUD（TableStore 可插拔：memory / pg）
 *
 * buildApp() 返回未 listen 的 Fastify 实例，测试用 app.inject。
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_TABLES, type TableDef } from '../../src/bitable/schema.js';
import { signToken, verifyToken } from './auth.js';
import { MemoryTableStore, type TableStore } from './store.js';
import { validateRecordFields } from './validation.js';
import { BotEventBus } from './events.js';
import { LocalFileStore } from './files.js';
import { buildDashboardSummary } from './dashboard.js';
import { canAccessRecord, filterAccessible } from './row-access.js';
import { CollabHub, collabTextFromUpdate } from './collab.js';
import { MemoryPushProvider, type Device, type PushProvider } from './push.js';
import { registerConsole } from './console.js';

export interface PlatformUser {
  user_id: string;
  name: string;
  password: string;
  email?: string;
  role: 'admin' | 'member' | 'bot';
}

export interface AppOptions {
  /** 初始用户（P1 从配置注入；P2 迁 PG）。 */
  users: PlatformUser[];
  /** HMAC secret。 */
  secret: string;
  /** Bot 网关令牌（X-Bot-Token）。 */
  botToken?: string;
  store?: TableStore;
  eventBus?: BotEventBus;
  /** 文件存储；缺省用内存临时目录的 LocalFileStore。 */
  fileStore?: LocalFileStore;
  /** 推送 provider；缺省 MemoryPushProvider（真实 APNs/FCM 属外部环境项）。 */
  pushProvider?: PushProvider;
}

interface StoredMessage {
  message_id: string;
  chat_id: string;
  sender_id: string;
  msg_type: string;
  content: Record<string, unknown>;
  created_at: string;
}

interface StoredChat {
  chat_id: string;
  chat_type: 'p2p' | 'group';
  name?: string;
  member_ids: string[];
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // CORS：Flutter Web / 浏览器跨源调试（P1 内网开发放开，生产收紧为白名单）。
  app.addHook('onSend', async (_req, reply) => {
    reply
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-headers', 'content-type, authorization, x-bot-token')
      .header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  });
  app.options('/*', async (_req, reply) => reply.code(204).send());
  // websocket 插件必须先就绪，{websocket:true} 路由才能正确注册 upgrade 处理。
  await app.register(fastifyWebsocket);
  const store = opts.store ?? new MemoryTableStore();
  const eventBus = opts.eventBus ?? new BotEventBus();
  const chats = new Map<string, StoredChat>();
  const messages = new Map<string, StoredMessage[]>(); // chat_id → messages
  const tableDefs = new Map<string, TableDef>(ALL_TABLES.map((t) => [t.key, t]));

  const authUser = (req: FastifyRequest) => {
    const token = bearer(req);
    return token ? verifyToken(token, opts.secret) : undefined;
  };

  // ---------------- auth ----------------

  app.post('/api/v1/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const user = opts.users.find((u) => u.user_id === username || u.name === username);
    if (!user || user.password !== password) {
      return reply.code(401).send({ message: 'invalid credentials' });
    }
    return {
      access_token: signToken({ sub: user.user_id, name: user.name, role: user.role }, opts.secret),
      refresh_token: signToken({ sub: user.user_id, name: user.name, role: user.role }, opts.secret, 30 * 24 * 3600_000),
      user: { user_id: user.user_id, name: user.name, email: user.email, role: user.role },
    };
  });

  app.get('/api/v1/users/me', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    return { user_id: p.sub, name: p.name, role: p.role };
  });

  app.get('/api/v1/users', async (req, reply) => {
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const { keyword } = req.query as { keyword?: string };
    const items = opts.users
      .filter((u) => !keyword || u.name.includes(keyword) || u.user_id.includes(keyword))
      .map((u) => ({ user_id: u.user_id, name: u.name, email: u.email, role: u.role }));
    return { items, has_more: false, total: items.length };
  });

  // ---------------- IM（内存） ----------------

  app.post('/api/v1/chats', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { name, member_ids = [] } = (req.body ?? {}) as { name?: string; member_ids?: string[] };
    const members = [...new Set([p.sub, ...member_ids])];
    const chat: StoredChat = {
      chat_id: `chat_${randomUUID()}`,
      chat_type: members.length > 2 ? 'group' : 'p2p',
      name,
      member_ids: members,
    };
    chats.set(chat.chat_id, chat);
    return reply.code(201).send({ ...chat, unread_count: 0 });
  });

  app.get('/api/v1/chats', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const items = [...chats.values()]
      .filter((c) => c.member_ids.includes(p.sub))
      .map((c) => ({ ...c, unread_count: 0 }));
    return { items, has_more: false };
  });

  const insertMessage = (
    chatId: string,
    senderId: string,
    msgType: string,
    content: Record<string, unknown>,
  ): StoredMessage | undefined => {
    if (!chats.has(chatId)) return undefined;
    const msg: StoredMessage = {
      message_id: `msg_${randomUUID()}`,
      chat_id: chatId,
      sender_id: senderId,
      msg_type: msgType,
      content,
      created_at: new Date().toISOString(),
    };
    const list = messages.get(chatId) ?? [];
    list.push(msg);
    messages.set(chatId, list);
    // 所有消息都进事件总线：bot 网关按 sender_id === 'bot' 自行过滤防回环，
    // 用户态 WS 按会话成员过滤推送给四端。
    eventBus.publish({ event_type: 'message.receive', message: msg as unknown as Record<string, unknown> });
    return msg;
  };

  app.post('/api/v1/chats/:chat_id/messages', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { chat_id } = req.params as { chat_id: string };
    const { msg_type, content } = (req.body ?? {}) as { msg_type?: string; content?: Record<string, unknown> };
    if (!msg_type || !content) return reply.code(400).send({ message: 'msg_type and content required' });
    const msg = insertMessage(chat_id, p.sub, msg_type, content);
    if (!msg) return reply.code(404).send({ message: 'chat not found' });
    return reply.code(201).send(msg);
  });

  app.get('/api/v1/chats/:chat_id/messages', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { chat_id } = req.params as { chat_id: string };
    if (!chats.has(chat_id)) return reply.code(404).send({ message: 'chat not found' });
    const items = [...(messages.get(chat_id) ?? [])].reverse();
    return { items, has_more: false };
  });

  // ---------------- 推送通知（设备注册 + 消息事件触发） ----------------

  const pushProvider = opts.pushProvider ?? new MemoryPushProvider();
  const devices = new Map<string, Device>();

  app.post('/api/v1/devices', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { platform, device_token } = (req.body ?? {}) as { platform?: string; device_token?: string };
    if ((platform !== 'ios' && platform !== 'android') || !device_token) {
      return reply.code(400).send({ message: 'platform(ios|android) and device_token required' });
    }
    // 同一 token 重复注册 → 幂等更新归属（换绑账号场景）
    const existing = [...devices.values()].find((d) => d.device_token === device_token);
    if (existing) {
      existing.user_id = p.sub;
      existing.platform = platform;
      return existing;
    }
    const device: Device = {
      device_id: `dev_${randomUUID()}`,
      user_id: p.sub,
      platform,
      device_token,
      created_at: new Date().toISOString(),
    };
    devices.set(device.device_id, device);
    return reply.code(201).send(device);
  });

  app.get('/api/v1/devices', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    return { items: [...devices.values()].filter((d) => d.user_id === p.sub) };
  });

  app.delete('/api/v1/devices/:device_id', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { device_id } = req.params as { device_id: string };
    const device = devices.get(device_id);
    if (!device) return reply.code(404).send({ message: 'device not found' });
    if (device.user_id !== p.sub && p.role !== 'admin') {
      return reply.code(403).send({ message: 'only owner can unregister' });
    }
    devices.delete(device_id);
    return reply.code(204).send();
  });

  // 消息事件 → 会话成员（除发送者）名下设备推送。推送失败不阻塞业务。
  eventBus.subscribe((e) => {
    if (e.event_type !== 'message.receive' || !e.message) return;
    const chat = chats.get(String(e.message.chat_id ?? ''));
    if (!chat) return;
    const senderId = String(e.message.sender_id ?? '');
    const senderName = opts.users.find((u) => u.user_id === senderId)?.name ?? senderId;
    const text = typeof e.message.content === 'object' && e.message.content
      ? String((e.message.content as Record<string, unknown>).text ?? `[${String(e.message.msg_type)}]`)
      : `[${String(e.message.msg_type)}]`;
    for (const memberId of chat.member_ids) {
      if (memberId === senderId) continue;
      for (const d of devices.values()) {
        if (d.user_id !== memberId) continue;
        void pushProvider
          .send(d.device_token, d.platform, {
            title: chat.name ?? senderName,
            body: `${senderName}: ${text}`,
            data: { chat_id: chat.chat_id, message_id: String(e.message.message_id ?? '') },
          })
          .catch(() => undefined);
      }
    }
  });

  // ---------------- bot 网关 ----------------

  app.post('/api/v1/bot/messages', async (req, reply) => {
    if (req.headers['x-bot-token'] !== opts.botToken) {
      return reply.code(401).send({ message: 'invalid bot token' });
    }
    const body = (req.body ?? {}) as {
      receive_id?: string;
      receive_id_type?: string;
      msg_type?: string;
      content?: Record<string, unknown>;
    };
    if (!body.receive_id || !body.msg_type || !body.content) {
      return reply.code(400).send({ message: 'receive_id, msg_type, content required' });
    }
    let chatId = body.receive_id;
    if (body.receive_id_type === 'user_id') {
      // P2P 会话复用：已有含该用户的 p2p 会话则复用，否则创建
      const existing = [...chats.values()].find(
        (c) => c.chat_type === 'p2p' && c.member_ids.includes(body.receive_id!),
      );
      if (existing) {
        chatId = existing.chat_id;
      } else {
        const chat: StoredChat = {
          chat_id: `chat_${randomUUID()}`,
          chat_type: 'p2p',
          member_ids: ['bot', body.receive_id],
        };
        chats.set(chat.chat_id, chat);
        chatId = chat.chat_id;
      }
    }
    const msg = insertMessage(chatId, 'bot', body.msg_type, body.content);
    if (!msg) return reply.code(404).send({ message: 'chat not found' });
    return reply.code(201).send(msg);
  });

  // ---------------- 表格引擎 ----------------

  app.get('/api/v1/tables', async (req, reply) => {
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    return {
      items: ALL_TABLES.map((t) => ({
        key: t.key,
        name: t.name,
        fields: t.fields.map((f) => ({
          field_name: f.field_name,
          type: f.type,
          options: Array.isArray(f.property?.options)
            ? (f.property.options as Array<{ name: string }>).map((o) => o.name)
            : undefined,
        })),
      })),
    };
  });

  const resolveTable = (key: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const def = tableDefs.get(key);
    if (!def) {
      reply.code(404).send({ message: `unknown table: ${key}` });
      return undefined;
    }
    return def;
  };

  app.get('/api/v1/tables/:table_key/records', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { table_key } = req.params as { table_key: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const q = req.query as { filter?: string; sort?: string; page_size?: string; page_token?: string };
    const page = await store.list(table_key, {
      filter: q.filter,
      sort: q.sort,
      pageSize: Math.min(Number(q.page_size) || 100, 500),
      pageToken: q.page_token,
    });
    return { ...page, items: filterAccessible(p, def, page.items) };
  });

  app.post('/api/v1/tables/:table_key/records', async (req, reply) => {
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const { table_key } = req.params as { table_key: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const { fields } = (req.body ?? {}) as { fields?: Record<string, unknown> };
    if (!fields || typeof fields !== 'object') {
      return reply.code(400).send({ message: 'fields object required' });
    }
    const errors = validateRecordFields(def, fields);
    if (errors.length > 0) return reply.code(422).send({ message: '字段校验失败', errors });
    return reply.code(201).send(await store.create(table_key, fields));
  });

  app.get('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const rec = await store.get(table_key, record_id);
    if (!rec || !canAccessRecord(p, def, rec)) {
      return reply.code(404).send({ message: 'record not found' });
    }
    return rec;
  });

  app.patch('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const existing = await store.get(table_key, record_id);
    if (!existing || !canAccessRecord(p, def, existing)) {
      return reply.code(404).send({ message: 'record not found' });
    }
    const { fields } = (req.body ?? {}) as { fields?: Record<string, unknown> };
    if (!fields || typeof fields !== 'object') {
      return reply.code(400).send({ message: 'fields object required' });
    }
    const errors = validateRecordFields(def, fields, { partial: true });
    if (errors.length > 0) return reply.code(422).send({ message: '字段校验失败', errors });
    const rec = await store.update(table_key, record_id, fields);
    if (!rec) return reply.code(404).send({ message: 'record not found' });
    return rec;
  });

  app.delete('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const existing = await store.get(table_key, record_id);
    if (!existing || !canAccessRecord(p, def, existing)) {
      return reply.code(404).send({ message: 'record not found' });
    }
    if (!(await store.delete(table_key, record_id))) {
      return reply.code(404).send({ message: 'record not found' });
    }
    return reply.code(204).send();
  });

  // ---------------- 卡片交互（ask_user_question 回流） ----------------

  app.post('/api/v1/cards/:card_id/actions', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { card_id } = req.params as { card_id: string };
    const { action, form_values } = (req.body ?? {}) as {
      action?: string;
      form_values?: Record<string, unknown>;
    };
    if (!action) return reply.code(400).send({ message: 'action required' });
    eventBus.publish({
      event_type: 'card.action',
      card_action: { card_id, user_id: p.sub, action, form_values },
    });
    return reply.code(202).send({ accepted: true });
  });

  // ---------------- bot 事件 WS（大脑订阅入口） ----------------

  app.get(
    '/api/v1/bot/events/ws',
    {
      websocket: true,
      // 握手前校验 bot 令牌：错误令牌直接 401，而不是升级后再 close。
      preValidation: async (req, reply) => {
        if ((req.headers as Record<string, unknown>)['x-bot-token'] !== opts.botToken) {
          await reply.code(401).send({ message: 'invalid bot token' });
        }
      },
    },
    (socket, req) => {
      // 可选断点续传：?since=<event_id>
      const { since } = req.query as { since?: string };
      eventBus.replay(since, (e) => socket.send(JSON.stringify(e)));
      const unsubscribe = eventBus.subscribe((e) => socket.send(JSON.stringify(e)));
      socket.on('close', unsubscribe);
    },
  );

  // ---------------- 用户态 WS（四端实时收消息） ----------------
  //
  // 浏览器/移动端不便设自定义头，令牌走 ?token=<jwt>。
  // 只推送本人所在会话的消息（按 chats 成员关系过滤）。

  app.get('/api/v1/events/ws', { websocket: true }, (socket, req) => {
    const { token } = req.query as { token?: string };
    const payload = token ? verifyToken(token, opts.secret) : undefined;
    if (!payload) {
      socket.close(4401, 'invalid token');
      return;
    }
    const unsubscribe = eventBus.subscribe((e) => {
      if (e.event_type !== 'message.receive' || !e.message) return;
      const chat = chats.get(String(e.message.chat_id ?? ''));
      if (!chat?.member_ids.includes(payload.sub)) return;
      socket.send(JSON.stringify(e));
    });
    socket.on('close', unsubscribe);
  });

  // ---------------- 文件（预签名语义，本地存储 P1） ----------------

  const fileStore =
    opts.fileStore ??
    new LocalFileStore({
      dir: join(tmpdir(), `classmateos-files-${process.pid}`),
      urlPrefix: '/api/v1/files',
      secret: opts.secret,
    });

  // 原始字节上传的 body parser
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/api/v1/files/upload-url', async (req, reply) => {
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const { file_name, size, content_type } = (req.body ?? {}) as {
      file_name?: string;
      size?: number;
      content_type?: string;
    };
    if (!file_name || typeof size !== 'number') {
      return reply.code(400).send({ message: 'file_name and size required' });
    }
    const g = fileStore.requestUpload({ fileName: file_name, size, contentType: content_type });
    return { file_key: g.fileKey, upload_url: g.uploadUrl, expires_in: g.expiresIn };
  });

  app.get('/api/v1/files/:file_key/download-url', async (req, reply) => {
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const { file_key } = req.params as { file_key: string };
    const grant = fileStore.getDownload(file_key);
    if (!grant) return reply.code(404).send({ message: 'file not found' });
    return { download_url: grant.downloadUrl, expires_in: grant.expiresIn };
  });

  // 签名直传/直取（无需登录态，凭 URL 签名）
  app.put('/api/v1/files/:file_key/content', async (req, reply) => {
    const { file_key } = req.params as { file_key: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!exp || !sig || !fileStore.verify(file_key, 'put', Number(exp), sig)) {
      return reply.code(403).send({ message: 'invalid or expired signature' });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ message: 'binary body required' });
    await fileStore.write(file_key, body);
    return reply.code(201).send({ file_key, size: body.length });
  });

  app.get('/api/v1/files/:file_key/content', async (req, reply) => {
    const { file_key } = req.params as { file_key: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!exp || !sig || !fileStore.verify(file_key, 'get', Number(exp), sig)) {
      return reply.code(403).send({ message: 'invalid or expired signature' });
    }
    const data = await fileStore.read(file_key);
    if (!data) return reply.code(404).send({ message: 'file not found' });
    return reply.type('application/octet-stream').send(data);
  });

  // ---------------- 日历 / 任务（P1：会议排期、帮扶提醒） ----------------

  interface StoredEvent {
    event_id: string;
    title: string;
    start_ms: number;
    end_ms: number;
    attendee_ids: string[];
    description?: string;
    created_by: string;
  }
  interface StoredTask {
    task_id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'done' | 'cancelled';
    assignee_id?: string;
    due_ms?: number;
    description?: string;
    created_by: string;
    created_at: string;
  }
  const events = new Map<string, StoredEvent>();
  const tasks = new Map<string, StoredTask>();
  const TASK_STATUSES = new Set(['pending', 'in_progress', 'done', 'cancelled']);

  app.post('/api/v1/calendar/events', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const body = (req.body ?? {}) as {
      title?: string;
      start_ms?: number;
      end_ms?: number;
      attendee_ids?: string[];
      description?: string;
    };
    if (!body.title || typeof body.start_ms !== 'number' || typeof body.end_ms !== 'number') {
      return reply.code(400).send({ message: 'title, start_ms, end_ms required' });
    }
    if (body.end_ms <= body.start_ms) {
      return reply.code(422).send({ message: 'end_ms must be after start_ms' });
    }
    const ev: StoredEvent = {
      event_id: `evt_cal_${randomUUID()}`,
      title: body.title,
      start_ms: body.start_ms,
      end_ms: body.end_ms,
      attendee_ids: [...new Set([p.sub, ...(body.attendee_ids ?? [])])],
      description: body.description,
      created_by: p.sub,
    };
    events.set(ev.event_id, ev);
    return reply.code(201).send(ev);
  });

  app.get('/api/v1/calendar/events', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { from, to } = req.query as { from?: string; to?: string };
    const fromMs = Number(from);
    const toMs = Number(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return reply.code(400).send({ message: 'from and to (ms) required' });
    }
    // 只返回本人参与或创建的、与时间窗相交的日程
    const items = [...events.values()]
      .filter(
        (e) =>
          (e.created_by === p.sub || e.attendee_ids.includes(p.sub)) &&
          e.end_ms > fromMs &&
          e.start_ms < toMs,
      )
      .sort((a, b) => a.start_ms - b.start_ms);
    return { items };
  });

  app.delete('/api/v1/calendar/events/:event_id', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { event_id } = req.params as { event_id: string };
    const ev = events.get(event_id);
    if (!ev) return reply.code(404).send({ message: 'event not found' });
    if (ev.created_by !== p.sub) return reply.code(403).send({ message: 'only creator can delete' });
    events.delete(event_id);
    return reply.code(204).send();
  });

  app.post('/api/v1/tasks', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const body = (req.body ?? {}) as {
      title?: string;
      assignee_id?: string;
      due_ms?: number;
      description?: string;
    };
    if (!body.title) return reply.code(400).send({ message: 'title required' });
    const task: StoredTask = {
      task_id: `task_${randomUUID()}`,
      title: body.title,
      status: 'pending',
      assignee_id: body.assignee_id,
      due_ms: body.due_ms,
      description: body.description,
      created_by: p.sub,
      created_at: new Date().toISOString(),
    };
    tasks.set(task.task_id, task);
    return reply.code(201).send(task);
  });

  app.get('/api/v1/tasks', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { assignee_id, status } = req.query as { assignee_id?: string; status?: string };
    let items = [...tasks.values()];
    // 可见性：本人创建的或指派给本人的
    items = items.filter((t) => t.created_by === p.sub || t.assignee_id === p.sub);
    if (assignee_id) items = items.filter((t) => t.assignee_id === assignee_id);
    if (status) items = items.filter((t) => t.status === status);
    return { items };
  });

  app.patch('/api/v1/tasks/:task_id', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { task_id } = req.params as { task_id: string };
    const task = tasks.get(task_id);
    if (!task) return reply.code(404).send({ message: 'task not found' });
    if (task.created_by !== p.sub && task.assignee_id !== p.sub) {
      return reply.code(403).send({ message: 'only creator or assignee can update' });
    }
    const body = (req.body ?? {}) as Partial<StoredTask>;
    if (body.status !== undefined) {
      if (!TASK_STATUSES.has(body.status)) {
        return reply.code(422).send({ message: `status must be one of: ${[...TASK_STATUSES].join(', ')}` });
      }
      task.status = body.status;
    }
    if (body.title !== undefined) task.title = body.title;
    if (body.due_ms !== undefined) task.due_ms = body.due_ms;
    if (body.description !== undefined) task.description = body.description;
    return task;
  });

  // ---------------- 文档（P1：markdown 正文；协同编辑为 P3 深化项） ----------------

  interface StoredDoc {
    doc_id: string;
    title: string;
    markdown: string;
    created_by: string;
    updated_at: string;
    /** 协同编辑持久化态（Yjs encodeStateAsUpdate 的 base64）；存在时优先于 markdown。 */
    yjs_update?: string;
  }
  const docs = new Map<string, StoredDoc>();

  // 协同编辑枢纽：房间首建播种 / 末连接断开持久化
  const collabHub = new CollabHub({
    loadSeed: (docId) => {
      const d = docs.get(docId);
      return d ? { markdown: d.markdown, yjs_update: d.yjs_update } : undefined;
    },
    onPersist: (docId, yjsUpdate) => {
      const d = docs.get(docId);
      if (!d) return;
      d.yjs_update = yjsUpdate;
      d.markdown = collabTextFromUpdate(yjsUpdate);
      d.updated_at = new Date().toISOString();
    },
  });

  // 协同编辑 WS：/api/v1/docs/:doc_id/collab?token=<jwt>
  app.get('/api/v1/docs/:doc_id/collab', { websocket: true }, (socket, req) => {
    const { doc_id } = req.params as { doc_id: string };
    const { token } = req.query as { token?: string };
    if (!token || !verifyToken(token, opts.secret)) {
      socket.close(4401, 'invalid token');
      return;
    }
    if (!docs.has(doc_id)) {
      socket.close(4404, 'doc not found');
      return;
    }
    collabHub.handleConnection(doc_id, socket);
  });

  app.post('/api/v1/docs', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { title, markdown } = (req.body ?? {}) as { title?: string; markdown?: string };
    if (!title || typeof markdown !== 'string') {
      return reply.code(400).send({ message: 'title and markdown required' });
    }
    const doc: StoredDoc = {
      doc_id: `doc_${randomUUID()}`,
      title,
      markdown,
      created_by: p.sub,
      updated_at: new Date().toISOString(),
    };
    docs.set(doc.doc_id, doc);
    return reply.code(201).send({ doc_id: doc.doc_id, url: `/api/v1/docs/${doc.doc_id}` });
  });

  app.get('/api/v1/docs', async (req, reply) => {
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const items = [...docs.values()].map(({ markdown: _m, ...meta }) => meta);
    return { items };
  });

  app.get('/api/v1/docs/:doc_id', async (req, reply) => {
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const { doc_id } = req.params as { doc_id: string };
    const doc = docs.get(doc_id);
    if (!doc) return reply.code(404).send({ message: 'doc not found' });
    return doc;
  });

  app.patch('/api/v1/docs/:doc_id', async (req, reply) => {
    const p = authUser(req);
    if (!p) return reply.code(401).send({ message: 'unauthorized' });
    const { doc_id } = req.params as { doc_id: string };
    const doc = docs.get(doc_id);
    if (!doc) return reply.code(404).send({ message: 'doc not found' });
    if (doc.created_by !== p.sub) return reply.code(403).send({ message: 'only creator can update' });
    const { title, markdown } = (req.body ?? {}) as { title?: string; markdown?: string };
    if (title !== undefined) doc.title = title;
    if (markdown !== undefined) {
      doc.markdown = markdown;
      // REST 直改 markdown 后，旧的协同态作废（下次协同会话从新 markdown 播种）
      delete doc.yjs_update;
    }
    doc.updated_at = new Date().toISOString();
    return doc;
  });

  // ---------------- 报表视图（吸收 dashboard/ 六卡） ----------------

  app.get('/api/v1/dashboard/summary', async (req, reply) => {
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    return buildDashboardSummary(store);
  });

  registerConsole(app);

  return app;
}
