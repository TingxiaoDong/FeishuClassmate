/** 第一阶段可信调度器：不调用模型，不接受模型正文，不回退普通 bot。
 *
 * 恢复边界（Agent 剩余任务 A-R02）：
 * - 每个触发先落盘（只存 taskId / occurrenceId / taskRevision / 重试簿记，不存凭证），再发任何有副作用的请求。
 * - 可重试失败按有界指数退避（RUN_BUSY 至少等 retryAfterMs）；超过后端 6 小时触发窗口就终止并清理，不无限重试。
 * - 明确受阻（撤销、过期、变版、越界、额度、幂等冲突）不重试；已拿到凭证时先尽力 finish，避免服务端运行一直 running。
 * - 逻辑消息键 = 任务 + 触发时刻 + 文档：同次重放复用，下一周期自然不同。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const SCHEDULER_PROTOCOL_VERSION = '2026-10-21.1';
const VERSION = SCHEDULER_PROTOCOL_VERSION;
/** 后端 OCCURRENCE_LOOKBACK_MS；快照里给了 lookbackMs 时以快照为准。 */
export const OCCURRENCE_LOOKBACK_MS = 6 * 3600_000;
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 5 * 60_000;

type Target = { type: 'chat' | 'user'; id: string };
type Receipt = { logicalMessageId: string; target: Target; status: 'sent' | 'blocked' | 'failed'; retryable?: boolean; code?: string | null };
type Pending = {
  taskId: string; occurrenceId: string; taskRevision?: string;
  /** 已失败的次数、下次最早重试时间、上次原因码：只用于退避和诊断，不含凭证。 */
  attempts?: number; nextAttemptAt?: number; lastCode?: string;
};
export type ScheduledResult = { status: 'done' | 'partial' | 'blocked' | 'failed'; output?: string; runId?: string; retryAt?: number };
export type RecoveredRun = { taskId: string; occurrenceId: string; result: ScheduledResult };
export interface TrustedScheduler {
  execute(taskId: string, occurrenceId: string): Promise<ScheduledResult>;
  /** 跑到期的待恢复触发；未到退避时间的跳过。返回本次实际处理的结果（供网关记日志）。 */
  recover(): Promise<RecoveredRun[]>;
}
export function scheduleOccurrence(expr: string, time: number): string {
  const unit = expr.trim().split(/\s+/).length === 6 ? 1000 : 60_000;
  return `schedule:${new Date(Math.floor(time / unit) * unit).toISOString()}`;
}
const OCCURRENCE_RE = /^schedule:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z)$/;
export const occurrenceTime = (occurrenceId: string): number | undefined => {
  const m = OCCURRENCE_RE.exec(occurrenceId);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : undefined;
};
export function retryDelay(attempts: number, retryAfterMs = 0): number {
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.max(backoff, Math.max(0, retryAfterMs));
}
class ApiError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryAfterMs = 0) { super(code); }
}
/** fetch 可注入隔离测试；生产使用同源、禁重定向、带超时的专用请求。 */
export function createTrustedScheduler(opts: {
  baseUrl: string; schedulerToken: string; botToken: string; stateDir: string; fetch?: typeof fetch; now?: () => number;
}): TrustedScheduler {
  const transport = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.baseUrl.replace(/\/$/, '');
  const valid = opts.schedulerToken.length >= 32 && opts.schedulerToken !== opts.botToken;
  const flights = new Map<string, Promise<ScheduledResult>>();
  async function request(path: string, body?: unknown, credential?: string, principal?: string, phase: 'begin' | 'other' = 'other'): Promise<any> {
    if (!valid) throw new ApiError('SCHEDULER_NOT_CONFIGURED');
    const headers: Record<string, string> = principal
      ? { 'X-Bot-Token': opts.botToken, 'X-On-Behalf-Of': principal }
      : { 'X-Automation-Scheduler-Token': opts.schedulerToken };
    if (credential) headers['X-Automation-Run-Credential'] = credential;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    let data: any;
    try {
      res = await transport(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      data = await res.json();
    } catch { throw new ApiError('BACKEND_UNAVAILABLE', true); }
    if (!res.ok) {
      const code = typeof data?.code === 'string' && /^[A-Z_]+$/.test(data.code) ? data.code : 'BACKEND_ERROR';
      // 开始运行时 401 = 触发证据无效（非触发时刻 / 超窗口），重试也不会变；投递/结束时 401 = 凭证被换发，恢复即可。
      const retryable = res.status >= 500 || code === 'RUN_BUSY' || (code === 'RUN_CREDENTIAL_INVALID' && phase !== 'begin');
      throw new ApiError(code, retryable, Number(data?.retryAfterMs) || 0);
    }
    return data;
  }
  const keyOf = (p: Pending) => createHash('sha256').update(JSON.stringify([p.taskId, p.occurrenceId])).digest('hex');
  async function save(p: Pending) {
    await mkdir(opts.stateDir, { recursive: true, mode: 0o700 });
    const dest = join(opts.stateDir, `${keyOf(p)}.json`), tmp = `${dest}.${randomUUID()}.tmp`;
    const file = await open(tmp, 'wx', 0o600);
    const record: Pending = { taskId: p.taskId, occurrenceId: p.occurrenceId, ...(p.taskRevision ? { taskRevision: p.taskRevision } : {}),
      ...(p.attempts ? { attempts: p.attempts, nextAttemptAt: p.nextAttemptAt, lastCode: p.lastCode } : {}) };
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    await rename(tmp, dest);
    const dir = await open(opts.stateDir, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async function remove(p: Pending) { await unlink(join(opts.stateDir, `${keyOf(p)}.json`)).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  function aggregate(rs: Receipt[]): ScheduledResult {
    const sent = rs.some(r => r.status === 'sent');
    return { status: sent ? (rs.some(r => r.status !== 'sent') ? 'partial' : 'done') : rs.some(r => r.status === 'failed') ? 'failed' : 'blocked' };
  }
  /** 拿到凭证后遇到不可恢复的错误：尽力结束运行，让服务端结果可见；失败也不影响本地终止。 */
  async function finishQuietly(path: string, token: string) {
    try { await request(`${path}/finish`, {}, token); } catch { /* 记录在服务端仍为 running，由报告里的诊断说明处理 */ }
  }
  async function run(p: Pending): Promise<ScheduledResult> {
    let runId: string | undefined;
    let held: { path: string; token: string } | undefined;
    try {
      const at = occurrenceTime(p.occurrenceId);
      if (at === undefined) throw new ApiError('RUN_INVALID');
      // 超过后端证据窗口：后端只会拒绝，继续重试没有意义。
      if (at < now() - OCCURRENCE_LOOKBACK_MS) throw new ApiError('OCCURRENCE_WINDOW_EXPIRED');
      // 必须先落盘，再进行任何可能产生副作用的请求。
      await save(p);
      const snap = await request(`/internal/automation/tasks/trigger/${encodeURIComponent(p.taskId)}`);
      if (snap.protocolVersion !== VERSION || snap.taskKind !== 'trigger' || snap.taskId !== p.taskId || snap.trigger?.event !== 'schedule' || snap.trigger?.condition || snap.occurrence?.supported !== true)
        throw new ApiError('UNSUPPORTED_CAPABILITY');
      const lookback = Number(snap.occurrence?.lookbackMs);
      if (Number.isFinite(lookback) && lookback > 0 && at < now() - lookback) throw new ApiError('OCCURRENCE_WINDOW_EXPIRED');
      if (!snap.enabled) throw new ApiError('TASK_DISABLED');
      if (!snap.deliveryReady || !snap.grant || snap.grant.effectiveStatus !== 'active') throw new ApiError('AUTHORIZATION_REQUIRED');
      if (!/^[a-f0-9]{64}$/.test(snap.taskRevision) || !snap.principalId) throw new ApiError('RUN_INVALID');
      if (p.taskRevision && p.taskRevision !== snap.taskRevision) throw new ApiError('TASK_REVISION_CHANGED');
      const caps = await request('/automation/capabilities', undefined, undefined, snap.principalId);
      if (caps.protocolVersion !== VERSION || caps.fixedTargetDelivery !== true || caps.atomicDelivery !== true || caps.durableResume !== true || caps.protectedDocLink !== true || caps.taskKinds?.trigger?.schedule !== true)
        throw new ApiError('UNSUPPORTED_CAPABILITY');
      if (p.taskRevision !== snap.taskRevision) { p.taskRevision = snap.taskRevision; await save(p); }
      const run = await request('/internal/automation/runs', { taskKind: 'trigger', taskId: p.taskId, expectedTaskRevision: p.taskRevision, occurrenceId: p.occurrenceId }, undefined, undefined, 'begin');
      if (run.taskId !== p.taskId || run.taskRevision !== p.taskRevision || run.principalId !== snap.principalId || run.occurrenceId !== p.occurrenceId || run.scope !== 'bot.messages.send' || typeof run.runId !== 'string') throw new ApiError('RUN_INVALID');
      runId = run.runId;
      if (run.credential === null) { if (!['succeeded', 'partial', 'failed', 'blocked'].includes(run.status) || !run.finishedAt) throw new ApiError('RUN_INVALID'); await remove(p); return { ...aggregate(run.deliveries ?? []), runId }; }
      if (run.credential?.header !== 'X-Automation-Run-Credential' || typeof run.credential.sendCredential !== 'string' || !Number.isFinite(Date.parse(run.credential.expiresAt))) throw new ApiError('RUN_INVALID');
      const path = `/internal/automation/runs/${encodeURIComponent(run.runId)}`;
      const token = run.credential.sendCredential;
      const expires = Date.parse(run.credential.expiresAt);
      if (expires <= now() || expires > now() + 305_000) throw new ApiError('RUN_CREDENTIAL_INVALID', true);
      held = { path, token };
      if (run.output?.mode !== 'protected_doc_link' || !Array.isArray(run.output.docIds) || !run.output.docIds.length || !Array.isArray(run.targets) || !run.targets.length) throw new ApiError('UNSUPPORTED_CAPABILITY');
      const current = await request(path);
      const receipts: Receipt[] = [];
      for (const docId of run.output.docIds) {
        if (typeof docId !== 'string' || !docId) throw new ApiError('RUN_INVALID');
        const logicalMessageId = `doc:${createHash('sha256').update(JSON.stringify([p.taskId, p.occurrenceId, docId])).digest('hex')}`;
        for (const t of run.targets) {
          if (!['chat', 'user'].includes(t.type) || typeof t.id !== 'string' || !t.id) throw new ApiError('RUN_INVALID');
          const target: Target = { type: t.type, id: t.id };
          const prev = (current.deliveries ?? []).find((r: Receipt) => r.logicalMessageId === logicalMessageId && r.target.type === t.type && r.target.id === t.id);
          // 已发出 / 明确受阻 / 不可重试：不再发；没有记录或 failed+retryable：用原键重放（服务端幂等）。
          if (prev && (prev.status === 'sent' || prev.status === 'blocked' || prev.retryable !== true)) { receipts.push(prev); continue; }
          const r = await request(`${path}/deliveries`, { logicalMessageId, target, purpose: 'final', payload: { mode: 'protected_doc_link', docId } }, token);
          if (!['sent', 'blocked', 'failed'].includes(r.status)) throw new ApiError('INVALID_DELIVERY_RESULT', true);
          receipts.push({ logicalMessageId, target, status: r.status, retryable: r.status === 'failed' && r.retryable === true, code: r.code ?? null });
        }
      }
      if (receipts.some(r => r.status === 'failed' && r.retryable)) {
        // 不结束运行：保留待恢复记录，退避后用原键重放失败目标。
        const retryAt = await scheduleRetry(p, 'DELIVERY_FAILED');
        return { ...aggregate(receipts), output: 'DELIVERY_FAILED', runId, retryAt };
      }
      const finished = await request(`${path}/finish`, {}, token);
      await remove(p);
      return { ...aggregate(finished.deliveries ?? receipts), runId };
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('STATE_UNAVAILABLE', true);
      if (err.retryable) {
        const retryAt = await scheduleRetry(p, err.code, err.retryAfterMs).catch(() => undefined);
        return { status: 'failed', output: err.code, runId, retryAt };
      }
      if (held) await finishQuietly(held.path, held.token);
      await remove(p).catch(() => undefined);
      return { status: 'blocked', output: err.code, runId };
    }
  }
  async function scheduleRetry(p: Pending, code: string, retryAfterMs = 0): Promise<number> {
    p.attempts = (p.attempts ?? 0) + 1;
    p.lastCode = code;
    p.nextAttemptAt = now() + retryDelay(p.attempts, retryAfterMs);
    await save(p);
    return p.nextAttemptAt;
  }
  function executePending(p: Pending): Promise<ScheduledResult> {
    const key = keyOf(p);
    const existing = flights.get(key);
    if (existing) return existing;
    const promise = run(p).finally(() => { flights.delete(key); });
    flights.set(key, promise);
    return promise;
  }
  const validPending = (p: Pending, file?: string) =>
    typeof p?.taskId === 'string' && !!p.taskId && occurrenceTime(p.occurrenceId) !== undefined && (!file || `${keyOf(p)}.json` === file);
  return {
    async execute(taskId, occurrenceId) {
      // 不覆盖已有版本：同一进程的新回调也只能恢复原始任务版本。
      const p: Pending = { taskId, occurrenceId };
      try {
        const saved = JSON.parse(await readFile(join(opts.stateDir, `${keyOf(p)}.json`), 'utf8')) as Pending;
        if (!validPending(saved) || saved.taskId !== taskId || saved.occurrenceId !== occurrenceId) return { status: 'blocked', output: 'STATE_INVALID' };
        if (saved.nextAttemptAt && saved.nextAttemptAt > now()) return { status: 'failed', output: saved.lastCode, retryAt: saved.nextAttemptAt };
        return executePending(saved);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'blocked', output: 'STATE_INVALID' }; }
      return executePending(p);
    },
    async recover() {
      let files: string[];
      try { files = await readdir(opts.stateDir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('STATE_UNAVAILABLE'); }
      const out: RecoveredRun[] = [];
      for (const file of files.filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
        let p: Pending;
        try { p = JSON.parse(await readFile(join(opts.stateDir, file), 'utf8')); } catch { continue; }
        if (!validPending(p, file)) continue;
        if (p.nextAttemptAt && p.nextAttemptAt > now()) continue; // 退避中：不忙循环
        out.push({ taskId: p.taskId, occurrenceId: p.occurrenceId, result: await executePending(p) });
      }
      return out;
    },
  };
}
