/**
 * 通知中心与手机推送（《二期功能需求文档》R-NT-01 / R-NT-02）。
 *
 *   GET  /notifications?filter=all|mention&page_size=&page_token=
 *   GET  /notifications/unread-count            → { count }
 *   POST /notifications/read  { ids } | { all: true }  → { updated, count }
 *   GET/PUT /users/me/notification-settings
 *
 * 通知来源（迭代 1）：任务指派（task.assigned）、日程邀请（calendar.invited）、任务即将到期（扫描）。
 * 其他模块（文档评论、审批……）以后调用 NotificationService.notify 即可。
 * 消息（IM）的未读不进通知中心，只走推送。
 *
 * 推送规则（PushDispatcher，消息推送和通知推送共用）：
 *   总开关 → 分类开关 → 免打扰时段 → 「桌面端在线时手机不推送」→ 「通知显示消息内容」。
 */

import type { Ctx } from './context.js';
import { fail, invalid, newId, pageOffset, pageResult, pageSize, type FieldError } from './context.js';
import type { PushMessage, PushProvider } from './push.js';
import { nowIso, type DevicePlatform, type NotificationRecord, type NotificationSettings, type Repo, type TaskRecord } from './repo.js';
import type { Clock } from './view-engine.js';

export const NOTIFY_CATEGORIES = ['message', 'mention', 'approval', 'task', 'calendar', 'comment'] as const;
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number];

export function defaultSettings(): NotificationSettings {
  return {
    enabled: true,
    categories: Object.fromEntries(NOTIFY_CATEGORIES.map((c) => [c, true])),
    dnd: { enabled: false, start: '23:00', end: '08:00' },
    mute_mobile_when_desktop_online: true,
    show_preview: true,
  };
}

/** 通知类型 → 设置里的分类。 */
export function categoryOf(type: string): NotifyCategory {
  if (type.endsWith('.mention')) return 'mention';
  if (type.startsWith('approval.')) return 'approval';
  if (type.startsWith('task.')) return type === 'task.comment' ? 'comment' : 'task';
  if (type.startsWith('calendar.')) return 'calendar';
  if (type.endsWith('.comment') || type === 'doc.access_request') return 'comment';
  return 'message';
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** PUT 请求体：缺的项沿用当前设置，不认识的分类忽略。 */
export function parseSettings(raw: unknown, base: NotificationSettings, errors: FieldError[]): NotificationSettings | undefined {
  if (!isObj(raw)) {
    errors.push({ field: 'body', message: '请求体必须是 JSON 对象' });
    return undefined;
  }
  const out: NotificationSettings = structuredClone(base);
  const bool = (k: 'enabled' | 'mute_mobile_when_desktop_online' | 'show_preview') => {
    if (raw[k] === undefined) return;
    if (typeof raw[k] !== 'boolean') errors.push({ field: k, message: '必须是 true 或 false' });
    else out[k] = raw[k] as boolean;
  };
  bool('enabled');
  bool('mute_mobile_when_desktop_online');
  bool('show_preview');
  if (raw.categories !== undefined) {
    if (!isObj(raw.categories)) errors.push({ field: 'categories', message: '必须是「分类 → true/false」对象' });
    else {
      for (const [k, v] of Object.entries(raw.categories)) {
        if (!(NOTIFY_CATEGORIES as readonly string[]).includes(k)) continue;
        if (typeof v !== 'boolean') errors.push({ field: `categories.${k}`, message: '必须是 true 或 false' });
        else out.categories[k] = v;
      }
    }
  }
  if (raw.dnd !== undefined) {
    if (!isObj(raw.dnd)) errors.push({ field: 'dnd', message: '必须是对象' });
    else {
      if (raw.dnd.enabled !== undefined) {
        if (typeof raw.dnd.enabled !== 'boolean') errors.push({ field: 'dnd.enabled', message: '必须是 true 或 false' });
        else out.dnd.enabled = raw.dnd.enabled;
      }
      for (const k of ['start', 'end'] as const) {
        if (raw.dnd[k] === undefined) continue;
        if (typeof raw.dnd[k] !== 'string' || !HHMM.test(raw.dnd[k] as string)) {
          errors.push({ field: `dnd.${k}`, message: '时间格式应为 HH:MM，如 23:00' });
        } else out.dnd[k] = raw.dnd[k] as string;
      }
    }
  }
  return errors.length ? undefined : out;
}

// ---------------- 在线状态 ----------------

/** 用户 WS 连接的端（?platform=macos|windows|linux|web|ios|android），供「桌面端在线时手机不推送」判断。 */
export class Presence {
  private readonly conns = new Map<string, Map<string, number>>();

  add(userId: string, platform: string): () => void {
    let m = this.conns.get(userId);
    if (!m) this.conns.set(userId, (m = new Map()));
    m.set(platform, (m.get(platform) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (m!.get(platform) ?? 1) - 1;
      if (n <= 0) m!.delete(platform);
      else m!.set(platform, n);
      if (m!.size === 0) this.conns.delete(userId);
    };
  }

  desktopOnline(userId: string): boolean {
    const m = this.conns.get(userId);
    return !!m && ['macos', 'windows', 'linux', 'desktop'].some((p) => m.has(p));
  }
}

// ---------------- 推送 ----------------

export class PushDispatcher {
  constructor(
    private readonly repo: Repo,
    private readonly provider: PushProvider,
    private readonly presence: Presence,
    private readonly clock: Clock,
  ) {}

  async settingsOf(userId: string): Promise<NotificationSettings> {
    const s = await this.repo.getNotificationSettings(userId);
    if (!s) return defaultSettings();
    const d = defaultSettings();
    return { ...d, ...s, categories: { ...d.categories, ...s.categories }, dnd: { ...d.dnd, ...s.dnd } };
  }

  inDnd(s: NotificationSettings, at = this.clock.now()): boolean {
    if (!s.dnd.enabled) return false;
    const p = this.clock.parts(at);
    const cur = p.h * 60 + p.min;
    const [sh, sm] = s.dnd.start.split(':').map(Number);
    const [eh, em] = s.dnd.end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start === end) return false;
    return start < end ? cur >= start && cur < end : cur >= start || cur < end;
  }

  /**
   * 给这些用户的设备推送。msg.body 是带内容的正文；用户关了「显示内容」时换成 hiddenBody。
   * 返回实际推送的设备数（测试用）。
   */
  async push(userIds: string[], category: NotifyCategory, msg: PushMessage, hiddenBody: string): Promise<number> {
    let sent = 0;
    for (const uid of new Set(userIds)) {
      const s = await this.settingsOf(uid);
      if (!s.enabled || s.categories[category] === false || this.inDnd(s)) continue;
      const desktop = this.presence.desktopOnline(uid);
      for (const d of await this.repo.listDevices([uid])) {
        const mobile = d.platform === 'ios' || d.platform === 'android';
        if (desktop && (mobile ? s.mute_mobile_when_desktop_online : true)) continue; // 桌面在线：桌面自己有 WS，不推
        sent++;
        void this.provider
          .send(d.device_token, d.platform as DevicePlatform, s.show_preview ? msg : { ...msg, body: hiddenBody })
          .catch(() => undefined);
      }
    }
    return sent;
  }
}

// ---------------- 通知服务 ----------------

export interface NotifyInput {
  user_id: string;
  type: string;
  actor_id: string | null;
  title: string;
  summary?: string;
  target: Record<string, unknown>;
  dedupe_key?: string | null;
}

export function notificationJson(n: NotificationRecord) {
  return {
    notification_id: n.notification_id,
    type: n.type,
    actor_id: n.actor_id,
    title: n.title,
    summary: n.summary,
    target: n.target,
    read: n.read,
    created_at: n.created_at,
  };
}

export class NotificationService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly ctx: Ctx,
    private readonly push: PushDispatcher,
    private readonly clock: Clock,
  ) {}

  /** 写入通知 + 推 notification.new + 手机推送。机器人 / 系统账号不收通知。 */
  async notify(input: NotifyInput): Promise<NotificationRecord | undefined> {
    if (input.user_id === 'bot' || input.user_id === 'system') return undefined;
    if (!(await this.ctx.repo.getUser(input.user_id))) return undefined;
    const n: NotificationRecord = {
      notification_id: newId('ntf'),
      user_id: input.user_id,
      type: input.type,
      actor_id: input.actor_id,
      title: input.title.slice(0, 200),
      summary: (input.summary ?? '').slice(0, 500),
      target: input.target,
      read: false,
      created_at: nowIso(),
      dedupe_key: input.dedupe_key ?? null,
    };
    if (!(await this.ctx.repo.insertNotification(n))) return undefined;
    this.ctx.publish('notification.new', { notification: notificationJson(n) }, [n.user_id], { user_only: true });
    await this.push.push(
      [n.user_id],
      categoryOf(n.type),
      { title: '飞书同学', body: n.title, data: { notification_id: n.notification_id, target: JSON.stringify(n.target) } },
      '你有一条新通知',
    );
    return n;
  }

  fmtTime(ms: number): string {
    const p = this.clock.parts(ms);
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${p.m + 1}月${p.d}日 ${pad(p.h)}:${pad(p.min)}`;
  }

  /** 任务即将到期（24 小时内）：每个任务每个截止时间只提醒一次。 */
  async scanDueSoon(now = this.clock.now()): Promise<number> {
    let n = 0;
    for (const t of await this.ctx.repo.listTasksDueBetween(now, now + 24 * 3600_000)) {
      if (!t.assignee_id || t.due_ms == null) continue;
      const hit = await this.notify({
        user_id: t.assignee_id,
        type: 'task.due_soon',
        actor_id: null,
        title: `任务「${t.title}」即将到期`,
        summary: `截止时间：${this.fmtTime(t.due_ms)}`,
        target: { type: 'task', id: t.task_id },
        dedupe_key: `task.due_soon:${t.task_id}:${t.due_ms}`,
      });
      if (hit) n++;
    }
    return n;
  }

  startScanner(intervalMs = 5 * 60_000): void {
    const run = () => void this.scanDueSoon().catch(() => undefined);
    const first = setTimeout(run, 10_000);
    first.unref?.();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 把已有的事件（任务指派、日程邀请）转成通知。 */
  attachEventSources(): void {
    this.ctx.eventBus.subscribe((e) => {
      if (e.event_type === 'task.assigned' && e.task) {
        const t = e.task as unknown as TaskRecord;
        const actor = (e.actor_id as string | undefined) ?? t.created_by;
        void (async () => {
          const name = await this.ctx.userName(actor);
          for (const uid of e.audience ?? []) {
            if (uid === actor) continue;
            await this.notify({
              user_id: uid,
              type: 'task.assigned',
              actor_id: actor,
              title: `${name} 给你指派了任务「${t.title}」`,
              summary: t.due_ms != null ? `截止时间：${this.fmtTime(t.due_ms)}` : (t.description ?? '').slice(0, 80),
              target: { type: 'task', id: t.task_id },
            });
          }
        })().catch(() => undefined);
      } else if (e.event_type === 'job.updated' && e.job) {
        // AGENT_PLAN M3：后台任务结束时通知本人
        const j = e.job as { job_id: string; title: string; status: string; owner_id: string; message?: string | null };
        if (j.status !== 'done' && j.status !== 'failed') return;
        void this.notify({
          user_id: j.owner_id,
          type: j.status === 'done' ? 'job.done' : 'job.failed',
          actor_id: 'bot',
          title: j.status === 'done' ? `飞书同学已完成「${j.title}」` : `飞书同学没能完成「${j.title}」`,
          summary: (j.message ?? '').slice(0, 200),
          target: { type: 'job', id: j.job_id },
          dedupe_key: `job:${j.job_id}:${j.status}`,
        }).catch(() => undefined);
      } else if (e.event_type === 'calendar.invited' && e.event) {
        const ev = e.event as { event_id: string; title: string; start_time?: number; start_ms?: number; created_by?: string; location?: string | null };
        const actor = ev.created_by ?? null;
        void (async () => {
          const name = actor ? await this.ctx.userName(actor) : '有人';
          const start = ev.start_time ?? ev.start_ms;
          for (const uid of e.audience ?? []) {
            await this.notify({
              user_id: uid,
              type: 'calendar.invited',
              actor_id: actor,
              title: `${name} 邀请你参加日程「${ev.title}」`,
              summary: [typeof start === 'number' ? this.fmtTime(start) : '', ev.location ?? ''].filter(Boolean).join(' · '),
              target: { type: 'calendar', id: ev.event_id, ...(typeof start === 'number' ? { start_ms: start } : {}) },
            });
          }
        })().catch(() => undefined);
      }
    });
  }
}

// ---------------- 路由 ----------------

export function registerNotificationRoutes(ctx: Ctx, svc: NotificationService, push: PushDispatcher): void {
  const { app, repo } = ctx;

  app.get('/api/v1/notifications', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { filter?: string; page_size?: string; page_token?: string };
    const limit = pageSize(q.page_size, 50, 200);
    const offset = pageOffset(q.page_token);
    const page = await repo.listNotifications(me.sub, { mentionOnly: q.filter === 'mention', limit, offset });
    return {
      ...pageResult(page.items.map(notificationJson), page.total, offset),
      unread_count: await repo.countUnreadNotifications(me.sub),
    };
  });

  app.get('/api/v1/notifications/unread-count', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    return { count: await repo.countUnreadNotifications(me.sub) };
  });

  app.post('/api/v1/notifications/read', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
    let ids: string[] | 'all';
    if (body.all === true) ids = 'all';
    else if (Array.isArray(body.ids) && body.ids.every((x) => typeof x === 'string')) ids = body.ids as string[];
    else return invalid(reply, [{ field: 'ids', message: '需要 ids（通知 ID 数组）或 all: true' }]);
    const updated = ids === 'all' || ids.length ? await repo.markNotificationsRead(me.sub, ids) : 0;
    const count = await repo.countUnreadNotifications(me.sub);
    if (updated) ctx.publish('notification.read', { count }, [me.sub], { user_only: true });
    return { updated, count };
  });

  app.get('/api/v1/users/me/notification-settings', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    return push.settingsOf(me.sub);
  });

  app.put('/api/v1/users/me/notification-settings', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const errors: FieldError[] = [];
    const next = parseSettings(req.body, await push.settingsOf(me.sub), errors);
    if (!next) return invalid(reply, errors);
    await repo.saveNotificationSettings(me.sub, next, nowIso());
    return next;
  });

  void fail;
  void svc;
}
