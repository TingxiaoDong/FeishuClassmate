/**
 * 行级权限（PLAN 灰度安全需求）：通用"保密记录"访问控制。
 *
 * 规则：若某 TableDef 同时满足
 *   - 存在 `visibility` 单选字段且选项含「保密」
 *   - 存在 `owner_open_id` 字段（User 类型，值形如 [{ id: 'ou_xxx' }]）
 * 则该表中 `fields.visibility === '保密'` 的记录仅对以下身份可见/可改：
 *   - 记录 owner（owner_open_id 数组中包含当前用户 user_id）
 *   - role === 'admin'
 * 其余成员：list 中过滤、get/patch/delete 一律 404（不泄露存在性）。
 */

import type { TableDef } from '../../src/bitable/schema.js';
import type { TokenPayload } from './auth.js';
import type { StoredRecord } from './store.js';

const CONFIDENTIAL = '保密';

/** 表是否启用行级保密规则。 */
export function hasRowAccessRule(def: TableDef): boolean {
  const vis = def.fields.find((f) => f.field_name === 'visibility');
  const owner = def.fields.find((f) => f.field_name === 'owner_open_id');
  if (!vis || !owner) return false;
  const options = vis.property?.options as Array<{ name: string }> | undefined;
  return Array.isArray(options) && options.some((o) => o.name === CONFIDENTIAL);
}

function ownerIds(record: StoredRecord): string[] {
  const raw = record.fields.owner_open_id;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : undefined))
    .filter((v): v is string => typeof v === 'string');
}

function isConfidential(record: StoredRecord): boolean {
  return record.fields.visibility === CONFIDENTIAL;
}

/** 当前用户是否可访问该记录。 */
export function canAccessRecord(user: TokenPayload, def: TableDef, record: StoredRecord): boolean {
  if (!hasRowAccessRule(def)) return true;
  if (!isConfidential(record)) return true;
  if (user.role === 'admin') return true;
  return ownerIds(record).includes(user.sub);
}

/** list 结果过滤（保持分页字段不变，仅剔除无权项）。 */
export function filterAccessible<T extends StoredRecord>(
  user: TokenPayload,
  def: TableDef,
  items: T[],
): T[] {
  return items.filter((r) => canAccessRecord(user, def, r));
}
