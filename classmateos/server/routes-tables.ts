/**
 * 多维表格（《前端接口需求文档》第 8 节）。
 */

import type { FastifyReply } from 'fastify';
import { ALL_TABLES, type TableDef } from '../../src/bitable/schema.js';
import { fail, invalid, type AuthedUser, type Ctx, type FieldError } from './context.js';
import { nowIso } from './repo.js';
import { canAccessRecord, filterAccessible, hasRowAccessRule } from './row-access.js';
import type { StoredRecord } from './store.js';
import { describeTable, requiredFieldsOf } from './table-meta.js';
import { attachmentKeysOf, personIdsOf, validateRecordFields } from './validation.js';

function recordJson(r: StoredRecord) {
  return {
    record_id: r.record_id,
    fields: r.fields,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by ?? null,
    updated_by: r.updated_by ?? null,
  };
}

export function registerTableRoutes(ctx: Ctx): void {
  const { app, store, repo, tableDefs } = ctx;

  const resolveTable = (key: string, reply: FastifyReply): TableDef | undefined => {
    const def = tableDefs.get(key);
    if (!def) {
      fail(reply, 404, `数据表不存在：${key}`, { code: 'TABLE_NOT_FOUND' });
      return undefined;
    }
    return def;
  };

  /** 人员字段的 id 必须是存在的用户；附件字段的 file_key 必须存在、已上传、本人有权访问。 */
  const checkRefs = async (def: TableDef, fields: Record<string, unknown>, me: AuthedUser): Promise<FieldError[]> => {
    const errors: FieldError[] = [];
    for (const f of def.fields) {
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
  const normalizeAttachments = async (def: TableDef, fields: Record<string, unknown>) => {
    for (const f of def.fields) {
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

  const linkAttachments = async (def: TableDef, tableKey: string, rec: StoredRecord) => {
    const existing = new Set<string>();
    for (const f of def.fields) {
      if (f.type !== 17) continue;
      for (const key of attachmentKeysOf(rec.fields[f.field_name])) {
        if (existing.has(key)) continue;
        existing.add(key);
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

  app.get('/api/v1/tables', async (req, reply) => {
    if (!(await ctx.requireUser(req, reply))) return;
    return { items: ALL_TABLES.filter((t) => tableDefs.has(t.key)).map(describeTable) };
  });

  app.get('/api/v1/tables/:table_key/records', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key } = req.params as { table_key: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const q = req.query as { filter?: string; sort?: string; page_size?: string; page_token?: string; keyword?: string };
    const n = Number(q.page_size);
    const pageSize = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 100;
    if (q.sort && !/^[\p{L}\p{N}_]+(\s+(asc|desc))?$/iu.test(q.sort.trim())) {
      return invalid(reply, [{ field: 'sort', message: '格式应为「字段 asc」或「字段 desc」' }]);
    }
    if (q.filter?.trim()) {
      for (const clause of q.filter.split(/\s+AND\s+/i)) {
        const m = clause.trim().match(/^([\p{L}\p{N}_]+)\s*(=|!=|<|<=|>|>=)\s*(.+)$/u);
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
    try {
      const page = await store.list(table_key, {
        filter: q.filter,
        sort: q.sort?.trim(),
        pageSize,
        pageToken: q.page_token,
        keyword: q.keyword,
        // 保密记录在存储层过滤，保证分页和 total 正确
        confidentialFor: hasRowAccessRule(def) && me.role !== 'admin' ? me.sub : undefined,
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
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const { fields } = (req.body ?? {}) as { fields?: unknown };
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fail(reply, 400, '缺少 fields 对象');
    const body = { ...(fields as Record<string, unknown>) };
    const errors = validateRecordFields(def, body, { required: requiredFieldsOf(def) });
    if (errors.length === 0) errors.push(...(await checkRefs(def, body, me)));
    if (errors.length > 0) return invalid(reply, errors, '字段校验失败');
    await normalizeAttachments(def, body);
    const rec = await store.create(table_key, body, me.sub);
    await linkAttachments(def, table_key, rec);
    return reply.code(201).send(recordJson(rec));
  });

  app.get('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const rec = await store.get(table_key, record_id);
    if (!rec || !canAccessRecord(me, def, rec)) return fail(reply, 404, '记录不存在');
    return recordJson(rec);
  });

  app.patch('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const existing = await store.get(table_key, record_id);
    if (!existing || !canAccessRecord(me, def, existing)) return fail(reply, 404, '记录不存在');
    const { fields } = (req.body ?? {}) as { fields?: unknown };
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fail(reply, 400, '缺少 fields 对象');
    const body = { ...(fields as Record<string, unknown>) };
    const errors = validateRecordFields(def, body, { partial: true });
    // 必填字段不能被清空
    for (const r of requiredFieldsOf(def)) {
      if (r in body && (body[r] == null || (typeof body[r] === 'string' && !(body[r] as string).trim()))) {
        errors.push({ field: r, message: '必填，不能清空' });
      }
    }
    if (errors.length === 0) errors.push(...(await checkRefs(def, body, me)));
    if (errors.length > 0) return invalid(reply, errors, '字段校验失败');
    await normalizeAttachments(def, body);
    const rec = await store.update(table_key, record_id, body, me.sub);
    if (!rec) return fail(reply, 404, '记录不存在');
    await linkAttachments(def, table_key, rec);
    return recordJson(rec);
  });

  app.delete('/api/v1/tables/:table_key/records/:record_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key, record_id } = req.params as { table_key: string; record_id: string };
    const def = resolveTable(table_key, reply);
    if (!def) return;
    const existing = await store.get(table_key, record_id);
    if (!existing || !canAccessRecord(me, def, existing)) return fail(reply, 404, '记录不存在');
    if (!(await store.delete(table_key, record_id))) return fail(reply, 404, '记录不存在');
    return reply.code(204).send();
  });
}
