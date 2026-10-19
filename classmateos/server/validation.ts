/**
 * Record validation against the Bitable-derived table definitions
 * (src/bitable/schema.ts). 语义与飞书多维表格一致：
 *   - 1 Text / 15 Url          → string
 *   - 2 Number                 → number
 *   - 3 SingleSelect           → string ∈ options
 *   - 4 MultiSelect            → string[]，每项 ∈ options
 *   - 5 DateTime               → number (ms epoch)
 *   - 7 Checkbox               → boolean
 *   - 11 User / 17 Attachment  → array of objects
 *   - 18 Link                  → string
 * 未知字段拒绝。错误信息为中文（前端直接展示）。
 */

import type { FieldDef, TableDef } from '../../src/bitable/schema.js';

export interface ValidationError {
  field: string;
  message: string;
}

/** 迁移溯源字段（P4）：飞书源 record_id，允许写入但不在 schema.ts 中定义。 */
export const MIGRATION_META_FIELDS = new Set(['feishu_record_id']);

export function optionsOf(field: FieldDef): string[] | undefined {
  const opts = field.property?.options;
  if (!Array.isArray(opts)) return undefined;
  return opts.map((o) => (o as { name?: string })?.name).filter(Boolean) as string[];
}

export function validateRecordFields(
  table: TableDef,
  fields: Record<string, unknown>,
  opts: { partial?: boolean; required?: string[] } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const byName = new Map(table.fields.map((f) => [f.field_name, f]));

  for (const [name, value] of Object.entries(fields)) {
    if (MIGRATION_META_FIELDS.has(name)) {
      if (typeof value !== 'string') errors.push({ field: name, message: '必须是文本' });
      continue;
    }
    const def = byName.get(name);
    if (!def) {
      errors.push({ field: name, message: '数据表里没有这个字段' });
      continue;
    }
    if (value == null) continue; // null 表示清空字段（与 Bitable 一致）

    switch (def.type) {
      case 1:
        if (typeof value !== 'string') errors.push({ field: name, message: '必须是文本' });
        break;
      case 15:
        if (typeof value !== 'string') errors.push({ field: name, message: '必须是链接地址（文本）' });
        break;
      case 2:
        if (typeof value !== 'number' || !Number.isFinite(value)) errors.push({ field: name, message: '必须是数字' });
        break;
      case 5:
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push({ field: name, message: '必须是日期（毫秒时间戳）' });
        }
        break;
      case 3: {
        const options = optionsOf(def);
        if (typeof value !== 'string') {
          errors.push({ field: name, message: '必须是单个选项' });
        } else if (options && !options.includes(value)) {
          errors.push({ field: name, message: `必须是以下之一：${options.join('、')}` });
        }
        break;
      }
      case 4: {
        const options = optionsOf(def);
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          errors.push({ field: name, message: '必须是选项列表' });
        } else if (options) {
          const bad = (value as string[]).filter((v) => !options.includes(v));
          if (bad.length > 0) {
            errors.push({ field: name, message: `选项无效：${bad.join('、')}（可选：${options.join('、')}）` });
          }
        }
        break;
      }
      case 7:
        if (typeof value !== 'boolean') errors.push({ field: name, message: '必须是勾选（true / false）' });
        break;
      case 11:
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null)) {
          errors.push({ field: name, message: '必须是人员列表' });
        }
        break;
      case 17:
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null)) {
          errors.push({ field: name, message: '必须是附件列表' });
        }
        break;
      case 18:
        if (typeof value !== 'string') errors.push({ field: name, message: '必须是关联记录的 ID' });
        break;
      default:
        break; // 未映射类型宽松放行，与 Bitable 行为一致
    }
  }

  if (!opts.partial) {
    for (const r of opts.required ?? []) {
      const v = fields[r];
      if (v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)) {
        errors.push({ field: r, message: '必填' });
      }
    }
  }
  return errors;
}

/** 人员字段里的 user_id（兼容 id / user_id / open_id）。 */
export function personIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (!v || typeof v !== 'object') return undefined;
      const o = v as Record<string, unknown>;
      return o.id ?? o.user_id ?? o.open_id;
    })
    .filter((v): v is string => typeof v === 'string');
}

/** 附件字段里的 file_key（兼容 file_token）。 */
export function attachmentKeysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (!v || typeof v !== 'object') return undefined;
      const o = v as Record<string, unknown>;
      return o.file_key ?? o.file_token;
    })
    .filter((v): v is string => typeof v === 'string');
}
