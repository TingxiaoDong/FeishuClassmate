/**
 * Record validation against the Bitable-derived table definitions
 * (src/bitable/schema.ts). The ClassmateOS table engine must enforce the
 * same semantics the agent relies on in Feishu (PLAN §2.2 表格引擎):
 *   - 1 Text / 15 Url          → string
 *   - 2 Number                 → number
 *   - 3 SingleSelect           → string ∈ options
 *   - 4 MultiSelect            → string[]，每项 ∈ options
 *   - 5 DateTime               → number (ms epoch)
 *   - 7 Checkbox               → boolean
 *   - 11 User / 17 Attachment  → array of objects
 *   - 18 Link                  → string
 * Unknown fields are rejected (same as Bitable).
 */

import type { FieldDef, TableDef } from '../../src/bitable/schema.js';

export interface ValidationError {
  field: string;
  message: string;
}

function optionsOf(field: FieldDef): string[] | undefined {
  const opts = field.property?.options;
  if (!Array.isArray(opts)) return undefined;
  return opts.map((o) => (o as { name?: string })?.name).filter(Boolean) as string[];
}

export function validateRecordFields(
  table: TableDef,
  fields: Record<string, unknown>,
  opts: { partial?: boolean } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const byName = new Map(table.fields.map((f) => [f.field_name, f]));

  for (const [name, value] of Object.entries(fields)) {
    const def = byName.get(name);
    if (!def) {
      errors.push({ field: name, message: `unknown field for table ${table.key}` });
      continue;
    }
    if (value == null) continue; // null clears a field (Bitable semantics)

    switch (def.type) {
      case 1:
      case 15:
        if (typeof value !== 'string') errors.push({ field: name, message: 'expected string' });
        break;
      case 2:
      case 5:
        if (typeof value !== 'number') errors.push({ field: name, message: 'expected number (ms epoch for dates)' });
        break;
      case 3: {
        const opts = optionsOf(def);
        if (typeof value !== 'string') {
          errors.push({ field: name, message: 'expected string (SingleSelect)' });
        } else if (opts && !opts.includes(value)) {
          errors.push({ field: name, message: `must be one of: ${opts.join(', ')}` });
        }
        break;
      }
      case 4: {
        const opts = optionsOf(def);
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          errors.push({ field: name, message: 'expected string[] (MultiSelect)' });
        } else if (opts) {
          const bad = (value as string[]).filter((v) => !opts.includes(v));
          if (bad.length > 0) errors.push({ field: name, message: `invalid options: ${bad.join(', ')}` });
        }
        break;
      }
      case 7:
        if (typeof value !== 'boolean') errors.push({ field: name, message: 'expected boolean' });
        break;
      case 11:
      case 17:
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null)) {
          errors.push({ field: name, message: 'expected array of objects' });
        }
        break;
      case 18:
        if (typeof value !== 'string') errors.push({ field: name, message: 'expected string (linked record id)' });
        break;
      default:
        break; // 未映射类型宽松放行，与 Bitable 行为一致
    }
  }

  void opts; // partial 语义保留：当前 create/update 都只校验传入字段
  return errors;
}
