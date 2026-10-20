/**
 * Agent 调用指标上报（AGENT_PLAN M5 §4）：runtime.onToolCall → 缓存 → 批量 POST /bot/agent/metrics。
 *
 * 只报工具名、成败、耗时、简短错误码；不报参数和结果（指标对所有同学可见）。
 * 上报失败只记日志，最多留 2000 条待重试，不影响对话。
 */

import type { AgentRuntime, ToolCallEvent } from './types.js';
import type { CosClient } from '../cos-sdk/client.js';

export interface MetricItem {
  tool: string;
  ok: boolean;
  duration_ms: number;
  error_code?: string;
  at: number;
}

export interface MetricsReporter {
  /** 立即上报缓存（测试 / 退出时用）。 */
  flush(): Promise<void>;
  stop(): void;
  pending(): number;
}

const MAX_BUFFER = 2000;

/** 从工具结果推出成败和错误码：抛错、或返回 { ok:false } 都算失败。 */
export function metricOf(e: ToolCallEvent, now = Date.now()): MetricItem {
  const r = (e.result && typeof e.result === 'object' ? e.result : {}) as { ok?: unknown; code?: unknown; error_code?: unknown };
  const failed = Boolean(e.error) || r.ok === false;
  let code: string | undefined;
  if (failed) {
    const raw = typeof r.code === 'string' ? r.code : typeof r.error_code === 'string' ? r.error_code : e.error ? 'EXCEPTION' : 'FAILED';
    code = raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 40) || 'FAILED';
  }
  return {
    tool: e.toolName.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100),
    ok: !failed,
    duration_ms: Math.max(0, Math.min(3_600_000, Math.round(e.durationMs ?? 0))),
    ...(code ? { error_code: code } : {}),
    at: now,
  };
}

export function attachPlatformMetrics(
  runtime: Pick<AgentRuntime, 'onToolCall'>,
  cos: Pick<CosClient, 'post'>,
  opts: { flushMs?: number; batch?: number; now?: () => number; onError?: (m: string) => void } = {},
): MetricsReporter {
  const now = opts.now ?? Date.now;
  const batch = opts.batch ?? 200;
  let buf: MetricItem[] = [];
  let flushing: Promise<void> | undefined;

  const unsub = runtime.onToolCall((e) => {
    buf.push(metricOf(e, now()));
    if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
  });

  const flushOnce = async () => {
    while (buf.length) {
      const items = buf.slice(0, batch);
      const r = await cos.post('/bot/agent/metrics', { items }, { asBot: true });
      if (!r.ok) {
        opts.onError?.(`[agent-metrics] 上报失败：${r.error}`);
        return; // 留着下次再试
      }
      buf = buf.slice(items.length);
    }
  };
  const flush = () => {
    flushing ??= flushOnce().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };

  const timer = setInterval(() => void flush(), opts.flushMs ?? 15_000);
  timer.unref?.();

  return {
    flush,
    stop() {
      clearInterval(timer);
      unsub();
    },
    pending: () => buf.length,
  };
}
