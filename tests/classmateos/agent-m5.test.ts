import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../classmateos/server/app.js';
import { parseAgentContext, parseAgentResult } from '../../classmateos/server/agent-message.js';
import { bjDate } from '../../classmateos/server/routes-agent-metrics.js';

let app: FastifyInstance;
const tokens: Record<string, string> = {};
beforeAll(async () => {
  app = await buildApp({
    secret: 's',
    botToken: 'btok',
    notificationScanner: false,
    users: [
      { user_id: 'admin', name: '管', password: 'pw', role: 'admin' },
      { user_id: 'a', name: '甲', password: 'pw', role: 'member' },
      { user_id: 'b', name: '乙', password: 'pw', role: 'member' },
    ],
  });
  for (const id of ['admin', 'a', 'b']) {
    tokens[id] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: id, password: 'pw' } })).json().access_token;
  }
});
afterAll(async () => app.close());

const req = (who: string, method: 'GET' | 'POST', url: string, payload?: object, extra: Record<string, string> = {}) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    payload,
    headers: who === 'bot' ? { 'x-bot-token': 'btok', ...extra } : { authorization: `Bearer ${tokens[who]}` },
  });

describe('M5 消息里的 AI 助手字段', () => {
  it('校验侧栏上下文和结果卡片', () => {
    expect(parseAgentContext({ kind: 'doc', id: 'doc_1', title: '周报', selection: 'x'.repeat(3000) }).value?.selection).toHaveLength(2000);
    expect(parseAgentContext({ kind: 'secret', id: 'x' }).error).toBeTruthy();
    expect(parseAgentContext({ kind: 'doc', id: '../etc' }).error).toBeTruthy();
    expect(parseAgentResult({ links: [{ link: 'cos://doc/d1', summary: '新建' }], steps: [{ label: '建文档', ok: true }] }).value).toMatchObject({
      links: [{ link: 'cos://doc/d1', kind: 'doc', id: 'd1' }],
    });
    expect(parseAgentResult({ links: [{ link: 'https://evil.example/x' }] }).error).toBeTruthy();
  });

  it('同学能带侧栏上下文发消息，伪造的结果卡片会被丢掉；机器人能发结果卡片但不能带上下文', async () => {
    // 同学和机器人的单聊（机器人只能往自己在的会话发消息，后端 B1）
    const chat = (await req('a', 'POST', '/chats', { chat_type: 'p2p', member_ids: ['bot'] })).json();
    const sent = await req('a', 'POST', `/chats/${chat.chat_id}/messages`, {
      msg_type: 'text',
      content: { text: '总结一下这篇', agent_context: { kind: 'doc', id: 'doc_1', title: '周报' }, agent_result: { links: [{ link: 'cos://doc/x' }] } },
    });
    expect(sent.statusCode).toBeLessThan(300);
    const body = sent.json();
    const content = (body.content ?? body.message?.content) as Record<string, unknown>;
    expect(content.agent_context).toMatchObject({ kind: 'doc', id: 'doc_1' });
    expect(content.agent_result).toBeUndefined();

    const bad = await req('a', 'POST', `/chats/${chat.chat_id}/messages`, { msg_type: 'text', content: { text: 'x', agent_context: { kind: 'doc', id: 'a b' } } });
    expect(bad.statusCode).toBe(422);

    const bot = await req('bot', 'POST', '/bot/messages', {
      receive_id: chat.chat_id,
      receive_id_type: 'chat_id',
      msg_type: 'text',
      content: { text: '建好了', agent_result: { links: [{ link: 'cos://doc/d2', summary: '会议纪要' }] }, agent_context: { kind: 'doc', id: 'd' } },
    });
    expect(bot.statusCode).toBeLessThan(300);
    const list = (await req('a', 'GET', `/chats/${chat.chat_id}/messages`)).json().items as { content: Record<string, unknown> }[];
    const botMsg = list.find((m) => m.content.text === '建好了');
    expect(botMsg?.content.agent_result).toMatchObject({ links: [{ link: 'cos://doc/d2', kind: 'doc', id: 'd2' }] });
    expect(botMsg?.content.agent_context).toBeUndefined();
  });
});

describe('M5 Agent 调用指标', () => {
  it('只有纯机器人身份能上报；同学能看汇总，错误码只给管理员', async () => {
    const items = [
      { tool: 'cos_doc_create', ok: true, duration_ms: 120 },
      { tool: 'cos_doc_create', ok: true, duration_ms: 80 },
      { tool: 'cos_table_query', ok: false, duration_ms: 50, error_code: 'FORBIDDEN' },
    ];
    expect((await req('a', 'POST', '/bot/agent/metrics', { items })).statusCode).toBe(401);
    expect((await req('bot', 'POST', '/bot/agent/metrics', { items }, { 'x-on-behalf-of': 'a' })).statusCode).toBe(401);
    expect((await req('bot', 'POST', '/bot/agent/metrics', { items: [{ tool: 'x', ok: true, duration_ms: 1, args: {} }] })).statusCode).toBe(422);
    expect((await req('bot', 'POST', '/bot/agent/metrics', { items })).json()).toMatchObject({ ok: true, accepted: 3 });

    const mine = (await req('a', 'GET', '/agent/metrics?days=7')).json();
    expect(mine.today).toMatchObject({ calls: 3, ok: 2, failed: 1, avg_ms: 83 });
    expect(mine.daily).toHaveLength(7);
    expect(mine.tools[0]).toMatchObject({ tool: 'cos_doc_create', calls: 2, success_rate: 100 });
    expect(mine.top_failures[0]).toEqual({ tool: 'cos_table_query', failed: 1, calls: 1 });

    const adm = (await req('admin', 'GET', '/agent/metrics')).json();
    expect(adm.top_failures[0].errors).toEqual({ FORBIDDEN: 1 });
  });

  it('按北京时间分日', () => {
    expect(bjDate(Date.parse('2026-10-19T16:30:00Z'))).toBe('2026-10-20');
  });
});
