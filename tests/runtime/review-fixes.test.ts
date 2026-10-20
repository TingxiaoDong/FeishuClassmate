/**
 * 代码审查（2026-10-20 · Agent）A1–A3 的验收测试。
 *   A1 网关只回复单聊和群里 @ 机器人的消息；
 *   A2 确认卡片写明要放行的操作（bound_action），每次高风险调用单独发卡；
 *   A3 没配策略按 write、策略出错按 destructive、物理工具必须带策略。
 */

import { describe, expect, it, vi } from 'vitest';
import { ClassmateRuntime } from '../../src/runtime/agent-runtime.js';
import { createBotGateway, stripBotMention } from '../../src/runtime/bot-gateway.js';
import { createBrain } from '../../src/runtime/brain.js';
import { boundActionOf, inferActionRisk } from '../../src/tools/cos/define.js';
import type { BotEventPayload, BotEventSource } from '../../src/pal/bot-events.js';
import type { ImService, PalChatInfo } from '../../src/pal/types.js';
import type { AgentRuntime, ConfirmResult, RunSessionInput } from '../../src/runtime/types.js';
import type { LlmClientLike } from '../../src/runtime/llm-client.js';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noLlm: LlmClientLike = { chat: async () => ({ content: 'ok', toolCalls: [] }) } as unknown as LlmClientLike;
const nullSource: BotEventSource = { connect: async () => {}, close: () => {}, onEvent: () => () => {} };

function fakeIm(chats: Record<string, PalChatInfo | 'error'>) {
  const sent: Array<{ chatId: string; msgType: string; content: Record<string, unknown> }> = [];
  let n = 0;
  const msg = (chatId: string) => ({ messageId: `m${++n}`, chatId, senderId: 'bot', msgType: 'text' as const, content: {}, createdAtMs: Date.now() });
  const im = {
    async sendMessage(p: { receiveId: string; msgType: string; content: Record<string, unknown> }) {
      sent.push({ chatId: p.receiveId, msgType: p.msgType, content: p.content });
      return { ok: true, value: msg(p.receiveId) };
    },
    async sendText(chatId: string, text: string) {
      sent.push({ chatId, msgType: 'text', content: { text } });
      return { ok: true, value: msg(chatId) };
    },
    async askUser() {
      return { ok: false, error: 'no' };
    },
    async getChat(chatId: string) {
      const c = chats[chatId];
      if (!c || c === 'error') return { ok: false, error: 'forbidden', code: 403 };
      return { ok: true, value: c };
    },
  } as unknown as ImService;
  return { im, sent };
}

function fakeRuntime(run: (input: RunSessionInput) => Promise<string> = async () => '好的') {
  const seen: RunSessionInput[] = [];
  const runtime = {
    registerTool() {},
    onToolCall: () => () => {},
    async runSession(input: RunSessionInput) {
      seen.push(input);
      return { sessionId: input.sessionId ?? 's', output: await run(input), messages: [], turns: 1 };
    },
  } as unknown as AgentRuntime;
  return { runtime, seen };
}

const msgEvent = (chatId: string, senderId: string, text: string, extra: Record<string, unknown> = {}): BotEventPayload => ({
  event_id: `e_${Math.random()}`,
  event_type: 'message.receive',
  created_at: new Date().toISOString(),
  message: { message_id: `msg_${Math.random()}`, chat_id: chatId, sender_id: senderId, msg_type: 'text', content: { text, ...extra } },
});

describe('A1 网关只回复单聊和群里 @ 机器人', () => {
  const chats: Record<string, PalChatInfo | 'error'> = {
    dm_bot: { chatType: 'p2p', memberIds: ['u1', 'bot'] },
    dm_people: { chatType: 'p2p', memberIds: ['u1', 'u2'] },
    group_bot: { chatType: 'group', memberIds: ['u1', 'u2', 'bot'] },
    group_people: { chatType: 'group', memberIds: ['u1', 'u2'] },
    broken: 'error',
  };
  const setup = () => {
    const { im, sent } = fakeIm(chats);
    const { runtime, seen } = fakeRuntime();
    const gw = createBotGateway({ runtime, eventSource: nullSource, im, sessionStore: false, progressDelayMs: false });
    return { gw, sent, seen };
  };

  it('机器人参与的单聊会回复', async () => {
    const { gw, seen, sent } = setup();
    await gw.handleMessage(msgEvent('dm_bot', 'u1', '今天有什么安排'));
    expect(seen).toHaveLength(1);
    expect(sent.at(-1)?.chatId).toBe('dm_bot');
  });

  it('同学之间的私聊、机器人不在的群、查不到的会话：不调大模型也不回复', async () => {
    const { gw, seen, sent } = setup();
    await gw.handleMessage(msgEvent('dm_people', 'u1', '晚上一起吃饭？'));
    await gw.handleMessage(msgEvent('group_people', 'u1', '@飞书同学 帮我建个表'));
    await gw.handleMessage(msgEvent('broken', 'u1', '你好'));
    expect(seen).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('群里没 @ 不回复；@ 了才回复，并且把 @ 去掉再交给模型', async () => {
    const { gw, seen } = setup();
    await gw.handleMessage(msgEvent('group_bot', 'u1', '大家下午好'));
    expect(seen).toHaveLength(0);
    await gw.handleMessage(msgEvent('group_bot', 'u1', '@飞书同学 总结一下今天的讨论'));
    expect(seen).toHaveLength(1);
    expect(seen[0].messages.at(-1)?.content).toBe('总结一下今天的讨论');
    // 用 mentions 字段 @（App 里点选成员）也算
    await gw.handleMessage(msgEvent('group_bot', 'u2', '帮我查下日程', { mentions: [{ user_id: 'bot', name: '飞书同学' }] }));
    expect(seen).toHaveLength(2);
  });

  it('「停」这类控制词也要先过筛选：别的会话里说「停」不会中止任务', async () => {
    const { im, sent } = fakeIm(chats);
    let release!: () => void;
    const { runtime } = fakeRuntime(
      (input) =>
        new Promise((res) => {
          release = () => res('完成');
          input.signal?.addEventListener('abort', () => res(''));
        }),
    );
    const gw = createBotGateway({ runtime, eventSource: nullSource, im, sessionStore: false, progressDelayMs: false });
    const task = gw.handleMessage(msgEvent('group_bot', 'u1', '@飞书同学 整理一下周报'));
    await new Promise((r) => setTimeout(r, 10));
    // 群里不 @ 说「停」：不当作控制词
    await gw.handleMessage(msgEvent('group_bot', 'u1', '停'));
    expect(sent.some((m) => String(m.content.text ?? '').includes('已停下'))).toBe(false);
    release();
    await task;
  });

  it('stripBotMention', () => {
    expect(stripBotMention('@飞书同学  帮我 @飞书同学 看看', ['飞书同学'])).toBe('帮我 看看');
  });
});

describe('A2 确认卡片绑定具体操作', () => {
  it('删除 A、再删除 B：发两张卡，各自带 bound_action；放行结果只含本卡 id', async () => {
    const { im, sent } = fakeIm({ dm: { chatType: 'p2p', memberIds: ['u1', 'bot'] } });
    const results: ConfirmResult[] = [];
    let gw!: ReturnType<typeof createBotGateway>;
    const clickLatest = () =>
      setTimeout(() => {
        const card = sent.filter((m) => m.msgType === 'interactive_card').at(-1)!;
        void gw.handleEvent({ event_id: 'x', created_at: '', event_type: 'card.action', card_action: { card_id: String(card.content.card_id), user_id: 'u1', action: '确认' } });
      }, 5);
    const { runtime } = fakeRuntime(async (input) => {
      for (const id of ['doc_a', 'doc_b']) {
        clickLatest();
        results.push(
          await input.confirm!({
            sessionId: 's',
            toolCallId: `t_${id}`,
            toolName: 'cos_doc',
            risk: 'destructive',
            summary: `删除文档 ${id}`,
            action: boundActionOf('DELETE', `/api/v1/docs/${id}`),
          }),
        );
      }
      return '都删了';
    });
    gw = createBotGateway({ runtime, eventSource: nullSource, im, sessionStore: false, progressDelayMs: false });
    await gw.handleMessage(msgEvent('dm', 'u1', '把 A 和 B 都删了'));

    const cards = sent.filter((m) => m.msgType === 'interactive_card');
    expect(cards).toHaveLength(2);
    expect(cards[0].content.card_id).not.toBe(cards[1].content.card_id);
    expect(cards[0].content.bound_action).toEqual({ method: 'DELETE', route: '/api/v1/docs/:doc_id', path: '/api/v1/docs/doc_a', target_id: 'doc_a' });
    expect(cards[1].content.bound_action).toMatchObject({ target_id: 'doc_b' });
    expect(results.map((r) => r.approved && r.cardId)).toEqual([cards[0].content.card_id, cards[1].content.card_id]);
  });

  it('批量删除按 id 列表绑定', () => {
    expect(boundActionOf('POST', '/api/v1/tables/t1/records/batch_delete', { record_ids: ['r1', 'r2'] })).toMatchObject({
      route: '/api/v1/tables/:table_key/records/batch_delete',
      target_id: ['r1', 'r2'],
    });
  });

  it('运行时把 bound_action 交给确认卡，确认后放进 ctx.confirmation', async () => {
    let n = 0;
    const llm = {
      chat: async () =>
        ++n === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 'del', arguments: '{"id":"d1"}' }] } : { content: '完成', toolCalls: [] },
    } as unknown as LlmClientLike;
    const rt = new ClassmateRuntime({ llm });
    const seenCtx: unknown[] = [];
    rt.registerTool('del', { type: 'object' }, async (_i, ctx) => (seenCtx.push(ctx.confirmation), { ok: true }), {
      policy: { risk: () => 'destructive', bind: async (i) => boundActionOf('DELETE', `/docs/${(i as { id: string }).id}`) },
    });
    const confirm = vi.fn(async () => ({ approved: true as const, cardId: 'card_1' }));
    await rt.runSession({ sessionId: 's', messages: [{ role: 'user', content: '删' }], confirm });
    expect(confirm.mock.calls[0][0]).toMatchObject({ action: { method: 'DELETE', target_id: 'd1' } });
    expect(String((confirm.mock.calls[0][0] as { summary: string }).summary)).toContain('d1');
    expect(seenCtx[0]).toMatchObject({ cardId: 'card_1', action: { target_id: 'd1' } });
  });
});

describe('A3 风险策略的默认值', () => {
  const rt = () => new ClassmateRuntime({ llm: noLlm, onError: () => {} });

  it('没配策略按 write；策略抛错按 destructive 并上报', () => {
    const onError = vi.fn();
    const r = new ClassmateRuntime({ llm: noLlm, onError });
    expect(r.assessRisk('x', undefined, {})).toEqual({ risk: 'write', needs: false });
    expect(r.assessRisk('x', { risk: () => { throw new Error('boom'); } }, {})).toEqual({ risk: 'destructive', needs: true });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('物理动作工具不带策略不能注册', () => {
    expect(() => rt().registerTool('temi_goto', { type: 'object' }, async () => ({}))).toThrow(/risk policy/);
    expect(() => rt().registerTool('arm_move', { type: 'object' }, async () => ({}), { physical: true })).toThrow(/risk policy/);
    expect(() => rt().registerTool('temi_goto', { type: 'object' }, async () => ({}), { policy: { risk: () => 'physical' } })).not.toThrow();
  });

  it('按动作名推断风险', () => {
    expect(inferActionRisk('delete_records')).toBe('destructive');
    expect(inferActionRisk('purge')).toBe('destructive');
    expect(inferActionRisk('list_records')).toBe('read');
    expect(inferActionRisk('update_doc')).toBe('write');
    expect(inferActionRisk(undefined)).toBe('write');
  });

  it('启动自检：大脑里注册的所有工具都有显式策略', () => {
    const prev = { m4: process.env.CLASSMATE_ROBOT_M4, mock: process.env.TEMI_MOCK };
    process.env.CLASSMATE_ROBOT_M4 = '1';
    process.env.TEMI_MOCK = '1';
    try {
      const brain = createBrain({ llm: noLlm, logger: silent, telemetry: false, cos: { baseUrl: 'http://127.0.0.1:9/api/v1', botToken: 't' } });
      const missing = brain.runtime.listTools().filter((n) => !brain.runtime.getTool(n)?.policy);
      expect(missing).toEqual([]);
      brain.robot?.close?.();
    } finally {
      process.env.CLASSMATE_ROBOT_M4 = prev.m4;
      process.env.TEMI_MOCK = prev.mock;
      if (prev.m4 === undefined) delete process.env.CLASSMATE_ROBOT_M4;
      if (prev.mock === undefined) delete process.env.TEMI_MOCK;
    }
  });
});
