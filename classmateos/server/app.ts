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
import { randomUUID } from 'node:crypto';
import { ALL_TABLES, type TableDef } from '../../src/bitable/schema.js';
import { signToken, verifyToken } from './auth.js';
import { MemoryTableStore, type TableStore } from './store.js';
import { validateRecordFields } from './validation.js';

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

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = opts.store ?? new MemoryTableStore();
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
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const { table_key } = req.params as { table_key: string };
    if (!resolveTable(table_key, reply)) return;
    const q = req.query as { filter?: string; sort?: string; page_size?: string; page_token?: string };
    return store.list(table_key, {
      filter: q.filter,
      sort: q.sort,
      pageSize: Math.min(Number(q.page_size) || 100, 500),
      pageToken: q.page_token,
    });
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
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    if (!resolveTable(table_key, reply)) return;
    const rec = await store.get(table_key, record_id);
    if (!rec) return reply.code(404).send({ message: 'record not found' });
    return rec;
  });

  app.patch('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
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
    if (!authUser(req)) return reply.code(401).send({ message: 'unauthorized' });
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    if (!resolveTable(table_key, reply)) return;
    if (!(await store.delete(table_key, record_id))) {
      return reply.code(404).send({ message: 'record not found' });
    }
    return reply.code(204).send();
  });

  return app;
}
