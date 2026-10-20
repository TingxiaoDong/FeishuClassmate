/**
 * 触发器引擎（AGENT_PLAN M3 §2.5 主动协作）。
 *
 * 平台上的「自动化」（/agent/triggers）由同学自己建；引擎在大脑侧：
 *   - 启动时拉取全部启用的触发器（GET /bot/triggers），收到 trigger.changed 重新拉取；
 *   - schedule：按 cron（北京时间）定时执行；
 *   - 事件类（record.changed / task.assigned / task.updated / calendar.invited / doc.comment_changed）：
 *     先按过滤条件匹配，再「以建它的同学身份」重新读取一次对象——读不到（没权限）就不触发；
 *   - 触发后以这位同学的身份跑一轮大脑会话，没有确认通道：删除、让机器人移动这类操作一律被跳过；
 *   - 有 condition 时模型先判断，不满足回复 SKIP，不打扰同学；
 *   - 结果发到触发器的 chat_id（没填就私聊同学），并回写 /bot/triggers/:id/fired。
 *
 * 防刷屏 / 防回环：冷却时间（cooldown_sec）；机器人代办引起的变更（via_bot）不触发；
 * 同一个触发器串行；全局最多 maxConcurrent 个同时运行，其余排队，队列满了丢弃并记日志。
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { CosClient } from '../cos-sdk/client.js';
import type { BotEventSource } from '../pal/bot-events.js';
import type { ImService } from '../pal/types.js';
import type { AgentRuntime } from './types.js';

export type TriggerEvent = 'record.changed' | 'task.assigned' | 'task.updated' | 'calendar.invited' | 'doc.comment_changed' | 'schedule';

export interface Trigger {
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
  last_fired_at?: string | null;
}

/** 平台推来的事件（字段随类型不同）。 */
export type PlatformEvent = { event_id?: string; event_type: string; via_bot?: boolean } & Record<string, unknown>;

export interface TriggerEngineOptions {
  client: CosClient;
  runtime: AgentRuntime;
  im: Pick<ImService, 'sendText'>;
  eventSource?: BotEventSource;
  systemPromptFor?: (text: string) => string | undefined;
  onLog?: (msg: string) => void;
  onError?: (err: unknown) => void;
  /** 同时运行的触发器上限，默认 2。 */
  maxConcurrent?: number;
  /** 排队上限，默认 50。 */
  maxQueue?: number;
  /** 关闭 cron（测试用）。 */
  cron?: boolean;
  now?: () => number;
}

export interface TriggerEngine {
  start(): Promise<void>;
  stop(): void;
  reload(): Promise<void>;
  /** 测试 / 诊断：处理一条平台事件，返回被触发的触发器 id。 */
  handleEvent(e: PlatformEvent): Promise<string[]>;
  /** 测试 / 诊断：立即执行某个触发器（schedule 或手动）。 */
  fire(triggerId: string, reason?: string): Promise<FireResult | undefined>;
  list(): Trigger[];
  /** 等所有排队中的执行结束（测试用）。 */
  idle(): Promise<void>;
}

export interface FireResult {
  status: 'done' | 'skipped' | 'failed' | 'cooldown';
  output?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** 事件是否匹配触发器的类型和过滤条件（不含权限检查）。 */
export function matchTrigger(t: Trigger, e: PlatformEvent): boolean {
  if (!t.enabled || t.event === 'schedule' || t.event !== e.event_type) return false;
  const f = t.filter ?? {};
  switch (t.event) {
    case 'record.changed': {
      if (e.via_bot) return false; // 机器人自己（含这个触发器）改的不再触发，防回环
      if (!f.table_key || f.table_key !== str(e.table_key)) return false;
      if (f.actions?.length && !f.actions.includes(str(e.action))) return false;
      if (f.fields_any?.length) {
        const changed = Array.isArray(e.changed_fields) ? (e.changed_fields as unknown[]).map(str) : [];
        // 新建 / 删除没有 changed_fields：视为所有字段都变了
        if (str(e.action) === 'updated' && !changed.some((c) => f.fields_any!.includes(c))) return false;
      }
      return true;
    }
    case 'task.assigned': {
      const task = obj(e.task);
      if (str(task.assignee_id) !== t.owner_id) return false;
      if (str(e.actor_id) === t.owner_id) return false; // 自己派给自己不提醒
      return !f.task_id || f.task_id === str(task.task_id);
    }
    case 'task.updated':
      if (e.via_bot) return false;
      return !f.task_id || f.task_id === str(e.task_id);
    case 'calendar.invited': {
      const ev = obj(e.event);
      const ids = new Set<string>();
      for (const a of Array.isArray(ev.attendees) ? ev.attendees : []) ids.add(str(obj(a).user_id));
      for (const id of Array.isArray(ev.attendee_ids) ? ev.attendee_ids : []) ids.add(str(id));
      if (ids.size && !ids.has(t.owner_id)) return false;
      return str(ev.organizer_id ?? ev.created_by) !== t.owner_id;
    }
    case 'doc.comment_changed':
      if (e.via_bot) return false;
      return !f.doc_id || f.doc_id === str(e.doc_id);
  }
  return false;
}

/** 事件的一句话说明（只放 id，不放内容——内容由模型以同学身份重新读取）。 */
export function describeEvent(t: Trigger, e?: PlatformEvent, reason?: string): string {
  if (!e) return reason ?? (t.event === 'schedule' ? `到了设定的时间（${t.cron}）` : '手动执行');
  switch (e.event_type) {
    case 'record.changed': {
      const verb = ({ created: '新增了', updated: '修改了', deleted: '删除了' } as Record<string, string>)[str(e.action)] ?? '变更了';
      const fields = Array.isArray(e.changed_fields) && e.changed_fields.length ? `（变化的字段：${(e.changed_fields as unknown[]).map(str).join('、')}）` : '';
      return `数据表 table_key=${str(e.table_key)} ${verb}记录 record_id=${str(e.record_id)}${fields}，操作人 ${str(e.operator_id)}`;
    }
    case 'task.assigned':
      return `${str(e.actor_id) || '有人'} 给你派了任务 task_id=${str(obj(e.task).task_id)}`;
    case 'task.updated':
      return `你能看到的任务 task_id=${str(e.task_id)} 有更新`;
    case 'calendar.invited':
      return `你收到了日程邀请 event_id=${str(obj(e.event).event_id)}`;
    case 'doc.comment_changed':
      return `文档 doc_id=${str(e.doc_id)} 的评论有变化（${str(e.action)}，comment_id=${str(e.comment_id)}）`;
  }
  return e.event_type;
}

export function buildTriggerPrompt(t: Trigger, what: string): string {
  return [
    `【自动化「${t.name}」被触发】`,
    `触发原因：${what}。`,
    `你正在以设置这个自动化的同学（user_id=${t.owner_id}）的身份工作，他现在不在对话里：不能请他确认，删除数据、让机器人移动这类操作会被系统跳过，不要尝试。`,
    '事件里只有 id，需要内容时先用工具读取最新数据，不要猜。',
    t.condition ? `先判断条件是否满足：「${t.condition}」。不满足就只回复 SKIP 四个字母，不调用任何写入工具。` : '',
    `要做的事：${t.prompt}`,
    `做完后用一两句话总结结果，这段话会${t.chat_id ? '发到他指定的群里' : '私信发给他'}；没有需要告诉他的就只回复 SKIP。`,
  ].filter(Boolean).join('\n');
}

export function createTriggerEngine(opts: TriggerEngineOptions): TriggerEngine {
  const log = opts.onLog ?? (() => {});
  const onError = opts.onError ?? (() => {});
  const now = opts.now ?? Date.now;
  const maxConcurrent = opts.maxConcurrent ?? 2;
  const maxQueue = opts.maxQueue ?? 50;

  let triggers = new Map<string, Trigger>();
  const cronTasks = new Map<string, ScheduledTask>();
  const lastFire = new Map<string, number>();
  const perTrigger = new Map<string, Promise<unknown>>();
  let active = 0;
  const waiters: Array<() => void> = [];
  const inflight = new Set<Promise<unknown>>();
  let unsubscribe: (() => void) | undefined;
  let stopped = false;

  const bot = { asBot: true as const };

  async function reload(): Promise<void> {
    const r = await opts.client.get<{ items: Trigger[] }>('/bot/triggers', bot);
    if (!r.ok) {
      onError(new Error(`load triggers failed: ${r.error}`));
      return;
    }
    triggers = new Map(r.data.items.filter((t) => t.enabled).map((t) => [t.trigger_id, t]));
    for (const t of triggers.values()) {
      if (t.last_fired_at && !lastFire.has(t.trigger_id)) lastFire.set(t.trigger_id, Date.parse(t.last_fired_at));
    }
    syncCron();
    log(`[triggers] loaded ${triggers.size}`);
  }

  function syncCron() {
    for (const [id, task] of cronTasks) {
      const t = triggers.get(id);
      if (!t || t.event !== 'schedule' || (task as ScheduledTask & { __expr?: string }).__expr !== t.cron) {
        task.stop();
        cronTasks.delete(id);
      }
    }
    if (opts.cron === false || stopped) return;
    for (const t of triggers.values()) {
      if (t.event !== 'schedule' || !t.cron || cronTasks.has(t.trigger_id) || !cron.validate(t.cron)) continue;
      const task = cron.schedule(t.cron, () => void fire(t.trigger_id).catch(onError), { timezone: 'Asia/Shanghai' }) as ScheduledTask & { __expr?: string };
      task.__expr = t.cron;
      cronTasks.set(t.trigger_id, task);
    }
  }

  /** 以触发器主人的身份确认他能看到事件里的对象。 */
  async function ownerCanSee(t: Trigger, e: PlatformEvent): Promise<boolean> {
    const as = { actor: { userId: t.owner_id, sessionId: `trg_${t.trigger_id}` } };
    let path: string | undefined;
    switch (e.event_type) {
      case 'record.changed':
        path = str(e.action) === 'deleted' ? `/tables/${encodeURIComponent(str(e.table_key))}` : `/tables/${encodeURIComponent(str(e.table_key))}/records/${encodeURIComponent(str(e.record_id))}`;
        break;
      case 'task.updated':
        path = `/tasks/${encodeURIComponent(str(e.task_id))}`;
        break;
      case 'task.assigned':
        path = `/tasks/${encodeURIComponent(str(obj(e.task).task_id))}`;
        break;
      case 'calendar.invited':
        path = `/calendar/events/${encodeURIComponent(str(obj(e.event).event_id))}`;
        break;
      case 'doc.comment_changed': {
        const r = await opts.client.get<{ created_by?: string; owner_id?: string }>(`/docs/${encodeURIComponent(str(e.doc_id))}`, as);
        if (!r.ok) return false;
        // 没指定文档时只盯「我的文档」
        return !!t.filter?.doc_id || r.data.created_by === t.owner_id || r.data.owner_id === t.owner_id;
      }
      default:
        return false;
    }
    const r = await opts.client.get(path, as);
    return r.ok;
  }

  async function acquire() {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    await new Promise<void>((res) => waiters.push(res));
    active += 1;
  }
  function release() {
    active -= 1;
    waiters.shift()?.();
  }

  async function execute(queued: Trigger, what: string): Promise<FireResult> {
    const t = triggers.get(queued.trigger_id);
    // 排队期间被停用、删除或网关停止：不再执行
    if (stopped || !t?.enabled) return { status: 'skipped', output: '自动化已停用' };
    const cooldown = (t.cooldown_sec ?? 300) * 1000;
    const last = lastFire.get(t.trigger_id);
    if (last !== undefined && now() - last < cooldown) {
      log(`[triggers] ${t.trigger_id} cooldown`);
      return { status: 'cooldown' };
    }
    lastFire.set(t.trigger_id, now());
    await acquire();
    let result: FireResult;
    try {
      const prompt = buildTriggerPrompt(t, what);
      const res = await opts.runtime.runSession({
        sessionId: `trg_${t.trigger_id}_${now()}`,
        messages: [{ role: 'user', content: prompt }],
        actor: { userId: t.owner_id, chatId: t.chat_id ?? undefined },
        systemPrompt: opts.systemPromptFor?.(`${t.prompt} ${t.condition ?? ''}`),
        maxTurns: 12,
      });
      const out = res.output.trim();
      if (!out || /^skip\b/i.test(out) || out === 'SKIP') {
        result = { status: 'skipped', output: out };
      } else {
        const sent = await opts.im.sendText(t.chat_id ?? t.owner_id, `🤖 自动化「${t.name}」\n${out}`, t.chat_id ? 'chat_id' : 'user_id');
        if (!sent.ok) onError(new Error(`trigger result send failed: ${sent.error}`));
        result = { status: 'done', output: out };
      }
    } catch (err) {
      onError(err);
      result = { status: 'failed', output: err instanceof Error ? err.message : String(err) };
    } finally {
      release();
    }
    const note = result.status === 'skipped' ? '条件不满足，未打扰' : result.status === 'failed' ? `失败：${result.output}` : (result.output ?? '');
    const r = await opts.client.post(`/bot/triggers/${encodeURIComponent(t.trigger_id)}/fired`, { result: note.slice(0, 500) }, bot);
    if (!r.ok) onError(new Error(`trigger fired report failed: ${r.error}`));
    log(`[triggers] ${t.trigger_id} → ${result.status}`);
    return result;
  }

  /** 同一个触发器串行。 */
  function enqueue(t: Trigger, what: string): Promise<FireResult> {
    if (inflight.size >= maxQueue) {
      onError(new Error(`trigger queue full, dropped ${t.trigger_id}`));
      return Promise.resolve({ status: 'skipped' as const });
    }
    const prev = perTrigger.get(t.trigger_id) ?? Promise.resolve();
    const p = prev.catch(() => undefined).then(() => execute(t, what));
    perTrigger.set(t.trigger_id, p);
    inflight.add(p);
    void p.finally(() => {
      inflight.delete(p);
      if (perTrigger.get(t.trigger_id) === p) perTrigger.delete(t.trigger_id);
    }).catch(() => undefined);
    return p;
  }

  async function fire(triggerId: string, reason?: string): Promise<FireResult | undefined> {
    const t = triggers.get(triggerId);
    if (!t || stopped) return undefined;
    return enqueue(t, describeEvent(t, undefined, reason));
  }

  async function handleEvent(e: PlatformEvent): Promise<string[]> {
    if (stopped) return [];
    if (e.event_type === 'trigger.changed') {
      await reload();
      return [];
    }
    const fired: string[] = [];
    for (const t of triggers.values()) {
      if (!matchTrigger(t, e)) continue;
      try {
        if (!(await ownerCanSee(t, e))) continue;
      } catch (err) {
        onError(err);
        continue;
      }
      fired.push(t.trigger_id);
      void enqueue(t, describeEvent(t, e));
    }
    return fired;
  }

  return {
    async start() {
      stopped = false;
      await reload();
      if (opts.eventSource) {
        unsubscribe = opts.eventSource.onEvent((e) => void handleEvent(e as unknown as PlatformEvent).catch(onError));
      }
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      for (const t of cronTasks.values()) t.stop();
      cronTasks.clear();
    },
    reload,
    handleEvent,
    fire,
    list: () => [...triggers.values()],
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}
