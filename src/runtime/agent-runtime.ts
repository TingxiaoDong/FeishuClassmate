/**
 * ClassmateRuntime — the self-hosted agent loop (PLAN §1.2-A1/A4).
 *
 * Deliberately minimal: one loop —
 *   LLM call → tool-call dispatch → results fed back → repeat
 * until the model stops requesting tools or `maxTurns` is hit. No context
 * compression, no parallel sessions inside the runtime (the lab-bot scenario
 * is single-tenant; concurrency is handled by callers per session id).
 *
 * 护栏（AGENT_PLAN M2）：每个工具可带 ToolPolicy；需要确认的调用先走 input.confirm
 * （网关发确认卡片），同学同意后才执行，并把确认卡片 id 交给工具（服务端据此放行删除）。
 * 同学说「停」时网关触发 signal：当前 LLM 请求和剩余工具调用都取消，返回 aborted=true。
 */

import { randomUUID } from 'node:crypto';
import type { LlmClientLike } from './llm-client.js';
import { defaultToolLabel } from './policy.js';
import type {
  AgentRuntime,
  BoundAction,
  ChatMessage,
  ConfirmResult,
  JsonSchema,
  RunSessionInput,
  RunSessionResult,
  RuntimeTool,
  ToolCallContext,
  ToolCallEvent,
  ToolCallHook,
  ToolPolicy,
  ToolRisk,
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

/** 会让机器人动起来的工具：注册时必须带风险策略（代码审查 A3）。 */
export const PHYSICAL_TOOL_NAME = /^(temi_|feishu_classmate_temi_)/;

/** 没得到确认时回给模型的话：告诉它别重试、怎么跟同学说。 */
const CONFIRM_REFUSAL: Record<'rejected' | 'timeout' | 'aborted' | 'unavailable', string> = {
  rejected: '同学在确认卡片上选了「取消」，这一步没有执行。不要再重试，直接告诉同学已取消。',
  timeout: '同学没有在规定时间内确认，这一步没有执行。告诉同学需要时可以再说一次。',
  aborted: '同学让停下了，这一步没有执行。',
  unavailable: '这一步需要同学确认后才能执行，但现在没有可以确认的同学（例如定时任务），已跳过。请在回复里说明需要同学自己来做或来确认。',
};

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
    meta?: { description?: string; policy?: ToolPolicy; physical?: boolean },
  ): void {
    if (this.tools.has(name)) throw new Error(`tool already registered: ${name}`);
    // 物理动作类工具漏配策略就可能不经确认让机器人移动：直接拒绝注册
    if ((meta?.physical ?? PHYSICAL_TOOL_NAME.test(name)) && !meta?.policy) {
      throw new Error(`physical tool must be registered with a risk policy: ${name}`);
    }
    this.tools.set(name, {
      name,
      description: meta?.description ?? '',
      parameters: schema,
      execute,
      policy: meta?.policy,
    });
  }

  setToolPolicy(name: string, policy: ToolPolicy): void {
    const t = this.tools.get(name);
    if (!t) throw new Error(`unknown tool: ${name}`);
    t.policy = policy;
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
    const aborted = () => ({ sessionId, output: '', messages, turns, aborted: true });
    try {
      while (turns < maxTurns) {
        if (input.signal?.aborted) return aborted();
        turns += 1;

        let res;
        try {
          res = await this.llm.chat({
            messages,
            tools: toolSpecs,
            sessionId,
            turnType: turns === 1 ? 'user' : 'tool',
            signal: input.signal,
          });
        } catch (err) {
          if (input.signal?.aborted) return aborted();
          throw err;
        }

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
          // 中断后剩下的调用不再执行，但要给每个 tool_call 一个结果，保持对话格式合法
          const resultText = input.signal?.aborted
            ? JSON.stringify({ ok: false, error: '同学让停下了，这一步没有执行' })
            : await this.dispatchToolCall(sessionId, tc, input);
          messages.push({ role: 'tool', content: resultText, toolCallId: tc.id });
        }
        if (input.signal?.aborted) return aborted();
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
    input: Pick<RunSessionInput, 'actor' | 'signal' | 'confirm' | 'onProgress'>,
  ): Promise<string> {
    const { actor, signal } = input;
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

    const ctx: ToolCallContext = { toolCallId: tc.id, sessionId, actor, signal };
    const policy = tool.policy;
    let label = tc.name;
    try {
      label = policy?.label?.(params) ?? defaultToolLabel(tc.name, params);
    } catch {
      label = defaultToolLabel(tc.name, params);
    }
    const { risk, needs } = this.assessRisk(tc.name, policy, params);

    // 护栏：高风险调用先问同学（AGENT_PLAN M2 §2.4）
    if (needs) {
      const decision = await this.askConfirm(tc, params, ctx, risk, label, input);
      if (!decision.approved) {
        const error = CONFIRM_REFUSAL[decision.reason];
        this.emit({ ...eventBase, params, durationMs: Date.now() - started, error });
        return JSON.stringify({ ok: false, cancelled: true, need_confirmation: decision.reason === 'unavailable', error });
      }
      ctx.confirmation = { cardId: decision.cardId, action: decision.action };
    }

    input.onProgress?.({ type: 'tool_start', toolName: tc.name, toolCallId: tc.id, label });
    try {
      const result = await tool.execute(params, ctx);
      const ok = !(result && typeof result === 'object' && (result as { ok?: unknown }).ok === false);
      input.onProgress?.({ type: 'tool_end', toolName: tc.name, toolCallId: tc.id, label, ok, durationMs: Date.now() - started });
      this.emit({
        ...eventBase,
        params,
        durationMs: Date.now() - started,
        result,
      });
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      input.onProgress?.({ type: 'tool_end', toolName: tc.name, toolCallId: tc.id, label, ok: false, durationMs: Date.now() - started });
      this.emit({ ...eventBase, params, durationMs: Date.now() - started, error });
      return JSON.stringify({ ok: false, error });
    }
  }

  /**
   * 风险判断（代码审查 A3）：
   *   - 没配策略 / 策略没给结果 → write（不会被当成只读悄悄放过）；
   *   - 策略函数抛异常 → destructive，一定要确认，并上报 onError。
   */
  assessRisk(name: string, policy: ToolPolicy | undefined, params: unknown): { risk: ToolRisk; needs: boolean } {
    try {
      const risk: ToolRisk = policy?.risk?.(params) ?? 'write';
      const needs = policy?.needsConfirm ? policy.needsConfirm(params, risk) : risk === 'destructive' || risk === 'physical';
      return { risk, needs };
    } catch (err) {
      this.onError?.(new Error(`tool policy failed for ${name}, treated as destructive: ${err instanceof Error ? err.message : String(err)}`));
      return { risk: 'destructive', needs: true };
    }
  }

  private async askConfirm(
    tc: { id: string; name: string },
    params: unknown,
    ctx: ToolCallContext,
    risk: ToolRisk,
    label: string,
    input: Pick<RunSessionInput, 'actor' | 'confirm'>,
  ): Promise<ConfirmResult & { action?: BoundAction }> {
    if (!input.confirm) return { approved: false, reason: 'unavailable' };
    const policy = this.tools.get(tc.name)?.policy;
    let summary: string | undefined;
    let action: BoundAction | undefined;
    if (!ctx.signal?.aborted) {
      try {
        action = await policy?.bind?.(params, ctx);
      } catch (err) {
        this.onError?.(err);
      }
      try {
        summary = await policy?.preview?.(params, ctx);
      } catch (err) {
        this.onError?.(err);
      }
    }
    const target = action?.target_id === undefined ? '' : Array.isArray(action.target_id) ? `（${action.target_id.length} 个对象）` : `（对象 ${action.target_id}）`;
    try {
      const r = await input.confirm({
        sessionId: ctx.sessionId,
        toolCallId: tc.id,
        toolName: tc.name,
        risk,
        summary: summary || `将要执行：${label}${target}`,
        actor: input.actor,
        ...(action ? { action } : {}),
      });
      return r.approved ? { ...r, action } : r;
    } catch (err) {
      this.onError?.(err);
      return { approved: false, reason: 'unavailable' };
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
