/**
 * 权限点（二期迭代 5 第 3 节）。
 *
 * 批次 0 过渡实现：还没有「角色」表，权限点由账号的 role 推出——
 *   admin  → 全部权限点；
 *   member → MEMBER_DEFAULT（和现在后端实际放开的行为一致：人人都能建表）；
 *   bot    → 无。
 * 批次 2 做角色管理时改成「所有角色权限的并集」，接口格式不变。
 */
import type { UserRecord } from './repo.js';

export const PERMISSION_POINTS = [
  'admin.members',
  'admin.departments',
  'admin.roles',
  'admin.audit',
  'admin.security',
  'table.create',
  'table.delete',
  'doc.delete',
  'doc.share',
  'doc.template',
  'wiki.create',
  'org.departments',
] as const;

export type PermissionPoint = (typeof PERMISSION_POINTS)[number];

/** 普通成员默认拥有的权限点。 */
export const MEMBER_DEFAULT: readonly PermissionPoint[] = ['table.create', 'doc.delete', 'doc.share', 'wiki.create'];

export function permissionsOf(user: Pick<UserRecord, 'role' | 'disabled'>): PermissionPoint[] {
  if (user.disabled || user.role === 'bot') return [];
  if (user.role === 'admin') return [...PERMISSION_POINTS];
  return [...MEMBER_DEFAULT];
}

export function hasPermission(user: Pick<UserRecord, 'role' | 'disabled'>, point: PermissionPoint): boolean {
  return permissionsOf(user).includes(point);
}
