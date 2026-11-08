/**
 * 自动化预授权 v2：原子投递的判定核心（纯函数）。
 * MemoryRepo 与 PgRepo 在各自的“事务”内读取同一组状态后调用 evaluateDelivery，
 * 保证两套存储的放行 / 拦截规则完全一致。本文件不读写任何存储。
 */
import type { EntityRecord, MessageRecord, NewMessage } from './repo.js';

export const DELIVERY_KIND = 'automation_delivery_v2';

export interface DeliveryLimits { perRun: number; perDay: number; perTargetPerRun: number; perTargetPerDay: number }

/** 存储层原子投递的输入。所有字段由后端服务生成，不接受客户端直传。 */
export interface AutomationDeliveryCommit {
  grantKind: string;
  draftId: string;
  grantId: string;
  runKind: string;
  runId: string;
  credentialHash: string;
  task: { kind: string; id: string; expectedRevision: string; revisionOf(data: Record<string, unknown>): string };
  /** 发往群时：执行身份必须仍是群成员（事务内重查）。发往用户时为 null。 */
  memberCheck: { chatId: string; userId: string } | null;
  deliveryKey: string;
  payloadDigest: string;
  targetKey: string;
  /** Asia/Shanghai 自然日，如 2026-10-21。 */
  dayKey: string;
  limits: DeliveryLimits;
  /** 事务前的实时权限检查已经失败时传入；事务只负责验证凭证、处理幂等并记录拦截结果。 */
  blockedCode: string | null;
  /** 放行时写入的消息；blockedCode 非空时可为 null。 */
  message: NewMessage | null;
  /** 写入投递记录的附加信息（目标、逻辑消息 ID 等），不得包含凭证。 */
  record: Record<string, unknown>;
  nowMs: number;
  /**
   * 提交时复核（B-R03-1）：存储层在拿到排他权限围栏之后、在事务自己的连接上调用，
   * 返回拦截码或 null。传入的 repo 只能用来读。不传表示不复核（只在内部测试中出现）。
   */
  recheck?: (repo: import('./repo.js').Repo) => Promise<string | null>;
}

export type AutomationDeliveryOutcome =
  | { status: 'sent'; message: MessageRecord; duplicate: boolean }
  | { status: 'blocked'; code: string }
  | { status: 'rejected'; code: 'RUN_CREDENTIAL_INVALID' | 'IDEMPOTENCY_CONFLICT' };

export interface DeliveryState {
  grant: EntityRecord | undefined;
  run: EntityRecord | undefined;
  task: EntityRecord | undefined;
  /** null = 不需要检查成员。 */
  isMember: boolean | null;
  existing: EntityRecord | undefined;
  /** 只统计 status=sent 的投递。 */
  counts: { run: number; day: number; targetRun: number; targetDay: number };
}

export type DeliveryDecision =
  | { kind: 'reject'; code: 'RUN_CREDENTIAL_INVALID' | 'IDEMPOTENCY_CONFLICT' }
  | { kind: 'duplicate'; messageId: string }
  | { kind: 'block'; code: string }
  | { kind: 'send' };

export function shanghaiDayKey(ms: number): string {
  // 中国不实行夏令时，固定 UTC+8。
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

export function evaluateDelivery(input: AutomationDeliveryCommit, s: DeliveryState): DeliveryDecision {
  // 1. 凭证与运行：任何不匹配都直接拒绝，不留下记录。
  const run = s.run?.data as Record<string, unknown> | undefined;
  if (!run || run.status !== 'running' || run.credentialHash !== input.credentialHash || run.grantId !== input.grantId || run.draftId !== input.draftId
    || typeof run.expiresAt !== 'string' || Date.parse(run.expiresAt) <= input.nowMs || run.taskRevision !== input.task.expectedRevision)
    return { kind: 'reject', code: 'RUN_CREDENTIAL_INVALID' };
  // 2. 幂等：同一逻辑消息键只能对应同一载荷；已经发出的直接返回原结果，不再发送。
  const existing = s.existing?.data as Record<string, unknown> | undefined;
  if (existing) {
    if (existing.payloadDigest !== input.payloadDigest) return { kind: 'reject', code: 'IDEMPOTENCY_CONFLICT' };
    if (existing.status === 'sent' && typeof existing.messageId === 'string') return { kind: 'duplicate', messageId: existing.messageId };
  }
  if (input.blockedCode) return { kind: 'block', code: input.blockedCode };
  // 3. 授权实时状态（与撤销在同一锁下串行）。
  const g = s.grant?.data as Record<string, unknown> | undefined;
  if (!s.grant || !g) return { kind: 'block', code: 'AUTHORIZATION_REQUIRED' };
  if (g.status === 'revoked') return { kind: 'block', code: 'GRANT_REVOKED' };
  if (g.status !== 'active' || g.grantId !== input.grantId) return { kind: 'block', code: 'AUTHORIZATION_REQUIRED' };
  if (s.grant.version !== run.grantVersion) return { kind: 'block', code: 'RUN_CREDENTIAL_INVALID' };
  const spec = g.spec as { expiresAt?: string } | undefined;
  if (!spec?.expiresAt || Date.parse(spec.expiresAt) <= input.nowMs) return { kind: 'block', code: 'GRANT_EXPIRED' };
  // 4. 任务安全版本（停用、改配置都会改变版本）。
  if (!s.task) return { kind: 'block', code: 'PRINCIPAL_INVALID' };
  let revision: string;
  try { revision = input.task.revisionOf(s.task.data); } catch { return { kind: 'block', code: 'TASK_REVISION_CHANGED' }; }
  if (revision !== input.task.expectedRevision) return { kind: 'block', code: 'TASK_REVISION_CHANGED' };
  // 5. 群成员资格。
  if (s.isMember === false) return { kind: 'block', code: 'PERMISSION_DENIED' };
  // 6. 额度：本次发送计入后不得超过任一上限。
  const l = input.limits;
  if (s.counts.run + 1 > l.perRun || s.counts.day + 1 > l.perDay || s.counts.targetRun + 1 > l.perTargetPerRun || s.counts.targetDay + 1 > l.perTargetPerDay)
    return { kind: 'block', code: 'QUOTA_EXCEEDED' };
  if (!input.message) return { kind: 'block', code: 'CONTENT_MODE_NOT_ALLOWED' };
  return { kind: 'send' };
}

/** 单条投递记录最多保留的尝试历史条数。 */
export const MAX_DELIVERY_ATTEMPTS = 50;
export interface DeliveryAttempt { runId: string; status: 'sent' | 'blocked'; code: string | null; messageId: string | null; at: string }

/** 记录里的尝试历史；旧记录没有 attempts 字段时，用它当前的结果补出一条。 */
export function deliveryAttempts(data: Record<string, unknown> | undefined, fallbackAt?: string): DeliveryAttempt[] {
  if (!data) return [];
  if (Array.isArray(data.attempts)) return data.attempts as DeliveryAttempt[];
  if (typeof data.runId !== 'string') return [];
  return [{ runId: data.runId, status: data.status === 'sent' ? 'sent' : 'blocked', code: (data.code as string | null) ?? null, messageId: (data.messageId as string | null) ?? null, at: fallbackAt ?? '' }];
}

/**
 * 投递记录的数据部分（status=sent 才计入额度）。
 * 记录按“授权 + 逻辑消息 + 目标”只有一条；每次运行的尝试追加到 attempts，
 * 这样 A 运行被拦、B 运行补发后，A 运行仍能看到自己那次被拦的结果。
 */
export function deliveryRecordData(input: AutomationDeliveryCommit, status: 'sent' | 'blocked', extra: { code?: string; messageId?: string }, existing?: EntityRecord): Record<string, unknown> {
  const at = new Date(input.nowMs).toISOString();
  // 同一运行只保留最后一次结果；不同运行不截断，避免早期运行的回执消失。
  const attempts = [...deliveryAttempts(existing?.data, existing?.updated_at).filter(a => a.runId !== input.runId), { runId: input.runId, status, code: extra.code ?? null, messageId: extra.messageId ?? null, at }];
  return {
    ...input.record,
    deliveryKey: input.deliveryKey, grantId: input.grantId, runId: input.runId, draftId: input.draftId,
    targetKey: input.targetKey, dayKey: input.dayKey, payloadDigest: input.payloadDigest,
    status, code: extra.code ?? null, messageId: extra.messageId ?? null, attempts,
  };
}

/**
 * 权限围栏（B-R03-1）。会收回文档访问权限的写操作取共享模式，投递事务取排他模式：
 * 普通写操作之间互不阻塞；投递在复核权限到提交之间，不会有收回权限的写操作插进来。
 * PostgreSQL 用同一个事务级 advisory lock 键；Memory 用下面的进程内读写锁。
 */
export const AUTOMATION_ACL_FENCE_KEY = 7_302_154_871;
/** 会影响文档访问判定的实体种类：回收站、知识库页面 / 空间、组织架构。 */
export const ACL_ENTITY_KINDS: ReadonlySet<string> = new Set(['doc_trash', 'wiki_doc', 'wiki_space', 'organization']);

export class AclFence {
  private readers = 0;
  private writer = false;
  private readonly queue: Array<{ exclusive: boolean; resolve: () => void }> = [];
  async run<T>(exclusive: boolean, fn: () => Promise<T> | T): Promise<T> {
    await this.acquire(exclusive);
    try { return await fn(); } finally { this.release(exclusive); }
  }
  private can(exclusive: boolean) { return exclusive ? !this.writer && this.readers === 0 : !this.writer; }
  private take(exclusive: boolean) { if (exclusive) this.writer = true; else this.readers++; }
  /** 能拿到时同步登记，保证登记之后到来的排他请求一定会等待。按到达顺序排队，排他请求不会饿死。 */
  private acquire(exclusive: boolean): Promise<void> {
    if (this.queue.length === 0 && this.can(exclusive)) { this.take(exclusive); return Promise.resolve(); }
    return new Promise(resolve => this.queue.push({ exclusive, resolve }));
  }
  private release(exclusive: boolean) {
    if (exclusive) this.writer = false; else this.readers--;
    while (this.queue.length && this.can(this.queue[0].exclusive)) { const n = this.queue.shift()!; this.take(n.exclusive); n.resolve(); }
  }
}
