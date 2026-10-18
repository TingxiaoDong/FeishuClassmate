/**
 * AgentRuntime — the brain-side contract of the self-hosted runtime (PLAN §1.2-A1).
 *
 * The whole migration hinges on this single interface:
 *   - skills/tools keep calling `registerZodTool`-style registration;
 *   - the LLM loop lives behind `runSession`;
 *   - telemetry hooks ride on `onToolCall` (replaces OpenClaw's
 *     `after_tool_call` event).
 *
 * Implementations: `ClassmateRuntime` (./agent-runtime.ts) today; a Hermes /
 * PicoClaw adapter (PLAN fallback B) can implement the same interface later
 * without touching any tool file.
 */

/** JSON Schema object describing a tool's input (draft 2020-12, OpenAI-tools compatible). */
export type JsonSchema = Record<string, unknown>;

export interface ToolCallContext {
  /** Unique id of this tool invocation (matches the LLM tool_call id). */
  toolCallId: string;
  /** Session that produced this call. */
  sessionId: string;
  /** Optional abort signal for cancellable sessions. */
  signal?: AbortSignal;
}

export interface RuntimeTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input — sent verbatim to the LLM as `function.parameters`. */
  parameters: JsonSchema;
  /**
   * Execute the tool. `input` is already validated against the zod schema by
   * the registration wrapper. Return any JSON-serialisable payload; the
   * runtime stringifies it into the `tool` message fed back to the LLM.
   */
  execute: (input: unknown, ctx: ToolCallContext) => Promise<unknown>;
}

/** Fired after every tool call, success or failure (PLAN §1.2-A4). */
export interface ToolCallEvent {
  toolName: string;
  sessionId: string;
  toolCallId: string;
  /** Validated input params (post zod-parse). */
  params: unknown;
  durationMs: number;
  /** Present iff the call failed (validation error or thrown exception). */
  error?: string;
  /** Tool return payload on success. */
  result?: unknown;
}

export type ToolCallHook = (event: ToolCallEvent) => void;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** Present on tool messages: the tool_call id being answered. */
  toolCallId?: string;
}

export interface RunSessionInput {
  /** Conversation so far (without system prompt — runtime prepends it). */
  messages: ChatMessage[];
  /** Stable session id; sent to MetaClaw as `X-Session-Id` (PLAN §0.2). */
  sessionId?: string;
  /** Optional system prompt override; defaults to runtime's configured prompt. */
  systemPrompt?: string;
  /** Hard cap on LLM round-trips (tool-call loops). Default 16. */
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface RunSessionResult {
  sessionId: string;
  /** Final assistant message content. */
  output: string;
  /** Full message transcript including tool calls/results. */
  messages: ChatMessage[];
  /** Number of LLM round-trips used. */
  turns: number;
}

export interface AgentRuntime {
  /** Register a tool by name + JSON Schema (PLAN §1.2-A1). */
  registerTool(
    name: string,
    schema: JsonSchema,
    execute: (input: unknown, ctx: ToolCallContext) => Promise<unknown>,
    meta?: { description?: string },
  ): void;

  /** Subscribe to post-tool-call events (telemetry; replaces `after_tool_call`). */
  onToolCall(fn: ToolCallHook): () => void;

  /** Run one conversational session to completion (tool-call loop inside). */
  runSession(input: RunSessionInput): Promise<RunSessionResult>;

  /** Look up a registered tool (used by tests and diagnostics). */
  getTool(name: string): RuntimeTool | undefined;

  /** Names of all registered tools, registration order. */
  listTools(): string[];
}
