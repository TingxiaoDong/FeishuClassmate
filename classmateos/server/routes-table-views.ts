/**
 * 视图（《二期功能需求文档》R-BT-03）。
 *
 *   GET    /tables/:key/views              公共视图 + 自己的个人视图（没有视图时自动建「表格视图」）
 *   POST   /tables/:key/views              新建；没有 can_edit 只能建个人视图
 *   PATCH  /tables/:key/views/:view_id     改名 / config（整体替换）/ personal，必须带 version
 *   DELETE /tables/:key/views/:view_id     最后一个公共视图不可删（422）
 *   PUT    /tables/:key/views/order        { view_ids }
 *
 * 公共视图需要表的 can_edit 才能改；个人视图只有本人能改、能删。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { fail, invalid, newId, type AuthedUser, type Ctx, type FieldError } from './context.js';
import { nowIso, type TableViewRecord, type ViewType } from './repo.js';
import type { ResolvedTable, TableService } from './table-service.js';
import { tablePermissions } from './table-schema.js';
import { parseViewConfig, VIEW_TYPES } from './view-engine.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const chars = (s: string) => [...s].length;

export function registerTableViewRoutes(ctx: Ctx, svc: TableService): void {
  const { app, repo } = ctx;

  const begin = async (req: FastifyRequest, reply: FastifyReply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return undefined;
    const { table_key } = req.params as { table_key: string };
    const res = await svc.load(table_key);
    if (!res) {
      fail(reply, 404, `数据表不存在：${table_key}`, { code: 'TABLE_NOT_FOUND' });
      return undefined;
    }
    return { me, res, canEdit: tablePermissions(me, res.schema).can_edit };
  };

  const json = (v: TableViewRecord, res: ResolvedTable, me: AuthedUser, canEdit: boolean) => svc.viewJson(v, res, me, canEdit);

  const parseName = (raw: unknown, errors: FieldError[]): string | undefined => {
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push({ field: 'name', message: '请填写视图名称' });
      return undefined;
    }
    const n = raw.trim();
    if (chars(n) > 60) {
      errors.push({ field: 'name', message: '视图名称最多 60 个字' });
      return undefined;
    }
    return n;
  };

  /** 找到本人能看到的视图。 */
  const findView = async (res: ResolvedTable, viewId: string, me: AuthedUser, reply: FastifyReply) => {
    const v = await repo.getView(viewId);
    if (!v || v.table_key !== res.schema.key || !svc.viewVisible(v, me)) {
      fail(reply, 404, '视图不存在', { code: 'VIEW_NOT_FOUND' });
      return undefined;
    }
    return v;
  };

  const canModify = (v: TableViewRecord, me: AuthedUser, canEdit: boolean) => (v.personal ? v.owner_id === me.sub : canEdit);

  app.get('/api/v1/tables/:table_key/views', async (req, reply) => {
    const b = await begin(req, reply);
    if (!b) return;
    const list = (await svc.views(b.res.schema.key)).filter((v) => svc.viewVisible(v, b.me));
    return { items: list.map((v) => json(v, b.res, b.me, b.canEdit)) };
  });

  app.post('/api/v1/tables/:table_key/views', async (req, reply) => {
    const b = await begin(req, reply);
    if (!b) return;
    const body = isObj(req.body) ? req.body : {};
    const errors: FieldError[] = [];
    const name = parseName(body.name, errors);
    const type = body.type ?? 'grid';
    if (typeof type !== 'string' || !(VIEW_TYPES as readonly string[]).includes(type)) {
      errors.push({ field: 'type', message: `视图类型只能是 ${VIEW_TYPES.join('、')}` });
    }
    if (body.personal != null && typeof body.personal !== 'boolean') errors.push({ field: 'personal', message: '必须是 true 或 false' });
    const config = parseViewConfig(body.config, b.res.schema.fields, errors);
    if (errors.length) return invalid(reply, errors);
    const personal = body.personal === true;
    if (!personal && !b.canEdit) return fail(reply, 403, '你没有这张表的编辑权限，只能新建个人视图', { code: 'FORBIDDEN' });

    const key = b.res.schema.key;
    const created = await svc.withLock(key, async () => {
      const existing = await svc.views(key);
      const now = nowIso();
      const v: TableViewRecord = {
        view_id: newId('vew'),
        table_key: key,
        name: name!,
        type: type as ViewType,
        personal,
        owner_id: personal ? b.me.sub : null,
        config: config!,
        version: 1,
        position: existing.reduce((m, x) => Math.max(m, x.position), 0) + 1,
        created_by: b.me.sub,
        created_at: now,
        updated_at: now,
      };
      await repo.insertView(v);
      return v;
    });
    svc.emitViewChanged(key, created, 'created');
    return reply.code(201).send(json(created, b.res, b.me, b.canEdit));
  });

  // 静态路径先注册：/views/order
  app.put('/api/v1/tables/:table_key/views/order', async (req, reply) => {
    const b = await begin(req, reply);
    if (!b) return;
    const ids = isObj(req.body) ? req.body.view_ids : undefined;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string')) {
      return invalid(reply, [{ field: 'view_ids', message: '必须是视图 ID 数组' }]);
    }
    if (!b.canEdit) return fail(reply, 403, '你没有这张表的编辑权限', { code: 'FORBIDDEN' });
    const key = b.res.schema.key;
    const list = await svc.withLock(key, async () => {
      const all = (await svc.views(key)).filter((v) => svc.viewVisible(v, b.me));
      const byId = new Map(all.map((v) => [v.view_id, v]));
      for (const id of ids as string[]) if (!byId.has(id)) throw new Error(`VIEW:${id}`);
      const seen = new Set(ids as string[]);
      const ordered = [...(ids as string[]).map((id) => byId.get(id)!), ...all.filter((v) => !seen.has(v.view_id))];
      await repo.setViewPositions(
        key,
        ordered.map((v, i) => ({ view_id: v.view_id, position: i + 1 })),
      );
      return (await repo.listViews(key)).filter((v) => svc.viewVisible(v, b.me));
    }).catch((err: Error) => {
      if (err.message.startsWith('VIEW:')) return err.message.slice(5);
      throw err;
    });
    if (typeof list === 'string') return invalid(reply, [{ field: 'view_ids', message: `视图不存在：${list}` }]);
    // 顺序变化：通知所有人刷新视图列表
    for (const v of list.filter((x) => !x.personal).slice(0, 1)) svc.emitViewChanged(key, v, 'updated');
    return { items: list.map((v) => json(v, b.res, b.me, b.canEdit)) };
  });

  app.patch('/api/v1/tables/:table_key/views/:view_id', async (req, reply) => {
    const b = await begin(req, reply);
    if (!b) return;
    const { view_id } = req.params as { view_id: string };
    const body = isObj(req.body) ? req.body : {};
    const errors: FieldError[] = [];
    if (!Number.isInteger(body.version)) errors.push({ field: 'version', message: '请带上视图当前的 version' });
    const name = body.name !== undefined ? parseName(body.name, errors) : undefined;
    const config = body.config !== undefined ? parseViewConfig(body.config, b.res.schema.fields, errors) : undefined;
    if (body.personal !== undefined && typeof body.personal !== 'boolean') errors.push({ field: 'personal', message: '必须是 true 或 false' });
    if (body.type !== undefined && (typeof body.type !== 'string' || !(VIEW_TYPES as readonly string[]).includes(body.type))) {
      errors.push({ field: 'type', message: `视图类型只能是 ${VIEW_TYPES.join('、')}` });
    }
    if (errors.length) return invalid(reply, errors);

    const key = b.res.schema.key;
    const out = await svc.withLock(key, async () => {
      const cur = await repo.getView(view_id);
      if (!cur || cur.table_key !== key || !svc.viewVisible(cur, b.me)) return { status: 404 as const };
      if (!canModify(cur, b.me, b.canEdit)) return { status: 403 as const };
      if (body.version !== cur.version) return { status: 409 as const, cur };
      const next: TableViewRecord = {
        ...cur,
        name: name ?? cur.name,
        type: (body.type as ViewType | undefined) ?? cur.type,
        config: config ?? cur.config,
        version: cur.version + 1,
        updated_at: nowIso(),
      };
      if (typeof body.personal === 'boolean' && body.personal !== cur.personal) {
        if (body.personal) {
          next.personal = true;
          next.owner_id = b.me.sub;
        } else {
          if (!b.canEdit) return { status: 403 as const };
          // 设为公共视图前确认不是最后一个……（个人 → 公共没有限制）
          next.personal = false;
          next.owner_id = null;
        }
      }
      // 公共视图改成个人视图后，表里至少还要有一个公共视图
      if (!cur.personal && next.personal) {
        const publicCount = (await repo.listViews(key)).filter((v) => !v.personal).length;
        if (publicCount <= 1) return { status: 422 as const };
      }
      if (!(await repo.updateView(next, cur.version))) return { status: 409 as const, cur: (await repo.getView(view_id)) ?? cur };
      return { status: 200 as const, view: next, prev: { personal: cur.personal, owner_id: cur.owner_id } };
    });
    if (out.status === 404) return fail(reply, 404, '视图不存在', { code: 'VIEW_NOT_FOUND' });
    if (out.status === 403) return fail(reply, 403, '你没有权限修改这个视图', { code: 'FORBIDDEN' });
    if (out.status === 422) return invalid(reply, [{ field: 'personal', message: '这是表里最后一个公共视图，不能设为个人视图' }]);
    if (out.status === 409) {
      return fail(reply, 409, '视图已被别人修改，请刷新后重试', { code: 'VERSION_CONFLICT', view: json(out.cur, b.res, b.me, b.canEdit) });
    }
    svc.emitViewChanged(key, out.view, 'updated', out.prev);
    return json(out.view, b.res, b.me, b.canEdit);
  });

  app.delete('/api/v1/tables/:table_key/views/:view_id', async (req, reply) => {
    const b = await begin(req, reply);
    if (!b) return;
    const { view_id } = req.params as { view_id: string };
    const v = await findView(b.res, view_id, b.me, reply);
    if (!v) return;
    if (!canModify(v, b.me, b.canEdit)) return fail(reply, 403, '你没有权限删除这个视图', { code: 'FORBIDDEN' });
    const key = b.res.schema.key;
    const ok = await svc.withLock(key, async () => {
      if (!v.personal) {
        const publicCount = (await repo.listViews(key)).filter((x) => !x.personal).length;
        if (publicCount <= 1) return false;
      }
      await repo.deleteView(view_id);
      return true;
    });
    if (!ok) return invalid(reply, [{ field: 'view_id', message: '至少要保留一个视图' }]);
    svc.emitViewChanged(key, v, 'deleted');
    return reply.code(204).send();
  });
}
