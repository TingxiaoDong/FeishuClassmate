/**
 * 报表视图聚合（PLAN §2.2：吸收现有 dashboard/ 的六张卡片）。
 *
 * 数据源从飞书 Bitable 换成 ClassmateOS 表格引擎（TableStore），
 * 聚合逻辑与原 dashboard/index.html 的六卡一一对应：
 *   tool_usage      本周 Tool 调用量（tool_trace 近 7 天，按 tool_name）
 *   tool_success    Tool 成功率（tool_trace 总体，按 tool_name）
 *   projects_kpi    项目数 + 按状态分布；甘特节点数 + 逾期数
 *   equipment       器材按状态分布
 *   submissions     投稿管线按状态分布
 *   failures        近期失败归档（最新 5 条）
 */

import type { TableStore } from './store.js';

const DAY_MS = 24 * 3600_000;

function countBy<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it] = (out[it] ?? 0) + 1;
  return out;
}

export interface DashboardSummary {
  generated_at: string;
  tool_usage: { by_tool: Record<string, number>; total: number };
  tool_success: { by_tool: Record<string, { ok: number; total: number; rate: number }> };
  projects_kpi: {
    projects_total: number;
    projects_by_status: Record<string, number>;
    gantt_total: number;
    gantt_overdue: number;
  };
  equipment: { by_state: Record<string, number>; total: number };
  submissions: { by_status: Record<string, number>; total: number };
  failures: Array<{ record_id: string; fields: Record<string, unknown> }>;
}

export async function buildDashboardSummary(store: TableStore, now = Date.now()): Promise<DashboardSummary> {
  const safeList = async (key: string, filter?: string) => {
    try {
      const res = await store.list(key, { filter, pageSize: 500 });
      return res.items;
    } catch {
      return []; // 表不存在（如未迁移）时该卡片置空，不影响其他卡片
    }
  };

  // tool_trace：started_at 为 ms 时间戳
  const traces = await safeList('tool_trace');
  const weekAgo = now - 7 * DAY_MS;
  const recent = traces.filter((r) => Number(r.fields.started_at ?? 0) >= weekAgo);
  const toolNames = recent.map((r) => String(r.fields.tool_name ?? 'unknown'));

  const successByTool: Record<string, { ok: number; total: number; rate: number }> = {};
  for (const t of traces) {
    const name = String(t.fields.tool_name ?? 'unknown');
    const agg = (successByTool[name] ??= { ok: 0, total: 0, rate: 0 });
    agg.total += 1;
    if (t.fields.ok === true || t.fields.ok === 'true') agg.ok += 1;
  }
  for (const agg of Object.values(successByTool)) {
    agg.rate = agg.total > 0 ? Math.round((agg.ok / agg.total) * 1000) / 10 : 0;
  }

  const projects = await safeList('projects');
  const gantt = await safeList('gantt');
  const ganttOverdue = gantt.filter(
    (r) =>
      Number(r.fields.due_date ?? Infinity) < now &&
      String(r.fields.status ?? '') !== '完成',
  );

  const equipment = await safeList('equipment');
  const submissions = await safeList('submissions');
  const failures = (await safeList('failure_archive'))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 5)
    .map((r) => ({ record_id: r.record_id, fields: r.fields }));

  return {
    generated_at: new Date(now).toISOString(),
    tool_usage: { by_tool: countBy(toolNames), total: recent.length },
    tool_success: { by_tool: successByTool },
    projects_kpi: {
      projects_total: projects.length,
      projects_by_status: countBy(projects.map((r) => String(r.fields.status ?? '未设置'))),
      gantt_total: gantt.length,
      gantt_overdue: ganttOverdue.length,
    },
    equipment: {
      by_state: countBy(equipment.map((r) => String(r.fields.state ?? '未知'))),
      total: equipment.length,
    },
    submissions: {
      by_status: countBy(submissions.map((r) => String(r.fields.status ?? '未设置'))),
      total: submissions.length,
    },
    failures,
  };
}
