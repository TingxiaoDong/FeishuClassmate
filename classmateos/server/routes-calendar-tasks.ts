/**
 * 日历（第 10 节）与任务（第 11 节）。
 */

import { fail, invalid, newId, type Ctx, type FieldError } from './context.js';
import {
  nowIso,
  type CalendarEventRecord,
  type Rsvp,
  type TaskPriority,
  type TaskRecord,
  type TaskStatus,
} from './repo.js';

const RSVPS = new Set<Rsvp>(['pending', 'accepted', 'declined', 'tentative']);
const TASK_STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'done', 'cancelled']);
const PRIORITIES = new Set<TaskPriority>(['low', 'normal', 'high', 'urgent']);
const MAX_RANGE_MS = 366 * 24 * 3600_000;

export function eventJson(ev: CalendarEventRecord) {
  return {
    event_id: ev.event_id,
    title: ev.title,
    start_ms: ev.start_ms,
    end_ms: ev.end_ms,
    attendee_ids: ev.attendees.map((a) => a.user_id),
    attendees: ev.attendees,
    description: ev.description,
    location: ev.location,
    all_day: ev.all_day,
    color: ev.color,
    reminders: ev.reminders,
    created_by: ev.created_by,
    created_at: ev.created_at,
    updated_at: ev.updated_at,
  };
}

export function taskJson(t: TaskRecord) {
  return { ...t };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 可选文本：undefined 不改；null 清空。 */
function optStr(body: Record<string, unknown>, key: string, errors: FieldError[], max: number): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') {
    errors.push({ field: key, message: '必须是文本' });
    return undefined;
  }
  if (v.length > max) {
    errors.push({ field: key, message: `不能超过 ${max} 字` });
    return undefined;
  }
  return v;
}

export function registerCalendarTaskRoutes(ctx: Ctx): void {
  const { app, repo } = ctx;

  // ---------------- 日历 ----------------

  /** 校验 10.2 的字段（partial = 修改）。返回规范化后的补丁。 */
  const checkEvent = async (body: Record<string, unknown>, partial: boolean, current?: CalendarEventRecord) => {
    const errors: FieldError[] = [];
    const patch: Partial<CalendarEventRecord> & { attendee_ids?: string[] } = {};
    if (body.title !== undefined || !partial) {
      if (typeof body.title !== 'string' || !body.title.trim()) errors.push({ field: 'title', message: '不能为空' });
      else if (body.title.length > 200) errors.push({ field: 'title', message: '不能超过 200 字' });
      else patch.title = body.title.trim();
    }
    for (const k of ['start_ms', 'end_ms'] as const) {
      if (body[k] !== undefined || !partial) {
        if (!isNum(body[k])) errors.push({ field: k, message: '必须是毫秒时间戳' });
        else patch[k] = Math.floor(body[k] as number);
      }
    }
    const start = patch.start_ms ?? current?.start_ms;
    const end = patch.end_ms ?? current?.end_ms;
    if (isNum(start) && isNum(end) && end <= start) errors.push({ field: 'end_ms', message: '结束时间必须晚于开始时间' });
    if (body.attendee_ids !== undefined && body.attendee_ids !== null) {
      if (!Array.isArray(body.attendee_ids) || body.attendee_ids.some((x) => typeof x !== 'string')) {
        errors.push({ field: 'attendee_ids', message: '必须是 user_id 列表' });
      } else {
        const ids = [...new Set(body.attendee_ids as string[])];
        const missing = await ctx.missingUsers(ids);
        if (missing.length) errors.push({ field: 'attendee_ids', message: `用户不存在：${missing.join('、')}` });
        else patch.attendee_ids = ids;
      }
    } else if (body.attendee_ids === null) patch.attendee_ids = [];
    const description = optStr(body, 'description', errors, 5000);
    if (description !== undefined) patch.description = description;
    const location = optStr(body, 'location', errors, 500);
    if (location !== undefined) patch.location = location;
    const color = optStr(body, 'color', errors, 32);
    if (color !== undefined) patch.color = color;
    if (body.all_day !== undefined) {
      if (typeof body.all_day !== 'boolean') errors.push({ field: 'all_day', message: '必须是 true / false' });
      else patch.all_day = body.all_day;
    }
    if (body.reminders !== undefined) {
      if (body.reminders === null) patch.reminders = null;
      else if (!Array.isArray(body.reminders) || body.reminders.some((x) => !isNum(x) || x < 0)) {
        errors.push({ field: 'reminders', message: '必须是提前提醒的分钟数列表' });
      } else patch.reminders = (body.reminders as number[]).map((x) => Math.floor(x));
    }
    return { errors, patch };
  };

  const notifyInvited = (ev: CalendarEventRecord, userIds: string[]) => {
    const targets = userIds.filter((id) => id !== ev.created_by);
    if (targets.length) ctx.publish('calendar.invited', { event: eventJson(ev) }, targets);
  };

  app.get('/api/v1/calendar/events', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { from, to, user_id } = req.query as { from?: string; to?: string; user_id?: string };
    const fromMs = Number(from);
    const toMs = Number(to);
    if (!from || !to || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return fail(reply, 400, '需要 from 和 to（毫秒时间戳）');
    }
    if (toMs <= fromMs) return invalid(reply, [{ field: 'to', message: '必须晚于 from' }]);
    if (toMs - fromMs > MAX_RANGE_MS) return invalid(reply, [{ field: 'to', message: '时间范围不能超过一年' }]);
    // 查看同事忙闲：只返回时间段，不返回标题等细节
    if (user_id && user_id !== me.sub) {
      if ((await ctx.missingUsers([user_id])).length) return fail(reply, 404, '用户不存在');
      const busy = await repo.listEvents(user_id, fromMs, toMs);
      return {
        items: busy
          .filter((e) => e.attendees.find((a) => a.user_id === user_id)?.rsvp !== 'declined')
          .map((e) => ({ start_ms: e.start_ms, end_ms: e.end_ms, all_day: e.all_day, busy: true, title: '忙碌' })),
      };
    }
    const items = await repo.listEvents(me.sub, fromMs, toMs);
    return { items: items.map(eventJson) };
  });

  app.post('/api/v1/calendar/events', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.title === undefined || body.start_ms === undefined || body.end_ms === undefined) {
      return fail(reply, 400, '缺少 title、start_ms 或 end_ms');
    }
    const { errors, patch } = await checkEvent(body, false);
    if (errors.length) return invalid(reply, errors);
    const now = nowIso();
    const ids = [me.sub, ...(patch.attendee_ids ?? []).filter((id) => id !== me.sub)];
    const ev: CalendarEventRecord = {
      event_id: newId('evt_cal'),
      title: patch.title!,
      start_ms: patch.start_ms!,
      end_ms: patch.end_ms!,
      attendees: ids.map((id) => ({ user_id: id, rsvp: id === me.sub ? 'accepted' : 'pending' })),
      description: patch.description ?? null,
      location: patch.location ?? null,
      all_day: patch.all_day ?? false,
      color: patch.color ?? null,
      reminders: patch.reminders ?? null,
      created_by: me.sub,
      created_at: now,
      updated_at: now,
    };
    await repo.saveEvent(ev);
    notifyInvited(ev, ids);
    return reply.code(201).send(eventJson(ev));
  });

  app.get('/api/v1/calendar/events/:event_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { event_id } = req.params as { event_id: string };
    const ev = await repo.getEvent(event_id);
    if (!ev || (ev.created_by !== me.sub && !ev.attendees.some((a) => a.user_id === me.sub))) {
      return fail(reply, 404, '日程不存在');
    }
    return eventJson(ev);
  });

  app.patch('/api/v1/calendar/events/:event_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { event_id } = req.params as { event_id: string };
    const ev = await repo.getEvent(event_id);
    if (!ev) return fail(reply, 404, '日程不存在');
    if (ev.created_by !== me.sub) return fail(reply, 403, '只有创建者可以修改日程');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { errors, patch } = await checkEvent(body, true, ev);
    if (errors.length) return invalid(reply, errors);
    const { attendee_ids, ...rest } = patch;
    const next: CalendarEventRecord = { ...ev, ...rest, updated_at: nowIso() };
    let added: string[] = [];
    if (attendee_ids) {
      const ids = [ev.created_by, ...attendee_ids.filter((id) => id !== ev.created_by)];
      const old = new Map(ev.attendees.map((a) => [a.user_id, a.rsvp]));
      next.attendees = ids.map((id) => ({ user_id: id, rsvp: old.get(id) ?? (id === ev.created_by ? 'accepted' : 'pending') }));
      added = ids.filter((id) => !old.has(id));
    }
    await repo.saveEvent(next);
    notifyInvited(next, added);
    return eventJson(next);
  });

  app.delete('/api/v1/calendar/events/:event_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { event_id } = req.params as { event_id: string };
    const ev = await repo.getEvent(event_id);
    if (!ev) return fail(reply, 404, '日程不存在');
    if (ev.created_by !== me.sub) return fail(reply, 403, '只有创建者可以删除日程');
    await repo.deleteEvent(event_id);
    return reply.code(204).send();
  });

  app.post('/api/v1/calendar/events/:event_id/rsvp', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { event_id } = req.params as { event_id: string };
    const ev = await repo.getEvent(event_id);
    if (!ev || !ev.attendees.some((a) => a.user_id === me.sub)) return fail(reply, 404, '日程不存在');
    const { rsvp } = (req.body ?? {}) as { rsvp?: unknown };
    if (typeof rsvp !== 'string' || !RSVPS.has(rsvp as Rsvp)) {
      return invalid(reply, [{ field: 'rsvp', message: '必须是以下之一：pending、accepted、declined、tentative' }]);
    }
    const next: CalendarEventRecord = {
      ...ev,
      attendees: ev.attendees.map((a) => (a.user_id === me.sub ? { ...a, rsvp: rsvp as Rsvp } : a)),
      updated_at: nowIso(),
    };
    await repo.saveEvent(next);
    return eventJson(next);
  });

  // ---------------- 任务 ----------------

  const checkTask = async (body: Record<string, unknown>, partial: boolean) => {
    const errors: FieldError[] = [];
    const patch: Partial<TaskRecord> = {};
    if (body.title !== undefined || !partial) {
      if (typeof body.title !== 'string' || !body.title.trim()) errors.push({ field: 'title', message: '不能为空' });
      else if (body.title.length > 200) errors.push({ field: 'title', message: '不能超过 200 字' });
      else patch.title = body.title.trim();
    }
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !TASK_STATUSES.has(body.status as TaskStatus)) {
        errors.push({ field: 'status', message: '必须是以下之一：pending、in_progress、done、cancelled' });
      } else patch.status = body.status as TaskStatus;
    }
    if (body.assignee_id !== undefined) {
      if (body.assignee_id === null || body.assignee_id === '') patch.assignee_id = null;
      else if (typeof body.assignee_id !== 'string') errors.push({ field: 'assignee_id', message: '必须是 user_id' });
      else if ((await ctx.missingUsers([body.assignee_id])).length) {
        errors.push({ field: 'assignee_id', message: `用户不存在：${body.assignee_id}` });
      } else patch.assignee_id = body.assignee_id;
    }
    if (body.due_ms !== undefined) {
      if (body.due_ms === null) patch.due_ms = null;
      else if (!isNum(body.due_ms)) errors.push({ field: 'due_ms', message: '必须是毫秒时间戳' });
      else patch.due_ms = Math.floor(body.due_ms);
    }
    const description = optStr(body, 'description', errors, 10000);
    if (description !== undefined) patch.description = description;
    if (body.priority !== undefined) {
      if (typeof body.priority !== 'string' || !PRIORITIES.has(body.priority as TaskPriority)) {
        errors.push({ field: 'priority', message: '必须是以下之一：low、normal、high、urgent' });
      } else patch.priority = body.priority as TaskPriority;
    }
    if (body.source !== undefined) {
      if (body.source !== null && (typeof body.source !== 'object' || Array.isArray(body.source))) {
        errors.push({ field: 'source', message: '必须是对象' });
      } else patch.source = body.source as Record<string, unknown> | null;
    }
    return { errors, patch };
  };

  const notifyAssigned = (task: TaskRecord, actorId: string) => {
    if (task.assignee_id && task.assignee_id !== actorId) {
      ctx.publish('task.assigned', { task: taskJson(task) }, [task.assignee_id]);
    }
  };

  app.get('/api/v1/tasks', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { assignee_id?: string; status?: string; created_by?: string };
    if (q.status && !TASK_STATUSES.has(q.status as TaskStatus)) {
      return invalid(reply, [{ field: 'status', message: '必须是以下之一：pending、in_progress、done、cancelled' }]);
    }
    const items = await repo.listTasks(me.sub, {
      assignee_id: q.assignee_id === 'me' ? me.sub : q.assignee_id || undefined,
      status: q.status || undefined,
      created_by: q.created_by === 'me' ? me.sub : q.created_by || undefined,
    });
    return { items: items.map(taskJson), has_more: false, total: items.length };
  });

  app.post('/api/v1/tasks', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.title === undefined) return fail(reply, 400, '缺少 title');
    const { errors, patch } = await checkTask(body, false);
    if (errors.length) return invalid(reply, errors);
    const now = nowIso();
    const status = patch.status ?? 'pending';
    const task: TaskRecord = {
      task_id: newId('task'),
      title: patch.title!,
      status,
      assignee_id: patch.assignee_id ?? null,
      due_ms: patch.due_ms ?? null,
      description: patch.description ?? null,
      priority: patch.priority ?? 'normal',
      source: patch.source ?? null,
      created_by: me.sub,
      created_at: now,
      updated_at: now,
      completed_at: status === 'done' ? now : null,
    };
    await repo.saveTask(task);
    notifyAssigned(task, me.sub);
    return reply.code(201).send(taskJson(task));
  });

  app.get('/api/v1/tasks/:task_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { task_id } = req.params as { task_id: string };
    const task = await repo.getTask(task_id);
    if (!task || (task.created_by !== me.sub && task.assignee_id !== me.sub)) return fail(reply, 404, '任务不存在');
    return taskJson(task);
  });

  app.patch('/api/v1/tasks/:task_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { task_id } = req.params as { task_id: string };
    const task = await repo.getTask(task_id);
    if (!task) return fail(reply, 404, '任务不存在');
    if (task.created_by !== me.sub && task.assignee_id !== me.sub) {
      return fail(reply, 403, '只有创建者或负责人可以修改任务');
    }
    const { errors, patch } = await checkTask((req.body ?? {}) as Record<string, unknown>, true);
    if (errors.length) return invalid(reply, errors);
    const now = nowIso();
    const next: TaskRecord = { ...task, ...patch, updated_at: now };
    if (patch.status !== undefined && patch.status !== task.status) {
      next.completed_at = patch.status === 'done' ? now : null;
    }
    await repo.saveTask(next);
    if (patch.assignee_id !== undefined && patch.assignee_id !== task.assignee_id) notifyAssigned(next, me.sub);
    return taskJson(next);
  });

  app.delete('/api/v1/tasks/:task_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { task_id } = req.params as { task_id: string };
    const task = await repo.getTask(task_id);
    if (!task || (task.created_by !== me.sub && task.assignee_id !== me.sub)) return fail(reply, 404, '任务不存在');
    if (task.created_by !== me.sub) return fail(reply, 403, '只有创建者可以删除任务');
    await repo.deleteTask(task_id);
    return reply.code(204).send();
  });
}
