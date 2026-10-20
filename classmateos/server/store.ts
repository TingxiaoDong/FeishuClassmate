/**
 * Table storage interface + in-memory implementation (P1 dev/test 默认).
 * PostgreSQL 实现（对接 classmateos/schema.sql）在 pg-store.ts。
 */

import { randomUUID } from 'node:crypto';
import type { TableDef } from '../../src/bitable/schema.js';

export interface StoredRecord {
  record_id: string;
  fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface ListResult {
  items: StoredRecord[];
  has_more: boolean;
  page_token?: string;
  /** 符合筛选条件（含保密过滤）的总数。 */
  total?: number;
}

export interface ListOptions {
  filter?: string;
  sort?: string;
  pageSize: number;
  pageToken?: string;
  /** 在所有文本类字段里模糊搜索。 */
  keyword?: string;
  /**
   * 保密记录过滤：给出 user_id 时，`visibility = 保密` 且负责人（owner_open_id）不含该用户的记录不返回。
   * 只对启用了行级保密规则的表、非管理员传入（见 row-access.ts）。
   */
  confidentialFor?: string;
}

export interface TableStore {
  /**
   * 注册一张运行时新建的数据表（自定义表）。幂等：PG 实现会 CREATE TABLE IF NOT EXISTS；
   * 内存实现无需处理。
   */
  registerTable?(def: TableDef): Promise<void>;
  /** 删除自定义表的物理表（只在建表登记失败回滚时用）。 */
  dropTable?(tableKey: string): Promise<void>;

  // ---- 字段管理（二期 R-BT-02）：def 是改动后的完整表定义 ----
  /** 只更新存储层持有的表定义（列类型转换用）。 */
  updateDef?(def: TableDef): Promise<void>;
  /** 新增字段对应的列（幂等）。 */
  addColumn?(def: TableDef, fieldName: string): Promise<void>;
  /** 删除字段：删列 / 清掉所有记录里的值。 */
  dropColumn?(def: TableDef, fieldName: string): Promise<void>;
  /** 改字段类型：列换成新类型，所有记录的该字段清空（之后由调用方用 writeValues 写回转换后的值）。 */
  retypeColumn?(def: TableDef, fieldName: string): Promise<void>;
  /** 去掉列上的选项约束（内置表改选项时）。 */
  relaxColumn?(def: TableDef, fieldName: string): Promise<void>;
  /** 直接写某个字段的值（null = 清空），不改 updated_at。 */
  writeValues?(tableKey: string, fieldName: string, entries: Array<{ record_id: string; value: unknown }>): Promise<void>;
  list(tableKey: string, opts: ListOptions): Promise<ListResult>;
  get(tableKey: string, recordId: string): Promise<StoredRecord | undefined>;
  create(tableKey: string, fields: Record<string, unknown>, actor?: string): Promise<StoredRecord>;
  update(
    tableKey: string,
    recordId: string,
    fields: Record<string, unknown>,
    actor?: string,
  ): Promise<StoredRecord | undefined>;
  delete(tableKey: string, recordId: string): Promise<boolean>;
}

/** 内存实现用的保密判断（与 row-access.ts 规则一致）。 */
export function visibleToUser(fields: Record<string, unknown>, userId: string): boolean {
  if (fields.visibility !== '保密') return true;
  const owners = Array.isArray(fields.owner_open_id) ? fields.owner_open_id : [];
  return owners.some((o) => o && typeof o === 'object' && (o as { id?: unknown }).id === userId);
}

function matchesKeyword(fields: Record<string, unknown>, keyword?: string): boolean {
  const kw = keyword?.trim().toLowerCase();
  if (!kw) return true;
  return Object.values(fields).some((v) => {
    if (typeof v === 'string') return v.toLowerCase().includes(kw);
    if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x.toLowerCase().includes(kw));
    return false;
  });
}

/**
 * 极简过滤表达式求值：`field="value"` / `field<50` / `field>3`，AND 连接。
 * 与 OpenAPI 草案的 filter 参数约定一致。
 */
export function matchesFilter(fields: Record<string, unknown>, filter?: string): boolean {
  if (!filter?.trim()) return true;
  const clauses = filter.split(/\s+AND\s+/i);
  for (const clause of clauses) {
    const m = clause.trim().match(/^([\p{L}\p{N}_]+)\s*(!=|<=|>=|=|<|>)\s*(.+)$/u);
    if (!m) return false; // 无法解析的子句视为不匹配（宁可少报不可错报）
    const [, field, op, rawVal] = m;
    const expected = rawVal.replace(/^"(.*)"$/, '$1');
    const actual = fields[field];
    const numActual = typeof actual === 'number' ? actual : Number(actual);
    const numExpected = Number(expected);
    const bothNumeric = !Number.isNaN(numActual) && !Number.isNaN(numExpected) && expected !== '';

    let ok: boolean;
    switch (op) {
      case '=':
        ok = bothNumeric ? numActual === numExpected : String(actual) === expected;
        break;
      case '!=':
        ok = bothNumeric ? numActual !== numExpected : String(actual) !== expected;
        break;
      case '<':
        ok = bothNumeric && numActual < numExpected;
        break;
      case '<=':
        ok = bothNumeric && numActual <= numExpected;
        break;
      case '>':
        ok = bothNumeric && numActual > numExpected;
        break;
      case '>=':
        ok = bothNumeric && numActual >= numExpected;
        break;
      default:
        ok = false;
    }
    if (!ok) return false;
  }
  return true;
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''), 'zh-Hans-CN');
}

export class MemoryTableStore implements TableStore {
  private readonly tables = new Map<string, Map<string, StoredRecord>>();

  /** 内存实现按需建表，注册无需处理。 */
  async registerTable(_def: TableDef): Promise<void> {}

  async dropTable(tableKey: string): Promise<void> {
    this.tables.delete(tableKey);
  }

  async updateDef(_def: TableDef): Promise<void> {}

  async addColumn(_def: TableDef, _fieldName: string): Promise<void> {}

  async relaxColumn(_def: TableDef, _fieldName: string): Promise<void> {}

  async dropColumn(def: TableDef, fieldName: string): Promise<void> {
    for (const r of this.table(def.key).values()) delete r.fields[fieldName];
  }

  async retypeColumn(def: TableDef, fieldName: string): Promise<void> {
    for (const r of this.table(def.key).values()) delete r.fields[fieldName];
  }

  async writeValues(tableKey: string, fieldName: string, entries: Array<{ record_id: string; value: unknown }>): Promise<void> {
    const t = this.table(tableKey);
    for (const e of entries) {
      const r = t.get(e.record_id);
      if (!r) continue;
      if (e.value == null) delete r.fields[fieldName];
      else r.fields[fieldName] = structuredClone(e.value);
    }
  }

  private table(key: string): Map<string, StoredRecord> {
    let t = this.tables.get(key);
    if (!t) {
      t = new Map();
      this.tables.set(key, t);
    }
    return t;
  }

  async list(tableKey: string, opts: ListOptions): Promise<ListResult> {
    let rows = [...this.table(tableKey).values()].filter(
      (r) =>
        matchesFilter(r.fields, opts.filter) &&
        matchesKeyword(r.fields, opts.keyword) &&
        (!opts.confidentialFor || visibleToUser(r.fields, opts.confidentialFor)),
    );

    if (opts.sort) {
      const m = opts.sort.match(/^([\p{L}\p{N}_]+)\s*(asc|desc)?$/iu);
      if (m) {
        const [, field, dir] = m;
        const sign = dir?.toLowerCase() === 'desc' ? -1 : 1;
        rows = rows.sort((a, b) => sign * compareValues(a.fields[field], b.fields[field]));
      }
    }

    const offset = opts.pageToken ? Number(opts.pageToken) || 0 : 0;
    const page = rows.slice(offset, offset + opts.pageSize);
    const next = offset + opts.pageSize;
    return {
      items: page,
      has_more: next < rows.length,
      page_token: next < rows.length ? String(next) : undefined,
      total: rows.length,
    };
  }

  async get(tableKey: string, recordId: string): Promise<StoredRecord | undefined> {
    // 返回副本：调用方拿着「修改前」的记录做比较（如实时事件判断公开→保密）时不会被后续 update 改掉
    const rec = this.table(tableKey).get(recordId);
    return rec ? { ...rec, fields: { ...rec.fields } } : undefined;
  }

  async create(tableKey: string, fields: Record<string, unknown>, actor?: string): Promise<StoredRecord> {
    const now = new Date().toISOString();
    const rec: StoredRecord = {
      record_id: `rec_${randomUUID()}`,
      fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null)),
      created_at: now,
      updated_at: now,
      created_by: actor ?? null,
      updated_by: actor ?? null,
    };
    this.table(tableKey).set(rec.record_id, rec);
    return rec;
  }

  async update(
    tableKey: string,
    recordId: string,
    fields: Record<string, unknown>,
    actor?: string,
  ): Promise<StoredRecord | undefined> {
    const t = this.table(tableKey);
    const rec = t.get(recordId);
    if (!rec) return undefined;
    // null 表示清空字段：从 fields 里去掉（与 PG 实现回读时省略 null 列一致）
    const merged = { ...rec.fields, ...fields };
    for (const [k, v] of Object.entries(merged)) if (v == null) delete merged[k];
    rec.fields = merged;
    rec.updated_at = new Date().toISOString();
    if (actor) rec.updated_by = actor;
    return rec;
  }

  async delete(tableKey: string, recordId: string): Promise<boolean> {
    return this.table(tableKey).delete(recordId);
  }
}
