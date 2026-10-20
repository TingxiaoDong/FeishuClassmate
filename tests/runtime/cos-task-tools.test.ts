/**
 * AGENT_PLAN M3：L1 任务型工具，经真实 HTTP 调内存版 ClassmateOS。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type PlatformUser } from '../../classmateos/server/app.js';
import { createBrain } from '../../src/runtime/brain.js';
import type { AgentRuntime, ToolCallContext } from '../../src/runtime/types.js';
import { fmtCn, freeSlots, parseDateCn, startOfDayCn } from '../../src/tools/cos/tasks.js';
import { createFakeConfig } from '../helpers/fake-config.js';

const USERS: PlatformUser[] = [
  { user_id: 'u_zhang', name: '张晓明', password: 'pw', role: 'member' },
  { user_id: 'u_li', name: '李华', password: 'pw', role: 'member' },
  { user_id: 'u_li2', name: '李华强', password: 'pw', role: 'member' },
  { user_id: 'u_wang1', name: '王芳', password: 'pw', role: 'member', department: '一组' } as PlatformUser,
  { user_id: 'u_wang2', name: '王芳', password: 'pw', role: 'member', department: '二组' } as PlatformUser,
];
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
type Ev = Record<string, any>;

let app: FastifyInstance;
let rt: AgentRuntime;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  app = await buildApp({ users: USERS, secret: 's', botToken: 'btok', notificationScanner: false });
  const addr = await app.listen({ port: 0, host: '127.0.0.1' });
  rt = createBrain({ config: createFakeConfig(), llm: { chat: async () => ({ content: '', toolCalls: [] }) }, logger: silent, telemetry: false, cos: { baseUrl: `${addr}/api/v1`, botToken: 'btok' } }).runtime;
  for (const u of ['u_zhang', 'u_li']) tokens[u] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json().access_token;
});
afterAll(async () => app.close());

let n = 0;
const ctx = (userId = 'u_zhang'): ToolCallContext => ({ toolCallId: `c${++n}`, sessionId: 's1', actor: { userId } });
const run = (tool: string, input: unknown, c = ctx()) => rt.getTool(tool)!.execute(input, c) as Promise<Ev>;
const as = (u: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${tokens[u]}` }, payload });

describe('时间工具（北京时间）', () => {
  it('解析日期文本', () => {
    expect(fmtCn(parseDateCn('2026-10-21')!)).toBe('2026-10-21 00:00');
    expect(fmtCn(parseDateCn('2026/10/21 14:30')!)).toBe('2026-10-21 14:30');
    expect(fmtCn(parseDateCn('2026年10月21日')!)).toBe('2026-10-21 00:00');
    expect(parseDateCn('下周')).toBeUndefined();
  });

  it('空闲时段：跳过周末、避开忙碌', () => {
    const mon = parseDateCn('2026-10-19')!; // 周一
    const busy = [{ start_ms: mon + 9 * 3.6e6, end_ms: mon + 11 * 3.6e6 }];
    const s = freeSlots(busy, mon, mon + 7 * 86_400_000, 60, { max: 50 });
    expect(fmtCn(s[0].start_ms)).toBe('2026-10-19 11:00');
    expect(s.every((x) => ![0, 6].includes(new Date(x.start_ms + 8 * 3.6e6).getUTCDay()))).toBe(true);
    expect(startOfDayCn(mon + 5 * 3.6e6)).toBe(mon);
  });
});

describe('L1 任务型工具', () => {
  it('全部注册', () => {
    const names = rt.listTools();
    for (const t of ['cos_find_people', 'cos_find_free_time', 'cos_schedule_meeting', 'cos_build_table', 'cos_table_add_rows', 'cos_table_stats', 'cos_write_doc', 'cos_assign_tasks', 'cos_daily_brief', 'cos_broadcast', 'cos_automation']) {
      expect(names).toContain(t);
    }
  });

  it('找人：完全同名优先，重名列候选', async () => {
    const r = await run('cos_find_people', { names: ['李华', '王芳', '赵六', '我'] });
    expect(r.data.found['李华'].user_id).toBe('u_li');
    expect(r.data.found['我'].user_id).toBe('u_zhang');
    expect(r.data.ambiguous['王芳']).toHaveLength(2);
    expect(r.data.missing).toEqual(['赵六']);
  });

  it('按列标题建表并填数据：人名、日期、数字、勾选自动转换', async () => {
    const r = await run('cos_build_table', {
      name: '器材借用登记',
      fields: [{ title: '器材' }, { title: '借用人', type: 'person' }, { title: '借出日期', type: 'date' }, { title: '数量', type: 'number' }, { title: '已归还', type: 'checkbox' }],
      rows: [
        { 器材: '示波器', 借用人: '李华', 借出日期: '2026-10-21', 数量: '2', 已归还: '否' },
        { 器材: '万用表', 借用人: '张晓明', 借出日期: '2026-10-22', 数量: 1, 已归还: '是' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.data.created).toBe(2);
    expect(r.data.problems).toEqual([]);
    const key = r.data.table_key;

    const add = await run('cos_table_add_rows', { table_key: key, rows: [{ 器材: '电源', 借用人: '王芳', 不存在的列: 'x' }] });
    expect(add.data.created).toBe(1);
    expect(add.data.problems.join()).toContain('不存在的列');
    expect(add.data.problems.join()).toContain('王芳');

    const st = await run('cos_table_stats', { table_key: key });
    expect(st.data.total).toBe(3);
    expect(st.data.stats['数量'].合计).toBe(3);
    expect(st.data.stats['已归还'].分布).toEqual({ 否: 2, 是: 1 });
  });

  it('超过 20 行的建表要确认', async () => {
    const pol = (rt.getTool('cos_build_table') as { policy?: any }).policy!;
    const rows = Array.from({ length: 21 }, (_, i) => ({ 名称: `x${i}` }));
    const input = { name: 't', fields: [{ title: '名称' }], rows };
    expect(pol.needsConfirm!(input, pol.risk!(input))).toBe(true);
  });

  it('约会议：冲突时不建，force 才建；无冲突时建并邀请', async () => {
    const day = startOfDayCn(Date.now()) + 3 * 86_400_000;
    const at = (h: number) => day + h * 3_600_000;
    await as('u_li', 'POST', '/calendar/events', { title: '李华私事', start_ms: at(10), end_ms: at(11) });
    const clash = await run('cos_schedule_meeting', { title: '组会', start_ms: at(10), end_ms: at(11), attendees: ['李华'] });
    expect(clash.code).toBe('TIME_CONFLICT');
    expect(clash.error).not.toContain('私事');

    const free = await run('cos_find_free_time', { people: ['李华'], from_ms: at(9), to_ms: at(18), duration_min: 60, include_weekends: true });
    expect(free.data.slots.length).toBeGreaterThan(0);
    expect(free.data.slots.some((s: Ev) => s.start_ms < at(11) && s.end_ms > at(10))).toBe(false);

    const ok = await run('cos_schedule_meeting', { title: '组会', start_ms: free.data.slots[0].start_ms, end_ms: free.data.slots[0].end_ms, attendees: ['李华'], location: '302' });
    expect(ok.ok).toBe(true);
    const liCal = (await as('u_li', 'GET', `/calendar/events?start_ms=${day}&end_ms=${day + 86_400_000}`)).json();
    expect(JSON.stringify(liCal)).toContain('组会');
  });

  it('批量派任务：有人名对不上就整体不派', async () => {
    const bad = await run('cos_assign_tasks', { tasks: [{ title: 'A', assignee: '李华' }, { title: 'B', assignee: '王芳' }] });
    expect(bad.code).toBe('PEOPLE_UNRESOLVED');
    const tasksBefore = (await as('u_li', 'GET', '/tasks?assignee_id=u_li')).json();
    expect(JSON.stringify(tasksBefore)).not.toContain('"A"');

    const ok = await run('cos_assign_tasks', { tasks: [{ title: '整理实验数据', assignee: '李华', due_ms: Date.now() + 86_400_000 }, { title: '写周报' }] });
    expect(ok.data.created).toHaveLength(2);
    expect(JSON.stringify((await as('u_li', 'GET', '/tasks?assignee_id=u_li')).json())).toContain('整理实验数据');
  });

  it('今日概览、写文档并私信分享', async () => {
    const brief = await run('cos_daily_brief', { range: 'week' }, ctx('u_li'));
    expect(brief.ok).toBe(true);
    expect(brief.data.open_task_count).toBeGreaterThan(0);

    const doc = await run('cos_write_doc', { title: '本周周报', markdown: '# 本周\n- 完成数据整理', share_to: '李华' });
    expect(doc.ok).toBe(true);
    expect(doc.data.shared[0]).toContain('已发给李华');
  });

  it('自动化：建、列、删（删除要确认）', async () => {
    const c = await run('cos_automation', { action: 'create', name: '派任务提醒', event: 'task.assigned', prompt: '有人给我派任务时提醒我' });
    expect(c.ok).toBe(true);
    const list = await run('cos_automation', { action: 'list' });
    expect(list.data.items).toHaveLength(1);
    const del = await run('cos_automation', { action: 'delete', trigger_id: c.data.trigger_id });
    expect(del.need_confirmation).toBe(true);
  });
});
