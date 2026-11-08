/**
 * 名字（或 user_id）→ 同学。任务工具找人、确认卡片写「发给谁」都用它。
 * 原来在 tasks.ts 里，代码审查 A4 时挪出来给 define.ts 共用（tasks.ts 仍然导出同名函数）。
 */

import type { Call } from './define.js';

export interface PersonHit { user_id: string; name: string; department?: string | null }
export interface PeopleResolution {
  found: Record<string, PersonHit>;
  ambiguous: Record<string, PersonHit[]>;
  missing: string[];
}

/** 「我 / 自己 / 本人」这类指提问同学本人的词。 */
export const SELF_WORDS = /^(我|me|自己|本人)$/i;

/** 名字（或 user_id）→ 人。完全同名优先；同名多人算「有歧义」，交给模型问同学。 */
export async function resolvePeople(call: Call, names: string[]): Promise<PeopleResolution> {
  const out: PeopleResolution = { found: {}, ambiguous: {}, missing: [] };
  for (const raw of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
    const name = raw.replace(/^@/, '');
    if (SELF_WORDS.test(name)) {
      const me = await call<PersonHit>('GET', '/users/me');
      if (me.ok) { out.found[raw] = { user_id: me.data.user_id, name: me.data.name }; continue; }
    }
    const r = await call<{ items: PersonHit[] }>('GET', '/users', { query: { keyword: name, page_size: 20 } });
    const items = r.ok ? r.data.items : [];
    const exact = items.filter((u) => u.name === name || u.user_id === name);
    const pick = exact.length ? exact : items;
    if (pick.length === 1) out.found[raw] = { user_id: pick[0].user_id, name: pick[0].name, department: pick[0].department };
    else if (pick.length > 1) out.ambiguous[raw] = pick.slice(0, 5).map((u) => ({ user_id: u.user_id, name: u.name, department: u.department }));
    else out.missing.push(raw);
  }
  return out;
}
