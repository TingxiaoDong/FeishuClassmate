import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BOT_ID, fail, type Ctx } from './context.js';
import type { Repo } from './repo.js';
import { AutomationRunCredentials } from './automation-run-credentials.js';
import { AutomationDeliveryService, type DeliveryTaskSource } from './automation-delivery.js';
import { docAccess } from './doc-access.js';
import type { TriggerData } from './routes-automation.js';
import { headerStr } from './agent-principal.js';
import { AutomationAuthorizationStore, AuthorizationError, AuthorizationSpecSchema, enabledRevision, taskRevision, type AuthorizationPolicy, type AuthorizationRecord, type TaskSnapshot } from './automation-authorization.js';
import { registerAutomationSchedulerRoutes } from './routes-automation-scheduler.js';
import { PROTOCOL_VERSION, RUN_KIND, PageQuery, effectiveStatus, handleAutomationError, paginate, runView, sendAutomationError, targetDisplay } from './automation-views.js';

const KIND = 'automation_authorization_v2';
const DraftInput = z.object(AuthorizationSpecSchema.shape).omit({ taskRevision: true, principalId: true }).strict();
const ApprovalInput = z.object({ expectedVersion: z.number().int().positive(), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/), enableTask: z.boolean().optional() }).strict();
const RevokeInput = z.object({ expectedVersion: z.number().int().positive() }).strict();

/** 触发器的安全快照。审批与投递事务共用同一个函数，保证两边算出的任务版本一致。 */
export function triggerSnapshot(id: string, data: Record<string, unknown>): TaskSnapshot {
  const d = data as unknown as TriggerData;
  // 明确列出安全字段；显示名/执行统计不参与。停用状态参与版本，发送时仍须实时检查。
  return { taskKind: 'trigger', taskId: id, ownerId: d.owner_id, principalId: d.owner_id, enabled: d.enabled,
    securityConfig: { securityRevision: d.security_revision ?? 'legacy', prompt: d.prompt, condition: d.condition, event: d.event, filter: d.filter, cron: d.cron, cooldownSec: d.cooldown_sec, resultChatId: d.chat_id } };
}

/** 投递服务用的任务来源：只支持 trigger；scheduler 适配器未实现，明确拒绝。 */
export const triggerDeliveryTaskSource: DeliveryTaskSource = {
  entityKind(kind) {
    if (kind !== 'trigger') throw new AuthorizationError('UNSUPPORTED_CAPABILITY');
    return 'agent_trigger';
  },
  revisionOf(kind, id, data) {
    if (kind !== 'trigger') throw new AuthorizationError('UNSUPPORTED_CAPABILITY');
    return taskRevision(triggerSnapshot(id, data));
  },
};

export interface AutomationServices { credentials: AutomationRunCredentials; delivery: AutomationDeliveryService }
declare module 'fastify' {
  interface FastifyInstance {
    /** 自动化预授权 v2 内部服务。只给后续经过独立鉴权的调度器入口使用，不得直接暴露给 bot 或模型。 */
    automationServices: AutomationServices;
  }
}

export interface AutomationRouteOptions {
  /** 已通过 usableSchedulerToken 校验的调度器密钥；未配置时调度器接口返回 503，投递能力报告关闭。 */
  schedulerToken?: string;
  resumeLeaseMs?: number;
}

/** 用给定存储构造权限策略。投递提交时复核会传入绑定到事务的存储，其余场景传 ctx。 */
export function automationPolicy(ctx: Ctx): AuthorizationPolicy {
  return {
    async loadTask(kind, id) {
      if (kind !== 'trigger') throw new AuthorizationError('UNSUPPORTED_CAPABILITY');
      const rec = await ctx.repo.getEntity('agent_trigger', id);
      return rec ? triggerSnapshot(id, rec.data) : undefined;
    },
    async assertCanApprove(actorId, task, spec) {
      const actor = await ctx.repo.getUser(actorId);
      const principal = await ctx.repo.getUser(task.principalId);
      if (!actor || actor.disabled || actor.role === 'bot' || actorId !== task.ownerId) throw new AuthorizationError('PERMISSION_DENIED');
      if (!principal || principal.disabled || principal.role === 'bot') throw new AuthorizationError('PRINCIPAL_INVALID');
      // 服务账号管理员授权、表格摘要和模板等待专门适配器，不做宽松回退。
      if (spec.output.mode !== 'protected_doc_link' || spec.resources.some(r => r.type !== 'doc')) throw new AuthorizationError('UNSUPPORTED_CAPABILITY');
      for (const target of spec.recipients.targets) {
        if (target.type === 'chat') {
          const chat = await ctx.repo.getChat(target.id);
          if (!chat || chat.chat_type !== 'group' || !chat.member_ids.includes(task.principalId)) throw new AuthorizationError('PERMISSION_DENIED');
        } else {
          const user = await ctx.repo.getUser(target.id);
          if (!user || user.disabled || user.role === 'bot') throw new AuthorizationError('PERMISSION_DENIED');
        }
      }
      for (const resource of spec.resources) {
        const doc = await ctx.repo.getDoc(resource.resourceId);
        if (!doc || !(await docAccess(ctx, doc, task.principalId)).permissions.can_view) throw new AuthorizationError('PERMISSION_DENIED');
      }
      const resultChatId = task.securityConfig.resultChatId;
      if (resultChatId && !spec.recipients.targets.some(t => t.type === 'chat' && t.id === resultChatId)) throw new AuthorizationError('TARGET_OUT_OF_SCOPE');
    },
    async assertCanRevoke(actorId, task) {
      const actor = await ctx.repo.getUser(actorId);
      if (!actor || actor.disabled || actor.role === 'bot' || actorId !== task.ownerId) throw new AuthorizationError('PERMISSION_DENIED');
    },
  };
}

/** ctx 的一个视图：只把 repo 换成指定存储，其他成员沿用原 ctx。 */
function withRepo(ctx: Ctx, repo: Repo): Ctx {
  return Object.create(ctx, { repo: { value: repo, enumerable: true } }) as Ctx;
}

export function registerAutomationAuthorizationRoutes(ctx: Ctx, opts: AutomationRouteOptions = {}): void {
  const deliveryOpen = !!opts.schedulerToken;
  const policy = automationPolicy(ctx);
  const store = new AutomationAuthorizationStore(ctx.repo, policy);
  // 装配运行凭证与原子投递服务。没有注册任何 HTTP 入口：签发凭证需要独立调度器鉴权（待与 Agent 确认）。
  const credentials = new AutomationRunCredentials(ctx.repo, policy);
  if (opts.resumeLeaseMs !== undefined) credentials.resumeLeaseMs = opts.resumeLeaseMs;
  const delivery = new AutomationDeliveryService(ctx.repo, policy, credentials, triggerDeliveryTaskSource, {
    chatCreated: (chat) => ctx.publish('chat.created', { chat: ctx.chatBaseJson(chat) }, chat.member_ids),
    async messageSent(chat, msg) {
      if (chat.member_ids.includes(BOT_ID)) await ctx.repo.markRead(chat.chat_id, BOT_ID, msg.message_id);
      await ctx.publishMessage('message.receive', msg, chat.member_ids);
    },
  }, Date.now, (repo) => automationPolicy(withRepo(ctx, repo)));
  ctx.app.decorate('automationServices', { credentials, delivery });
  const handleError = handleAutomationError;
  registerAutomationSchedulerRoutes(ctx, { schedulerToken: opts.schedulerToken, policy, credentials, delivery });
  /** 授权当前是否真的会被投递：有效授权 + 任务启用且版本一致 + 调度器已配置 + 定时触发器。 */
  const deliveryEnabled = async (d: AuthorizationRecord) => {
    if (!deliveryOpen || effectiveStatus(d) !== 'active' || d.spec.taskKind !== 'trigger') return false;
    const rec = await ctx.repo.getEntity('agent_trigger', d.spec.taskId);
    if (!rec) return false;
    const t = rec.data as unknown as TriggerData;
    return t.enabled && t.event === 'schedule' && taskRevision(triggerSnapshot(rec.id, rec.data)) === d.spec.taskRevision;
  };
  /**
   * 审批并启用：只把“停用、且安全修订与授权批准的版本一致”的触发器改成启用，不生成新修订。
   * 用实体 CAS；期间任务被改过（版本或修订变化）就返回 false。
   */
  const activateTrigger = async (spec: AuthorizationRecord['spec']): Promise<boolean> => {
    const rec = await ctx.repo.getEntity('agent_trigger', spec.taskId);
    if (!rec) return false;
    const t = rec.data as unknown as TriggerData;
    if (t.enabled) return taskRevision(triggerSnapshot(rec.id, rec.data)) === spec.taskRevision;
    if (enabledRevision(triggerSnapshot(rec.id, rec.data)) !== spec.taskRevision) return false;
    const ok = await ctx.repo.saveEntity({ ...rec, updated_at: new Date().toISOString(), data: { ...rec.data, enabled: true, updated_at: new Date().toISOString() } }, rec.version);
    if (ok) ctx.publish('trigger.changed', { trigger_id: rec.id }, []);
    return ok;
  };
  const realUser = async (req: FastifyRequest, reply: FastifyReply) => {
    if (ctx.isBot(req) || headerStr(req, 'x-on-behalf-of')) { fail(reply, 403, '此操作必须由真实登录用户完成', { code: 'PERMISSION_DENIED' }); return; }
    return ctx.requireUser(req, reply);
  };
  const visible = async (req: FastifyRequest, reply: FastifyReply, id: string, real: boolean) => {
    const me = real ? await realUser(req, reply) : await ctx.requireUser(req, reply);
    if (!me) return;
    const rec = await ctx.repo.getEntity(KIND, id);
    if (!rec || rec.scope !== me.sub) { fail(reply, 404, '授权不存在', { code: 'NOT_FOUND' }); return; }
    return { me, rec };
  };

  ctx.app.get('/api/v1/automation/capabilities', async (req, reply) => {
    if (!await ctx.requireUser(req, reply)) return;
    return {
      protocolVersion: PROTOCOL_VERSION,
      drafts: true, draftDetail: true, approval: true, approveEnablesTask: true, runQuery: true,
      // 调度器密钥配置后才开放；只支持定时触发器 + 固定目标 + 文档链接。
      fixedTargetDelivery: deliveryOpen, atomicDelivery: true, durableResume: deliveryOpen,
      taskKinds: { trigger: { schedule: deliveryOpen, events: false }, scheduler: false },
      scheduler: false, protectedDocLinkDraft: true, protectedDocLink: deliveryOpen, controlledTemplate: false,
      restrictedRead: false, businessOperations: false, aiText: false, dynamicRecipients: false,
      draftEditing: false, migration: false, serviceAccounts: false,
    };
  });
  ctx.app.post('/api/v1/automation/drafts', async (req, reply) => {
    const me = await ctx.requireUser(req, reply); if (!me) return;
    try {
      const input = DraftInput.parse(req.body);
      const task = await policy.loadTask(input.taskKind, input.taskId);
      if (!task || task.ownerId !== me.sub) return fail(reply, 404, '任务不存在', { code: 'NOT_FOUND' });
      // 停用的任务也可以建草稿：版本按“启用后”计算，批准时须 enableTask=true 才会原子启用同一修订。
      const spec = AuthorizationSpecSchema.parse({ ...input, principalId: task.principalId, taskRevision: enabledRevision(task) });
      await policy.assertCanApprove(me.sub, task, spec);
      const rec = await store.createDraft(spec, { allowDisabled: true });
      return reply.code(201).send({ ...rec.data, version: rec.version });
    } catch (err) { return handleError(err, reply); }
  });
  ctx.app.post('/api/v1/automation/drafts/:draftId/approve', async (req, reply) => {
    const { draftId } = req.params as { draftId: string };
    const got = await visible(req, reply, draftId, true); if (!got) return;
    try {
      const body = ApprovalInput.parse(req.body);
      const spec = (got.rec.data as unknown as AuthorizationRecord).spec;
      const task = await policy.loadTask(spec.taskKind, spec.taskId);
      if (!task) return sendAutomationError(reply, 'PRINCIPAL_INVALID');
      // 停用的任务：必须明确要求“批准并启用”，否则不保存一份永远不会生效的授权。
      if (!task.enabled && !body.enableTask) return sendAutomationError(reply, 'TASK_DISABLED');
      const actor = { userId: got.me.sub, authentication: 'user' as const };
      const d = await store.approve(actor, draftId, body.expectedVersion, body.expectedDigest, { allowDisabled: !task.enabled });
      if (!task.enabled && !await activateTrigger(spec)) {
        // 启用失败（任务刚被改过）：撤销刚生效的授权。即使撤销也失败，该授权绑定的修订已无法再出现，不会生效。
        await store.revoke(actor, draftId, body.expectedVersion + 1).catch(() => undefined);
        return sendAutomationError(reply, 'TASK_REVISION_CHANGED');
      }
      return { ...d, version: body.expectedVersion + 1, effectiveStatus: effectiveStatus(d), taskEnabled: true, deliveryEnabled: await deliveryEnabled(d) };
    } catch (err) { return handleError(err, reply); }
  });
  // 用实体 ID 撤销，避免遍历所有授权查找 grantId。协议提案对应修订。
  ctx.app.post('/api/v1/automation/drafts/:draftId/revoke', async (req, reply) => {
    const { draftId } = req.params as { draftId: string };
    const got = await visible(req, reply, draftId, true); if (!got) return;
    try {
      const body = RevokeInput.parse(req.body);
      const d = await store.revoke({ userId: got.me.sub, authentication: 'user' }, draftId, body.expectedVersion);
      return { ...d, version: body.expectedVersion + 1, effectiveStatus: effectiveStatus(d), deliveryEnabled: false };
    } catch (err) { return handleError(err, reply); }
  });
  ctx.app.get('/api/v1/automation/drafts', async (req, reply) => {
    const me = await ctx.requireUser(req, reply); if (!me) return;
    try {
      const query = z.object(PageQuery).strict().parse(req.query);
      const page = paginate(await ctx.repo.listEntities(KIND, me.sub), query.page_size, query.page_token);
      if (page === 'bad_cursor') return fail(reply, 422, '分页游标无效', { code: 'CURSOR_NOT_FOUND' });
      const items = [];
      for (const r of page.items) { const d = r.data as unknown as AuthorizationRecord; items.push({ ...d, version: r.version, effectiveStatus: effectiveStatus(d), deliveryEnabled: await deliveryEnabled(d) }); }
      return { items, total: page.total, page_token: page.page_token };
    } catch (err) { return handleError(err, reply); }
  });

  // 前端 P0 2.1：完整、可信的审阅快照。权限由服务端实时计算，不根据客户端声明推导。
  ctx.app.get('/api/v1/automation/drafts/:draftId', async (req, reply) => {
    const { draftId } = req.params as { draftId: string };
    const got = await visible(req, reply, draftId, false); if (!got) return;
    const d = got.rec.data as unknown as AuthorizationRecord;
    const realActor = !ctx.isBot(req) && !headerStr(req, 'x-on-behalf-of');
    const trig = await ctx.repo.getEntity('agent_trigger', d.spec.taskId);
    const t = trig?.data as unknown as TriggerData | undefined;
    const snap = trig ? triggerSnapshot(trig.id, trig.data) : undefined;
    const principal = await ctx.repo.getUser(d.spec.principalId);
    const status = effectiveStatus(d);
    const revisionMatches = !!snap && enabledRevision(snap) === d.spec.taskRevision;
    // 审批资格
    const approveReasons: string[] = [];
    if (!realActor) approveReasons.push('REAL_USER_REQUIRED');
    if (d.status !== 'pending') approveReasons.push('DRAFT_STALE');
    else if (status === 'draft_expired') approveReasons.push('DRAFT_EXPIRED');
    if (!snap) approveReasons.push('TASK_NOT_FOUND');
    else if (!revisionMatches) approveReasons.push('TASK_REVISION_CHANGED');
    if (snap && revisionMatches && d.status === 'pending') {
      try { await policy.assertCanApprove(got.me.sub, snap, d.spec); } catch (err) { approveReasons.push(err instanceof AuthorizationError ? err.code : 'PERMISSION_DENIED'); }
    }
    const revokeReasons: string[] = [];
    if (!realActor) revokeReasons.push('REAL_USER_REQUIRED');
    if (d.status === 'revoked') revokeReasons.push('GRANT_REVOKED');
    if (!snap) revokeReasons.push('TASK_NOT_FOUND');
    else { try { await policy.assertCanRevoke(got.me.sub, snap, d.spec); } catch (err) { revokeReasons.push(err instanceof AuthorizationError ? err.code : 'PERMISSION_DENIED'); } }
    const resources = [];
    for (const r of d.spec.resources) {
      const doc = r.type === 'doc' ? await ctx.repo.getDoc(r.resourceId) : undefined;
      const readable = !!doc && (await docAccess(ctx, doc, got.me.sub)).permissions.can_view;
      resources.push({ ...r, exists: !!doc, displayName: readable ? doc!.title : null });
    }
    const targets = [];
    for (const target of d.spec.recipients.targets) targets.push(await targetDisplay(ctx, target));
    return {
      ...d, version: got.rec.version, effectiveStatus: status, deliveryEnabled: await deliveryEnabled(d),
      task: t && snap ? {
        kind: 'trigger', id: trig!.id, name: t.name, enabled: t.enabled, prompt: t.prompt, condition: t.condition, event: t.event, filter: t.filter,
        cron: t.cron, scheduleTimezone: 'Asia/Shanghai', resultChatId: t.chat_id, cooldownSec: t.cooldown_sec,
        securityRevision: t.security_revision ?? 'legacy', currentRevision: enabledRevision(snap), revisionMatches,
        deliverySupported: t.event === 'schedule',
      } : null,
      principal: principal ? { id: principal.user_id, name: principal.name, accountType: principal.role === 'bot' ? 'bot' : 'user', active: !principal.disabled } : { id: d.spec.principalId, name: null, accountType: null, active: false },
      permissions: { canApprove: approveReasons.length === 0, canRevoke: revokeReasons.length === 0, approveBlockedReasons: approveReasons, revokeBlockedReasons: revokeReasons, requiresEnableTask: !!t && !t.enabled && d.status === 'pending' },
      targets, resources,
      bindingRules: { securityFieldsInRevision: ['securityRevision', 'prompt', 'condition', 'event', 'filter', 'cron', 'cooldownSec', 'resultChatId', 'ownerId', 'principalId', 'enabled'], displayOnlyFields: ['name'], approvalRequires: ['expectedVersion', 'expectedDigest'] },
    };
  });

  // 前端 P0 2.3：运行与逐目标结果（仅本人任务）。
  ctx.app.get('/api/v1/automation/runs', async (req, reply) => {
    const me = await ctx.requireUser(req, reply); if (!me) return;
    try {
      const q = z.object({ ...PageQuery, taskKind: z.enum(['trigger', 'scheduler']).optional(), taskId: z.string().min(1).max(200).optional() }).strict().parse(req.query);
      const rows = (await ctx.repo.listEntities(RUN_KIND, me.sub)).filter(r => (!q.taskKind || r.data.taskKind === q.taskKind) && (!q.taskId || r.data.taskId === q.taskId));
      const page = paginate(rows, q.page_size, q.page_token);
      if (page === 'bad_cursor') return fail(reply, 422, '分页游标无效', { code: 'CURSOR_NOT_FOUND' });
      const cache = new Map();
      const items = [];
      for (const r of page.items) items.push(await runView(ctx, r, cache));
      return { items, total: page.total, page_token: page.page_token };
    } catch (err) { return handleError(err, reply); }
  });
  ctx.app.get('/api/v1/automation/runs/:runId', async (req, reply) => {
    const me = await ctx.requireUser(req, reply); if (!me) return;
    const rec = await ctx.repo.getEntity(RUN_KIND, (req.params as { runId: string }).runId);
    if (!rec || rec.scope !== me.sub) return fail(reply, 404, '运行不存在', { code: 'NOT_FOUND' });
    return runView(ctx, rec);
  });
}
