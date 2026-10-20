/**
 * 二期迭代 3 收尾：重复日程加固。
 *  - IANA 时区 + 夏令时、全天日程、跨年、远期日期（不再被 5000 次上限截断）；
 *  - 例外实例跨出原时间窗；
 *  - 多条写入原子提交、并发冲突 409；
 *  - 日程类通知 target 带 start_ms（前端 v0.4 约定）。
 * 设置 CLASSMATEOS_TEST_PG_URL 时同时在 PostgreSQL 上跑（会清空该库）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import type { Repo } from '../../classmateos/server/repo.js';
import { expandInWindow, localToUtc, parseRRule, zoneOffsetMs } from '../../classmateos/server/rrule.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
let pool: pg.Pool | undefined;
afterAll(async () => { await pool?.end(); });
const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];

const H = 3600_000;
const D = 24 * H;
const NY = 'America/New_York';
const SH = 'Asia/Shanghai';
const localDay = (t: number, tz: string) => new Date(t + zoneOffsetMs(tz, t)).toISOString().slice(0, 16);

describe('时区换算与展开', () => {
  it('纽约每天 9 点：跨夏令时开始 / 结束都保持本地 9 点', () => {
    const start = Date.UTC(2026, 2, 6, 14, 0); // 2026-03-06 09:00 EST
    const r = parseRRule('FREQ=DAILY;COUNT=4', NY);
    const got = expandInWindow(r, start, H, NY, start, start + 10 * D);
    expect(got.map((t) => localDay(t, NY))).toEqual(['2026-03-06T09:00', '2026-03-07T09:00', '2026-03-08T09:00', '2026-03-09T09:00']);
    // 3 月 8 日起是夏令时，UTC 时间提前一小时
    expect(got[3] - got[1]).toBe(2 * D - H);
    const fall = Date.UTC(2026, 9, 30, 13, 0); // 2026-10-30 09:00 EDT
    const g2 = expandInWindow(parseRRule('FREQ=DAILY;COUNT=4', NY), fall, H, NY, fall, fall + 10 * D);
    expect(g2.map((t) => localDay(t, NY))).toEqual(['2026-10-30T09:00', '2026-10-31T09:00', '2026-11-01T09:00', '2026-11-02T09:00']);
  });

  it('夏令时跳过的本地时间往后顺延；固定偏移仍可用', () => {
    // 2026-03-08 02:30 在纽约不存在 → 03:30 EDT = 07:30 UTC
    expect(localToUtc(NY, Date.UTC(2026, 2, 8, 2, 30))).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(localToUtc(480, Date.UTC(2026, 0, 1, 8, 0))).toBe(Date.UTC(2026, 0, 1, 0, 0));
    expect(zoneOffsetMs(SH, Date.UTC(2026, 6, 1))).toBe(8 * H);
  });

  it('远期日期：每天一次的系列十几年后照常展开（不再被 5000 次上限截断）', () => {
    const start = Date.UTC(2026, 9, 19, 1, 0);
    const r = parseRRule('FREQ=DAILY', SH);
    const from = Date.UTC(2045, 0, 1) - 8 * H;
    const got = expandInWindow(r, start, H, SH, from, from + 7 * D);
    expect(got).toHaveLength(7);
    expect(localDay(got[0], SH)).toBe('2045-01-01T09:00');
    const w = expandInWindow(parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', SH), start, H, SH, from, from + 28 * D);
    // 两周一次，从 2026-10-19 起算的周一
    for (const t of w) expect(Math.round((t - start) / D) % 14).toBe(0);
    expect(w).toHaveLength(2);
  });

  it('跨年与闰日：每周一跨年连续；2 月 29 日的每年规则只在闰年出现', () => {
    const dec28 = Date.UTC(2026, 11, 28, 1, 0); // 周一
    const wk = expandInWindow(parseRRule('FREQ=WEEKLY;BYDAY=MO', SH), dec28, H, SH, dec28, dec28 + 21 * D);
    expect(wk.map((t) => localDay(t, SH).slice(0, 10))).toEqual(['2026-12-28', '2027-01-04', '2027-01-11']);
    const leap = Date.UTC(2028, 1, 29, 1, 0);
    const y = expandInWindow(parseRRule('FREQ=YEARLY', SH), leap, H, SH, leap, Date.UTC(2037, 0, 1));
    expect(y.map((t) => localDay(t, SH).slice(0, 4))).toEqual(['2028', '2032', '2036']);
  });

  it('全天日程：按本地 0 点展开，跨夏令时也不偏', () => {
    const mid = localToUtc(NY, Date.UTC(2026, 2, 7)); // 纽约 3 月 7 日 0 点
    const got = expandInWindow(parseRRule('FREQ=DAILY;COUNT=3', NY), mid, D, NY, mid, mid + 5 * D);
    expect(got.map((t) => localDay(t, NY))).toEqual(['2026-03-07T00:00', '2026-03-08T00:00', '2026-03-09T00:00']);
  });
});

describe.each(backends)('重复日程加固（$name）', ({ usePg }) => {
  async function makeApp() {
    const o: AppOptions = {
      secret: 's', notificationScanner: false,
      users: [
        { user_id: 'ou_admin', name: '王老师', password: 'pw', role: 'admin' },
        { user_id: 'ou_li', name: '李同学', password: 'pw', role: 'member' },
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
    const repo = (app as unknown as { cos: { ctx: { repo: Repo } } }).cos.ctx.repo;
    return { app, call, repo };
  }

  it('功能开关 calendar.recurrence 已打开', async () => {
    const { app } = await makeApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json().features['calendar.recurrence']).toBe(true);
    } finally { await app.close(); }
  });

  it('日程带 timezone：校验、返回、按该时区跨夏令时展开；没带时返回默认时区', async () => {
    const { app, call } = await makeApp();
    try {
      const start = Date.UTC(2026, 2, 6, 14, 0);
      expect((await call('ou_admin', 'POST', '/calendar/events', { title: 'x', start_ms: start, end_ms: start + H, timezone: 'Mars/Base' })).statusCode).toBe(422);
      const c = await call('ou_admin', 'POST', '/calendar/events', { title: '纽约例会', start_ms: start, end_ms: start + H, timezone: NY, recurrence: 'FREQ=DAILY' });
      expect(c.statusCode).toBe(201);
      expect(c.json().timezone).toBe(NY);
      // 窗口 3 天（UTC）：夏令时后 3 月 9 日 9 点 = start + 3 天 - 1 小时，仍在窗口内
      const items = (await call('ou_admin', 'GET', `/calendar/events?start_ms=${start}&end_ms=${start + 3 * D}`)).json().items;
      expect(items.map((e: any) => localDay(e.start_ms, NY))).toEqual(['2026-03-06T09:00', '2026-03-07T09:00', '2026-03-08T09:00', '2026-03-09T09:00']);
      const plain = (await call('ou_admin', 'POST', '/calendar/events', { title: '普通', start_ms: start, end_ms: start + H })).json();
      expect(plain.timezone).toBe(SH);
      // 只改这一次时不能改时区
      expect((await call('ou_admin', 'PATCH', `/calendar/events/${items[1].event_id}?scope=this`, { timezone: SH })).statusCode).toBe(422);
      // 全部改时区：按新时区重新展开
      await call('ou_admin', 'PATCH', `/calendar/events/${c.json().event_id}?scope=all`, { timezone: SH });
      const after = (await call('ou_admin', 'GET', `/calendar/events?start_ms=${start}&end_ms=${start + 4 * D}`)).json().items.filter((e: any) => e.title === '纽约例会');
      expect(new Set(after.map((e: any) => (e.start_ms - start) % D))).toEqual(new Set([0]));
    } finally { await app.close(); }
  });

  it('例外实例挪出原时间窗：原窗口不再出现，新窗口能查到；通知 target 带 start_ms', async () => {
    const { app, call } = await makeApp();
    try {
      const MON9 = Date.UTC(2026, 9, 19, 1, 0);
      const c = (await call('ou_admin', 'POST', '/calendar/events', { title: '组会', start_ms: MON9, end_ms: MON9 + H, attendee_ids: ['ou_li'], recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4' })).json();
      const second = `${c.event_id}`;
      const list = (await call('ou_admin', 'GET', `/calendar/events?start_ms=${MON9}&end_ms=${MON9 + 28 * D}`)).json().items;
      expect(list).toHaveLength(4);
      const moved = MON9 + 60 * D;
      expect((await call('ou_admin', 'PATCH', `/calendar/events/${list[1].event_id}?scope=this`, { start_ms: moved, end_ms: moved + H })).statusCode).toBe(200);
      const w1 = (await call('ou_admin', 'GET', `/calendar/events?start_ms=${MON9}&end_ms=${MON9 + 28 * D}`)).json().items;
      expect(w1.map((e: any) => e.start_ms)).toEqual([MON9, MON9 + 14 * D, MON9 + 21 * D]);
      const w2 = (await call('ou_admin', 'GET', `/calendar/events?start_ms=${moved - D}&end_ms=${moved + D}`)).json().items;
      expect(w2).toHaveLength(1);
      expect(w2[0]).toMatchObject({ is_exception: true, original_start_ms: MON9 + 7 * D, recurring_event_id: second });
      // 删掉整个系列时，挪出去的例外也一起删
      expect((await call('ou_admin', 'DELETE', `/calendar/events/${c.event_id}?scope=all`)).statusCode).toBe(204);
      expect((await call('ou_admin', 'GET', `/calendar/events?start_ms=${moved - D}&end_ms=${moved + D}`)).json().items).toHaveLength(0);
      const ntf = (await call('ou_li', 'GET', '/notifications')).json().items.find((n: any) => n.type === 'calendar.invited');
      expect(ntf.target).toEqual({ type: 'calendar', id: c.event_id, start_ms: MON9 });
    } finally { await app.close(); }
  });

  it('并发：基于旧版本的提交被拒绝，不会丢数据；两个人同时改两次实例结果一致', async () => {
    const { app, call, repo } = await makeApp();
    try {
      const MON9 = Date.UTC(2026, 9, 19, 1, 0);
      const c = (await call('ou_admin', 'POST', '/calendar/events', { title: '组会', start_ms: MON9, end_ms: MON9 + H, recurrence: 'FREQ=WEEKLY;BYDAY=MO' })).json();
      const stale = (await repo.getEvent(c.event_id))!;
      await call('ou_admin', 'DELETE', `/calendar/events/${c.event_id}_r${MON9 + 7 * D}?scope=this`);
      // 用旧版本提交：返回 false，什么都不写
      expect(await repo.commitEvents({ expect: { event_id: stale.event_id, updated_at: stale.updated_at }, save: [{ ...stale, title: '被覆盖' }], remove: [] })).toBe(false);
      expect((await repo.getEvent(c.event_id))!.exdates).toEqual([MON9 + 7 * D]);
      // 同时单独修改两次不同的实例
      const [a, b] = await Promise.all([
        call('ou_admin', 'PATCH', `/calendar/events/${c.event_id}_r${MON9 + 14 * D}?scope=this`, { title: 'A' }),
        call('ou_admin', 'PATCH', `/calendar/events/${c.event_id}_r${MON9 + 21 * D}?scope=this`, { title: 'B' }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect([[200, 200], [200, 409]]).toContainEqual(codes);
      if (codes[1] === 409) expect((codes[1] === b.statusCode ? b : a).json().code).toBe('EVENT_CONFLICT');
      const master = (await repo.getEvent(c.event_id))!;
      const exceptions = await repo.listEventExceptions(c.event_id);
      // 主日程的排除日期和例外实例必须一一对应（没有丢失、没有孤儿）
      expect(master.exdates!.filter((x) => x !== MON9 + 7 * D).sort()).toEqual(exceptions.map((e) => e.original_start_ms).sort());
      expect(exceptions).toHaveLength(codes[1] === 409 ? 1 : 2);
    } finally { await app.close(); }
  });

  it.runIf(usePg)('PostgreSQL：中途出错整批回滚', async () => {
    const { app, call, repo } = await makeApp();
    try {
      const MON9 = Date.UTC(2026, 9, 19, 1, 0);
      const c = (await call('ou_admin', 'POST', '/calendar/events', { title: '组会', start_ms: MON9, end_ms: MON9 + H, recurrence: 'FREQ=DAILY' })).json();
      const m = (await repo.getEvent(c.event_id))!;
      await expect(repo.commitEvents({ save: [{ ...m, event_id: 'bad', title: null as unknown as string }], remove: [c.event_id] })).rejects.toThrow();
      expect(await repo.getEvent(c.event_id)).toBeTruthy();
    } finally { await app.close(); }
  });
});
