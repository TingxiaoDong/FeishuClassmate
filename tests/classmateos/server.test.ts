/**
 * ClassmateOS backend MVP tests (P1): Fastify inject 测 API 行为，
 * 并用真 PAL ClassmateOSAdapter 打真 server 做端到端闭环。
 */

import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../classmateos/server/app.js';
import { createClassmateOSAdapter } from '../../src/pal/classmateos-adapter.js';

const USERS = [
  { user_id: 'ou_alice', name: 'alice', password: 'pw1', role: 'admin' as const },
  { user_id: 'ou_bob', name: 'bob', password: 'pw2', role: 'member' as const },
];

async function makeApp(): Promise<FastifyInstance> {
  return buildApp({ users: USERS, secret: "test-secret", botToken: "btok" });
}

async function login(app: FastifyInstance, name = 'alice', password = 'pw1'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: name, password },
  });
  expect(res.statusCode).toBe(200);
  return res.json().access_token;
}

describe('ClassmateOS server (P1 MVP)', () => {
  it('bot 私聊：只复用含 bot 的 p2p，不会把消息塞进用户之间的单聊', async () => {
    const app = await makeApp();
    const token = await login(app);
    const human = await app.inject({
      method: 'POST',
      url: '/api/v1/chats',
      headers: { authorization: `Bearer ${token}` },
      payload: { member_ids: ['ou_bob'] },
    });
    const humanChatId = human.json().chat_id;
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/bot/messages',
        headers: { 'x-bot-token': 'btok' },
        payload: { receive_id: 'ou_alice', receive_id_type: 'user_id', msg_type: 'text', content: { text: 'hi' } },
      });
    const first = (await send()).json();
    const second = (await send()).json();
    expect(first.chat_id).not.toBe(humanChatId);
    expect(second.chat_id).toBe(first.chat_id); // 第二次复用同一个 bot 会话
    const msgs = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${humanChatId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(msgs.json().items).toHaveLength(0);
    await app.close();
  });

  it('auth: login → users/me → users list', async () => {
    const app = await makeApp();
    const token = await login(app);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json()).toMatchObject({ user_id: 'ou_alice', name: 'alice', role: 'admin' });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/users?keyword=bob',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].user_id).toBe('ou_bob');

    // 坏密码 / 无令牌
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'x' } })).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/users/me' })).statusCode).toBe(401);
    await app.close();
  });

  it('tables: meta exposes 23 张表；records CRUD + 单选校验 + 过滤', async () => {
    const app = await makeApp();
    const token = await login(app);
    const auth = { authorization: `Bearer ${token}` };

    const meta = await app.inject({ method: 'GET', url: '/api/v1/tables', headers: auth });
    expect(meta.json().items).toHaveLength(23);
    expect(meta.json().items.map((t: { key: string }) => t.key)).toContain('tool_trace');

    // 单选越界 → 422
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/tables/projects/records',
      headers: auth,
      payload: { fields: { title: 'X', status: '不存在的状态' } },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].field).toBe('status');

    // 未知字段 → 422
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/tables/projects/records',
      headers: auth,
      payload: { fields: { not_a_field: 1 } },
    });
    expect(unknown.statusCode).toBe(422);

    // 正常 CRUD
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tables/projects/records',
      headers: auth,
      payload: { fields: { title: 'Alpha', status: '进行中', project_id: 'p1' } },
    });
    expect(created.statusCode).toBe(201);
    const recId = created.json().record_id;

    const created2 = await app.inject({
      method: 'POST',
      url: '/api/v1/tables/projects/records',
      headers: auth,
      payload: { fields: { title: 'Beta', status: '完成', project_id: 'p2' } },
    });
    expect(created2.statusCode).toBe(201);

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v1/tables/projects/records?filter=${encodeURIComponent('status="进行中"')}`,
      headers: auth,
    });
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().items[0].fields.title).toBe('Alpha');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tables/projects/records/${recId}`,
      headers: auth,
      payload: { fields: { status: '完成' } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().fields.status).toBe('完成');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tables/projects/records/${recId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
    await app.close();
  });

  it('IM: 建群 → 发消息 → bot 代发 → 拉历史', async () => {
    const app = await makeApp();
    const token = await login(app);
    const auth = { authorization: `Bearer ${token}` };

    const chat = await app.inject({
      method: 'POST',
      url: '/api/v1/chats',
      headers: auth,
      payload: { name: '项目组', member_ids: ['ou_bob'] },
    });
    expect(chat.statusCode).toBe(201);
    const chatId = chat.json().chat_id;

    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/messages`,
      headers: auth,
      payload: { msg_type: 'text', content: { text: '开会了' } },
    });
    expect(sent.statusCode).toBe(201);

    // bot 无令牌 → 401；有令牌 → 201
    expect(
      (await app.inject({
        method: 'POST',
        url: '/api/v1/bot/messages',
        payload: { receive_id: chatId, msg_type: 'text', content: { text: 'hi' } },
      })).statusCode,
    ).toBe(401);

    const botMsg = await app.inject({
      method: 'POST',
      url: '/api/v1/bot/messages',
      headers: { 'x-bot-token': 'btok' },
      payload: { receive_id: chatId, msg_type: 'text', content: { text: '甘特图提醒' } },
    });
    expect(botMsg.statusCode).toBe(201);
    expect(botMsg.json().sender_id).toBe('bot');

    const history = await app.inject({ method: 'GET', url: `/api/v1/chats/${chatId}/messages`, headers: auth });
    expect(history.json().items).toHaveLength(2);
    await app.close();
  });

  it('端到端: PAL ClassmateOSAdapter ↔ 真 server', async () => {
    const app = await makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const token = await login(app);
    const pal = createClassmateOSAdapter({
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: token,
      botToken: 'btok',
    });

    const me = await pal.auth.getCurrentUser();
    expect(me.ok && me.value.userId).toBe('ou_alice');

    const created = await pal.table.createRecord('equipment', {
      equipment_id: 'eq1',
      name: '示波器',
      state: '在库',
    });
    expect(created.ok).toBe(true);

    const listed = await pal.table.listRecords({ tableKey: 'equipment' });
    expect(listed.ok && listed.value.records).toHaveLength(1);

    const msg = await pal.im.sendText('ou_bob', '器材该还了', 'user_id');
    expect(msg.ok).toBe(true);

    await app.close();
  });
});
