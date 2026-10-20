/**
 * Agent 自动化（AGENT_PLAN M3 §2.4 长任务 / §2.5 主动协作）。
 *
 * 后台任务（job）——App 端 job_dialog.dart / phase2_jobs.dart 已按这个形状轮询：
 *   GET   /api/v1/jobs                     我的后台任务（新的在前）
 *   GET   /api/v1/jobs/:job_id             单个任务（本人或管理员）
 *   POST  /api/v1/bot/jobs                 （纯 bot）大脑登记一个长任务
 *   PATCH /api/v1/bot/jobs/:job_id         （纯 bot）更新进度 / 状态 / 结果
 *
 * 自动化触发器——同学用一句话让飞书同学「某件事发生时 / 每周几点」自动帮忙：
 *   GET    /api/v1/agent/triggers          我的触发器
 *   POST   /api/v1/agent/triggers          新建（机器人可代办）
 *   PATCH  /api/v1/agent/triggers/:id      修改 / 停用
 *   DELETE /api/v1/agent/triggers/:id      删除（机器人代办时要确认卡片）
 *   GET    /api/v1/bot/triggers            （纯 bot）全部启用中的触发器
 *   POST   /api/v1/bot/triggers/:id/fired  （纯 bot）记一次触发结果
 *
 * 触发器总是以「建它的同学」的身份运行，权限按这位同学算；改动后推 trigger.changed 给大脑。
 */

import cron from 'node-cron';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { headerStr } from './agent-principal.js';
import { fail, invalid, newId, type AuthedUser, type Ctx, type FieldError } from './context.js';
import { nowIso, type EntityRecord } from './repo.js';

const JOB_KIND = 'agent_job';
const TRIGGER_KIND = 'agent_trigger';

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TRIGGER_EVENTS = ['record.changed', 'task.assigned', 'task.updated', 'calendar.invited', 'doc.comment_changed', 'schedule'] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

/** 每位同学最多几个触发器。 */
export const MAX_TRIGGERS_PER_USER = 20;
/** 两次触发的最短间隔（秒），防止表格频繁修改造成刷屏。 */
const MIN_COOLDOWN = 60;
const DEFAULT_COOLDOWN = 300;

export interface JobData {
  job_id: string;
  kind: string;
  title: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  steps: Array<{ label: string; state: string }>;
  result: Record<string, unknown>;
  owner_id: string;
  chat_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface TriggerData {
  trigger_id: string;
  owner_id: string;
  name: string;
  event: TriggerEvent;
  filter: { table_key?: string; actions?: string[]; fields_any?: string[]; doc_id?: string; task_id?: string };
  cron: string | null;
  condition: string | null;
  prompt: string;
  chat_id: string | null;
  enabled: boolean;
  cooldown_sec: number;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
  fire_count: number;
  last_result: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 100);

export function registerAutomationRoutes(ctx: Ctx): void {
  const { app, repo } = ctx;

  const pureBot = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!ctx.isBot(req) || headerStr(req, 'x-on-behalf-of')) {
      fail(reply, 401, 'invalid bot token');
      return false;
    }
    return true;
  };

  const save = async (kind: string, id: string, scope: string, data: Record<string, unknown>, cur?: EntityRecord) => {
    const now = nowIso();
    return repo.saveEntity(
      { kind, id, scope, data, version: cur?.version ?? 0, created_at: cur?.created_at ?? now, updated_at: now },
      cur?.version ?? 0,
    );
  };

  // ================================================================ 后台任务

  const jobJson = (d: JobData) => d;
  const canSeeJob = (me: AuthedUser, d: JobData) => d.owner_id === me.sub || me.user.role === 'admin';

  app.get('/api/v1/jobs', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { status } = req.query as { status?: string };
    const items = (await repo.listEntities(JOB_KIND, me.sub))
      .map((r) => r.data as unknown as JobData)
      .filter((d) => !status || d.status === status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 100);
    return { items: items.map(jobJson) };
  });

  app.get('/api/v1/jobs/:job_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { job_id } = req.params as { job_id: string };
    const rec = await repo.getEntity(JOB_KIND, job_id);
    const d = rec?.data as unknown as JobData | undefined;
    if (!d || !canSeeJob(me, d)) return fail(reply, 404, '任务不存在');
    return jobJson(d);
  });

  app.post('/api/v1/bot/jobs', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    if (typeof b.owner_id !== 'string' || !b.owner_id) errors.push({ field: 'owner_id', message: '不能为空' });
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) errors.push({ field: 'title', message: '1-200 字' });
    if (b.chat_id != null && typeof b.chat_id !== 'string') errors.push({ field: 'chat_id', message: '必须是文本' });
    if (errors.length) return invalid(reply, errors);
    if ((await ctx.missingUsers([b.owner_id as string])).length) return fail(reply, 404, '用户不存在');
    const now = nowIso();
    const d: JobData = {
      job_id: newId('job'),
      kind: typeof b.kind === 'string' ? b.kind.slice(0, 40) : 'agent',
      title: (b.title as string).trim(),
      status: 'running',
      progress: 0,
      message: null,
      steps: [],
      result: {},
      owner_id: b.owner_id as string,
      chat_id: (b.chat_id as string | undefined) ?? null,
      session_id: typeof b.session_id === 'string' ? b.session_id.slice(0, 300) : null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    await save(JOB_KIND, d.job_id, d.owner_id, d as unknown as Record<string, unknown>);
    ctx.publish('job.updated', { job: d }, [d.owner_id], { user_only: true });
    return reply.code(201).send(d);
  });

  app.patch('/api/v1/bot/jobs/:job_id', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const { job_id } = req.params as { job_id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    if (b.status !== undefined && !JOB_STATUSES.includes(b.status as JobStatus)) errors.push({ field: 'status', message: `只能是 ${JOB_STATUSES.join(' / ')}` });
    if (b.progress !== undefined && (typeof b.progress !== 'number' || b.progress < 0 || b.progress > 1)) errors.push({ field: 'progress', message: '0-1 之间的数' });
    if (b.message != null && (typeof b.message !== 'string' || b.message.length > 5000)) errors.push({ field: 'message', message: '不超过 5000 字' });
    if (b.steps !== undefined && (!Array.isArray(b.steps) || b.steps.length > 50)) errors.push({ field: 'steps', message: '最多 50 步' });
    if (b.result !== undefined && !isObj(b.result)) errors.push({ field: 'result', message: '必须是对象' });
    if (errors.length) return invalid(reply, errors);
    for (let i = 0; i < 3; i++) {
      const cur = await repo.getEntity(JOB_KIND, job_id);
      if (!cur) return fail(reply, 404, '任务不存在');
      const old = cur.data as unknown as JobData;
      if (old.status === 'done' || old.status === 'failed') return fail(reply, 409, '任务已经结束', { code: 'JOB_FINISHED' });
      const now = nowIso();
      const status = (b.status as JobStatus | undefined) ?? old.status;
      const finished = status === 'done' || status === 'failed';
      const d: JobData = {
        ...old,
        status,
        progress: finished && status === 'done' ? 1 : ((b.progress as number | undefined) ?? old.progress),
        message: b.message !== undefined ? ((b.message as string | null) ?? null) : old.message,
        steps: b.steps !== undefined
          ? (b.steps as unknown[]).map((s) => ({ label: String((s as { label?: unknown })?.label ?? '').slice(0, 100), state: String((s as { state?: unknown })?.state ?? '').slice(0, 20) }))
          : old.steps,
        result: (b.result as Record<string, unknown> | undefined) ?? old.result,
        updated_at: now,
        finished_at: finished ? now : null,
      };
      if (await save(JOB_KIND, job_id, old.owner_id, d as unknown as Record<string, unknown>, cur)) {
        ctx.publish('job.updated', { job: d }, [d.owner_id], { user_only: true });
        return d;
      }
    }
    return fail(reply, 409, '任务正被其他请求修改', { code: 'CONFLICT' });
  });

  // ================================================================ 触发器

  /** 校验并规整触发器字段；partial=true 时只校验给了的字段。 */
  async function parseTrigger(me: AuthedUser, b: Record<string, unknown>, base: Partial<TriggerData>, errors: FieldError[]) {
    const out: Partial<TriggerData> = {};
    const has = (k: string) => b[k] !== undefined;
    if (has('name') || base.name === undefined) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 50) errors.push({ field: 'name', message: '1-50 字' });
      else out.name = b.name.trim();
    }
    if (has('event') || base.event === undefined) {
      if (!TRIGGER_EVENTS.includes(b.event as TriggerEvent)) errors.push({ field: 'event', message: `只能是 ${TRIGGER_EVENTS.join(' / ')}` });
      else out.event = b.event as TriggerEvent;
    }
    if (has('prompt') || base.prompt === undefined) {
      if (typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 2000) errors.push({ field: 'prompt', message: '1-2000 字：触发时要飞书同学做什么' });
      else out.prompt = b.prompt.trim();
    }
    if (has('condition')) {
      if (b.condition !== null && (typeof b.condition !== 'string' || b.condition.length > 500)) errors.push({ field: 'condition', message: '不超过 500 字' });
      else out.condition = (b.condition as string | null)?.trim() || null;
    }
    if (has('filter')) {
      const f = b.filter;
      if (f !== null && !isObj(f)) errors.push({ field: 'filter', message: '必须是对象' });
      else {
        const ff = (f ?? {}) as Record<string, unknown>;
        const filter: TriggerData['filter'] = {};
        for (const k of ['table_key', 'doc_id', 'task_id'] as const) {
          if (ff[k] === undefined) continue;
          if (typeof ff[k] !== 'string' || !(ff[k] as string) || (ff[k] as string).length > 100) errors.push({ field: `filter.${k}`, message: '必须是文本' });
          else filter[k] = ff[k] as string;
        }
        if (ff.actions !== undefined) {
          if (!strList(ff.actions, 3) || !(ff.actions as string[]).every((a) => ['created', 'updated', 'deleted'].includes(a))) errors.push({ field: 'filter.actions', message: 'created / updated / deleted' });
          else filter.actions = ff.actions as string[];
        }
        if (ff.fields_any !== undefined) {
          if (!strList(ff.fields_any, 20)) errors.push({ field: 'filter.fields_any', message: '字段英文名列表' });
          else filter.fields_any = ff.fields_any as string[];
        }
        out.filter = filter;
      }
    }
    if (has('cron')) {
      if (b.cron !== null && (typeof b.cron !== 'string' || !cron.validate(b.cron))) errors.push({ field: 'cron', message: 'cron 表达式不合法（5 段：分 时 日 月 周，如 0 9 * * 1）' });
      else out.cron = (b.cron as string | null) ?? null;
    }
    if (has('chat_id')) {
      if (b.chat_id !== null && typeof b.chat_id !== 'string') errors.push({ field: 'chat_id', message: '必须是文本' });
      else if (b.chat_id) {
        const chat = await repo.getChat(b.chat_id as string);
        if (!chat || !chat.member_ids.includes(me.sub)) errors.push({ field: 'chat_id', message: '你不在这个会话里' });
        else out.chat_id = b.chat_id as string;
      } else out.chat_id = null;
    }
    if (has('enabled')) {
      if (typeof b.enabled !== 'boolean') errors.push({ field: 'enabled', message: '必须是 true / false' });
      else out.enabled = b.enabled;
    }
    if (has('cooldown_sec')) {
      if (typeof b.cooldown_sec !== 'number' || !Number.isInteger(b.cooldown_sec) || b.cooldown_sec < MIN_COOLDOWN || b.cooldown_sec > 7 * 86400) {
        errors.push({ field: 'cooldown_sec', message: `${MIN_COOLDOWN} 秒到 7 天` });
      } else out.cooldown_sec = b.cooldown_sec;
    }
    const event = out.event ?? base.event;
    const cronExpr = out.cron !== undefined ? out.cron : base.cron;
    if (event === 'schedule' && !cronExpr) errors.push({ field: 'cron', message: '定时触发需要 cron' });
    if (event === 'record.changed' && !(out.filter ?? base.filter)?.table_key) errors.push({ field: 'filter.table_key', message: '表格触发需要指定是哪张表' });
    return out;
  }

  const triggerChanged = (id: string) => ctx.publish('trigger.changed', { trigger_id: id }, []);

  const loadOwned = async (me: AuthedUser, id: string, reply: FastifyReply) => {
    const rec = await repo.getEntity(TRIGGER_KIND, id);
    const d = rec?.data as unknown as TriggerData | undefined;
    if (!rec || !d || (d.owner_id !== me.sub && me.user.role !== 'admin')) {
      fail(reply, 404, '触发器不存在');
      return undefined;
    }
    return { rec, d };
  };

  app.get('/api/v1/agent/triggers', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const items = (await repo.listEntities(TRIGGER_KIND, me.sub)).map((r) => r.data as unknown as TriggerData);
    return { items };
  });

  app.post('/api/v1/agent/triggers', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const p = await parseTrigger(me, b, {}, errors);
    if (errors.length) return invalid(reply, errors);
    if ((await repo.listEntities(TRIGGER_KIND, me.sub)).length >= MAX_TRIGGERS_PER_USER) {
      return fail(reply, 409, `每人最多 ${MAX_TRIGGERS_PER_USER} 个自动化，请先删掉不用的`, { code: 'TRIGGER_LIMIT' });
    }
    const now = nowIso();
    const d: TriggerData = {
      trigger_id: newId('trg'),
      owner_id: me.sub,
      name: p.name!,
      event: p.event!,
      filter: p.filter ?? {},
      cron: p.cron ?? null,
      condition: p.condition ?? null,
      prompt: p.prompt!,
      chat_id: p.chat_id ?? null,
      enabled: p.enabled ?? true,
      cooldown_sec: p.cooldown_sec ?? DEFAULT_COOLDOWN,
      created_at: now,
      updated_at: now,
      last_fired_at: null,
      fire_count: 0,
      last_result: null,
    };
    await save(TRIGGER_KIND, d.trigger_id, me.sub, d as unknown as Record<string, unknown>);
    triggerChanged(d.trigger_id);
    return reply.code(201).send(d);
  });

  app.patch('/api/v1/agent/triggers/:trigger_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { trigger_id } = req.params as { trigger_id: string };
    const got = await loadOwned(me, trigger_id, reply);
    if (!got) return;
    const errors: FieldError[] = [];
    const p = await parseTrigger(me, (req.body ?? {}) as Record<string, unknown>, got.d, errors);
    if (errors.length) return invalid(reply, errors);
    const d: TriggerData = { ...got.d, ...p, updated_at: nowIso() };
    if (!(await save(TRIGGER_KIND, trigger_id, got.d.owner_id, d as unknown as Record<string, unknown>, got.rec))) {
      return fail(reply, 409, '触发器正被其他请求修改', { code: 'CONFLICT' });
    }
    triggerChanged(trigger_id);
    return d;
  });

  app.delete('/api/v1/agent/triggers/:trigger_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { trigger_id } = req.params as { trigger_id: string };
    if (!(await loadOwned(me, trigger_id, reply))) return;
    await repo.deleteEntity(TRIGGER_KIND, trigger_id);
    triggerChanged(trigger_id);
    return reply.code(204).send();
  });

  app.get('/api/v1/bot/triggers', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const items = (await repo.listEntities(TRIGGER_KIND)).map((r) => r.data as unknown as TriggerData).filter((d) => d.enabled);
    return { items };
  });

  app.post('/api/v1/bot/triggers/:trigger_id/fired', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const { trigger_id } = req.params as { trigger_id: string };
    const { result } = (req.body ?? {}) as { result?: unknown };
    for (let i = 0; i < 3; i++) {
      const cur = await repo.getEntity(TRIGGER_KIND, trigger_id);
      if (!cur) return fail(reply, 404, '触发器不存在');
      const old = cur.data as unknown as TriggerData;
      const d: TriggerData = {
        ...old,
        last_fired_at: nowIso(),
        fire_count: (old.fire_count ?? 0) + 1,
        last_result: typeof result === 'string' ? result.slice(0, 500) : null,
      };
      if (await save(TRIGGER_KIND, trigger_id, old.owner_id, d as unknown as Record<string, unknown>, cur)) return { ok: true };
    }
    return fail(reply, 409, '触发器正被其他请求修改', { code: 'CONFLICT' });
  });
}
