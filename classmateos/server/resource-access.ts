import { belongsToDepartment } from './organization.js';
/** 二期共用资源授权。路由接入前不改变一期访问行为。 */
import type { Repo, ResourceGrant } from './repo.js';

export type ResourceRole = 'viewer' | 'commenter' | 'editor' | 'manager';
const ranks: Record<ResourceRole, number> = { viewer: 1, commenter: 2, editor: 3, manager: 4 };

export function permissionFlags(role: ResourceRole | null) {
  const n = role ? ranks[role] : 0;
  return { can_view: n >= 1, can_comment: n >= 2, can_edit: n >= 3, can_manage: n >= 4, can_delete: n >= 4 };
}

/** 调用方必须先确认资源存在、未删除，再提供明确的默认授权。 */
export async function resourceRole(repo: Repo, userId: string, grant: ResourceGrant): Promise<ResourceRole | null> {
  const user = await repo.getUser(userId);
  if (!user || user.disabled || user.role === 'bot') return null;
  if (user.role === 'admin' || grant.owner_id === userId) return 'manager';
  let role: ResourceRole | null = grant.visibility === 'org_edit' || grant.visibility === 'all'
    ? 'editor' : grant.visibility === 'org_view' ? 'viewer' : null;
  for (const member of grant.members) {
    let matches = member.member_type === 'user' && member.member_id === userId;
    // 同时兼容已迁移部门 ID 和旧授权名称。
    if (member.member_type === 'department') matches = await belongsToDepartment(repo, userId, member.member_id);
    if (member.member_type === 'chat') {
      const chat = await repo.getChat(member.member_id);
      matches = !!chat?.member_ids.includes(userId);
    }
    if (matches && (!role || ranks[member.role] > ranks[role])) role = member.role;
  }
  return role;
}

/** 严格检查授权数据；不静默丢弃未知角色或类型。 */
export async function validateGrant(repo: Repo, grant: ResourceGrant): Promise<Array<{ field: string; message: string }>> {
  const errors: Array<{ field: string; message: string }> = [];
  const allowed = grant.resource_type === 'doc' ? ['off', 'org_view', 'org_edit'] : ['all', 'members'];
  if (!allowed.includes(grant.visibility)) errors.push({ field: 'visibility', message: '不支持的可见范围' });
  const owner = await repo.getUser(grant.owner_id);
  if (!owner || owner.disabled || owner.role === 'bot') errors.push({ field: 'owner_id', message: '所有者必须是有效成员' });
  if (!Array.isArray(grant.members) || grant.members.length > 500) {
    errors.push({ field: 'members', message: '协作者必须为数组，且不能超过 500 项' });
    return errors;
  }
  const seen = new Set<string>();
  for (const [i, member] of grant.members.entries()) {
    const field = `members[${i}]`;
    if (!member || !['user', 'department', 'chat'].includes(member.member_type) || typeof member.member_id !== 'string' || !member.member_id.trim()) {
      errors.push({ field, message: '协作者类型或标识无效' });
      continue;
    }
    if (!Object.hasOwn(ranks, member.role) || (grant.resource_type !== 'doc' && member.role === 'commenter')) errors.push({ field: `${field}.role`, message: '不支持的协作者角色' });
    const key = `${member.member_type}:${member.member_id}`;
    if (seen.has(key)) errors.push({ field, message: '协作者重复' });
    seen.add(key);
    if (member.member_type === 'user') {
      const user = await repo.getUser(member.member_id);
      if (!user || user.disabled || user.role === 'bot') errors.push({ field, message: '成员不存在或不可用' });
    } else if (member.member_type === 'chat' && !(await repo.getChat(member.member_id))) {
      errors.push({ field, message: '群组不存在' });
    }
    if (member.member_type === 'user' && member.member_id === grant.owner_id && member.role !== 'manager') errors.push({ field, message: '所有者不能被降权' });
  }
  return errors;
}
