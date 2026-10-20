/**
 * 二期迭代 3：重复日程（R-CA-01）、任务扩展（R-TK-01 ~ 05）。
 * 对照《二期迭代3_前端接口需求与进度.md》第 3、4、5 节。
 * 设置 CLASSMATEOS_TEST_PG_URL 时同时在 PostgreSQL 上跑（会清空该库）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import { expandInWindow, parseRRule, truncateRule } from '../../classmateos/server/rrule.js';
import type { BotEvent } from '../../classmateos/server/events.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
let pool: pg.Pool | undefined;
afterAll(async () => { await pool?.end(); });
const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];

const H = 3600_000;
const D = 24 * H;
/** 北京时间 2026-10-19（周一）09:00 */
const MON9 = Date.UTC(2026, 9, 19, 1, 0);

describe('rrule 展开（北京时间）', () => {
  const off = 480;
  it('每周一：本地 9 点不漂移；COUNT / UNTIL（含当天）', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO;COUNT=3', off);
    expect(expandInWindow(r, MON9, H, off, MON9, MON9 + 60 * D)).toEqual([MON9, MON9 + 7 * D, MON9 + 14 * D]);
    const u = parseRRule('FREQ=DAILY;UNTIL=20261021', off);
    expect(expandInWindow(u, MON9, H, off, MON9, MON9 + 10 * D)).toHaveLength(3);
  });
  it('工作日、每两周、每月 31 日跳过小月、每月第 5 个周五不存在时跳过', () => {
    const wk = parseRRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', off);
    expect(expandInWindow(wk, MON9, H, off, MON9, MON9 + 7 * D)).toHaveLength(5);
    const bi = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', off);
    expect(expandInWindow(bi, MON9, H, off, MON9, MON9 + 28 * D)).toEqual([MON9, MON9 + 14 * D]);
    const oct31 = Date.UTC(2026, 9, 31, 1, 0);
    const m31 = parseRRule('FREQ=MONTHLY;BYMONTHDAY=31', off);
    const got = expandInWindow(m31, oct31, H, off, oct31, Date.UTC(2027, 3, 1)).map((t) => new Date(t + 8 * H).toISOString().slice(0, 10));
    expect(got).toEqual(['2026-10-31', '2026-12-31', '2027-01-31', '2027-03-31']);
    const fri5 = parseRRule('FREQ=MONTHLY;BYDAY=5FR', off);
    const oct30 = Date.UTC(2026, 9, 30, 1, 0); // 10 月第 5 个周五
    const f = expandInWindow(fri5, oct30, H, off, oct30, Date.UTC(2027, 1, 1)).map((t) => new Date(t + 8 * H).toISOString().slice(0, 10));
    expect(f).toEqual(['2026-10-30', '2027-01-29']);
  });
  it('不支持的写法给中文错误；截断规则保留其他部分', () => {
    expect(() => parseRRule('FREQ=HOURLY', off)).toThrow(/FREQ/);
    expect(() => parseRRule('FREQ=DAILY;COUNT=2;UNTIL=20261030', off)).toThrow(/COUNT 和 UNTIL/);
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO;COUNT=10', off);
    expect(truncateRule('FREQ=WEEKLY;BYDAY=MO;COUNT=10', r, MON9, off, MON9 + 14 * D)).toBe('FREQ=WEEKLY;BYDAY=MO;COUNT=2');
  });
});

describe.each(backends)('二期迭代 3（$name）', ({ usePg }) => {
  async function makeApp(reset = true) {
    const o: AppOptions = {
      secret: 's', notificationScanner: false,
      users: [
        { user_id: 'ou_admin', name: '王老师', password: 'pw', role: 'admin' },
        { user_id: 'ou_li', name: '李同学', password: 'pw', role: 'member' },
        { user_id: 'ou_zhang', name: '张晓明', password: 'pw', role: 'member' },
        { user_id: 'ou_out', name: '外人', password: 'pw', role: 'member' },
      ],
    };
    if (usePg) {
      pool ??= new pg.Pool({ connectionString: PG_URL, max: 5 });
      if (reset) {
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        await pool.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
        await new PgRepo(pool).init();
      }
      const st = new PgTableStore(pool);
      await st.ensureMetaColumns();
      o.repo = new PgRepo(pool);
      o.store = st;
    }
    const app = await buildApp(o);
    const tokens: Record<string, string> = {};
    const call = async (u: string, method: string, url: string, payload?: unknown) => {
      tokens[u] ??= (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json().access_token;
      return app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${tokens[u]}` }, payload: payload as Record<string, unknown> });
    };
    const events: BotEvent[] = [];
    (app as unknown as { cos: { ctx: { eventBus: { subscribe(fn: (e: BotEvent) => void): void } } } }).cos.ctx.eventBus.subscribe((e) => events.push(e));
    return { app, call, events };
  }

  it('功能开关：task.* 和重复日程打开，审批关闭', async () => {
    const { app } = await makeApp();
    try {
      const f = (await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json().features;
      for (const k of ['task.subtasks', 'task.followers', 'task.comments', 'task.lists']) expect(f[k]).toBe(true);
      expect(f.approval).toBe(false);
      expect(f['calendar.recurrence']).toBe(true);
    } finally { await app.close(); }
  });

  it('重复日程：展开、仅此一次、此后全部、删除，参数兼容 from/to，重启后仍在', async () => {
    let { app, call } = await makeApp();
    let seriesId = '';
    const win = `start_ms=${MON9 - D}&end_ms=${MON9 + 35 * D}`;
    try {
      // 规则错误 422
      expect((await call('ou_admin', 'POST', '/calendar/events', { title: 'x', start_ms: MON9, end_ms: MON9 + H, recurrence: 'FREQ=SECONDLY' })).statusCode).toBe(422);
      const c = await call('ou_admin', 'POST', '/calendar/events', { title: '组会', start_ms: MON9, end_ms: MON9 + H, attendee_ids: ['ou_li'], recurrence: 'FREQ=WEEKLY;BYDAY=MO' });
      expect(c.statusCode).toBe(201);
      seriesId = c.json().event_id;
      expect(c.json()).toMatchObject({ recurrence: 'FREQ=WEEKLY;BYDAY=MO', recurring_event_id: seriesId, is_exception: false });
      let items = (await call('ou_li', 'GET', `/calendar/events?${win}`)).json().items;
      expect(items.map((e: any) => e.start_ms)).toEqual([0, 7, 14, 21, 28].map((d) => MON9 + d * D));
      expect(items[1]).toMatchObject({ recurring_event_id: seriesId, original_start_ms: MON9 + 7 * D, recurrence: 'FREQ=WEEKLY;BYDAY=MO' });
      // 一期参数仍然可用
      expect((await call('ou_li', 'GET', `/calendar/events?from=${MON9 - D}&to=${MON9 + 35 * D}`)).json().items).toHaveLength(5);
      // 外人看不到，参与人不能改
      expect((await call('ou_out', 'GET', `/calendar/events/${items[1].event_id}`)).statusCode).toBe(404);
      expect((await call('ou_li', 'PATCH', `/calendar/events/${items[1].event_id}?scope=all`, { title: '改' })).statusCode).toBe(403);
      // 仅此一次：第 2 次推迟 2 小时
      expect((await call('ou_admin', 'PATCH', `/calendar/events/${items[1].event_id}?scope=this`, { recurrence: 'FREQ=DAILY' })).statusCode).toBe(422);
      const ex = await call('ou_admin', 'PATCH', `/calendar/events/${items[1].event_id}?scope=this`, { start_ms: MON9 + 7 * D + 2 * H, end_ms: MON9 + 7 * D + 3 * H, title: '组会（改时间）' });
      expect(ex.statusCode).toBe(200);
      expect(ex.json()).toMatchObject({ is_exception: true, original_start_ms: MON9 + 7 * D, recurring_event_id: seriesId, title: '组会（改时间）' });
      // 仅删第 3 次
      expect((await call('ou_admin', 'DELETE', `/calendar/events/${items[2].event_id}?scope=this`)).statusCode).toBe(204);
      items = (await call('ou_admin', 'GET', `/calendar/events?${win}`)).json().items;
      expect(items.map((e: any) => [e.start_ms, e.title])).toEqual([
        [MON9, '组会'], [MON9 + 7 * D + 2 * H, '组会（改时间）'], [MON9 + 21 * D, '组会'], [MON9 + 28 * D, '组会'],
      ]);
      // 此后全部：从第 4 次起改名，拆成新系列
      const tail = await call('ou_admin', 'PATCH', `/calendar/events/${items[2].event_id}?scope=following`, { title: '新学期组会' });
      expect(tail.statusCode).toBe(200);
      expect(tail.json().recurring_event_id).not.toBe(seriesId);
      items = (await call('ou_admin', 'GET', `/calendar/events?${win}`)).json().items;
      expect(items.map((e: any) => e.title)).toEqual(['组会', '组会（改时间）', '新学期组会', '新学期组会']);
      // 全部：整体改地点，例外也同步
      await call('ou_admin', 'PATCH', `/calendar/events/${seriesId}?scope=all`, { location: 'B302' });
      items = (await call('ou_admin', 'GET', `/calendar/events?${win}`)).json().items;
      expect(items.slice(0, 2).map((e: any) => e.location)).toEqual(['B302', 'B302']);
      // 参与人回复写在系列上
      expect((await call('ou_li', 'POST', `/calendar/events/${items[0].event_id}/rsvp`, { rsvp: 'accepted' })).json().attendees.find((a: any) => a.user_id === 'ou_li').rsvp).toBe('accepted');
      // 删除新系列（此后全部 = 第一次时等于全部）
      expect((await call('ou_admin', 'DELETE', `/calendar/events/${items[2].event_id}?scope=following`)).statusCode).toBe(204);
      expect((await call('ou_admin', 'GET', `/calendar/events?${win}`)).json().items).toHaveLength(2);
    } finally { await app.close(); }
    if (usePg) {
      ({ app, call } = await makeApp(false));
      try {
        const items = (await call('ou_admin', 'GET', `/calendar/events?${win}`)).json().items;
        expect(items.map((e: any) => e.title)).toEqual(['组会', '组会（改时间）']);
      } finally { await app.close(); }
    }
    ({ app, call } = await makeApp(!usePg));
    try {
      // 取消重复：只保留正在编辑的这一次
      const c = (await call('ou_admin', 'POST', '/calendar/events', { title: '晨跑', start_ms: MON9, end_ms: MON9 + H, recurrence: 'FREQ=DAILY;COUNT=5' })).json();
      const list = (await call('ou_admin', 'GET', `/calendar/events?start_ms=${MON9 + 2 * D}&end_ms=${MON9 + 3 * D}`)).json().items.filter((e: any) => e.title === '晨跑');
      const one = await call('ou_admin', 'PATCH', `/calendar/events/${list[0].event_id}?scope=all`, { recurrence: null });
      expect(one.json()).toMatchObject({ recurrence: null, start_ms: MON9 + 2 * D, event_id: c.event_id });
      expect((await call('ou_admin', 'GET', `/calendar/events?${win}`)).json().items.filter((e: any) => e.title === '晨跑')).toHaveLength(1);
      expect((await call('ou_admin', 'DELETE', `/calendar/events/${c.event_id}?scope=all`)).statusCode).toBe(204);
    } finally { await app.close(); }
  });

  it('子任务：3 层上限、只返回顶层、进度、排序、删父任务连子任务一起删', async () => {
    const { app, call, events } = await makeApp();
    try {
      const root = (await call('ou_admin', 'POST', '/tasks', { title: '机械臂抓取', assignee_id: 'ou_li' })).json();
      expect(root).toMatchObject({ depth: 1, parent_id: null, subtask_count: 0, permissions: { can_edit: true, can_delete: true } });
      const a = (await call('ou_li', 'POST', '/tasks', { title: '标定', parent_id: root.task_id })).json();
      const b = (await call('ou_admin', 'POST', '/tasks', { title: '抓取测试', parent_id: root.task_id })).json();
      expect(a.depth).toBe(2);
      const a1 = (await call('ou_admin', 'POST', '/tasks', { title: '相机内参', parent_id: a.task_id })).json();
      expect(a1.depth).toBe(3);
      const deep = await call('ou_admin', 'POST', '/tasks', { title: '太深', parent_id: a1.task_id });
      expect(deep.statusCode).toBe(422);
      expect(deep.json().code).toBe('TASK_DEPTH_EXCEEDED');
      // 外人不能加子任务
      expect((await call('ou_out', 'POST', '/tasks', { title: 'x', parent_id: root.task_id })).statusCode).toBe(404);
      // 列表只有顶层
      expect((await call('ou_admin', 'GET', '/tasks')).json().items.map((t: any) => t.task_id)).toEqual([root.task_id]);
      expect((await call('ou_admin', 'GET', '/tasks?include_subtasks=true')).json().items).toHaveLength(4);
      events.length = 0;
      await call('ou_li', 'PATCH', `/tasks/${b.task_id}`, { status: 'done' });
      expect(events.some((e) => e.event_type === 'task.updated' && e.task_id === root.task_id && e.audience?.includes('ou_li'))).toBe(true);
      expect((await call('ou_admin', 'GET', `/tasks/${root.task_id}`)).json()).toMatchObject({ subtask_count: 2, subtask_done_count: 1 });
      // 排序
      expect((await call('ou_admin', 'POST', `/tasks/${root.task_id}/subtasks/order`, { task_ids: [a.task_id] })).statusCode).toBe(409);
      await call('ou_admin', 'POST', `/tasks/${root.task_id}/subtasks/order`, { task_ids: [b.task_id, a.task_id] });
      const subs = (await call('ou_admin', 'GET', `/tasks/${root.task_id}/subtasks`)).json();
      expect(subs.items.map((t: any) => t.task_id)).toEqual([b.task_id, a.task_id]);
      expect(subs.has_more).toBe(false);
      // 负责人不能删，创建人删父任务：子任务一起删
      expect((await call('ou_li', 'DELETE', `/tasks/${root.task_id}`)).statusCode).toBe(403);
      expect((await call('ou_admin', 'DELETE', `/tasks/${root.task_id}`)).statusCode).toBe(204);
      expect((await call('ou_admin', 'GET', `/tasks/${a1.task_id}`)).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('关注人、评论（@ 通知 + 附件）、动态', async () => {
    const { app, call } = await makeApp();
    try {
      const t = (await call('ou_admin', 'POST', '/tasks', { title: '写周报' })).json();
      expect((await call('ou_out', 'POST', `/tasks/${t.task_id}/followers/ou_out`)).statusCode).toBe(404);
      expect((await call('ou_admin', 'POST', `/tasks/${t.task_id}/followers/ou_zhang`)).json().follower_ids).toEqual(['ou_zhang']);
      // 关注人：能看能评论，不能改，不能加别人
      const seen = (await call('ou_zhang', 'GET', `/tasks/${t.task_id}`)).json();
      expect(seen.permissions).toMatchObject({ can_view: true, can_comment: true, can_edit: false, can_follow: true, can_manage_followers: false });
      expect((await call('ou_zhang', 'PATCH', `/tasks/${t.task_id}`, { title: '改' })).statusCode).toBe(403);
      expect((await call('ou_zhang', 'POST', `/tasks/${t.task_id}/followers/ou_li`)).statusCode).toBe(403);
      expect((await call('ou_zhang', 'GET', '/tasks?follower_id=me')).json().items.map((x: any) => x.task_id)).toEqual([t.task_id]);
      // 附件上传（ref task）+ @ 评论
      expect((await call('ou_out', 'POST', '/files/upload-url', { file_name: 'a.png', size: 3, ref: { type: 'task', id: t.task_id } })).statusCode).toBe(422);
      const up = (await call('ou_zhang', 'POST', '/files/upload-url', { file_name: '结果.png', size: 3, ref: { type: 'task', id: t.task_id } })).json();
      const u = new URL(up.upload_url, 'http://x');
      await app.inject({ method: 'PUT', url: u.pathname + u.search, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('abc') });
      expect((await call('ou_zhang', 'POST', `/tasks/${t.task_id}/comments`, { content: { text: ' ' } })).statusCode).toBe(422);
      const cm = await call('ou_zhang', 'POST', `/tasks/${t.task_id}/comments`, {
        content: { text: '@王老师 图做好了', mentions: [{ user_id: 'ou_admin', name: '王老师', offset: 0, length: 4 }, { user_id: 'ou_out', name: '外人', offset: 0, length: 3 }] },
        attachments: [{ file_key: up.file_key, name: '结果.png', size: 3, mime_type: 'image/png' }],
      });
      expect(cm.statusCode).toBe(201);
      expect(cm.json()).toMatchObject({ user_id: 'ou_zhang', attachments: [{ file_key: up.file_key, name: '结果.png' }], permissions: { can_delete: true } });
      const ntf = (await call('ou_admin', 'GET', '/notifications')).json().items;
      expect(ntf.some((n: any) => n.type === 'task.mention' && n.target.type === 'task' && n.target.id === t.task_id)).toBe(true);
      // 看不到任务的人被 @ 也不通知
      expect((await call('ou_out', 'GET', '/notifications')).json().items).toHaveLength(0);
      // 能看任务就能下载附件，外人不行
      expect((await call('ou_admin', 'GET', `/files/${up.file_key}/download-url`)).statusCode).toBe(200);
      expect((await call('ou_out', 'GET', `/files/${up.file_key}/download-url`)).statusCode).toBe(404);
      // 别人的评论：作者和创建人能删，其他关注人不能
      const mine = (await call('ou_admin', 'POST', `/tasks/${t.task_id}/comments`, { content: { text: '收到' } })).json();
      expect((await call('ou_zhang', 'DELETE', `/tasks/${t.task_id}/comments/${mine.comment_id}`)).statusCode).toBe(403);
      expect((await call('ou_admin', 'DELETE', `/tasks/${t.task_id}/comments/${cm.json().comment_id}`)).statusCode).toBe(204);
      expect((await call('ou_admin', 'GET', `/tasks/${t.task_id}/comments`)).json().items.map((c: any) => c.content.text)).toEqual(['收到']);
      // 动态：倒序、结构化 changes
      await call('ou_admin', 'PATCH', `/tasks/${t.task_id}`, { status: 'in_progress' });
      await call('ou_admin', 'PATCH', `/tasks/${t.task_id}`, { status: 'done' });
      const acts = (await call('ou_zhang', 'GET', `/tasks/${t.task_id}/activities`)).json().items;
      expect(acts[0]).toMatchObject({ action: 'completed', operator_id: 'ou_admin', changes: [{ field_name: 'status', before: 'in_progress', after: 'done' }] });
      expect(acts[1].changes[0]).toEqual({ field_name: 'status', before: 'pending', after: 'in_progress' });
      expect(acts.at(-1).action).toBe('created');
      expect(acts.map((a: any) => a.action)).toContain('follower_added');
      // 取消关注后看不到
      await call('ou_zhang', 'DELETE', `/tasks/${t.task_id}/followers/me`);
      expect((await call('ou_zhang', 'GET', `/tasks/${t.task_id}`)).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('任务清单：默认分组、成员权限、分组重名、删分组回未分组、删清单不删任务', async () => {
    let { app, call, events } = await makeApp();
    let listId = '';
    let taskId = '';
    try {
      const l = await call('ou_admin', 'POST', '/tasklists', { name: '机械臂抓取项目' });
      expect(l.statusCode).toBe(201);
      listId = l.json().list_id;
      expect(l.json().permissions).toEqual({ can_view: true, can_edit: true, can_manage: true, can_delete: true });
      const secs = (await call('ou_admin', 'GET', `/tasklists/${listId}/sections`)).json().items;
      expect(secs.map((s: any) => s.name)).toEqual(['待开始', '进行中', '已完成']);
      // 外人看不到清单
      expect((await call('ou_out', 'GET', '/tasklists')).json().items).toHaveLength(0);
      expect((await call('ou_out', 'GET', `/tasklists/${listId}/tasks`)).statusCode).toBe(404);
      // 一步建任务进分组
      const t = (await call('ou_admin', 'POST', '/tasks', { title: '采集数据', list_id: listId, section_id: secs[0].section_id })).json();
      taskId = t.task_id;
      expect(t.tasklists).toEqual([{ list_id: listId, section_id: secs[0].section_id, name: '机械臂抓取项目' }]);
      // 成员：李同学可编辑、张晓明只读
      const put = await call('ou_admin', 'PUT', `/tasklists/${listId}/members`, { members: [{ member_type: 'user', member_id: 'ou_li', role: 'editor' }, { member_type: 'user', member_id: 'ou_zhang', role: 'viewer' }] });
      expect(put.statusCode).toBe(200);
      expect((await call('ou_li', 'GET', `/tasklists/${listId}/members`)).json().members).toHaveLength(2);
      expect((await call('ou_li', 'GET', '/tasklists')).json().items[0].permissions).toEqual({ can_view: true, can_edit: true, can_manage: false, can_delete: false });
      expect((await call('ou_li', 'GET', '/tasks')).json().items.map((x: any) => x.task_id)).toEqual([taskId]);
      expect((await call('ou_li', 'GET', `/tasks/${taskId}`)).json().permissions.can_edit).toBe(true);
      expect((await call('ou_zhang', 'GET', `/tasks/${taskId}`)).json().permissions).toMatchObject({ can_view: true, can_edit: false });
      expect((await call('ou_zhang', 'POST', `/tasklists/${listId}/sections`, { name: '归档' })).statusCode).toBe(403);
      expect((await call('ou_li', 'PATCH', `/tasklists/${listId}`, { name: '改名' })).statusCode).toBe(403);
      // 分组：重名 409；编辑者移动任务；移到未分组
      const dup = await call('ou_li', 'POST', `/tasklists/${listId}/sections`, { name: ' 进行中 ' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().code).toBe('SECTION_NAME_EXISTS');
      events.length = 0;
      await call('ou_li', 'POST', `/tasks/${taskId}/tasklists`, { list_id: listId, section_id: secs[1].section_id });
      expect(events.some((e) => e.event_type === 'tasklist.updated' && e.list_id === listId && e.audience?.includes('ou_zhang'))).toBe(true);
      expect((await call('ou_admin', 'GET', `/tasklists/${listId}/tasks`)).json().items[0].tasklists[0].section_id).toBe(secs[1].section_id);
      expect((await call('ou_li', 'DELETE', `/tasklists/${listId}/sections/${secs[1].section_id}`)).statusCode).toBe(204);
      expect((await call('ou_admin', 'GET', `/tasks/${taskId}`)).json().tasklists[0].section_id).toBeNull();
      // 任务状态不随分组变化
      expect((await call('ou_admin', 'GET', `/tasks/${taskId}`)).json().status).toBe('pending');
      if (!usePg) await tail(call);
    } finally { await app.close(); }
    if (!usePg) return;
    ({ app, call, events } = await makeApp(false));
    try {
      await tail(call);
    } finally { await app.close(); }

    async function tail(call: (u: string, m: string, url: string, p?: unknown) => Promise<{ statusCode: number; json(): any }>) {
      // 重启后：清单、成员、任务归属都在
      expect((await call('ou_zhang', 'GET', `/tasks/${taskId}`)).json().tasklists[0].list_id).toBe(listId);
      // 移出清单后只读成员看不到；删清单不删任务
      expect((await call('ou_li', 'DELETE', `/tasks/${taskId}/tasklists/${listId}`)).statusCode).toBe(204);
      expect((await call('ou_zhang', 'GET', `/tasks/${taskId}`)).statusCode).toBe(404);
      expect((await call('ou_admin', 'DELETE', `/tasklists/${listId}`)).statusCode).toBe(204);
      expect((await call('ou_admin', 'GET', `/tasks/${taskId}`)).statusCode).toBe(200);
      expect((await call('ou_admin', 'GET', '/tasklists')).json().items).toHaveLength(0);
    }
  });
});
