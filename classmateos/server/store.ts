/**
 * Table storage interface + in-memory implementation (P1 dev/test 默认).
 * PostgreSQL 实现（对接 classmateos/schema.sql）在 pg-store.ts。
 */

import { randomUUID } from 'node:crypto';

export interface StoredRecord {
  record_id: string;
  fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ListResult {
  items: StoredRecord[];
  has_more: boolean;
  page_token?: string;
}

export interface TableStore {
  list(
    tableKey: string,
    opts: { filter?: string; sort?: string; pageSize: number; pageToken?: string },
  ): Promise<ListResult>;
  get(tableKey: string, recordId: string): Promise<StoredRecord | undefined>;
  create(tableKey: string, fields: Record<string, unknown>): Promise<StoredRecord>;
  update(tableKey: string, recordId: string, fields: Record<string, unknown>): Promise<StoredRecord | undefined>;
  delete(tableKey: string, recordId: string): Promise<boolean>;
}

/**
 * 极简过滤表达式求值：`field="value"` / `field<50` / `field>3`，AND 连接。
 * 与 OpenAPI 草案的 filter 参数约定一致。
 */
export function matchesFilter(fields: Record<string, unknown>, filter?: string): boolean {
  if (!filter?.trim()) return true;
  const clauses = filter.split(/\s+AND\s+/i);
  for (const clause of clauses) {
    const m = clause.trim().match(/^([\p{L}\p{N}_]+)\s*(=|!=|<|<=|>|>=)\s*(.+)$/u);
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

  private table(key: string): Map<string, StoredRecord> {
    let t = this.tables.get(key);
    if (!t) {
      t = new Map();
      this.tables.set(key, t);
    }
    return t;
  }

  async list(
    tableKey: string,
    opts: { filter?: string; sort?: string; pageSize: number; pageToken?: string },
  ): Promise<ListResult> {
    let rows = [...this.table(tableKey).values()].filter((r) => matchesFilter(r.fields, opts.filter));

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
    };
  }

  async get(tableKey: string, recordId: string): Promise<StoredRecord | undefined> {
    return this.table(tableKey).get(recordId);
  }

  async create(tableKey: string, fields: Record<string, unknown>): Promise<StoredRecord> {
    const now = new Date().toISOString();
    const rec: StoredRecord = {
      record_id: `rec_${randomUUID()}`,
      fields,
      created_at: now,
      updated_at: now,
    };
    this.table(tableKey).set(rec.record_id, rec);
    return rec;
  }

  async update(
    tableKey: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<StoredRecord | undefined> {
    const t = this.table(tableKey);
    const rec = t.get(recordId);
    if (!rec) return undefined;
    rec.fields = { ...rec.fields, ...fields };
    rec.updated_at = new Date().toISOString();
    return rec;
  }

  async delete(tableKey: string, recordId: string): Promise<boolean> {
    return this.table(tableKey).delete(recordId);
  }
}
