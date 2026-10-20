/**
 * 字段管理（《二期功能需求文档》R-BT-02）。
 *
 *   POST   /tables/:key/fields                           新增（可选 after_field）
 *   PATCH  /tables/:key/fields/:field                    改名称 / 类型 / 必填 / 选项（option_renames）/ 说明
 *   DELETE /tables/:key/fields/:field?base_version=      删除（主字段 422，内置字段 403，被视图引用 409 FIELD_IN_USE）
 *   PUT    /tables/:key/fields/order                     改默认顺序
 *   POST   /tables/:key/fields/:field/convert-preview    改类型前预估影响条数
 *
 * 都需要表的 can_manage；带 base_version 时与当前版本不一致返回 409 VERSION_CONFLICT。
 * 都返回整张表的最新定义（同 GET /tables 单项），并推送 table.schema_changed。
 */

import { tableAccessOf } from './table-access.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fail, invalid, type AuthedUser, type Ctx, type FieldError } from './context.js';
import { nowIso } from './repo.js';
import type { ResolvedTable, TableService } from './table-service.js';
import {
  convertValue,
  describeSchema,
  fieldsToRecords,
  isEmptyValue,
  MAX_FIELDS,
  parseDescription,
  parseOptions,
  parseTitle,
  parseType,
  pickFieldName,
  RESERVED_FIELD_NAMES,
  schemaToDef,
  tablePermissions,
  type FieldMeta,
  type TableSchema,
} from './table-schema.js';
import { fieldUsages } from './view-engine.js';

const isSelect = (t: number) => t === 3 || t === 4;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

class OpError {
  constructor(
    readonly status: number,
    readonly message: string,
    readonly extra: Record<string, unknown> = {},
  ) {}
}

export function registerTableFieldRoutes(ctx: Ctx, svc: TableService): void {
  const { app, repo, store } = ctx;

  /**
   * 字段操作外壳：鉴权 → 加表锁 → 取最新结构 → 权限 / 版本检查 → fn。
   * fn 抛 OpError 时按其状态码返回。
   */
  const op = async (
    req: FastifyRequest,
    reply: FastifyReply,
    fn: (res: ResolvedTable, me: AuthedUser, body: Record<string, unknown>) => Promise<unknown>,
    opts: { checkVersion?: boolean } = { checkVersion: true },
  ) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { table_key } = req.params as { table_key: string };
    const body = isObj(req.body) ? req.body : {};
    try {
      return await svc.withLock(table_key, async () => {
        const res = await svc.load(table_key, true);
        if (!res) throw new OpError(404, `数据表不存在：${table_key}`, { code: 'TABLE_NOT_FOUND' });
        if (!(await tableAccessOf(ctx).flags(me, res.schema)).can_manage) {
          throw new OpError(403, '只有管理员或数据表创建者可以管理字段', { code: 'FORBIDDEN' });
        }
        if (opts.checkVersion) {
          const raw = body.base_version ?? (req.query as { base_version?: string }).base_version;
          if (raw !== undefined && raw !== null && raw !== '') {
            const v = Number(raw);
            if (!Number.isInteger(v)) throw new OpError(422, '参数校验失败', { code: 'VALIDATION_FAILED', errors: [{ field: 'base_version', message: '必须是整数' }] });
            if (v !== res.schema.version) {
              throw new OpError(409, '内容已被别人修改，请刷新后重试', { code: 'VERSION_CONFLICT', table: describeSchema(res.schema, me) });
            }
          }
        }
        return fn(res, me, body);
      });
    } catch (err) {
      if (err instanceof OpError) return fail(reply, err.status, err.message, err.extra);
      throw err;
    }
  };

  const validationError = (errors: FieldError[]) =>
    new OpError(422, errors[0]?.message ?? '参数校验失败', { code: 'VALIDATION_FAILED', errors });

  /**
   * 提交新的字段列表：before（加列 / 去约束）→ 按版本保存 → after（删列 / 改类型 / 改值）→ 刷新缓存 → 推送。
   */
  const commit = async (
    res: ResolvedTable,
    me: AuthedUser,
    fields: FieldMeta[],
    hooks: { before?: (def: ReturnType<typeof schemaToDef>) => Promise<void>; after?: (def: ReturnType<typeof schemaToDef>) => Promise<void> } = {},
  ) => {
    const old = res.schema;
    const now = nowIso();
    const schema: TableSchema = { ...old, fields, version: old.version + 1, updated_at: now };
    const def = schemaToDef(schema, svc.builtinDef(old.key));
    await hooks.before?.(def);
    const ok = old.builtin
      ? await repo.saveTableSchema(
          { table_key: old.key, version: schema.version, fields: fieldsToRecords(fields, true), updated_at: now },
          res.hasOverride ? old.version : null,
        )
      : await repo.updateCustomTableFields(old.key, fieldsToRecords(fields, false), schema.version, now, old.version);
    if (!ok) {
      const latest = await svc.load(old.key, true);
      throw new OpError(409, '内容已被别人修改，请刷新后重试', {
        code: 'VERSION_CONFLICT',
        ...(latest ? { table: describeSchema(latest.schema, me) } : {}),
      });
    }
    await store.updateDef?.(def);
    await hooks.after?.(def);
    const next = { schema, def, hasOverride: true };
    if (!old.builtin) {
      const t = ctx.customTables.get(old.key);
      if (t) ctx.customTables.set(old.key, { ...t, fields: fieldsToRecords(fields, false), version: schema.version, updated_at: now });
    }
    await svc.apply(next);
    svc.emitSchemaChanged(old.key, schema.version);
    return describeSchema(schema, me);
  };

  const findField = (res: ResolvedTable, name: string) => {
    const f = res.schema.fields.find((x) => x.field_name === name);
    if (!f) throw new OpError(404, `字段不存在：${name}`, { code: 'FIELD_NOT_FOUND' });
    return f;
  };

  /** 字段在每条记录里的值（只取非空的）。 */
  const valuesOf = async (key: string, fieldName: string) =>
    (await svc.scanAll(key))
      .map((r) => ({ record_id: r.record_id, value: r.fields[fieldName] }))
      .filter((e) => !isEmptyValue(e.value));

  // ---------------- 新增 ----------------

  app.post('/api/v1/tables/:table_key/fields', (req, reply) =>
    op(req, reply, async (res, me, body) => {
      const errors: FieldError[] = [];
      const fields = res.schema.fields;
      if (fields.length >= MAX_FIELDS) throw validationError([{ field: 'fields', message: `一张表最多 ${MAX_FIELDS} 个字段` }]);
      // 内置表物理列名都算占用（包括已改名的内置字段）
      const taken = new Set([...fields.map((f) => f.field_name), ...(svc.builtinDef(res.schema.key)?.fields.map((f) => f.field_name) ?? []), ...RESERVED_FIELD_NAMES]);
      const name = pickFieldName(body.field_name, errors, taken);
      const title = parseTitle(body.title, errors, fields);
      const type = parseType(body.type, errors);
      if (body.required != null && typeof body.required !== 'boolean') errors.push({ field: 'required', message: '必须是 true 或 false' });
      const description = parseDescription(body.description, errors);
      let opts: ReturnType<typeof parseOptions>;
      if (type !== undefined && isSelect(type)) opts = parseOptions(body.options, body.option_colors, '', errors);
      else if (Array.isArray(body.options) && body.options.length > 0) errors.push({ field: 'options', message: '只有单选、多选字段可以设置选项' });
      let insertAt = fields.length;
      if (body.after_field != null) {
        const i = fields.findIndex((f) => f.field_name === body.after_field);
        if (i < 0) errors.push({ field: 'after_field', message: `字段不存在：${String(body.after_field)}` });
        else insertAt = i + 1;
      }
      if (errors.length) throw validationError(errors);
      const f: FieldMeta = {
        field_name: name!,
        title: title!,
        type: type!,
        required: body.required === true,
        description: description ?? null,
        builtin: false,
        ...(opts ? opts : {}),
      };
      const next = [...fields.slice(0, insertAt), f, ...fields.slice(insertAt)];
      const out = await commit(res, me, next, { before: (def) => store.addColumn?.(def, f.field_name) ?? Promise.resolve() });
      return reply.code(201).send(out);
    }),
  );

  // ---------------- 默认顺序 ----------------

  app.put('/api/v1/tables/:table_key/fields/order', (req, reply) =>
    op(req, reply, async (res, me, body) => {
      const names = body.field_names;
      if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== 'string')) {
        throw validationError([{ field: 'field_names', message: '必须是字段名数组' }]);
      }
      const byName = new Map(res.schema.fields.map((f) => [f.field_name, f]));
      const seen = new Set<string>();
      for (const n of names as string[]) {
        if (!byName.has(n)) throw validationError([{ field: 'field_names', message: `字段不存在：${n}` }]);
        if (seen.has(n)) throw validationError([{ field: 'field_names', message: `字段重复：${n}` }]);
        seen.add(n);
      }
      // 没列出的字段按原顺序接在后面
      const next = [...(names as string[]).map((n) => byName.get(n)!), ...res.schema.fields.filter((f) => !seen.has(f.field_name))];
      return commit(res, me, next);
    }),
  );

  // ---------------- 修改 ----------------

  /** 计算 PATCH 后的字段 + 已有值的改写方式。 */
  const planPatch = (res: ResolvedTable, cur: FieldMeta, body: Record<string, unknown>) => {
    const errors: FieldError[] = [];
    const isPrimary = res.schema.primary_field === cur.field_name;
    const next: FieldMeta = { ...cur };

    if (body.title !== undefined) {
      const t = parseTitle(body.title, errors, res.schema.fields.filter((f) => f.field_name !== cur.field_name));
      if (t) next.title = t;
    }
    if (body.type !== undefined && body.type !== cur.type) {
      if (cur.builtin) throw new OpError(403, '内置字段不能修改类型', { code: 'FORBIDDEN' });
      if (isPrimary) throw validationError([{ field: 'type', message: '主字段不能修改类型' }]);
      const t = parseType(body.type, errors);
      if (t !== undefined) next.type = t;
    }
    if (body.required !== undefined) {
      if (typeof body.required !== 'boolean') errors.push({ field: 'required', message: '必须是 true 或 false' });
      else if (body.required !== cur.required) {
        if (cur.builtin) throw new OpError(403, '内置字段只能修改名称和选项', { code: 'FORBIDDEN' });
        if (isPrimary && !body.required) errors.push({ field: 'required', message: '主字段必须是必填' });
        else next.required = body.required;
      }
    }
    if (body.description !== undefined) {
      const d = parseDescription(body.description, errors);
      if (d !== undefined && d !== cur.description) {
        if (cur.builtin) throw new OpError(403, '内置字段只能修改名称和选项', { code: 'FORBIDDEN' });
        next.description = d;
      }
    }

    // 选项
    let renames: Record<string, string> = {};
    if (isSelect(next.type)) {
      const rawOptions = body.options !== undefined ? body.options : isSelect(cur.type) ? cur.options : undefined;
      if (body.option_renames != null) {
        if (!isObj(body.option_renames) || Object.values(body.option_renames).some((v) => typeof v !== 'string')) {
          errors.push({ field: 'option_renames', message: '必须是「旧选项 → 新选项」对象' });
        } else renames = Object.fromEntries(Object.entries(body.option_renames as Record<string, string>).map(([k, v]) => [k, v.trim()]));
      }
      // 改名的选项沿用原来的颜色
      const oldColors = { ...(cur.option_colors ?? {}) };
      for (const [o, n] of Object.entries(renames)) if (oldColors[o]) oldColors[n] = oldColors[o];
      const parsed = parseOptions(rawOptions, body.option_colors !== undefined ? body.option_colors : cur.option_colors, '', errors, oldColors);
      if (parsed) {
        for (const [o, n] of Object.entries(renames)) {
          if (!(cur.options ?? []).includes(o)) errors.push({ field: 'option_renames', message: `没有这个旧选项：${o}` });
          else if (!parsed.options.includes(n)) errors.push({ field: 'option_renames', message: `改名后的选项「${n}」不在 options 里` });
        }
        next.options = parsed.options;
        next.option_colors = parsed.option_colors;
      }
    } else {
      if (Array.isArray(body.options) && body.options.length > 0) errors.push({ field: 'options', message: '只有单选、多选字段可以设置选项' });
      delete next.options;
      delete next.option_colors;
    }
    if (errors.length) throw validationError(errors);

    const typeChanged = next.type !== cur.type;
    const optionsChanged =
      isSelect(next.type) && JSON.stringify(next.options ?? []) !== JSON.stringify(cur.options ?? []);
    /** 旧值 → 新值；undefined = 清空。 */
    const mapValue = (v: unknown): unknown => {
      let x = v;
      if (isSelect(cur.type) && Object.keys(renames).length) {
        if (typeof x === 'string') x = renames[x] ?? x;
        else if (Array.isArray(x)) x = x.map((e) => (typeof e === 'string' ? (renames[e] ?? e) : e));
      }
      return convertValue(x, cur.type, next.type, isSelect(next.type) ? next.options : undefined);
    };
    return { next, typeChanged, optionsChanged, mapValue };
  };

  app.patch('/api/v1/tables/:table_key/fields/:field_name', (req, reply) =>
    op(req, reply, async (res, me, body) => {
      const cur = findField(res, (req.params as { field_name: string }).field_name);
      const plan = planPatch(res, cur, body);
      const fields = res.schema.fields.map((f) => (f.field_name === cur.field_name ? plan.next : f));
      const key = res.schema.key;
      const name = cur.field_name;

      if (plan.typeChanged) {
        const values = await valuesOf(key, name);
        return commit(res, me, fields, {
          after: async (def) => {
            await store.retypeColumn?.(def, name);
            const out = values.map((e) => ({ record_id: e.record_id, value: plan.mapValue(e.value) })).filter((e) => e.value !== undefined);
            await store.writeValues?.(key, name, out);
          },
        });
      }
      if (plan.optionsChanged) {
        const values = await valuesOf(key, name);
        return commit(res, me, fields, {
          before: (def) => store.relaxColumn?.(def, name) ?? Promise.resolve(),
          after: async () => {
            const changed = values
              .map((e) => ({ record_id: e.record_id, old: e.value, value: plan.mapValue(e.value) ?? null }))
              .filter((e) => JSON.stringify(e.old) !== JSON.stringify(e.value))
              .map(({ record_id, value }) => ({ record_id, value }));
            await store.writeValues?.(key, name, changed);
          },
        });
      }
      return commit(res, me, fields);
    }),
  );

  app.post('/api/v1/tables/:table_key/fields/:field_name/convert-preview', (req, reply) =>
    op(
      req,
      reply,
      async (res, _me, body) => {
        const cur = findField(res, (req.params as { field_name: string }).field_name);
        const errors: FieldError[] = [];
        const type = parseType(body.type, errors);
        if (errors.length) throw validationError(errors);
        let options: string[] | undefined;
        if (isSelect(type!)) {
          if (Array.isArray(body.options)) options = body.options.filter((o): o is string => typeof o === 'string').map((o) => o.trim());
          else if (isSelect(cur.type)) options = cur.options;
        }
        const values = await valuesOf(res.schema.key, cur.field_name);
        if (type === cur.type && !options) return { affected: 0, will_clear: 0 };
        let willClear = 0;
        for (const e of values) if (convertValue(e.value, cur.type, type!, options) === undefined) willClear++;
        return { affected: values.length, will_clear: willClear };
      },
      { checkVersion: false },
    ),
  );

  // ---------------- 删除 ----------------

  app.delete('/api/v1/tables/:table_key/fields/:field_name', (req, reply) =>
    op(req, reply, async (res, me) => {
      const cur = findField(res, (req.params as { field_name: string }).field_name);
      if (res.schema.primary_field === cur.field_name) throw validationError([{ field: 'field_name', message: '主字段不能删除' }]);
      if (cur.builtin) throw new OpError(403, '内置字段不能删除', { code: 'FORBIDDEN' });
      const refs: Array<{ view_id: string; view_name: string; personal: boolean; usages: string[] }> = [];
      for (const v of await repo.listViews(res.schema.key)) {
        const usages = fieldUsages(v.config, cur.field_name);
        if (usages.length) refs.push({ view_id: v.view_id, view_name: v.name, personal: v.personal, usages });
      }
      if (refs.length) {
        const where = refs
          .slice(0, 3)
          .map((r) => `${r.personal ? '个人' : ''}视图「${r.view_name}」的${r.usages.join('、')}`)
          .join('；');
        throw new OpError(
          409,
          `字段「${cur.title}」正在被 ${where}${refs.length > 3 ? ` 等 ${refs.length} 个视图` : ''}使用，请先在视图里去掉它再删除`,
          { code: 'FIELD_IN_USE', references: refs },
        );
      }
      const fields = res.schema.fields.filter((f) => f.field_name !== cur.field_name);
      return commit(res, me, fields, { after: (def) => store.dropColumn?.(def, cur.field_name) ?? Promise.resolve() });
    }),
  );

  void invalid;
}
