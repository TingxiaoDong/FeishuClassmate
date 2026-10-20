/**
 * 导入导出（迭代 5：R-BT-07 表格导入导出、R-DC-06 文档导出、R-AD-01 成员批量导入），进度走 GET /jobs/:job_id + WS job.updated。
 *
 *   POST /tables/imports/preview        {file_key} → {headers, rows(前 20 行), total_rows, suggested_types}
 *   POST /tables/:key/imports           {file_key, mode: append | upsert, mapping: {列名: 字段名}} → 202 {job_id}
 *   POST /tables/:key/exports           {format: xlsx | csv, view_id?, record_ids?} → 202 {job_id}
 *   POST /docs/:doc_id/exports          {format: pdf | docx} → 202 {job_id}
 *   GET  /users/import/template         → {file_key}（xlsx 模板）
 *   POST /users/import/preview          {file_key} → {headers, rows, total_rows, errors: [{row, message}]}
 *   POST /users/import                  {file_key} → 202 {job_id}
 *
 * 写数据都通过「以发起人身份在进程内调用已有接口」完成（app.inject，转发原请求的鉴权头），
 * 所以字段校验、权限、修改历史、实时事件、操作日志与手工操作完全一致。
 * 导入完成：result {succeeded, failed, error_file_key?}；导出完成：result {file_key, file_name}。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fail, invalid, type AuthedUser, type Ctx } from './context.js';
import { docAccess } from './doc-access.js';
import { parseMarkdown, toDocx, toPdf } from './doc-export.js';
import { JobFailure, jobsOf } from './jobs.js';
import { OfficeError, readSheetFile, writeCsv, writeXlsx, type Sheet } from './office.js';
import type { TableService } from './table-service.js';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_ROWS = 50_000;
const BATCH = 200;
const PREVIEW_ROWS = 20;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const TRUE_RE = /^(true|1|yes|y|是|对|✓|√|☑|已完成|勾选)$/i;
const FALSE_RE = /^(false|0|no|n|否|不|✗|×|☐|未完成|)$/i;
const DATE_RE = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** 本地日期（北京时间）→ 毫秒时间戳。 */
export function parseDateCell(v: string, tzOffsetMinutes = 480): number | undefined {
  const m = v.trim().match(DATE_RE);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - tzOffsetMinutes * 60_000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (/^\d{12,13}$/.test(v.trim())) return Number(v.trim());
  return undefined;
}
const parseNum = (v: string) => {
  const s = v.trim().replace(/[,，\s]/g, '').replace(/^[¥$￥]/, '');
  const pct = s.endsWith('%');
  const n = Number(pct ? s.slice(0, -1) : s);
  return s && Number.isFinite(n) ? (pct ? n / 100 : n) : undefined;
};

/** 根据一列的样本推荐字段类型（一期类型编号）。 */
export function suggestType(values: string[]): number {
  const vs = values.map((v) => v.trim()).filter(Boolean);
  if (!vs.length) return 1;
  if (vs.every((v) => /^https?:\/\/\S+$/i.test(v))) return 15;
  if (vs.every((v) => TRUE_RE.test(v) || (FALSE_RE.test(v) && v !== ''))) return 7;
  if (vs.every((v) => DATE_RE.test(v))) return 5;
  if (vs.every((v) => parseNum(v) !== undefined)) return 2;
  const distinct = new Set(vs);
  if (vs.length >= 4 && distinct.size <= Math.min(10, Math.ceil(vs.length / 2)) && [...distinct].every((v) => v.length <= 20)) return 3;
  return 1;
}

export function registerImportExportRoutes(ctx: Ctx, svc: TableService, tzOffsetMinutes = 480): void {
  const { app, repo } = ctx;
  const jobs = jobsOf(ctx);

  /** 以发起人身份调用已有接口。 */
  const authHeaders = (req: FastifyRequest) => {
    const h: Record<string, string> = {};
    for (const k of ['authorization', 'x-bot-token', 'x-on-behalf-of', 'x-agent-confirm']) {
      const v = req.headers[k];
      if (typeof v === 'string') h[k] = v;
    }
    return h;
  };
  const call = async (headers: Record<string, string>, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Record<string, unknown> = {};
    try { body = r.json(); } catch { /* 204 等 */ }
    return { status: r.statusCode, body };
  };

  /** 读上传的表格文件（必须是自己能访问的文件）。 */
  async function readUpload(me: AuthedUser, fileKey: unknown, reply: FastifyReply): Promise<{ sheet: Sheet; name: string } | undefined> {
    if (typeof fileKey !== 'string' || !fileKey) { invalid(reply, [{ field: 'file_key', message: '请先上传文件' }]); return undefined; }
    const file = await repo.getFile(fileKey);
    if (!file || !file.uploaded_at || !(await ctx.canAccessFile(me, file))) { fail(reply, 404, '文件不存在或还没有上传完成', { code: 'FILE_NOT_FOUND' }); return undefined; }
    if (file.size > MAX_FILE) { fail(reply, 413, '文件不能超过 20 MB', { code: 'FILE_TOO_LARGE' }); return undefined; }
    const buf = await ctx.fileStore.read(fileKey);
    if (!buf) { fail(reply, 404, '文件内容不存在', { code: 'FILE_NOT_FOUND' }); return undefined; }
    try {
      const sheet = readSheetFile(buf, file.file_name);
      if (!sheet.length || !sheet[0].some((h) => h.trim())) { fail(reply, 422, '文件是空的，或第一行没有表头', { code: 'EMPTY_FILE' }); return undefined; }
      if (sheet.length - 1 > MAX_ROWS) { fail(reply, 422, `一次最多导入 ${MAX_ROWS} 行`, { code: 'TOO_MANY_ROWS' }); return undefined; }
      return { sheet, name: file.file_name };
    } catch (e) {
      fail(reply, 422, e instanceof OfficeError ? e.message : '无法读取这个文件，请确认是 xlsx 或 csv', { code: 'BAD_FILE' });
      return undefined;
    }
  }

  const headersOf = (sheet: Sheet) => sheet[0].map((h, i) => h.trim() || `列${i + 1}`);
  const stamp = () => new Date(Date.now() + tzOffsetMinutes * 60_000).toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1_');
  const safeName = (s: string) => s.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60) || '导出';

  // ================================================================ 表格导入

  app.post('/api/v1/tables/imports/preview', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const up = await readUpload(me, (req.body as { file_key?: unknown } | null)?.file_key, reply);
    if (!up) return;
    const headers = headersOf(up.sheet);
    const data = up.sheet.slice(1);
    const sample = data.slice(0, 200);
    const suggested_types: Record<string, number> = {};
    headers.forEach((h, i) => { suggested_types[h] = suggestType(sample.map((r) => r[i] ?? '')); });
    return { headers, rows: data.slice(0, PREVIEW_ROWS).map((r) => headers.map((_, i) => r[i] ?? '')), total_rows: data.length, suggested_types };
  });

  app.post('/api/v1/tables/:table_key/imports', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key } = req.params as { table_key: string };
    const res = await svc.load(table_key);
    if (!res) return fail(reply, 404, `数据表不存在：${table_key}`, { code: 'TABLE_NOT_FOUND' });
    const body = (req.body ?? {}) as { file_key?: unknown; mode?: unknown; mapping?: unknown };
    const mode = body.mode ?? 'append';
    if (mode !== 'append' && mode !== 'upsert') return invalid(reply, [{ field: 'mode', message: '只能是 append 或 upsert' }]);
    if (!body.mapping || typeof body.mapping !== 'object' || Array.isArray(body.mapping)) return invalid(reply, [{ field: 'mapping', message: '必须是 {列名: 字段名}' }]);
    const fields = new Map(res.schema.fields.map((f) => [f.field_name, f]));
    const mapping = Object.entries(body.mapping as Record<string, unknown>).filter(([, f]) => f !== null && f !== '');
    const bad = mapping.filter(([, f]) => typeof f !== 'string' || !fields.has(f));
    if (bad.length) return invalid(reply, [{ field: 'mapping', message: `字段不存在：${bad.map(([, f]) => String(f)).join('、')}` }]);
    if (!mapping.length) return invalid(reply, [{ field: 'mapping', message: '至少选择一列导入' }]);
    const unsupported = mapping.filter(([, f]) => fields.get(f as string)!.type === 17);
    if (unsupported.length) return invalid(reply, [{ field: 'mapping', message: '附件字段不能从文件导入' }]);
    const up = await readUpload(me, body.file_key, reply);
    if (!up) return;
    const headers = headersOf(up.sheet);
    const missing = mapping.filter(([col]) => !headers.includes(col));
    if (missing.length) return invalid(reply, [{ field: 'mapping', message: `文件里没有这些列：${missing.map(([c]) => c).join('、')}` }]);
    const primary = res.schema.primary_field;
    if (mode === 'upsert' && !mapping.some(([, f]) => f === primary)) return invalid(reply, [{ field: 'mapping', message: '按主字段更新时，必须导入主字段这一列' }]);

    const headersFwd = authHeaders(req);
    const job = await jobs.create(me.sub, 'table_import', `导入到「${res.schema.name}」`);
    void jobs.run(job, async (update) => {
      const users = (await repo.listUsers({ limit: 1_000_000, offset: 0 })).items.filter((u) => u.role !== 'bot');
      const userBy = new Map<string, string>();
      for (const u of users) { userBy.set(u.user_id.toLowerCase(), u.user_id); userBy.set(u.name.toLowerCase(), u.user_id); if (u.email) userBy.set(u.email.toLowerCase(), u.user_id); }
      const cols = mapping.map(([col, f]) => ({ idx: headers.indexOf(col), col, field: fields.get(f as string)! }));
      const rows = up.sheet.slice(1);
      const errors: Array<{ row: number; message: string }> = [];
      /** 单元格 → 接口值；返回 undefined 表示留空，抛字符串表示格式错误。 */
      const convert = (raw: string, f: (typeof cols)[number]['field']): unknown => {
        const v = raw.trim();
        if (!v) return undefined;
        switch (f.type) {
          case 2: { const n = parseNum(v); if (n === undefined) throw `「${f.title}」必须是数字`; return n; }
          case 5: { const t = parseDateCell(v, tzOffsetMinutes); if (t === undefined) throw `「${f.title}」日期格式不对（如 2026-10-20）`; return t; }
          case 7: if (TRUE_RE.test(v)) return true; if (FALSE_RE.test(v)) return false; throw `「${f.title}」只能填 是 / 否`;
          case 4: return v.split(/[,，、;；\n]/).map((x) => x.trim()).filter(Boolean);
          case 11: {
            const ids = v.split(/[,，、;；\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
              const id = userBy.get(x.toLowerCase());
              if (!id) throw `「${f.title}」找不到成员：${x}`;
              return { id };
            });
            return ids;
          }
          default: return v;
        }
      };
      // upsert：主字段 → record_id
      const existing = new Map<string, string>();
      if (mode === 'upsert') {
        for (const r of await svc.scanAll(table_key, { confidentialFor: me.user.role === 'admin' ? undefined : me.sub })) {
          const k = String(r.fields[primary] ?? '').trim();
          if (k && !existing.has(k)) existing.set(k, r.record_id);
        }
      }
      let succeeded = 0;
      for (let start = 0; start < rows.length; start += BATCH) {
        const creates: Array<{ row: number; fields: Record<string, unknown> }> = [];
        const updates: Array<{ row: number; record_id: string; fields: Record<string, unknown> }> = [];
        for (let i = start; i < Math.min(rows.length, start + BATCH); i++) {
          const r = rows[i];
          if (!r.some((v) => v.trim())) continue; // 空行跳过，不计数
          const data: Record<string, unknown> = {};
          try {
            for (const c of cols) {
              const v = convert(r[c.idx] ?? '', c.field);
              if (v !== undefined) data[c.field.field_name] = v;
            }
          } catch (msg) {
            errors.push({ row: i, message: String(msg) });
            continue;
          }
          const key = String(data[primary] ?? '').trim();
          const hit = mode === 'upsert' && key ? existing.get(key) : undefined;
          if (hit) updates.push({ row: i, record_id: hit, fields: data });
          else creates.push({ row: i, fields: data });
        }
        if (creates.length) {
          const r = await call(headersFwd, 'POST', `/tables/${encodeURIComponent(table_key)}/records/batch_create`, { records: creates.map((c) => ({ fields: c.fields })) });
          if (r.status !== 200) throw new JobFailure(String(r.body.message ?? '导入失败：没有权限或数据表已被删除'));
          const failed = (r.body.failed ?? []) as Array<{ index: number; message: string }>;
          for (const f of failed) errors.push({ row: creates[f.index].row, message: f.message });
          succeeded += creates.length - failed.length;
          if (mode === 'upsert') for (const [i, rec] of ((r.body.succeeded ?? []) as Array<{ record_id: string; fields: Record<string, unknown> }>).entries()) {
            const k = String(rec.fields?.[primary] ?? creates[i]?.fields[primary] ?? '').trim();
            if (k && !existing.has(k)) existing.set(k, rec.record_id);
          }
        }
        if (updates.length) {
          const r = await call(headersFwd, 'POST', `/tables/${encodeURIComponent(table_key)}/records/batch_update`, { records: updates.map((u) => ({ record_id: u.record_id, fields: u.fields })) });
          if (r.status !== 200) throw new JobFailure(String(r.body.message ?? '导入失败：没有权限或数据表已被删除'));
          const failed = new Map(((r.body.failed ?? []) as Array<{ record_id: string; message: string }>).map((f) => [f.record_id, f.message]));
          for (const u of updates) if (failed.has(u.record_id)) errors.push({ row: u.row, message: failed.get(u.record_id)! });
          succeeded += updates.length - failed.size;
        }
        const done = Math.min(rows.length, start + BATCH);
        await update({ progress: 0.1 + 0.85 * (done / Math.max(1, rows.length)), message: `已处理 ${done} / ${rows.length} 行` });
      }
      errors.sort((a, b) => a.row - b.row);
      const result: Record<string, unknown> = { succeeded, failed: errors.length };
      if (errors.length) {
        const sheet: Sheet = [['行号', '失败原因', ...headers], ...errors.map((e) => [String(e.row + 2), e.message, ...headers.map((_, i) => rows[e.row]?.[i] ?? '')])];
        result.error_file_key = await jobs.saveFile(me.sub, `导入失败明细_${stamp()}.xlsx`, writeXlsx(sheet, '失败明细'), XLSX_TYPE);
      }
      return result;
    });
    return reply.code(202).send({ job_id: job.job_id });
  });

  // ================================================================ 表格导出

  /** 单元格显示值。 */
  const display = (v: unknown, type: number, names: Map<string, string>): string => {
    if (v === null || v === undefined) return '';
    if (type === 5 && typeof v === 'number') {
      const iso = new Date(v + tzOffsetMinutes * 60_000).toISOString();
      return iso.slice(11, 16) === '00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
    }
    if (type === 7) return v === true ? '是' : '否';
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? String((x as Record<string, unknown>).name ?? (x as Record<string, unknown>).file_name ?? names.get(String((x as Record<string, unknown>).id)) ?? (x as Record<string, unknown>).id ?? '') : String(x))).join('、');
    if (typeof v === 'object') return String((v as Record<string, unknown>).text ?? (v as Record<string, unknown>).link ?? JSON.stringify(v));
    return String(v);
  };

  app.post('/api/v1/tables/:table_key/exports', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key } = req.params as { table_key: string };
    const res = await svc.load(table_key);
    if (!res) return fail(reply, 404, `数据表不存在：${table_key}`, { code: 'TABLE_NOT_FOUND' });
    const body = (req.body ?? {}) as { format?: unknown; view_id?: unknown; record_ids?: unknown };
    const format = body.format ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'csv') return invalid(reply, [{ field: 'format', message: '只能是 xlsx 或 csv' }]);
    if (body.view_id !== undefined && body.view_id !== null && typeof body.view_id !== 'string') return invalid(reply, [{ field: 'view_id', message: '必须是视图 ID' }]);
    if (body.record_ids !== undefined && body.record_ids !== null && (!Array.isArray(body.record_ids) || body.record_ids.some((x) => typeof x !== 'string') || body.record_ids.length > MAX_ROWS)) {
      return invalid(reply, [{ field: 'record_ids', message: '必须是记录 ID 数组' }]);
    }
    const headersFwd = authHeaders(req);
    const viewId = (body.view_id as string | undefined) ?? undefined;
    let view: { name: string; config: { hidden_fields?: string[]; field_order?: string[] } } | undefined;
    if (viewId) {
      const r = await call(headersFwd, 'GET', `/tables/${encodeURIComponent(table_key)}/views`);
      view = ((r.body.items ?? []) as Array<{ view_id: string; name: string; config: { hidden_fields?: string[]; field_order?: string[] } }>).find((v) => v.view_id === viewId);
      if (!view) return fail(reply, 404, '视图不存在', { code: 'VIEW_NOT_FOUND' });
    }
    const ids = body.record_ids ? new Set(body.record_ids as string[]) : undefined;
    const job = await jobs.create(me.sub, 'table_export', `导出「${res.schema.name}」`);
    void jobs.run(job, async (update) => {
      const items: Array<{ record_id: string; fields: Record<string, unknown> }> = [];
      for (let token: string | null = '0'; token !== null; ) {
        const q = new URLSearchParams({ page_size: '500', page_token: token });
        if (viewId) q.set('view_id', viewId);
        const r = await call(headersFwd, 'GET', `/tables/${encodeURIComponent(table_key)}/records?${q}`);
        if (r.status !== 200) throw new JobFailure(String(r.body.message ?? '导出失败'));
        for (const it of (r.body.items ?? []) as typeof items) if (!ids || ids.has(it.record_id)) items.push(it);
        token = (r.body.has_more ? (r.body.page_token as string | null) : null) ?? null;
        if (items.length > MAX_ROWS) break;
        await update({ progress: 0.2, message: `已读取 ${items.length} 条` });
      }
      // 列：视图的字段顺序，去掉隐藏列
      let cols = res.schema.fields;
      if (view) {
        const order = view.config.field_order ?? [];
        const hidden = new Set(view.config.hidden_fields ?? []);
        cols = [...cols].sort((a, b) => {
          const ia = order.indexOf(a.field_name), ib = order.indexOf(b.field_name);
          return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
        }).filter((f) => !hidden.has(f.field_name) || f.field_name === res.schema.primary_field);
      }
      const names = new Map((await repo.listUsers({ limit: 1_000_000, offset: 0 })).items.map((u) => [u.user_id, u.name]));
      const sheet: Sheet = [cols.map((f) => f.title), ...items.map((r) => cols.map((f) => display(r.fields[f.field_name], f.type, names)))];
      const base = safeName(`${res.schema.name}${view ? `_${view.name}` : ''}_${stamp()}`);
      const file_name = `${base}.${format}`;
      const file_key = format === 'csv'
        ? await jobs.saveFile(me.sub, file_name, writeCsv(sheet), 'text/csv; charset=utf-8')
        : await jobs.saveFile(me.sub, file_name, writeXlsx(sheet, res.schema.name), XLSX_TYPE);
      return { file_key, file_name, total: items.length };
    });
    return reply.code(202).send({ job_id: job.job_id });
  });

  // ================================================================ 文档导出

  app.post('/api/v1/docs/:doc_id/exports', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { doc_id } = req.params as { doc_id: string };
    const format = (req.body as { format?: unknown } | null)?.format;
    if (format !== 'pdf' && format !== 'docx') return invalid(reply, [{ field: 'format', message: '只能是 pdf 或 docx' }]);
    const doc = await repo.getDoc(doc_id);
    if (!doc) return fail(reply, 404, '文档不存在', { code: 'NOT_FOUND' });
    if (!(await docAccess(ctx, doc, me.sub)).permissions.can_view) return fail(reply, 403, '没有权限访问这个文档', { code: 'FORBIDDEN' });
    const job = await jobs.create(me.sub, 'doc_export', `导出「${doc.title}」`);
    void jobs.run(job, async (update) => {
      const blocks = parseMarkdown(doc.markdown ?? '');
      // 图片：文档里引用、且本人有权访问的文件
      const loadImage = async (key: string) => {
        const f = await repo.getFile(key);
        if (!f || !(await ctx.canAccessFile(me, f)) || f.size > 15 * 1024 * 1024) return undefined;
        return ctx.fileStore.read(key);
      };
      await update({ progress: 0.3, message: '正在生成文件' });
      const data = format === 'pdf' ? await toPdf(doc.title, blocks, loadImage) : await toDocx(doc.title, blocks, loadImage);
      const file_name = `${safeName(doc.title)}.${format}`;
      const file_key = await jobs.saveFile(me.sub, file_name, data, format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      return { file_key, file_name, size: data.length };
    });
    return reply.code(202).send({ job_id: job.job_id });
  });

  // ================================================================ 成员批量导入（R-AD-01）

  const USER_COLS = ['登录账号', '姓名', '邮箱', '手机号', '职务', '部门', '直属上级', '角色'] as const;

  async function adminGuard(req: FastifyRequest, reply: FastifyReply) {
    const me = await ctx.requireUser(req, reply);
    if (!me) return undefined;
    if (me.via_bot) { fail(reply, 403, '这个操作不允许由机器人代办，请本人在 App 里操作', { code: 'BOT_SCOPE_DENIED' }); return undefined; }
    if (!(await ctx.roles.has(me.user, 'admin.members'))) { fail(reply, 403, '没有权限执行这个操作', { code: 'FORBIDDEN', permission: 'admin.members' }); return undefined; }
    return me;
  }

  /** 校验并把一行换成 POST /users 的请求体。部门写名称（多级用 / 分隔，多个用 、分隔），角色写名称。 */
  async function userRowParser() {
    const org = await ctx.org.read();
    const roles = (await ctx.roles.read(true)).roles;
    const users = (await repo.listUsers({ limit: 1_000_000, offset: 0 })).items;
    const deptPath = (id: string | null): string => {
      const d = org.departments.find((x) => x.department_id === id);
      return d ? (d.parent_id ? `${deptPath(d.parent_id)}/${d.name}` : d.name) : '';
    };
    const deptBy = new Map<string, string[]>();
    for (const d of org.departments) {
      for (const k of new Set([d.name, deptPath(d.department_id)])) deptBy.set(k, [...(deptBy.get(k) ?? []), d.department_id]);
    }
    const taken = new Set(users.map((u) => u.user_id.toLowerCase()));
    return (row: string[], idx: (c: string) => number, seen: Set<string>): { body?: Record<string, unknown>; error?: string } => {
      const get = (c: string) => (idx(c) >= 0 ? (row[idx(c)] ?? '').trim() : '');
      const username = get('登录账号'), name = get('姓名');
      if (!username) return { error: '登录账号不能为空' };
      if (!/^[\w.@-]{2,64}$/.test(username)) return { error: '登录账号需 2～64 位，只能包含字母、数字和 _ . @ -' };
      if (taken.has(username.toLowerCase())) return { error: `登录账号已存在：${username}` };
      if (seen.has(username.toLowerCase())) return { error: `文件里登录账号重复：${username}` };
      if (!name) return { error: '姓名不能为空' };
      const body: Record<string, unknown> = { username, name };
      const email = get('邮箱'), phone = get('手机号'), title = get('职务');
      if (email) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: `邮箱格式不对：${email}` }; body.email = email; }
      if (phone) body.phone = phone;
      if (title) body.title = title;
      const depts = get('部门');
      if (depts) {
        const ids: string[] = [];
        for (const n of depts.split(/[、,，;；\n]/).map((x) => x.trim().replace(/\s*\/\s*/g, '/')).filter(Boolean)) {
          const hit = deptBy.get(n);
          if (!hit) return { error: `部门不存在：${n}` };
          if (hit.length > 1) return { error: `有多个部门叫「${n}」，请写完整路径（如 学院/班级）` };
          ids.push(hit[0]);
        }
        body.department_ids = ids;
        body.primary_department_id = ids[0];
      }
      const leader = get('直属上级');
      if (leader) {
        const l = users.find((u) => u.role !== 'bot' && (u.user_id === leader || u.name === leader));
        if (!l) return { error: `直属上级不存在：${leader}` };
        body.leader_id = l.user_id;
      }
      const roleNames = get('角色');
      if (roleNames) {
        const ids: string[] = [];
        for (const n of roleNames.split(/[、,，;；]/).map((x) => x.trim()).filter(Boolean)) {
          const r = roles.find((x) => x.name === n || x.role_id === n);
          if (!r) return { error: `角色不存在：${n}` };
          ids.push(r.role_id);
        }
        body.role_ids = ids;
      }
      seen.add(username.toLowerCase());
      return { body };
    };
  }

  app.get('/api/v1/users/import/template', async (req, reply) => {
    const me = await adminGuard(req, reply);
    if (!me) return;
    const sheet: Sheet = [[...USER_COLS], ['zhangsan', '张三', 'zhangsan@example.com', '13800000000', '学生', '计算机学院/1 班', 'lisi', '普通成员']];
    const file_key = await jobs.saveFile(me.sub, '成员导入模板.xlsx', writeXlsx(sheet, '成员'), XLSX_TYPE);
    return { file_key, file_name: '成员导入模板.xlsx' };
  });

  const userIdx = (sheet: Sheet) => {
    const headers = headersOf(sheet);
    return (c: string) => headers.indexOf(c);
  };

  app.post('/api/v1/users/import/preview', async (req, reply) => {
    const me = await adminGuard(req, reply);
    if (!me) return;
    const up = await readUpload(me, (req.body as { file_key?: unknown } | null)?.file_key, reply);
    if (!up) return;
    const idx = userIdx(up.sheet);
    if (idx('登录账号') < 0 || idx('姓名') < 0) return fail(reply, 422, '表头需要包含「登录账号」和「姓名」，请使用导入模板', { code: 'BAD_TEMPLATE' });
    const parse = await userRowParser();
    const seen = new Set<string>();
    const rows = up.sheet.slice(1);
    const errors: Array<{ row: number; message: string }> = [];
    rows.forEach((r, i) => { if (r.some((v) => v.trim())) { const p = parse(r, idx, seen); if (p.error) errors.push({ row: i, message: p.error }); } });
    const headers = headersOf(up.sheet);
    return { headers, rows: rows.map((r) => headers.map((_, i) => r[i] ?? '')), total_rows: rows.length, errors };
  });

  app.post('/api/v1/users/import', async (req, reply) => {
    const me = await adminGuard(req, reply);
    if (!me) return;
    const up = await readUpload(me, (req.body as { file_key?: unknown } | null)?.file_key, reply);
    if (!up) return;
    const idx = userIdx(up.sheet);
    if (idx('登录账号') < 0 || idx('姓名') < 0) return fail(reply, 422, '表头需要包含「登录账号」和「姓名」，请使用导入模板', { code: 'BAD_TEMPLATE' });
    const headersFwd = authHeaders(req);
    const job = await jobs.create(me.sub, 'user_import', '批量导入成员');
    void jobs.run(job, async (update) => {
      const parse = await userRowParser();
      const seen = new Set<string>();
      const rows = up.sheet.slice(1);
      const created: Sheet = [['登录账号', '姓名', '初始密码']];
      const errors: Array<{ row: number; message: string }> = [];
      for (const [i, r] of rows.entries()) {
        if (!r.some((v) => v.trim())) continue;
        const p = parse(r, idx, seen);
        if (p.error) { errors.push({ row: i, message: p.error }); continue; }
        const res = await call(headersFwd, 'POST', '/users', p.body);
        if (res.status === 201) created.push([String(res.body.username ?? p.body!.username), String(res.body.name ?? ''), String(res.body.initial_password ?? '')]);
        else errors.push({ row: i, message: String(res.body.message ?? `创建失败（${res.status}）`) });
        if (i % 20 === 0) await update({ progress: 0.1 + 0.85 * (i / Math.max(1, rows.length)), message: `已处理 ${i + 1} / ${rows.length} 行` });
      }
      const result: Record<string, unknown> = { succeeded: created.length - 1, failed: errors.length };
      // 初始密码只在这个文件里出现一次
      if (created.length > 1) {
        result.file_name = `成员初始密码_${stamp()}.xlsx`;
        result.file_key = await jobs.saveFile(me.sub, result.file_name as string, writeXlsx(created, '初始密码'), XLSX_TYPE);
      }
      if (errors.length) {
        const headers = headersOf(up.sheet);
        const sheet: Sheet = [['行号', '失败原因', ...headers], ...errors.map((e) => [String(e.row + 2), e.message, ...headers.map((_, c) => rows[e.row]?.[c] ?? '')])];
        result.error_file_key = await jobs.saveFile(me.sub, `成员导入失败明细_${stamp()}.xlsx`, writeXlsx(sheet, '失败明细'), XLSX_TYPE);
      }
      await ctx.auditLog.record({ req, operator_id: me.sub, operator_name: me.user.name, action: 'user.import', target_type: 'user', target_id: null, target_name: null, detail: `成功 ${created.length - 1}，失败 ${errors.length}` });
      return result;
    });
    return reply.code(202).send({ job_id: job.job_id });
  });
}
