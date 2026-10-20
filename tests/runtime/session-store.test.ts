import { describe, expect, it } from 'vitest';
import { createBotGateway } from '../../src/runtime/bot-gateway.js';
import { MemorySessionStore, extractRecentObjects, recordTurn, trimHistory } from '../../src/runtime/session-store.js';
import type { AgentRuntime, RunSessionInput } from '../../src/runtime/types.js';
import type { BotEventPayload } from '../../src/pal/bot-events.js';

function fakeRuntime(seen: RunSessionInput[]): AgentRuntime {
  return {
    registerTool() {},
    onToolCall() { return () => {}; },
    getTool() { return undefined; },
    listTools() { return []; },
    async runSession(input) {
      seen.push(input);
      return {
        sessionId: input.sessionId ?? 's',
        output: `回复${seen.length}`,
        turns: 1,
        messages: [{ role: 'tool', toolCallId: 't', content: JSON.stringify({ ok: true, summary: '器材表', links: ['cos://table/t1'] }) }],
      };
    },
  };
}

const gateway = (runtime: AgentRuntime, sent: string[] = []) =>
  createBotGateway({
    runtime,
    eventSource: { onEvent: () => () => {}, connect: async () => {}, close() {} } as never,
    im: { sendText: async (_chat: string, text: string) => { sent.push(text); return { ok: true, value: {} }; } } as never,
  });
const msg = (sender: string, text: string): BotEventPayload => ({ event_type: 'message.receive', message: { chat_id: 'c1', sender_id: sender, msg_type: 'text', content: { text } } }) as never;

describe('会话记忆', () => {
  it('同一同学多轮带历史和最近对象，群内不同同学互相隔离', async () => {
    const seen: RunSessionInput[] = [];
    const g = gateway(fakeRuntime(seen));
    await g.handleMessage(msg('u_zhang', '建表'));
    await g.handleMessage(msg('u_zhang', '刚才那张表加一列'));
    await g.handleMessage(msg('u_li', '我是谁'));
    expect(seen[1].actor).toEqual({ userId: 'u_zhang', chatId: 'c1' });
    expect(seen[1].messages.map((m) => m.content).join('\n')).toContain('cos://table/t1');
    expect(seen[1].messages.some((m) => m.content.includes('[u_zhang] 建表'))).toBe(true);
    expect(seen[2].messages.map((m) => m.content).join('\n')).not.toContain('建表');
    expect(seen[2].sessionId).not.toBe(seen[1].sessionId);
  });

  it('重置命令只清当前同学会话', async () => {
    const seen: RunSessionInput[] = [];
    const sent: string[] = [];
    const g = gateway(fakeRuntime(seen), sent);
    await g.handleMessage(msg('u_zhang', '第一句'));
    await g.handleMessage(msg('u_zhang', '/reset'));
    await g.handleMessage(msg('u_zhang', '第二句'));
    expect(sent).toContain('好的，之前的上下文已清空，我们重新开始。');
    expect(seen.at(-1)!.messages.map((m) => m.content).join('\n')).not.toContain('第一句');
  });

  it('裁剪历史并提取成功结果中的链接', async () => {
    const h = [{ role: 'user' as const, content: 'a'.repeat(20) }, { role: 'assistant' as const, content: 'b' }, { role: 'user' as const, content: 'c' }];
    trimHistory(h, 1, 100);
    expect(h).toEqual([{ role: 'user', content: 'c' }]);
    expect(extractRecentObjects({ messages: [{ role: 'tool', content: '{"ok":false,"links":["cos://doc/x"]}' }] })).toEqual([]);
    const store = new MemorySessionStore();
    const next = await recordTurn(await store.load('s'), { user: { role: 'user', content: 'x' }, recent: [{ link: 'cos://a', at: 1 }, { link: 'cos://b', at: 2 }] }, { maxRecent: 1 });
    await store.save('s', next);
    expect((await store.load('s')).recent.map((r) => r.link)).toEqual(['cos://b']);
  });
});
