/**
 * 登录设备会话 + 安全设置 + 账号登录状态（二期迭代 5 第 4.1、4.6 节，批次 1）。
 *
 * 存储全部走通用对象表（cos_entities），不改表结构：
 *   - auth_session / <sid>        scope = user_id   一次登录 = 一个设备会话
 *   - user_auth    / <user_id>    scope = 'user'    失败次数、锁定、强制改密、最后登录、头像 file_key
 *   - system_setting / security   scope = 'global'  安全设置
 *
 * access / refresh 令牌都带 sid。每次请求校验会话没被吊销、没有空闲超时。
 * 会话在本进程缓存 3 秒；本进程吊销立即生效，多实例部署时其他实例最多晚 3 秒。
 * 没有 sid 的旧令牌（升级前签发的）：账号做过「改密 / 退出全部设备 / 停用」后一律拒绝。
 */

import { randomUUID, randomInt } from 'node:crypto';
import type { EntityRecord, Repo } from './repo.js';
import type { FieldError } from './context.js';
import type { TokenPayload } from './auth.js';

// ---------------- 安全设置 ----------------

export interface SecuritySettings {
  password_min_length: number;
  password_require_letter_digit: boolean;
  force_change_on_first_login: boolean;
  access_token_ttl_minutes: number;
  /** 0 = 不启用。 */
  idle_timeout_minutes: number;
  /** 0 = 不锁定。 */
  lock_after_failures: number;
  lock_minutes: number;
}

export const DEFAULT_SECURITY: SecuritySettings = {
  password_min_length: 8,
  password_require_letter_digit: true,
  force_change_on_first_login: true,
  access_token_ttl_minutes: 120,
  idle_timeout_minutes: 0,
  lock_after_failures: 5,
  lock_minutes: 15,
};

const INT_RULES: Record<string, { min: number; max: number; label: string; zeroOk?: boolean }> = {
  password_min_length: { min: 6, max: 64, label: '密码最短长度' },
  access_token_ttl_minutes: { min: 5, max: 1440, label: '登录令牌有效期（分钟）' },
  idle_timeout_minutes: { min: 5, max: 43200, label: '空闲超时（分钟）', zeroOk: true },
  lock_after_failures: { min: 1, max: 20, label: '连续失败锁定次数', zeroOk: true },
  lock_minutes: { min: 1, max: 1440, label: '锁定时长（分钟）' },
};
const BOOL_KEYS = ['password_require_letter_digit', 'force_change_on_first_login'] as const;

/** 合并部分更新并校验；返回新设置或错误。 */
export function mergeSecurity(cur: SecuritySettings, body: Record<string, unknown>): { settings: SecuritySettings; errors: FieldError[] } {
  const next: SecuritySettings = { ...cur };
  const errors: FieldError[] = [];
  for (const [k, r] of Object.entries(INT_RULES)) {
    const v = body[k];
    if (v === undefined) continue;
    const range = r.zeroOk ? `0（不启用）或 ${r.min}～${r.max}` : `${r.min}～${r.max}`;
    if (typeof v !== 'number' || !Number.isInteger(v) || !((r.zeroOk && v === 0) || (v >= r.min && v <= r.max))) {
      errors.push({ field: k, message: `${r.label}必须是 ${range} 之间的整数` });
    } else (next as unknown as Record<string, number>)[k] = v;
  }
  for (const k of BOOL_KEYS) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') errors.push({ field: k, message: '必须是 true 或 false' });
    else next[k] = v;
  }
  return { settings: next, errors };
}

/** 按安全设置检查新密码；返回中文原因，通过返回 null。 */
export function passwordProblem(pw: string, s: SecuritySettings): string | null {
  const rule = `密码至少 ${s.password_min_length} 位${s.password_require_letter_digit ? '，且必须同时包含字母和数字' : ''}`;
  if (pw.length < s.password_min_length) return rule;
  if (pw.length > 128) return '密码最长 128 位';
  if (s.password_require_letter_digit && !(/[A-Za-z]/.test(pw) && /\d/.test(pw))) return rule;
  return null;
}

/** 生成满足任何安全设置的随机密码（管理员重置 / 新建成员用）。 */
export function randomPassword(len = 12): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const pick = (s: string) => s[randomInt(s.length)];
  const chars = [pick(letters), pick(digits)];
  while (chars.length < Math.max(len, 8)) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ---------------- 会话 / 账号状态 ----------------

export interface SessionData {
  user_id: string;
  device_name: string;
  platform: string | null;
  ip: string | null;
  last_active_at: string;
  /** 当前有效的 refresh 令牌 jti（轮换时更新）。 */
  refresh_jti: string;
  expires_at: string;
  revoked: boolean;
}

export interface UserAuthState {
  failed_count: number;
  locked_until: string | null;
  must_change_password: boolean;
  last_login_at: string | null;
  /** 改密 / 退出全部 / 停用后置 true：拒绝没有 sid 的旧令牌。 */
  legacy_revoked: boolean;
  avatar_file_key: string | null;
}

const EMPTY_STATE: UserAuthState = {
  failed_count: 0,
  locked_until: null,
  must_change_password: false,
  last_login_at: null,
  legacy_revoked: false,
  avatar_file_key: null,
};

export interface DeviceInfo {
  device_name?: string | null;
  platform?: string | null;
  ip?: string | null;
  user_agent?: string | null;
}

export type AccessCheck = 'ok' | 'revoked' | 'idle';

const CACHE_MS = 3_000;
const TOUCH_MS = 60_000;
const PLATFORMS = new Set(['macos', 'windows', 'linux', 'web', 'ios', 'android']);

export function guessDevice(info: DeviceInfo): { device_name: string; platform: string | null } {
  const ua = info.user_agent ?? '';
  let platform = info.platform && PLATFORMS.has(info.platform) ? info.platform : null;
  if (!platform) {
    if (/iPhone|iPad/i.test(ua)) platform = 'ios';
    else if (/Android/i.test(ua)) platform = 'android';
    else if (/Mozilla/i.test(ua)) platform = 'web';
    else if (/Macintosh|Mac OS X|macos/i.test(ua)) platform = 'macos';
    else if (/Windows/i.test(ua)) platform = 'windows';
    else if (/Linux/i.test(ua)) platform = 'linux';
  }
  const fromUa = /Mozilla/i.test(ua)
    ? `${/Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '浏览器'}${/Macintosh/.test(ua) ? '（Mac）' : /Windows/.test(ua) ? '（Windows）' : /iPhone/.test(ua) ? '（iPhone）' : /Android/.test(ua) ? '（Android）' : ''}`
    : null;
  const names: Record<string, string> = { macos: 'Mac 客户端', windows: 'Windows 客户端', linux: 'Linux 客户端', web: '网页版', ios: 'iPhone', android: 'Android 手机' };
  const name = info.device_name?.trim().slice(0, 100) || fromUa || (platform ? names[platform] : null) || '未知设备';
  return { device_name: name, platform };
}

export class AuthService {
  private sessionCache = new Map<string, { rec: EntityRecord | undefined; at: number }>();
  private stateCache = new Map<string, { st: UserAuthState; at: number }>();
  private security?: { s: SecuritySettings; at: number };
  private revokeListeners = new Map<string, Set<() => void>>();

  constructor(private readonly repo: Repo) {}

  // ---------- 安全设置 ----------

  async getSecurity(): Promise<SecuritySettings> {
    if (this.security && Date.now() - this.security.at < CACHE_MS) return this.security.s;
    const rec = await this.repo.getEntity('system_setting', 'security');
    const s = { ...DEFAULT_SECURITY, ...((rec?.data as Partial<SecuritySettings>) ?? {}) };
    this.security = { s, at: Date.now() };
    return s;
  }

  async saveSecurity(s: SecuritySettings): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const cur = await this.repo.getEntity('system_setting', 'security');
      const now = new Date().toISOString();
      const ok = await this.repo.saveEntity(
        { kind: 'system_setting', id: 'security', scope: 'global', data: { ...s }, version: cur?.version ?? 0, created_at: cur?.created_at ?? now, updated_at: now },
        cur?.version ?? 0,
      );
      if (ok) {
        this.security = { s, at: Date.now() };
        return;
      }
    }
    throw new Error('security settings write conflict');
  }

  async accessTtlMs(): Promise<number> {
    return (await this.getSecurity()).access_token_ttl_minutes * 60_000;
  }

  // ---------- 账号状态 ----------

  async getState(userId: string, fresh = false): Promise<UserAuthState> {
    const hit = this.stateCache.get(userId);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.st;
    const rec = await this.repo.getEntity('user_auth', userId);
    const st = { ...EMPTY_STATE, ...((rec?.data as Partial<UserAuthState>) ?? {}) };
    this.stateCache.set(userId, { st, at: Date.now() });
    return st;
  }

  /** 读-改-写（版本冲突自动重试）。 */
  async updateState(userId: string, fn: (s: UserAuthState) => UserAuthState | void): Promise<UserAuthState> {
    for (let i = 0; i < 8; i++) {
      const rec = await this.repo.getEntity('user_auth', userId);
      const cur = { ...EMPTY_STATE, ...((rec?.data as Partial<UserAuthState>) ?? {}) };
      const draft = { ...cur };
      const next = fn(draft) ?? draft;
      const now = new Date().toISOString();
      const ok = await this.repo.saveEntity(
        { kind: 'user_auth', id: userId, scope: 'user', data: { ...next }, version: rec?.version ?? 0, created_at: rec?.created_at ?? now, updated_at: now },
        rec?.version ?? 0,
      );
      if (ok) {
        this.stateCache.set(userId, { st: next, at: Date.now() });
        return next;
      }
    }
    throw new Error('user auth state write conflict');
  }

  /** 登录前检查锁定；返回剩余锁定分钟数，未锁定返回 0。 */
  async lockedMinutes(userId: string): Promise<number> {
    const st = await this.getState(userId, true);
    const until = st.locked_until ? Date.parse(st.locked_until) : 0;
    return until > Date.now() ? Math.max(1, Math.ceil((until - Date.now()) / 60_000)) : 0;
  }

  /** 记录一次密码错误；返回是否因此被锁定。 */
  async recordFailure(userId: string): Promise<{ locked: boolean; minutes: number }> {
    const s = await this.getSecurity();
    let locked = false;
    await this.updateState(userId, (st) => {
      st.failed_count += 1;
      if (s.lock_after_failures > 0 && st.failed_count >= s.lock_after_failures) {
        st.locked_until = new Date(Date.now() + s.lock_minutes * 60_000).toISOString();
        st.failed_count = 0;
        locked = true;
      }
      return st;
    });
    return { locked, minutes: s.lock_minutes };
  }

  async recordLogin(userId: string): Promise<UserAuthState> {
    return this.updateState(userId, (st) => {
      st.failed_count = 0;
      st.locked_until = null;
      st.last_login_at = new Date().toISOString();
      return st;
    });
  }

  // ---------- 会话 ----------

  private toSession(rec: EntityRecord) {
    return { session_id: rec.id, created_at: rec.created_at, ...(rec.data as unknown as SessionData) };
  }

  async createSession(userId: string, info: DeviceInfo, refreshJti: string, refreshTtlMs: number): Promise<string> {
    const sid = `ses_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const now = new Date().toISOString();
    const dev = guessDevice(info);
    const data: SessionData = {
      user_id: userId,
      device_name: dev.device_name,
      platform: dev.platform,
      ip: info.ip ?? null,
      last_active_at: now,
      refresh_jti: refreshJti,
      expires_at: new Date(Date.now() + refreshTtlMs).toISOString(),
      revoked: false,
    };
    const rec: EntityRecord = { kind: 'auth_session', id: sid, scope: userId, data: { ...data }, version: 0, created_at: now, updated_at: now };
    await this.repo.saveEntity(rec, 0);
    this.sessionCache.set(sid, { rec: { ...rec, version: 1 }, at: Date.now() });
    return sid;
  }

  private async getSessionRec(sid: string, fresh = false): Promise<EntityRecord | undefined> {
    const hit = this.sessionCache.get(sid);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.rec;
    const rec = await this.repo.getEntity('auth_session', sid);
    this.sessionCache.set(sid, { rec, at: Date.now() });
    return rec;
  }

  private async patchSession(sid: string, fn: (d: SessionData) => SessionData | null): Promise<EntityRecord | undefined> {
    for (let i = 0; i < 6; i++) {
      const rec = await this.repo.getEntity('auth_session', sid);
      if (!rec) return undefined;
      const next = fn({ ...(rec.data as unknown as SessionData) });
      if (!next) return rec;
      const updated: EntityRecord = { ...rec, data: { ...next }, updated_at: new Date().toISOString() };
      if (await this.repo.saveEntity(updated, rec.version)) {
        const saved = { ...updated, version: rec.version + 1 };
        this.sessionCache.set(sid, { rec: saved, at: Date.now() });
        return saved;
      }
    }
    return undefined;
  }

  private sessionProblem(d: SessionData | undefined, idleMin: number): AccessCheck {
    if (!d || d.revoked || Date.parse(d.expires_at) < Date.now()) return 'revoked';
    if (idleMin > 0 && Date.now() - Date.parse(d.last_active_at) > idleMin * 60_000 + TOUCH_MS) return 'idle';
    return 'ok';
  }

  /**
   * 校验 access 令牌对应的会话：没被吊销、没空闲超时；通过时节流更新 last_active_at。
   */
  async checkAccess(p: Pick<TokenPayload, 'sub' | 'sid'>): Promise<AccessCheck> {
    if (!p.sid) return (await this.getState(p.sub)).legacy_revoked ? 'revoked' : 'ok';
    const rec = await this.getSessionRec(p.sid);
    const d = rec?.data as unknown as SessionData | undefined;
    if (!rec || d?.user_id !== p.sub) return 'revoked';
    const s = await this.getSecurity();
    const r = this.sessionProblem(d, s.idle_timeout_minutes);
    if (r === 'idle') {
      await this.revokeSession(p.sid);
      return 'idle';
    }
    if (r !== 'ok') return r;
    if (Date.now() - Date.parse(d.last_active_at) > TOUCH_MS) {
      void this.patchSession(p.sid, (x) => ({ ...x, last_active_at: new Date().toISOString() })).catch(() => undefined);
    }
    return 'ok';
  }

  /**
   * refresh 轮换：会话有效且 jti 是会话当前的 refresh_jti，才换成 newJti。
   * 返回 false 表示会话已失效（被踢 / 空闲超时 / 旧 refresh 被重放）。
   */
  async rotateRefresh(sid: string, userId: string, oldJti: string, newJti: string, refreshTtlMs: number): Promise<boolean> {
    const s = await this.getSecurity();
    let ok = false;
    let idle = false;
    const saved = await this.patchSession(sid, (d) => {
      ok = false;
      const r = d.user_id === userId && d.refresh_jti === oldJti ? this.sessionProblem(d, s.idle_timeout_minutes) : 'revoked';
      if (r !== 'ok') {
        idle = r === 'idle';
        return null;
      }
      ok = true;
      const now = new Date().toISOString();
      return { ...d, refresh_jti: newJti, last_active_at: now, expires_at: new Date(Date.now() + refreshTtlMs).toISOString() };
    });
    if (idle) await this.revokeSession(sid);
    return ok && saved?.data.refresh_jti === newJti;
  }

  /** 吊销会话（同时吊销它当前的 refresh 令牌），并通知本进程上该会话的 WS 连接。 */
  async revokeSession(sid: string): Promise<boolean> {
    let jti: string | undefined;
    let changed = false;
    const rec = await this.patchSession(sid, (d) => {
      jti = d.refresh_jti;
      if (d.revoked) return null;
      changed = true;
      return { ...d, revoked: true };
    });
    if (!rec) return false;
    if (jti) await this.repo.revokeRefreshToken(jti);
    for (const cb of this.revokeListeners.get(sid) ?? []) cb();
    return changed;
  }

  /** 吊销用户的全部会话（exceptSid 除外），并拒绝没有 sid 的旧令牌。返回吊销数量。 */
  async revokeAll(userId: string, exceptSid?: string): Promise<number> {
    await this.updateState(userId, (st) => ({ ...st, legacy_revoked: true }));
    let n = 0;
    for (const rec of await this.repo.listEntities('auth_session', userId)) {
      if (rec.id === exceptSid || (rec.data as unknown as SessionData).revoked) continue;
      if (await this.revokeSession(rec.id)) n++;
    }
    return n;
  }

  /** 有效会话，最近活跃的在前。 */
  async listSessions(userId: string) {
    const s = await this.getSecurity();
    return (await this.repo.listEntities('auth_session', userId))
      .filter((r) => this.sessionProblem(r.data as unknown as SessionData, s.idle_timeout_minutes) === 'ok')
      .map((r) => this.toSession(r))
      .sort((a, b) => b.last_active_at.localeCompare(a.last_active_at) || b.created_at.localeCompare(a.created_at));
  }

  async getSession(sid: string) {
    const rec = await this.getSessionRec(sid, true);
    return rec ? this.toSession(rec) : undefined;
  }

  /** WS 连接登记：会话被吊销时回调（用于以 4401 关闭）。 */
  onRevoke(sid: string | undefined, cb: () => void): () => void {
    if (!sid) return () => undefined;
    let set = this.revokeListeners.get(sid);
    if (!set) this.revokeListeners.set(sid, (set = new Set()));
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (!set!.size) this.revokeListeners.delete(sid);
    };
  }
}
