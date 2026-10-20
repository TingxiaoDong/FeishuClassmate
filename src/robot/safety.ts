/**
 * 机器人安全守卫（AGENT_PLAN M4 §3.5）。每次让机器人移动前检查：
 *   1. 电量：低于阈值只允许回充电桩；
 *   2. 单控制者锁：同一时间只有一位同学（或一个会话）能指挥机器人移动，空闲 5 分钟自动释放；
 *   3. 白名单：目标地点必须在地点表里且没有被停用；
 *   4. 时间围栏：夜间（默认 22:00–07:00）禁止移动。
 * 急停不经过守卫，任何人任何时候都能用，并且会释放锁。
 */

import type { RobotLocation } from './locations.js';
import type { RobotStatus } from './sidecar.js';

export interface GuardActor {
  userId?: string;
  name?: string;
  sessionId: string;
}

export interface LockHolder {
  userId?: string;
  name?: string;
  sessionId: string;
  until: number;
}

export type GuardCode = 'LOW_BATTERY' | 'LOCKED' | 'NOT_ALLOWED' | 'UNKNOWN_LOCATION' | 'QUIET_HOURS' | 'OFFLINE';

export type GuardResult = { ok: true } | { ok: false; code: GuardCode; reason: string };

export interface GuardOptions {
  /** 电量低于多少（%）只能回充，默认 20。 */
  minBattery?: number;
  /** 夜间禁止移动的时段「HH:MM-HH:MM」；空字符串或 off 表示不限制。默认 22:00-07:00。 */
  quietHours?: string;
  /** 控制锁空闲多久自动释放，默认 5 分钟。 */
  lockTtlMs?: number;
  now?: () => Date;
}

export function guardOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): GuardOptions {
  const n = Number(env.CLASSMATE_ROBOT_MIN_BATTERY);
  const ttl = Number(env.CLASSMATE_ROBOT_LOCK_TTL_SEC);
  return {
    minBattery: Number.isFinite(n) && env.CLASSMATE_ROBOT_MIN_BATTERY ? n : undefined,
    quietHours: env.CLASSMATE_ROBOT_QUIET_HOURS,
    lockTtlMs: Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : undefined,
  };
}

/** 解析「22:00-07:00」→ 分钟区间；不限制时返回 undefined。 */
export function parseQuietHours(spec: string | undefined): { from: number; to: number } | undefined {
  if (spec === undefined) spec = '22:00-07:00';
  if (!spec.trim() || /^(off|none|0|false|no)$/i.test(spec.trim())) return undefined;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) return undefined;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  return from === to ? undefined : { from, to };
}

export function inQuietHours(d: Date, q: { from: number; to: number } | undefined): boolean {
  if (!q) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  return q.from < q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to;
}

const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export class RobotGuard {
  private holder?: LockHolder;
  readonly minBattery: number;
  readonly quiet?: { from: number; to: number };
  private ttl: number;
  private now: () => Date;

  constructor(opts: GuardOptions = {}) {
    this.minBattery = opts.minBattery ?? 20;
    this.quiet = parseQuietHours(opts.quietHours);
    this.ttl = opts.lockTtlMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** 当前持锁人（过期的视为没有）。 */
  lockHolder(): LockHolder | undefined {
    if (this.holder && this.holder.until <= this.now().getTime()) this.holder = undefined;
    return this.holder;
  }

  private sameController(a: GuardActor, h: LockHolder) {
    return a.sessionId === h.sessionId || (!!a.userId && a.userId === h.userId);
  }

  /** 移动前检查（不改变状态）。 */
  checkMove(actor: GuardActor, target: RobotLocation | undefined, status: RobotStatus | undefined, opts: { query?: string } = {}): GuardResult {
    if (!status || !status.online) return { ok: false, code: 'OFFLINE', reason: '机器人现在不在线' };
    if (!target) {
      return { ok: false, code: 'UNKNOWN_LOCATION', reason: `地点表里没有「${opts.query ?? ''}」，机器人只去登记过的地点。可以先用 temi_locations 查看` };
    }
    if (!target.allowed) return { ok: false, code: 'NOT_ALLOWED', reason: `「${target.label}」已被管理员停用，机器人不能去` };
    if (status.battery == null) return { ok: false, code: 'LOW_BATTERY', reason: '无法核实电量，暂不允许移动' };
    const goingHome = target.kind === 'dock';
    if (!goingHome && inQuietHours(this.now(), this.quiet)) {
      return { ok: false, code: 'QUIET_HOURS', reason: `现在是夜间禁行时段（${fmt(this.quiet!.from)}–${fmt(this.quiet!.to)}），机器人只能回充电桩` };
    }
    if (!goingHome && status?.battery != null && status.battery < this.minBattery) {
      return { ok: false, code: 'LOW_BATTERY', reason: `电量只剩 ${status.battery}%（低于 ${this.minBattery}%），只能先回充电桩充电` };
    }
    return this.checkLock(actor);
  }

  /** 原地动作（转身、抬头、跟随）只查锁、在线、夜间。 */
  checkLocalMove(actor: GuardActor, status: RobotStatus | undefined): GuardResult {
    if (!status || !status.online) return { ok: false, code: 'OFFLINE', reason: '机器人现在不在线' };
    if (inQuietHours(this.now(), this.quiet)) return { ok: false, code: 'QUIET_HOURS', reason: '现在是夜间禁行时段，机器人不移动' };
    if (status.battery == null || status.battery < this.minBattery) return { ok: false, code: 'LOW_BATTERY', reason: '电量未知或过低，暂不允许移动' };
    return this.checkLock(actor);
  }

  private checkLock(actor: GuardActor): GuardResult {
    const h = this.lockHolder();
    if (h && !this.sameController(actor, h)) {
      const left = Math.max(1, Math.ceil((h.until - this.now().getTime()) / 60_000));
      return { ok: false, code: 'LOCKED', reason: `${h.name ?? '另一位同学'}正在使用机器人，约 ${left} 分钟后空出；紧急情况可以直接急停` };
    }
    return { ok: true };
  }

  /** 拿锁 / 续期（先 checkMove 通过再调）。 */
  acquire(actor: GuardActor): LockHolder {
    this.holder = { userId: actor.userId, name: actor.name, sessionId: actor.sessionId, until: this.now().getTime() + this.ttl };
    return this.holder;
  }

  /** 释放：只放自己的锁；不传 actor 强制释放（急停）。 */
  release(actor?: GuardActor): void {
    const h = this.lockHolder();
    if (!h) return;
    if (!actor || this.sameController(actor, h)) this.holder = undefined;
  }
}
