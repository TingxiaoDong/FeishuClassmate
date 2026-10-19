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
import type { ListOptions, ListResult, StoredRecord, TableStore } from './store.js';
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

/** 记录创建人 / 修改人（平台元数据列，ensureMetaColumns 时追加到每张业务表）。 */
const META_CREATED_BY = 'cos_created_by';
const META_UPDATED_BY = 'cos_updated_by';
const SKIP_COLUMNS = new Set(['record_id', 'created_at', 'updated_at', '__total', META_CREATED_BY, META_UPDATED_BY]);

export class PgTableStore implements TableStore {
  private readonly tableDefs: Map<string, TableDef>;
  private readonly fieldDefs = new Map<string, Map<string, FieldDef>>();
  /** ensureMetaColumns 成功后才写入创建人 / 修改人列。 */
  private metaColumns = false;

  constructor(
    private readonly pool: PgPoolLike,
    tableDefs: TableDef[] = ALL_TABLES,
  ) {
    this.tableDefs = new Map(tableDefs.map((t) => [t.key, t]));
    for (const t of tableDefs) {
      this.fieldDefs.set(t.key, new Map(t.fields.map((f) => [f.field_name, f])));
    }
  }

  /** 给每张业务表追加 cos_created_by / cos_updated_by 列（幂等）。 */
  async ensureMetaColumns(): Promise<void> {
    for (const key of this.tableDefs.keys()) {
      await this.pool.query(
        `ALTER TABLE ${q(key)} ADD COLUMN IF NOT EXISTS ${META_CREATED_BY} text, ADD COLUMN IF NOT EXISTS ${META_UPDATED_BY} text`,
      );
    }
    this.metaColumns = true;
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
      if (SKIP_COLUMNS.has(col)) continue;
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
    const ts = (v: unknown) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v));
    const rec: StoredRecord = {
      record_id: String(row.record_id),
      fields,
      created_at: ts(row.created_at),
      updated_at: ts(row.updated_at),
    };
    if (META_CREATED_BY in row) rec.created_by = (row[META_CREATED_BY] as string) ?? null;
    if (META_UPDATED_BY in row) rec.updated_by = (row[META_UPDATED_BY] as string) ?? null;
    return rec;
  }

  async list(tableKey: string, opts: ListOptions): Promise<ListResult> {
    const def = this.def(tableKey);
    const fdefs = this.fieldDefs.get(tableKey)!;
    const params: unknown[] = [];
    const where: string[] = [];
    for (const c of parseFilter(opts.filter)) {
      const type = fdefs.get(c.field)?.type;
      params.push(c.value);
      const p = `$${params.length}`;
      if (type === 2 && c.value !== '' && !Number.isNaN(Number(c.value))) {
        where.push(`${q(c.field)} ${c.op} ${p}::double precision`);
      } else if (type === 5 && c.value !== '' && !Number.isNaN(Number(c.value))) {
        where.push(`${q(c.field)} ${c.op} to_timestamp(${p}::double precision / 1000)`);
      } else {
        where.push(`${q(c.field)}::text ${c.op} ${p}`);
      }
    }
    const kw = opts.keyword?.trim();
    if (kw) {
      const textCols = def.fields.filter((f) => [1, 3, 15].includes(f.type)).map((f) => f.field_name);
      const arrCols = def.fields.filter((f) => f.type === 4).map((f) => f.field_name);
      if (textCols.length + arrCols.length > 0) {
        params.push(`%${kw.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
        const p = `$${params.length}`;
        const ors = [
          ...textCols.map((c) => `${q(c)} ILIKE ${p}`),
          ...arrCols.map((c) => `array_to_string(${q(c)}, ' ') ILIKE ${p}`),
        ];
        where.push(`(${ors.join(' OR ')})`);
      }
    }
    if (opts.confidentialFor && fdefs.has('visibility') && fdefs.has('owner_open_id')) {
      params.push(JSON.stringify([{ id: opts.confidentialFor }]));
      where.push(`("visibility" IS DISTINCT FROM '保密' OR "owner_open_id" @> $${params.length}::jsonb)`);
    }

    let orderBy = '';
    const sm = opts.sort?.match(/^([\p{L}\p{N}_]+)\s*(asc|desc)?$/iu);
    if (sm && (fdefs.has(sm[1]) || sm[1] === 'created_at' || sm[1] === 'updated_at')) {
      orderBy = ` ORDER BY ${q(sm[1])} ${sm[2]?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
    }

    const offset = opts.pageToken ? Number(opts.pageToken) || 0 : 0;
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    params.push(opts.pageSize + 1, offset);
    const { rows } = await this.pool.query(
      `SELECT *, count(*) OVER() AS __total FROM ${q(tableKey)}${whereSql}${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const hasMore = rows.length > opts.pageSize;
    const page = rows.slice(0, opts.pageSize);
    let total: number | undefined = rows.length > 0 ? Number(rows[0].__total ?? NaN) : undefined;
    if (total === undefined || Number.isNaN(total)) {
      if (rows.length === 0 && offset === 0) total = 0;
      else if (rows.length === 0) {
        const c = await this.pool.query(
          `SELECT count(*) AS n FROM ${q(tableKey)}${whereSql}`,
          params.slice(0, params.length - 2),
        );
        total = Number(c.rows[0]?.n ?? 0);
      } else total = undefined;
    }
    return {
      items: page.map((r) => this.fromRow(tableKey, r)),
      has_more: hasMore,
      page_token: hasMore ? String(offset + opts.pageSize) : undefined,
      total,
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

  async create(tableKey: string, fields: Record<string, unknown>, actor?: string): Promise<StoredRecord> {
    this.def(tableKey);
    const recordId = `rec_${randomUUID()}`;
    const names = Object.keys(fields);
    const cols = ['record_id', ...names];
    const params = [recordId, ...names.map((n) => this.toColumn(tableKey, n, fields[n]))];
    if (this.metaColumns && actor) {
      cols.push(META_CREATED_BY, META_UPDATED_BY);
      params.push(actor, actor);
    }
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
    actor?: string,
  ): Promise<StoredRecord | undefined> {
    this.def(tableKey);
    const names = Object.keys(fields);
    if (names.length === 0) return this.get(tableKey, recordId);
    const params = names.map((n) => this.toColumn(tableKey, n, fields[n]));
    let sets = names.map((n, i) => `${q(n)} = $${i + 1}`).join(', ');
    if (this.metaColumns && actor) {
      params.push(actor);
      sets += `, ${META_UPDATED_BY} = $${params.length}`;
    }
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
