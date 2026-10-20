/**
 * Agent 调用指标（AGENT_PLAN M5 §4 ToolTrace 落平台）。
 *
 *   POST /api/v1/bot/agent/metrics   大脑批量上报（纯 bot 令牌）：按「日期 + 工具」累加次数 / 成功 / 失败 / 耗时
 *   GET  /api/v1/agent/metrics       同学查看：今日调用、成功率、平均耗时、失败最多的工具、近 N 天趋势
 *
 * 只存工具名、成败、耗时和简短错误码，不存参数和返回内容——调用参数里可能有同学的保密数据，
 * 而指标是所有同学都能看的。日期按北京时间。
 */

import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { headerStr } from './agent-principal.js';
import { fail, invalid, type Ctx } from './context.js';
import { nowIso } from './repo.js';

const KIND = 'agent_metric';
const MAX_DAYS = 30;

export interface AgentMetricRow {
  date: string;
  tool: string;
  calls: number;
  ok: number;
  failed: number;
  total_ms: number;
  /** 错误码 → 次数（最多保留 10 种）。 */
  errors: Record<string, number>;
}

const item = z
  .object({
    tool: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/),
    ok: z.boolean(),
    duration_ms: z.number().min(0).max(3_600_000),
    error_code: z.string().max(40).regex(/^[A-Za-z0-9_.:-]*$/).optional(),
    at: z.number().int().positive().optional(),
  })
  .strict();
const batch = z.object({ items: z.array(item).min(1).max(500) }).strict();

/** 北京时间的日期 YYYY-MM-DD。 */
export function bjDate(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

export function registerAgentMetricsRoutes(ctx: Ctx, opts: { now?: () => number } = {}): void {
  const { app, repo } = ctx;
  const now = opts.now ?? Date.now;

  const pureBot = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!ctx.isBot(req) || headerStr(req, 'x-on-behalf-of')) {
      fail(reply, 401, '需要机器人身份');
      return false;
    }
    return true;
  };

  /** 把一组增量合并进某天某工具的汇总；版本冲突时重读再写。 */
  const merge = async (date: string, tool: string, add: Omit<AgentMetricRow, 'date' | 'tool'>): Promise<boolean> => {
    const id = `${date}|${tool}`;
    for (let i = 0; i < 5; i++) {
      const cur = await repo.getEntity(KIND, id);
      const prev = (cur?.data as AgentMetricRow | undefined) ?? { date, tool, calls: 0, ok: 0, failed: 0, total_ms: 0, errors: {} };
      const errors = { ...prev.errors };
      for (const [k, v] of Object.entries(add.errors)) {
        if (k in errors || Object.keys(errors).length < 10) errors[k] = (errors[k] ?? 0) + v;
      }
      const data: AgentMetricRow = {
        date,
        tool,
        calls: prev.calls + add.calls,
        ok: prev.ok + add.ok,
        failed: prev.failed + add.failed,
        total_ms: prev.total_ms + add.total_ms,
        errors,
      };
      const t = nowIso();
      const saved = await repo.saveEntity(
        { kind: KIND, id, scope: date, data: data as unknown as Record<string, unknown>, version: cur?.version ?? 0, created_at: cur?.created_at ?? t, updated_at: t },
        cur?.version ?? 0,
      );
      if (saved) return true;
    }
    return false;
  };

  app.post('/api/v1/bot/agent/metrics', async (req, reply) => {
    if (!pureBot(req, reply)) return reply;
    const p = batch.safeParse(req.body);
    if (!p.success) return invalid(reply, [{ field: 'items', message: '指标格式不合法' }]);
    const groups = new Map<string, Omit<AgentMetricRow, 'date' | 'tool'> & { date: string; tool: string }>();
    const today = now();
    for (const it of p.data.items) {
      // 不接受未来时间或 30 天前的数据，避免把历史改乱
      const at = it.at && it.at <= today + 60_000 && it.at >= today - MAX_DAYS * 86_400_000 ? it.at : today;
      const date = bjDate(at);
      const key = `${date}|${it.tool}`;
      const g = groups.get(key) ?? { date, tool: it.tool, calls: 0, ok: 0, failed: 0, total_ms: 0, errors: {} };
      g.calls += 1;
      if (it.ok) g.ok += 1;
      else {
        g.failed += 1;
        const code = it.error_code || 'ERROR';
        g.errors[code] = (g.errors[code] ?? 0) + 1;
      }
      g.total_ms += Math.round(it.duration_ms);
      groups.set(key, g);
    }
    let failedGroups = 0;
    for (const g of groups.values()) {
      const { date, tool, ...add } = g;
      if (!(await merge(date, tool, add))) failedGroups += 1;
    }
    if (failedGroups) return fail(reply, 409, '部分指标写入冲突，请重试', { code: 'CONFLICT' });
    return { ok: true, accepted: p.data.items.length };
  });

  app.get('/api/v1/agent/metrics', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = (req.query ?? {}) as { days?: string };
    const days = Math.min(MAX_DAYS, Math.max(1, Number.parseInt(q.days ?? '7', 10) || 7));
    const t = now();
    const dates = Array.from({ length: days }, (_, i) => bjDate(t - (days - 1 - i) * 86_400_000));
    const rows: AgentMetricRow[] = [];
    for (const d of dates) rows.push(...(await repo.listEntities(KIND, d)).map((r) => r.data as unknown as AgentMetricRow));
    const today = dates[dates.length - 1];
    const sum = (list: AgentMetricRow[]) => {
      const calls = list.reduce((a, r) => a + r.calls, 0);
      const ok = list.reduce((a, r) => a + r.ok, 0);
      const ms = list.reduce((a, r) => a + r.total_ms, 0);
      return { calls, ok, failed: calls - ok, success_rate: calls ? Math.round((ok / calls) * 1000) / 10 : null, avg_ms: calls ? Math.round(ms / calls) : null };
    };
    const todayRows = rows.filter((r) => r.date === today);
    const byTool = new Map<string, AgentMetricRow[]>();
    for (const r of rows) byTool.set(r.tool, [...(byTool.get(r.tool) ?? []), r]);
    const tools = [...byTool.entries()]
      .map(([tool, list]) => ({ tool, ...sum(list) }))
      .sort((a, b) => b.calls - a.calls);
    const isAdmin = me.user.role === 'admin' && !ctx.isBot(req);
    const topFailures = tools
      .filter((x) => x.failed > 0)
      .sort((a, b) => b.failed - a.failed)
      .slice(0, 5)
      .map((x) => {
        const errs: Record<string, number> = {};
        for (const r of byTool.get(x.tool) ?? []) for (const [k, v] of Object.entries(r.errors ?? {})) errs[k] = (errs[k] ?? 0) + v;
        // 错误码只给管理员看，普通同学只看到哪个工具失败多
        return { tool: x.tool, failed: x.failed, calls: x.calls, ...(isAdmin ? { errors: errs } : {}) };
      });
    return {
      days,
      today: { date: today, ...sum(todayRows) },
      range: sum(rows),
      daily: dates.map((d) => ({ date: d, ...sum(rows.filter((r) => r.date === d)) })),
      tools: tools.slice(0, 20),
      top_failures: topFailures,
      generated_at: new Date(t).toISOString(),
    };
  });
}
