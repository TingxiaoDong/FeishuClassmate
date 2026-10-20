/**
 * 组织架构（迭代 5 R-AD-02）。读接口所有登录用户可调（通讯录浏览），写接口要 admin.departments，机器人不能代办。
 * 写操作记操作日志 department.change，并把成员的旧字段 department 同步成主部门名称。
 */
import type { FastifyRequest } from 'fastify';
import type { AuthedUser, Ctx } from './context.js';
import { fail, pageOffset, pageResult, pageSize } from './context.js';
import { OrgError } from './organization.js';
import { nowIso } from './repo.js';

const ORG_CODES: Record<number, string> = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'VALIDATION_FAILED' };

export function registerDepartmentRoutes(ctx: Ctx) {
  const org = ctx.org;
  const root = '/api/v1/departments';
  const methods = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
  const paths = [root, `${root}/:id`, `${root}/:id/path`, `${root}/:id/members`, `${root}/:id/members/:user_id`];
  const allowed = new Set(['GET 0', 'POST 0', 'GET 1', 'PATCH 1', 'DELETE 1', 'GET 2', 'POST 3', 'DELETE 4']);

  /** 把这些成员的旧字段 department 同步成主部门名称。 */
  async function syncLegacy(uids: string[]) {
    const s = await org.read();
    for (const uid of uids) {
      const u = await ctx.repo.getUser(uid);
      if (!u) continue;
      const m = s.members[uid];
      const name = s.departments.find((d) => d.department_id === m?.primary_department_id)?.name ?? null;
      if (u.department !== name) {
        await ctx.repo.updateUser(uid, { department: name, updated_at: nowIso() });
        ctx.invalidateUser(uid);
      }
    }
  }

  const audit = (req: FastifyRequest, me: AuthedUser, id: string, name: string | null, detail: string) =>
    ctx.auditLog.record({ req, operator_id: me.sub, operator_name: me.user.name, action: 'department.change', target_type: 'department', target_id: id, target_name: name, detail });

  for (const method of methods) for (const [idx, url] of paths.entries()) {
    if (!allowed.has(`${method} ${idx}`)) continue;
    ctx.app.route({ method, url, handler: async (req, reply) => {
      const me = await ctx.requireUser(req, reply); if (!me) return;
      if (method !== 'GET' && (me.via_bot || !(await ctx.roles.has(me.user, 'admin.departments')))) return fail(reply, 403, '没有组织架构管理权限', { code: 'FORBIDDEN' });
      const { id, user_id } = req.params as { id: string; user_id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        if (method === 'GET') {
          const s = await org.read();
          if (idx === 0) {
            const q = req.query as { parent_id?: string; page_size?: string; page_token?: string };
            const parent = q.parent_id === 'root' ? null : q.parent_id;
            const items = s.departments.filter(d => parent === undefined || d.parent_id === parent).sort((a,b) => a.order-b.order || a.department_id.localeCompare(b.department_id));
            const offset = pageOffset(q.page_token), limit = pageSize(q.page_size, 500, 1000);
            return pageResult(items.slice(offset, offset+limit).map(d => org.json(s,d)), items.length, offset);
          }
          const d = org.get(s,id);
          if (idx === 1) return org.json(s,d);
          const items = [d]; let p = d.parent_id;
          while (p) { const up = org.get(s,p); items.unshift(up); p = up.parent_id; }
          return { items: items.map(x => org.json(s,x)), page_token: null, has_more: false };
        }
        const before = await org.read();
        const oldName = before.departments.find((d) => d.department_id === id)?.name ?? null;
        let result;
        let detail = '';
        let touched: string[] = [];
        if (method === 'POST' && idx === 0) { result = await org.create(b); detail = '新建部门'; }
        if (method === 'PATCH') {
          result = await org.update(id,b);
          detail = `修改：${Object.keys(b).join('、') || '无'}`;
          // 改名后，以它为主部门的成员旧字段要跟着改
          if (b.name !== undefined && result.name !== oldName) touched = Object.entries(before.members).filter(([, m]) => m.primary_department_id === id).map(([uid]) => uid);
        }
        if (method === 'DELETE' && idx === 1) { await org.remove(id); detail = '删除部门'; }
        if (method === 'POST' && idx === 3) {
          const ids = await org.validUsers(b.user_ids);
          await org.addMembers(id, ids);
          touched = ids; detail = `加入成员：${ids.join('、')}`;
        }
        if (method === 'DELETE' && idx === 4) { await org.removeMember(id,user_id); touched = [user_id]; detail = `移出成员：${user_id}`; }
        if (touched.length) await syncLegacy(touched);
        const depId = result?.department_id ?? id;
        await audit(req, me, depId, result?.name ?? oldName, detail);
        const audience = (await ctx.repo.listUsers({ limit: 1000000, offset: 0 })).items.filter(u=>!u.disabled).map(u=>u.user_id);
        ctx.publish('department.changed', { department_id: depId }, audience, { user_only: true });
        if (touched.length) ctx.publish('user.updated', { user_ids: touched }, audience, { user_only: true });
        if (result) { const s = await org.read(); return reply.code(method === 'POST' ? 201 : 200).send(org.json(s,result)); }
        return reply.code(204).send();
      } catch (e) { if (e instanceof OrgError) return fail(reply,e.status,e.message,{ code: ORG_CODES[e.status] ?? 'BAD_REQUEST' }); throw e; }
    } });
  }
}
