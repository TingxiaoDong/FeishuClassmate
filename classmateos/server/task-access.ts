import { belongsToDepartment } from './organization.js';
/**
 * 二期 R-TK-01 ~ 05：任务权限、任务清单授权、实时事件受众。
 *
 * 通用对象（cos_entities）里的任务扩展：
 *   tasklist       id = list_id，                 scope = ''
 *   task_section   id = section_id，              scope = list_id
 *   task_in_list   id = `${task_id}|${list_id}`，  scope = list_id
 *   task_comment   id = comment_id，              scope = task_id
 *   task_activity  id = activity_id，             scope = task_id
 *   task_file      id = `${file_key}|${task_id}`，scope = file_key
 * 清单成员用共用授权 cos_resource_grants（resource_type = 'tasklist'）。
 */

import type { Ctx } from './context.js';
import type { EntityRecord, ResourceGrant, TaskRecord } from './repo.js';
import { resourceRole, type ResourceRole } from './resource-access.js';

export const MAX_TASK_DEPTH = 3;
const ranks: Record<ResourceRole, number> = { viewer: 1, commenter: 2, editor: 3, manager: 4 };
const higher = (a: ResourceRole | null, b: ResourceRole | null) => (!a ? b : !b ? a : ranks[b] > ranks[a] ? b : a);

export function taskPermissions(role: ResourceRole | null) {
  const n = role ? ranks[role] : 0;
  return {
    can_view: n >= 1,
    can_comment: n >= 2,
    can_follow: n >= 1,
    can_edit: n >= 3,
    can_manage_followers: n >= 3,
    can_delete: n >= 4,
  };
}

export function listPermissions(role: ResourceRole | null) {
  const n = role ? ranks[role] : 0;
  return { can_view: n >= 1, can_edit: n >= 3, can_manage: n >= 4, can_delete: n >= 4 };
}

/** 一次请求内的缓存，列表接口里避免重复查询。 */
export class TaskAccess {
  private tasks = new Map<string, TaskRecord | undefined>();
  private grants = new Map<string, ResourceGrant | undefined>();
  private listRoles = new Map<string, ResourceRole | null>();
  private memberships?: EntityRecord[];
  private lists?: Map<string, EntityRecord>;

  constructor(private readonly ctx: Ctx, private readonly userId: string) {}

  async task(id: string) {
    if (!this.tasks.has(id)) this.tasks.set(id, await this.ctx.repo.getTask(id));
    return this.tasks.get(id);
  }
  remember(t: TaskRecord) {
    this.tasks.set(t.task_id, t);
  }

  /** 自己 + 祖先（从近到远），最多 MAX_TASK_DEPTH 层。 */
  async chain(t: TaskRecord): Promise<TaskRecord[]> {
    const out = [t];
    let cur = t;
    while (cur.parent_id && out.length < MAX_TASK_DEPTH + 1) {
      const p = await this.task(cur.parent_id);
      if (!p) break;
      out.push(p);
      cur = p;
    }
    return out;
  }

  async depth(t: TaskRecord) {
    return (await this.chain(t)).length;
  }

  async allLists() {
    this.lists ??= new Map((await this.ctx.repo.listEntities('tasklist')).map((e) => [e.id, e]));
    return this.lists;
  }

  async allMemberships() {
    this.memberships ??= await this.ctx.repo.listEntities('task_in_list');
    return this.memberships;
  }

  async membershipsOf(taskId: string) {
    return (await this.allMemberships()).filter((m) => m.data.task_id === taskId);
  }

  async grant(listId: string) {
    if (!this.grants.has(listId)) this.grants.set(listId, await this.ctx.repo.getResourceGrant('tasklist', listId));
    return this.grants.get(listId);
  }

  async listRole(listId: string): Promise<ResourceRole | null> {
    if (!this.listRoles.has(listId)) {
      const list = (await this.allLists()).get(listId);
      const g = list ? await this.grant(listId) : undefined;
      this.listRoles.set(listId, g ? await resourceRole(this.ctx.repo, this.userId, g) : null);
    }
    return this.listRoles.get(listId)!;
  }

  /**
   * 任务角色（取最高）：
   *   本任务创建人 → manager；本任务负责人 → editor；
   *   祖先任务创建人 → manager，祖先负责人 → editor（子任务跟着父任务走）；
   *   本任务或祖先的关注人 → commenter（能看、能评论，不能改）；
   *   所在清单（看顶层任务所在清单）：可管理 / 可编辑 → editor，可阅读 → commenter。
   */
  async role(t: TaskRecord): Promise<ResourceRole | null> {
    const user = await this.ctx.repo.getUser(this.userId);
    if (!user || user.disabled || user.role === 'bot') return null;
    let role: ResourceRole | null = null;
    const chain = await this.chain(t);
    for (const x of chain) {
      if (x.created_by === this.userId) role = higher(role, 'manager');
      if (x.assignee_id === this.userId) role = higher(role, 'editor');
      if ((x.follower_ids ?? []).includes(this.userId)) role = higher(role, 'commenter');
    }
    for (const x of chain) {
      for (const m of await this.membershipsOf(x.task_id)) {
        const lr = await this.listRole(String(m.data.list_id));
        if (lr) role = higher(role, ranks[lr] >= 3 ? 'editor' : 'commenter');
      }
    }
    return role;
  }

  /** 我能看到的清单里的全部任务 ID（用于 GET /tasks 扩大可见范围）。 */
  async taskIdsInMyLists(): Promise<string[]> {
    const ids: string[] = [];
    for (const m of await this.allMemberships()) {
      if (await this.listRole(String(m.data.list_id))) ids.push(String(m.data.task_id));
    }
    return ids;
  }

  /** 清单授权涉及的全部用户（所有者 + 成员 / 部门 / 群展开）。 */
  async grantUsers(listId: string): Promise<string[]> {
    const g = await this.grant(listId);
    if (!g) return [];
    const out = new Set<string>([g.owner_id]);
    let users: Awaited<ReturnType<Ctx['repo']['listUsers']>>['items'] | undefined;
    for (const m of g.members) {
      if (m.member_type === 'user') out.add(m.member_id);
      else if (m.member_type === 'chat') (await this.ctx.repo.getChat(m.member_id))?.member_ids.forEach((u) => out.add(u));
      else {
        users ??= (await this.ctx.repo.listUsers({ limit: 100_000, offset: 0 })).items;
        for (const u of users) if (await belongsToDepartment(this.ctx.repo, u.user_id, m.member_id)) out.add(u.user_id);
      }
    }
    return [...out];
  }

  /** 任务事件推给：负责人、创建人、关注人（含祖先任务的）、所在清单的全部成员。 */
  async audience(t: TaskRecord): Promise<string[]> {
    const out = new Set<string>();
    for (const x of await this.chain(t)) {
      out.add(x.created_by);
      if (x.assignee_id) out.add(x.assignee_id);
      (x.follower_ids ?? []).forEach((u) => out.add(u));
      for (const m of await this.membershipsOf(x.task_id)) (await this.grantUsers(String(m.data.list_id))).forEach((u) => out.add(u));
    }
    return [...out];
  }
}
