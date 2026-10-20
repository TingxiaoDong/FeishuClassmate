/**
 * 多维表格（《前端接口需求文档》第 8 节 +《多维表格新建数据表接口需求》+《二期功能需求文档》R-BT-01 ~ 06）。
 * 数据表 = 内置表（src/bitable/schema.ts，可叠加结构覆盖层）+ 自定义表（POST /tables）。
 *
 *   本文件：表列表 / 单表 / 新建表、记录 CRUD（含按视图计算、分组）、批量操作、实时事件
 *   routes-table-fields.ts：字段管理（R-BT-02）
 *   routes-table-views.ts：视图（R-BT-03）
 */

import type { FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { ALL_TABLES } from '../../src/bitable/schema.js';
import { fail, invalid, type AuthedUser, type Ctx, type FieldError } from './context.js';
import { parseCreateTable } from './custom-tables.js';
import { nowIso, type CustomTableRecord } from './repo.js';
import { canAccessRecord, filterAccessible, hasRowAccessRule } from './row-access.js';
import { registerTableFieldRoutes } from './routes-table-fields.js';
import { registerTableViewRoutes } from './routes-table-views.js';
import { registerTableManageRoutes } from './routes-table-manage.js';
import { tableAccessOf } from './table-access.js';
import type { NotificationService } from './notifications.js';
import type { StoredRecord } from './store.js';
import { recordJson, TableService, type ResolvedTable } from './table-service.js';
import { customSchema, describeSchema, schemaToDef, tablePermissions } from './table-schema.js';
import { describeTable } from './table-meta.js';
import { attachmentKeysOf, personIdsOf, validateRecordFields } from './validation.js';
import { applyView, groupCounts, groupPath, type Clock, type ViewConfig } from './view-engine.js';

const BATCH_MAX = 500;
const VIEW_DELETE_MAX = 10_000;

export function registerTableRoutes(ctx: Ctx, opts: { clock: Clock; notifications?: NotificationService }): TableService {
  const { app, store, repo } = ctx;
  const svc = new TableService(ctx, opts.clock);
  const access = tableAccessOf(ctx);
  // 表级权限：统一挡在 /tables/:table_key/** 前面（R-BT-09）
  access.install((key) => svc.load(key));

  // WS 订阅 table:<key>：表存在即可订阅（R-BT-09 表权限上线前，所有成员都能看所有表）
  ctx.topicAuthorizers.set('table', async (user, key) => {
    const res = await svc.load(key);
    if (!res) return 'NOT_FOUND';
    return (await access.canView(user, res.schema)) ? null : 'FORBIDDEN';
  });

  const resolve = async (key: string, reply: FastifyReply): Promise<ResolvedTable | undefined> => {
    const res = await svc.load(key);
    if (!res) {
      fail(reply, 404, `数据表不存在：${key}`, { code: 'TABLE_NOT_FOUND' });
      return undefined;
    }
    return res;
  };

  const requiredOf = (res: ResolvedTable) => res.schema.fields.filter((f) => f.required).map((f) => f.field_name);
  const titleOf = (res: ResolvedTable, name: string) => res.schema.fields.find((f) => f.field_name === name)?.title ?? name;

  /** 内置表的中文名 / 英文名，自定义表不能重名（大小写不敏感）。 */
  const builtinNames = new Set(
    ALL_TABLES.flatMap((t) => [t.name, describeTable(t).name]).map((n) => n.trim().toLowerCase()),
  );

  /** 建表串行化：避免同一 client_request_id 并发提交建出两张表。 */
  let createChain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = createChain.then(fn, fn);
    createChain = run.catch(() => undefined);
    return run;
  };

  /** 人员字段的 id 必须是存在的用户；附件字段的 file_key 必须存在、已上传、本人有权访问。 */
  const checkRefs = async (res: ResolvedTable, fields: Record<string, unknown>, me: AuthedUser): Promise<FieldError[]> => {
    const errors: FieldError[] = [];
    for (const f of res.def.fields) {
      const v = fields[f.field_name];
      if (v == null) continue;
      if (f.type === 11) {
        const missing = await ctx.missingUsers(personIdsOf(v));
        if (missing.length) errors.push({ field: f.field_name, message: `用户不存在：${missing.join('、')}` });
        if (Array.isArray(v) && v.some((p) => personIdsOf([p]).length === 0)) {
          errors.push({ field: f.field_name, message: '每个人员都必须带 id' });
        }
      } else if (f.type === 17) {
        if (Array.isArray(v) && v.some((a) => attachmentKeysOf([a]).length === 0)) {
          errors.push({ field: f.field_name, message: '每个附件都必须带 file_key' });
          continue;
        }
        for (const key of attachmentKeysOf(v)) {
          const file = await repo.getFile(key);
          if (!file || !file.uploaded_at || !(await ctx.canAccessFile(me, file))) {
            errors.push({ field: f.field_name, message: `文件不存在或还没有上传完成：${key}` });
          }
        }
      }
    }
    return errors;
  };

  /** 附件补全文件名 / 大小（前端兼容 name、file_name 两种写法）。 */
  const normalizeAttachments = async (res: ResolvedTable, fields: Record<string, unknown>) => {
    for (const f of res.def.fields) {
      if (f.type !== 17 || !Array.isArray(fields[f.field_name])) continue;
      fields[f.field_name] = await Promise.all(
        (fields[f.field_name] as Array<Record<string, unknown>>).map(async (a) => {
          const key = (a.file_key ?? a.file_token) as string;
          const file = await repo.getFile(key);
          if (!file) return a;
          const name = (typeof a.file_name === 'string' && a.file_name) || (typeof a.name === 'string' && a.name) || file.file_name;
          return { ...a, file_key: key, file_name: name, name, size: file.size, content_type: file.content_type };
        }),
      );
    }
  };

  const linkAttachments = async (res: ResolvedTable, rec: StoredRecord) => {
    const tableKey = res.schema.key;
    const seen = new Set<string>();
    for (const f of res.def.fields) {
      if (f.type !== 17) continue;
      for (const key of attachmentKeysOf(rec.fields[f.field_name])) {
        if (seen.has(key)) continue;
        seen.add(key);
        const links = await repo.listFileLinks(key);
        if (links.some((l) => l.source_type === 'table' && l.table_key === tableKey && l.record_id === rec.record_id)) continue;
        await repo.addFileLink({
          file_key: key,
          source_type: 'table',
          chat_id: null,
          message_id: null,
          table_key: tableKey,
          record_id: rec.record_id,
          created_at: nowIso(),
        });
      }
    }
  };

  /** 新建记录前的校验 + 规范化；返回错误或可写入的字段。 */
  const prepareCreate = async (res: ResolvedTable, raw: unknown, me: AuthedUser) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [{ field: 'fields', message: '缺少 fields 对象' }] };
    const body = { ...(raw as Record<string, unknown>) };
    const errors = validateRecordFields(res.def, body, { required: requiredOf(res) });
    if (errors.length === 0) errors.push(...(await checkRefs(res, body, me)));
    if (errors.length) return { errors };
    await normalizeAttachments(res, body);
    return { errors: [] as FieldError[], fields: body };
  };

  const prepareUpdate = async (res: ResolvedTable, raw: unknown, me: AuthedUser) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [{ field: 'fields', message: '缺少 fields 对象' }] };
    const body = { ...(raw as Record<string, unknown>) };
    const errors = validateRecordFields(res.def, body, { partial: true });
    for (const r of requiredOf(res)) {
      const v = body[r];
      if (r in body && (v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0))) {
        errors.push({ field: r, message: '必填，不能清空' });
      }
    }
    if (errors.length === 0) errors.push(...(await checkRefs(res, body, me)));
    if (errors.length) return { errors };
    await normalizeAttachments(res, body);
    return { errors: [] as FieldError[], fields: body };
  };

  /** 批量结果里的中文原因：「状态」：必须是以下之一…… */
  const explain = (res: ResolvedTable, errors: FieldError[]) =>
    errors.map((e) => `「${titleOf(res, e.field)}」${e.message}`).join('；');

  // ---------------- 表 ----------------

  // 内置表在前（固定顺序），自定义表按创建时间正序
  app.get('/api/v1/tables', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const items = [];
    for (const r of await svc.listAll()) {
      const flags = await access.flags(me, r.schema);
      if (flags.can_view) items.push(describeSchema(r.schema, me, flags));
    }
    return { items };
  });

  app.get('/api/v1/tables/:table_key', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const res = await resolve((req.params as { table_key: string }).table_key, reply);
    if (!res) return;
    return describeSchema(res.schema, me, await access.flags(me, res.schema));
  });

  // 新建数据表：所有已登录、未禁用的用户都可以
  app.post('/api/v1/tables', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    if (!(await ctx.roles.has(me.user, 'table.create'))) return fail(reply, 403, '没有新建数据表的权限', { code: 'FORBIDDEN' });
    const { value: input, errors } = parseCreateTable(req.body);
    if (!input) return invalid(reply, errors, '字段校验失败');

    return serialized(async () => {
      // 幂等：同一用户 24 小时内同一 client_request_id 返回第一次建的表
      if (input.client_request_id) {
        const since = new Date(Date.now() - 24 * 3600_000).toISOString();
        const hit = await repo.findCustomTableByRequest(me.sub, input.client_request_id, since);
        if (hit) {
          const res = await svc.load(hit.key, true);
          const sch = res?.schema ?? customSchema(hit);
          return reply.code(200).send(describeSchema(sch, me, await access.flags(me, sch)));
        }
      }

      const nameTaken = () =>
        fail(reply, 409, `已经有名为「${input.name}」的数据表了，请换一个名称`, { code: 'TABLE_NAME_EXISTS' });
      if (builtinNames.has(input.name.toLowerCase()) || (await repo.findCustomTableByName(input.name))) return nameTaken();
      // 改过名的表（PATCH /tables/:key）按当前名称查重
      if ((await svc.listAll()).some((r) => r.schema.name.trim().toLowerCase() === input.name.toLowerCase())) return nameTaken();

      let key = '';
      for (let i = 0; i < 10 && !key; i++) {
        const k = `tbl_${randomBytes(5).toString('hex')}`;
        if (!svc.isBuiltin(k) && !(await repo.getCustomTable(k))) key = k;
      }
      if (!key) throw new Error('无法生成数据表 key');

      const now = nowIso();
      const rec: CustomTableRecord = {
        key,
        name: input.name,
        description: input.description,
        icon: 'table',
        primary_field: input.primary_field,
        fields: input.fields.map((f) => ({ ...f, description: null })),
        created_by: me.sub,
        created_at: now,
        updated_at: now,
        client_request_id: input.client_request_id,
        version: 1,
      };
      // 先登记定义（占住名称，唯一索引兜底并发重名），再建物理表；建表失败回滚登记
      if ((await repo.insertCustomTable(rec)) === 'name_exists') return nameTaken();
      const schema = customSchema(rec);
      try {
        ctx.customTables.set(key, rec);
        await svc.apply({ schema, def: schemaToDef(schema), hasOverride: true });
      } catch (err) {
        svc.forget(key);
        ctx.tableDefs.delete(key);
        ctx.customTables.delete(key);
        await repo.deleteCustomTable(key).catch(() => undefined);
        await store.dropTable?.(key).catch(() => undefined);
        throw err;
      }
      ctx.publish('table.created', { table_key: key }, undefined, { all: true, user_only: true });
      return reply.code(201).send(describeSchema(schema, me, await access.flags(me, schema)));
    });
  });

  // ---------------- 记录 ----------------

  /** 记录列表：view_id 给出时由后端按视图筛选、排序、分组（R-BT-03 / 04）。 */
  app.get('/api/v1/tables/:table_key/records', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key } = req.params as { table_key: string };
    const res = await resolve(table_key, reply);
    if (!res) return;
    const def = res.def;
    const q = req.query as {
      filter?: string;
      sort?: string;
      page_size?: string;
      page_token?: string;
      keyword?: string;
      view_id?: string;
      group_path?: string;
    };
    const n = Number(q.page_size);
    const pageSize = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 100;
    if (q.sort && !/^[\p{L}\p{N}_]+(\s+(asc|desc))?$/iu.test(q.sort.trim())) {
      return invalid(reply, [{ field: 'sort', message: '格式应为「字段 asc」或「字段 desc」' }]);
    }
    if (q.filter?.trim()) {
      for (const clause of q.filter.split(/\s+AND\s+/i)) {
        const m = clause.trim().match(/^([\p{L}\p{N}_]+)\s*(!=|<=|>=|=|<|>)\s*(.+)$/u);
        if (!m) {
          return invalid(reply, [{ field: 'filter', message: `无法识别的条件「${clause.trim()}」，示例：status="进行中" AND budget>=1000` }]);
        }
        if (!def.fields.some((f) => f.field_name === m[1])) {
          return invalid(reply, [{ field: 'filter', message: `数据表里没有这个字段：${m[1]}` }]);
        }
      }
    }
    const sortField = q.sort?.trim().split(/\s+/)[0];
    if (sortField && !def.fields.some((f) => f.field_name === sortField)) {
      return invalid(reply, [{ field: 'sort', message: `数据表里没有这个字段：${sortField}` }]);
    }
    // 保密记录在存储层过滤，保证分页和 total 正确
    const confidentialFor = hasRowAccessRule(def) && me.role !== 'admin' ? me.sub : undefined;

    try {
      if (q.view_id) {
        const view = await repo.getView(q.view_id);
        if (!view || view.table_key !== table_key || !svc.viewVisible(view, me)) {
          return fail(reply, 404, '视图不存在', { code: 'VIEW_NOT_FOUND' });
        }
        let groupFilter: string[] | undefined;
        if (q.group_path) {
          try {
            const p = JSON.parse(q.group_path) as unknown;
            if (!Array.isArray(p) || p.some((x) => typeof x !== 'string')) throw new Error('bad');
            groupFilter = p as string[];
          } catch {
            return invalid(reply, [{ field: 'group_path', message: '必须是 JSON 字符串数组，如 ["进行中"]' }]);
          }
        }
        const cfg = view.config as ViewConfig;
        const all = await svc.scanAll(table_key, { filter: q.filter, keyword: q.keyword, confidentialFor });
        let sorted = applyView(cfg, filterAccessible(me, def, all), svc.clock, res.schema.fields);
        const groups = cfg.group?.length ? groupCounts(cfg, sorted, res.schema.fields) : undefined;
        if (groupFilter) {
          const gf = groupFilter;
          sorted = sorted.filter((r) => {
            const p = groupPath(cfg, r, res.schema.fields);
            return gf.every((v, i) => p[i] === v);
          });
        }
        const offset = q.page_token ? Math.max(0, Number(q.page_token) || 0) : 0;
        const items = sorted.slice(offset, offset + pageSize).map(recordJson);
        const next = offset + pageSize;
        return {
          items,
          has_more: next < sorted.length,
          page_token: next < sorted.length ? String(next) : null,
          total: sorted.length,
          view_id: view.view_id,
          view_version: view.version,
          ...(groups && !groupFilter ? { groups } : {}),
        };
      }

      const page = await store.list(table_key, {
        filter: q.filter,
        sort: q.sort?.trim(),
        pageSize,
        pageToken: q.page_token,
        keyword: q.keyword,
        confidentialFor,
      });
      const items = filterAccessible(me, def, page.items).map(recordJson);
      return {
        items,
        has_more: page.has_more,
        page_token: page.page_token ?? null,
        total: page.total ?? items.length,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/filter|unparseable|unknown field|sort/i.test(msg)) {
        return invalid(reply, [{ field: 'filter', message: '筛选条件格式不正确，示例：status="进行中" AND budget>=1000' }]);
      }
      throw err;
    }
  });

  app.post('/api/v1/tables/:table_key/records', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key } = req.params as { table_key: string };
    const res = await resolve(table_key, reply);
    if (!res) return;
    const { fields } = (req.body ?? {}) as { fields?: unknown };
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fail(reply, 400, '缺少 fields 对象');
    const p = await prepareCreate(res, fields, me);
    if (!p.fields) return invalid(reply, p.errors, '字段校验失败');
    const rec = await store.create(table_key, p.fields, me.sub);
    await linkAttachments(res, rec);
    await svc.emitRecord(res.def, 'created', rec.record_id, me.sub, { record: rec });
    return reply.code(201).send(recordJson(rec));
  });

  // 批量（R-BT-06）。静态路径优先于 /records/:record_id。
  app.post('/api/v1/tables/:table_key/records/batch_create', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key } = req.params as { table_key: string };
    const res = await resolve(table_key, reply);
    if (!res) return;
    const { records } = (req.body ?? {}) as { records?: unknown };
    if (!Array.isArray(records) || records.length === 0) return invalid(reply, [{ field: 'records', message: '至少需要一条记录' }]);
    if (records.length > BATCH_MAX) return invalid(reply, [{ field: 'records', message: `一次最多 ${BATCH_MAX} 条` }]);
    const succeeded: unknown[] = [];
    const failed: Array<{ index: number; record_id: null; message: string }> = [];
    for (const [i, item] of records.entries()) {
      const raw = item && typeof item === 'object' ? (item as { fields?: unknown }).fields : undefined;
      const p = await prepareCreate(res, raw, me);
      if (!p.fields) {
        failed.push({ index: i, record_id: null, message: explain(res, p.errors) });
        continue;
      }
      try {
        const rec = await store.create(table_key, p.fields, me.sub);
        await linkAttachments(res, rec);
        await svc.emitRecord(res.def, 'created', rec.record_id, me.sub, { record: rec });
        succeeded.push(recordJson(rec));
      } catch (err) {
        req.log.error(err);
        failed.push({ index: i, record_id: null, message: '保存失败，请稍后再试' });
      }
    }
    return { succeeded, failed };
  });

  app.post('/api/v1/tables/:table_key/records/batch_update', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key } = req.params as { table_key: string };
    const res = await resolve(table_key, reply);
    if (!res) return;
    const body = (req.body ?? {}) as { records?: unknown; record_ids?: unknown; fields?: unknown };
    let items: Array<{ record_id: string; fields: unknown }>;
    if (body.records !== undefined) {
      if (!Array.isArray(body.records) || body.records.length === 0) {
        return invalid(reply, [{ field: 'records', message: '至少需要一条记录' }]);
      }
      if (body.records.some((r) => !r || typeof r !== 'object' || typeof (r as { record_id?: unknown }).record_id !== 'string')) {
        return invalid(reply, [{ field: 'records', message: '每一项都要有 record_id 和 fields' }]);
      }
      items = body.records as Array<{ record_id: string; fields: unknown }>;
    } else if (body.record_ids !== undefined) {
      if (!Array.isArray(body.record_ids) || body.record_ids.length === 0 || body.record_ids.some((x) => typeof x !== 'string')) {
        return invalid(reply, [{ field: 'record_ids', message: '必须是非空的记录 ID 数组' }]);
      }
      if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) {
        return invalid(reply, [{ field: 'fields', message: '缺少要统一修改的 fields' }]);
      }
      items = [...new Set(body.record_ids as string[])].map((id) => ({ record_id: id, fields: body.fields }));
    } else {
      return invalid(reply, [{ field: 'records', message: '需要 records，或 record_ids + fields' }]);
    }
    if (items.length > BATCH_MAX) return invalid(reply, [{ field: 'records', message: `一次最多 ${BATCH_MAX} 条` }]);

    const succeeded: unknown[] = [];
    const failed: Array<{ record_id: string; message: string }> = [];
    for (const item of items) {
      const existing = await store.get(table_key, item.record_id);
      if (!existing || !canAccessRecord(me, res.def, existing)) {
        failed.push({ record_id: item.record_id, message: '记录不存在或已被删除' });
        continue;
      }
      const p = await prepareUpdate(res, item.fields, me);
      if (!p.fields) {
        failed.push({ record_id: item.record_id, message: explain(res, p.errors) });
        continue;
      }
      const rec = await store.update(table_key, item.record_id, p.fields, me.sub);
      if (!rec) {
        failed.push({ record_id: item.record_id, message: '记录不存在或已被删除' });
        continue;
      }
      await linkAttachments(res, rec);
      await svc.emitRecord(res.def, 'updated', rec.record_id, me.sub, { record: rec, before: existing, changed: Object.keys(p.fields) });
      succeeded.push(recordJson(rec));
    }
    return { succeeded, failed };
  });

  app.post('/api/v1/tables/:table_key/records/batch_delete', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key } = req.params as { table_key: string };
    const res = await resolve(table_key, reply);
    if (!res) return;
    const body = (req.body ?? {}) as { record_ids?: unknown; view_id?: unknown; all?: unknown };
    let ids: string[];
    if (body.record_ids !== undefined) {
      if (!Array.isArray(body.record_ids) || body.record_ids.length === 0 || body.record_ids.some((x) => typeof x !== 'string')) {
        return invalid(reply, [{ field: 'record_ids', message: '必须是非空的记录 ID 数组' }]);
      }
      ids = [...new Set(body.record_ids as string[])];
      if (ids.length > BATCH_MAX) return invalid(reply, [{ field: 'record_ids', message: `一次最多 ${BATCH_MAX} 条` }]);
    } else if (typeof body.view_id === 'string' && body.all === true) {
      const view = await repo.getView(body.view_id);
      if (!view || view.table_key !== table_key || !svc.viewVisible(view, me)) {
        return fail(reply, 404, '视图不存在', { code: 'VIEW_NOT_FOUND' });
      }
      const confidentialFor = hasRowAccessRule(res.def) && me.role !== 'admin' ? me.sub : undefined;
      const all = await svc.scanAll(table_key, { confidentialFor });
      ids = applyView(view.config as ViewConfig, filterAccessible(me, res.def, all), svc.clock, res.schema.fields).map((r) => r.record_id);
      if (ids.length > VIEW_DELETE_MAX) {
        return invalid(reply, [{ field: 'view_id', message: `视图里有 ${ids.length} 条记录，一次最多删除 ${VIEW_DELETE_MAX} 条` }]);
      }
    } else {
      return invalid(reply, [{ field: 'record_ids', message: '需要 record_ids，或 view_id + all: true' }]);
    }
    const succeeded: string[] = [];
    const failed: Array<{ record_id: string; message: string }> = [];
    for (const id of ids) {
      const existing = await store.get(table_key, id);
      if (!existing || !canAccessRecord(me, res.def, existing) || !(await store.delete(table_key, id))) {
        failed.push({ record_id: id, message: '记录不存在或已被删除' });
        continue;
      }
      await svc.emitRecord(res.def, 'deleted', id, me.sub, { before: existing });
      succeeded.push(id);
    }
    return { succeeded, failed };
  });

  app.get('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const res = await resolve(table_key, reply);
    if (!res) return;
    const rec = await store.get(table_key, record_id);
    if (!rec || !canAccessRecord(me, res.def, rec)) return fail(reply, 404, '记录不存在');
    return recordJson(rec);
  });

  /** 记录修改记录：谁、什么时候、改了哪些字段；机器人代办的带 via_bot。 */
  app.get('/api/v1/tables/:table_key/records/:record_id/history', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const res = await resolve(table_key, reply);
    if (!res) return;
    const rec = await store.get(table_key, record_id);
    if (!rec || !canAccessRecord(me, res.def, rec)) return fail(reply, 404, '记录不存在');
    const items = (await ctx.repo.listEntities('record_history', `${table_key}|${record_id}`))
      .sort((a, b) => String(b.data.at ?? b.created_at).localeCompare(String(a.data.at ?? a.created_at)))
      .map((e) => ({ history_id: e.id, ...e.data }));
    return { items, has_more: false };
  });

  app.patch('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const res = await resolve(table_key, reply);
    if (!res) return;
    const existing = await store.get(table_key, record_id);
    if (!existing || !canAccessRecord(me, res.def, existing)) return fail(reply, 404, '记录不存在');
    const { fields } = (req.body ?? {}) as { fields?: unknown };
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fail(reply, 400, '缺少 fields 对象');
    const p = await prepareUpdate(res, fields, me);
    if (!p.fields) return invalid(reply, p.errors, '字段校验失败');
    const rec = await store.update(table_key, record_id, p.fields, me.sub);
    if (!rec) return fail(reply, 404, '记录不存在');
    await linkAttachments(res, rec);
    await svc.emitRecord(res.def, 'updated', rec.record_id, me.sub, { record: rec, before: existing, changed: Object.keys(p.fields) });
    return recordJson(rec);
  });

  app.delete('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const res = await resolve(table_key, reply);
    if (!res) return;
    const existing = await store.get(table_key, record_id);
    if (!existing || !canAccessRecord(me, res.def, existing)) return fail(reply, 404, '记录不存在');
    if (!(await store.delete(table_key, record_id))) return fail(reply, 404, '记录不存在');
    await svc.emitRecord(res.def, 'deleted', record_id, me.sub, { before: existing });
    return reply.code(204).send();
  });

  registerTableFieldRoutes(ctx, svc);
  registerTableViewRoutes(ctx, svc);
  registerTableManageRoutes(ctx, svc, { reservedNames: builtinNames, notifications: opts.notifications });
  void tablePermissions;
  return svc;
}
