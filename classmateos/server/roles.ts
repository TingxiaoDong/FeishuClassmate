/**
 * 角色与权限点（迭代 5 R-AD-03）。
 * 存在通用对象表 kind=access_roles / id=roles（带版本号，并发写自动重试）。
 * 没有显式分配过角色的账号按账号身份推出默认角色：admin → super_admin，member → member。
 */
import { randomUUID } from 'node:crypto';
import { MEMBER_DEFAULT, PERMISSION_POINTS, type PermissionPoint } from './permissions.js';
import type { Repo, UserRecord } from './repo.js';

export interface RoleDef { role_id: string; name: string; description: string; builtin: boolean; permissions: string[] }
interface RoleState { roles: RoleDef[]; assignments: Record<string, string[]> }
export class RoleError extends Error { constructor(public status: number, message: string, public code = 'BAD_REQUEST') { super(message); } }

const KIND = 'access_roles';
const ID = 'roles';
export const SUPER = 'super_admin';
const ADMIN_POINTS = PERMISSION_POINTS.filter((p) => p !== 'admin.roles');
const BUILTIN: RoleDef[] = [
  { role_id: SUPER, name: '超级管理员', description: '拥有全部权限', builtin: true, permissions: [...PERMISSION_POINTS] },
  { role_id: 'admin', name: '管理员', description: '日常管理（不含角色管理）', builtin: true, permissions: [...ADMIN_POINTS] },
  { role_id: 'member', name: '普通成员', description: '默认角色', builtin: true, permissions: [...MEMBER_DEFAULT] },
];
const CACHE_MS = 2000;

export class RoleService {
  private cache?: { s: RoleState; at: number };
  constructor(private readonly repo: Repo) {}

  private normalize(raw: Partial<RoleState> | undefined): RoleState {
    const roles = [...(raw?.roles ?? [])];
    for (const b of BUILTIN) if (!roles.some((r) => r.role_id === b.role_id)) roles.unshift(structuredClone(b));
    const sup = roles.find((r) => r.role_id === SUPER)!;
    sup.permissions = [...PERMISSION_POINTS];
    return { roles, assignments: { ...(raw?.assignments ?? {}) } };
  }

  async read(fresh = false): Promise<RoleState> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return structuredClone(this.cache.s);
    const r = await this.repo.getEntity(KIND, ID);
    const s = this.normalize(r?.data as Partial<RoleState> | undefined);
    this.cache = { s, at: Date.now() };
    return structuredClone(s);
  }

  async change<T>(fn: (s: RoleState) => Promise<T> | T): Promise<T> {
    for (let i = 0; i < 8; i++) {
      const r = await this.repo.getEntity(KIND, ID);
      const s = this.normalize(r?.data as Partial<RoleState> | undefined);
      const out = await fn(s);
      const now = new Date().toISOString();
      const ok = await this.repo.saveEntity(
        { kind: KIND, id: ID, scope: 'global', data: { ...s } as unknown as Record<string, unknown>, version: r?.version ?? 0, created_at: r?.created_at ?? now, updated_at: now },
        r?.version ?? 0,
      );
      if (ok) {
        this.cache = { s, at: Date.now() };
        return out;
      }
    }
    throw new RoleError(409, '角色已被其他人修改，请刷新后重试', 'CONFLICT');
  }

  roleIdsOf(s: RoleState, user: Pick<UserRecord, 'user_id' | 'role'>): string[] {
    const set = s.assignments[user.user_id];
    if (set) return set.filter((id) => s.roles.some((r) => r.role_id === id));
    if (user.role === 'admin') return [SUPER];
    if (user.role === 'member') return ['member'];
    return [];
  }

  async roleIds(user: Pick<UserRecord, 'user_id' | 'role'>): Promise<string[]> {
    return this.roleIdsOf(await this.read(), user);
  }

  async permissionsOf(user: Pick<UserRecord, 'user_id' | 'role' | 'disabled'>): Promise<string[]> {
    if (user.disabled || user.role === 'bot') return [];
    const s = await this.read();
    const out = new Set<string>();
    for (const id of this.roleIdsOf(s, user)) for (const p of s.roles.find((r) => r.role_id === id)?.permissions ?? []) out.add(p);
    return PERMISSION_POINTS.filter((p) => out.has(p)).concat([...out].filter((p) => !(PERMISSION_POINTS as readonly string[]).includes(p)));
  }

  async has(user: Pick<UserRecord, 'user_id' | 'role' | 'disabled'>, p: PermissionPoint): Promise<boolean> {
    return (await this.permissionsOf(user)).includes(p);
  }

  async isSuper(user: Pick<UserRecord, 'user_id' | 'role'>): Promise<boolean> {
    return (await this.roleIds(user)).includes(SUPER);
  }

  /** 角色成员（含按账号身份推出默认角色的人）。 */
  membersOf(s: RoleState, roleId: string, users: UserRecord[]): string[] {
    return users.filter((u) => u.role !== 'bot' && this.roleIdsOf(s, u).includes(roleId)).map((u) => u.user_id);
  }

  json(s: RoleState, r: RoleDef, users: UserRecord[]) {
    return { role_id: r.role_id, name: r.name, description: r.description, builtin: r.builtin, permissions: r.permissions, member_ids: this.membersOf(s, r.role_id, users) };
  }

  static checkPermissions(v: unknown, granter: string[]): string[] {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new RoleError(422, '权限点必须是字符串数组');
    const list = [...new Set(v as string[])];
    const unknown = list.filter((p) => !(PERMISSION_POINTS as readonly string[]).includes(p));
    if (unknown.length) throw new RoleError(422, `未知的权限点：${unknown.join('、')}`);
    const beyond = list.filter((p) => !granter.includes(p));
    if (beyond.length) throw new RoleError(403, `不能授予自己没有的权限：${beyond.join('、')}`, 'FORBIDDEN');
    return list;
  }

  static newId(): string {
    return `role_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
}

/** 根据角色同步账号身份（super_admin / admin → admin，其余 → member），保持旧接口里 role==='admin' 的判断一致。 */
export function accountRoleFor(roleIds: string[]): 'admin' | 'member' {
  return roleIds.includes(SUPER) || roleIds.includes('admin') ? 'admin' : 'member';
}
