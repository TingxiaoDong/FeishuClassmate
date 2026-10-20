/**
 * 二期迭代 4 R-SR-01：全局搜索与最近访问。对照《二期迭代4_前端接口需求与进度.md》第 4 节。
 * 设置 CLASSMATEOS_TEST_PG_URL 时同时在 PostgreSQL 上跑（会清空该库）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import { highlight, snippetOf } from '../../classmateos/server/routes-search.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
let pool: pg.Pool | undefined;
afterAll(async () => { await pool?.end(); });
const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];

describe('搜索高亮', () => {
  it('只用 <em>，去掉原文里的 em 标签，不区分大小写', () => {
    expect(highlight('Robot 机械臂 robot', ['robot'])).toBe('<em>Robot</em> 机械臂 <em>robot</em>');
    expect(highlight('<em>假</em>高亮 机械臂', ['机械'])).toBe('假高亮 <em>机械</em>臂');
    expect(highlight('机械臂', ['机械', '械臂'])).toBe('<em>机械臂</em>');
    const s = snippetOf('a'.repeat(100) + '关键词' + 'b'.repeat(100), ['关键词']);
    expect(s.startsWith('…')).toBe(true);
    expect(s).toContain('<em>关键词</em>');
  });
});

describe.each(backends)('二期迭代 4 全局搜索（$name）', ({ usePg }) => {
  async function makeApp() {
    const o: AppOptions = {
      secret: 's', notificationScanner: false, linkPreviewFetcher: null,
      users: [
        { user_id: 'ou_admin', name: '王老师', password: 'pw', role: 'admin' },
        { user_id: 'ou_li', name: '李同学', password: 'pw', role: 'member', department: '机器人组' },
        { user_id: 'ou_zhang', name: '张晓明', password: 'pw', role: 'member' },
        { user_id: 'ou_out', name: '外人', password: 'pw', role: 'member' },
      ],
    };
    if (usePg) {
      pool ??= new pg.Pool({ connectionString: PG_URL, max: 5 });
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await pool.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
      await new PgRepo(pool).init();
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
    const search = async (u: string, qs: string) => {
      const r = await call(u, 'GET', `/search?${qs}`);
      expect(r.statusCode, r.body).toBe(200);
      const groups = r.json().groups as Array<{ type: string; total: number; items: Array<Record<string, any>>; page_token?: string }>;
      return Object.fromEntries(groups.map((g) => [g.type, g]));
    };
    return { app, call, search };
  }

  it('功能开关 search 已打开，wiki 仍关闭', async () => {
    const { app, call } = await makeApp();
    const f = (await call('ou_li', 'GET', '/capabilities')).json().features;
    expect(f.search).toBe(true);
    expect(f.wiki).toBe(false);
    await app.close();
  });

  it('参数校验：空关键词 400，超长 / 未知类型 / 坏游标 422；未登录 401', async () => {
    const { app, call } = await makeApp();
    expect((await call('ou_li', 'GET', '/search?q=')).statusCode).toBe(400);
    expect((await call('ou_li', 'GET', `/search?q=${'字'.repeat(101)}`)).statusCode).toBe(422);
    expect((await call('ou_li', 'GET', '/search?q=x&types=foo')).statusCode).toBe(422);
    expect((await call('ou_li', 'GET', '/search?q=x&types=doc&page_token=-1')).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/api/v1/search?q=x' })).statusCode).toBe(401);
    await app.close();
  });

  it('8 类分组都返回、默认不含 wiki；联系人、群、消息按权限过滤，total 准确', async () => {
    const { app, call, search } = await makeApp();
    const lab = (await call('ou_admin', 'POST', '/chats', { chat_type: 'group', name: '机械臂攻关群', member_ids: ['ou_li'] })).json().chat_id;
    const secret = (await call('ou_admin', 'POST', '/chats', { chat_type: 'group', name: '机械臂保密群', member_ids: ['ou_zhang'] })).json().chat_id;
    for (let i = 0; i < 5; i++) await call('ou_admin', 'POST', `/chats/${lab}/messages`, { msg_type: 'text', content: { text: `机械臂 标定第${i}轮` } });
    await call('ou_admin', 'POST', `/chats/${secret}/messages`, { msg_type: 'text', content: { text: '机械臂 秘密方案' } });

    const all = await search('ou_li', 'q=' + encodeURIComponent('机械臂'));
    expect(Object.keys(all).sort()).toEqual(['chat', 'doc', 'event', 'message', 'record', 'task', 'user']);
    expect(all.chat.total).toBe(1);
    expect(all.chat.items[0].title).toBe('<em>机械臂</em>攻关群');
    expect(all.message.total).toBe(5);
    expect(all.message.items).toHaveLength(3); // 多类型时每组默认 3 条
    expect(all.message.items.every((m) => m.extra.chat_id === lab)).toBe(true);

    // 单类型分页，游标连续、不重复
    const p1 = await search('ou_li', 'q=' + encodeURIComponent('机械臂') + '&types=message&page_size=2');
    expect(p1.message.total).toBe(5);
    expect(p1.message.page_token).toBeTruthy();
    const p2 = await search('ou_li', 'q=' + encodeURIComponent('机械臂') + `&types=message&page_size=2&page_token=${p1.message.page_token}`);
    const p3 = await search('ou_li', 'q=' + encodeURIComponent('机械臂') + `&types=message&page_size=2&page_token=${p2.message.page_token}`);
    const ids = [...p1.message.items, ...p2.message.items, ...p3.message.items].map((m) => m.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.message.page_token).toBeUndefined();

    // 筛选：chat_id、sender_id
    expect((await search('ou_zhang', `q=${encodeURIComponent('机械臂')}&types=message&chat_id=${lab}`)).message.total).toBe(0);
    expect((await search('ou_zhang', `q=${encodeURIComponent('机械臂')}&types=message&sender_id=ou_admin`)).message.total).toBe(1);

    // 联系人：多个词都要出现
    const u = await search('ou_zhang', 'q=' + encodeURIComponent('李') + '&types=user');
    expect(u.user.items.map((x) => x.id)).toEqual(['ou_li']);
    expect(u.user.items[0].title).toBe('<em>李</em>同学');
    expect((await search('ou_zhang', 'q=' + encodeURIComponent('李 不存在') + '&types=user')).user.total).toBe(0);
    await app.close();
  });

  it('文档：私密文档对外人不可见；owner_id / start_ms 筛选；正文命中给片段', async () => {
    const { app, call, search } = await makeApp();
    const open = (await call('ou_li', 'POST', '/docs', { title: '四足步态笔记', markdown: '本周调整了步态参数，四足机器人更稳。' })).json();
    const priv = (await call('ou_li', 'POST', '/docs', { title: '四足私密', markdown: '仅自己' })).json();
    expect((await call('ou_li', 'PUT', `/docs/${priv.doc_id}/permissions`, { link_share: 'off', members: [{ member_type: 'user', member_id: 'ou_zhang', role: 'viewer' }] })).statusCode).toBe(200);

    const out = await search('ou_out', 'q=' + encodeURIComponent('四足') + '&types=doc');
    expect(out.doc.items.map((d) => d.id)).toEqual([open.doc_id]);
    expect(out.doc.total).toBe(1);
    const zhang = await search('ou_zhang', 'q=' + encodeURIComponent('四足') + '&types=doc');
    expect(zhang.doc.total).toBe(2);
    expect((await search('ou_zhang', 'q=' + encodeURIComponent('四足') + '&types=doc&owner_id=ou_admin')).doc.total).toBe(0);
    expect((await search('ou_zhang', 'q=' + encodeURIComponent('四足') + `&types=doc&start_ms=${Date.now() + 86_400_000}`)).doc.total).toBe(0);
    const body = await search('ou_out', 'q=' + encodeURIComponent('步态参数') + '&types=doc');
    expect(body.doc.items[0].snippet).toContain('<em>步态参数</em>');
    expect(body.doc.items[0].extra.owner_id).toBe('ou_li');
    await app.close();
  });

  it('记录、任务、日程：保密记录、别人的任务和日程搜不到', async () => {
    const { app, call, search } = await makeApp();
    expect((await call('ou_li', 'POST', '/tables/projects/records', { fields: { project_id: 'P-1', title: '灵巧手公开项目', owner_open_id: [{ id: 'ou_li' }] } })).statusCode).toBe(201);
    expect((await call('ou_li', 'POST', '/tables/projects/records', { fields: { project_id: 'P-2', title: '灵巧手保密项目', owner_open_id: [{ id: 'ou_li' }], visibility: '保密' } })).statusCode).toBe(201);
    expect((await search('ou_out', 'q=' + encodeURIComponent('灵巧手') + '&types=record')).record.total).toBe(1);
    const mine = await search('ou_li', 'q=' + encodeURIComponent('灵巧手') + '&types=record&table_key=projects');
    expect(mine.record.total).toBe(2);
    expect(mine.record.items[0].extra.table_key).toBe('projects');
    expect((await search('ou_admin', 'q=' + encodeURIComponent('灵巧手') + '&types=record')).record.total).toBe(2);

    await call('ou_li', 'POST', '/tasks', { title: '灵巧手装配', assignee_id: 'ou_zhang' });
    expect((await search('ou_zhang', 'q=' + encodeURIComponent('灵巧手') + '&types=task')).task.total).toBe(1);
    expect((await search('ou_out', 'q=' + encodeURIComponent('灵巧手') + '&types=task')).task.total).toBe(0);

    const t0 = Date.now() + 3_600_000;
    await call('ou_li', 'POST', '/calendar/events', { title: '灵巧手评审会', start_ms: t0, end_ms: t0 + 3_600_000, attendee_ids: ['ou_zhang'] });
    await call('ou_li', 'POST', '/calendar/events', { title: '灵巧手周会', start_ms: t0 - 7 * 86_400_000, end_ms: t0 - 7 * 86_400_000 + 3_600_000, recurrence: 'FREQ=WEEKLY' });
    const ev = await search('ou_li', 'q=' + encodeURIComponent('灵巧手') + '&types=event');
    expect(ev.event.total).toBe(2);
    const weekly = ev.event.items.find((x) => x.title.includes('周会'))!;
    expect(weekly.extra.start_ms).toBeGreaterThan(Date.now()); // 重复日程定位到下一次
    expect(weekly.extra.recurring_event_id).toBe(weekly.id);
    expect((await search('ou_zhang', 'q=' + encodeURIComponent('灵巧手') + '&types=event')).event.total).toBe(1);
    expect((await search('ou_out', 'q=' + encodeURIComponent('灵巧手') + '&types=event')).event.total).toBe(0);
    await app.close();
  });

  it('wiki 分组可请求，未实现时返回空', async () => {
    const { app, search } = await makeApp();
    const r = await search('ou_li', 'q=x&types=wiki');
    expect(r.wiki).toEqual({ type: 'wiki', total: 0, items: [] });
    await app.close();
  });

  it('最近访问：打开详情自动记录，最新在前；失去权限后不再返回', async () => {
    const { app, call } = await makeApp();
    const a = (await call('ou_li', 'POST', '/docs', { title: '文档甲' })).json();
    const b = (await call('ou_li', 'POST', '/docs', { title: '文档乙' })).json();
    expect((await call('ou_zhang', 'GET', `/docs/${a.doc_id}`)).statusCode).toBe(200);
    expect((await call('ou_zhang', 'GET', '/tables/projects')).statusCode).toBe(200);
    expect((await call('ou_zhang', 'GET', `/docs/${b.doc_id}`)).statusCode).toBe(200);
    expect((await call('ou_zhang', 'GET', `/docs/${a.doc_id}`)).statusCode).toBe(200); // 再次打开会排到最前
    // 无权访问的请求不记录
    expect((await call('ou_out', 'GET', '/docs/doc_not_exists')).statusCode).toBe(404);

    let items = (await call('ou_zhang', 'GET', '/recent')).json().items as Array<Record<string, any>>;
    expect(items.map((x) => `${x.type}:${x.title}`)).toEqual(['doc:文档甲', 'doc:文档乙', 'table:' + items[2].title]);
    expect(items[2].id).toBe('projects');
    expect((await call('ou_out', 'GET', '/recent')).json().items).toEqual([]);

    // 收回权限、改名：最近访问跟着变
    await call('ou_li', 'PUT', `/docs/${a.doc_id}/permissions`, { link_share: 'off', members: [] });
    await call('ou_li', 'PATCH', `/docs/${b.doc_id}`, { title: '文档乙（新）' });
    items = (await call('ou_zhang', 'GET', '/recent?page_size=1')).json().items;
    expect(items.map((x) => x.title)).toEqual(['文档乙（新）']);
    await app.close();
  });
});
