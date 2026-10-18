/**
 * ToolTrace telemetry for the self-hosted runtime (PLAN §1.2-A4 parity).
 *
 * Ported from the OpenClaw `after_tool_call` hook in index.ts (L52–118):
 * one log line per tool call + best-effort fire-and-forget write to the
 * ToolTrace bitable table. Behaviour identical; only the subscription
 * mechanism changed (runtime.onToolCall instead of api.on).
 */

import type { AgentRuntime, ToolCallEvent } from './types.js';
import type { ClassmateConfig } from '../config.js';
import { getFeishuClient } from '../util/feishu-api.js';

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

    // --- ToolTrace telemetry (fire-and-forget) -----------------------------
    const startedAtMs = Date.now() - ms;
    let paramsJson = '';
    try {
      paramsJson = JSON.stringify(event.params ?? {});
      if (paramsJson.length > 8000) paramsJson = paramsJson.slice(0, 8000) + '…<truncated>';
    } catch {
      paramsJson = '<unserializable>';
    }
    const traceId = `tr_${startedAtMs}_${Math.random().toString(36).slice(2, 8)}`;

    (async () => {
      try {
        const cfg = opts.getConfig();
        const appToken = cfg.bitable.appToken;
        const traceTableId = cfg.bitable.tableIds?.tool_trace;
        if (!appToken || !traceTableId) return;
        const client = getFeishuClient(cfg);
        const fields: Record<string, unknown> = {
          trace_id: traceId,
          tool_name: event.toolName,
          session_key: sid,
          params_json: paramsJson,
          ok: !event.error,
          error: event.error ? String(event.error) : '',
          duration_ms: ms,
          started_at: startedAtMs,
        };
        const res = await client.createRecord(appToken, traceTableId, fields);
        if (!res.ok) {
          logger.debug?.(`[feishu-classmate] tool_trace write skipped: ${res.error}`);
        }
      } catch (err) {
        logger.debug?.(
          `[feishu-classmate] tool_trace write threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  });
}
