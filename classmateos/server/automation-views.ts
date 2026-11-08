/**
 * 自动化预授权 v2：用户接口与调度器接口共用的错误码映射、运行视图、授权查找。
 * 所有视图都不包含发送凭证或其散列。
 */
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { fail, invalid, type Ctx } from './context.js';
import { AuthorizationError, aggregateRunStatus, type AuthorizationCode, type AuthorizationRecord, type DeliveryResult } from './automation-authorization.js';
import type { StoredAutomationRun } from './automation-run-credentials.js';
import { DELIVERY_KIND, deliveryAttempts } from './automation-delivery-core.js';
import type { EntityRecord } from './repo.js';

export const GRANT_KIND = 'automation_authorization_v2';
export const RUN_KIND = 'automation_run_v2';
export const PROTOCOL_VERSION = '2026-10-21.1';
export const CREDENTIAL_HEADER = 'x-automation-run-credential';
export const SCHEDULER_HEADER = 'x-automation-scheduler-token';

/** 冻结的错误码 → HTTP 状态与稳定中文提示。 */
export const AUTOMATION_ERRORS: Record<AuthorizationCode, { status: number; message: string }> = {
  AUTHORIZATION_REQUIRED: { status: 403, message: '这个自动化还没有获得发送授权' },
  GRANT_EXPIRED: { status: 403, message: '授权已过期，需要重新授权' },
  GRANT_REVOKED: { status: 403, message: '授权已撤销' },
  TASK_REVISION_CHANGED: { status: 409, message: '任务设置已变化，需要重新审批' },
  DRAFT_STALE: { status: 409, message: '授权内容已变化或已处理，请刷新后重试' },
  PRINCIPAL_INVALID: { status: 403, message: '执行身份已失效' },
  PERMISSION_DENIED: { status: 403, message: '没有权限执行此操作' },
  TARGET_OUT_OF_SCOPE: { status: 403, message: '发送对象不在授权范围内' },
  CONTENT_MODE_NOT_ALLOWED: { status: 403, message: '发送内容不在授权范围内' },
  QUOTA_EXCEEDED: { status: 429, message: '已达到授权的发送额度' },
  RUN_CREDENTIAL_INVALID: { status: 401, message: '运行凭证或触发证据无效' },
  TASK_DISABLED: { status: 403, message: '任务已停用' },
  UNSUPPORTED_CAPABILITY: { status: 422, message: '暂不支持这项自动化能力' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: '同一条消息的内容与之前不一致' },
};

export function sendAutomationError(reply: FastifyReply, code: AuthorizationCode) {
  const e = AUTOMATION_ERRORS[code];
  return fail(reply, e.status, e.message, { code });
}

/** 统一错误处理：Zod → 422 VALIDATION_FAILED；AuthorizationError → 冻结映射；其他错误交给 Fastify（500）。 */
export function handleAutomationError(err: unknown, reply: FastifyReply) {
  if (err instanceof z.ZodError) return invalid(reply, err.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
  if (err instanceof AuthorizationError) return sendAutomationError(reply, err.code);
  throw err;
}

export function effectiveStatus(d: AuthorizationRecord, nowMs = Date.now()): 'pending' | 'active' | 'revoked' | 'expired' | 'draft_expired' {
  if (d.status === 'active' && Date.parse(d.spec.expiresAt) <= nowMs) return 'expired';
  if (d.status === 'pending' && Date.parse(d.draftExpiresAt) <= nowMs) return 'draft_expired';
  return d.status;
}

/** 某个任务当前可用的授权：已批准、未到期、批准的版本与任务当前版本一致；多个时取最近批准的。 */
export async function findActiveGrant(ctx: Ctx, ownerId: string, taskKind: string, taskId: string, currentRevision: string, nowMs = Date.now()): Promise<EntityRecord | undefined> {
  return (await ctx.repo.listEntities(GRANT_KIND, ownerId))
    .filter(r => {
      const d = r.data as unknown as AuthorizationRecord;
      return d.spec.taskKind === taskKind && d.spec.taskId === taskId && d.status === 'active' && Date.parse(d.spec.expiresAt) > nowMs && d.spec.taskRevision === currentRevision;
    })
    .sort((a, b) => String((b.data as unknown as AuthorizationRecord).approvedAt).localeCompare(String((a.data as unknown as AuthorizationRecord).approvedAt)))[0];
}

export async function targetDisplay(ctx: Ctx, t: { type: 'chat' | 'user'; id: string }) {
  if (t.type === 'chat') {
    const chat = await ctx.repo.getChat(t.id);
    return { type: t.type, id: t.id, exists: !!chat, displayName: chat?.name ?? null, chatType: chat?.chat_type ?? null, memberCount: chat?.member_ids.length ?? null };
  }
  const u = await ctx.repo.getUser(t.id);
  return { type: t.type, id: t.id, exists: !!u, displayName: u?.name ?? null, department: u?.department ?? null, title: u?.title ?? null, active: !!u && !u.disabled };
}

/** 一次运行的视图：每个目标的投递结果 + 聚合状态。不含凭证 / 凭证散列。 */
export async function runView(ctx: Ctx, rec: EntityRecord, cache = new Map<string, EntityRecord[]>()) {
  const run = rec.data as unknown as StoredAutomationRun;
  let rows = cache.get(run.grantId);
  if (!rows) { rows = await ctx.repo.listEntities(DELIVERY_KIND, run.grantId); cache.set(run.grantId, rows); }
  const names = new Map<string, string | null>();
  const deliveries = [];
  for (const r of rows) {
    const d = r.data as Record<string, unknown> & { target: { type: 'chat' | 'user'; id: string } };
    // 每次运行只看自己的那次尝试（B-R03-4）：同一逻辑消息在别的运行里补发成功，不会把本运行显示成已发出。
    const attempts = deliveryAttempts(d, r.updated_at);
    const mine = attempts.filter(a => a.runId === run.runId).at(-1);
    if (!mine) continue;
    const latest = attempts.at(-1)!;
    const key = `${d.target.type}:${d.target.id}`;
    if (!names.has(key)) names.set(key, (await targetDisplay(ctx, d.target)).displayName);
    deliveries.push({
      logicalMessageId: d.logicalMessageId as string, target: { ...d.target, displayName: names.get(key) ?? null },
      purpose: (d.purpose as string | undefined) ?? 'final', status: mine.status,
      code: mine.code, messageId: mine.messageId,
      docId: (d.docId as string | undefined) ?? null, retryable: false, updatedAt: mine.at || r.updated_at,
      /** 这条逻辑消息后来在其他运行里有新的结果时给出（只读参考，不改变本运行的状态）。 */
      laterAttempt: latest.runId !== run.runId ? { runId: latest.runId, status: latest.status, code: latest.code, messageId: latest.messageId, at: latest.at } : null,
    });
  }
  deliveries.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const status = aggregateRunStatus(deliveries.map(d => ({ ...d, code: (d.code ?? undefined) as AuthorizationCode | undefined, messageId: d.messageId ?? undefined }) as DeliveryResult), run.status === 'finished');
  return {
    runId: run.runId, grantId: run.grantId, draftId: run.draftId, taskKind: run.taskKind ?? null, taskId: run.taskId ?? null,
    taskRevision: run.taskRevision, principalId: run.principalId, occurrenceId: run.occurrenceId ?? null,
    startedAt: run.startedAt ?? rec.created_at, finishedAt: run.finishedAt ?? (run.status === 'finished' ? rec.updated_at : null),
    status, documentCreated: false, documentIds: [] as string[], deliveries,
  };
}

/** 游标分页（按 created_at、id 倒序）。游标是最后一条的 id。 */
export function paginate<T extends { id: string; created_at: string }>(rows: T[], pageSize: number, pageToken?: string): { items: T[]; total: number; page_token: string | null } | 'bad_cursor' {
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const cursor = pageToken ? Buffer.from(pageToken, 'base64url').toString('utf8') : undefined;
  const at = cursor ? sorted.findIndex(r => r.id === cursor) : -1;
  if (cursor && at < 0) return 'bad_cursor';
  const items = sorted.slice(at + 1, at + 1 + pageSize);
  return { items, total: sorted.length, page_token: at + 1 + items.length < sorted.length ? Buffer.from(items.at(-1)!.id).toString('base64url') : null };
}
export const PageQuery = { page_size: z.coerce.number().int().min(1).max(100).default(50), page_token: z.string().max(1000).optional() };
