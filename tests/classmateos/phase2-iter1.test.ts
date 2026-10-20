/**
 * 《二期功能需求文档》迭代 1 验收：功能开关、字段管理（R-BT-02）、视图（R-BT-03）、分组（R-BT-04）、
 * 实时刷新（R-BT-05）、批量操作（R-BT-06）、通知中心（R-NT-01）、通知设置与推送规则（R-NT-02）。
 *
 * memory 总是运行；设置 CLASSMATEOS_TEST_PG_URL 时同时跑 PostgreSQL（会清空该库，请用专门的测试库）。
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import WebSocket from 'ws';
import { buildApp, type AppOptions, type PlatformUser } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import { MemoryPushProvider } from '../../classmateos/server/push.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
const USERS: PlatformUser[] = [
  { user_id: 'ou_admin', name: '王老师', password: 'admin', role: 'admin' },
  { user_id: 'u_zhang', name: '张晓明', password: 'pw', role: 'member' },
  { user_id: 'u_li', name: '李华', password: 'pw', role: 'member' },
];
/** 2026-10-19 12:00 北京时间（周一）。 */
const NOW = Date.UTC(2026, 9, 19, 4, 0, 0);
const DAY = 86_400_000;

type Ev = Record<string, any>;

let pool: pg.Pool | undefined;
async function resetPg(): Promise<pg.Pool> {
  pool ??= new pg.Pool({ connectionString: PG_URL, max: 5 });
  // 内置表可能被上一个用例加过列 / 去过约束：整库重建
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
  await new PgRepo(pool).init();
  return pool;
}

afterAll(async () => {
  await pool?.end();
});

const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(backends)('二期迭代 1（$name）', ({ usePg }) => {
  const apps: FastifyInstance[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    for (const a of apps.splice(0)) await a.close();
  });

  async function makeApp(opts: { reset?: boolean; now?: number; push?: MemoryPushProvider } = {}) {
    const o: AppOptions = {
      users: USERS,
      secret: 's',
      botToken: 'b',
      now: () => opts.now ?? NOW,
      notificationScanner: false,
      pushProvider: opts.push,
    };
    if (usePg) {
      const p = opts.reset === false ? pool! : await resetPg();
      const st = new PgTableStore(p);
      await st.ensureMetaColumns();
      o.repo = new PgRepo(p);
      o.store = st;
    }
    const app = await buildApp(o);
    apps.push(app);
    const tok = async (u: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: u, password: u === 'ou_admin' ? 'admin' : 'pw' },
        })
      ).json().access_token as string;
    const call = (token: string | undefined, method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as 'GET',
        url: `/api/v1${url}`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload: payload as Ev | undefined,
      });
    const ws = async (token: string, query = '') => {
      if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const sock = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events/ws?token=${token}${query}`);
      sockets.push(sock);
      const events: Ev[] = [];
      sock.on('message', (d) => events.push(JSON.parse(String(d))));
      await new Promise((res, rej) => {
        sock.once('open', res);
        sock.once('error', rej);
      });
      const send = (m: Ev) => sock.send(JSON.stringify(m));
      const subscribe = async (topic: string) => {
        send({ type: 'subscribe', topic });
        for (let i = 0; i < 50 && !events.some((e) => e.topic === topic && /subscribe/.test(e.event_type)); i++) await sleep(10);
      };
      return { sock, events, send, subscribe, of: (t: string) => events.filter((e) => e.event_type === t) };
    };
    return { app, tok, call, ws };
  }

  const tableBody = (over: Ev = {}) => ({
    name: '设备借用',
    primary_field: 'name',
    fields: [
      { field_name: 'name', title: '名称', type: 1, required: true },
      { field_name: 'status', title: '状态', type: 3, options: ['空闲', '借出'] },
      { field_name: 'qty', title: '数量', type: 2 },
      { field_name: 'note', title: '备注', type: 1 },
      { field_name: 'owner', title: '负责人', type: 11 },
      { field_name: 'due', title: '归还日期', type: 5 },
    ],
    ...over,
  });

  async function withTable(z: string, call: Awaited<ReturnType<typeof makeApp>>['call']) {
    const t = (await call(z, 'POST', '/tables', tableBody())).json();
    return t as Ev;
  }

  // ---------------- 2.1 功能开关 ----------------

  it('GET /capabilities 打开迭代 1 的功能，未上线的为 false', async () => {
    const { call } = await makeApp();
    const r = await call(undefined, 'GET', '/capabilities');
    expect(r.statusCode).toBe(200);
    const f = r.json().features;
    for (const k of ['table.create', 'table.fields', 'table.views', 'notifications']) expect(f[k]).toBe(true);
    for (const k of ['wiki', 'approval', 'doc.folders']) expect(f[k]).toBeFalsy();
  });

  // ---------------- R-BT-01 / 02 ----------------

  it('GET /tables 带 builtin / version / permissions；GET /tables/:key 返回单表', async () => {
    const { tok, call } = await makeApp();
    const [a, z] = [await tok('ou_admin'), await tok('u_zhang')];
    const t = await withTable(z, call);
    expect(t).toMatchObject({ builtin: false, version: 1, permissions: { can_view: true, can_edit: true, can_manage: true, can_delete: true } });
    expect(t.fields.every((f: Ev) => f.builtin === false)).toBe(true);

    const list = (await call(z, 'GET', '/tables')).json().items as Ev[];
    const projects = list.find((x) => x.key === 'projects')!;
    expect(projects).toMatchObject({ builtin: true, version: 1, permissions: { can_manage: false, can_delete: false } });
    expect(projects.fields.every((f: Ev) => f.builtin === true)).toBe(true);
    expect((await call(a, 'GET', '/tables/projects')).json().permissions.can_manage).toBe(true);
    // 别人建的表：李华不能管理
    expect((await call(await tok('u_li'), 'GET', `/tables/${t.key}`)).json().permissions).toMatchObject({ can_edit: true, can_manage: false });
    expect((await call(z, 'GET', '/tables/nope')).statusCode).toBe(404);
  });

  it('字段：新增（自动字段名、插入位置）、改名、版本冲突、排序、删除、主字段保护、无权限 403', async () => {
    const { tok, call } = await makeApp();
    const [z, l] = [await tok('u_zhang'), await tok('u_li')];
    const t = await withTable(z, call);
    const url = `/tables/${t.key}/fields`;

    // 新增：不传 field_name 时后端生成；after_field 指定位置
    let r = await call(z, 'POST', url, { title: '位置', type: 3, options: ['A 柜', 'B 柜'], option_colors: { 'A 柜': 'cyan' }, after_field: 'name', base_version: 1 });
    expect(r.statusCode).toBe(201);
    let tb = r.json();
    expect(tb.version).toBe(2);
    expect(tb.fields[1]).toMatchObject({ field_name: 'field_1', title: '位置', type: 3, options: ['A 柜', 'B 柜'], builtin: false });
    expect(tb.fields[1].option_colors).toMatchObject({ 'A 柜': 'cyan' });
    // 新字段立即可写
    r = await call(z, 'POST', `/tables/${t.key}/records`, { fields: { name: '示波器', field_1: 'A 柜' } });
    expect(r.statusCode).toBe(201);
    expect((await call(z, 'POST', `/tables/${t.key}/records`, { fields: { name: 'x', field_1: 'C 柜' } })).statusCode).toBe(422);

    // 旧版本号 → 409 VERSION_CONFLICT，并带最新表定义
    r = await call(z, 'POST', url, { title: '价格', type: 2, base_version: 1 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'VERSION_CONFLICT', table: { version: 2 } });

    // 重名、非法类型 → 422
    expect((await call(z, 'POST', url, { title: '名称', type: 1 })).json().errors[0].field).toBe('title');
    expect((await call(z, 'POST', url, { title: '关联', type: 18 })).statusCode).toBe(422);
    expect((await call(z, 'POST', url, { title: '单选', type: 3 })).json().errors[0].field).toBe('options');

    // 改名
    r = await call(z, 'PATCH', `${url}/qty`, { title: '库存数量', type: 2, required: false, description: '' , base_version: 2 });
    expect(r.statusCode).toBe(200);
    tb = r.json();
    expect(tb.fields.find((f: Ev) => f.field_name === 'qty').title).toBe('库存数量');
    expect(tb.version).toBe(3);

    // 排序：只给一部分，其余按原顺序接在后面
    r = await call(z, 'PUT', `${url}/order`, { field_names: ['status', 'name'] });
    expect(r.json().fields.map((f: Ev) => f.field_name).slice(0, 3)).toEqual(['status', 'name', 'field_1']);
    expect((await call(z, 'PUT', `${url}/order`, { field_names: ['nope'] })).statusCode).toBe(422);

    // 主字段：不能删、不能改类型
    expect((await call(z, 'DELETE', `${url}/name`)).statusCode).toBe(422);
    expect((await call(z, 'PATCH', `${url}/name`, { type: 2 })).statusCode).toBe(422);
    // 别人不能管理字段
    expect((await call(l, 'POST', url, { title: '价格', type: 2 })).json().code).toBe('FORBIDDEN');

    // 删除（DELETE 的 base_version 放在 query）
    const v = (await call(z, 'GET', `/tables/${t.key}`)).json().version;
    expect((await call(z, 'DELETE', `${url}/note?base_version=${v - 1}`)).statusCode).toBe(409);
    r = await call(z, 'DELETE', `${url}/note?base_version=${v}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().fields.some((f: Ev) => f.field_name === 'note')).toBe(false);
    expect((await call(z, 'POST', `/tables/${t.key}/records`, { fields: { name: 'y', note: 'z' } })).statusCode).toBe(422);
  });

  it('字段：选项改名同步已有记录，删除的选项被清空；改类型先预估再转换', async () => {
    const { tok, call } = await makeApp();
    const z = await tok('u_zhang');
    const t = await withTable(z, call);
    const rec = async (fields: Ev) => (await call(z, 'POST', `/tables/${t.key}/records`, { fields })).json().record_id as string;
    const r1 = await rec({ name: '示波器', status: '空闲', note: '12' });
    const r2 = await rec({ name: '万用表', status: '借出', note: 'abc' });
    const r3 = await rec({ name: '电源', note: '3.5' });
    const get = async (id: string) => (await call(z, 'GET', `/tables/${t.key}/records/${id}`)).json().fields;

    let r = await call(z, 'PATCH', `/tables/${t.key}/fields/status`, {
      options: ['可用', '借出', '维修'],
      option_renames: { 空闲: '可用' },
      option_colors: { 维修: 'red' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().fields.find((f: Ev) => f.field_name === 'status').option_colors).toMatchObject({ 维修: 'red' });
    expect((await get(r1)).status).toBe('可用');
    expect((await get(r2)).status).toBe('借出');

    r = await call(z, 'PATCH', `/tables/${t.key}/fields/status`, { options: ['可用'] });
    expect(r.statusCode).toBe(200);
    expect((await get(r1)).status).toBe('可用');
    expect((await get(r2)).status).toBeUndefined();

    // 文本 → 数字：预估 3 条有值、1 条转不了
    r = await call(z, 'POST', `/tables/${t.key}/fields/note/convert-preview`, { type: 2 });
    expect(r.json()).toEqual({ affected: 3, will_clear: 1 });
    r = await call(z, 'PATCH', `/tables/${t.key}/fields/note`, { type: 2 });
    expect(r.statusCode).toBe(200);
    expect((await get(r1)).note).toBe(12);
    expect((await get(r2)).note).toBeUndefined();
    expect((await get(r3)).note).toBe(3.5);
    // 新类型的校验生效
    expect((await call(z, 'PATCH', `/tables/${t.key}/records/${r1}`, { fields: { note: '文字' } })).statusCode).toBe(422);
    // 数字 → 多选（选项里没有的值清空）
    r = await call(z, 'PATCH', `/tables/${t.key}/fields/note`, { type: 4, options: ['12', '99'] });
    expect(r.statusCode).toBe(200);
    expect((await get(r1)).note).toEqual(['12']);
    expect((await get(r3)).note).toBeUndefined();
  });

  it('内置表：可新增 / 删除自定义字段，内置字段只能改名称和选项（选项改名同步记录）', async () => {
    const { tok, call } = await makeApp();
    const [a, z] = [await tok('ou_admin'), await tok('u_zhang')];
    const rec = (await call(a, 'POST', '/tables/projects/records', { fields: { title: '四足', status: '进行中' } })).json();

    expect((await call(z, 'POST', '/tables/projects/fields', { title: '经费', type: 2 })).statusCode).toBe(403);
    let r = await call(a, 'POST', '/tables/projects/fields', { field_name: 'budget_cny', title: '经费', type: 2 });
    expect(r.statusCode).toBe(201);
    expect(r.json().fields.at(-1)).toMatchObject({ field_name: 'budget_cny', builtin: false });
    // 不能和内置列重名
    expect((await call(a, 'POST', '/tables/projects/fields', { field_name: 'status', title: '状态2', type: 1 })).statusCode).toBe(422);
    expect((await call(a, 'PATCH', `/tables/projects/records/${rec.record_id}`, { fields: { budget_cny: 5000 } })).statusCode).toBe(200);

    // 内置字段：改名 + 选项改名
    const status = r.json().fields.find((f: Ev) => f.field_name === 'status');
    r = await call(a, 'PATCH', '/tables/projects/fields/status', {
      title: '项目状态',
      required: status.required,
      description: '',
      options: status.options.map((o: string) => (o === '进行中' ? '开发中' : o)),
      option_renames: { 进行中: '开发中' },
    });
    expect(r.statusCode).toBe(200);
    const got = (await call(a, 'GET', `/tables/projects/records/${rec.record_id}`)).json().fields;
    expect(got).toMatchObject({ status: '开发中', budget_cny: 5000 });
    expect((await call(a, 'POST', '/tables/projects/records', { fields: { title: 'x', status: '开发中' } })).statusCode).toBe(201);
    // 内置字段：不能删、不能改类型、不能改必填
    expect((await call(a, 'DELETE', '/tables/projects/fields/status')).statusCode).toBe(403);
    expect((await call(a, 'PATCH', '/tables/projects/fields/status', { type: 1 })).statusCode).toBe(403);
    expect((await call(a, 'PATCH', '/tables/projects/fields/status', { required: !status.required })).statusCode).toBe(403);
    // 自定义字段可以删
    r = await call(a, 'DELETE', '/tables/projects/fields/budget_cny');
    expect(r.statusCode).toBe(200);
    const tb = (await call(z, 'GET', '/tables/projects')).json();
    expect(tb.fields.find((f: Ev) => f.field_name === 'status').title).toBe('项目状态');
    expect(tb.fields.some((f: Ev) => f.field_name === 'budget_cny')).toBe(false);
    expect(tb.version).toBe(4);
  });

  // ---------------- R-BT-03 / 04 ----------------

  it('视图：默认视图、新建、个人视图只自己可见、版本冲突、最后一个公共视图不可删、排序、config 原样保存', async () => {
    const { tok, call } = await makeApp();
    const [z, l] = [await tok('u_zhang'), await tok('u_li')];
    const t = await withTable(z, call);
    const url = `/tables/${t.key}/views`;
    let views = (await call(z, 'GET', url)).json().items as Ev[];
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ name: '表格视图', type: 'grid', personal: false, version: 1 });
    const def = views[0];

    const cfg = {
      filter: { conjunction: 'and', conditions: [{ field_name: 'status', operator: 'is', value: ['借出'] }] },
      sort: [{ field_name: 'qty', desc: true }],
      group: [],
      hidden_fields: ['note'],
      field_order: ['name', 'status'],
      field_widths: { name: 240 },
      row_height: 'compact',
      kanban_field: 'status',
      calendar: { start_field: 'due', end_field: 'due' },
    };
    let r = await call(z, 'POST', url, { name: '借出中', type: 'kanban', config: cfg });
    expect(r.statusCode).toBe(201);
    const kanban = r.json();
    expect(kanban.config).toMatchObject(cfg);
    expect(kanban.config.calendar).toEqual(cfg.calendar);

    // 引用不存在的字段 → 422
    r = await call(z, 'POST', url, { name: 'x', config: { sort: [{ field_name: 'nope' }] } });
    expect(r.json().errors[0].field).toBe('config.sort[0].field_name');

    // 个人视图只自己可见
    const mine = (await call(l, 'POST', url, { name: '我的', type: 'grid', personal: true })).json();
    expect(mine).toMatchObject({ personal: true, owner_id: 'u_li' });
    expect(((await call(z, 'GET', url)).json().items as Ev[]).map((v) => v.view_id)).not.toContain(mine.view_id);
    expect(((await call(l, 'GET', url)).json().items as Ev[]).map((v) => v.view_id)).toContain(mine.view_id);
    expect((await call(z, 'PATCH', `${url}/${mine.view_id}`, { name: 'x', version: 1 })).statusCode).toBe(404);

    // 版本冲突
    r = await call(z, 'PATCH', `${url}/${kanban.view_id}`, { name: '借出', version: 1 });
    expect(r.json()).toMatchObject({ name: '借出', version: 2 });
    r = await call(l, 'PATCH', `${url}/${kanban.view_id}`, { name: '旧', version: 1 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'VERSION_CONFLICT', view: { version: 2 } });
    expect((await call(z, 'PATCH', `${url}/${kanban.view_id}`, { name: '缺版本' })).statusCode).toBe(422);

    // 排序
    r = await call(z, 'PUT', `${url}/order`, { view_ids: [kanban.view_id, def.view_id] });
    expect(r.json().items.map((v: Ev) => v.view_id)).toEqual([kanban.view_id, def.view_id]);

    // 删除：最后一个公共视图不可删
    expect((await call(z, 'DELETE', `${url}/${kanban.view_id}`)).statusCode).toBe(204);
    expect((await call(z, 'DELETE', `${url}/${def.view_id}`)).statusCode).toBe(422);
    // 个人视图可以删；改成个人视图时也要保留至少一个公共视图
    expect((await call(z, 'PATCH', `${url}/${def.view_id}`, { personal: true, version: def.version })).statusCode).toBe(422);
    expect((await call(l, 'DELETE', `${url}/${mine.view_id}`)).statusCode).toBe(204);

    // 字段被视图引用时不能删
    await call(z, 'PATCH', `${url}/${def.view_id}`, { config: { group: [{ field_name: 'status' }] }, version: def.version });
    r = await call(z, 'DELETE', `/tables/${t.key}/fields/status`);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('FIELD_IN_USE');
    expect(r.json().message).toContain('表格视图');
    expect(r.json().message).toContain('分组');
    views = (await call(z, 'GET', url)).json().items;
    expect(views).toHaveLength(1);
  });

  it('按视图取记录：后端筛选 / 排序 / 分组（600 条，空值排最后，日期筛选按北京时间）', async () => {
    const { tok, call } = await makeApp();
    const z = await tok('u_zhang');
    const t = await withTable(z, call);
    const records = Array.from({ length: 600 }, (_, i) => ({
      fields: {
        name: `设备${String(i).padStart(3, '0')}`,
        ...(i % 3 === 0 ? {} : { status: i % 3 === 1 ? '空闲' : '借出' }),
        ...(i % 10 === 0 ? {} : { qty: i % 7 }),
        ...(i % 2 === 0 ? { owner: [{ id: i % 4 === 0 ? 'u_zhang' : 'u_li' }] } : {}),
        due: NOW + (i % 20) * DAY - 10 * DAY,
      },
    }));
    for (let i = 0; i < 600; i += 300) {
      const r = await call(z, 'POST', `/tables/${t.key}/records/batch_create`, { records: records.slice(i, i + 300) });
      expect(r.json().failed).toEqual([]);
    }
    const url = `/tables/${t.key}/views`;
    const view = (
      await call(z, 'POST', url, {
        name: '统计',
        config: {
          filter: { conjunction: 'and', conditions: [{ field_name: 'qty', operator: 'gte', value: 2 }] },
          sort: [{ field_name: 'qty', desc: true }],
          group: [{ field_name: 'status' }, { field_name: 'owner' }],
        },
      })
    ).json();
    const all: Ev[] = [];
    let token: string | null = null;
    let first: Ev | undefined;
    do {
      const page: Ev = (await call(z, 'GET', `/tables/${t.key}/records?view_id=${view.view_id}&page_size=200${token ? `&page_token=${token}` : ''}`)).json();
      first ??= page;
      all.push(...page.items);
      token = page.page_token;
    } while (token);
    const expected = records.filter((r) => typeof r.fields.qty === 'number' && r.fields.qty >= 2);
    expect(first!.total).toBe(expected.length);
    expect(all).toHaveLength(expected.length);
    expect(new Set(all.map((r) => r.record_id)).size).toBe(expected.length);
    // 分组字段优先：status 升序（借出 < 空闲，空值最后），组内 qty 降序
    const statusSeq = all.map((r) => r.fields.status ?? '');
    const firstEmpty = statusSeq.indexOf('');
    expect(statusSeq.slice(firstEmpty).every((s) => s === '')).toBe(true);
    // 分组计数（含两层）
    const groups = first!.groups as Array<{ path: string[]; count: number }>;
    const top = groups.filter((g) => g.path.length === 1);
    expect(top.map((g) => g.path[0])).toEqual(['借出', '空闲', '']);
    expect(top.reduce((s, g) => s + g.count, 0)).toBe(expected.length);
    const borrow = expected.filter((r) => r.fields.status === '借出');
    expect(top[0].count).toBe(borrow.length);
    const sub = groups.filter((g) => g.path.length === 2 && g.path[0] === '借出');
    expect(sub.reduce((s, g) => s + g.count, 0)).toBe(borrow.length);
    // 组内加载
    const inGroup = (await call(z, 'GET', `/tables/${t.key}/records?view_id=${view.view_id}&page_size=500&group_path=${encodeURIComponent('["借出"]')}`)).json();
    expect(inGroup.total).toBe(borrow.length);
    expect(inGroup.items.every((r: Ev) => r.fields.status === '借出')).toBe(true);
    // 第二层按负责人分组：同一负责人连成一段，段内 qty 降序
    const owners: string[] = inGroup.items.map((r: Ev) => r.fields.owner?.[0]?.id ?? '');
    for (let i = 1; i < owners.length; i++) {
      if (owners[i] === owners[i - 1]) expect(inGroup.items[i].fields.qty).toBeLessThanOrEqual(inGroup.items[i - 1].fields.qty);
    }
    expect(new Set(owners).size).toBe(owners.filter((o, i) => i === 0 || o !== owners[i - 1]).length);

    // 人员 is、日期 today / this_week / last_7_days
    const count = async (conditions: Ev[], conjunction = 'and') => {
      const v = (await call(z, 'POST', url, { name: 'c', personal: true, config: { filter: { conjunction, conditions } } })).json();
      return (await call(z, 'GET', `/tables/${t.key}/records?view_id=${v.view_id}&page_size=1`)).json().total as number;
    };
    expect(await count([{ field_name: 'owner', operator: 'is', value: ['u_zhang'] }])).toBe(150);
    expect(await count([{ field_name: 'due', operator: 'today' }])).toBe(30);
    // 本周（周一 10-19 到周日 10-25）：offset 10..16 → 7 天 × 30
    expect(await count([{ field_name: 'due', operator: 'this_week' }])).toBe(210);
    expect(await count([{ field_name: 'due', operator: 'last_7_days' }])).toBe(210);
    expect(await count([{ field_name: 'status', operator: 'is_empty' }])).toBe(200);
    expect(await count([{ field_name: 'status', operator: 'is', value: [] }])).toBe(600); // 空条件不生效
    expect(await count([{ field_name: 'name', operator: 'contains', value: '设备00' }])).toBe(10);
    expect(
      await count(
        [
          { field_name: 'status', operator: 'is', value: ['借出'] },
          { field_name: 'name', operator: 'contains', value: '设备00' },
        ],
        'or',
      ),
    ).toBe(200 + 10 - 3);

    // 看不到的视图 / 别的表的视图 → 404
    expect((await call(z, 'GET', `/tables/projects/records?view_id=${view.view_id}`)).statusCode).toBe(404);
  });

  // ---------------- R-BT-06 ----------------

  it('批量：创建 / 统一修改 / 逐条修改 / 删除，部分失败给中文原因；按视图删除全部', async () => {
    const { tok, call } = await makeApp();
    const z = await tok('u_zhang');
    const t = await withTable(z, call);
    const base = `/tables/${t.key}/records`;
    let r = await call(z, 'POST', `${base}/batch_create`, {
      records: [
        ...Array.from({ length: 200 }, (_, i) => ({ fields: { name: `r${i}`, status: '空闲' } })),
        { fields: { status: '坏了' } },
      ],
    });
    expect(r.json().succeeded).toHaveLength(200);
    expect(r.json().failed).toHaveLength(1);
    expect(r.json().failed[0].index).toBe(200);
    expect(r.json().failed[0].message).toContain('「名称」');
    expect(r.json().failed[0].message).toContain('「状态」');
    const ids = (r.json().succeeded as Ev[]).map((x) => x.record_id);

    r = await call(z, 'POST', `${base}/batch_update`, { record_ids: [...ids, 'rec_nope'], fields: { status: '借出' } });
    expect(r.json().succeeded).toHaveLength(200);
    expect(r.json().failed).toEqual([{ record_id: 'rec_nope', message: '记录不存在或已被删除' }]);
    expect((await call(z, 'GET', `${base}/${ids[5]}`)).json().fields.status).toBe('借出');

    r = await call(z, 'POST', `${base}/batch_update`, {
      records: [
        { record_id: ids[0], fields: { status: '空闲' } },
        { record_id: ids[1], fields: { name: '' } },
      ],
    });
    expect(r.json().succeeded).toHaveLength(1);
    expect(r.json().failed[0]).toMatchObject({ record_id: ids[1] });
    expect(r.json().failed[0].message).toContain('不能清空');
    expect((await call(z, 'POST', `${base}/batch_update`, { record_ids: ids })).statusCode).toBe(422);
    expect((await call(z, 'POST', `${base}/batch_create`, { records: Array.from({ length: 501 }, () => ({ fields: { name: 'x' } })) })).statusCode).toBe(422);

    r = await call(z, 'POST', `${base}/batch_delete`, { record_ids: ids.slice(0, 150) });
    expect(r.json().succeeded).toHaveLength(150);
    const view = (await call(z, 'POST', `/tables/${t.key}/views`, { name: '空闲', config: { filter: { conditions: [{ field_name: 'status', operator: 'is', value: ['空闲'] }] } } })).json();
    r = await call(z, 'POST', `${base}/batch_delete`, { view_id: view.view_id, all: true });
    expect(r.json().succeeded).toHaveLength(0); // ids[0] 已在前 150 条里被删
    expect((await call(z, 'GET', `${base}?page_size=1`)).json().total).toBe(50);
  });

  // ---------------- R-BT-05 ----------------

  it('实时：订阅 table:<key> 才收到 record.changed / schema / view 事件，带 operator_id；保密记录只推给负责人', async () => {
    const { tok, call, ws } = await makeApp();
    const [a, z, l] = [await tok('ou_admin'), await tok('u_zhang'), await tok('u_li')];
    const t = await withTable(z, call);
    const zw = await ws(z);
    const lw = await ws(l);
    const aw = await ws(a);
    await zw.subscribe(`table:${t.key}`);
    await lw.subscribe('table:projects');
    await aw.subscribe('table:projects');
    expect(zw.of('subscribed')).toEqual([{ event_type: 'subscribed', topic: `table:${t.key}` }]);
    await zw.subscribe('table:nope');
    expect(zw.of('subscribe_failed')[0]).toMatchObject({ topic: 'table:nope', code: 'NOT_FOUND' });

    const rec = (await call(l, 'POST', `/tables/${t.key}/records`, { fields: { name: '示波器' } })).json();
    await call(l, 'PATCH', `/tables/${t.key}/records/${rec.record_id}`, { fields: { status: '借出' } });
    await call(l, 'DELETE', `/tables/${t.key}/records/${rec.record_id}`);
    await call(z, 'POST', `/tables/${t.key}/fields`, { title: '价格', type: 2 });
    await call(z, 'POST', `/tables/${t.key}/views`, { name: '个人', personal: true });
    await sleep(200);
    const changes = zw.of('record.changed');
    expect(changes.map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
    expect(changes[0]).toMatchObject({ table_key: t.key, record_id: rec.record_id, operator_id: 'u_li', record: { fields: { name: '示波器' } } });
    expect(changes[1].changed_fields).toEqual(['status']);
    expect(changes[2].record).toBeUndefined();
    expect(zw.of('table.schema_changed')).toEqual([expect.objectContaining({ table_key: t.key, version: 2 })]);
    expect(zw.of('table.view_changed')[0]).toMatchObject({ table_key: t.key, action: 'created' });
    // 没订阅这张表的人收不到；内部字段不下发
    expect(lw.of('record.changed')).toHaveLength(0);
    expect(lw.of('table.view_changed')).toHaveLength(0);
    expect(changes[0].scope).toBeUndefined();
    expect(changes[0].audience).toBeUndefined();
    // 新建表：所有人都收到 table.created（不用订阅）
    const t2 = (await call(l, 'POST', '/tables', tableBody({ name: '另一张' }))).json();
    await sleep(100);
    expect(zw.of('table.created').map((e) => e.table_key)).toContain(t2.key);

    // 保密记录：只推给负责人和管理员；从公开改成保密时，其他人收到 deleted
    const p = (await call(z, 'POST', '/tables/projects/records', { fields: { title: '公开项目', visibility: '可公开', owner_open_id: [{ id: 'u_zhang' }] } })).json();
    await call(z, 'PATCH', `/tables/projects/records/${p.record_id}`, { fields: { visibility: '保密' } });
    await call(z, 'PATCH', `/tables/projects/records/${p.record_id}`, { fields: { title: '保密项目' } });
    await sleep(200);
    const li = lw.of('record.changed').filter((e) => e.record_id === p.record_id);
    expect(li.map((e) => e.action)).toEqual(['created', 'deleted']);
    expect(JSON.stringify(li)).not.toContain('保密项目');
    const ad = aw.of('record.changed').filter((e) => e.record_id === p.record_id);
    expect(ad.map((e) => e.action)).toEqual(['created', 'updated', 'updated']);

    // 取消订阅后不再收到
    lw.send({ type: 'unsubscribe', topic: 'table:projects' });
    await sleep(50);
    await call(a, 'POST', '/tables/projects/records', { fields: { title: '新项目' } });
    await sleep(150);
    expect(lw.of('record.changed')).toHaveLength(2);
  });

  it('实时：断线带 since 重连后，重新订阅会补发期间的表格事件；大脑 WS 只收触发器需要的事件且不带内容', async () => {
    const { app, tok, call, ws } = await makeApp();
    const z = await tok('u_zhang');
    const t = await withTable(z, call);
    const w1 = await ws(z);
    await w1.subscribe(`table:${t.key}`);
    await call(z, 'POST', `/tables/${t.key}/records`, { fields: { name: 'a' } });
    await sleep(100);
    const last = w1.of('record.changed').at(-1)!.event_id as string;
    w1.sock.close();
    await call(z, 'POST', `/tables/${t.key}/records`, { fields: { name: 'b' } });
    await call(z, 'POST', `/tables/${t.key}/records`, { fields: { name: 'c' } });

    const w2 = await ws(z, `&since=${last}`);
    await sleep(100);
    expect(w2.of('record.changed')).toHaveLength(0); // 还没订阅
    await w2.subscribe(`table:${t.key}`);
    await sleep(100);
    expect(w2.of('record.changed').map((e) => e.record.fields.name)).toEqual(['b', 'c']);

    // 大脑 WS
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const bot = new WebSocket(`ws://127.0.0.1:${port}/api/v1/bot/events/ws`, { headers: { 'X-Bot-Token': 'b' } });
    sockets.push(bot);
    const botEvents: Ev[] = [];
    bot.on('message', (d) => botEvents.push(JSON.parse(String(d))));
    await new Promise((r) => bot.once('open', r));
    await call(z, 'POST', `/tables/${t.key}/records`, { fields: { name: 'd' } });
    await sleep(150);
    const rc = botEvents.filter((e) => e.event_type === 'record.changed');
    expect(rc).toHaveLength(1); // M3：触发器需要
    expect(rc[0].record_id).toBeTruthy();
    expect(rc[0].record).toBeUndefined(); // 不带记录内容
    expect(botEvents.some((e) => e.event_type === 'notification.new')).toBe(false);
  });

  // ---------------- R-NT-01 / 02 ----------------

  it('通知中心：任务指派 / 日程邀请生成通知并实时推送；未读数、已读、@我筛选', async () => {
    const { tok, call, ws } = await makeApp();
    const [z, l] = [await tok('u_zhang'), await tok('u_li')];
    const lw = await ws(l);
    const task = (await call(z, 'POST', '/tasks', { title: '整理实验数据', assignee_id: 'u_li', due_ms: NOW + DAY })).json();
    await call(z, 'POST', '/calendar/events', { title: '组会', start_ms: NOW + DAY, end_ms: NOW + DAY + 3600_000, attendee_ids: ['u_li'] });
    await sleep(200);
    const news = lw.of('notification.new');
    expect(news).toHaveLength(2);
    expect(news[0].notification).toMatchObject({
      type: 'task.assigned',
      actor_id: 'u_zhang',
      title: '张晓明 给你指派了任务「整理实验数据」',
      target: { type: 'task', id: task.task_id },
      read: false,
    });
    expect(news[1].notification).toMatchObject({ type: 'calendar.invited', title: '张晓明 邀请你参加日程「组会」', target: { type: 'calendar' } });

    expect((await call(l, 'GET', '/notifications/unread-count')).json()).toEqual({ count: 2 });
    expect((await call(z, 'GET', '/notifications/unread-count')).json()).toEqual({ count: 0 });
    const list = (await call(l, 'GET', '/notifications?filter=all')).json();
    expect(list.items.map((n: Ev) => n.type)).toEqual(['calendar.invited', 'task.assigned']); // 倒序
    expect(list.total).toBe(2);
    expect((await call(l, 'GET', '/notifications?filter=mention')).json().items).toEqual([]);

    let r = await call(l, 'POST', '/notifications/read', { ids: [list.items[0].notification_id] });
    expect(r.json()).toEqual({ updated: 1, count: 1 });
    // 别人的通知标不了
    expect((await call(z, 'POST', '/notifications/read', { ids: [list.items[1].notification_id] })).json().updated).toBe(0);
    r = await call(l, 'POST', '/notifications/read', { all: true });
    expect(r.json()).toEqual({ updated: 1, count: 0 });
    await sleep(100);
    expect(lw.of('notification.read').at(-1)).toMatchObject({ count: 0 });
    expect((await call(l, 'POST', '/notifications/read', {})).statusCode).toBe(422);
  });

  it('任务即将到期提醒：24 小时内到期的任务提醒一次', async () => {
    const { app, tok, call } = await makeApp();
    const z = await tok('u_zhang');
    await call(z, 'POST', '/tasks', { title: '交周报', assignee_id: 'u_li', due_ms: NOW + 3 * 3600_000 });
    await call(z, 'POST', '/tasks', { title: '下周的事', assignee_id: 'u_li', due_ms: NOW + 3 * DAY });
    const svc = (app as unknown as { cos: { notifications: { scanDueSoon(now: number): Promise<number> } } }).cos.notifications;
    expect(await svc.scanDueSoon(NOW)).toBe(1);
    expect(await svc.scanDueSoon(NOW)).toBe(0);
    const items = (await call(await tok('u_li'), 'GET', '/notifications')).json().items as Ev[];
    expect(items.find((n) => n.type === 'task.due_soon')).toMatchObject({ title: '任务「交周报」即将到期', summary: '截止时间：10月19日 15:00' });
  });

  it('通知设置：默认值、部分更新、校验；推送按总开关 / 分类 / 免打扰 / 桌面在线 / 显示内容执行', async () => {
    const push = new MemoryPushProvider();
    // 现在是北京时间 23:30
    const { tok, call, ws } = await makeApp({ push, now: Date.UTC(2026, 9, 19, 15, 30) });
    const [z, l] = [await tok('u_zhang'), await tok('u_li')];
    let r = await call(l, 'GET', '/users/me/notification-settings');
    expect(r.json()).toEqual({
      enabled: true,
      categories: { message: true, mention: true, approval: true, task: true, calendar: true, comment: true },
      dnd: { enabled: false, start: '23:00', end: '08:00' },
      mute_mobile_when_desktop_online: true,
      show_preview: true,
    });
    expect((await call(l, 'PUT', '/users/me/notification-settings', { dnd: { start: '25:00' } })).json().errors[0].field).toBe('dnd.start');

    // 设备：macOS 也能注册
    expect((await call(l, 'POST', '/devices', { platform: 'macos', device_token: 'mac-1' })).statusCode).toBe(201);
    expect((await call(l, 'POST', '/devices', { platform: 'ios', device_token: 'ios-1' })).statusCode).toBe(201);

    const chat = (await call(z, 'POST', '/chats', { member_ids: ['u_li'] })).json();
    const say = async (text: string) => {
      await call(z, 'POST', `/chats/${chat.chat_id}/messages`, { msg_type: 'text', content: { text } });
      await sleep(80);
    };
    await say('一');
    expect(push.sent.map((s) => s.device_token).sort()).toEqual(['ios-1', 'mac-1']);
    expect(push.sent[0].msg.body).toBe('张晓明: 一');

    // 不显示内容
    await call(l, 'PUT', '/users/me/notification-settings', { show_preview: false });
    push.sent.length = 0;
    await say('秘密');
    expect(push.sent.every((s) => s.msg.body === '张晓明 发来一条新消息')).toBe(true);

    // 关掉「消息」分类
    r = await call(l, 'PUT', '/users/me/notification-settings', { categories: { message: false }, show_preview: true });
    expect(r.json().categories).toMatchObject({ message: false, task: true });
    push.sent.length = 0;
    await say('二');
    expect(push.sent).toHaveLength(0);
    // 通知类（任务）照常推
    await call(z, 'POST', '/tasks', { title: '任务', assignee_id: 'u_li' });
    await sleep(100);
    expect(push.sent).toHaveLength(2);

    // 免打扰（23:00–08:00，现在 23:30）
    await call(l, 'PUT', '/users/me/notification-settings', { categories: { message: true }, dnd: { enabled: true } });
    push.sent.length = 0;
    await say('三');
    expect(push.sent).toHaveLength(0);

    // 桌面端在线：手机和 mac 都不推
    await call(l, 'PUT', '/users/me/notification-settings', { dnd: { enabled: false } });
    const desk = await ws(l, '&platform=macos');
    push.sent.length = 0;
    await say('四');
    expect(push.sent).toHaveLength(0);
    desk.sock.close();
    await sleep(80);
    await say('五');
    expect(push.sent).toHaveLength(2);

    // 总开关
    await call(l, 'PUT', '/users/me/notification-settings', { enabled: false });
    push.sent.length = 0;
    await say('六');
    expect(push.sent).toHaveLength(0);
    expect((await call(l, 'GET', '/users/me/notification-settings')).json()).toMatchObject({ enabled: false, show_preview: true });
  });

  it.runIf(usePg)('PostgreSQL：重启后字段、视图、通知、通知设置都还在', async () => {
    const { tok, call } = await makeApp();
    const z = await tok('u_zhang');
    const t = await withTable(z, call);
    await call(z, 'POST', `/tables/${t.key}/fields`, { title: '价格', type: 2 });
    await call(await tok('ou_admin'), 'POST', '/tables/projects/fields', { field_name: 'budget', title: '经费', type: 2 });
    const v = (await call(z, 'POST', `/tables/${t.key}/views`, { name: '看板', type: 'kanban', config: { kanban_field: 'status' } })).json();
    await call(z, 'POST', '/tasks', { title: '任务', assignee_id: 'u_li' });
    await call(z, 'PUT', '/users/me/notification-settings', { show_preview: false });
    await sleep(100);

    const again = await makeApp({ reset: false });
    const z2 = await again.tok('u_zhang');
    const tb = (await again.call(z2, 'GET', `/tables/${t.key}`)).json();
    expect(tb.version).toBe(2);
    expect(tb.fields.at(-1)).toMatchObject({ field_name: 'field_1', title: '价格' });
    expect((await again.call(z2, 'POST', `/tables/${t.key}/records`, { fields: { name: 'x', field_1: 9.5 } })).statusCode).toBe(201);
    expect((await again.call(z2, 'POST', '/tables/projects/records', { fields: { title: 'p', budget: 100 } })).statusCode).toBe(201);
    const views = (await again.call(z2, 'GET', `/tables/${t.key}/views`)).json().items as Ev[];
    expect(views.find((x) => x.view_id === v.view_id)).toMatchObject({ type: 'kanban', config: { kanban_field: 'status' } });
    expect((await again.call(await again.tok('u_li'), 'GET', '/notifications/unread-count')).json().count).toBe(1);
    expect((await again.call(z2, 'GET', '/users/me/notification-settings')).json().show_preview).toBe(false);
  });
});
