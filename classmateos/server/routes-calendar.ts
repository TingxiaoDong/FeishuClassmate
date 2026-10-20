/**
 * 日历（一期第 10 节）+ 二期 R-CA-01 重复日程。
 *
 * 存储模型：
 *   - 普通日程：recurrence 为 null 的一行。
 *   - 重复系列：一行「主日程」（recurrence = RRULE，start_ms/end_ms = 第一次），查询时按时间窗展开；
 *     被删掉或被单独修改的实例记在主日程的 exdates（原始开始时间）。
 *   - 例外实例：单独修改过的那一次，独立一行，recurring_event_id = 主日程，original_start_ms = 原始开始时间。
 * 实例 ID（不透明）：`<主日程 ID>_r<原始开始毫秒>`；第一次也可以直接用主日程 ID。
 * 时区：每条日程可带 IANA `timezone`，重复规则按它的本地时间展开（含夏令时）；没带用服务器默认日历时区。
 * 一致性：一次修改 / 删除涉及多条数据时用 repo.commitEvents 原子提交，并要求主日程仍是读取时的版本，
 *        否则返回 409 EVENT_CONFLICT，前端重新拉取后再试。
 */

import { fail, invalid, newId, type Ctx, type FieldError } from './context.js';
import { nowIso, type CalendarEventRecord, type Rsvp } from './repo.js';
import {
  RRuleError,
  expandInWindow,
  isValidTimeZone,
  isOccurrence,
  occurrences,
  parseRRule,
  remainderRule,
  truncateRule,
  type RRule,
  type Zone,
} from './rrule.js';

const RSVPS = new Set<Rsvp>(['pending', 'accepted', 'declined', 'tentative']);
const MAX_RANGE_MS = 366 * 24 * 3600_000;
const SCOPES = new Set(['this', 'following', 'all']);
type Scope = 'this' | 'following' | 'all';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 普通日程 / 例外实例 / 主日程（作为第一次）的输出。master 用于给实例补系列信息。 */
export function eventJson(ev: CalendarEventRecord, master?: CalendarEventRecord, defaultZone: Zone = 'Asia/Shanghai') {
  const series = master ?? (ev.recurrence ? ev : undefined);
  const tz = ev.timezone ?? series?.timezone ?? (typeof defaultZone === 'string' ? defaultZone : null);
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
    recurrence: series?.recurrence ?? null,
    recurring_event_id: series ? series.event_id : null,
    original_start_ms: ev.recurring_event_id ? (ev.original_start_ms ?? ev.start_ms) : series ? ev.start_ms : null,
    is_exception: !!ev.recurring_event_id,
    timezone: tz,
  };
}

/** 系列里原始开始时间为 t 的那一次（虚拟实例）。 */
function instanceJson(master: CalendarEventRecord, t: number, defaultZone?: Zone) {
  const dur = master.end_ms - master.start_ms;
  return {
    ...eventJson({ ...master, start_ms: t, end_ms: t + dur }, master, defaultZone),
    event_id: t === master.start_ms ? master.event_id : instanceId(master.event_id, t),
    original_start_ms: t,
  };
}

const instanceId = (masterId: string, t: number) => `${masterId}_r${t}`;

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

type Patch = Partial<CalendarEventRecord> & { attendee_ids?: string[] };

/** 解析后的目标：普通日程 / 系列主日程上的某一次 / 例外实例。 */
type Target =
  | { kind: 'single'; ev: CalendarEventRecord }
  | { kind: 'instance'; master: CalendarEventRecord; t: number; viaMasterId: boolean }
  | { kind: 'exception'; ev: CalendarEventRecord; master: CalendarEventRecord };

export function registerCalendarRoutes(ctx: Ctx, opts: { defaultZone: () => Zone }): void {
  const { app, repo } = ctx;
  const zoneOf = (ev: { timezone?: string | null }): Zone => ev.timezone ?? opts.defaultZone();
  const J = (ev: CalendarEventRecord, master?: CalendarEventRecord) => eventJson(ev, master, opts.defaultZone());
  const IJ = (master: CalendarEventRecord, t: number) => instanceJson(master, t, opts.defaultZone());
  /** 保证新的 updated_at 和旧值不同（并发检查依赖它）。 */
  const stamp = (prev?: string) => {
    let n = nowIso();
    if (prev && n <= prev) n = new Date(Date.parse(prev) + 1).toISOString();
    return n;
  };
  const conflict = (reply: Parameters<typeof fail>[0]) =>
    reply.code(409).send({ code: 'EVENT_CONFLICT', message: '这个日程刚被别人修改过，请刷新后再试' });

  const rule = (ev: CalendarEventRecord): RRule => parseRRule(ev.recurrence!, zoneOf(ev));

  /** 校验 10.2 的字段（partial = 修改）。返回规范化后的补丁。 */
  const checkEvent = async (body: Record<string, unknown>, partial: boolean, current?: { start_ms: number; end_ms: number; timezone?: string | null }) => {
    const errors: FieldError[] = [];
    const patch: Patch = {};
    if (body.timezone !== undefined) {
      if (body.timezone === null || body.timezone === '') patch.timezone = null;
      else if (!isValidTimeZone(body.timezone)) errors.push({ field: 'timezone', message: '必须是 IANA 时区名，如 Asia/Shanghai' });
      else patch.timezone = body.timezone;
    }
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
    // recurrence：undefined 不改；null 取消重复；字符串 = 新规则
    let recurrence: string | null | undefined;
    if (body.recurrence !== undefined) {
      if (body.recurrence === null || body.recurrence === '') recurrence = null;
      else if (typeof body.recurrence !== 'string' || body.recurrence.length > 500) {
        errors.push({ field: 'recurrence', message: '必须是 RRULE 文本（不超过 500 字）或 null' });
      } else {
        try {
          parseRRule(body.recurrence, zoneOf({ timezone: patch.timezone !== undefined ? patch.timezone : current?.timezone }));
          recurrence = body.recurrence.trim().replace(/^RRULE:/i, '');
        } catch (e) {
          errors.push({ field: 'recurrence', message: e instanceof RRuleError ? e.message : '重复规则无效' });
        }
      }
    }
    return { errors, patch, recurrence };
  };

  /** 新规则下 start 不是其中一次时，挪到第一次（RFC：DTSTART 应该是第一次）。 */
  const alignStart = (ev: CalendarEventRecord): string | null => {
    if (!ev.recurrence) return null;
    const r = rule(ev);
    const dur = ev.end_ms - ev.start_ms;
    const first = occurrences(r, ev.start_ms, zoneOf(ev)).next();
    if (first.done) return '按这个重复规则，一次日程都不会出现';
    ev.start_ms = first.value;
    ev.end_ms = first.value + dur;
    return null;
  };

  const notifyInvited = (ev: CalendarEventRecord, userIds: string[]) => {
    const targets = userIds.filter((id) => id !== ev.created_by);
    if (targets.length) ctx.publish('calendar.invited', { event: J(ev) }, targets);
  };

  const participant = (ev: CalendarEventRecord, uid: string) => ev.created_by === uid || ev.attendees.some((a) => a.user_id === uid);

  /** 按 ID 找到目标；找不到 / 实例不存在返回 undefined。 */
  const resolve = async (id: string): Promise<Target | undefined> => {
    const ev = await repo.getEvent(id);
    if (ev) {
      if (ev.recurring_event_id) {
        const master = await repo.getEvent(ev.recurring_event_id);
        return master ? { kind: 'exception', ev, master } : { kind: 'single', ev };
      }
      if (ev.recurrence) return { kind: 'instance', master: ev, t: ev.start_ms, viaMasterId: true };
      return { kind: 'single', ev };
    }
    const m = /^(.+)_r(\d+)$/.exec(id);
    if (!m) return undefined;
    const master = await repo.getEvent(m[1]);
    const t = Number(m[2]);
    if (!master?.recurrence || (master.exdates ?? []).includes(t)) return undefined;
    try {
      if (!isOccurrence(rule(master), master.start_ms, zoneOf(master), t)) return undefined;
    } catch {
      return undefined;
    }
    return { kind: 'instance', master, t, viaMasterId: false };
  };

  const seriesOf = (tg: Target) => (tg.kind === 'single' ? tg.ev : tg.master);

  /** 时间窗内用户能看到的全部日程（普通 + 例外 + 展开后的实例）。 */
  const listWindow = async (userId: string, fromMs: number, toMs: number) => {
    const singles = await repo.listEvents(userId, fromMs, toMs);
    const masters = new Map((await repo.listRecurringEvents(userId, toMs)).map((m) => [m.event_id, m]));
    const out: Array<ReturnType<typeof eventJson>> = [];
    for (const ev of singles) {
      if (ev.recurring_event_id) {
        const master = masters.get(ev.recurring_event_id) ?? (await repo.getEvent(ev.recurring_event_id));
        out.push(J(ev, master?.recurrence ? master : undefined));
      } else out.push(J(ev));
    }
    for (const m of masters.values()) {
      let starts: number[];
      try {
        starts = expandInWindow(rule(m), m.start_ms, m.end_ms - m.start_ms, zoneOf(m), fromMs, toMs);
      } catch {
        starts = [m.start_ms]; // 规则损坏时至少显示第一次，不让整张日历出错
      }
      const ex = new Set(m.exdates ?? []);
      for (const t of starts) if (!ex.has(t)) out.push(IJ(m, t));
    }
    return out.sort((a, b) => a.start_ms - b.start_ms || a.event_id.localeCompare(b.event_id));
  };

  app.get('/api/v1/calendar/events', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    // 一期 from/to 与二期 start_ms/end_ms 两套参数都接受
    const q = req.query as { from?: string; to?: string; start_ms?: string; end_ms?: string; user_id?: string };
    const fromRaw = q.start_ms ?? q.from;
    const toRaw = q.end_ms ?? q.to;
    const fromMs = Number(fromRaw);
    const toMs = Number(toRaw);
    if (!fromRaw || !toRaw || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return fail(reply, 400, '需要 start_ms 和 end_ms（或 from 和 to，毫秒时间戳）');
    }
    if (toMs <= fromMs) return invalid(reply, [{ field: q.end_ms ? 'end_ms' : 'to', message: '必须晚于开始时间' }]);
    if (toMs - fromMs > MAX_RANGE_MS) return invalid(reply, [{ field: q.end_ms ? 'end_ms' : 'to', message: '时间范围不能超过一年' }]);
    // 查看同事忙闲：只返回时间段，不返回标题等细节
    if (q.user_id && q.user_id !== me.sub) {
      if ((await ctx.missingUsers([q.user_id])).length) return fail(reply, 404, '用户不存在');
      const busy = await listWindow(q.user_id, fromMs, toMs);
      return {
        items: busy
          .filter((e) => e.attendees.find((a) => a.user_id === q.user_id)?.rsvp !== 'declined')
          .map((e) => ({ start_ms: e.start_ms, end_ms: e.end_ms, all_day: e.all_day, busy: true, title: '忙碌' })),
      };
    }
    return { items: await listWindow(me.sub, fromMs, toMs) };
  });

  app.post('/api/v1/calendar/events', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.title === undefined || body.start_ms === undefined || body.end_ms === undefined) {
      return fail(reply, 400, '缺少 title、start_ms 或 end_ms');
    }
    const { errors, patch, recurrence } = await checkEvent(body, false);
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
      timezone: patch.timezone ?? null,
      created_by: me.sub,
      created_at: now,
      updated_at: now,
      recurrence: recurrence ?? null,
      recurring_event_id: null,
      original_start_ms: null,
      exdates: [],
    };
    const bad = alignStart(ev);
    if (bad) return invalid(reply, [{ field: 'recurrence', message: bad }]);
    await repo.saveEvent(ev);
    notifyInvited(ev, ids);
    return reply.code(201).send(J(ev));
  });

  app.get('/api/v1/calendar/events/:event_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const tg = await resolve((req.params as { event_id: string }).event_id);
    if (!tg || !participant(tg.kind === 'exception' ? tg.ev : seriesOf(tg), me.sub)) return fail(reply, 404, '日程不存在');
    if (tg.kind === 'single') return J(tg.ev);
    if (tg.kind === 'exception') return J(tg.ev, tg.master);
    return IJ(tg.master, tg.t);
  });

  const parseScope = (raw: unknown, tg: Target): Scope | null => {
    if (raw === undefined || raw === '') return tg.kind === 'instance' && tg.viaMasterId ? 'all' : 'this';
    return typeof raw === 'string' && SCOPES.has(raw) ? (raw as Scope) : null;
  };

  /** 新参与人列表（保留已有回复）。 */
  const withAttendees = (base: CalendarEventRecord, ids: string[]) => {
    const all = [base.created_by, ...ids.filter((id) => id !== base.created_by)];
    const old = new Map(base.attendees.map((a) => [a.user_id, a.rsvp]));
    return {
      attendees: all.map((id) => ({ user_id: id, rsvp: old.get(id) ?? (id === base.created_by ? 'accepted' : 'pending') as Rsvp })),
      added: all.filter((id) => !old.has(id)),
    };
  };

  /** 只取非时间、非参与人的字段（用于「全部」时同步到例外实例）。 */
  const plainFields = (p: Patch) => {
    const { start_ms: _s, end_ms: _e, attendee_ids: _a, ...rest } = p;
    return rest;
  };

  app.patch('/api/v1/calendar/events/:event_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const tg = await resolve((req.params as { event_id: string }).event_id);
    if (!tg) return fail(reply, 404, '日程不存在');
    const series = seriesOf(tg);
    if (series.created_by !== me.sub) {
      return participant(tg.kind === 'exception' ? tg.ev : series, me.sub)
        ? fail(reply, 403, '只有创建者可以修改日程')
        : fail(reply, 404, '日程不存在');
    }
    const scope = parseScope((req.query as { scope?: string }).scope, tg);
    if (!scope) return invalid(reply, [{ field: 'scope', message: '必须是以下之一：this、following、all' }]);
    // 当前这一次的时间（虚拟实例 / 例外 / 普通日程）
    const cur =
      tg.kind === 'instance'
        ? { start_ms: tg.t, end_ms: tg.t + tg.master.end_ms - tg.master.start_ms, timezone: tg.master.timezone }
        : { start_ms: tg.ev.start_ms, end_ms: tg.ev.end_ms, timezone: tg.kind === 'exception' ? tg.master.timezone : tg.ev.timezone };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { errors, patch, recurrence } = await checkEvent(body, true, cur);
    if (errors.length) return invalid(reply, errors);
    const now = stamp(series.updated_at);
    const { attendee_ids, start_ms: _ns, end_ms: _ne, ...rest } = patch;
    const newStart = patch.start_ms ?? cur.start_ms;
    const newEnd = patch.end_ms ?? cur.end_ms;
    const delta = newStart - cur.start_ms;

    // ---- 普通日程 ----
    if (tg.kind === 'single') {
      const next: CalendarEventRecord = { ...tg.ev, ...rest, start_ms: newStart, end_ms: newEnd, updated_at: now };
      let added: string[] = [];
      if (attendee_ids) ({ attendees: next.attendees, added } = withAttendees(tg.ev, attendee_ids));
      if (recurrence !== undefined) {
        if (tg.ev.recurring_event_id) return invalid(reply, [{ field: 'recurrence', message: '这条日程已经脱离原来的重复系列，不能单独设置重复' }]);
        next.recurrence = recurrence;
        next.exdates = [];
        const bad = alignStart(next);
        if (bad) return invalid(reply, [{ field: 'recurrence', message: bad }]);
      }
      if (!(await repo.commitEvents({ expect: { event_id: tg.ev.event_id, updated_at: tg.ev.updated_at }, save: [next], remove: [] }))) return conflict(reply);
      notifyInvited(next, added);
      return J(next);
    }

    const master = tg.master;
    const t = tg.kind === 'instance' ? tg.t : (tg.ev.original_start_ms ?? tg.ev.start_ms);

    // ---- 仅此一次 ----
    if (scope === 'this') {
      if (recurrence !== undefined && recurrence !== master.recurrence) {
        return invalid(reply, [{ field: 'recurrence', message: '只修改这一次时不能改重复规则，请选择「此后全部」或「全部」' }], );
      }
      const base: CalendarEventRecord =
        tg.kind === 'exception'
          ? tg.ev
          : { ...master, event_id: newId('evt_cal'), start_ms: t, end_ms: cur.end_ms, recurrence: null, recurring_event_id: master.event_id, original_start_ms: t, exdates: [], created_at: now };
      const next: CalendarEventRecord = { ...base, ...rest, start_ms: newStart, end_ms: newEnd, updated_at: now };
      let added: string[] = [];
      if (attendee_ids) ({ attendees: next.attendees, added } = withAttendees(base, attendee_ids));
      // 例外实例不带时区，跟随系列
      next.timezone = null;
      if (patch.timezone !== undefined && patch.timezone !== (master.timezone ?? null)) {
        return invalid(reply, [{ field: 'timezone', message: '只修改这一次时不能改时区，请选择「全部」' }]);
      }
      const save = [next];
      if (tg.kind === 'instance') save.unshift({ ...master, exdates: [...new Set([...(master.exdates ?? []), t])], updated_at: now });
      const ok = await repo.commitEvents({ expect: { event_id: master.event_id, updated_at: master.updated_at }, save, remove: [] });
      if (!ok) return conflict(reply);
      notifyInvited(next, added);
      return J(next, tg.kind === 'instance' ? save[0] : master);
    }

    const exceptions = await repo.listEventExceptions(master.event_id);
    const dur = newEnd - newStart;
    // 换时区会让每一次的 UTC 时间都变，已有的例外 / 排除日期对不上，按改规则处理
    const zoneChanged = patch.timezone !== undefined && (patch.timezone ?? null) !== (master.timezone ?? null);
    const ruleChanged = (recurrence !== undefined && recurrence !== master.recurrence) || zoneChanged;

    // ---- 全部（或「此后全部」但这是第一次）----
    if (scope === 'all' || t <= master.start_ms) {
      const next: CalendarEventRecord = { ...master, ...rest, updated_at: now };
      let added: string[] = [];
      if (attendee_ids) ({ attendees: next.attendees, added } = withAttendees(master, attendee_ids));
      const removeExceptions: string[] = [];
      const updateExceptions: CalendarEventRecord[] = [];
      if (recurrence === null) {
        // 取消重复：只保留正在编辑的这一次（按新时间），其余实例和例外都删掉
        Object.assign(next, { start_ms: newStart, end_ms: newEnd, recurrence: null, exdates: [] });
        for (const e of exceptions) removeExceptions.push(e.event_id);
      } else {
        next.start_ms = master.start_ms + delta;
        next.end_ms = next.start_ms + dur;
        if (ruleChanged) {
          next.recurrence = recurrence ?? master.recurrence;
          next.exdates = [];
          for (const e of exceptions) removeExceptions.push(e.event_id);
        } else {
          next.exdates = (master.exdates ?? []).map((x) => x + delta);
          for (const e of exceptions) {
            const shifted: CalendarEventRecord = { ...e, ...plainFields(patch), original_start_ms: (e.original_start_ms ?? e.start_ms) + delta, updated_at: now };
            if (attendee_ids) shifted.attendees = withAttendees(e, attendee_ids).attendees;
            updateExceptions.push(shifted);
          }
        }
        const bad = alignStart(next);
        if (bad) return invalid(reply, [{ field: 'recurrence', message: bad }]);
      }
      const committed = await repo.commitEvents({ expect: { event_id: master.event_id, updated_at: master.updated_at }, save: [next, ...updateExceptions], remove: removeExceptions });
      if (!committed) return conflict(reply);
      notifyInvited(next, added);
      if (!next.recurrence) return J(next);
      const at = t + delta;
      const ok = !(next.exdates ?? []).includes(at) && isOccurrence(rule(next), next.start_ms, zoneOf(next), at);
      return IJ(next, ok ? at : next.start_ms);
    }

    // ---- 此后全部：拆成两个系列 ----
    const r = rule(master);
    const head: CalendarEventRecord = {
      ...master,
      recurrence: truncateRule(master.recurrence!, r, master.start_ms, zoneOf(master), t),
      exdates: (master.exdates ?? []).filter((x) => x < t),
      updated_at: now,
    };
    const tail: CalendarEventRecord = {
      ...master,
      ...rest,
      event_id: newId('evt_cal'),
      start_ms: newStart,
      end_ms: newEnd,
      recurrence: ruleChanged && recurrence !== undefined ? recurrence : remainderRule(master.recurrence!, r, master.start_ms, zoneOf(master), t),
      exdates: ruleChanged ? [] : (master.exdates ?? []).filter((x) => x >= t).map((x) => x + delta),
      created_at: now,
      updated_at: now,
    };
    let added: string[] = [];
    if (attendee_ids) ({ attendees: tail.attendees, added } = withAttendees(master, attendee_ids));
    const bad = alignStart(tail);
    if (bad) return invalid(reply, [{ field: 'recurrence', message: bad }]);
    const save: CalendarEventRecord[] = [head, tail];
    const remove: string[] = [];
    for (const e of exceptions) {
      const o = e.original_start_ms ?? e.start_ms;
      if (o < t) continue;
      if (ruleChanged || !tail.recurrence) remove.push(e.event_id);
      else {
        const moved: CalendarEventRecord = { ...e, ...plainFields(patch), timezone: null, recurring_event_id: tail.event_id, original_start_ms: o + delta, updated_at: now };
        if (attendee_ids) moved.attendees = withAttendees(e, attendee_ids).attendees;
        save.push(moved);
      }
    }
    if (!(await repo.commitEvents({ expect: { event_id: master.event_id, updated_at: master.updated_at }, save, remove }))) return conflict(reply);
    notifyInvited(tail, added);
    return tail.recurrence ? IJ(tail, tail.start_ms) : J(tail);
  });

  app.delete('/api/v1/calendar/events/:event_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const tg = await resolve((req.params as { event_id: string }).event_id);
    if (!tg) return fail(reply, 404, '日程不存在');
    const series = seriesOf(tg);
    if (series.created_by !== me.sub) {
      return participant(tg.kind === 'exception' ? tg.ev : series, me.sub)
        ? fail(reply, 403, '只有创建者可以删除日程')
        : fail(reply, 404, '日程不存在');
    }
    const scope = parseScope((req.query as { scope?: string }).scope, tg);
    if (!scope) return invalid(reply, [{ field: 'scope', message: '必须是以下之一：this、following、all' }]);
    if (tg.kind === 'single') {
      await repo.deleteEvent(tg.ev.event_id);
      return reply.code(204).send();
    }
    const master = tg.master;
    const t = tg.kind === 'instance' ? tg.t : (tg.ev.original_start_ms ?? tg.ev.start_ms);
    const now = stamp(master.updated_at);
    const expect = { event_id: master.event_id, updated_at: master.updated_at };
    const done = (ok: boolean) => (ok ? reply.code(204).send() : conflict(reply));
    if (scope === 'this') {
      // 例外实例的原始时间已在 exdates 里，只删它自己；同时校验系列没被别人改过
      if (tg.kind === 'exception') return done(await repo.commitEvents({ expect, save: [], remove: [tg.ev.event_id] }));
      return done(await repo.commitEvents({ expect, save: [{ ...master, exdates: [...new Set([...(master.exdates ?? []), t])], updated_at: now }], remove: [] }));
    }
    const exceptions = await repo.listEventExceptions(master.event_id);
    if (scope === 'all' || t <= master.start_ms) {
      return done(await repo.commitEvents({ expect, save: [], remove: [...exceptions.map((e) => e.event_id), master.event_id] }));
    }
    return done(await repo.commitEvents({
      expect,
      save: [{
        ...master,
        recurrence: truncateRule(master.recurrence!, rule(master), master.start_ms, zoneOf(master), t),
        exdates: (master.exdates ?? []).filter((x) => x < t),
        updated_at: now,
      }],
      remove: exceptions.filter((e) => (e.original_start_ms ?? e.start_ms) >= t).map((e) => e.event_id),
    }));
  });

  app.post('/api/v1/calendar/events/:event_id/rsvp', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const tg = await resolve((req.params as { event_id: string }).event_id);
    // 虚拟实例的回复记在整个系列上；例外实例单独记
    const ev = tg ? (tg.kind === 'exception' ? tg.ev : seriesOf(tg)) : undefined;
    if (!tg || !ev || !ev.attendees.some((a) => a.user_id === me.sub)) return fail(reply, 404, '日程不存在');
    const { rsvp } = (req.body ?? {}) as { rsvp?: unknown };
    if (typeof rsvp !== 'string' || !RSVPS.has(rsvp as Rsvp)) {
      return invalid(reply, [{ field: 'rsvp', message: '必须是以下之一：pending、accepted、declined、tentative' }]);
    }
    const next: CalendarEventRecord = {
      ...ev,
      attendees: ev.attendees.map((a) => (a.user_id === me.sub ? { ...a, rsvp: rsvp as Rsvp } : a)),
      updated_at: stamp(ev.updated_at),
    };
    if (!(await repo.commitEvents({ expect: { event_id: ev.event_id, updated_at: ev.updated_at }, save: [next], remove: [] }))) return conflict(reply);
    if (tg.kind === 'exception') return J(next, tg.master);
    if (tg.kind === 'instance') return IJ(next, tg.t);
    return J(next);
  });
}
