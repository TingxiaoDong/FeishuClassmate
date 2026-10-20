/**
 * 《前端接口需求文档》第 14 节验收清单（契约测试）。
 *
 * 同一套用例跑两种后端：
 *   - memory：总是运行；
 *   - postgres：设置 CLASSMATEOS_TEST_PG_URL 时运行（会清空该库里的表，请用专门的测试库），
 *     例如 CLASSMATEOS_TEST_PG_URL=postgresql://postgres@localhost/cos_test
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';
import { buildApp, type AppOptions, type PlatformUser } from '../../classmateos/server/app.js';
import { signToken } from '../../classmateos/server/auth.js';
import { LocalFileStore } from '../../classmateos/server/files.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
const SECRET = 'contract-secret';
const USERS: PlatformUser[] = [
  { user_id: 'admin', name: '管理员', password: 'admin', role: 'admin' },
  { user_id: 'u_zhang', name: '张晓明', password: 'pw', role: 'member', department: '机器人组' },
  { user_id: 'u_li', name: '李华', password: 'pw', role: 'member' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HAN = /[\u4e00-\u9fa5]/;

type Ev = Record<string, any>;

let pool: pg.Pool | undefined;
async function resetPg(): Promise<pg.Pool> {
  pool ??= new pg.Pool({ connectionString: PG_URL, max: 5 });
  await pool.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
  await new PgRepo(pool).init();
  const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  if (rows.length) await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`);
  return pool;
}

afterAll(async () => {
  await pool?.end();
});

const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];

describe.each(backends)('前端接口验收清单（$name）', ({ usePg }) => {
  const apps: FastifyInstance[] = [];
  const sockets: WebSocket[] = [];
  const fileStore = new LocalFileStore({
    dir: mkdtempSync(join(tmpdir(), 'cos-contract-')),
    urlPrefix: '/api/v1/files',
    secret: SECRET,
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    for (const a of apps.splice(0)) await a.close();
  });

  async function makeApp(reset = true) {
    const opts: AppOptions = { users: USERS, secret: SECRET, botToken: 'btok', fileStore, heartbeatMs: 300 };
    if (usePg) {
      const p = reset ? await resetPg() : pool!;
      const st = new PgTableStore(p);
      await st.ensureMetaColumns();
      opts.repo = new PgRepo(p);
      opts.store = st;
    }
    const app = await buildApp(opts);
    await app.listen({ port: 0, host: '127.0.0.1' });
    apps.push(app);
    const port = (app.server.address() as AddressInfo).port;

    const login = async (username: string, password: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
      expect(r.statusCode).toBe(200);
      return r.json() as { access_token: string; refresh_token: string; user: Ev };
    };
    const tok = async (u: string) => (await login(u, u === 'admin' ? 'admin' : 'pw')).access_token;
    const call = (token: string | undefined, method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as 'GET',
        url: `/api/v1${url}`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload: payload as Record<string, unknown> | undefined,
      });
    const bot = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/api/v1/bot/messages', headers: { 'x-bot-token': 'btok' }, payload: payload as Ev });

    const ws = (path: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      sockets.push(socket);
      const events: Ev[] = [];
      socket.on('message', (d) => {
        try {
          events.push(JSON.parse(String(d)));
        } catch {
          // 协同通道是二进制帧
        }
      });
      const closed = new Promise<number>((r) => socket.on('close', (c) => r(c)));
      const opened = new Promise<void>((res, rej) => {
        socket.once('open', () => res());
        socket.once('error', rej);
      });
      const waitFor = async (pred: (e: Ev) => boolean, ms = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const hit = events.find(pred);
          if (hit) return hit;
          await sleep(20);
        }
        throw new Error(`等待事件超时，已收到：${JSON.stringify(events.map((e) => e.event_type))}`);
      };
      return { socket, events, closed, opened, waitFor };
    };
    const userWs = async (token: string, since?: string) => {
      const c = ws(`/api/v1/events/ws?token=${encodeURIComponent(token)}${since ? `&since=${since}` : ''}`);
      await c.opened;
      await sleep(50); // 等服务端查完账号
      return c;
    };
    return { app, port, login, tok, call, bot, ws, userWs };
  }

  const send = async (call: Awaited<ReturnType<typeof makeApp>>['call'], token: string, chatId: string, text: string) => {
    const r = await call(token, 'POST', `/chats/${chatId}/messages`, { msg_type: 'text', content: { text } });
    expect(r.statusCode).toBe(201);
    return r.json() as Ev;
  };

  // ======================= P0 =======================

  it('P0 非会话成员读写消息返回 403', async () => {
    const { tok, call } = await makeApp();
    const [a, l] = [await tok('admin'), await tok('u_li')];
    const chat = (await call(a, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] })).json();
    expect((await call(l, 'GET', `/chats/${chat.chat_id}/messages`)).statusCode).toBe(403);
    const post = await call(l, 'POST', `/chats/${chat.chat_id}/messages`, { msg_type: 'text', content: { text: 'x' } });
    expect(post.statusCode).toBe(403);
    expect(post.json().code).toBe('CHAT_NOT_MEMBER');
    expect((await call(l, 'GET', '/chats/chat_none/messages')).statusCode).toBe(404);
  });

  it('P0 未读数 / 最后一条 / 排序；标记已读后清零并推送 message.read', async () => {
    const { tok, call, userWs } = await makeApp();
    const [a, z, l] = [await tok('admin'), await tok('u_zhang'), await tok('u_li')];
    const other = (await call(l, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] })).json();
    await send(call, l, other.chat_id, '早');
    await sleep(5);
    const chat = (await call(a, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] })).json();
    for (const t of ['1', '2', '3']) await send(call, a, chat.chat_id, t);

    const list = (await call(z, 'GET', '/chats')).json();
    expect(list.items[0].chat_id).toBe(chat.chat_id);
    expect(list.items[0].unread_count).toBe(3);
    expect(list.items[0].last_message.content.text).toBe('3');
    expect(list.items[1].unread_count).toBe(1);
    // 发送者自己不算未读
    expect((await call(a, 'GET', '/chats')).json().items[0].unread_count).toBe(0);

    const ws2 = await userWs(z);
    expect((await call(z, 'POST', `/chats/${chat.chat_id}/read`, {})).statusCode).toBe(204);
    const ev = await ws2.waitFor((e) => e.event_type === 'message.read');
    expect(ev.read).toMatchObject({ chat_id: chat.chat_id, user_id: 'u_zhang' });
    expect(ev.audience).toBeUndefined();
    const after = (await call(z, 'GET', `/chats/${chat.chat_id}`)).json();
    expect(after.unread_count).toBe(0);
    expect(after.last_read_message_id).toBe(after.last_message.message_id);
  });

  it('P0 消息分页：120 条按 50 条一页倒序取完，不重不漏', async () => {
    const { tok, call } = await makeApp();
    const a = await tok('admin');
    const chat = (await call(a, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] })).json();
    for (let i = 1; i <= 120; i++) await send(call, a, chat.chat_id, String(i));

    const texts: string[] = [];
    let before: string | undefined;
    const pages: Array<{ n: number; more: boolean }> = [];
    for (let i = 0; i < 5; i++) {
      const r = (
        await call(a, 'GET', `/chats/${chat.chat_id}/messages?page_size=50${before ? `&before_message_id=${before}` : ''}`)
      ).json();
      texts.push(...r.items.map((m: Ev) => m.content.text));
      pages.push({ n: r.items.length, more: r.has_more });
      if (!r.has_more) break;
      before = r.items[r.items.length - 1].message_id;
    }
    expect(pages).toEqual([
      { n: 50, more: true },
      { n: 50, more: true },
      { n: 20, more: false },
    ]);
    expect(texts).toEqual(Array.from({ length: 120 }, (_, i) => String(120 - i)));

    // after_message_id：正序补消息
    const mid = (await call(a, 'GET', `/chats/${chat.chat_id}/messages?page_size=1&before_message_id=${before}`)).json();
    expect(mid.items.length).toBe(1);
    const after = (await call(a, 'GET', `/chats/${chat.chat_id}/messages?page_size=3&after_message_id=${mid.items[0].message_id}`)).json();
    expect(after.items.map((m: Ev) => m.content.text)).toEqual(['21', '22', '23']);
    expect(after.has_more).toBe(true);
  });

  it('P0 卡片回答写回 content.answer；重复回答 409；成员收到 message.updated', async () => {
    const { tok, call, bot, userWs } = await makeApp();
    const [a, z, l] = [await tok('admin'), await tok('u_zhang'), await tok('u_li')];
    const chat = (await call(a, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] })).json();
    const sent = await bot({
      receive_id: chat.chat_id,
      msg_type: 'interactive_card',
      content: { card_id: 'card_001', question: '组会改到周四可以吗？', options: ['可以', '不行'] },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().content.answer).toBeNull();
    const zws = await userWs(z);

    expect((await call(l, 'POST', '/cards/card_001/actions', { action: '可以' })).statusCode).toBe(403);
    const ok = await call(a, 'POST', '/cards/card_001/actions', { action: '可以', form_values: {} });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ accepted: true });

    const msgs = (await call(z, 'GET', `/chats/${chat.chat_id}/messages`)).json().items as Ev[];
    const card = msgs.find((m) => m.msg_type === 'interactive_card')!;
    expect(card.content.answer).toMatchObject({ user_id: 'admin', action: '可以' });
    expect(card.updated_at).toBeTruthy();

    const again = await call(z, 'POST', '/cards/card_001/actions', { action: '不行' });
    expect(again.statusCode).toBe(409);
    expect(again.json().answer.action).toBe('可以');

    const upd = await zws.waitFor((e) => e.event_type === 'message.updated');
    expect(upd.message.content.answer.action).toBe('可以');
    expect(zws.events.some((e) => e.event_type === 'card.action')).toBe(false);
  });

  it('P0 refresh_token 不能当 access 用；刷新换新令牌；过期令牌连 WS 被 4401 关闭', async () => {
    const { login, call, ws } = await makeApp();
    const t = await login('admin', 'admin');
    expect((await call(t.refresh_token, 'GET', '/users/me')).statusCode).toBe(401);

    const r = await call(undefined, 'POST', '/auth/refresh', { refresh_token: t.refresh_token });
    expect(r.statusCode).toBe(200);
    const fresh = r.json();
    expect(fresh.access_token).toBeTruthy();
    expect(fresh.refresh_token).not.toBe(t.refresh_token);
    expect((await call(fresh.access_token, 'GET', '/users/me')).json().user_id).toBe('admin');
    // 旧 refresh_token 已轮换作废
    const reuse = await call(undefined, 'POST', '/auth/refresh', { refresh_token: t.refresh_token });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('REFRESH_EXPIRED');

    const expired = signToken({ sub: 'admin', name: '管理员', role: 'admin' }, SECRET, -1000);
    expect((await call(expired, 'GET', '/users/me')).statusCode).toBe(401);
    const c = ws(`/api/v1/events/ws?token=${expired}`);
    expect(await c.closed).toBe(4401);
    // 登出后 refresh_token 失效
    expect((await call(undefined, 'POST', '/auth/logout', { refresh_token: fresh.refresh_token })).statusCode).toBe(204);
    expect((await call(undefined, 'POST', '/auth/refresh', { refresh_token: fresh.refresh_token })).statusCode).toBe(401);
  });

  it.skipIf(!usePg)('P0 后端重启后数据仍在（PostgreSQL）', async () => {
    const first = await makeApp();
    const a = await first.tok('admin');
    const chat = (await first.call(a, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] })).json();
    await send(first.call, a, chat.chat_id, '重启前的消息');
    const rec = (await first.call(a, 'POST', '/tables/projects/records', { fields: { title: '四足机器人步态', status: '进行中' } })).json();
    const doc = (await first.call(a, 'POST', '/docs', { title: '组会纪要', markdown: '# 纪要' })).json();
    const task = (await first.call(a, 'POST', '/tasks', { title: '整理数据', assignee_id: 'u_zhang' })).json();
    await apps.splice(0).pop()!.close();

    const second = await makeApp(false);
    const z = await second.tok('u_zhang');
    const chats = (await second.call(z, 'GET', '/chats')).json();
    expect(chats.items[0]).toMatchObject({ chat_id: chat.chat_id, unread_count: 1 });
    expect(chats.items[0].last_message.content.text).toBe('重启前的消息');
    expect((await second.call(z, 'GET', `/tables/projects/records/${rec.record_id}`)).json().fields.title).toBe('四足机器人步态');
    expect((await second.call(z, 'GET', `/docs/${doc.doc_id}`)).json().markdown).toBe('# 纪要');
    expect((await second.call(z, 'GET', '/tasks')).json().items.map((t: Ev) => t.task_id)).toContain(task.task_id);
  });

  // ======================= P1 =======================

  it('P1 /users/me 与 /users 中本人一致；成员带部门', async () => {
    const { tok, call } = await makeApp();
    const z = await tok('u_zhang');
    const me = (await call(z, 'GET', '/users/me')).json();
    const list = (await call(z, 'GET', '/users')).json();
    // 迭代 5：/users/me 多带本人的 permissions，通讯录里不带，其余字段一致
    const { permissions, ...meBase } = me;
    expect(Array.isArray(permissions)).toBe(true);
    expect(list.items.find((u: Ev) => u.user_id === 'u_zhang')).toEqual(meBase);
    expect(me.department).toBe('机器人组');
    expect(me.password_hash).toBeUndefined();
    expect(list.total).toBe(list.items.length);
  });

  it('P1 单聊去重；一个成员也能建群；只有自己的「我的云盘」会话', async () => {
    const { tok, call } = await makeApp();
    const a = await tok('admin');
    const c1 = await call(a, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] });
    const c2 = await call(a, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] });
    expect(c1.statusCode).toBe(201);
    expect(c2.statusCode).toBe(200);
    expect(c2.json().chat_id).toBe(c1.json().chat_id);
    const z = await tok('u_zhang');
    expect((await call(z, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['admin'] })).json().chat_id).toBe(c1.json().chat_id);

    const g = (await call(a, 'POST', '/chats', { chat_type: 'group', member_ids: ['u_zhang'], name: 'x' })).json();
    expect(g.chat_type).toBe('group');
    expect(g.owner_id).toBe('admin');

    const drive = await call(a, 'POST', '/chats', { name: '我的云盘', member_ids: [] });
    expect(drive.statusCode).toBe(201);
    expect(drive.json()).toMatchObject({ kind: 'drive', member_ids: ['admin'] });
    expect((await call(a, 'POST', '/chats', { member_ids: ['nobody'] })).statusCode).toBe(422);
  });

  it('P1 改群名、加人、退群各插入 system 消息并推送事件', async () => {
    const { tok, call, userWs } = await makeApp();
    const [a, l] = [await tok('admin'), await tok('u_li')];
    const aws = await userWs(a);
    const lws = await userWs(l);
    const g = (await call(a, 'POST', '/chats', { chat_type: 'group', member_ids: ['u_zhang'], name: '项目组' })).json();
    await aws.waitFor((e) => e.event_type === 'chat.created');

    expect((await call(a, 'PATCH', `/chats/${g.chat_id}`, { name: '四足项目组' })).json().name).toBe('四足项目组');
    await aws.waitFor((e) => e.event_type === 'chat.updated' && e.chat.name === '四足项目组');
    expect((await call(a, 'POST', `/chats/${g.chat_id}/members`, { member_ids: ['u_li'] })).statusCode).toBe(200);
    await aws.waitFor((e) => e.event_type === 'chat.member_added');
    await lws.waitFor((e) => e.event_type === 'chat.member_added');
    expect((await call(l, 'DELETE', `/chats/${g.chat_id}/members/u_li`)).statusCode).toBe(204);
    await aws.waitFor((e) => e.event_type === 'chat.member_removed' && e.user_id === 'u_li');
    await lws.waitFor((e) => e.event_type === 'chat.member_removed');

    const sys = (await call(a, 'GET', `/chats/${g.chat_id}/messages`)).json().items.filter((m: Ev) => m.msg_type === 'system');
    const texts = sys.map((m: Ev) => m.content.text).reverse();
    expect(texts).toEqual([
      '管理员 创建了群聊',
      '管理员 将群名修改为「四足项目组」',
      '管理员 邀请 李华 加入了群聊',
      '李华 退出了群聊',
    ]);
    // 被移出的人看不到这个会话了
    expect((await call(l, 'GET', '/chats')).json().items.map((c: Ev) => c.chat_id)).not.toContain(g.chat_id);
    // 普通成员不能改群名
    const z = await tok('u_zhang');
    expect((await call(z, 'PATCH', `/chats/${g.chat_id}`, { name: 'y' })).statusCode).toBe(403);
  });

  it('P1 WS 断开后带 since 重连补齐消息；since 无效时要求 resync；心跳与客户端 ping 不断开', async () => {
    const { tok, call, userWs } = await makeApp();
    const [a, z] = [await tok('admin'), await tok('u_zhang')];
    const chat = (await call(a, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] })).json();
    const w1 = await userWs(z);
    await send(call, a, chat.chat_id, '断线前');
    const last = await w1.waitFor((e) => e.event_type === 'message.receive');
    w1.socket.close();
    await sleep(50);
    await send(call, a, chat.chat_id, '断线中 1');
    await send(call, a, chat.chat_id, '断线中 2');

    const w2 = await userWs(z, last.event_id);
    await w2.waitFor((e) => e.message?.content?.text === '断线中 2');
    const texts = w2.events.filter((e) => e.event_type === 'message.receive').map((e) => e.message.content.text);
    expect(texts).toEqual(['断线中 1', '断线中 2']);

    w2.socket.send(JSON.stringify({ type: 'ping' }));
    await w2.waitFor((e) => e.event_type === 'pong');
    await w2.waitFor((e) => e.event_type === 'ping', 2000);
    expect(w2.socket.readyState).toBe(WebSocket.OPEN);

    const w3 = await userWs(z, 'evt_too_old');
    await w3.waitFor((e) => e.event_type === 'resync.required');
  });

  it('P1 下载带正确 Content-Type 与中文文件名；云盘 scope 过滤与下载权限', async () => {
    const { tok, call, app } = await makeApp();
    const [a, z, l] = [await tok('admin'), await tok('u_zhang'), await tok('u_li')];
    const upload = async (token: string, name: string, body: Buffer, type?: string) => {
      const g = (await call(token, 'POST', '/files/upload-url', { file_name: name, size: body.length, content_type: type })).json();
      const put = await app.inject({
        method: 'PUT',
        url: g.upload_url,
        headers: { 'content-type': 'application/octet-stream' },
        payload: body,
      });
      expect(put.statusCode).toBe(201);
      return g.file_key as string;
    };

    const pdf = await upload(a, '报告.pdf', Buffer.from('%PDF-1.4 test'));
    const dl = (await call(a, 'GET', `/files/${pdf}/download-url`)).json();
    const got = await app.inject({ method: 'GET', url: dl.download_url });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('application/pdf');
    expect(String(got.headers['content-disposition'])).toContain(`filename*=UTF-8''${encodeURIComponent('报告.pdf')}`);
    expect(got.body).toBe('%PDF-1.4 test');
    const ranged = await app.inject({ method: 'GET', url: dl.download_url, headers: { range: 'bytes=0-3' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('%PDF');

    // admin 上传到云盘；张在与李的单聊里发图片（admin 不在）
    expect((await call(a, 'POST', `/files/${pdf}/drive`)).json()).toMatchObject({ file_name: '报告.pdf', kind: 'pdf', source: { type: 'drive' } });
    const png = await upload(z, '实验.png', Buffer.from('png-bytes'));
    const zl = (await call(z, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_li'] })).json();
    expect((await call(z, 'POST', `/chats/${zl.chat_id}/messages`, { msg_type: 'image', content: { file_key: png } })).statusCode).toBe(201);

    const mine = (await call(a, 'GET', '/files?scope=mine')).json();
    expect(mine.items.map((f: Ev) => f.file_name)).toEqual(['报告.pdf']);
    const aShared = (await call(a, 'GET', '/files?scope=shared')).json();
    expect(aShared.items.map((f: Ev) => f.file_key)).not.toContain(png);
    const lShared = (await call(l, 'GET', '/files?scope=shared')).json();
    expect(lShared.items[0]).toMatchObject({ file_key: png, kind: 'image', source: { type: 'chat', chat_id: zl.chat_id } });
    expect((await call(l, 'GET', '/files?kind=pdf')).json().items).toHaveLength(0);
    expect((await call(a, 'GET', `/files/${png}/download-url`)).statusCode).toBe(404);
    expect((await call(l, 'GET', `/files/${png}/download-url`)).statusCode).toBe(200);
    // 别人的文件不能拿来发消息
    expect(
      (await call(a, 'POST', `/chats/${zl.chat_id}/messages`, { msg_type: 'image', content: { file_key: png } })).statusCode,
    ).toBe(403);

    const usage = (await call(a, 'GET', '/files/usage')).json();
    expect(usage.used).toBe(Buffer.from('%PDF-1.4 test').length);
    expect(usage.quota).toBe(10 * 1024 ** 3);
    expect((await call(z, 'DELETE', `/files/${pdf}`)).statusCode).toBe(404);
    expect((await call(a, 'DELETE', `/files/${pdf}`)).statusCode).toBe(204);
    expect((await call(a, 'GET', '/files?scope=mine')).json().items).toHaveLength(0);

    const tooBig = await call(a, 'POST', '/files/upload-url', { file_name: 'big.zip', size: 300 * 1024 * 1024 });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().message).toBe('文件不能超过 200 MB');
  });

  it('P1 表格字段带中文 title；记录列表带 total；422 错误为中文；人员必须存在', async () => {
    const { tok, call } = await makeApp();
    const a = await tok('admin');
    const tables = (await call(a, 'GET', '/tables')).json().items as Ev[];
    expect(tables.length).toBeGreaterThan(10);
    for (const t of tables) {
      expect(t.primary_field).toBeTruthy();
      for (const f of t.fields) expect(typeof f.title === 'string' && f.title.length > 0).toBe(true);
    }
    const projects = tables.find((t) => t.key === 'projects')!;
    expect(projects.name).toBe('项目');
    expect(projects.fields.find((f: Ev) => f.field_name === 'status').title).toBe('状态');

    for (const title of ['四足机器人步态', '机械臂抓取', '视觉导航']) {
      const r = await call(a, 'POST', '/tables/projects/records', { fields: { title, status: '进行中', owner_open_id: [{ id: 'u_zhang', name: '张晓明' }] } });
      expect(r.statusCode).toBe(201);
      expect(r.json().created_by).toBe('admin');
    }
    const page = (await call(a, 'GET', '/tables/projects/records?page_size=2')).json();
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.has_more).toBe(true);
    const page2 = (await call(a, 'GET', `/tables/projects/records?page_size=2&page_token=${page.page_token}`)).json();
    expect(page2.items).toHaveLength(1);
    expect(page2.has_more).toBe(false);
    expect((await call(a, 'GET', '/tables/projects/records?keyword=机械')).json().total).toBe(1);
    expect((await call(a, 'GET', '/tables/projects/records?filter=' + encodeURIComponent('status="进行中"'))).json().total).toBe(3);

    const bad = await call(a, 'POST', '/tables/projects/records', { fields: { status: '不存在的状态', nope: 1 } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toBe('字段校验失败');
    for (const e of bad.json().errors) expect(e.message).toMatch(HAN);
    const ghost = await call(a, 'POST', '/tables/projects/records', { fields: { title: 'x', owner_open_id: [{ id: 'ghost' }] } });
    expect(ghost.statusCode).toBe(422);
    expect(ghost.json().errors[0].message).toContain('ghost');
    const badFilter = await call(a, 'GET', '/tables/projects/records?filter=' + encodeURIComponent('nope="1"'));
    expect(badFilter.statusCode).toBe(422);

    // null 清空字段
    const rec = page.items[0];
    const cleared = (await call(a, 'PATCH', `/tables/projects/records/${rec.record_id}`, { fields: { status: null } })).json();
    expect(cleared.fields.status).toBeUndefined();
    expect(cleared.updated_by).toBe('admin');
  });

  it('P1 修改日程（仅创建者）；参与人必须存在；回复邀请', async () => {
    const { tok, call, userWs } = await makeApp();
    const [a, z] = [await tok('admin'), await tok('u_zhang')];
    const zws = await userWs(z);
    const base = 1792387800000;
    const created = await call(a, 'POST', '/calendar/events', {
      title: '项目周会',
      start_ms: base,
      end_ms: base + 3600_000,
      attendee_ids: ['u_zhang'],
      location: '实验楼 302',
    });
    expect(created.statusCode).toBe(201);
    const ev = created.json();
    expect(ev).toMatchObject({ attendee_ids: ['admin', 'u_zhang'], location: '实验楼 302', all_day: false });
    expect(ev.created_at).toBeTruthy();
    await zws.waitFor((e) => e.event_type === 'calendar.invited' && e.event.event_id === ev.event_id);

    const moved = await call(a, 'PATCH', `/calendar/events/${ev.event_id}`, { start_ms: base + 7200_000, end_ms: base + 10800_000 });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ start_ms: base + 7200_000, end_ms: base + 10800_000, title: '项目周会' });
    expect((await call(z, 'PATCH', `/calendar/events/${ev.event_id}`, { title: 'x' })).statusCode).toBe(403);
    expect((await call(a, 'PATCH', `/calendar/events/${ev.event_id}`, { end_ms: base })).statusCode).toBe(422);
    expect((await call(a, 'POST', '/calendar/events', { title: 'x', start_ms: base, end_ms: base + 1, attendee_ids: ['ghost'] })).statusCode).toBe(422);

    const rsvp = (await call(z, 'POST', `/calendar/events/${ev.event_id}/rsvp`, { rsvp: 'accepted' })).json();
    expect(rsvp.attendees.find((x: Ev) => x.user_id === 'u_zhang').rsvp).toBe('accepted');
    const list = (await call(z, 'GET', `/calendar/events?from=${base}&to=${base + 86400_000}`)).json();
    expect(list.items.map((e: Ev) => e.event_id)).toEqual([ev.event_id]);
    expect((await call(z, 'DELETE', `/calendar/events/${ev.event_id}`)).statusCode).toBe(403);
    expect((await call(a, 'DELETE', `/calendar/events/${ev.event_id}`)).statusCode).toBe(204);
  });

  it('P1 任务：改负责人、清空截止时间、completed_at；非创建者删除 403', async () => {
    const { tok, call, userWs } = await makeApp();
    const [a, l] = [await tok('admin'), await tok('u_li')];
    const lws = await userWs(l);
    const t = (await call(a, 'POST', '/tasks', { title: '  整理实验数据  ', assignee_id: 'u_zhang', due_ms: 1792387800000 })).json();
    expect(t).toMatchObject({ title: '整理实验数据', status: 'pending', priority: 'normal', completed_at: null });
    expect((await call(a, 'POST', '/tasks', { title: '   ' })).statusCode).toBe(422);
    expect((await call(a, 'POST', '/tasks', { title: 'x', assignee_id: 'ghost' })).statusCode).toBe(422);

    const p = await call(a, 'PATCH', `/tasks/${t.task_id}`, { assignee_id: 'u_li', due_ms: null });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ assignee_id: 'u_li', due_ms: null });
    await lws.waitFor((e) => e.event_type === 'task.assigned' && e.task.task_id === t.task_id);

    const done = (await call(l, 'PATCH', `/tasks/${t.task_id}`, { status: 'done' })).json();
    expect(done.completed_at).toBeTruthy();
    const reopened = (await call(l, 'PATCH', `/tasks/${t.task_id}`, { status: 'in_progress' })).json();
    expect(reopened.completed_at).toBeNull();
    expect((await call(l, 'PATCH', `/tasks/${t.task_id}`, { status: 'archived' })).statusCode).toBe(422);

    expect((await call(l, 'DELETE', `/tasks/${t.task_id}`)).statusCode).toBe(403);
    expect((await call(a, 'DELETE', `/tasks/${t.task_id}`)).statusCode).toBe(204);
    expect((await call(a, 'GET', '/tasks')).json().items).toHaveLength(0);
  });

  it('P1 文档：完整 Doc、can_edit、并发保护 409；删除后列表消失、协同连接 4404', async () => {
    const { tok, call, ws } = await makeApp();
    const [a, z] = [await tok('admin'), await tok('u_zhang')];
    const created = await call(a, 'POST', '/docs', { title: '10 月 19 日组会纪要', markdown: '# 纪要' });
    expect(created.statusCode).toBe(201);
    const doc = created.json();
    expect(doc).toMatchObject({ title: '10 月 19 日组会纪要', markdown: '# 纪要', created_by: 'admin', updated_by: 'admin', can_edit: true });
    expect(doc.url).toBe(`/api/v1/docs/${doc.doc_id}`);
    expect((await call(z, 'GET', `/docs/${doc.doc_id}`)).json().can_edit).toBe(false);
    expect((await call(z, 'PATCH', `/docs/${doc.doc_id}`, { title: 'x' })).statusCode).toBe(403);

    const saved = (await call(a, 'PATCH', `/docs/${doc.doc_id}`, { markdown: '# 纪要 v2', base_updated_at: doc.updated_at })).json();
    expect(saved.markdown).toBe('# 纪要 v2');
    const stale = await call(a, 'PATCH', `/docs/${doc.doc_id}`, { markdown: '# 覆盖', base_updated_at: doc.updated_at });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ message: '文档已被他人修改', doc: { markdown: '# 纪要 v2' } });

    await sleep(5);
    const second = (await call(z, 'POST', '/docs', { title: '周报', markdown: '' })).json();
    const list = (await call(a, 'GET', '/docs')).json();
    expect(list.items.map((d: Ev) => d.doc_id)).toEqual([second.doc_id, doc.doc_id]);
    expect(list.items[0].markdown).toBeUndefined();
    expect((await call(a, 'GET', '/docs?scope=mine')).json().items.map((d: Ev) => d.doc_id)).toEqual([doc.doc_id]);
    expect((await call(a, 'GET', '/docs?keyword=周报')).json().items).toHaveLength(1);

    const collab = ws(`/api/v1/docs/${doc.doc_id}/collab?token=${z}`);
    await collab.opened;
    await sleep(100);
    expect((await call(z, 'DELETE', `/docs/${doc.doc_id}`)).statusCode).toBe(403);
    expect((await call(a, 'DELETE', `/docs/${doc.doc_id}`)).statusCode).toBe(204);
    expect(await collab.closed).toBe(4404);
    expect((await call(a, 'GET', '/docs')).json().items.map((d: Ev) => d.doc_id)).not.toContain(doc.doc_id);
    expect((await call(a, 'GET', `/docs/${doc.doc_id}`)).statusCode).toBe(404);
  });

  // ======================= P2（抽查） =======================

  it('P2 撤回 / 编辑 / 搜索 / 幂等发送 / 置顶免打扰 / 管理员禁用账号', async () => {
    const { tok, call, login, ws } = await makeApp();
    const [a, z] = [await tok('admin'), await tok('u_zhang')];
    const chat = (await call(a, 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_zhang'] })).json();
    const m1 = await call(a, 'POST', `/chats/${chat.chat_id}/messages`, { msg_type: 'text', content: { text: '四足步态数据' }, client_msg_id: 'c1' });
    const m2 = await call(a, 'POST', `/chats/${chat.chat_id}/messages`, { msg_type: 'text', content: { text: '四足步态数据' }, client_msg_id: 'c1' });
    expect(m1.statusCode).toBe(201);
    expect(m2.statusCode).toBe(200);
    expect(m2.json().message_id).toBe(m1.json().message_id);

    const edited = (await call(a, 'PATCH', `/messages/${m1.json().message_id}`, { content: { text: '四足步态数据 v2' } })).json();
    expect(edited.content.text).toBe('四足步态数据 v2');
    expect((await call(z, 'PATCH', `/messages/${m1.json().message_id}`, { content: { text: 'x' } })).statusCode).toBe(403);
    const found = (await call(z, 'GET', '/messages/search?keyword=步态')).json();
    expect(found.items[0].highlight).toContain('步态');
    expect((await call(await tok('u_li'), 'GET', '/messages/search?keyword=步态')).json().items).toHaveLength(0);
    const recalled = (await call(a, 'POST', `/messages/${m1.json().message_id}/recall`)).json();
    expect(recalled).toMatchObject({ recalled: true, content: {} });

    const s = (await call(z, 'PATCH', `/chats/${chat.chat_id}/settings`, { pinned: true, muted: true })).json();
    expect(s).toMatchObject({ pinned: true, muted: true });

    const zws = ws(`/api/v1/events/ws?token=${z}`);
    await zws.opened;
    expect((await call(z, 'PATCH', '/users/u_zhang', { disabled: true })).statusCode).toBe(403);
    expect((await call(a, 'PATCH', '/users/u_zhang', { disabled: true })).statusCode).toBe(200);
    // 管理员修改后立即清用户缓存，无需等待
    const r = await call(z, 'GET', '/users/me');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('ACCOUNT_DISABLED');
    const relog = await call(undefined, 'POST', '/auth/login', { username: 'u_zhang', password: 'pw' });
    expect(relog.statusCode).toBe(403);
    const zws2 = ws(`/api/v1/events/ws?token=${z}`);
    expect(await zws2.closed).toBe(4403);
    expect((await login('admin', 'admin')).user.role).toBe('admin');
  }, 15_000);
});
