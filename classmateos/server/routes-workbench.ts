/**
 * 工作台应用与个人快捷方式（迭代 5 R-WB-01，开关 workbench.apps）。
 *
 *   GET /workbench/apps       → {builtin: string[], shortcuts: Shortcut[]}
 *   PUT /workbench/shortcuts  → 整体覆盖，顺序即显示顺序；新项由后端分配 id
 *
 * builtin 按功能开关过滤（如 wiki 关闭时不返回 wiki）。快捷方式是个人的，
 * 存在通用实体表 workbench_shortcuts（id=用户 ID）。目标被删或没权限时照常返回，前端点开再提示。
 */
import type { Ctx } from './context.js';
import { fail, invalid, newId, type FieldError } from './context.js';
import { nowIso } from './repo.js';

export const BUILTIN_APPS = ['messages', 'calendar', 'bitable', 'docs', 'wiki', 'tasks', 'drive', 'contacts'] as const;
/** 内置应用 → 控制它是否显示的功能开关（没有列出的总是显示）。 */
const APP_FEATURE: Record<string, string> = { wiki: 'wiki' };
const TYPES = new Set(['table_view', 'wiki_space', 'doc']);
const KIND = 'workbench_shortcuts';
export const MAX_SHORTCUTS = 50;

export interface Shortcut { id: string; type: string; target_id: string; name: string; icon?: string; table_key?: string }

export function registerWorkbenchRoutes(ctx: Ctx, features: Record<string, boolean>): void {
  const { app, repo } = ctx;

  const load = async (uid: string): Promise<Shortcut[]> => {
    const r = await repo.getEntity(KIND, uid);
    return Array.isArray(r?.data.items) ? (r!.data.items as Shortcut[]) : [];
  };

  app.get('/api/v1/workbench/apps', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const builtin = BUILTIN_APPS.filter((k) => !APP_FEATURE[k] || features[APP_FEATURE[k]]);
    return { builtin, shortcuts: await load(me.sub) };
  });

  app.put('/api/v1/workbench/shortcuts', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const list = ((req.body ?? {}) as { shortcuts?: unknown }).shortcuts;
    const errors: FieldError[] = [];
    if (!Array.isArray(list)) return invalid(reply, [{ field: 'shortcuts', message: '必须是数组' }]);
    if (list.length > MAX_SHORTCUTS) return invalid(reply, [{ field: 'shortcuts', message: `最多 ${MAX_SHORTCUTS} 个快捷方式` }]);
    const old = new Set((await load(me.sub)).map((s) => s.id));
    const seen = new Set<string>();
    const out: Shortcut[] = [];
    list.forEach((raw, i) => {
      const f = `shortcuts[${i}]`;
      if (!raw || typeof raw !== 'object') { errors.push({ field: f, message: '必须是对象' }); return; }
      const s = raw as Record<string, unknown>;
      if (typeof s.type !== 'string' || !TYPES.has(s.type)) { errors.push({ field: `${f}.type`, message: '只能是 table_view、wiki_space、doc' }); return; }
      if (typeof s.target_id !== 'string' || !s.target_id) { errors.push({ field: `${f}.target_id`, message: '不能为空' }); return; }
      if (typeof s.name !== 'string' || !s.name.trim() || s.name.trim().length > 50) { errors.push({ field: `${f}.name`, message: '不能为空，且不超过 50 字' }); return; }
      if (s.icon !== undefined && s.icon !== null && (typeof s.icon !== 'string' || s.icon.length > 200)) { errors.push({ field: `${f}.icon`, message: '必须是字符串' }); return; }
      if (s.type === 'table_view' && (typeof s.table_key !== 'string' || !s.table_key)) { errors.push({ field: `${f}.table_key`, message: '视图快捷方式需要 table_key' }); return; }
      // 保留已有项的 id；新项或重复 id 由后端分配
      const id = typeof s.id === 'string' && old.has(s.id) && !seen.has(s.id) ? s.id : newId('sc');
      seen.add(id);
      out.push({
        id, type: s.type, target_id: s.target_id, name: s.name.trim(),
        ...(typeof s.icon === 'string' && s.icon ? { icon: s.icon } : {}),
        ...(s.type === 'table_view' ? { table_key: s.table_key as string } : {}),
      });
    });
    if (errors.length) return invalid(reply, errors, errors[0].message);
    const now = nowIso();
    for (let i = 0; i < 5; i++) {
      const cur = await repo.getEntity(KIND, me.sub);
      const ok = await repo.saveEntity({ kind: KIND, id: me.sub, scope: me.sub, data: { items: out }, version: cur?.version ?? 0, created_at: cur?.created_at ?? now, updated_at: now }, cur?.version ?? 0);
      if (ok) return { shortcuts: out };
    }
    return fail(reply, 409, '数据已被修改，请重试', { code: 'CONFLICT' });
  });
}
