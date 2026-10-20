/**
 * 《多维表格新建数据表接口需求》第 5 节验收清单。
 *
 * memory 总是运行；设置 CLASSMATEOS_TEST_PG_URL 时同时跑 PostgreSQL（会清空该库，请用专门的测试库）。
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions, type PlatformUser } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
const USERS: PlatformUser[] = [
  { user_id: 'ou_admin', name: '管理员', password: 'admin', role: 'admin' },
  { user_id: 'u_zhang', name: '张晓明', password: 'pw', role: 'member' },
  { user_id: 'u_li', name: '李华', password: 'pw', role: 'member' },
];

type Ev = Record<string, any>;

let pool: pg.Pool | undefined;
async function resetPg(): Promise<pg.Pool> {
  pool ??= new pg.Pool({ connectionString: PG_URL, max: 5 });
  await pool.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
  await new PgRepo(pool).init();
  const custom = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'tbl\\_%'`);
  for (const r of custom.rows) await pool.query(`DROP TABLE "${r.tablename}"`);
  const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  if (rows.length) await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`);
  return pool;
}

afterAll(async () => {
  await pool?.end();
});

const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];

const sample = (over: Ev = {}) => ({
  name: '设备借用',
  description: '记录实验室设备借用情况',
  primary_field: 'name',
  client_request_id: `table_${Math.random().toString(36).slice(2)}`,
  fields: [
    { field_name: 'name', title: '名称', type: 1, required: true },
    { field_name: 'field_1', title: '状态', type: 3, required: false, options: ['空闲', '借出'] },
    { field_name: 'field_2', title: '借用人', type: 11, required: true },
    { field_name: 'qty', title: '数量', type: 2 },
    { field_name: 'tags', title: '标签', type: 4, options: ['贵重', '易碎'], option_colors: { 贵重: 'red' } },
    { field_name: 'due', title: '归还日期', type: 5 },
    { field_name: 'ok', title: '已检查', type: 7 },
    { field_name: 'link', title: '说明书', type: 15 },
    { field_name: 'files', title: '附件', type: 17 },
  ],
  ...over,
});

describe.each(backends)('新建数据表（$name）', ({ usePg }) => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  async function makeApp(reset = true) {
    const opts: AppOptions = { users: USERS, secret: 's', botToken: 'b' };
    if (usePg) {
      const p = reset ? await resetPg() : pool!;
      const st = new PgTableStore(p);
      await st.ensureMetaColumns();
      opts.repo = new PgRepo(p);
      opts.store = st;
    }
    const app = await buildApp(opts);
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
    return { app, tok, call };
  }

  const errorFields = (r: { json(): Ev }) => (r.json().errors as Ev[]).map((e) => e.field);

  it('合法请求返回 201，带 key 和完整字段定义；GET /tables 能看到且一致', async () => {
    const { tok, call } = await makeApp();
    const z = await tok('u_zhang');
    expect((await call(undefined, 'POST', '/tables', sample())).statusCode).toBe(401);

    const r = await call(z, 'POST', '/tables', sample({ name: '  设备借用  ' }));
    expect(r.statusCode).toBe(201);
    const t = r.json();
    expect(t.key).toMatch(/^tbl_[a-z0-9]+$/);
    expect(t).toMatchObject({
      name: '设备借用',
      description: '记录实验室设备借用情况',
      icon: 'table',
      primary_field: 'name',
      created_by: 'u_zhang',
    });
    expect(t.created_at).toBeTruthy();
    expect(t.updated_at).toBe(t.created_at);
    expect(t.fields).toHaveLength(9);
    expect(t.fields[0]).toMatchObject({ field_name: 'name', title: '名称', type: 1, required: true });
    expect(t.fields[1]).toMatchObject({ field_name: 'field_1', title: '状态', type: 3, required: false, options: ['空闲', '借出'] });
    expect(Object.keys(t.fields[1].option_colors)).toEqual(['空闲', '借出']);
    expect(t.fields[2]).toMatchObject({ field_name: 'field_2', type: 11, required: true });
    expect(t.fields[2].options).toBeUndefined();
    expect(t.fields[3].required).toBe(false); // 省略 required 默认 false
    expect(t.fields[4].option_colors.贵重).toBe('red');

    const list = (await call(z, 'GET', '/tables')).json().items as Ev[];
    const builtinCount = list.filter((x) => x.builtin).length;
    expect(builtinCount).toBeGreaterThan(0);
    expect(list.findIndex((x) => x.key === t.key)).toBe(builtinCount); // 内置表在前
    expect(list.find((x) => x.key === t.key)).toEqual(t);
  });

  it('同一 client_request_id 重复提交不产生第二张表', async () => {
    const { tok, call } = await makeApp();
    const z = await tok('u_zhang');
    const body = sample();
    const first = await call(z, 'POST', '/tables', body);
    expect(first.statusCode).toBe(201);
    const [again, concurrent] = await Promise.all([
      call(z, 'POST', '/tables', body),
      call(z, 'POST', '/tables', { ...body, name: '改了名字也算同一次' }),
    ]);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(concurrent.json().key).toBe(first.json().key);
    const custom = (await call(z, 'GET', '/tables')).json().items.filter((x: Ev) => !x.builtin);
    expect(custom).toHaveLength(1);
  });

  it('新表可新增、编辑、删除记录，并按字段定义返回中文校验错误', async () => {
    const { tok, call } = await makeApp();
    const [z, l] = [await tok('u_zhang'), await tok('u_li')];
    const key = (await call(z, 'POST', '/tables', sample())).json().key;

    // 必填 / 选项 / 类型 / 人员 / 附件 / 未知字段
    const bad = await call(l, 'POST', `/tables/${key}/records`, {
      fields: { field_1: '丢了', qty: '三个', field_x: 1 },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('VALIDATION_FAILED');
    const errs = Object.fromEntries((bad.json().errors as Ev[]).map((e) => [e.field, e.message]));
    expect(errs.name).toBe('必填');
    expect(errs.field_2).toBe('必填');
    expect(errs.field_1).toContain('空闲');
    expect(errs.qty).toBe('必须是数字');
    expect(errs.field_x).toBe('数据表里没有这个字段');

    const badRef = await call(l, 'POST', `/tables/${key}/records`, {
      fields: { name: '示波器', field_2: [{ id: 'nobody' }], files: [{ file_key: 'fk_none' }] },
    });
    expect(badRef.statusCode).toBe(422);
    expect(errorFields(badRef).sort()).toEqual(['field_2', 'files']);

    const due = Date.parse('2026-10-25T00:00:00.000Z');
    const created = await call(l, 'POST', `/tables/${key}/records`, {
      fields: {
        name: '示波器',
        field_1: '借出',
        field_2: [{ id: 'u_zhang' }],
        qty: 2,
        tags: ['贵重'],
        due,
        ok: true,
        link: 'https://example.com/manual',
      },
    });
    expect(created.statusCode).toBe(201);
    const rec = created.json();
    expect(rec.fields).toMatchObject({ name: '示波器', field_1: '借出', qty: 2, tags: ['贵重'], due, ok: true });
    expect(rec.created_by).toBe('u_li');
    await call(l, 'POST', `/tables/${key}/records`, { fields: { name: '万用表', field_2: [{ id: 'u_li' }], qty: 5 } });

    // 筛选 / 排序 / 关键词 / total
    const filtered = (await call(z, 'GET', `/tables/${key}/records?filter=${encodeURIComponent('qty>=3')}`)).json();
    expect(filtered.items.map((r: Ev) => r.fields.name)).toEqual(['万用表']);
    const sorted = (await call(z, 'GET', `/tables/${key}/records?sort=${encodeURIComponent('qty desc')}`)).json();
    expect(sorted.total).toBe(2);
    expect(sorted.items.map((r: Ev) => r.fields.name)).toEqual(['万用表', '示波器']);
    expect((await call(z, 'GET', `/tables/${key}/records?keyword=示波`)).json().total).toBe(1);

    // 编辑：必填不能清空；选项校验；正常修改
    const clear = await call(z, 'PATCH', `/tables/${key}/records/${rec.record_id}`, { fields: { name: '', field_2: [] } });
    expect(clear.statusCode).toBe(422);
    expect(errorFields(clear).sort()).toEqual(['field_2', 'name']);
    const badOpt = await call(z, 'PATCH', `/tables/${key}/records/${rec.record_id}`, { fields: { tags: ['便宜'] } });
    expect(badOpt.statusCode).toBe(422);
    const upd = await call(z, 'PATCH', `/tables/${key}/records/${rec.record_id}`, { fields: { field_1: '空闲', qty: null } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().fields.field_1).toBe('空闲');
    expect(upd.json().fields.qty).toBeUndefined();
    expect(upd.json().updated_by).toBe('u_zhang');
    expect((await call(z, 'GET', `/tables/${key}/records/${rec.record_id}`)).json().fields.field_1).toBe('空闲');

    // 删除
    expect((await call(z, 'DELETE', `/tables/${key}/records/${rec.record_id}`)).statusCode).toBe(204);
    expect((await call(z, 'GET', `/tables/${key}/records/${rec.record_id}`)).statusCode).toBe(404);
    expect((await call(z, 'GET', `/tables/tbl_nope/records`)).statusCode).toBe(404);
  });

  it('主字段不存在、不是文本、不是必填时返回 422', async () => {
    const { tok, call } = await makeApp();
    const z = await tok('u_zhang');
    const cases: Ev[] = [
      sample({ primary_field: 'missing' }),
      sample({ primary_field: 'qty' }),
      sample({ primary_field: 'name', fields: [{ field_name: 'name', title: '名称', type: 1, required: false }] }),
      sample({ primary_field: undefined }),
    ];
    for (const body of cases) {
      const r = await call(z, 'POST', '/tables', body);
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe('VALIDATION_FAILED');
      expect(errorFields(r)).toContain('primary_field');
      expect(r.json().errors[0].message).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('字段名不合法、字段名 / 显示名重复、单选多选缺选项等返回 422（带字段路径）', async () => {
    const { tok, call } = await makeApp();
    const z = await tok('u_zhang');
    const name = { field_name: 'name', title: '名称', type: 1, required: true };
    const check = async (fields: Ev[], path: string, extra: Ev = {}) => {
      const r = await call(z, 'POST', '/tables', sample({ fields, ...extra }));
      expect(r.statusCode, path).toBe(422);
      expect(r.json().message).toBe('字段校验失败');
      expect(errorFields(r), JSON.stringify(r.json())).toContain(path);
    };
    await check([name, { field_name: 'Bad-Name', title: 'x', type: 1 }], 'fields[1].field_name');
    await check([name, { field_name: '1abc', title: 'x', type: 1 }], 'fields[1].field_name');
    await check([name, { field_name: 'record_id', title: 'x', type: 1 }], 'fields[1].field_name');
    await check([name, { field_name: 'name', title: '另一个', type: 1 }], 'fields[1].field_name');
    await check([name, { field_name: 'n2', title: ' 名称 ', type: 1 }], 'fields[1].title');
    await check([name, { field_name: 'n2', title: '', type: 1 }], 'fields[1].title');
    await check([name, { field_name: 's', title: '状态', type: 3 }], 'fields[1].options');
    await check([name, { field_name: 's', title: '状态', type: 4, options: [] }], 'fields[1].options');
    await check([name, { field_name: 's', title: '状态', type: 3, options: ['a', ' a '] }], 'fields[1].options[1]');
    await check([name, { field_name: 's', title: '状态', type: 3, options: ['a', ''] }], 'fields[1].options[1]');
    await check([name, { field_name: 's', title: '文本', type: 1, options: ['a'] }], 'fields[1].options');
    await check([name, { field_name: 'rel', title: '关联', type: 18 }], 'fields[1].type');
    await check([name, { field_name: 'x', title: '未知', type: 99 }], 'fields[1].type');
    await check([name, { field_name: 'x', title: 'x', type: 1, required: 'yes' }], 'fields[1].required');
    await check([], 'fields');
    await check(Array.from({ length: 31 }, (_, i) => ({ field_name: i ? `f${i}` : 'name', title: `t${i}`, type: 1, required: true })), 'fields');
    await check([name], 'name', { name: '   ' });
    await check([name], 'name', { name: '名'.repeat(61) });
    await check([name], 'description', { description: '长'.repeat(501) });
    // 边界：60 字表名、30 个字段、50 个选项合法
    const ok = await call(
      z,
      'POST',
      '/tables',
      sample({
        name: '表'.repeat(60),
        fields: [
          name,
          { field_name: 's', title: '状态', type: 3, options: Array.from({ length: 50 }, (_, i) => `选项${i}`) },
          ...Array.from({ length: 28 }, (_, i) => ({ field_name: `f${i}`, title: `字段${i}`, type: 1 })),
        ],
      }),
    );
    expect(ok.statusCode).toBe(201);
  });

  it('表名重复返回 409 TABLE_NAME_EXISTS（大小写不敏感，含内置表名）', async () => {
    const { tok, call } = await makeApp();
    const [z, l] = [await tok('u_zhang'), await tok('u_li')];
    expect((await call(z, 'POST', '/tables', sample({ name: 'Device Log' }))).statusCode).toBe(201);
    const dup = await call(l, 'POST', '/tables', sample({ name: ' device log ' }));
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('TABLE_NAME_EXISTS');
    expect(dup.json().message).toMatch(/[\u4e00-\u9fa5]/);
    const builtin = await call(l, 'POST', '/tables', sample({ name: '项目' }));
    expect(builtin.statusCode).toBe(409);
  });

  it.skipIf(!usePg)('PostgreSQL 模式下重启后新表和记录仍在', async () => {
    const first = await makeApp();
    const z = await first.tok('u_zhang');
    const body = sample();
    const t = (await first.call(z, 'POST', '/tables', body)).json();
    const rec = (
      await first.call(z, 'POST', `/tables/${t.key}/records`, {
        fields: { name: '示波器', field_2: [{ id: 'u_zhang' }], qty: 3, tags: ['易碎'], due: 1760000000000 },
      })
    ).json();
    await apps.splice(0).pop()!.close();

    const second = await makeApp(false);
    const z2 = await second.tok('u_zhang');
    const list = (await second.call(z2, 'GET', '/tables')).json().items as Ev[];
    expect(list.find((x) => x.key === t.key)).toEqual(t);
    const got = (await second.call(z2, 'GET', `/tables/${t.key}/records/${rec.record_id}`)).json();
    expect(got.fields).toMatchObject({ name: '示波器', qty: 3, tags: ['易碎'], due: 1760000000000, field_2: [{ id: 'u_zhang' }] });
    // 重启后幂等记录仍有效
    const again = await second.call(z2, 'POST', '/tables', body);
    expect(again.statusCode).toBe(200);
    expect(again.json().key).toBe(t.key);
    // 名称唯一由数据库兜底
    expect((await second.call(z2, 'POST', '/tables', sample({ name: '设备借用' }))).statusCode).toBe(409);
    // 物理表确实存在
    const { rows } = await pool!.query('SELECT count(*)::int AS n FROM ' + `"${t.key}"`);
    expect(rows[0].n).toBe(1);
  });
});
