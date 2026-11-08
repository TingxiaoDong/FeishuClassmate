/**
 * 自动化预授权 v2：投递服务。把一次“按授权发给一个固定目标”的请求变成一次存储层原子提交。
 *
 * 流程：凭证认证（失败 → 抛 RUN_CREDENTIAL_INVALID，不留记录）
 *   → 实时检查授权、任务、执行身份、目标与文档权限（失败 → 记拦截结果）
 *   → 目标 / 输出模式是否在批准范围内（越界 → 记拦截结果）
 *   → repo.commitAutomationDelivery：事务内重查 + 幂等 + 额度 + 写消息 + 写结果
 *   → 新消息提交后才推送事件。
 *
 * 消息正文完全由后端生成：一句固定说明 + cos://doc 链接 + 代发标记。不带文档标题、摘要或模型文本。
 * 本服务尚未接入 HTTP 路由、调度器或 Agent 发送出口，不构成上线开关。
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BOT_ID } from './context.js';
import { nowIso, p2pKeyOf, type ChatRecord, type MessageRecord, type NewMessage, type Repo } from './repo.js';
import { AuthorizationError, FixedTargetSchema, securityDigest, type AuthorizationPolicy, type AuthorizationRecord, type DeliveryResult, type RunContext } from './automation-authorization.js';
import { AutomationRunCredentials, RUN_KIND, hash } from './automation-run-credentials.js';
import { DELIVERY_KIND, deliveryAttempts, shanghaiDayKey, type AutomationDeliveryCommit } from './automation-delivery-core.js';

const GRANT_KIND = 'automation_authorization_v2';
const safeId = z.string().regex(/^[A-Za-z0-9_.:\-]{1,128}$/);
export const DeliveryRequestSchema = z.object({
  logicalMessageId: safeId,
  target: FixedTargetSchema,
  /** Agent 的投递用途；只记录，不影响放行规则。 */
  purpose: z.enum(['business', 'final']).optional(),
  payload: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('protected_doc_link'), docId: z.string().regex(/^[A-Za-z0-9_.:\-]{1,200}$/) }).strict(),
    z.object({ mode: z.literal('controlled_template'), templateId: safeId, templateVersion: z.number().int().positive() }).strict(),
  ]),
}).strict();

/** 任务实体与安全版本的可信来源（trigger 由 routes-automation-authorization 提供）。 */
export interface DeliveryTaskSource {
  entityKind(taskKind: 'trigger' | 'scheduler'): string;
  revisionOf(taskKind: 'trigger' | 'scheduler', taskId: string, data: Record<string, unknown>): string;
}
export interface DeliveryHooks {
  chatCreated?(chat: ChatRecord): Promise<void> | void;
  /** 只在新消息提交成功后调用（重复请求不再推送）。 */
  messageSent?(chat: ChatRecord, message: MessageRecord): Promise<void> | void;
}
export type DeliveryOutcome = DeliveryResult & { duplicate?: boolean; retryable?: boolean; message?: MessageRecord };

export class AutomationDeliveryService {
  constructor(
    private readonly repo: Repo,
    private readonly policy: AuthorizationPolicy,
    private readonly credentials: AutomationRunCredentials,
    private readonly tasks: DeliveryTaskSource,
    private readonly hooks: DeliveryHooks = {},
    private readonly now: () => number = Date.now,
    /**
     * 按给定存储构造同一套权限策略（B-R03-1 提交时复核用）。存储层在拿到排他权限围栏后、
     * 用事务自己的连接调用它，重新检查执行身份、目标、文档可读权限。不传则只做事务前检查。
     */
    private readonly policyFor?: (repo: Repo) => AuthorizationPolicy,
  ) {}

  async deliver(context: RunContext, raw: unknown): Promise<DeliveryOutcome> {
    const req = DeliveryRequestSchema.parse(raw);
    // 1. 凭证认证：失败直接抛出，不写任何记录。
    const { run } = await this.credentials.authenticate(context);
    // 2. 实时检查（授权状态、任务版本、执行身份、目标与文档权限）。
    let blockedCode: string | null = null;
    // 凭证已认证，这里再失败只能是授权 / 任务 / 权限的实时状态变了（授权版本变化记为 RUN_CREDENTIAL_INVALID）。
    // 策略抛出的非预期错误按 PERMISSION_DENIED 拦截（失败即关闭）。凭证若恰好在此期间到期，事务会先拒绝。
    try { await this.credentials.verify(context); } catch (err) {
      blockedCode = err instanceof AuthorizationError ? err.code : 'PERMISSION_DENIED';
    }
    const grantRec = await this.repo.getEntity(GRANT_KIND, run.draftId);
    const grant = grantRec?.data as unknown as AuthorizationRecord | undefined;
    if (!grant) blockedCode ??= 'AUTHORIZATION_REQUIRED';
    const spec = grant?.spec;
    // 3. 批准范围：目标必须在固定名单内，输出模式和文档必须是批准过的。
    if (spec && !blockedCode) {
      if (!spec.recipients.targets.some(t => t.type === req.target.type && t.id === req.target.id)) blockedCode = 'TARGET_OUT_OF_SCOPE';
      else if (req.payload.mode !== 'protected_doc_link' || spec.output.mode !== 'protected_doc_link' || !spec.output.docIds.includes(req.payload.docId)) blockedCode = 'CONTENT_MODE_NOT_ALLOWED';
    }
    // 4. 解析目标会话、生成正文（只在前面都通过时）。
    let chat: ChatRecord | undefined;
    let chatCreated = false;
    let message: NewMessage | null = null;
    const deliveryKey = `${run.grantId}|${req.logicalMessageId}|${req.target.type}|${req.target.id}`;
    if (!blockedCode && req.payload.mode === 'protected_doc_link') {
      ({ chat, created: chatCreated } = await this.resolveChat(req.target));
      const principal = await this.repo.getUser(run.principalId);
      if (!chat) blockedCode = 'PERMISSION_DENIED';
      else if (!principal || principal.disabled) blockedCode = 'PRINCIPAL_INVALID';
      else message = {
        message_id: `msg_${randomUUID().replace(/-/g, '')}`,
        chat_id: chat.chat_id, sender_id: BOT_ID, msg_type: 'text',
        content: {
          text: `${principal.name} 设置的自动化任务分享了一篇文档（需要有查看权限才能打开）。`,
          agent_result: { links: [{ link: `cos://doc/${req.payload.docId}`, kind: 'doc', id: req.payload.docId }] },
          sent_on_behalf_of: { user_id: principal.user_id, name: principal.name },
          automation: { run_id: run.runId, grant_id: run.grantId, logical_message_id: req.logicalMessageId },
        },
        created_at: nowIso(), reply_to_message_id: null,
        client_msg_id: `auto_${createHash('sha256').update(deliveryKey).digest('hex').slice(0, 48)}`,
        card_id: null,
      };
    }
    const limits = spec?.limits ?? { perRun: 0, perDay: 0, perTargetPerRun: 0, perTargetPerDay: 0 };
    const nowMs = this.now();
    const input: AutomationDeliveryCommit = {
      grantKind: GRANT_KIND, draftId: run.draftId, grantId: run.grantId,
      runKind: RUN_KIND, runId: run.runId, credentialHash: hash(context.sendCredential),
      task: {
        kind: this.tasks.entityKind(spec?.taskKind ?? 'trigger'), id: spec?.taskId ?? '',
        expectedRevision: run.taskRevision,
        revisionOf: (data) => this.tasks.revisionOf(spec!.taskKind, spec!.taskId, data),
      },
      memberCheck: chat && req.target.type === 'chat' ? { chatId: chat.chat_id, userId: run.principalId } : null,
      deliveryKey, payloadDigest: securityDigest(req.payload), targetKey: `${req.target.type}:${req.target.id}`,
      dayKey: shanghaiDayKey(nowMs), limits: { perRun: limits.perRun, perDay: limits.perDay, perTargetPerRun: limits.perTargetPerRun, perTargetPerDay: limits.perTargetPerDay },
      blockedCode, message,
      recheck: spec && !blockedCode && this.policyFor ? async (txRepo) => {
        const p = this.policyFor!(txRepo);
        try {
          const task = await p.loadTask(spec.taskKind, spec.taskId);
          if (!task) return 'PRINCIPAL_INVALID';
          await p.assertCanApprove(task.ownerId, task, spec);
          if (req.target.type === 'user') {
            const u = await txRepo.getUser(req.target.id);
            if (!u || u.disabled || u.role === 'bot') return 'PERMISSION_DENIED';
          }
          const principal = await txRepo.getUser(run.principalId);
          if (!principal || principal.disabled || principal.role === 'bot') return 'PRINCIPAL_INVALID';
          return null;
        } catch (err) { return err instanceof AuthorizationError ? err.code : 'PERMISSION_DENIED'; }
      } : undefined,
      record: { logicalMessageId: req.logicalMessageId, target: req.target, payloadMode: req.payload.mode, purpose: req.purpose ?? 'final', ...(req.payload.mode === 'protected_doc_link' ? { docId: req.payload.docId } : {}) },
      nowMs,
    };
    const base = { logicalMessageId: req.logicalMessageId, target: req.target };
    let outcome;
    try { outcome = await this.repo.commitAutomationDelivery(input); }
    // 结果未知（提交失败或连接中断）：用同一逻辑消息键重放是安全的（幂等）。
    catch { return { ...base, status: 'failed', retryable: true }; }
    if (outcome.status === 'rejected') throw new AuthorizationError(outcome.code);
    if (outcome.status === 'blocked') return { ...base, status: 'blocked', code: outcome.code as DeliveryResult['code'], retryable: false };
    // B-R03-2：新建的机器人单聊等消息真的发出后才推送，被拦时不推送空会话。
    if (chatCreated && chat) await this.hooks.chatCreated?.(chat);
    if (!outcome.duplicate && chat) await this.hooks.messageSent?.(chat, outcome.message);
    return { ...base, status: 'sent', messageId: outcome.message.message_id, duplicate: outcome.duplicate, retryable: false, message: outcome.message };
  }

  /** 某个授权下的全部投递结果（不含凭证）。调用方负责查询权限。 */
  async listDeliveries(grantId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.repo.listEntities(DELIVERY_KIND, grantId)).map(e => ({ ...e.data, updatedAt: e.updated_at }));
  }

  /** 某次运行的投递结果（不含凭证）。 */
  async listRunDeliveries(grantId: string, runId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.listDeliveries(grantId)).filter(d => deliveryAttempts(d).some(a => a.runId === runId));
  }

  private async resolveChat(target: { type: 'chat' | 'user'; id: string }): Promise<{ chat: ChatRecord | undefined; created: boolean }> {
    if (target.type === 'chat') {
      const chat = await this.repo.getChat(target.id);
      return { chat: chat && chat.chat_type === 'group' ? chat : undefined, created: false };
    }
    const user = await this.repo.getUser(target.id);
    if (!user || user.disabled || user.role === 'bot') return { chat: undefined, created: false };
    const now = nowIso();
    const res = await this.repo.createChat({
      chat_id: `chat_${randomUUID().replace(/-/g, '')}`, chat_type: 'p2p', name: null, description: null, owner_id: null, kind: 'normal',
      p2p_key: p2pKeyOf(BOT_ID, target.id), member_ids: [BOT_ID, target.id], created_at: now, updated_at: now,
    });
    return { chat: res.chat, created: res.created };
  }
}
