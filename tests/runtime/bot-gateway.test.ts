/**
 * 新栈全链路验收（PLAN §2.4 接法完整跑通）：
 *
 *   用户 REST 发消息 → 平台 WS 推送 → Bot 网关 → 大脑 runSession
 *   → mock LLM → PAL /bot/messages → 聊天历史可见 bot 回复
 *
 * 全真实组件，仅 LLM 为 mock（MetaClaw proxy 不在测试环境内）。
 */

import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import { WsBotEventSource } from '../../src/pal/bot-events.js';
import { createClassmateOSAdapter } from '../../src/pal/classmateos-adapter.js';
import { createBrain } from '../../src/runtime/brain.js';
import { createBotGateway } from '../../src/runtime/bot-gateway.js';
import type { ChatCompletionRequest } from '../../src/runtime/llm-client.js';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Echo 大脑：原样引用用户最后一句话。 */
function echoLlm() {
  return {
    async chat(req: ChatCompletionRequest) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      return { content: `大脑回复：${lastUser?.content ?? ''}`, toolCalls: [] };
    },
  };
}

describe('Bot 网关全链路（事件 → 大脑 → 回复）', () => {
  it('用户消息触发大脑回复并出现在聊天历史中', async () => {
    // --- 平台 ---
    const app = await buildApp({
      users: [
        { user_id: 'ou_alice', name: 'alice', password: 'pw', role: 'admin' },
        { user_id: 'ou_admin', name: 'admin', password: 'pw', role: 'admin' },
      ],
      secret: 's',
      botToken: 'btok',
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}/api/v1`;
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'pw' },
    });
    const token = login.json().access_token as string;
    const auth = { authorization: `Bearer ${token}` };

    // --- 大脑 + 网关 ---
    const eventSource = new WsBotEventSource({ baseUrl, botToken: 'btok', reconnectMs: 0 });
    const pal = createClassmateOSAdapter({ baseUrl, accessToken: token, botToken: 'btok' });
    const { runtime } = createBrain({ llm: echoLlm(), logger: silent, telemetry: false });
    const gateway = createBotGateway({ runtime, eventSource, im: pal.im, onError: (e) => { throw e; } });
    await gateway.start();

    // --- 用户侧：建会话、发消息 ---
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v1/chats',
      headers: auth,
      payload: { member_ids: ['ou_admin'] },
    });
    const chatId = chat.json().chat_id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/messages`,
      headers: auth,
      payload: { msg_type: 'text', content: { text: '帮我看看甘特图' } },
    });

    // --- 等待大脑回复出现在历史里（WS 异步，最多等 3s） ---
    let items: Array<{ sender_id: string; content: { text?: string } }> = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const history = await app.inject({
        method: 'GET',
        url: `/api/v1/chats/${chatId}/messages`,
        headers: auth,
      });
      items = history.json().items;
      if (items.some((m) => m.sender_id === 'bot')) break;
    }

    gateway.stop();
    await app.close();

    const botMsg = items.find((m) => m.sender_id === 'bot');
    expect(botMsg?.content.text).toBe('大脑回复：帮我看看甘特图');
    // 用户消息 + bot 回复，共 2 条
    expect(items).toHaveLength(2);
  });
});
