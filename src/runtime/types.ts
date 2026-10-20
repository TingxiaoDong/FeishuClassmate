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
  /** Who this session acts for (sender of the message); platform tools use it as on-behalf-of. */
  actor?: SessionActor;
  /**
   * 这次调用已经过同学确认（AGENT_PLAN M2）；cardId 作为服务端放行删除的凭证。
   * 一张卡只用一次：工具只在第一个写请求上带 cardId（代码审查 A2）。
   */
  confirmation?: { cardId?: string; action?: BoundAction };
}

// ---------------------------------------------------------------- 护栏（AGENT_PLAN M2 §2.4）

export type ToolRisk = 'read' | 'write' | 'destructive' | 'physical';

/**
 * 确认卡片绑定的具体操作（代码审查 A2 / 后端 B3）：服务端核验「确认的就是这次请求」。
 * route 是带 /api/v1 前缀的路由模板（和服务端 routeOptions.url 一致），path 是实际路径。
 */
export interface BoundAction {
  method: string;
  route: string;
  path: string;
  /** 操作对象；批量删除时是 id 列表。 */
  target_id?: string | string[];
}

/** 工具的风险策略：运行时据此决定要不要先发确认卡片。 */
export interface ToolPolicy {
  /** 按这次参数判断风险。没配策略时运行时按 write 处理；策略出错按 destructive（要确认）。 */
  risk?: (input: unknown) => ToolRisk;
  /** 要不要确认；缺省 destructive / physical 要确认。批量写入可在这里按条数要求确认（预演）。 */
  needsConfirm?: (input: unknown, risk: ToolRisk) => boolean;
  /** 给同学看的确认说明 / 预演（会改动什么、多少条、示例）。失败时用默认说明。 */
  preview?: (input: unknown, ctx: ToolCallContext) => Promise<string | undefined>;
  /** 进度消息里的步骤名，如「新增记录」。 */
  label?: (input: unknown) => string;
  /** 这次调用会发出的写请求（不真正发送），写进确认卡片的 bound_action。 */
  bind?: (input: unknown, ctx: ToolCallContext) => Promise<BoundAction | undefined>;
}

export interface ConfirmRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  risk: ToolRisk;
  /** 确认卡片上的说明。 */
  summary: string;
  actor?: SessionActor;
  /** 这张卡要放行的具体操作（有服务端接口的工具才有）。 */
  action?: BoundAction;
}

export type ConfirmResult =
  | { approved: true; cardId?: string }
  | { approved: false; reason: 'rejected' | 'timeout' | 'aborted' | 'unavailable' };

export type Confirmer = (req: ConfirmRequest) => Promise<ConfirmResult>;

export interface ProgressEvent {
  type: 'tool_start' | 'tool_end';
  toolName: string;
  toolCallId: string;
  /** 步骤名。 */
  label: string;
  ok?: boolean;
  durationMs?: number;
}

export interface SessionActor {
  userId: string;
  name?: string;
  chatId?: string;
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
  policy?: ToolPolicy;
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
  /** Who the session acts for; passed to every tool call. */
  actor?: SessionActor;
  /** 高风险工具调用前询问同学（确认卡片）。不传时需要确认的调用一律跳过。 */
  confirm?: Confirmer;
  /** 工具开始 / 结束时回调（进度消息）。 */
  onProgress?: (e: ProgressEvent) => void;
}

export interface RunSessionResult {
  sessionId: string;
  /** Final assistant message content. */
  output: string;
  /** 会话被中断（同学说「停」）。 */
  aborted?: boolean;
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
    meta?: { description?: string; policy?: ToolPolicy; physical?: boolean },
  ): void;

  /** 给已注册的工具设置 / 替换风险策略（旧业务工具在注册后补策略用）。 */
  setToolPolicy?(name: string, policy: ToolPolicy): void;

  /** Subscribe to post-tool-call events (telemetry; replaces `after_tool_call`). */
  onToolCall(fn: ToolCallHook): () => void;

  /** Run one conversational session to completion (tool-call loop inside). */
  runSession(input: RunSessionInput): Promise<RunSessionResult>;

  /** Look up a registered tool (used by tests and diagnostics). */
  getTool(name: string): RuntimeTool | undefined;

  /** Names of all registered tools, registration order. */
  listTools(): string[];
}
