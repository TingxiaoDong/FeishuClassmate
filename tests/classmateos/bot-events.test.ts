/**
 * 大脑↔平台通道闭环测试（PLAN §2.4）：
 * 真 Fastify server + 真 WsBotEventSource（ws 客户端）。
 *
 * 1. 用户发消息 → message.receive 事件到达订阅者；
 * 2. bot 令牌错误 → WS 被拒（4401）；
 * 3. askUser 完整回流：bot 发卡 → 用户点按钮（/cards/:id/actions）→
 *    askUser resolve 出答案；超时路径也验证。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import { WsBotEventSource, type BotEventPayload } from '../../src/pal/bot-events.js';
import { createClassmateOSAdapter } from '../../src/pal/classmateos-adapter.js';
import type { FastifyInstance } from 'fastify';

const USERS = [{ user_id: 'ou_alice', name: 'alice', password: 'pw1', role: 'admin' as const }];

async function setup(): Promise<{ app: FastifyInstance; baseUrl: string; token: string }> {
  const app = await buildApp({ users: USERS, secret: "s", botToken: "btok" });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'alice', password: 'pw1' },
  });
  return { app, baseUrl: `http://127.0.0.1:${port}/api/v1`, token: login.json().access_token };
}

const sources: WsBotEventSource[] = [];
function makeSource(baseUrl: string, botToken = 'btok'): WsBotEventSource {
  const s = new WsBotEventSource({ baseUrl, botToken, reconnectMs: 0 });
  sources.push(s);
  return s;
}

afterEach(() => {
  while (sources.length) sources.pop()!.close();
});

describe('Bot 事件 WS + askUser 回流', () => {
  it('用户消息经 WS 推送给订阅者', async () => {
    const { app, baseUrl, token } = await setup();
    const source = makeSource(baseUrl);
    await source.connect();

    const events: BotEventPayload[] = [];
    source.onEvent((e) => events.push(e));

    // 用户建会话并发消息
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v1/chats',
      headers: { authorization: `Bearer ${token}` },
      payload: { member_ids: ['ou_bob'] },
    });
    const chatId = chat.json().chat_id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { msg_type: 'text', content: { text: '今天进展如何' } },
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('message.receive');
    expect(events[0].message?.content).toMatchObject({ text: '今天进展如何' });
    expect(events[0].event_id).toMatch(/^evt_/);
    await app.close();
  });

  it('askUser：发卡 → 用户点击 → 答案回流；超时返回 timedOut', async () => {
    const { app, baseUrl, token } = await setup();
    const source = makeSource(baseUrl);
    await source.connect();

    const pal = createClassmateOSAdapter({
      baseUrl,
      accessToken: token,
      botToken: 'btok',
      eventSource: source,
    });

    // 完整回流：异步触发用户点击
    const askPromise = pal.im.askUser({
      userId: 'ou_alice',
      question: '甘特图 M2 确认完成？',
      options: ['完成', '未完成'],
      timeoutMs: 5000,
    });

    // 等卡片发出（轮询 chats/messages 太重，直接等事件循环一拍后发 action）
    await new Promise((r) => setTimeout(r, 300));
    // 从 bot 发出的 P2P 消息里拿 card_id
    const chatsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/chats',
      headers: { authorization: `Bearer ${token}` },
    });
    const chatId = chatsRes.json().items[0].chat_id;
    const msgs = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    const cardId = msgs.json().items[0].content.card_id;
    expect(cardId).toMatch(/^card_/);

    await app.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/actions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: '完成' },
    });

    const answer = await askPromise;
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.value).toEqual({ answer: '完成', timedOut: false });
    }

    // 超时路径
    const timeoutAnswer = await pal.im.askUser({
      userId: 'ou_alice',
      question: '没人会答的问题',
      timeoutMs: 300,
    });
    expect(timeoutAnswer.ok && timeoutAnswer.value.timedOut).toBe(true);
    await app.close();
  });

  it('bot 令牌错误时 WS 被拒绝', async () => {
    const { app, baseUrl } = await setup();
    const bad = makeSource(baseUrl, 'wrong-token');
    await expect(bad.connect()).rejects.toThrow();
    await app.close();
  });
});
