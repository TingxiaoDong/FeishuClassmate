/**
 * 用户态 WS 测试（四端 IM 实时性）：
 * 成员收到所在会话的全部消息（含 bot 回复），非成员收不到；
 * 坏令牌被拒。用 ws 客户端直连真 server。
 */

import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../../classmateos/server/app.js';

const USERS = [
  { user_id: 'ou_alice', name: 'alice', password: 'pw1', role: 'admin' as const },
  { user_id: 'ou_bob', name: 'bob', password: 'pw2', role: 'member' as const },
  { user_id: 'ou_eve', name: 'eve', password: 'pw3', role: 'member' as const },
];

async function loginUser(app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never, name: string, pw: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: name, password: pw },
  });
  return res.json().access_token as string;
}

function connectUserWs(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events/ws?token=${token}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('用户态 WS（/api/v1/events/ws）', () => {
  it('成员实时收到本会话用户+bot消息，非成员收不到', async () => {
    const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const aliceToken = await loginUser(app, 'alice', 'pw1');
    const eveToken = await loginUser(app, 'eve', 'pw3');
    const auth = { authorization: `Bearer ${aliceToken}` };

    const aliceEvents: Array<Record<string, unknown>> = [];
    const eveEvents: Array<Record<string, unknown>> = [];
    const aliceWs = await connectUserWs(port, aliceToken);
    const eveWs = await connectUserWs(port, eveToken);
    aliceWs.on('message', (d) => aliceEvents.push(JSON.parse(String(d))));
    eveWs.on('message', (d) => eveEvents.push(JSON.parse(String(d))));

    // alice 与 bob 的会话（eve 不在其中）
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v1/chats',
      headers: auth,
      payload: { member_ids: ['ou_bob', 'bot'] }, // 机器人要在会话里（代码审查 B1）
    });
    const chatId = chat.json().chat_id as string;

    // alice 发消息
    await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/messages`,
      headers: auth,
      payload: { msg_type: 'text', content: { text: '在吗' } },
    });
    // bot 回复
    await app.inject({
      method: 'POST',
      url: '/api/v1/bot/messages',
      headers: { 'x-bot-token': 'btok' },
      payload: { receive_id: chatId, msg_type: 'text', content: { text: '我在' } },
    });

    await new Promise((r) => setTimeout(r, 300));
    aliceWs.close();
    eveWs.close();
    await app.close();

    // alice 收到 2 条消息（自己发的 + bot 的），另有新会话的 chat.created；eve 一条没有
    expect(aliceEvents.some((e) => e.event_type === 'chat.created')).toBe(true);
    // 不算「创建了群聊」系统消息
    const aliceMsgs = aliceEvents.filter((e) => e.event_type === 'message.receive' && (e.message as { sender_id: string }).sender_id !== 'system');
    expect(aliceMsgs).toHaveLength(2);
    expect(aliceMsgs.map((e) => (e.message as { sender_id: string }).sender_id)).toEqual([
      'ou_alice',
      'bot',
    ]);
    expect(eveEvents).toHaveLength(0);
  });

  it('坏令牌连接被关闭', async () => {
    const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events/ws?token=bad.token`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4401);
    await app.close();
  });
});
