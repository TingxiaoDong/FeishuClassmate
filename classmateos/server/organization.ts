import { createHash, randomUUID } from 'node:crypto';
import type { Repo } from './repo.js';

export interface Department { department_id: string; name: string; parent_id: string | null; leader_id: string | null; order: number; aliases: string[] }
export interface OrgMember { department_ids: string[]; primary_department_id: string | null; leader_id: string | null }
export interface Organization { departments: Department[]; members: Record<string, OrgMember> }
export class OrgError extends Error { constructor(public status: number, message: string) { super(message); } }
const KIND = 'organization';
const ID = 'directory';
export class OrganizationService {
  constructor(private repo: Repo) {}
  async read(): Promise<Organization> {
    const r = await this.repo.getEntity(KIND, ID);
    return r ? structuredClone(r.data) as unknown as Organization : { departments: [], members: {} };
  }
  async change<T>(fn: (s: Organization) => T): Promise<T> {
    for (let i = 0; i < 8; i++) {
      const r = await this.repo.getEntity(KIND, ID);
      const s = r ? structuredClone(r.data) as unknown as Organization : { departments: [], members: {} };
      const result = fn(s);
      const now = new Date().toISOString();
      if (await this.repo.saveEntity({ kind: KIND, id: ID, scope: 'global', data: { ...s }, version: r?.version ?? 0, created_at: r?.created_at ?? now, updated_at: now }, r?.version ?? 0)) return result;
    }
    throw new OrgError(409, '组织架构已被其他人修改，请重试');
  }
  async migrate() {
    const users = (await this.repo.listUsers({ limit: 1000000, offset: 0 })).items;
    await this.change(s => {
      for (const u of users) {
        if (s.members[u.user_id] || u.role === 'bot') continue;
        let d = u.department ? s.departments.find(d => d.aliases.includes(u.department!) || d.name === u.department) : undefined;
        if (!d && u.department) {
          d = { department_id: 'dept_' + createHash('sha256').update(u.department).digest('hex').slice(0, 24), name: u.department, parent_id: null, leader_id: null, order: s.departments.length, aliases: [u.department] };
          s.departments.push(d);
        }
        s.members[u.user_id] = { department_ids: d ? [d.department_id] : [], primary_department_id: d?.department_id ?? null, leader_id: null };
      }
    });
  }
  async validUsers(ids: unknown): Promise<string[]> {
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some(x => typeof x !== 'string')) throw new OrgError(422, '成员必须是用户 ID 数组，最多 1000 人');
    const unique = [...new Set(ids)] as string[];
    for (const id of unique) { const u = await this.repo.getUser(id); if (!u || u.role === 'bot' || u.disabled) throw new OrgError(422, '成员不存在或已停用'); }
    return unique;
  }
  async create(body: Record<string, unknown>) {
    const name = this.name(body.name);
    const leader_id = await this.leader(body.leader_id);
    const department_id = 'dept_' + randomUUID().replaceAll('-', '');
    return this.change(s => {
      const parent_id = this.parent(s, body.parent_id ?? null);
      if (s.departments.some(d => d.parent_id === parent_id && d.name.toLowerCase() === name.toLowerCase())) throw new OrgError(409, '同级部门名称已存在');
      const d: Department = { department_id, name, parent_id, leader_id, order: s.departments.filter(d => d.parent_id === parent_id).length, aliases: [] };
      s.departments.push(d); return d;
    });
  }
  async update(id: string, body: Record<string, unknown>) {
    const name = body.name === undefined ? undefined : this.name(body.name);
    const leader = body.leader_id === undefined ? undefined : await this.leader(body.leader_id);
    if (body.order !== undefined && (typeof body.order !== 'number' || !Number.isSafeInteger(body.order) || body.order < 0)) throw new OrgError(422, '排序必须是非负整数');
    return this.change(s => {
      const d = this.get(s, id);
      const parent = body.parent_id === undefined ? d.parent_id : this.parent(s, body.parent_id);
      if (parent && this.descendants(s, id).has(parent)) throw new OrgError(400, '不能把部门移动到自己或下级部门中');
      if (s.departments.some(x => x.department_id !== id && x.parent_id === parent && x.name.toLowerCase() === (name ?? d.name).toLowerCase())) throw new OrgError(409, '同级部门名称已存在');
      d.parent_id = parent; if (name !== undefined) d.name = name;
      if (leader !== undefined) d.leader_id = leader;
      if (body.order !== undefined) d.order = body.order as number;
      return d;
    });
  }
  async remove(id: string) {
    return this.change(s => {
      this.get(s, id);
      if (s.departments.some(d => d.parent_id === id)) throw new OrgError(409, '部门有下级部门，不能删除');
      if (Object.values(s.members).some(m => m.department_ids.includes(id))) throw new OrgError(409, '部门还有成员，不能删除');
      s.departments = s.departments.filter(d => d.department_id !== id);
    });
  }
  async addMembers(id: string, ids: unknown) {
    const users = await this.validUsers(ids);
    await this.change(s => { this.get(s, id); for (const uid of users) {
      const m = s.members[uid] ??= { department_ids: [], primary_department_id: null, leader_id: null };
      if (!m.department_ids.includes(id)) m.department_ids.push(id);
      m.primary_department_id ??= id;
    } });
  }
  async removeMember(id: string, uid: string) {
    await this.change(s => { this.get(s, id); const m = s.members[uid]; if (!m) return;
      m.department_ids = m.department_ids.filter(x => x !== id);
      if (m.primary_department_id === id) m.primary_department_id = m.department_ids[0] ?? null;
    });
  }
  get(s: Organization, id: string) { const d = s.departments.find(d => d.department_id === id); if (!d) throw new OrgError(404, '部门不存在'); return d; }
  descendants(s: Organization, id: string) {
    const out = new Set([id]); let n = 0;
    while (n !== out.size) { n = out.size; for (const d of s.departments) if (d.parent_id && out.has(d.parent_id)) out.add(d.department_id); }
    return out;
  }
  json(s: Organization, d: Department) {
    const descendants = this.descendants(s, d.department_id);
    const { aliases, ...pub } = d;
    return { ...pub, member_count: Object.values(s.members).filter(m => m.department_ids.some(id => descendants.has(id))).length, has_children: s.departments.some(x => x.parent_id === d.department_id) };
  }
  private name(v: unknown) { if (typeof v !== 'string' || !v.trim() || v.trim().length > 100) throw new OrgError(422, '部门名称不能为空且不能超过 100 字'); return v.trim(); }
  private parent(s: Organization, v: unknown): string | null { if (v === null) return null; if (typeof v !== 'string') throw new OrgError(422, '上级部门必须是部门 ID 或 null'); this.get(s, v); return v; }
  private async leader(v: unknown): Promise<string | null> { if (v == null) return null; await this.validUsers([v]); return v as string; }
}

/** 已迁移成员按 ID/旧名映射匹配，不能再按旧 user.department 授权，防止移出后仍能访问。 */
export async function belongsToDepartment(repo: Repo, uid: string, dept: string): Promise<boolean> {
  const s = await new OrganizationService(repo).read();
  const m = s.members[uid];
  if (!m) return (await repo.getUser(uid))?.department === dept;
  const d = s.departments.find(d => d.department_id === dept || d.aliases.includes(dept));
  return !!d && m.department_ids.includes(d.department_id);
}
