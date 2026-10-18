/**
 * P0 acceptance test (PLAN §3): "runtime POC 能用 mock LLM 跑通一个 tool call 环".
 *
 * Covers:
 *  1. zod → JSON Schema 直出（无 TypeBox）；
 *  2. runSession 完整环：LLM 请求 tool call → 工具执行 → 结果回灌 → 最终回复；
 *  3. onToolCall 钩子（替代 after_tool_call）收到成功/失败事件；
 *  4. MetaClawLlmClient 的 HTTP 行为：X-Session-Id / X-Turn-Type 头 +
 *     /v1/memory/flush_session（用本地 HTTP server 冒充 proxy）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { ClassmateRuntime } from '../../src/runtime/agent-runtime.js';
import { MetaClawLlmClient, type ChatCompletionRequest } from '../../src/runtime/llm-client.js';
import { registerZodTool, zodToJsonSchema } from '../../src/runtime/zod-tool.js';
import type { AgentRuntime, ToolCallEvent } from '../../src/runtime/types.js';

// ---------------------------------------------------------------------------
// 1. zod → JSON Schema
// ---------------------------------------------------------------------------

describe('zodToJsonSchema (A2)', () => {
  it('emits OpenAI-tools-compatible JSON Schema natively', () => {
    const schema = z.object({
      title: z.string().describe('项目标题'),
      progress: z.number().min(0).max(100).optional(),
      status: z.enum(['进行中', '完成']),
      tags: z.array(z.string()).default([]),
    });
    const js = zodToJsonSchema(schema);
    expect(js.$schema).toBeUndefined();
    expect(js.type).toBe('object');
    const props = js.properties as Record<string, Record<string, unknown>>;
    expect(props.title).toMatchObject({ type: 'string', description: '项目标题' });
    expect(props.status.enum).toEqual(['进行中', '完成']);
    expect(js.required).toEqual(expect.arrayContaining(['title', 'status']));
    expect(js.required).not.toContain('progress');
  });
});

// ---------------------------------------------------------------------------
// 2–3. agent loop with a scripted mock LLM
// ---------------------------------------------------------------------------

/** Mock LLM: first turn asks for the echo tool, second turn answers. */
function makeScriptedLlm(seen: ChatCompletionRequest[]) {
  return {
    async chat(req: ChatCompletionRequest) {
      seen.push(req);
      if (seen.length === 1) {
        expect(req.turnType).toBe('user');
        expect(req.tools?.map((t) => t.name)).toContain('echo_test');
        return {
          content: '',
          toolCalls: [{ id: 'call_1', name: 'echo_test', arguments: '{"text":"hello"}' }],
        };
      }
      expect(req.turnType).toBe('tool');
      const toolMsg = req.messages[req.messages.length - 1];
      expect(toolMsg.role).toBe('tool');
      expect(toolMsg.toolCallId).toBe('call_1');
      expect(toolMsg.content).toContain('hello');
      return { content: '回显完成：hello', toolCalls: [] };
    },
  };
}

describe('ClassmateRuntime (A1/A4)', () => {
  function makeRuntime(seen: ChatCompletionRequest[]) {
    const events: ToolCallEvent[] = [];
    const flush = vi.fn().mockResolvedValue(undefined);
    const runtime: AgentRuntime = new ClassmateRuntime({
      llm: makeScriptedLlm(seen),
      systemPrompt: 'test system',
      flushSession: flush,
    });
    runtime.onToolCall((e) => events.push(e));
    registerZodTool(runtime, {
      name: 'echo_test',
      description: 'echo back the input text',
      inputSchema: z.object({ text: z.string() }),
      async execute(input) {
        return { ok: true, echoed: input.text };
      },
    });
    return { runtime, events, flush };
  }

  it('runs a full tool-call loop with a mock LLM', async () => {
    const seen: ChatCompletionRequest[] = [];
    const { runtime, events, flush } = makeRuntime(seen);

    const res = await runtime.runSession({
      sessionId: 'sess_test',
      messages: [{ role: 'user', content: '帮我回显 hello' }],
    });

    expect(res.output).toBe('回显完成：hello');
    expect(res.turns).toBe(2);
    expect(seen).toHaveLength(2);

    // system prompt prepended
    expect(seen[0].messages[0]).toEqual({ role: 'system', content: 'test system' });

    // after_tool_call hook fired with success payload
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      toolName: 'echo_test',
      sessionId: 'sess_test',
      toolCallId: 'call_1',
      params: { text: 'hello' },
    });
    expect(events[0].error).toBeUndefined();
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);

    // session flushed at end
    expect(flush).toHaveBeenCalledWith('sess_test');
  });

  it('emits error events for validation failures and unknown tools', async () => {
    const events: ToolCallEvent[] = [];
    const runtime = new ClassmateRuntime({
      llm: {
        async chat() {
          return {
            content: '',
            toolCalls: [
              { id: 'c1', name: 'echo_test', arguments: '{"text":123}' }, // wrong type
              { id: 'c2', name: 'missing_tool', arguments: '{}' }, // unknown
            ],
          };
        },
      },
    });
    runtime.onToolCall((e) => events.push(e));
    registerZodTool(runtime, {
      name: 'echo_test',
      description: 'echo',
      inputSchema: z.object({ text: z.string() }),
      async execute(input) {
        return { echoed: input.text };
      },
    });

    await runtime.runSession({
      sessionId: 's2',
      messages: [{ role: 'user', content: 'go' }],
      maxTurns: 1,
    });

    expect(events).toHaveLength(2);
    // zod validation failures are returned to the LLM as {ok:false,error}
    // payloads (same as the legacy OpenClaw adapter), so the hook sees a
    // completed call carrying the error payload:
    expect(events[0].error).toBeUndefined();
    expect(events[0].result).toMatchObject({ ok: false });
    expect(JSON.stringify(events[0].result)).toMatch(/validation/);
    // unknown tool → hard dispatch error on the hook
    expect(events[1].error).toMatch(/unknown tool/);
  });
});

// ---------------------------------------------------------------------------
// 4. MetaClawLlmClient over HTTP (A3): headers + flush endpoint
// ---------------------------------------------------------------------------

describe('MetaClawLlmClient (A3)', () => {
  it('sends X-Session-Id / X-Turn-Type headers and flushes the session', async () => {
    const received: Array<{ url: string; headers: Record<string, unknown>; body: unknown }> = [];
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          headers: req.headers as Record<string, unknown>,
          body: raw ? JSON.parse(raw) : null,
        });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/chat/completions') {
          res.end(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
            }),
          );
        } else {
          res.end('{}');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    try {
      const client = new MetaClawLlmClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'test-model',
        apiKey: 'k-test',
      });
      const out = await client.chat({
        messages: [{ role: 'user', content: 'ping' }],
        sessionId: 'sess_http',
        turnType: 'user',
      });
      expect(out.content).toBe('pong');
      await client.flushSession('sess_http');

      expect(received).toHaveLength(2);
      const [chatReq, flushReq] = received;
      expect(chatReq.headers['x-session-id']).toBe('sess_http');
      expect(chatReq.headers['x-turn-type']).toBe('user');
      expect(chatReq.headers['authorization']).toBe('Bearer k-test');
      expect(chatReq.body).toMatchObject({ model: 'test-model' });
      expect(flushReq.url).toBe('/v1/memory/flush_session');
      expect(flushReq.body).toEqual({ session_id: 'sess_http' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
