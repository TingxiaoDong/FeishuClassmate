/** 内部运行凭证核心；调用方必须是经过独立鉴权和触发验证的可信调度器。
 * 不注册 HTTP 接口，不代表投递事务已经实现。 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Repo, EntityRecord } from './repo.js';
import { AuthorizationError, taskRevision, type AuthorizationPolicy, type AuthorizationRecord, type RunContext } from './automation-authorization.js';

const KIND = 'automation_run_v2';
const GRANTS = 'automation_authorization_v2';
export const RUN_KIND = KIND;
export const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface StoredAutomationRun {
  runId: string;
  draftId: string;
  grantId: string;
  grantVersion: number;
  taskRevision: string;
  principalId: string;
  expiresAt: string;
  credentialHash: string;
  status: 'running' | 'finished';
  /** 以下字段由 begin() 写入；issue() 生成的测试运行没有 occurrence。 */
  taskKind?: 'trigger' | 'scheduler';
  taskId?: string;
  occurrenceId?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  /** 凭证换发次数（恢复运行时 +1）。 */
  credentialRotation?: number;
  /** 当前凭证签发时间（毫秒）；租约期内不允许其他调用方接管。 */
  credentialIssuedAtMs?: number;
}
/** 同一次触发正被另一个调度进程持有（租约期内）。调用方应等待 retryAfterMs 后重试，或查询运行结果。 */
export class RunBusyError extends Error {
  readonly code = 'RUN_BUSY';
  constructor(public readonly runId: string, public readonly retryAfterMs: number) { super('RUN_BUSY'); }
}
export interface BeginRunInput { draftId: string; expectedRevision: string; taskKind: 'trigger' | 'scheduler'; taskId: string; occurrenceId: string }
export interface BeginRunResult { context: RunContext | null; run: StoredAutomationRun; resumed: boolean }
/** 同一任务 + 同一次触发 → 同一个 runId（重启、重试都得到同一个逻辑运行）。 */
export function occurrenceRunId(taskKind: string, taskId: string, occurrenceId: string): string {
  return `arn_${createHash('sha256').update(`${taskKind}\n${taskId}\n${occurrenceId}`).digest('hex').slice(0, 40)}`;
}
type Storage = Pick<Repo, 'getEntity' | 'saveEntity'>;
export class AutomationRunCredentials {
  /** 换发凭证的租约：签发后这段时间内，同一次触发的其他开始 / 恢复请求返回 RUN_BUSY，不会顶掉正在使用的凭证。 */
  resumeLeaseMs = 15_000;
  constructor(private readonly repo: Storage, private readonly policy: AuthorizationPolicy, private readonly now: () => number = Date.now) {}

  private async active(draftId: string) {
    const rec = await this.repo.getEntity(GRANTS, draftId);
    if (!rec) throw new AuthorizationError('AUTHORIZATION_REQUIRED');
    const grant = rec.data as unknown as AuthorizationRecord;
    if (grant.status === 'revoked') throw new AuthorizationError('GRANT_REVOKED');
    if (grant.status !== 'active' || !grant.grantId || !grant.approvedBy) throw new AuthorizationError('AUTHORIZATION_REQUIRED');
    if (Date.parse(grant.spec.expiresAt) <= this.now()) throw new AuthorizationError('GRANT_EXPIRED');
    const task = await this.policy.loadTask(grant.spec.taskKind, grant.spec.taskId);
    if (!task || task.principalId !== grant.spec.principalId) throw new AuthorizationError('PRINCIPAL_INVALID');
    if (!task.enabled) throw new AuthorizationError('TASK_DISABLED');
    if (taskRevision(task) !== grant.spec.taskRevision) throw new AuthorizationError('TASK_REVISION_CHANGED');
    await this.policy.assertCanApprove(grant.approvedBy, task, grant.spec);
    return { rec, grant };
  }

  /** 内部调用，不接受模型发来的身份或触发声明；HTTP 适配器必须另行验证触发证据。 */
  async issue(draftId: string, expectedRevision: string, ttlMs = 300_000): Promise<RunContext> {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
    const { rec, grant } = await this.active(draftId);
    if (grant.spec.taskRevision !== expectedRevision) throw new AuthorizationError('TASK_REVISION_CHANGED');
    const now = this.now();
    const expiresAt = new Date(Math.min(now + ttlMs, Date.parse(grant.spec.expiresAt))).toISOString();
    const sendCredential = randomBytes(32).toString('base64url');
    const runId = `arn_${randomUUID()}`;
    const run: StoredAutomationRun = { runId, draftId, grantId: grant.grantId!, grantVersion: rec.version, taskRevision: expectedRevision, principalId: grant.spec.principalId, expiresAt, credentialHash: hash(sendCredential), status: 'running' };
    const at = new Date(now).toISOString();
    if (!await this.repo.saveEntity({ kind: KIND, id: runId, scope: rec.scope, version: 0, created_at: at, updated_at: at, data: run as unknown as Record<string, unknown> }, 0)) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
    // 若签发期间发生撤销，验证失败，不向调用者返回凭证。
    await this.verify({ runId, grantId: run.grantId, taskRevision: expectedRevision, principalId: run.principalId, expiresAt, sendCredential });
    return { runId, grantId: run.grantId, taskRevision: expectedRevision, principalId: run.principalId, expiresAt, sendCredential };
  }

  /**
   * 开始或恢复一次触发对应的运行（调度器入口用）。
   * - 第一次：新建运行并签发凭证。并发重复调用只会有一个创建成功，其余按恢复处理。
   * - 运行中：重新核验授权、任务版本、身份和权限，换发新凭证（旧凭证随即失效）；授权版本变了（撤销等）则拒绝。
   * - 已结束：不再签发凭证，context 为 null，调用方只能查询结果。
   */
  async begin(input: BeginRunInput, ttlMs = 300_000): Promise<BeginRunResult> {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
    const runId = occurrenceRunId(input.taskKind, input.taskId, input.occurrenceId);
    {
      const existing = await this.repo.getEntity(KIND, runId);
      if (existing) {
        const run = existing.data as unknown as StoredAutomationRun;
        if (run.status === 'finished') return { context: null, run, resumed: true };
        const issuedAt = run.credentialIssuedAtMs ?? Date.parse(existing.updated_at);
        const busyFor = issuedAt + this.resumeLeaseMs - this.now();
        if (busyFor > 0) throw new RunBusyError(runId, busyFor);
        // 恢复：重新核验授权（撤销、到期、停用、变版、权限失效都会在这里失败），授权实体版本必须没变。
        const { rec, grant } = await this.active(run.draftId);
        if (rec.version !== run.grantVersion || grant.grantId !== run.grantId) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
        if (run.taskRevision !== input.expectedRevision) throw new AuthorizationError('TASK_REVISION_CHANGED');
        const now = this.now();
        const sendCredential = randomBytes(32).toString('base64url');
        const next: StoredAutomationRun = { ...run, credentialHash: hash(sendCredential), expiresAt: new Date(Math.min(now + ttlMs, Date.parse(grant.spec.expiresAt))).toISOString(), credentialRotation: (run.credentialRotation ?? 0) + 1, credentialIssuedAtMs: now };
        // 并发接管：CAS 失败说明别的调用方刚换发过，按租约处理。
        if (!await this.repo.saveEntity({ ...existing, updated_at: new Date(now).toISOString(), data: next as unknown as Record<string, unknown> }, existing.version)) throw new RunBusyError(runId, this.resumeLeaseMs);
        const context = { runId, grantId: next.grantId, taskRevision: next.taskRevision, principalId: next.principalId, expiresAt: next.expiresAt, sendCredential };
        await this.verifyOwn(context);
        return { context, run: next, resumed: true };
      }
      const { rec, grant } = await this.active(input.draftId);
      if (grant.spec.taskRevision !== input.expectedRevision) throw new AuthorizationError('TASK_REVISION_CHANGED');
      if (grant.spec.taskKind !== input.taskKind || grant.spec.taskId !== input.taskId) throw new AuthorizationError('AUTHORIZATION_REQUIRED');
      const now = this.now();
      const at = new Date(now).toISOString();
      const sendCredential = randomBytes(32).toString('base64url');
      const run: StoredAutomationRun = { runId, draftId: input.draftId, grantId: grant.grantId!, grantVersion: rec.version, taskRevision: input.expectedRevision, principalId: grant.spec.principalId,
        expiresAt: new Date(Math.min(now + ttlMs, Date.parse(grant.spec.expiresAt))).toISOString(), credentialHash: hash(sendCredential), status: 'running',
        taskKind: input.taskKind, taskId: input.taskId, occurrenceId: input.occurrenceId, startedAt: at, finishedAt: null, credentialRotation: 0, credentialIssuedAtMs: now };
      // 并发创建：只有一个成功；其余不去接管（否则会顶掉赢家刚拿到的凭证），直接返回 RUN_BUSY。
      if (!await this.repo.saveEntity({ kind: KIND, id: runId, scope: rec.scope, version: 0, created_at: at, updated_at: at, data: run as unknown as Record<string, unknown> }, 0)) throw new RunBusyError(runId, this.resumeLeaseMs);
      const context = { runId, grantId: run.grantId, taskRevision: run.taskRevision, principalId: run.principalId, expiresAt: run.expiresAt, sendCredential };
      await this.verifyOwn(context);
      return { context, run, resumed: false };
    }
  }

  /** 签发后自检：若凭证已被其他调用方换掉，按 RUN_BUSY 返回；授权失效等其他错误照常抛出。 */
  private async verifyOwn(context: RunContext): Promise<void> {
    try { await this.verify(context); } catch (err) {
      const cur = (await this.repo.getEntity(KIND, context.runId))?.data as unknown as StoredAutomationRun | undefined;
      if (cur && cur.credentialHash !== hash(context.sendCredential)) throw new RunBusyError(context.runId, this.resumeLeaseMs);
      throw err;
    }
  }

  /** 此验证不替代消息/额度/幂等提交事务内的最终检查。 */
  /** 只验证凭证本身（散列、绑定字段、运行状态、到期），不检查授权和权限的实时状态。 */
  async authenticate(context: RunContext): Promise<{ run: StoredAutomationRun; record: EntityRecord }> {
    if (!context || typeof context.runId !== 'string' || typeof context.sendCredential !== 'string' || context.sendCredential.length !== 43) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
    const record = await this.repo.getEntity(KIND, context.runId);
    if (!record) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
    const run = record.data as unknown as StoredAutomationRun;
    if (run.status !== 'running' || run.credentialHash !== hash(context.sendCredential) || run.grantId !== context.grantId || run.taskRevision !== context.taskRevision || run.principalId !== context.principalId || run.expiresAt !== context.expiresAt || Date.parse(run.expiresAt) <= this.now()) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
    return { run, record };
  }

  async verify(context: RunContext): Promise<{ run: StoredAutomationRun; grant: AuthorizationRecord; record: EntityRecord }> {
    const { run, record } = await this.authenticate(context);
    const { rec, grant } = await this.active(run.draftId);
    if (rec.version !== run.grantVersion || grant.grantId !== run.grantId) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
    return { run, grant, record };
  }

  async finish(context: RunContext): Promise<void> {
    const { run, record } = await this.authenticate(context);
    // 结束只需要凭证有效：授权被撤销后调度器仍要能把运行收尾（不会再发消息）。
    const at = new Date(this.now()).toISOString();
    if (!await this.repo.saveEntity({ ...record, updated_at: at, data: { ...run, status: 'finished', finishedAt: at } }, record.version)) throw new AuthorizationError('RUN_CREDENTIAL_INVALID');
  }
}
