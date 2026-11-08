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
import { canAccessRecord } from './row-access.js';
import { tableAccessOf } from './table-access.js';
import type { TableService } from './table-service.js';

export const BUILTIN_APPS = ['messages', 'calendar', 'bitable', 'docs', 'wiki', 'tasks', 'drive', 'contacts'] as const;
/** 内置应用 → 控制它是否显示的功能开关（没有列出的总是显示）。 */
const APP_FEATURE: Record<string, string> = { wiki: 'wiki' };
const TYPES = new Set(['table_view', 'wiki_space', 'doc']);
const KIND = 'workbench_shortcuts';
export const MAX_SHORTCUTS = 50;

export interface Shortcut { id: string; type: string; target_id: string; name: string; icon?: string; table_key?: string }

export type DashboardTemplate = 'number' | 'bar' | 'donut' | 'recent';
export interface DashboardConfig {
  id: string;
  title: string;
  table_key: string;
  field_name: string | null;
  template: DashboardTemplate;
  limit: number;
  created_at: string;
  updated_at: string;
}

const DASHBOARD_KIND = 'workbench_dashboards';
const DASHBOARD_MAX = 24;
const DASHBOARD_TEMPLATES = new Set<DashboardTemplate>(['number', 'bar', 'donut', 'recent']);

export function registerWorkbenchRoutes(ctx: Ctx, features: Record<string, boolean>, tableService?: TableService): void {
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

  const dashboardLoad = async (uid: string): Promise<DashboardConfig[]> => {
    const r = await repo.getEntity(DASHBOARD_KIND, uid);
    return Array.isArray(r?.data.items) ? (r!.data.items as DashboardConfig[]) : [];
  };

  const dashboardJson = (d: DashboardConfig) => ({ ...d });

  app.get('/api/v1/workbench/dashboards', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const configs = await dashboardLoad(me.sub);
    const tables = tableService ? await tableService.listAll() : [];
    const access = tableAccessOf(ctx);
    const available = [];
    for (const t of tables) {
      const flags = await access.flags(me, t.schema);
      if (flags.can_view && !t.schema.builtin) available.push({ key: t.schema.key, name: t.schema.name, fields: t.schema.fields.map((f) => ({ field_name: f.field_name, title: f.title, type: f.type, options: f.options ?? [] })) });
    }
    return { dashboards: configs.map(dashboardJson), tables: available };
  });

  app.put('/api/v1/workbench/dashboards', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    if (!tableService) return fail(reply, 503, '看板服务暂不可用');
    const raw = ((req.body ?? {}) as { dashboards?: unknown }).dashboards;
    if (!Array.isArray(raw) || raw.length > DASHBOARD_MAX) return invalid(reply, [{ field: 'dashboards', message: `最多 ${DASHBOARD_MAX} 个看板` }]);
    const access = tableAccessOf(ctx);
    const tables = await tableService.listAll();
    const byKey = new Map(tables.filter((t) => !t.schema.builtin).map((t) => [t.schema.key, t]));
    const old = new Set((await dashboardLoad(me.sub)).map((d) => d.id));
    const seen = new Set<string>();
    const errors: FieldError[] = [];
    const out: DashboardConfig[] = [];
    raw.forEach((v, i) => {
      const f = `dashboards[${i}]`;
      if (!v || typeof v !== 'object') { errors.push({ field: f, message: '必须是对象' }); return; }
      const x = v as Record<string, unknown>;
      const tableKey = typeof x.table_key === 'string' ? x.table_key : '';
      const table = byKey.get(tableKey);
      if (!table) { errors.push({ field: `${f}.table_key`, message: '只能选择可访问的自定义数据表' }); return; }
      const title = typeof x.title === 'string' ? x.title.trim() : '';
      const template = x.template as DashboardTemplate;
      const field = x.field_name == null ? null : String(x.field_name);
      if (!title || title.length > 60) errors.push({ field: `${f}.title`, message: '标题不能为空且不超过 60 字' });
      if (!DASHBOARD_TEMPLATES.has(template)) errors.push({ field: `${f}.template`, message: '模板不受支持' });
      if (field && !table.schema.fields.some((z) => z.field_name === field)) errors.push({ field: `${f}.field_name`, message: '字段不存在' });
      if (template !== 'number' && !field) errors.push({ field: `${f}.field_name`, message: '该模板需要选择字段' });
      const id = typeof x.id === 'string' && old.has(x.id) && !seen.has(x.id) ? x.id : newId('db');
      seen.add(id);
      const now = nowIso();
      out.push({ id, title, table_key: tableKey, field_name: field, template, limit: Math.min(20, Math.max(3, Number(x.limit) || 5)), created_at: now, updated_at: now });
    });
    if (errors.length) return invalid(reply, errors, errors[0].message);
    const now = nowIso();
    const cur = await repo.getEntity(DASHBOARD_KIND, me.sub);
    if (!(await repo.saveEntity({ kind: DASHBOARD_KIND, id: me.sub, scope: me.sub, data: { items: out }, version: cur?.version ?? 0, created_at: cur?.created_at ?? now, updated_at: now }, cur?.version ?? 0))) return fail(reply, 409, '看板配置已被修改，请重试', { code: 'CONFLICT' });
    return { dashboards: out.map(dashboardJson) };
  });

  app.get('/api/v1/workbench/dashboards/data', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me || !tableService) return;
    const configs = await dashboardLoad(me.sub);
    const access = tableAccessOf(ctx);
    const result = [];
    for (const d of configs) {
      const t = await tableService.load(d.table_key);
      if (!t || t.schema.builtin || !(await access.canView(me, t.schema))) continue;
      const all = (await tableService.scanAll(d.table_key)).filter((r) => canAccessRecord(me, t.def, r));
      const rows = all.slice(-d.limit).reverse();
      const counts: Record<string, number> = {};
      if (d.field_name) for (const r of all) {
        const raw = r.fields[d.field_name];
        const value = Array.isArray(raw) ? (raw.length ? raw.map(String).join('、') : '未设置') : String(raw ?? '未设置');
        counts[value] = (counts[value] ?? 0) + 1;
      }
      result.push({ ...d, total: all.length, values: counts, records: rows.map((r) => ({ record_id: r.record_id, fields: r.fields, created_at: r.created_at })) });
    }
    return { items: result };
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
