/**
 * 报表聚合测试：六张卡片的数据从表格引擎正确汇总。
 */

import { describe, expect, it } from 'vitest';
import { MemoryTableStore } from '../../classmateos/server/store.js';
import { buildDashboardSummary } from '../../classmateos/server/dashboard.js';
import { buildApp } from '../../classmateos/server/app.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 24 * 3600_000;

async function seededStore() {
  const store = new MemoryTableStore();
  await store.create('tool_trace', { tool_name: 'temi_speak', ok: true, started_at: NOW - DAY });
  await store.create('tool_trace', { tool_name: 'temi_speak', ok: true, started_at: NOW - 2 * DAY });
  await store.create('tool_trace', { tool_name: 'gantt_check', ok: false, started_at: NOW - DAY });
  await store.create('tool_trace', { tool_name: 'old_tool', ok: true, started_at: NOW - 30 * DAY }); // 超 7 天
  await store.create('projects', { title: 'A', status: '进行中' });
  await store.create('projects', { title: 'B', status: '完成' });
  await store.create('gantt', { milestone: 'M1', status: '进行中', due_date: NOW - DAY }); // 逾期
  await store.create('gantt', { milestone: 'M2', status: '完成', due_date: NOW - DAY }); // 完成不算逾期
  await store.create('gantt', { milestone: 'M3', status: '未开始', due_date: NOW + DAY });
  await store.create('equipment', { name: '示波器', state: '在库' });
  await store.create('equipment', { name: '焊台', state: '借出' });
  await store.create('submissions', { title: 'Paper1', status: '审稿中' });
  await store.create('failure_archive', { title: '导航翻车', date: NOW });
  return store;
}

describe('dashboard summary', () => {
  it('六卡聚合逻辑正确', async () => {
    const s = await buildDashboardSummary(await seededStore(), NOW);

    expect(s.tool_usage.total).toBe(3); // 近 7 天 3 条（old_tool 不算）
    expect(s.tool_usage.by_tool).toEqual({ temi_speak: 2, gantt_check: 1 });

    expect(s.tool_success.by_tool.temi_speak).toEqual({ ok: 2, total: 2, rate: 100 });
    expect(s.tool_success.by_tool.gantt_check).toEqual({ ok: 0, total: 1, rate: 0 });

    expect(s.projects_kpi.projects_total).toBe(2);
    expect(s.projects_kpi.projects_by_status).toEqual({ 进行中: 1, 完成: 1 });
    expect(s.projects_kpi.gantt_total).toBe(3);
    expect(s.projects_kpi.gantt_overdue).toBe(1);

    expect(s.equipment.by_state).toEqual({ 在库: 1, 借出: 1 });
    expect(s.submissions.by_status).toEqual({ 审稿中: 1 });
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0].fields.title).toBe('导航翻车');
  });

  it('空表/缺表不报错，卡片置空', async () => {
    const s = await buildDashboardSummary(new MemoryTableStore(), NOW);
    expect(s.tool_usage.total).toBe(0);
    expect(s.projects_kpi.projects_total).toBe(0);
    expect(s.failures).toHaveLength(0);
  });

  it('端点需要登录', async () => {
    const app = await buildApp({
      users: [{ user_id: 'u', name: 'a', password: 'p', role: 'admin' }],
      secret: 's',
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary' })).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'a', password: 'p' },
    });
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary',
      headers: { authorization: `Bearer ${login.json().access_token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().generated_at).toBeTruthy();
    await app.close();
  });
});
