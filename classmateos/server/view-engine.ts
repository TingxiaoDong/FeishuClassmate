/**
 * 视图计算（《二期功能需求文档》R-BT-03 / R-BT-04）：筛选、排序、分组。
 * 规则与前端 app/lib/pages/view_engine.dart 逐条一致（实时插入的新记录位置两边要相同）：
 *   - is / is_not：值是字符串数组；单选 / 多选比选项文字，人员比 user_id，复选框比 "true"/"false"，
 *     数字比数值，日期按天比较；数组为空时条件不生效；
 *   - contains / not_contains：文字包含（不区分大小写），值为空不生效；
 *   - gt / gte / lt / lte：数字（日期为毫秒）；
 *   - today / this_week（周一开始）/ last_7_days / this_month：按服务端时区（默认 UTC+8）；
 *   - 排序：空值不管升降序都排最后；分组字段先参与排序，保证同组连续；稳定排序。
 */

import type { FieldError } from './context.js';
import type { StoredRecord } from './store.js';
import { fieldText, isEmptyValue, type FieldMeta } from './table-schema.js';

export const VIEW_TYPES = ['grid', 'kanban', 'calendar', 'gantt', 'gallery'] as const;
export const FILTER_OPERATORS = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'gt',
  'gte',
  'lt',
  'lte',
  'today',
  'this_week',
  'last_7_days',
  'this_month',
] as const;
const ROW_HEIGHTS = ['compact', 'standard', 'loose'];

export interface FilterCondition {
  field_name: string;
  operator: string;
  value?: unknown;
}
export interface SortSpec {
  field_name: string;
  desc: boolean;
}
export interface ViewConfig {
  filter: { conjunction: 'and' | 'or'; conditions: FilterCondition[] };
  sort: SortSpec[];
  group: SortSpec[];
  hidden_fields: string[];
  field_order: string[];
  field_widths: Record<string, number>;
  row_height: string;
  kanban_field: string | null;
  [extra: string]: unknown;
}

export function defaultViewConfig(): ViewConfig {
  return {
    filter: { conjunction: 'and', conditions: [] },
    sort: [],
    group: [],
    hidden_fields: [],
    field_order: [],
    field_widths: {},
    row_height: 'standard',
    kanban_field: null,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 校验并规范化视图配置；不认识的配置项（如 calendar）原样保留。
 * 筛选 / 排序 / 分组 / 看板引用的字段必须存在；隐藏字段、字段顺序、列宽里的字段名不校验（输出时过滤）。
 */
export function parseViewConfig(raw: unknown, fields: FieldMeta[], errors: FieldError[]): ViewConfig | undefined {
  if (raw === undefined || raw === null) return defaultViewConfig();
  if (!isObj(raw)) {
    errors.push({ field: 'config', message: '必须是对象' });
    return undefined;
  }
  if (JSON.stringify(raw).length > 64 * 1024) {
    errors.push({ field: 'config', message: '视图配置太大' });
    return undefined;
  }
  const names = new Set(fields.map((f) => f.field_name));
  const n0 = errors.length;
  const out: ViewConfig = { ...defaultViewConfig(), ...raw } as ViewConfig;

  // filter
  if (raw.filter != null) {
    const f = raw.filter;
    if (!isObj(f)) errors.push({ field: 'config.filter', message: '必须是对象' });
    else {
      const conj = f.conjunction ?? 'and';
      if (conj !== 'and' && conj !== 'or') errors.push({ field: 'config.filter.conjunction', message: '只能是 and 或 or' });
      const conds = f.conditions ?? [];
      if (!Array.isArray(conds)) errors.push({ field: 'config.filter.conditions', message: '必须是数组' });
      else if (conds.length > 50) errors.push({ field: 'config.filter.conditions', message: '最多 50 个条件' });
      else {
        const list: FilterCondition[] = [];
        conds.forEach((c, i) => {
          const at = `config.filter.conditions[${i}]`;
          if (!isObj(c)) return errors.push({ field: at, message: '必须是对象' });
          if (typeof c.field_name !== 'string' || !names.has(c.field_name)) {
            return errors.push({ field: `${at}.field_name`, message: `数据表里没有这个字段：${String(c.field_name)}` });
          }
          if (typeof c.operator !== 'string' || !(FILTER_OPERATORS as readonly string[]).includes(c.operator)) {
            return errors.push({ field: `${at}.operator`, message: `不支持的运算符：${String(c.operator)}` });
          }
          list.push({ ...c, field_name: c.field_name, operator: c.operator });
        });
        out.filter = { ...f, conjunction: conj === 'or' ? 'or' : 'and', conditions: list };
      }
    }
  }

  // sort / group
  const specs = (key: 'sort' | 'group', max: number): SortSpec[] => {
    const v = raw[key];
    if (v == null) return [];
    if (!Array.isArray(v)) {
      errors.push({ field: `config.${key}`, message: '必须是数组' });
      return [];
    }
    if (v.length > max) {
      errors.push({ field: `config.${key}`, message: `最多 ${max} 个${key === 'group' ? '分组' : '排序'}字段` });
      return [];
    }
    const res: SortSpec[] = [];
    v.forEach((s, i) => {
      if (!isObj(s) || typeof s.field_name !== 'string' || !names.has(s.field_name)) {
        errors.push({ field: `config.${key}[${i}].field_name`, message: `数据表里没有这个字段：${isObj(s) ? String(s.field_name) : ''}` });
        return;
      }
      res.push({ ...s, field_name: s.field_name, desc: s.desc === true });
    });
    return res;
  };
  out.sort = specs('sort', 10);
  out.group = specs('group', 3);

  const strList = (key: 'hidden_fields' | 'field_order') => {
    const v = raw[key];
    if (v == null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      errors.push({ field: `config.${key}`, message: '必须是字段名数组' });
      return [];
    }
    return v as string[];
  };
  out.hidden_fields = strList('hidden_fields');
  out.field_order = strList('field_order');

  if (raw.field_widths != null) {
    if (!isObj(raw.field_widths) || Object.values(raw.field_widths).some((w) => typeof w !== 'number' || !Number.isFinite(w))) {
      errors.push({ field: 'config.field_widths', message: '必须是「字段名 → 宽度数字」对象' });
    }
  }
  if (raw.row_height != null && !ROW_HEIGHTS.includes(String(raw.row_height))) {
    errors.push({ field: 'config.row_height', message: '只能是 compact、standard、loose' });
  }
  if (raw.kanban_field != null && (typeof raw.kanban_field !== 'string' || !names.has(raw.kanban_field))) {
    errors.push({ field: 'config.kanban_field', message: `数据表里没有这个字段：${String(raw.kanban_field)}` });
  }
  if (raw.kanban_field === undefined) out.kanban_field = null;
  return errors.length > n0 ? undefined : out;
}

/** 输出时去掉已不存在的字段（隐藏字段、字段顺序、列宽）。 */
export function sanitizeViewConfig(cfg: Record<string, unknown>, fields: FieldMeta[]): Record<string, unknown> {
  const names = new Set(fields.map((f) => f.field_name));
  const out = { ...defaultViewConfig(), ...cfg };
  out.hidden_fields = (out.hidden_fields ?? []).filter((n) => names.has(n));
  out.field_order = (out.field_order ?? []).filter((n) => names.has(n));
  out.field_widths = Object.fromEntries(Object.entries(out.field_widths ?? {}).filter(([n]) => names.has(n)));
  return out;
}

/** 这个视图配置在哪些地方用到了字段（删除字段时给出 FIELD_IN_USE 提示）。 */
export function fieldUsages(cfg: Record<string, unknown>, fieldName: string): string[] {
  const c = { ...defaultViewConfig(), ...cfg } as ViewConfig;
  const out: string[] = [];
  if (c.filter?.conditions?.some((x) => x.field_name === fieldName)) out.push('筛选');
  if (c.sort?.some((x) => x.field_name === fieldName)) out.push('排序');
  if (c.group?.some((x) => x.field_name === fieldName)) out.push('分组');
  if (c.kanban_field === fieldName) out.push('看板分列');
  const cal = c.calendar;
  if (isObj(cal) && Object.values(cal).includes(fieldName)) out.push('日历');
  return out;
}

// ---------------- 计算 ----------------

function valueTokens(v: unknown): Set<string> {
  if (v == null) return new Set();
  if (typeof v === 'boolean') return new Set([String(v)]);
  if (Array.isArray(v)) {
    const s = new Set<string>();
    for (const e of v) {
      if (isObj(e)) {
        const id = userIdOf(e);
        s.add(id || String(e.name ?? e.text ?? ''));
      } else s.add(String(e));
    }
    s.delete('');
    return s;
  }
  if (isObj(v)) {
    const id = userIdOf(v);
    return new Set([id || fieldText(v)]);
  }
  const t = fieldText(v);
  return t ? new Set([t]) : new Set();
}

function userIdOf(m: Record<string, unknown>): string {
  return String(m.id ?? m.user_id ?? m.open_id ?? '');
}

function numOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 时区换算：本地「某天 0 点」对应的 UTC 毫秒。 */
export class Clock {
  constructor(
    readonly tzOffsetMinutes = 480,
    private readonly nowFn: () => number = Date.now,
  ) {}
  private get off() {
    return this.tzOffsetMinutes * 60_000;
  }
  now(): number {
    return this.nowFn();
  }
  /** ms 所在本地日的 0 点（UTC 毫秒）。 */
  dayStart(ms: number): number {
    const local = ms + this.off;
    return local - (((local % 86_400_000) + 86_400_000) % 86_400_000) - this.off;
  }
  sameDay(a: number, b: number): boolean {
    return this.dayStart(a) === this.dayStart(b);
  }
  /** 本地日期部件。 */
  parts(ms: number): { y: number; m: number; d: number; weekday: number; h: number; min: number } {
    const t = new Date(ms + this.off);
    return {
      y: t.getUTCFullYear(),
      m: t.getUTCMonth(),
      d: t.getUTCDate(),
      weekday: ((t.getUTCDay() + 6) % 7) + 1, // 周一 = 1
      h: t.getUTCHours(),
      min: t.getUTCMinutes(),
    };
  }
  monthStart(y: number, m: number): number {
    return Date.UTC(y, m, 1) - this.off;
  }
}

export function matchCondition(c: FilterCondition, fields: Record<string, unknown>, clock: Clock): boolean {
  const v = fields[c.field_name];
  const now = clock.now();
  const day = clock.dayStart(now);
  const inRange = (from: number, to: number) => typeof v === 'number' && v >= from && v < to;
  switch (c.operator) {
    case 'is_empty':
      return isEmptyValue(v);
    case 'is_not_empty':
      return !isEmptyValue(v);
    case 'contains':
    case 'not_contains': {
      const q = String(Array.isArray(c.value) ? c.value.join(' ') : (c.value ?? '')).trim().toLowerCase();
      if (!q) return true;
      const hit = fieldText(v).toLowerCase().includes(q) || [...valueTokens(v)].some((t) => t.toLowerCase().includes(q));
      return c.operator === 'contains' ? hit : !hit;
    }
    case 'is':
    case 'is_not': {
      const want = new Set(
        Array.isArray(c.value)
          ? c.value.map((e) => String(e))
          : c.value == null || String(c.value) === ''
            ? []
            : [String(c.value)],
      );
      if (want.size === 0) return true;
      let hit: boolean;
      if (typeof v === 'number' || (typeof v === 'string' && numOf(v) !== undefined)) {
        const a = numOf(v);
        hit = [...want].some((w) => numOf(w) === a);
        // 日期「等于」按天比较
        if (!hit && typeof v === 'number' && v > 100_000_000_000) {
          hit = [...want].some((w) => {
            const m = numOf(w);
            return m !== undefined && clock.sameDay(v, m);
          });
        }
      } else {
        const tokens = v == null ? new Set(['false']) : valueTokens(v);
        hit = [...tokens].some((t) => want.has(t)) || (!Array.isArray(v) && want.has(fieldText(v)));
      }
      return c.operator === 'is' ? hit : !hit;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = numOf(v);
      const b = numOf(Array.isArray(c.value) ? c.value[0] : c.value);
      if (b === undefined) return true;
      if (a === undefined) return false;
      return c.operator === 'gt' ? a > b : c.operator === 'gte' ? a >= b : c.operator === 'lt' ? a < b : a <= b;
    }
    case 'today':
      return inRange(day, day + 86_400_000);
    case 'this_week': {
      const start = day - (clock.parts(now).weekday - 1) * 86_400_000;
      return inRange(start, start + 7 * 86_400_000);
    }
    case 'last_7_days':
      return inRange(day - 6 * 86_400_000, day + 86_400_000);
    case 'this_month': {
      const p = clock.parts(now);
      return inRange(clock.monthStart(p.y, p.m), clock.monthStart(p.y, p.m + 1));
    }
  }
  return true;
}

export function matchFilter(cfg: ViewConfig, fields: Record<string, unknown>, clock: Clock, known?: Set<string>): boolean {
  // 引用了已不存在字段的条件不生效
  const cs = (cfg.filter?.conditions ?? []).filter((c) => !known || known.has(c.field_name));
  if (cs.length === 0) return true;
  return cfg.filter.conjunction === 'or'
    ? cs.some((c) => matchCondition(c, fields, clock))
    : cs.every((c) => matchCondition(c, fields, clock));
}

/** 与前端 compareValues 一致：空值最后；数字按数值；布尔 true 在前；其余按文字（码位）比较。 */
export function compareValues(a: unknown, b: unknown): number {
  const ea = isEmptyValue(a);
  const eb = isEmptyValue(b);
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  const na = numOf(a);
  const nb = numOf(b);
  if (na !== undefined && nb !== undefined) return na < nb ? -1 : na > nb ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? -1 : 1;
  const ta = fieldText(a);
  const tb = fieldText(b);
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

function compareRecords(specs: SortSpec[], a: StoredRecord, b: StoredRecord): number {
  for (const s of specs) {
    const va = a.fields[s.field_name];
    const vb = b.fields[s.field_name];
    const c = compareValues(va, vb);
    if (c !== 0) {
      if (isEmptyValue(va) !== isEmptyValue(vb)) return c; // 空值无论升降序都在最后
      return s.desc ? -c : c;
    }
  }
  return 0;
}

export function groupValue(v: unknown): string {
  return isEmptyValue(v) ? '' : fieldText(v);
}

/** 筛选 + 排序（分组字段优先），保持输入顺序作为稳定排序的兜底。 */
export function applyView(cfg: ViewConfig, records: StoredRecord[], clock: Clock, fields: FieldMeta[]): StoredRecord[] {
  const known = new Set(fields.map((f) => f.field_name));
  const list = records.filter((r) => matchFilter(cfg, r.fields, clock, known));
  const specs = [...(cfg.group ?? []), ...(cfg.sort ?? [])].filter((s) => known.has(s.field_name));
  if (specs.length) {
    const idx = new Map(list.map((r, i) => [r.record_id, i]));
    list.sort((a, b) => compareRecords(specs, a, b) || idx.get(a.record_id)! - idx.get(b.record_id)!);
  }
  return list;
}

export function groupPath(cfg: ViewConfig, r: StoredRecord, fields: FieldMeta[]): string[] {
  const known = new Set(fields.map((f) => f.field_name));
  return (cfg.group ?? []).filter((g) => known.has(g.field_name)).map((g) => groupValue(r.fields[g.field_name]));
}

/** 分组统计：每一层每个组一项（path 从第一层开始），按记录顺序。 */
export function groupCounts(cfg: ViewConfig, sorted: StoredRecord[], fields: FieldMeta[]): Array<{ path: string[]; count: number }> {
  const out = new Map<string, { path: string[]; count: number }>();
  for (const r of sorted) {
    const p = groupPath(cfg, r, fields);
    for (let depth = 1; depth <= p.length; depth++) {
      const path = p.slice(0, depth);
      const key = JSON.stringify(path);
      const g = out.get(key);
      if (g) g.count++;
      else out.set(key, { path, count: 1 });
    }
  }
  return [...out.values()];
}
