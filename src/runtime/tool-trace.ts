/**
 * ToolTrace telemetry for the self-hosted runtime (PLAN §1.2-A4 parity).
 *
 * Ported from the 旧版工具调用钩子 in index.ts (L52–118):
 * one log line per tool call + best-effort fire-and-forget write to the
 * ToolTrace bitable table. Behaviour identical; only the subscription
 * mechanism changed (runtime.onToolCall instead of api.on).
 */

import type { AgentRuntime, ToolCallEvent } from './types.js';
import type { ClassmateConfig } from '../config.js';

export interface TelemetryOptions {
  getConfig: () => ClassmateConfig;
  logger?: { info: (m: string) => void; warn?: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void };
  /** Only trace tools with this prefix; default 'feishu_classmate_'. */
  prefix?: string;
}

/** Subscribe to onToolCall; returns an unsubscribe function. */
export function attachToolTraceTelemetry(
  runtime: AgentRuntime,
  opts: TelemetryOptions,
): () => void {
  const prefix = opts.prefix ?? 'feishu_classmate_';
  const logger = opts.logger ?? console;

  return runtime.onToolCall((event: ToolCallEvent) => {
    if (!event.toolName.startsWith(prefix)) return;
    const ms = event.durationMs ?? 0;
    const sid = event.sessionId ?? '-';
    if (event.error) {
      logger.error(`[feishu-classmate] tool fail: ${event.toolName} session=${sid} error=${event.error} (${ms}ms)`);
    } else {
      logger.info(`[feishu-classmate] tool done: ${event.toolName} session=${sid} ok (${ms}ms)`);
    }

    // 指标上报由 agent-metrics 统一负责；这里保留轻量本地日志钩子。
    // 不把工具参数或结果写入旧平台，避免泄露会话内容。
    void opts.getConfig;
    logger.debug?.(`[agent-trace] ${event.toolName} session=${sid} duration=${ms}ms`);
  });
}
