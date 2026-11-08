/**
 * OpenAI-compatible LLM client for the ClassmateOS agent gateway.
 * Uses the standard `/chat/completions` API and carries the session metadata
 * required by the gateway. Zero dependencies; uses the global `fetch`.
 */

import type { ChatMessage } from './types.js';

/** Structural interface so tests can inject a mock LLM without HTTP. */
export interface LlmClientLike {
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResult>;
}

export interface LlmClientOptions {
  /** e.g. http://127.0.0.1:30000/v1 — no trailing slash required. */
  baseUrl: string;
  /** Model name passed through to the proxy. */
  model: string;
  /** Upstream API key if the proxy forwards to a hosted provider. */
  apiKey?: string;
  /** Request timeout in ms. Default 120_000. */
  timeoutMs?: number;
}

export interface ToolSpecForLlm {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSpecForLlm[];
  sessionId: string;
  /** Gateway turn annotation: 'user' for user-initiated turns, 'tool' after tool results. */
  turnType: 'user' | 'tool';
  temperature?: number;
  /** 会话被中断时取消正在进行的请求。 */
  signal?: AbortSignal;
}

interface RawToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface RawChatCompletion {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: RawToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface ChatCompletionResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export class OpenAiLlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(opts: LlmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** One chat-completions round-trip against the proxy. */
  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCalls) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        if (m.toolCallId) msg.tool_call_id = m.toolCallId;
        return msg;
      }),
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.temperature != null) body.temperature = req.temperature;

    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(req.sessionId, req.turnType),
      body: JSON.stringify(body),
    }, req.signal);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(`LLM request failed: HTTP ${res.status}`, res.status, text.slice(0, 2000));
    }

    const data = (await res.json()) as RawChatCompletion;
    const choice = data.choices?.[0];
    if (!choice) throw new LlmError('LLM returned no choices');
    const toolCalls = (choice.message.tool_calls ?? [])
      .filter((tc) => tc.type === 'function')
      .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
    return {
      content: choice.message.content ?? '',
      toolCalls,
      finishReason: choice.finish_reason,
    };
  }


  private headers(sessionId: string, turnType: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId,
      'X-Turn-Type': turnType,
    };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const onAbort = () => ac.abort();
    if (signal?.aborted) ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
