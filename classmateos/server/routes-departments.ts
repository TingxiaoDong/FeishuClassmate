import type { Ctx } from './context.js';
import { fail, pageOffset, pageResult, pageSize } from './context.js';
import { OrgError } from './organization.js';

export function registerDepartmentRoutes(ctx: Ctx) {
  const org = ctx.org;
  const root = '/api/v1/departments';
  const methods = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
  const paths = [root, `${root}/:id`, `${root}/:id/path`, `${root}/:id/members`, `${root}/:id/members/:user_id`];
  const allowed = new Set(['GET 0', 'POST 0', 'GET 1', 'PATCH 1', 'DELETE 1', 'GET 2', 'POST 3', 'DELETE 4']);
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
        let result;
        if (method === 'POST' && idx === 0) result = await org.create(b);
        if (method === 'PATCH') result = await org.update(id,b);
        if (method === 'DELETE' && idx === 1) await org.remove(id);
        if (method === 'POST' && idx === 3) await org.addMembers(id,b.user_ids);
        if (method === 'DELETE' && idx === 4) await org.removeMember(id,user_id);
        const audience = (await ctx.repo.listUsers({ limit: 1000000, offset: 0 })).items.filter(u=>!u.disabled).map(u=>u.user_id);
        ctx.publish('department.changed', { department_id: result?.department_id ?? id }, audience, { user_only: true });
        if (result) { const s = await org.read(); return reply.code(method === 'POST' ? 201 : 200).send(org.json(s,result)); }
        return reply.code(204).send();
      } catch (e) { if (e instanceof OrgError) return fail(reply,e.status,e.message); throw e; }
    } });
  }
}
