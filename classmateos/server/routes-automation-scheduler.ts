/**
 * 自动化预授权 v2：可信调度器接口（/api/v1/internal/automation/*）。
 *
 * 鉴权：独立调度器密钥（请求头 X-Automation-Scheduler-Token），与 bot 令牌分开配置、不能相同；
 * 普通 bot 令牌、用户令牌、代办头都不能调用。没有配置密钥时这些接口全部返回 503，能力接口报告不可投递。
 * 发送凭证只出现在“开始 / 恢复运行”的响应里，调用方须只保存在可信适配器闭包中。
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fail, type Ctx } from './context.js';
import { AuthorizationError, enabledRevision, taskRevision, type AuthorizationPolicy, type AuthorizationRecord, type RunContext } from './automation-authorization.js';
import { occurrenceRunId, RunBusyError, type AutomationRunCredentials, type StoredAutomationRun } from './automation-run-credentials.js';
import type { AutomationDeliveryService } from './automation-delivery.js';
import { verifyScheduleOccurrence, SCHEDULE_TIMEZONE, OCCURRENCE_LOOKBACK_MS } from './automation-occurrence.js';
import type { TriggerData } from './routes-automation.js';
import { CREDENTIAL_HEADER, GRANT_KIND, PROTOCOL_VERSION, RUN_KIND, SCHEDULER_HEADER, effectiveStatus, findActiveGrant, handleAutomationError, runView, sendAutomationError } from './automation-views.js';

export interface SchedulerDeps {
  schedulerToken: string | undefined;
  policy: AuthorizationPolicy;
  credentials: AutomationRunCredentials;
  delivery: AutomationDeliveryService;
  now?: () => number;
}

const TaskKind = z.enum(['trigger', 'scheduler']);
const BeginInput = z.object({ taskKind: TaskKind, taskId: z.string().min(1).max(200), expectedTaskRevision: z.string().regex(/^[a-f0-9]{64}$/), occurrenceId: z.string().min(1).max(80) }).strict();

/** 调度器密钥：至少 32 个字符，且不能与 bot 令牌相同；不满足时视为未配置。 */
export function usableSchedulerToken(token: string | undefined, botToken: string | undefined): string | undefined {
  if (!token || token.length < 32 || token === botToken) return undefined;
  return token;
}

export function registerAutomationSchedulerRoutes(ctx: Ctx, deps: SchedulerDeps): void {
  const now = deps.now ?? Date.now;
  const scheduler = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!deps.schedulerToken) { fail(reply, 503, '自动化调度器未配置', { code: 'SCHEDULER_NOT_CONFIGURED' }); return false; }
    const got = req.headers[SCHEDULER_HEADER];
    const a = Buffer.from(typeof got === 'string' ? got : ''), b = Buffer.from(deps.schedulerToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) { fail(reply, 401, '调度器身份无效', { code: 'SCHEDULER_UNAUTHORIZED' }); return false; }
    return true;
  };
  const loadTrigger = async (taskKind: string, taskId: string) => {
    if (taskKind !== 'trigger') throw new AuthorizationError('UNSUPPORTED_CAPABILITY');
    const rec = await ctx.repo.getEntity('agent_trigger', taskId);
    return rec ? (rec.data as unknown as TriggerData) : undefined;
  };
  const grantView = (rec: { id: string; version: number; data: Record<string, unknown> }) => {
    const d = rec.data as unknown as AuthorizationRecord;
    return { draftId: d.draftId, grantId: d.grantId, version: rec.version, effectiveStatus: effectiveStatus(d, now()), targets: d.spec.recipients.targets, resources: d.spec.resources, output: d.spec.output, limits: d.spec.limits, expiresAt: d.spec.expiresAt, scope: d.scope };
  };
  const credentialFrom = (req: FastifyRequest) => { const v = req.headers[CREDENTIAL_HEADER]; return typeof v === 'string' ? v : ''; };
  /** 用路径里的 runId + 请求头凭证组装运行上下文；其余绑定字段取自服务端运行记录。 */
  const contextOf = async (runId: string, credential: string): Promise<{ ctx: RunContext; run: StoredAutomationRun } | undefined> => {
    const rec = await ctx.repo.getEntity(RUN_KIND, runId);
    if (!rec) return undefined;
    const run = rec.data as unknown as StoredAutomationRun;
    return { run, ctx: { runId, grantId: run.grantId, taskRevision: run.taskRevision, principalId: run.principalId, expiresAt: run.expiresAt, sendCredential: credential } };
  };

  // P0-1 可信任务快照（含当前可用授权）。taskRevision 由后端计算，Agent 不要用本地散列代替。
  ctx.app.get('/api/v1/internal/automation/tasks/:taskKind/:taskId', async (req, reply) => {
    if (!scheduler(req, reply)) return reply;
    const { taskKind, taskId } = req.params as { taskKind: string; taskId: string };
    try {
      const t = await loadTrigger(TaskKind.parse(taskKind), taskId);
      const snap = t ? await deps.policy.loadTask('trigger', taskId) : undefined;
      if (!t || !snap) return fail(reply, 404, '任务不存在', { code: 'NOT_FOUND' });
      const current = taskRevision(snap);
      const grant = snap.enabled ? await findActiveGrant(ctx, snap.ownerId, 'trigger', taskId, current, now()) : undefined;
      return {
        protocolVersion: PROTOCOL_VERSION, taskKind: 'trigger', taskId, taskRevision: current, enabledTaskRevision: enabledRevision(snap),
        ownerId: snap.ownerId, principalId: snap.principalId, enabled: snap.enabled,
        trigger: { event: t.event, cron: t.cron, timezone: SCHEDULE_TIMEZONE, filter: t.filter, condition: t.condition, prompt: t.prompt, resultChatId: t.chat_id, cooldownSec: t.cooldown_sec },
        occurrence: t.event === 'schedule' ? { supported: true, format: 'schedule:<触发时刻 ISO 8601>', lookbackMs: OCCURRENCE_LOOKBACK_MS } : { supported: false, code: 'UNSUPPORTED_CAPABILITY' },
        grant: grant ? grantView(grant) : null,
        deliveryReady: !!grant && t.event === 'schedule',
      };
    } catch (err) { return handleAutomationError(err, reply); }
  });

  // P0-2 开始 / 恢复运行，签发短期发送凭证。
  ctx.app.post('/api/v1/internal/automation/runs', async (req, reply) => {
    if (!scheduler(req, reply)) return reply;
    try {
      const body = BeginInput.parse(req.body);
      const t = await loadTrigger(body.taskKind, body.taskId);
      if (!t) return fail(reply, 404, '任务不存在', { code: 'NOT_FOUND' });
      const occurrenceId = verifyScheduleOccurrence(t, body.occurrenceId, now());
      const runId = occurrenceRunId(body.taskKind, body.taskId, occurrenceId);
      let draftId = ((await ctx.repo.getEntity(RUN_KIND, runId))?.data as unknown as StoredAutomationRun | undefined)?.draftId;
      if (!draftId) {
        const snap = await deps.policy.loadTask('trigger', body.taskId);
        if (!snap) return fail(reply, 404, '任务不存在', { code: 'NOT_FOUND' });
        if (!snap.enabled) return sendAutomationError(reply, 'TASK_DISABLED');
        const current = taskRevision(snap);
        if (current !== body.expectedTaskRevision) return sendAutomationError(reply, 'TASK_REVISION_CHANGED');
        const grant = await findActiveGrant(ctx, snap.ownerId, 'trigger', body.taskId, current, now());
        if (!grant) return sendAutomationError(reply, 'AUTHORIZATION_REQUIRED');
        draftId = grant.id;
      }
      const res = await deps.credentials.begin({ draftId, expectedRevision: body.expectedTaskRevision, taskKind: body.taskKind, taskId: body.taskId, occurrenceId });
      const grantRec = (await ctx.repo.getEntity(GRANT_KIND, res.run.draftId))!;
      const g = grantRec.data as unknown as AuthorizationRecord;
      const view = await runView(ctx, (await ctx.repo.getEntity(RUN_KIND, res.run.runId))!);
      return reply.code(res.resumed ? 200 : 201).send({
        ...view, resumed: res.resumed, scope: g.scope,
        targets: g.spec.recipients.targets, output: g.spec.output, limits: g.spec.limits, grantExpiresAt: g.spec.expiresAt,
        credential: res.context ? { header: 'X-Automation-Run-Credential', sendCredential: res.context.sendCredential, expiresAt: res.context.expiresAt } : null,
      });
    } catch (err) {
      if (err instanceof RunBusyError) return fail(reply, 409, '这次触发正由另一个调度进程处理，请稍后重试', { code: 'RUN_BUSY', runId: err.runId, retryAfterMs: Math.ceil(err.retryAfterMs) });
      return handleAutomationError(err, reply);
    }
  });

  // P0-4 受控投递（单个目标）。失败不回退任何普通 bot 通道。
  ctx.app.post('/api/v1/internal/automation/runs/:runId/deliveries', async (req, reply) => {
    if (!scheduler(req, reply)) return reply;
    const { runId } = req.params as { runId: string };
    try {
      const got = await contextOf(runId, credentialFrom(req));
      if (!got) return sendAutomationError(reply, 'RUN_CREDENTIAL_INVALID');
      const r = await deps.delivery.deliver(got.ctx, req.body);
      return { logicalMessageId: r.logicalMessageId, target: r.target, status: r.status, code: r.code ?? null, messageId: r.messageId ?? null, duplicate: r.duplicate ?? false, retryable: r.retryable ?? false };
    } catch (err) { return handleAutomationError(err, reply); }
  });

  // 结束运行：凭证失效，返回聚合结果。已结束的运行重复调用直接返回结果。
  ctx.app.post('/api/v1/internal/automation/runs/:runId/finish', async (req, reply) => {
    if (!scheduler(req, reply)) return reply;
    const { runId } = req.params as { runId: string };
    try {
      const rec = await ctx.repo.getEntity(RUN_KIND, runId);
      if (!rec) return sendAutomationError(reply, 'RUN_CREDENTIAL_INVALID');
      if ((rec.data as unknown as StoredAutomationRun).status !== 'finished') {
        const got = (await contextOf(runId, credentialFrom(req)))!;
        await deps.credentials.finish(got.ctx);
      }
      return await runView(ctx, (await ctx.repo.getEntity(RUN_KIND, runId))!);
    } catch (err) { return handleAutomationError(err, reply); }
  });

  // P0-5 查询：按 runId，或按任务 + occurrenceId（恢复时用）。
  ctx.app.get('/api/v1/internal/automation/runs/:runId', async (req, reply) => {
    if (!scheduler(req, reply)) return reply;
    const rec = await ctx.repo.getEntity(RUN_KIND, (req.params as { runId: string }).runId);
    if (!rec) return fail(reply, 404, '运行不存在', { code: 'NOT_FOUND' });
    return runView(ctx, rec);
  });
  ctx.app.get('/api/v1/internal/automation/runs', async (req, reply) => {
    if (!scheduler(req, reply)) return reply;
    try {
      const q = z.object({ taskKind: TaskKind, taskId: z.string().min(1).max(200), occurrenceId: z.string().min(1).max(80) }).strict().parse(req.query);
      const m = /^schedule:(.+)$/.exec(q.occurrenceId);
      const ms = m ? Date.parse(m[1]) : NaN;
      if (!Number.isFinite(ms)) return sendAutomationError(reply, 'RUN_CREDENTIAL_INVALID');
      const rec = await ctx.repo.getEntity(RUN_KIND, occurrenceRunId(q.taskKind, q.taskId, `schedule:${new Date(ms).toISOString()}`));
      if (!rec) return fail(reply, 404, '这次触发还没有开始运行', { code: 'NOT_FOUND' });
      return runView(ctx, rec);
    } catch (err) { return handleAutomationError(err, reply); }
  });
}
