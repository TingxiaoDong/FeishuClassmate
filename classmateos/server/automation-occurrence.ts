/**
 * 自动化预授权 v2：可信触发证据（occurrence）。
 *
 * 第一阶段只支持定时触发器（event=schedule）：occurrenceId = `schedule:<触发时刻 ISO 8601>`。
 * 后端用与 Agent 触发引擎相同的 node-cron 匹配规则（Asia/Shanghai）核对这个时刻确实是该 cron 的触发时刻，
 * 并且落在 [now - 6 小时, now + 2 分钟] 内。规范化后的 occurrenceId 决定 runId，同一次触发重启 / 重试得到同一运行。
 *
 * 事件触发器（record.changed 等）的事件只在内存环形缓冲里，重启后无法核验，第一阶段明确不支持。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { AuthorizationError } from './automation-authorization.js';

export const OCCURRENCE_LOOKBACK_MS = 6 * 3600_000;
export const OCCURRENCE_LOOKAHEAD_MS = 120_000;
export const SCHEDULE_TIMEZONE = 'Asia/Shanghai';

type Matcher = { match(date: Date): boolean };
let MatcherCtor: (new (pattern: string, timezone?: string) => Matcher) | undefined;
function loadMatcher() {
  if (!MatcherCtor) {
    // node-cron 的 exports 没有导出 TimeMatcher；按包内文件路径加载，保证与 cron.schedule 的匹配规则完全相同。
    const req = createRequire(import.meta.url);
    const main = req.resolve('node-cron');
    MatcherCtor = (req(join(dirname(main), 'time', 'time-matcher.js')) as { TimeMatcher: typeof MatcherCtor }).TimeMatcher;
  }
  return MatcherCtor!;
}

export function cronMatches(expr: string, at: Date, timezone = SCHEDULE_TIMEZONE): boolean {
  return new (loadMatcher())(expr, timezone).match(at);
}

/**
 * 核对并规范化定时触发证据。任一条不满足都抛 AuthorizationError：
 * - 格式不对、时间不在窗口内、不是 cron 触发时刻 → RUN_CREDENTIAL_INVALID（触发证据无效）
 * - 非定时触发器 → UNSUPPORTED_CAPABILITY
 */
export function verifyScheduleOccurrence(trigger: { event: string; cron: string | null }, occurrenceId: string, nowMs: number): string {
  if (trigger.event !== 'schedule' || !trigger.cron) throw new AuthorizationError('UNSUPPORTED_CAPABILITY');
  const m = /^schedule:(.{10,40})$/.exec(occurrenceId);
  const ms = m ? Date.parse(m[1]) : NaN;
  if (!m || !Number.isFinite(ms) || ms % 1000 !== 0 || !/(Z|[+-]\d{2}:\d{2})$/.test(m[1])) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
  if (ms < nowMs - OCCURRENCE_LOOKBACK_MS || ms > nowMs + OCCURRENCE_LOOKAHEAD_MS) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
  if (!cronMatches(trigger.cron, new Date(ms))) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
  return `schedule:${new Date(ms).toISOString()}`;
}
