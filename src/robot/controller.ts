/**
 * 机器人控制器（AGENT_PLAN M4 §3.1–3.5）：工具、Temi 语音通道、App 急停都经过它。
 *
 *   - 移动前过安全守卫（电量 / 单控制者锁 / 白名单 / 夜间）；
 *   - 导航可以等到达（wait），也可以立即返回 action_id，到达 / 失败事件回来后更新；
 *   - 订阅 sidecar 事件，维护电量、位置、当前动作；
 *   - 状态变化和每个动作写到平台（RobotStatus / RobotLogs），工作台的机器人卡片据此显示。
 */

import { randomUUID } from 'node:crypto';
import type { CosClient } from '../cos-sdk/client.js';
import type { LocationRegistry, RobotLocation } from './locations.js';
import { RobotGuard, type GuardActor, type GuardResult, type LockHolder } from './safety.js';
import type { RobotEvent, RobotSidecar, RobotStatus } from './sidecar.js';

export type ActionState = 'moving' | 'arrived' | 'failed';

export interface RobotAction {
  action_id: string;
  location: string;
  label: string;
  state: ActionState;
  reason?: string;
  started_by?: string;
  started_at: number;
  ended_at?: number;
}

export interface RobotLogEntry {
  kind: 'goto' | 'say' | 'ask' | 'move' | 'follow' | 'stop' | 'look' | 'task' | 'event' | 'location';
  text: string;
  actor_id?: string | null;
  ok?: boolean;
  action_id?: string;
}

/** 平台上报（尽力而为，失败只记日志）。 */
export interface RobotReporter {
  status(robotId: string, s: Record<string, unknown>): Promise<void>;
  log(robotId: string, e: RobotLogEntry): Promise<void>;
}

export function createCosRobotReporter(client: CosClient, onError: (e: unknown) => void = () => {}): RobotReporter {
  return {
    async status(id, s) {
      const r = await client.put(`/bot/robots/${encodeURIComponent(id)}/status`, s, { asBot: true });
      if (!r.ok) onError(new Error(`robot status report failed: ${r.error}`));
    },
    async log(id, e) {
      const r = await client.post(`/bot/robots/${encodeURIComponent(id)}/logs`, e, { asBot: true });
      if (!r.ok) onError(new Error(`robot log failed: ${r.error}`));
    },
  };
}

export type GotoResult =
  | { ok: true; action_id: string; location: string; label: string; arrived: boolean; state: ActionState }
  | { ok: false; code: string; error: string; action_id?: string };

export interface RobotControllerOptions {
  sidecar: RobotSidecar;
  locations: LocationRegistry;
  guard?: RobotGuard;
  robotId?: string;
  reporter?: RobotReporter;
  /** 等待到达的最长时间，默认 120 秒。 */
  gotoTimeoutMs?: number;
  onLog?: (m: string) => void;
  onError?: (e: unknown) => void;
}

export class RobotController {
  readonly sidecar: RobotSidecar;
  readonly locations: LocationRegistry;
  readonly guard: RobotGuard;
  readonly robotId: string;
  private actions = new Map<string, RobotAction>();
  private waiters = new Map<string, Array<(a: RobotAction) => void>>();
  private current?: string;
  private lastStatus?: RobotStatus;
  private listeners = new Set<(e: RobotEvent) => void>();
  private unsub?: () => void;
  private reportTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;

  constructor(private opts: RobotControllerOptions) {
    this.sidecar = opts.sidecar;
    this.locations = opts.locations;
    this.guard = opts.guard ?? new RobotGuard();
    this.robotId = opts.robotId ?? 'temi';
    this.unsub = this.sidecar.onEvent((e) => this.handleEvent(e));
  }

  /** 订阅机器人事件（Temi 语音通道、网关用）。 */
  onEvent(fn: (e: RobotEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  start() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => { void this.refreshStatus().then(() => this.report()).catch(e => this.opts.onError?.(e)); }, 20_000);
    this.heartbeat.unref?.();
    this.sidecar.start?.();
    void this.refreshStatus().then(() => this.report()).catch(e => this.opts.onError?.(e));
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.unsub?.();
    this.sidecar.close?.();
    if (this.reportTimer) clearTimeout(this.reportTimer);
  }

  // ------------------------------------------------------------ 事件

  private handleEvent(e: RobotEvent) {
    if (e.type === 'battery' && typeof e.battery === 'number') {
      this.lastStatus = { ...(this.lastStatus ?? emptyStatus(this.sidecar.mock)), battery: e.battery, charging: !!e.charging };
      if (e.battery < this.guard.minBattery) this.log({ kind: 'event', text: `电量低：${e.battery}%` });
    }
    if (e.type === 'nav.arrived' || e.type === 'nav.failed') {
      const id = e.action_id ?? this.current;
      if (id) this.finish(id, e.type === 'nav.arrived' ? 'arrived' : 'failed', e.reason);
      if (e.type === 'nav.arrived' && e.location && this.lastStatus) this.lastStatus = { ...this.lastStatus, location: e.location, is_moving: false, heading_to: null };
    }
    if (e.type === 'estop') {
      if (this.current) this.finish(this.current, 'failed', '已急停');
      this.guard.release();
    }
    if (e.type === 'connection' && this.lastStatus) this.lastStatus = { ...this.lastStatus, online: !!e.connected };
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        this.opts.onError?.(err);
      }
    }
    if (e.type !== 'asr' && e.type !== 'person.detected' && e.type !== 'person.lost') this.scheduleReport();
  }

  private finish(id: string, state: ActionState, reason?: string) {
    const a = this.actions.get(id);
    if (!a || a.state !== 'moving') return;
    a.state = state;
    a.reason = reason;
    a.ended_at = Date.now();
    if (this.current === id) this.current = undefined;
    this.log({ kind: 'goto', text: state === 'arrived' ? `到达「${a.label}」` : `没能到达「${a.label}」：${reason ?? '未知原因'}`, ok: state === 'arrived', action_id: id, actor_id: a.started_by });
    for (const fn of this.waiters.get(id) ?? []) fn(a);
    this.waiters.delete(id);
  }

  // ------------------------------------------------------------ 状态

  async refreshStatus(): Promise<RobotStatus | undefined> {
    const r = await this.sidecar.status();
    if (r.ok && r.data) this.lastStatus = r.data;
    else if (!r.ok) this.lastStatus = { ...(this.lastStatus ?? emptyStatus(this.sidecar.mock)), online: false };
    return this.lastStatus;
  }

  currentAction(): RobotAction | undefined {
    return this.current ? this.actions.get(this.current) : undefined;
  }

  getAction(id: string): RobotAction | undefined {
    return this.actions.get(id);
  }

  async snapshot(): Promise<{ status?: RobotStatus; current_action?: RobotAction; controller?: LockHolder }> {
    return { status: await this.refreshStatus(), current_action: this.currentAction(), controller: this.guard.lockHolder() };
  }

  private scheduleReport() {
    if (!this.opts.reporter || this.reportTimer) return;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = undefined;
      void this.report();
    }, 300);
    this.reportTimer.unref?.();
  }

  private async report() {
    if (!this.opts.reporter) return;
    const s = this.lastStatus;
    const a = this.currentAction();
    const h = this.guard.lockHolder();
    await this.opts.reporter
      .status(this.robotId, {
        online: s?.online ?? false,
        mock: this.sidecar.mock,
        battery: s?.battery ?? null,
        charging: s?.charging ?? false,
        is_moving: s?.is_moving ?? !!a,
        location: s?.location ?? null,
        current_action: a ? { action_id: a.action_id, label: `前往「${a.label}」`, started_by: a.started_by ?? null } : null,
        controller: h ? { user_id: h.userId ?? null, name: h.name ?? null, until: new Date(h.until).toISOString() } : null,
      })
      .catch((e) => this.opts.onError?.(e));
  }

  log(e: RobotLogEntry) {
    this.opts.onLog?.(`[robot] ${e.text}`);
    void this.opts.reporter?.log(this.robotId, e).catch((err) => this.opts.onError?.(err));
  }

  // ------------------------------------------------------------ 动作

  /** 检查能不能去某处（不移动）。 */
  async check(actor: GuardActor, query: string): Promise<{ target?: RobotLocation; result: GuardResult }> {
    const target = await this.locations.resolve(query);
    const status = await this.refreshStatus();
    return { target, result: this.guard.checkMove(actor, target, status, { query }) };
  }

  async goto(actor: GuardActor, query: string, opts: { wait?: boolean; timeoutMs?: number } = {}): Promise<GotoResult> {
    const { target, result } = await this.check(actor, query);
    if (!result.ok) return { ok: false, code: result.code, error: result.reason };
    const loc = target!;
    this.guard.acquire(actor);
    const prev = this.current;
    if (prev) this.finish(prev, 'failed', '被新的导航指令取代');
    const id = `act_${randomUUID().slice(0, 8)}`;
    const action: RobotAction = { action_id: id, location: loc.name, label: loc.label, state: 'moving', started_by: actor.userId, started_at: Date.now() };
    this.actions.set(id, action);
    this.current = id;
    this.trimActions();
    this.log({ kind: 'goto', text: `${actor.name ?? '飞书同学'}让机器人前往「${loc.label}」`, actor_id: actor.userId, action_id: id });
    this.scheduleReport();

    const sent = this.sidecar.goto(loc.name, id).then((r) => {
      // HTTP 返回也算一次结果（没有事件推送的旧 sidecar 只能靠它）
      if (r.ok && r.data?.arrived) this.finish(id, 'arrived');
      else if (!r.ok) this.finish(id, 'failed', r.error ?? '导航失败');
      // r.ok 但没确认到达：保持「前往中」，等 nav.arrived / nav.failed 事件或超时
    }).catch((e) => this.finish(id, 'failed', String(e)));
    if (opts.wait === false) {
      void sent.catch((e) => this.finish(id, 'failed', e instanceof Error ? e.message : String(e)));
      return { ok: true, action_id: id, location: loc.name, label: loc.label, arrived: false, state: 'moving' };
    }
    const done = await this.waitAction(id, opts.timeoutMs ?? this.opts.gotoTimeoutMs ?? 120_000);
    if (done.state === 'arrived') return { ok: true, action_id: id, location: loc.name, label: loc.label, arrived: true, state: 'arrived' };
    if (done.state === 'moving') return { ok: true, action_id: id, location: loc.name, label: loc.label, arrived: false, state: 'moving' };
    return { ok: false, code: 'NAV_FAILED', error: `没能到达「${loc.label}」：${done.reason ?? '未知原因'}`, action_id: id };
  }

  /** 等某个动作结束；超时返回当时的状态（仍是 moving）。 */
  waitAction(id: string, timeoutMs: number): Promise<RobotAction> {
    const a = this.actions.get(id);
    if (!a) return Promise.reject(new Error(`没有这个动作：${id}`));
    if (a.state !== 'moving') return Promise.resolve(a);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = (this.waiters.get(id) ?? []).filter((f) => f !== done);
        this.waiters.set(id, list);
        resolve(a);
      }, timeoutMs);
      const done = (x: RobotAction) => {
        clearTimeout(timer);
        resolve(x);
      };
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), done]);
    });
  }

  /** 原地动作：转身 / 抬头 / 跟随。 */
  async localMove(actor: GuardActor, kind: 'turn' | 'tilt' | 'follow' | 'unfollow', value = 0): Promise<{ ok: boolean; error?: string; code?: string }> {
    if (kind !== 'unfollow') {
      const check = this.guard.checkLocalMove(actor, await this.refreshStatus());
      if (!check.ok) return { ok: false, code: check.code, error: check.reason };
      this.guard.acquire(actor);
    }
    const r =
      kind === 'turn' ? await this.sidecar.turn(value) : kind === 'tilt' ? await this.sidecar.tilt(value) : await this.sidecar.follow(kind === 'follow');
    const text = kind === 'turn' ? `转身 ${value}°` : kind === 'tilt' ? `抬头 ${value}°` : kind === 'follow' ? '开始跟随' : '停止跟随';
    this.log({ kind: kind === 'turn' || kind === 'tilt' ? 'move' : 'follow', text, actor_id: actor.userId, ok: r.ok });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** 急停：不经过守卫，释放锁，结束当前动作。 */
  async stop(by?: { userId?: string; name?: string; source?: string }): Promise<{ ok: boolean; error?: string }> {
    const r = await this.sidecar.stop();
    if (this.current) this.finish(this.current, 'failed', '已急停');
    this.guard.release();
    this.log({ kind: 'stop', text: `${by?.name ?? by?.userId ?? '飞书同学'}${by?.source === 'app' ? '在 App 里' : ''}按了急停`, actor_id: by?.userId, ok: r.ok });
    this.scheduleReport();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** 用完主动让出控制权。 */
  release(actor: GuardActor) {
    this.guard.release(actor);
    this.scheduleReport();
  }

  private trimActions() {
    if (this.actions.size <= 50) return;
    for (const [id, a] of this.actions) {
      if (a.state !== 'moving') this.actions.delete(id);
      if (this.actions.size <= 30) break;
    }
  }
}

function emptyStatus(mock: boolean): RobotStatus {
  return { online: false, mock, battery: null, charging: false, is_moving: false, location: null, heading_to: null };
}
