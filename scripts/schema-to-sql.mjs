#!/usr/bin/env node
/**
 * schema-to-sql — mechanically translate src/bitable/schema.ts (Feishu Bitable
 * field definitions) into PostgreSQL DDL for the ClassmateOS table engine
 * (PLAN §2.2 / P0 deliverable ⑤).
 *
 * Usage:
 *   node scripts/schema-to-sql.mjs            # print DDL to stdout
 *   node scripts/schema-to-sql.mjs -o out.sql # write to file
 *
 * Field type mapping (Bitable type number → Postgres):
 *    1 Text        → text
 *    2 Number      → double precision
 *    3 SingleSelect→ text (+ CHECK constraint against allowed options)
 *    4 MultiSelect → text[] (+ CHECK: every element in options)
 *    5 DateTime    → timestamptz   (Bitable stores ms epoch; we store real ts)
 *    7 Checkbox    → boolean
 *   11 User        → jsonb        (array of {id})
 *   15 Url         → text
 *   17 Attachment  → jsonb        (array of file refs)
 *   18 Link        → text         (foreign record id)
 *  unknown         → jsonb
 *
 * Every table additionally gets: record_id (PK), created_at, updated_at.
 * Chinese field names are preserved verbatim (quoted identifiers) — field
 * names are what tool callers pass as payload keys, same as in Bitable.
 */

import { ALL_TABLES } from '../src/bitable/schema.ts';
import { writeFileSync } from 'node:fs';

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

function sqlLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function optionsOf(field) {
  const opts = field.property?.options;
  if (!Array.isArray(opts)) return undefined;
  return opts.map((o) => o?.name).filter(Boolean);
}

function columnSql(field) {
  const name = q(field.field_name);
  switch (field.type) {
    case 1:
    case 15:
      return `${name} text`;
    case 2:
      return `${name} double precision`;
    case 3: {
      const opts = optionsOf(field);
      const base = `${name} text`;
      if (!opts || opts.length === 0) return base;
      const list = opts.map(sqlLiteral).join(', ');
      return `${base} CHECK (${name} IS NULL OR ${name} IN (${list}))`;
    }
    case 4: {
      const opts = optionsOf(field);
      const base = `${name} text[]`;
      if (!opts || opts.length === 0) return base;
      const list = opts.map(sqlLiteral).join(', ');
      return `${base} CHECK (${name} IS NULL OR ${name} <@ ARRAY[${list}]::text[])`;
    }
    case 5:
      return `${name} timestamptz`;
    case 7:
      return `${name} boolean`;
    case 11:
    case 17:
      return `${name} jsonb`;
    case 18:
      return `${name} text`;
    default:
      return `${name} jsonb`;
  }
}

function tableSql(def) {
  const fieldNames = new Set(def.fields.map((f) => f.field_name));
  const cols = [
    'record_id text PRIMARY KEY',
    ...def.fields.map(columnSql),
    // System columns — skipped when the Bitable schema already defines them.
    ...(fieldNames.has('created_at') ? [] : ['created_at timestamptz NOT NULL DEFAULT now()']),
    ...(fieldNames.has('updated_at') ? [] : ['updated_at timestamptz NOT NULL DEFAULT now()']),
  ];
  const comment = `\nCOMMENT ON TABLE ${q(def.key)} IS ${sqlLiteral(def.name)};`;
  return `CREATE TABLE IF NOT EXISTS ${q(def.key)} (\n  ${cols.join(',\n  ')}\n);${comment}`;
}

const header = `-- ClassmateOS core schema — generated from src/bitable/schema.ts
-- DO NOT EDIT BY HAND; regenerate with: node scripts/schema-to-sql.mjs
-- Tables: ${ALL_TABLES.length}
`;

const ddl = `${header}\nBEGIN;\n\n${ALL_TABLES.map(tableSql).join('\n\n')}\n\nCOMMIT;\n`;

const outIdx = process.argv.indexOf('-o');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  writeFileSync(process.argv[outIdx + 1], ddl);
  console.log(`wrote ${process.argv[outIdx + 1]} (${ALL_TABLES.length} tables)`);
} else {
  process.stdout.write(ddl);
}
