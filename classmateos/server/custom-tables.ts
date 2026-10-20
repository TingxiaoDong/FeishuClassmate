/**
 * 多维表格自定义数据表（《多维表格新建数据表接口需求》）：
 *   - parseCreateTable：POST /api/v1/tables 请求体校验（中文错误，字段路径如 fields[1].options）；
 *   - customTableDef：自定义表定义 → 内部 TableDef（记录校验 / 存储共用）；
 *   - describeCustomTable：与 GET /tables 单项结构一致的返回体。
 */

import type { FieldDef, TableDef } from '../../src/bitable/schema.js';
import type { FieldError } from './context.js';
import type { CustomFieldRecord, CustomTableRecord } from './repo.js';
import { COLOR_NAMES } from './table-meta.js';
import { ALLOWED_COLORS } from './table-schema.js';

/** 新建时支持的字段类型（暂不支持关联 18）。 */
export const CUSTOM_FIELD_TYPES: Record<number, string> = {
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

/** 物理表的系统列，不能用作字段名。 */
const RESERVED_FIELD_NAMES = new Set([
  'record_id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'feishu_record_id',
  'cos_created_by',
  'cos_updated_by',
]);

/** 自动分配的选项颜色顺序（都是前端已有的颜色名）。 */
const AUTO_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'turquoise', 'yellow', 'carmine', 'wathet', 'gray'];

const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** PostgreSQL 标识符最长 63 字节，超出会被截断导致同名，这里收紧到 63。 */
const FIELD_NAME_MAX = 63;

const chars = (s: string) => [...s].length;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface CreateTableInput {
  name: string;
  description: string | null;
  primary_field: string;
  client_request_id: string | null;
  fields: CustomFieldRecord[];
}

export function parseCreateTable(body: unknown): { value?: CreateTableInput; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });
  if (!isObj(body)) return { errors: [{ field: 'body', message: '请求体必须是 JSON 对象' }] };

  // name
  let name = '';
  if (typeof body.name !== 'string') err('name', '请填写数据表名称');
  else {
    name = body.name.trim();
    if (!name) err('name', '请填写数据表名称');
    else if (chars(name) > 60) err('name', '数据表名称最多 60 个字');
  }

  // description
  let description: string | null = null;
  if (body.description != null) {
    if (typeof body.description !== 'string') err('description', '说明必须是文本');
    else {
      description = body.description.trim() || null;
      if (description && chars(description) > 500) err('description', '说明最多 500 个字');
    }
  }

  // client_request_id
  let clientRequestId: string | null = null;
  if (body.client_request_id != null) {
    if (typeof body.client_request_id !== 'string' || !body.client_request_id.trim()) {
      err('client_request_id', '必须是非空文本');
    } else if (body.client_request_id.length > 128) err('client_request_id', '最多 128 个字符');
    else clientRequestId = body.client_request_id;
  }

  // fields
  const fields: CustomFieldRecord[] = [];
  if (!Array.isArray(body.fields) || body.fields.length === 0) err('fields', '至少需要一个字段');
  else if (body.fields.length > 30) err('fields', '最多 30 个字段');
  else {
    const seenNames = new Set<string>();
    const seenTitles = new Set<string>();
    body.fields.forEach((raw, i) => {
      const at = `fields[${i}]`;
      if (!isObj(raw)) {
        err(at, '字段定义必须是对象');
        return;
      }
      let ok = true;

      // field_name
      const fn = raw.field_name;
      if (typeof fn !== 'string' || !fn) {
        err(`${at}.field_name`, '请填写字段名');
        ok = false;
      } else if (!FIELD_NAME_RE.test(fn)) {
        err(`${at}.field_name`, '字段名只能用小写字母、数字和下划线，并以字母开头');
        ok = false;
      } else if (fn.length > FIELD_NAME_MAX) {
        err(`${at}.field_name`, `字段名最多 ${FIELD_NAME_MAX} 个字符`);
        ok = false;
      } else if (RESERVED_FIELD_NAMES.has(fn)) {
        err(`${at}.field_name`, `「${fn}」是系统保留字段名，请换一个`);
        ok = false;
      } else if (seenNames.has(fn)) {
        err(`${at}.field_name`, `字段名「${fn}」重复`);
        ok = false;
      } else seenNames.add(fn);

      // title
      let title = '';
      if (typeof raw.title !== 'string' || !raw.title.trim()) {
        err(`${at}.title`, '请填写字段显示名');
        ok = false;
      } else {
        title = raw.title.trim();
        const k = title.toLowerCase();
        if (chars(title) > 40) {
          err(`${at}.title`, '字段显示名最多 40 个字');
          ok = false;
        } else if (seenTitles.has(k)) {
          err(`${at}.title`, `字段显示名「${title}」重复`);
          ok = false;
        } else seenTitles.add(k);
      }

      // type
      const type = raw.type;
      if (type === 18) {
        err(`${at}.type`, '暂不支持在新建数据表时创建关联字段');
        ok = false;
      } else if (typeof type !== 'number' || !(type in CUSTOM_FIELD_TYPES)) {
        err(`${at}.type`, `不支持的字段类型，可选：${Object.entries(CUSTOM_FIELD_TYPES).map(([k, v]) => `${k} ${v}`).join('、')}`);
        ok = false;
      }

      // required
      if (raw.required != null && typeof raw.required !== 'boolean') {
        err(`${at}.required`, '必须是 true 或 false');
        ok = false;
      }
      const required = raw.required === true;

      // options / option_colors
      const isSelect = type === 3 || type === 4;
      let options: string[] | undefined;
      let optionColors: Record<string, string> | undefined;
      if (isSelect) {
        if (!Array.isArray(raw.options) || raw.options.length === 0) {
          err(`${at}.options`, '至少填写一个选项');
          ok = false;
        } else if (raw.options.length > 50) {
          err(`${at}.options`, '最多 50 个选项');
          ok = false;
        } else {
          const seen = new Set<string>();
          options = [];
          for (const [j, o] of raw.options.entries()) {
            const v = typeof o === 'string' ? o.trim() : '';
            if (!v) {
              err(`${at}.options[${j}]`, '选项不能为空');
              ok = false;
            } else if (chars(v) > 40) {
              err(`${at}.options[${j}]`, '选项最多 40 个字');
              ok = false;
            } else if (seen.has(v)) {
              err(`${at}.options[${j}]`, `选项「${v}」重复`);
              ok = false;
            } else {
              seen.add(v);
              options.push(v);
            }
          }
        }
        if (options && raw.option_colors != null) {
          if (!isObj(raw.option_colors)) {
            err(`${at}.option_colors`, '必须是「选项 → 颜色名」对象');
            ok = false;
          } else {
            for (const [k, c] of Object.entries(raw.option_colors)) {
              if (!options.includes(k.trim())) {
                err(`${at}.option_colors`, `没有这个选项：${k}`);
                ok = false;
              } else if (typeof c !== 'string' || !ALLOWED_COLORS.includes(c)) {
                err(`${at}.option_colors`, `不支持的颜色：${String(c)}（可选：${ALLOWED_COLORS.join('、')}）`);
                ok = false;
              }
            }
          }
        }
        if (options) {
          const given = isObj(raw.option_colors) ? (raw.option_colors as Record<string, string>) : {};
          const trimmedGiven = Object.fromEntries(Object.entries(given).map(([k, v]) => [k.trim(), v]));
          optionColors = Object.fromEntries(
            options.map((o, j) => [o, trimmedGiven[o] ?? AUTO_COLORS[j % AUTO_COLORS.length]]),
          );
        }
      } else if (raw.options != null && !(Array.isArray(raw.options) && raw.options.length === 0)) {
        err(`${at}.options`, '只有单选、多选字段可以设置选项');
        ok = false;
      }

      if (ok) {
        const f: CustomFieldRecord = { field_name: fn as string, title, type: type as number, required };
        if (options) {
          f.options = options;
          f.option_colors = optionColors;
        }
        fields.push(f);
      }
    });
  }

  // primary_field
  let primary = '';
  if (typeof body.primary_field !== 'string' || !body.primary_field) err('primary_field', '请指定主字段');
  else {
    primary = body.primary_field;
    const list = Array.isArray(body.fields) ? (body.fields as unknown[]) : [];
    const pf = list.find((f) => isObj(f) && f.field_name === primary) as Record<string, unknown> | undefined;
    if (!pf) err('primary_field', '主字段必须是字段列表中的一个字段');
    else if (pf.type !== 1) err('primary_field', '主字段必须是文本类型');
    else if (pf.required !== true) err('primary_field', '主字段必须设为必填');
  }

  if (errors.length > 0) return { errors };
  return { value: { name, description, primary_field: primary, client_request_id: clientRequestId, fields }, errors };
}

/** 自定义表 → 内部 TableDef（选项写成 Bitable 的 property.options，颜色存为调色板序号）。 */
export function customTableDef(t: CustomTableRecord): TableDef {
  return {
    key: t.key,
    name: t.name,
    fields: t.fields.map((f): FieldDef => {
      if (!f.options) return { field_name: f.field_name, type: f.type };
      return {
        field_name: f.field_name,
        type: f.type,
        property: {
          options: f.options.map((name) => ({ name, color: Math.max(0, COLOR_NAMES.indexOf(f.option_colors?.[name] ?? '')) })),
        },
      };
    }),
  };
}

export function requiredOfCustom(t: CustomTableRecord): string[] {
  return t.fields.filter((f) => f.required).map((f) => f.field_name);
}

/** 与 GET /tables 单项结构一致。 */
export function describeCustomTable(t: CustomTableRecord) {
  return {
    key: t.key,
    name: t.name,
    description: t.description,
    icon: t.icon,
    primary_field: t.primary_field,
    builtin: false,
    created_by: t.created_by,
    created_at: t.created_at,
    updated_at: t.updated_at,
    fields: t.fields.map((f) => ({
      field_name: f.field_name,
      title: f.title,
      type: f.type,
      required: f.required,
      ...(f.options ? { options: f.options, option_colors: f.option_colors ?? {} } : {}),
      description: null,
    })),
  };
}
