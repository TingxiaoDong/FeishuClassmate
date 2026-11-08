/** 自动化预授权 v2：共享契约与存储核心。尚未接入路由/发送，不构成上线开关。 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Repo, EntityRecord } from './repo.js';

const id = z.string().trim().min(1).max(200);
const ids = z.array(id).max(100);
export const FixedTargetSchema = z.object({ type: z.enum(['chat', 'user']), id }).strict();
export const ResourceScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('doc'), resourceId: id }).strict(),
  z.object({ type: z.literal('table'), resourceId: id, recordIds: ids.min(1), fields: ids.min(1) }).strict(),
]);
export const RecipientRuleSchema = z.object({ kind: z.literal('fixed'), targets: z.array(FixedTargetSchema).min(1).max(100) }).strict().superRefine((v, ctx) => {
  const keys = v.targets.map(t => JSON.stringify([t.type, t.id]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: '目标不能重复' });
});
export const AuthorizationSpecSchema = z.object({
  taskKind: z.enum(['trigger', 'scheduler']), taskId: id,
  taskRevision: z.string().regex(/^[a-f0-9]{64}$/), principalId: id,
  recipients: RecipientRuleSchema,
  resources: z.array(ResourceScopeSchema).max(100),
  output: z.discriminatedUnion('mode', [
    // 模板仅使用后端登记模板与后端读取的数据，不接收模型生成的正文或字段值。
    z.object({ mode: z.literal('controlled_template'), templateId: id, templateVersion: z.number().int().positive() }).strict(),
    z.object({ mode: z.literal('protected_doc_link'), docIds: ids.min(1) }).strict(),
  ]),
  limits: z.object({
    perRun: z.number().int().min(1).max(1000), perDay: z.number().int().min(1).max(10000),
    perTargetPerRun: z.number().int().min(1).max(1000), perTargetPerDay: z.number().int().min(1).max(10000),
    timezone: z.literal('Asia/Shanghai'),
  }).strict(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((v, ctx) => {
  if (v.limits.perRun > v.limits.perDay || v.limits.perTargetPerRun > v.limits.perRun || v.limits.perTargetPerDay > v.limits.perDay || v.limits.perTargetPerRun > v.limits.perTargetPerDay)
    ctx.addIssue({ code: 'custom', message: '额度上下限不一致' });
  if (v.output.mode === 'protected_doc_link' && v.output.docIds.some(d => !v.resources.some(r => r.type === 'doc' && r.resourceId === d)))
    ctx.addIssue({ code: 'custom', message: '链接文档必须属于批准的资料范围' });
});
export type AuthorizationSpec = z.infer<typeof AuthorizationSpecSchema>;
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;
export type RecipientRule = z.infer<typeof RecipientRuleSchema>;
export type AuthorizationCode = 'AUTHORIZATION_REQUIRED' | 'GRANT_EXPIRED' | 'GRANT_REVOKED' | 'TASK_REVISION_CHANGED' | 'PRINCIPAL_INVALID' | 'PERMISSION_DENIED' | 'TARGET_OUT_OF_SCOPE' | 'CONTENT_MODE_NOT_ALLOWED' | 'QUOTA_EXCEEDED' | 'RUN_CREDENTIAL_INVALID' | 'DRAFT_STALE' | 'TASK_DISABLED' | 'UNSUPPORTED_CAPABILITY' | 'IDEMPOTENCY_CONFLICT';
export class AuthorizationError extends Error {
  constructor(public readonly code: AuthorizationCode) { super(code); }
}

/** 仅对 JSON 值使用；对象键稳定排序，数组保留语义顺序。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  throw new TypeError('安全摘要只接受合法 JSON');
}
export function securityDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
/** 安全配置必须由可信任务适配器完整提供，不能直接使用模型提供的 taskRevision。 */
export interface TaskSnapshot { taskKind: 'trigger' | 'scheduler'; taskId: string; ownerId: string; principalId: string; enabled: boolean; securityConfig: Record<string, unknown> }
export function taskRevision(task: TaskSnapshot): string {
  return securityDigest({ taskKind: task.taskKind, taskId: task.taskId, ownerId: task.ownerId, principalId: task.principalId, enabled: task.enabled, securityConfig: task.securityConfig });
}
/** 任务“启用状态下”的安全版本。已启用任务与 taskRevision 相同；停用任务用于“审批并启用”。 */
export function enabledRevision(task: TaskSnapshot): string { return taskRevision({ ...task, enabled: true }); }
export interface ApprovalActor { userId: string; authentication: 'user' | 'bot' | 'delegated' }
export interface AuthorizationPolicy {
  /** 必须实时读取任务、身份；不得采信请求提供的 owner/principal/version。 */
  loadTask(kind: 'trigger' | 'scheduler', taskId: string): Promise<TaskSnapshot | undefined>;
  /** 必须检查真实登录用户、任务管理资格、执行身份、目标、资料、模板和链接权限。失败须抛错。 */
  assertCanApprove(actorId: string, task: TaskSnapshot, spec: AuthorizationSpec): Promise<void>;
  assertCanRevoke(actorId: string, task: TaskSnapshot, spec: AuthorizationSpec): Promise<void>;
}
export interface AuthorizationRecord {
  draftId: string; draftDigest: string; draftExpiresAt: string; spec: AuthorizationSpec;
  status: 'pending' | 'active' | 'revoked'; grantId: string | null;
  scope: 'bot.messages.send'; approvedBy: string | null; approvedAt: string | null; revokedAt: string | null;
}
const KIND = 'automation_authorization_v2';
export class AutomationAuthorizationStore {
  constructor(private readonly repo: Pick<Repo, 'getEntity' | 'saveEntity'>, private readonly policy: AuthorizationPolicy, private readonly now: () => number = Date.now) {}
  private user(actor: ApprovalActor): void {
    if (actor.authentication !== 'user' || !actor.userId) throw new AuthorizationError('PERMISSION_DENIED');
  }
  /**
   * allowDisabled：停用的任务按“启用后”的快照比较版本（enabledRevision）。只有能原子启用同一安全修订的
   * 调用方（审批并启用路由）才可以传 true；普通 PATCH 启用会生成新修订，旧草稿 / 授权随之失效。
   */
  private async task(spec: AuthorizationSpec, allowDisabled = false): Promise<TaskSnapshot> {
    const t = await this.policy.loadTask(spec.taskKind, spec.taskId);
    if (!t || t.principalId !== spec.principalId) throw new AuthorizationError('PRINCIPAL_INVALID');
    if (!t.enabled && !allowDisabled) throw new AuthorizationError('TASK_DISABLED');
    if (enabledRevision(t) !== spec.taskRevision) throw new AuthorizationError('TASK_REVISION_CHANGED');
    return t;
  }
  /** 调用者权限必须由路由鉴权；此内部方法不向客户端暴露，不创建有效授权。 */
  async createDraft(input: unknown, opts: { allowDisabled?: boolean } = {}): Promise<EntityRecord> {
    const spec = AuthorizationSpecSchema.parse(input);
    const task = await this.task(spec, opts.allowDisabled);
    const now = this.now();
    if (Date.parse(spec.expiresAt) <= now) throw new AuthorizationError('GRANT_EXPIRED');
    const draftId = `agd_${randomUUID()}`;
    const data: AuthorizationRecord = { draftId, draftDigest: securityDigest(spec), draftExpiresAt: new Date(Math.min(now + 30 * 60_000, Date.parse(spec.expiresAt))).toISOString(), spec, status: 'pending', grantId: null, scope: 'bot.messages.send', approvedBy: null, approvedAt: null, revokedAt: null };
    const at = new Date(now).toISOString();
    const rec: EntityRecord = { kind: KIND, id: draftId, scope: task.ownerId, version: 0, created_at: at, updated_at: at, data: data as unknown as Record<string, unknown> };
    if (!await this.repo.saveEntity(rec, 0)) throw new AuthorizationError('DRAFT_STALE');
    return { ...rec, version: 1 };
  }
  async approve(actor: ApprovalActor, draftId: string, expectedVersion: number, expectedDigest: string, opts: { allowDisabled?: boolean } = {}): Promise<AuthorizationRecord> {
    this.user(actor);
    const rec = await this.repo.getEntity(KIND, draftId);
    if (!rec || rec.version !== expectedVersion) throw new AuthorizationError('DRAFT_STALE');
    const d = rec.data as unknown as AuthorizationRecord;
    if (d.status !== 'pending' || d.draftDigest !== expectedDigest || securityDigest(d.spec) !== expectedDigest || Date.parse(d.draftExpiresAt) <= this.now()) throw new AuthorizationError('DRAFT_STALE');
    const task = await this.task(d.spec, opts.allowDisabled);
    await this.policy.assertCanApprove(actor.userId, task, d.spec);
    // 再核对任务，减少资格校验期间发生变更的窗口。投递仍必须事务内重新检查。
    await this.task(d.spec, opts.allowDisabled);
    const now = this.now();
    if (Date.parse(d.spec.expiresAt) <= now || Date.parse(d.draftExpiresAt) <= now) throw new AuthorizationError('GRANT_EXPIRED');
    const next: AuthorizationRecord = { ...d, status: 'active', grantId: `agr_${randomUUID()}`, approvedBy: actor.userId, approvedAt: new Date(now).toISOString() };
    if (!await this.repo.saveEntity({ ...rec, data: next as unknown as Record<string, unknown>, updated_at: next.approvedAt! }, expectedVersion)) throw new AuthorizationError('DRAFT_STALE');
    return next;
  }
  async revoke(actor: ApprovalActor, draftId: string, expectedVersion: number): Promise<AuthorizationRecord> {
    this.user(actor);
    const rec = await this.repo.getEntity(KIND, draftId);
    if (!rec || rec.version !== expectedVersion) throw new AuthorizationError('DRAFT_STALE');
    const d = rec.data as unknown as AuthorizationRecord;
    const task = await this.policy.loadTask(d.spec.taskKind, d.spec.taskId);
    // 删除任务后的授权应由生命周期清理事务撤销，不能跳过权限检查。
    if (!task) throw new AuthorizationError('PERMISSION_DENIED');
    await this.policy.assertCanRevoke(actor.userId, task, d.spec);
    const next: AuthorizationRecord = { ...d, status: 'revoked', revokedAt: new Date(this.now()).toISOString() };
    if (!await this.repo.saveEntity({ ...rec, data: next as unknown as Record<string, unknown>, updated_at: next.revokedAt! }, expectedVersion)) throw new AuthorizationError('DRAFT_STALE');
    return next;
  }
}

export interface RunContext { runId: string; grantId: string; taskRevision: string; principalId: string; expiresAt: string; sendCredential: string }
export interface DeliveryRequest { logicalMessageId: string; target: z.infer<typeof FixedTargetSchema>; payload: { mode: 'controlled_template'; templateId: string; templateVersion: number } | { mode: 'protected_doc_link'; docId: string } }
export interface DeliveryResult { logicalMessageId: string; target: z.infer<typeof FixedTargetSchema>; status: 'sent' | 'blocked' | 'failed'; code?: AuthorizationCode; messageId?: string }
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'blocked' | 'failed';
export function aggregateRunStatus(results: DeliveryResult[], finished: boolean): RunStatus {
  if (!finished) return 'running';
  if (!results.length) return 'blocked';
  if (results.every(r => r.status === 'sent')) return 'succeeded';
  if (results.some(r => r.status === 'sent')) return 'partial';
  return results.some(r => r.status === 'failed') ? 'failed' : 'blocked';
}
