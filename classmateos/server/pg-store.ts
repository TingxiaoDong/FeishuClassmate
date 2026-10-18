/**
 * PgTableStore — PostgreSQL 存储实现（PLAN §2.2 表格引擎持久化），
 * 对接 scripts/schema-to-sql.mjs 生成的 DDL（classmateos/schema.sql）。
 *
 * 设计：
 *   - 依赖最小 Pool 接口（node-postgres 的 Pool 结构兼容），测试注入 fake；
 *   - 列类型规则与 DDL 一致：type 5 DateTime ↔ timestamptz（写入 ms→ISO，
 *     读出 →ms），type 11/17 ↔ jsonb（序列化），type 4 ↔ text[]；
 *   - filter 迷你表达式 → 参数化 WHERE（与 store.ts 的 matchesFilter 同语法）；
 *   - page_token = offset（与 MemoryTableStore 语义一致）。
 */

import { randomUUID } from 'node:crypto';
import { ALL_TABLES, type FieldDef, type TableDef } from '../../src/bitable/schema.js';
import type { ListResult, StoredRecord, TableStore } from './store.js';
import { MIGRATION_META_FIELDS } from './validation.js';

/** node-postgres Pool 的最小结构子集。 */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

interface FilterClause {
  field: string;
  op: '=' | '!=' | '<' | '<=' | '>' | '>=';
  value: string;
}

function parseFilter(filter?: string): FilterClause[] {
  if (!filter?.trim()) return [];
  const out: FilterClause[] = [];
  for (const clause of filter.split(/\s+AND\s+/i)) {
    const m = clause.trim().match(/^([\p{L}\p{N}_]+)\s*(=|!=|<|<=|>|>=)\s*(.+)$/u);
    if (!m) throw new Error(`unparseable filter clause: ${clause}`);
    out.push({
      field: m[1],
      op: m[2] as FilterClause['op'],
      value: m[3].replace(/^"(.*)"$/, '$1'),
    });
  }
  return out;
}

export class PgTableStore implements TableStore {
  private readonly tableDefs: Map<string, TableDef>;
  private readonly fieldDefs = new Map<string, Map<string, FieldDef>>();

  constructor(
    private readonly pool: PgPoolLike,
    tableDefs: TableDef[] = ALL_TABLES,
  ) {
    this.tableDefs = new Map(tableDefs.map((t) => [t.key, t]));
    for (const t of tableDefs) {
      this.fieldDefs.set(t.key, new Map(t.fields.map((f) => [f.field_name, f])));
    }
  }

  private def(tableKey: string): TableDef {
    const d = this.tableDefs.get(tableKey);
    if (!d) throw new Error(`unknown table: ${tableKey}`);
    return d;
  }

  /** JS 值 → 列值（按字段类型）。 */
  private toColumn(tableKey: string, name: string, value: unknown): unknown {
    const f = this.fieldDefs.get(tableKey)?.get(name);
    if (value == null) return null;
    if (MIGRATION_META_FIELDS.has(name)) return String(value);
    switch (f?.type) {
      case 5:
        return new Date(Number(value)).toISOString();
      case 11:
      case 17:
        return JSON.stringify(value);
      default:
        return value;
    }
  }

  /** 行 → StoredRecord（反序列化 + 收集非空业务字段）。 */
  private fromRow(tableKey: string, row: Record<string, unknown>): StoredRecord {
    const fields: Record<string, unknown> = {};
    const defs = this.fieldDefs.get(tableKey);
    for (const [col, raw] of Object.entries(row)) {
      if (['record_id', 'created_at', 'updated_at'].includes(col)) continue;
      if (raw == null) continue;
      const f = defs?.get(col);
      if (f?.type === 5) {
        fields[col] = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
      } else if ((f?.type === 11 || f?.type === 17) && typeof raw === 'string') {
        try {
          fields[col] = JSON.parse(raw);
        } catch {
          fields[col] = raw;
        }
      } else {
        fields[col] = raw;
      }
    }
    return {
      record_id: String(row.record_id),
      fields,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  async list(
    tableKey: string,
    opts: { filter?: string; sort?: string; pageSize: number; pageToken?: string },
  ): Promise<ListResult> {
    this.def(tableKey);
    const params: unknown[] = [];
    const where: string[] = [];
    for (const c of parseFilter(opts.filter)) {
      params.push(c.value);
      where.push(`${q(c.field)}::text ${c.op} $${params.length}`);
    }

    let orderBy = '';
    const sm = opts.sort?.match(/^([\p{L}\p{N}_]+)\s*(asc|desc)?$/iu);
    if (sm) orderBy = ` ORDER BY ${q(sm[1])} ${sm[2]?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;

    const offset = opts.pageToken ? Number(opts.pageToken) || 0 : 0;
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    params.push(opts.pageSize + 1, offset);
    const { rows } = await this.pool.query(
      `SELECT * FROM ${q(tableKey)}${whereSql}${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const hasMore = rows.length > opts.pageSize;
    const page = rows.slice(0, opts.pageSize);
    return {
      items: page.map((r) => this.fromRow(tableKey, r)),
      has_more: hasMore,
      page_token: hasMore ? String(offset + opts.pageSize) : undefined,
    };
  }

  async get(tableKey: string, recordId: string): Promise<StoredRecord | undefined> {
    this.def(tableKey);
    const { rows } = await this.pool.query(
      `SELECT * FROM ${q(tableKey)} WHERE record_id = $1`,
      [recordId],
    );
    return rows[0] ? this.fromRow(tableKey, rows[0]) : undefined;
  }

  async create(tableKey: string, fields: Record<string, unknown>): Promise<StoredRecord> {
    this.def(tableKey);
    const recordId = `rec_${randomUUID()}`;
    const names = Object.keys(fields);
    const cols = ['record_id', ...names];
    const params = [recordId, ...names.map((n) => this.toColumn(tableKey, n, fields[n]))];
    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.pool.query(
      `INSERT INTO ${q(tableKey)} (${cols.map(q).join(', ')}) VALUES (${placeholders}) RETURNING *`,
      params,
    );
    return this.fromRow(tableKey, rows[0]);
  }

  async update(
    tableKey: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<StoredRecord | undefined> {
    this.def(tableKey);
    const names = Object.keys(fields);
    if (names.length === 0) return this.get(tableKey, recordId);
    const params = names.map((n) => this.toColumn(tableKey, n, fields[n]));
    const sets = names.map((n, i) => `${q(n)} = $${i + 1}`).join(', ');
    params.push(recordId);
    const { rows } = await this.pool.query(
      `UPDATE ${q(tableKey)} SET ${sets}, updated_at = now() WHERE record_id = $${params.length} RETURNING *`,
      params,
    );
    return rows[0] ? this.fromRow(tableKey, rows[0]) : undefined;
  }

  async delete(tableKey: string, recordId: string): Promise<boolean> {
    this.def(tableKey);
    const { rows } = await this.pool.query(
      `DELETE FROM ${q(tableKey)} WHERE record_id = $1 RETURNING record_id`,
      [recordId],
    );
    return rows.length > 0;
  }
}
