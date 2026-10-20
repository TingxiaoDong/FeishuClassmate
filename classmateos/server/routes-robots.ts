import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail, type Ctx } from './context.js';
import { headerStr } from './agent-principal.js';
import { nowIso } from './repo.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

const location = z.object({
  name: z.string().trim().min(1).max(100), label: z.string().max(100).optional(),
  aliases: z.array(z.string().min(1).max(100)).max(20).default([]),
  kind: z.enum(['room', 'workstation', 'dock', 'other']).default('other'),
  owner_user_id: z.string().max(100).nullable().optional(), allowed: z.boolean().default(false),
}).strict();
const status = z.object({
  online: z.boolean(), mock: z.boolean(), battery: z.number().min(0).max(100).nullable(),
  charging: z.boolean(), is_moving: z.boolean(), location: z.string().max(100).nullable(),
  current_action: z.object({ action_id: z.string(), label: z.string().max(200), started_by: z.string().nullable() }).nullable(),
  controller: z.object({ user_id: z.string().nullable(), name: z.string().nullable(), until: z.string() }).nullable(),
}).strict();
/** 平台机器人配置；纯 bot 只读配置、上报状态，不能自行放行地点。 */
export function registerRobotRoutes(ctx: Ctx) {
  const { app, repo } = ctx;
  const pureBotError = (req: FastifyRequest, reply: FastifyReply) =>
    !ctx.isBot(req) || headerStr(req, 'x-on-behalf-of') ? fail(reply, 401, '需要机器人身份') : undefined;
  const robotId = (req: FastifyRequest) => (req.params as { robot_id: string }).robot_id;
  const key = (id: string, name: string) => JSON.stringify([id, name]);
  const save = async (kind: string, id: string, scope: string, data: Record<string, unknown>) => {
    const cur = await repo.getEntity(kind, id);
    const now = nowIso();
    return repo.saveEntity({ kind, id, scope, data, version: cur?.version ?? 0, created_at: cur?.created_at ?? now, updated_at: now }, cur?.version ?? 0);
  };
  app.post('/api/v1/bot/robots/:robot_id/logs', async (req, reply) => {
    const denied = pureBotError(req, reply);
    if (denied) return denied;
    const parsed = z.object({
      kind: z.enum(['goto', 'say', 'ask', 'move', 'follow', 'stop', 'look', 'task', 'event', 'location']),
      text: z.string().max(2000), actor_id: z.string().nullable().optional(),
      ok: z.boolean().optional(), action_id: z.string().optional(),
    }).strict().safeParse(req.body);
    if (!parsed.success) return fail(reply, 422, '日志字段不合法');
    const id = randomUUID();
    const data = { ...parsed.data, log_id: id, created_at: nowIso() };
    await save('robot_log', id, robotId(req), data);
    return reply.code(201).send(data);
  });
  app.get('/api/v1/robots/:robot_id/logs', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    // 日志可能含播报内容，只有管理员本人能查看完整日志。
    if (me.user.role !== 'admin' || ctx.isBot(req)) return fail(reply, 403, '仅管理员可查看机器人日志');
    const items = await repo.listEntities('robot_log', robotId(req));
    return { items: items.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100).map(x => x.data) };
  });
  for (const prefix of ['/robots', '/bot/robots']) {
    app.get(`/api/v1${prefix}/:robot_id/locations`, async (req, reply) => {
      if (prefix.startsWith('/bot')) { const denied = pureBotError(req, reply); if (denied) return denied; }
      else if (!await ctx.requireUser(req, reply)) return;
      return { items: (await repo.listEntities('robot_location', robotId(req))).map(r => r.data) };
    });
  }
  app.get('/api/v1/robots/:robot_id/status', async (req, reply) => {
    if (!await ctx.requireUser(req, reply)) return;
    const rec = await repo.getEntity('robot_status', robotId(req));
    if (!rec) return { online: false, stale: true };
    const stale = Date.now() - Date.parse(rec.updated_at) > 60_000;
    return { ...rec.data, online: !stale && rec.data.online === true, stale, updated_at: rec.updated_at };
  });
  app.put('/api/v1/bot/robots/:robot_id/status', async (req, reply) => {
    const denied = pureBotError(req, reply);
    if (denied) return denied;
    const p = status.safeParse(req.body);
    if (!p.success) return fail(reply, 422, '状态字段不合法');
    if (!await save('robot_status', robotId(req), robotId(req), p.data)) return fail(reply, 409, '状态已更新，请重试');
    return { ok: true };
  });
  app.post('/api/v1/robots/:robot_id/locations', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    if (me.user.role !== 'admin' || ctx.isBot(req)) return fail(reply, 403, '地点配置只能由管理员本人修改');
    const p = location.safeParse(req.body);
    if (!p.success) return fail(reply, 422, '地点字段不合法');
    const id = robotId(req);
    if (await repo.getEntity('robot_location', key(id, p.data.name))) return fail(reply, 409, '地点已存在');
    if (!await save('robot_location', key(id, p.data.name), id, { ...p.data, label: p.data.label ?? p.data.name })) return fail(reply, 409, '配置冲突');
    return reply.code(201).send(p.data);
  });
  // App 一键急停：任何登录的同学本人都能按；机器人代办身份不能按（防止模型误触）。
  app.post('/api/v1/robots/:robot_id/estop', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    if (ctx.isBot(req)) return fail(reply, 403, '急停只能由同学本人在 App 里按');
    const id = robotId(req);
    ctx.publish('robot.estop', { robot_id: id, user_id: me.user.user_id, name: me.user.name });
    const logId = randomUUID();
    await save('robot_log', logId, id, { log_id: logId, kind: 'stop', text: `${me.user.name}在 App 里按了急停`, actor_id: me.user.user_id, ok: true, created_at: nowIso() });
    return { ok: true, robot_id: id };
  });
  app.patch('/api/v1/robots/:robot_id/locations/:name', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    if (me.user.role !== 'admin' || ctx.isBot(req)) return fail(reply, 403, '地点配置只能由管理员本人修改');
    const { name } = req.params as { name: string };
    const id = robotId(req);
    const cur = await repo.getEntity('robot_location', key(id, name));
    if (!cur) return fail(reply, 404, '地点不存在');
    const patch = location.omit({ name: true }).partial().safeParse(req.body);
    if (!patch.success) return fail(reply, 422, '地点字段不合法');
    const data = { ...cur.data, ...patch.data };
    if (!await repo.saveEntity({ ...cur, data, updated_at: nowIso() }, cur.version)) return fail(reply, 409, '配置冲突');
    return data;
  });
}
