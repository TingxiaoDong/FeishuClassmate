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
  /** 带 range 参数时返回实际统计区间（start_at 闭、end_at 开）。 */
  range?: { range: string; start_at: string; end_at: string };
}

export interface DashboardRange { range: string; start: number; end: number }

export class DashboardRangeError extends Error {}

/**
 * 解析报表时间范围（按本地时区 tzOffsetMinutes 切日）：
 *   week     本周一 0 点 ～ 下周一 0 点
 *   month    本月 1 日 0 点 ～ 下月 1 日 0 点
 *   semester 本学期：秋季学期 9/1 ～ 次年 2/1，春季学期 2/1 ～ 9/1；
 *            可用环境变量 COS_SEMESTER_START / COS_SEMESTER_END（YYYY-MM-DD，本地日期）固定
 *   custom   start_at ～ end_at（ISO，end_at 开区间），最长 400 天
 */
export function parseDashboardRange(
  q: { range?: string; start_at?: string; end_at?: string },
  now: number,
  tzOffsetMinutes = 480,
  env: Record<string, string | undefined> = process.env,
): DashboardRange | undefined {
  if (q.range === undefined || q.range === '') return undefined;
  const off = tzOffsetMinutes * 60_000;
  const localMidnight = (y: number, m: number, d: number) => Date.UTC(y, m, d) - off;
  const t = new Date(now + off);
  const y = t.getUTCFullYear(), m = t.getUTCMonth(), d = t.getUTCDate();
  switch (q.range) {
    case 'week': {
      const back = (t.getUTCDay() + 6) % 7; // 周一 = 0
      const start = localMidnight(y, m, d - back);
      return { range: 'week', start, end: start + 7 * DAY_MS };
    }
    case 'month':
      return { range: 'month', start: localMidnight(y, m, 1), end: localMidnight(y, m + 1, 1) };
    case 'semester': {
      const parseDay = (v?: string) => {
        const mm = v?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return mm ? localMidnight(Number(mm[1]), Number(mm[2]) - 1, Number(mm[3])) : undefined;
      };
      const fs = parseDay(env.COS_SEMESTER_START), fe = parseDay(env.COS_SEMESTER_END);
      if (fs !== undefined && fe !== undefined && fs < fe) return { range: 'semester', start: fs, end: fe + DAY_MS };
      if (m >= 8) return { range: 'semester', start: localMidnight(y, 8, 1), end: localMidnight(y + 1, 1, 1) };
      if (m === 0) return { range: 'semester', start: localMidnight(y - 1, 8, 1), end: localMidnight(y, 1, 1) };
      return { range: 'semester', start: localMidnight(y, 1, 1), end: localMidnight(y, 8, 1) };
    }
    case 'custom': {
      const start = Date.parse(q.start_at ?? ''), end = Date.parse(q.end_at ?? '');
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new DashboardRangeError('自定义范围需要 start_at 和 end_at（ISO 时间）');
      if (start >= end) throw new DashboardRangeError('start_at 必须早于 end_at');
      if (end - start > 400 * DAY_MS) throw new DashboardRangeError('自定义范围最长 400 天');
      return { range: 'custom', start, end };
    }
    default:
      throw new DashboardRangeError('range 只能是 week、month、semester、custom');
  }
}

/**
 * 不传 range：保持一期行为（调用量看近 7 天，成功率、失败归档看全部）。
 * 传 range：调用量、成功率、失败归档都只统计区间内的；项目、甘特、器材、投稿是当前状态快照，不按区间过滤。
 */
export async function buildDashboardSummary(store: TableStore, now = Date.now(), range?: DashboardRange): Promise<DashboardSummary> {
  const safeList = async (key: string, filter?: string) => {
    try {
      const res = await store.list(key, { filter, pageSize: 500 });
      return res.items;
    } catch {
      return []; // 表不存在（如未迁移）时该卡片置空，不影响其他卡片
    }
  };

  // tool_trace：started_at 为 ms 时间戳
  const inRange = (ms: number) => !!range && ms >= range.start && ms < range.end;
  const allTraces = await safeList('tool_trace');
  const traces = range ? allTraces.filter((r) => inRange(Number(r.fields.started_at ?? 0))) : allTraces;
  const weekAgo = now - 7 * DAY_MS;
  const recent = range ? traces : traces.filter((r) => Number(r.fields.started_at ?? 0) >= weekAgo);
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
    .filter((r) => !range || inRange(Date.parse(String(r.created_at))))
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
    ...(range ? { range: { range: range.range, start_at: new Date(range.start).toISOString(), end_at: new Date(range.end).toISOString() } } : {}),
  };
}
