/**
 * 多维表格「表结构」统一模型（《二期功能需求文档》R-BT-01 / R-BT-02）：
 *   - 内置表：src/bitable/schema.ts + table-meta.ts 生成，叠加 cos_table_schemas 覆盖层
 *     （字段改名 / 改选项 / 新增自定义字段 / 默认顺序）；
 *   - 自定义表：cos_custom_tables 里的定义。
 * 两者都转成 TableSchema，再由 schemaToDef 生成记录校验 / 存储用的 TableDef。
 */

import type { FieldDef, TableDef } from '../../src/bitable/schema.js';
import type { FieldError } from './context.js';
import type { CustomTableRecord, FieldMetaRecord, TableSchemaRecord } from './repo.js';
import { COLOR_NAMES, describeTable } from './table-meta.js';

export interface FieldMeta {
  field_name: string;
  title: string;
  type: number;
  required: boolean;
  options?: string[];
  option_colors?: Record<string, string>;
  description: string | null;
  builtin: boolean;
}

export interface TableSchema {
  key: string;
  builtin: boolean;
  name: string;
  description: string | null;
  icon: string | null;
  primary_field: string | null;
  fields: FieldMeta[];
  version: number;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 字段管理支持的类型（与新建表一致，暂不含关联 18）。 */
export const FIELD_TYPES: Record<number, string> = {
  1: '文本',
  2: '数字',
  3: '单选',
  4: '多选',
  5: '日期',
  7: '复选框',
  11: '人员',
  15: '超链接',
  17: '附件',
};

/** 选项颜色：前端 8 色 + Bitable 调色板里已有的颜色名。 */
export const ALLOWED_COLORS = [...new Set(['blue', 'green', 'orange', 'red', 'purple', 'cyan', 'yellow', 'gray', ...COLOR_NAMES])];
const AUTO_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'cyan', 'yellow', 'gray'];

export const MAX_FIELDS = 100;
export const RESERVED_FIELD_NAMES = new Set([
  'record_id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'feishu_record_id',
  'cos_created_by',
  'cos_updated_by',
]);
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

const isSelect = (type: number) => type === 3 || type === 4;
const chars = (s: string) => [...s].length;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------------- 生成表结构 ----------------

function toMeta(f: FieldMetaRecord, builtinDefault: boolean): FieldMeta {
  const m: FieldMeta = {
    field_name: f.field_name,
    title: f.title,
    type: f.type,
    required: !!f.required,
    description: f.description ?? null,
    builtin: f.builtin ?? builtinDefault,
  };
  if (isSelect(f.type)) {
    m.options = [...(f.options ?? [])];
    m.option_colors = { ...(f.option_colors ?? {}) };
  }
  return m;
}

/** 内置表：默认结构 + 覆盖层（覆盖层缺的内置字段补在后面；已不存在的内置字段去掉）。 */
export function builtinSchema(def: TableDef, override?: TableSchemaRecord): TableSchema {
  const base = describeTable(def);
  const defaults: FieldMeta[] = base.fields.map((f) =>
    toMeta(
      {
        field_name: f.field_name,
        title: f.title,
        type: f.type,
        required: f.required,
        options: f.options,
        option_colors: f.option_colors,
        description: null,
      },
      true,
    ),
  );
  let fields = defaults;
  if (override) {
    const builtinNames = new Set(defaults.map((f) => f.field_name));
    const kept = override.fields
      .filter((f) => (f.builtin ? builtinNames.has(f.field_name) : true))
      .map((f) => toMeta(f, false));
    const have = new Set(kept.map((f) => f.field_name));
    fields = [...kept, ...defaults.filter((f) => !have.has(f.field_name))];
  }
  return {
    key: def.key,
    builtin: true,
    name: base.name,
    description: base.description,
    icon: base.icon,
    primary_field: base.primary_field,
    fields,
    version: override?.version ?? 1,
    created_by: null,
    created_at: null,
    updated_at: override?.updated_at ?? null,
  };
}

export function customSchema(t: CustomTableRecord): TableSchema {
  return {
    key: t.key,
    builtin: false,
    name: t.name,
    description: t.description,
    icon: t.icon,
    primary_field: t.primary_field,
    fields: t.fields.map((f) => toMeta(f, false)),
    version: t.version ?? 1,
    created_by: t.created_by,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

/** 表结构 → 内部 TableDef。内置字段沿用原定义（只替换选项）；选项颜色存为调色板序号。 */
export function schemaToDef(schema: TableSchema, original?: TableDef): TableDef {
  const orig = new Map((original?.fields ?? []).map((f) => [f.field_name, f]));
  const optionProp = (f: FieldMeta) => ({
    options: (f.options ?? []).map((name) => ({ name, color: Math.max(0, COLOR_NAMES.indexOf(f.option_colors?.[name] ?? '')) })),
  });
  return {
    key: schema.key,
    name: original?.name ?? schema.name,
    fields: schema.fields.map((f): FieldDef => {
      const o = f.builtin ? orig.get(f.field_name) : undefined;
      if (o) return isSelect(o.type) ? { ...o, property: { ...(o.property ?? {}), ...optionProp(f) } } : o;
      return isSelect(f.type) ? { field_name: f.field_name, type: f.type, property: optionProp(f) } : { field_name: f.field_name, type: f.type };
    }),
  };
}

/** 表结构 → 覆盖层 / 自定义表里存的字段列表。 */
export function fieldsToRecords(fields: FieldMeta[], keepBuiltinFlag: boolean): FieldMetaRecord[] {
  return fields.map((f) => {
    const r: FieldMetaRecord = { field_name: f.field_name, title: f.title, type: f.type, required: f.required, description: f.description };
    if (isSelect(f.type)) {
      r.options = f.options ?? [];
      r.option_colors = f.option_colors ?? {};
    }
    if (keepBuiltinFlag) r.builtin = f.builtin;
    return r;
  });
}

// ---------------- 权限与返回体 ----------------

export interface Permissions {
  can_view: boolean;
  can_edit: boolean;
  can_comment: boolean;
  can_manage: boolean;
  can_delete: boolean;
}

/**
 * 表的权限（迭代 2 的 R-BT-09 上线前的简化规则）：
 * 所有成员可看、可编辑记录；管理员和自定义表的创建者可管理字段 / 删除表。
 */
export function tablePermissions(me: { sub: string; role: string }, schema: TableSchema): Permissions {
  const manage = me.role === 'admin' || (!schema.builtin && schema.created_by === me.sub);
  return { can_view: true, can_edit: true, can_comment: true, can_manage: manage, can_delete: manage && !schema.builtin };
}

/** 与 GET /tables 单项结构一致。 */
export function describeSchema(schema: TableSchema, me: { sub: string; role: string }) {
  return {
    key: schema.key,
    name: schema.name,
    description: schema.description,
    icon: schema.icon,
    primary_field: schema.primary_field,
    builtin: schema.builtin,
    created_by: schema.created_by,
    created_at: schema.created_at,
    updated_at: schema.updated_at,
    version: schema.version,
    permissions: tablePermissions(me, schema),
    fields: schema.fields.map((f) => ({
      field_name: f.field_name,
      title: f.title,
      type: f.type,
      required: f.required,
      ...(isSelect(f.type) ? { options: f.options ?? [], option_colors: f.option_colors ?? {} } : {}),
      description: f.description,
      builtin: f.builtin,
    })),
  };
}

// ---------------- 字段请求体校验 ----------------

export function parseOptions(
  rawOptions: unknown,
  rawColors: unknown,
  at: string,
  errors: FieldError[],
  existingColors: Record<string, string> = {},
): { options: string[]; option_colors: Record<string, string> } | undefined {
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    errors.push({ field: `${at}options`, message: '至少填写一个选项' });
    return undefined;
  }
  if (rawOptions.length > 50) {
    errors.push({ field: `${at}options`, message: '最多 50 个选项' });
    return undefined;
  }
  let ok = true;
  const seen = new Set<string>();
  const options: string[] = [];
  rawOptions.forEach((o, j) => {
    const v = typeof o === 'string' ? o.trim() : '';
    if (!v) {
      errors.push({ field: `${at}options[${j}]`, message: '选项不能为空' });
      ok = false;
    } else if (chars(v) > 40) {
      errors.push({ field: `${at}options[${j}]`, message: '选项最多 40 个字' });
      ok = false;
    } else if (seen.has(v)) {
      errors.push({ field: `${at}options[${j}]`, message: `选项「${v}」重复` });
      ok = false;
    } else {
      seen.add(v);
      options.push(v);
    }
  });
  const given: Record<string, string> = {};
  if (rawColors != null) {
    if (!isObj(rawColors)) {
      errors.push({ field: `${at}option_colors`, message: '必须是「选项 → 颜色名」对象' });
      ok = false;
    } else {
      for (const [k, c] of Object.entries(rawColors)) {
        if (!seen.has(k.trim())) continue; // 已删除 / 改名前的旧选项颜色：忽略
        if (typeof c !== 'string' || !ALLOWED_COLORS.includes(c)) {
          errors.push({ field: `${at}option_colors`, message: `不支持的颜色：${String(c)}（可选：${AUTO_COLORS.join('、')}）` });
          ok = false;
        } else given[k.trim()] = c;
      }
    }
  }
  if (!ok) return undefined;
  const option_colors = Object.fromEntries(
    options.map((o, j) => [o, given[o] ?? existingColors[o] ?? AUTO_COLORS[j % AUTO_COLORS.length]]),
  );
  return { options, option_colors };
}

export function parseTitle(raw: unknown, errors: FieldError[], others: FieldMeta[]): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) {
    errors.push({ field: 'title', message: '请填写字段名称' });
    return undefined;
  }
  const title = raw.trim();
  if (chars(title) > 40) {
    errors.push({ field: 'title', message: '字段名称最多 40 个字' });
    return undefined;
  }
  if (others.some((f) => f.title.trim().toLowerCase() === title.toLowerCase())) {
    errors.push({ field: 'title', message: `已有同名字段「${title}」` });
    return undefined;
  }
  return title;
}

export function parseDescription(raw: unknown, errors: FieldError[]): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    errors.push({ field: 'description', message: '必须是文本' });
    return undefined;
  }
  const d = raw.trim();
  if (chars(d) > 500) {
    errors.push({ field: 'description', message: '说明最多 500 个字' });
    return undefined;
  }
  return d || null;
}

export function parseType(raw: unknown, errors: FieldError[]): number | undefined {
  if (raw === 18) {
    errors.push({ field: 'type', message: '暂不支持关联字段' });
    return undefined;
  }
  if (typeof raw !== 'number' || !(raw in FIELD_TYPES)) {
    errors.push({
      field: 'type',
      message: `不支持的字段类型，可选：${Object.entries(FIELD_TYPES).map(([k, v]) => `${k} ${v}`).join('、')}`,
    });
    return undefined;
  }
  return raw;
}

/** 新字段的 field_name：给了就校验，没给就生成 field_N。 */
export function pickFieldName(raw: unknown, errors: FieldError[], taken: Set<string>): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    for (let i = 1; ; i++) {
      const n = `field_${i}`;
      if (!taken.has(n)) return n;
    }
  }
  if (typeof raw !== 'string' || !FIELD_NAME_RE.test(raw)) {
    errors.push({ field: 'field_name', message: '字段名只能用小写字母、数字和下划线，以字母开头，最多 63 个字符' });
    return undefined;
  }
  if (RESERVED_FIELD_NAMES.has(raw)) {
    errors.push({ field: 'field_name', message: `「${raw}」是系统保留字段名，请换一个` });
    return undefined;
  }
  if (taken.has(raw)) {
    errors.push({ field: 'field_name', message: `字段名「${raw}」已存在` });
    return undefined;
  }
  return raw;
}

// ---------------- 改类型时的值转换 ----------------

export function isEmptyValue(v: unknown): boolean {
  return (
    v == null ||
    (typeof v === 'string' && v === '') ||
    (Array.isArray(v) && v.length === 0) ||
    (isObj(v) && Object.keys(v).length === 0)
  );
}

/** 单元格的显示文字（与前端 bitable_field.dart 的 fieldText 一致）。 */
export function fieldText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) return v.map(fieldText).filter((s) => s).join('、');
  if (isObj(v)) return String(v.text ?? v.name ?? v.link ?? v.file_name ?? v.id ?? JSON.stringify(v));
  return String(v);
}

const TRUE_WORDS = new Set(['true', '是', '1', 'yes', 'y', '✓', '已完成', '完成']);
const FALSE_WORDS = new Set(['false', '否', '0', 'no', 'n', '']);

/**
 * 把旧值转成新类型；转换不了返回 undefined（会被清空）。
 * options 给出时，单选 / 多选只保留在选项里的值。
 */
export function convertValue(v: unknown, from: number, to: number, options?: string[]): unknown {
  if (isEmptyValue(v)) return undefined;
  if (from === to && !isSelect(to)) return v;
  const inOptions = (s: string) => !options || options.includes(s);
  switch (to) {
    case 1:
    case 15: {
      const t = fieldText(from === 5 && typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : v);
      return t || undefined;
    }
    case 2: {
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      const s = (Array.isArray(v) && v.length === 1 ? fieldText(v[0]) : fieldText(v)).trim().replace(/,/g, '');
      const n = Number(s);
      return s !== '' && Number.isFinite(n) ? n : undefined;
    }
    case 3: {
      const s = Array.isArray(v) ? (v.length ? fieldText(v[0]) : '') : fieldText(v);
      return s && inOptions(s) ? s : undefined;
    }
    case 4: {
      const list = Array.isArray(v)
        ? v.map(fieldText)
        : fieldText(v)
            .split(/[,，、;；]/)
            .map((s) => s.trim());
      const out = [...new Set(list.filter((s) => s && inOptions(s)))];
      return out.length ? out : undefined;
    }
    case 5: {
      if (typeof v === 'number') return v;
      const t = Date.parse(fieldText(v));
      return Number.isFinite(t) ? t : undefined;
    }
    case 7: {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      const s = fieldText(v).trim().toLowerCase();
      if (TRUE_WORDS.has(s)) return true;
      if (FALSE_WORDS.has(s)) return false;
      return undefined;
    }
    case 11:
      return from === 11 ? v : undefined;
    case 17:
      return from === 17 ? v : undefined;
    default:
      return undefined;
  }
}
