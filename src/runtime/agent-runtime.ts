/**
 * ClassmateRuntime — the self-hosted agent loop (PLAN §1.2-A1/A4).
 *
 * Deliberately minimal: one loop —
 *   LLM call → tool-call dispatch → results fed back → repeat
 * until the model stops requesting tools or `maxTurns` is hit. No context
 * compression, no parallel sessions inside the runtime (the lab-bot scenario
 * is single-tenant; concurrency is handled by callers per session id).
 */

import { randomUUID } from 'node:crypto';
import type { LlmClientLike } from './llm-client.js';
import type {
  AgentRuntime,
  ChatMessage,
  JsonSchema,
  RunSessionInput,
  RunSessionResult,
  RuntimeTool,
  ToolCallContext,
  ToolCallEvent,
  ToolCallHook,
} from './types.js';

export interface ClassmateRuntimeOptions {
  llm: LlmClientLike;
  /** Default system prompt prepended to every session. */
  systemPrompt?: string;
  /** Default max LLM round-trips per session. Default 16. */
  maxTurns?: number;
  /**
   * Called when a session ends so MetaClaw can flush memory. Best-effort —
   * errors are swallowed and reported via onError. Omit to disable.
   */
  flushSession?: (sessionId: string) => Promise<void>;
  /** Sink for non-fatal runtime errors (flush failures etc.). */
  onError?: (err: unknown) => void;
}

const DEFAULT_MAX_TURNS = 16;

export class ClassmateRuntime implements AgentRuntime {
  private readonly tools = new Map<string, RuntimeTool>();
  private readonly hooks: ToolCallHook[] = [];
  private readonly llm: LlmClientLike;
  private readonly systemPrompt?: string;
  private readonly defaultMaxTurns: number;
  private readonly flushSession?: (sessionId: string) => Promise<void>;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: ClassmateRuntimeOptions) {
    this.llm = opts.llm;
    this.systemPrompt = opts.systemPrompt;
    this.defaultMaxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.flushSession = opts.flushSession;
    this.onError = opts.onError;
  }

  registerTool(
    name: string,
    schema: JsonSchema,
    execute: (input: unknown, ctx: ToolCallContext) => Promise<unknown>,
    meta?: { description?: string },
  ): void {
    if (this.tools.has(name)) throw new Error(`tool already registered: ${name}`);
    this.tools.set(name, {
      name,
      description: meta?.description ?? '',
      parameters: schema,
      execute,
    });
  }

  onToolCall(fn: ToolCallHook): () => void {
    this.hooks.push(fn);
    return () => {
      const i = this.hooks.indexOf(fn);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  getTool(name: string): RuntimeTool | undefined {
    return this.tools.get(name);
  }

  listTools(): string[] {
    return [...this.tools.keys()];
  }

  async runSession(input: RunSessionInput): Promise<RunSessionResult> {
    const sessionId = input.sessionId ?? `sess_${randomUUID()}`;
    const maxTurns = input.maxTurns ?? this.defaultMaxTurns;

    const messages: ChatMessage[] = [];
    const sys = input.systemPrompt ?? this.systemPrompt;
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push(...input.messages);

    const toolSpecs = [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    let turns = 0;
    let output = '';
    try {
      while (turns < maxTurns) {
        if (input.signal?.aborted) throw new Error('session aborted');
        turns += 1;

        const res = await this.llm.chat({
          messages,
          tools: toolSpecs,
          sessionId,
          turnType: turns === 1 ? 'user' : 'tool',
        });

        if (res.toolCalls.length === 0) {
          output = res.content;
          messages.push({ role: 'assistant', content: res.content });
          break;
        }

        // Record the assistant turn that requested the tool calls…
        messages.push({
          role: 'assistant',
          content: res.content,
          toolCalls: res.toolCalls,
        });

        // …then dispatch each tool call and feed results back.
        for (const tc of res.toolCalls) {
          const resultText = await this.dispatchToolCall(sessionId, tc);
          messages.push({ role: 'tool', content: resultText, toolCallId: tc.id });
        }
      }

      if (turns >= maxTurns && !output) {
        const last = [...messages].reverse().find((m) => m.role === 'assistant');
        output = last?.content ?? '';
      }
      return { sessionId, output, messages, turns };
    } finally {
      if (this.flushSession) {
        try {
          await this.flushSession(sessionId);
        } catch (err) {
          this.onError?.(err);
        }
      }
    }
  }

  /** Execute one tool call; always returns the string fed back to the LLM. */
  private async dispatchToolCall(
    sessionId: string,
    tc: { id: string; name: string; arguments: string },
  ): Promise<string> {
    const tool = this.tools.get(tc.name);
    const started = Date.now();
    const eventBase = {
      toolName: tc.name,
      sessionId,
      toolCallId: tc.id,
      durationMs: 0,
    };

    if (!tool) {
      const error = `unknown tool: ${tc.name}`;
      this.emit({ ...eventBase, params: undefined, durationMs: 0, error });
      return JSON.stringify({ ok: false, error });
    }

    let params: unknown;
    try {
      params = tc.arguments ? JSON.parse(tc.arguments) : {};
    } catch {
      const error = `invalid tool arguments JSON for ${tc.name}`;
      this.emit({ ...eventBase, params: tc.arguments, durationMs: Date.now() - started, error });
      return JSON.stringify({ ok: false, error });
    }

    try {
      const result = await tool.execute(params, { toolCallId: tc.id, sessionId });
      this.emit({
        ...eventBase,
        params,
        durationMs: Date.now() - started,
        result,
      });
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ ...eventBase, params, durationMs: Date.now() - started, error });
      return JSON.stringify({ ok: false, error });
    }
  }

  private emit(event: ToolCallEvent): void {
    for (const fn of this.hooks) {
      try {
        fn(event);
      } catch (err) {
        this.onError?.(err);
      }
    }
  }
}
