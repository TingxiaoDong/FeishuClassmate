/**
 * 二期迭代 4：消息增强（R-IM-01 ~ 07）。对照《二期迭代4_前端接口需求与进度.md》第 3、5、6 节。
 * 设置 CLASSMATEOS_TEST_PG_URL 时同时在 PostgreSQL 上跑（会清空该库）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import type { BotEvent } from '../../classmateos/server/events.js';
import { checkUrl, defaultLinkFetcher, extractUrls, isPublicIp, parseHtmlMeta } from '../../classmateos/server/link-preview.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
let pool: pg.Pool | undefined;
afterAll(async () => { await pool?.end(); });
const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('链接预览安全检查', () => {
  it('拒绝内网、回环、元数据地址和非 http 协议', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('2606:4700::1111')).toBe(true);
    for (const u of ['file:///etc/passwd', 'gopher://x', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://user:pw@example.com/', 'http://example.com:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://foo.internal/']) {
      expect(checkUrl(u), u).toBeNull();
    }
    expect(checkUrl('https://example.com/a?b=1')).not.toBeNull();
  });
  it('抓取器对内网地址直接返回 null；解析标题和简介；提取链接', async () => {
    expect(await defaultLinkFetcher('http://127.0.0.1/')).toBeNull();
    expect(await defaultLinkFetcher('http://localhost:80/')).toBeNull();
    expect(parseHtmlMeta('<title> 标题 &amp; 测试 </title><meta name="description" content="简介">')).toEqual({ title: '标题 & 测试', description: '简介' });
    expect(parseHtmlMeta('<meta property="og:title" content="OG"><title>x</title>').title).toBe('OG');
    expect(extractUrls('看 https://a.com/x，和 https://b.com/y. 还有 https://a.com/x')).toEqual(['https://a.com/x', 'https://b.com/y']);
  });
});

describe.each(backends)('二期迭代 4 消息（$name）', ({ usePg }) => {
  async function makeApp(reset = true) {
    const o: AppOptions = {
      secret: 's', notificationScanner: false,
      linkPreviewFetcher: async (url) => (url.includes('example.com') ? { url, title: '示例站点', description: '一段简介' } : null),
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
    const send = async (u: string, chat: string, text: string, extra: Record<string, unknown> = {}) =>
      (await call(u, 'POST', `/chats/${chat}/messages`, { msg_type: 'text', content: { text }, ...extra })).json();
    const group = async () => (await call('ou_admin', 'POST', '/chats', { chat_type: 'group', name: '具身智能实验室', member_ids: ['ou_li', 'ou_zhang'] })).json().chat_id as string;
    const userEvents = (type: string, uid: string) => events.filter((e) => e.event_type === type && e.audience?.includes(uid));
    return { app, call, events, send, group, userEvents };
  }

  it('功能开关：消息增强各项已打开', async () => {
    const { app } = await makeApp();
    try {
      const f = (await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json().features;
      for (const k of ['message.thread', 'message.reaction', 'message.forward', 'message.urgent', 'message.favorite', 'message.pin', 'message.link_preview', 'message.rich_text']) expect(f[k], k).toBe(true);
    } finally { await app.close(); }
  });

  it('R-IM-01 已读回执：准确的 read_count、已读名单只给发送人、message.read 推给全体', async () => {
    const { app, call, send, group, userEvents } = await makeApp();
    try {
      const chat = await group();
      const m = await send('ou_admin', chat, '大家看下');
      expect(m).toMatchObject({ read_count: 0, member_count: 2 });
      expect((await call('ou_li', 'GET', `/chats/${chat}/messages`)).json().items.find((x: any) => x.message_id === m.message_id).read_count).toBeUndefined();
      expect((await call('ou_li', 'POST', `/chats/${chat}/read`, {})).statusCode).toBe(204);
      // 同一个人重复已读不会重复计数
      await call('ou_li', 'POST', `/chats/${chat}/read`, {});
      const ev = userEvents('message.read', 'ou_admin');
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ chat_id: chat, user_id: 'ou_li', last_read_message_id: m.message_id });
      const mine = (await call('ou_admin', 'GET', `/chats/${chat}/messages`)).json().items.find((x: any) => x.message_id === m.message_id);
      expect(mine).toMatchObject({ read_count: 1, member_count: 2 });
      expect((await call('ou_admin', 'GET', `/messages/${m.message_id}/read-users`)).json()).toEqual({ read: ['ou_li'], unread: ['ou_zhang'] });
      expect((await call('ou_li', 'GET', `/messages/${m.message_id}/read-users`)).statusCode).toBe(403);
      expect((await call('ou_out', 'GET', `/messages/${m.message_id}/read-users`)).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('R-IM-02 话题：回复不进主会话、同时发到群、分页、关注、未读、不能嵌套、话题模式权限', async () => {
    const { app, call, send, group, userEvents } = await makeApp();
    try {
      const chat = await group();
      const root = await send('ou_admin', chat, '机械臂标定方案');
      const r1 = await send('ou_li', chat, '我觉得可以', { thread_root_id: root.message_id });
      expect(r1).toMatchObject({ thread_root_id: root.message_id, also_send_to_chat: false });
      await send('ou_zhang', chat, '同意', { thread_root_id: root.message_id });
      const r3 = await send('ou_li', chat, '同步到群里', { thread_root_id: root.message_id, also_send_to_chat: true });
      // 不能在话题回复里再开话题；also_send_to_chat 只能用于话题回复
      expect((await call('ou_li', 'POST', `/chats/${chat}/messages`, { msg_type: 'text', content: { text: 'x' }, thread_root_id: r1.message_id })).statusCode).toBe(422);
      expect((await call('ou_li', 'POST', `/chats/${chat}/messages`, { msg_type: 'text', content: { text: 'x' }, also_send_to_chat: true })).statusCode).toBe(422);
      const main = (await call('ou_zhang', 'GET', `/chats/${chat}/messages`)).json().items.map((x: any) => x.message_id);
      expect(main).toContain(root.message_id);
      expect(main).toContain(r3.message_id);
      expect(main).not.toContain(r1.message_id);
      const rootView = (await call('ou_admin', 'GET', `/chats/${chat}/messages`)).json().items.find((x: any) => x.message_id === root.message_id);
      expect(rootView.thread).toMatchObject({ reply_count: 3, participants: ['ou_li', 'ou_zhang'], followed: true });
      // 回复话题时对根消息推 message.updated
      expect(userEvents('message.updated', 'ou_admin').some((e: any) => e.message.message_id === root.message_id && e.message.thread?.reply_count === 3)).toBe(true);
      // 会话最后一条是同时发到群的那条；话题未读：发起人有 1 个话题有新回复
      let chatView = (await call('ou_admin', 'GET', `/chats/${chat}`)).json();
      expect(chatView.last_message.message_id).toBe(r3.message_id);
      expect(chatView.thread_unread_count).toBe(1);
      // 分页取完全部回复
      const p1 = (await call('ou_admin', 'GET', `/messages/${root.message_id}/thread?page_size=2`)).json();
      expect(p1.items.map((x: any) => x.message_id)).toHaveLength(2);
      expect(p1.has_more).toBe(true);
      const p2 = (await call('ou_admin', 'GET', `/messages/${root.message_id}/thread?page_size=2&page_token=${p1.page_token}`)).json();
      expect(p2.items.map((x: any) => x.message_id)).toEqual([r3.message_id]);
      expect(p2.has_more).toBe(false);
      chatView = (await call('ou_admin', 'GET', `/chats/${chat}`)).json();
      expect(chatView.thread_unread_count).toBe(0);
      // 关注 / 取消关注
      expect((await call('ou_zhang', 'DELETE', `/messages/${root.message_id}/thread/follow`)).json().thread.followed).toBe(false);
      expect((await call('ou_zhang', 'POST', `/messages/${root.message_id}/thread/follow`)).json().thread.followed).toBe(true);
      expect((await call('ou_out', 'POST', `/messages/${root.message_id}/thread/follow`)).statusCode).toBe(403);
      // 话题回复不算主会话未读：张晓明只有根消息和同步到群的两条未读（话题回复不算）
      const zv = (await call('ou_zhang', 'GET', `/chats/${chat}`)).json();
      expect(zv.unread_count).toBe(2);
      // 话题模式：只有群主 / 管理员能改
      expect((await call('ou_li', 'PATCH', `/chats/${chat}`, { thread_mode: true })).statusCode).toBe(403);
      const tm = await call('ou_admin', 'PATCH', `/chats/${chat}`, { thread_mode: true });
      expect(tm.json().thread_mode).toBe(true);
      expect(userEvents('chat.updated', 'ou_li').some((e: any) => e.chat.thread_mode === true)).toBe(true);
    } finally { await app.close(); }
  });

  it('R-IM-03 表情回应：加 / 取消幂等、各人视角、推 message.updated、越权', async () => {
    const { app, call, send, group, userEvents } = await makeApp();
    try {
      const chat = await group();
      const m = await send('ou_admin', chat, '论文投出去了');
      const r = (await call('ou_li', 'POST', `/messages/${m.message_id}/reactions`, { emoji: 'THUMBSUP' })).json();
      expect(r.reactions).toEqual([{ emoji: 'THUMBSUP', count: 1, user_ids: ['ou_li'], reacted_by_me: true }]);
      await call('ou_li', 'POST', `/messages/${m.message_id}/reactions`, { emoji: 'THUMBSUP' });
      const z = (await call('ou_zhang', 'POST', `/messages/${m.message_id}/reactions`, { emoji: 'THUMBSUP' })).json();
      expect(z.reactions[0]).toMatchObject({ count: 2, reacted_by_me: true });
      const adminView = userEvents('message.updated', 'ou_admin').at(-1) as any;
      expect(adminView.message.reactions[0]).toMatchObject({ count: 2, reacted_by_me: false });
      expect(adminView.scope?.user_only).toBe(true);
      const d = (await call('ou_li', 'DELETE', `/messages/${m.message_id}/reactions/THUMBSUP`)).json();
      expect(d.reactions).toEqual([{ emoji: 'THUMBSUP', count: 1, user_ids: ['ou_zhang'], reacted_by_me: false }]);
      expect((await call('ou_li', 'POST', `/messages/${m.message_id}/reactions`, { emoji: '<b>' })).statusCode).toBe(422);
      expect((await call('ou_out', 'POST', `/messages/${m.message_id}/reactions`, { emoji: 'OK' })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('R-IM-04 转发：逐条 / 合并、接收方能下载文件、防重复提交、会话数上限、不能转发看不到的消息', async () => {
    const { app, call, send, group } = await makeApp();
    try {
      const chat = await group();
      const up = (await call('ou_admin', 'POST', '/files/upload-url', { file_name: '结果.png', size: 3 })).json();
      const u = new URL(up.upload_url, 'http://x');
      expect((await app.inject({ method: 'PUT', url: u.pathname + u.search, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('abc') })).statusCode).toBeLessThan(300);
      const img = (await call('ou_admin', 'POST', `/chats/${chat}/messages`, { msg_type: 'image', content: { file_key: up.file_key } })).json();
      const t = await send('ou_li', chat, '这是实验结果');
      const dm = (await call('ou_li', 'POST', '/chats', { chat_type: 'p2p', member_ids: ['ou_out'] })).json().chat_id;
      expect((await call('ou_out', 'GET', `/files/${up.file_key}/download-url`)).statusCode).toBe(404);
      const body = { message_ids: [t.message_id, img.message_id], chat_ids: [dm], mode: 'single', note: '看看', client_request_id: 'c_1' };
      const f = await call('ou_li', 'POST', '/messages/forward', body);
      expect(f.statusCode).toBe(201);
      const items = f.json().items;
      expect(items.map((x: any) => x.msg_type)).toEqual(['image', 'text', 'text']); // 按原顺序，最后是留言
      expect(items[0].forwarded_from).toMatchObject({ chat_name: '具身智能实验室', sender_id: 'ou_admin' });
      expect((await call('ou_out', 'GET', `/files/${up.file_key}/download-url`)).statusCode).toBe(200);
      // 同一个 client_request_id 只执行一次
      const again = await call('ou_li', 'POST', '/messages/forward', body);
      expect(again.statusCode).toBe(200);
      expect(again.json().items.map((x: any) => x.message_id)).toEqual(items.map((x: any) => x.message_id));
      expect((await call('ou_out', 'GET', `/chats/${dm}/messages`)).json().items).toHaveLength(3);
      // 合并转发
      const dm2 = (await call('ou_zhang', 'POST', '/chats', { chat_type: 'p2p', member_ids: ['ou_out'] })).json().chat_id;
      const mg = (await call('ou_zhang', 'POST', '/messages/forward', { message_ids: [img.message_id, t.message_id], chat_ids: [dm2], mode: 'merge' })).json().items[0];
      expect(mg.msg_type).toBe('merge_forward');
      expect(mg.content.title).toBe('具身智能实验室的聊天记录');
      expect(mg.content.messages.map((x: any) => [x.sender_id, x.msg_type])).toEqual([['ou_admin', 'image'], ['ou_li', 'text']]);
      expect(mg.content.messages[0]).toHaveProperty('created_at');
      // 上限与越权
      expect((await call('ou_li', 'POST', '/messages/forward', { message_ids: [t.message_id], chat_ids: Array.from({ length: 11 }, (_, i) => `c${i}`) })).statusCode).toBe(422);
      expect((await call('ou_out', 'POST', '/messages/forward', { message_ids: [t.message_id], chat_ids: [dm] })).statusCode).toBe(422);
      expect((await call('ou_li', 'POST', '/messages/forward', { message_ids: [t.message_id], chat_ids: [dm2] })).statusCode).toBe(422);
    } finally { await app.close(); }
  });

  it('R-IM-05 加急：只能加急自己的消息、每人每条一次、横幅事件、离线补拉、确认后推 urgent_acked', async () => {
    const { app, call, send, group, userEvents } = await makeApp();
    try {
      const chat = await group();
      const m = await send('ou_admin', chat, '下午三点组会，务必参加');
      expect((await call('ou_li', 'POST', `/messages/${m.message_id}/urgent`, { user_ids: ['ou_zhang'] })).statusCode).toBe(403);
      expect((await call('ou_admin', 'POST', `/messages/${m.message_id}/urgent`, { user_ids: ['ou_out'] })).statusCode).toBe(422);
      const u = await call('ou_admin', 'POST', `/messages/${m.message_id}/urgent`, { user_ids: ['ou_li', 'ou_zhang'], type: 'push' });
      expect(u.statusCode).toBe(200);
      expect(u.json().urgent).toEqual({ user_ids: ['ou_li', 'ou_zhang'], ack_user_ids: [] });
      expect(userEvents('message.urgent', 'ou_li')[0]).toMatchObject({ message_id: m.message_id, chat_id: chat, from_user_id: 'ou_admin', preview: '下午三点组会，务必参加' });
      expect((await call('ou_li', 'GET', '/notifications')).json().items.some((n: any) => n.type === 'message.urgent')).toBe(true);
      expect((await call('ou_admin', 'POST', `/messages/${m.message_id}/urgent`, { user_ids: ['ou_li'] })).statusCode).toBe(429);
      const pending = (await call('ou_li', 'GET', '/messages/urgent/pending')).json().items;
      expect(pending).toEqual([expect.objectContaining({ message_id: m.message_id, chat_id: chat, from_user_id: 'ou_admin' })]);
      expect((await call('ou_out', 'POST', `/messages/${m.message_id}/urgent/ack`)).statusCode).toBe(403);
      expect((await call('ou_li', 'POST', `/messages/${m.message_id}/urgent/ack`)).statusCode).toBe(204);
      const acked = userEvents('message.urgent_acked', 'ou_admin');
      expect(acked).toHaveLength(1);
      expect(acked[0].audience).toContain('ou_li');
      expect((await call('ou_li', 'GET', '/messages/urgent/pending')).json().items).toHaveLength(0);
      expect((await call('ou_admin', 'GET', `/chats/${chat}/messages`)).json().items.find((x: any) => x.message_id === m.message_id).urgent.ack_user_ids).toEqual(['ou_li']);
    } finally { await app.close(); }
  });

  it('R-IM-06 收藏和 Pin：幂等、退群后看不到收藏正文、最多 10 条 Pin、chat.updated 带 pinned_message_ids', async () => {
    let { app, call, send, group, userEvents } = await makeApp();
    let chat = '';
    try {
      chat = await group();
      const m = await send('ou_admin', chat, '数据集下载地址');
      expect((await call('ou_li', 'POST', `/messages/${m.message_id}/favorite`)).statusCode).toBe(204);
      expect((await call('ou_li', 'POST', `/messages/${m.message_id}/favorite`)).statusCode).toBe(204);
      const fav = (await call('ou_li', 'GET', '/favorites')).json();
      expect(fav.items).toHaveLength(1);
      expect(fav.items[0]).toMatchObject({ chat_name: '具身智能实验室', message: { message_id: m.message_id } });
      expect((await call('ou_out', 'POST', `/messages/${m.message_id}/favorite`)).statusCode).toBe(403);
      // Pin
      const ids: string[] = [m.message_id];
      for (let i = 0; i < 9; i++) ids.push((await send('ou_li', chat, `第 ${i} 条`)).message_id);
      for (const id of ids) expect((await call('ou_li', 'POST', `/chats/${chat}/pins/${id}`)).statusCode).toBe(204);
      expect((await call('ou_li', 'POST', `/chats/${chat}/pins/${ids[0]}`)).statusCode).toBe(204); // 重复固定幂等
      const extra = await send('ou_li', chat, '第 11 条');
      const over = await call('ou_li', 'POST', `/chats/${chat}/pins/${extra.message_id}`);
      expect(over.statusCode).toBe(409);
      expect(over.json().code).toBe('PIN_LIMIT');
      expect((await call('ou_zhang', 'GET', `/chats/${chat}`)).json().pinned_message_ids).toEqual(ids);
      expect((await call('ou_zhang', 'GET', `/chats/${chat}/pins`)).json().items.map((x: any) => x.message.message_id)).toEqual(ids);
      expect((await call('ou_zhang', 'DELETE', `/chats/${chat}/pins/${ids[1]}`)).statusCode).toBe(204);
      expect((userEvents('chat.updated', 'ou_admin').at(-1) as any).chat.pinned_message_ids).toHaveLength(9);
      expect((await call('ou_out', 'GET', `/chats/${chat}/pins`)).statusCode).toBe(403);
    } finally { await app.close(); }
    // PostgreSQL：重启后收藏、Pin 都还在
    if (usePg) ({ app, call } = await makeApp(false));
    else ({ app, call } = { app, call });
    try {
      if (usePg) {
        expect((await call('ou_li', 'GET', '/favorites')).json().items).toHaveLength(1);
        expect((await call('ou_li', 'GET', `/chats/${chat}/pins`)).json().items).toHaveLength(9);
      }
    } finally { if (usePg) await app.close(); }
  });

  it('R-IM-06 退群后收藏不再返回正文，但仍能取消收藏', async () => {
    const { app, call, send, group } = await makeApp();
    try {
      const chat = await group();
      const m = await send('ou_admin', chat, '数据集下载地址');
      await call('ou_li', 'POST', `/messages/${m.message_id}/favorite`);
      expect((await call('ou_li', 'DELETE', `/chats/${chat}/members/ou_li`)).statusCode).toBe(204);
      expect((await call('ou_li', 'GET', '/favorites')).json().items).toHaveLength(0);
      expect((await call('ou_li', 'DELETE', `/messages/${m.message_id}/favorite`)).statusCode).toBe(204);
    } finally { await app.close(); }
  });

  it('R-IM-07 富文本和链接预览：post 带 markdown、后端写回 link_previews、客户端不能伪造预览', async () => {
    const { app, call, group, userEvents } = await makeApp();
    try {
      const chat = await group();
      const md = await call('ou_li', 'POST', `/chats/${chat}/messages`, { msg_type: 'post', content: { markdown: '**加粗**\n- 列表' } });
      expect(md.statusCode).toBe(201);
      expect(md.json().content.markdown).toBe('**加粗**\n- 列表');
      const m = (await call('ou_li', 'POST', `/chats/${chat}/messages`, { msg_type: 'text', content: { text: '看这个 https://example.com/a 和 http://127.0.0.1/admin', link_previews: [{ url: 'x', title: '伪造' }] } })).json();
      expect(m.content.link_previews).toBeUndefined();
      for (let i = 0; i < 20 && !userEvents('message.updated', 'ou_zhang').some((e: any) => e.message.message_id === m.message_id); i++) await sleep(20);
      const got = (await call('ou_zhang', 'GET', `/chats/${chat}/messages`)).json().items.find((x: any) => x.message_id === m.message_id);
      expect(got.content.link_previews).toEqual([{ url: 'https://example.com/a', title: '示例站点', description: '一段简介' }]);
      // 单条记录接口（内部链接卡片用）已存在
      expect((await call('ou_li', 'GET', '/tables/Projects/records/nope')).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it.runIf(usePg)('PostgreSQL：话题、表情、加急重启后仍在', async () => {
    let { app, call, send, group } = await makeApp();
    let chat = '';
    let root = '';
    try {
      chat = await group();
      root = (await send('ou_admin', chat, '根')).message_id;
      await send('ou_li', chat, '回复', { thread_root_id: root });
      await call('ou_li', 'POST', `/messages/${root}/reactions`, { emoji: 'DONE' });
      await call('ou_admin', 'POST', `/messages/${root}/urgent`, { user_ids: ['ou_zhang'] });
    } finally { await app.close(); }
    ({ app, call } = await makeApp(false));
    try {
      const r = (await call('ou_admin', 'GET', `/chats/${chat}/messages`)).json().items.find((x: any) => x.message_id === root);
      expect(r.thread.reply_count).toBe(1);
      expect(r.reactions[0]).toMatchObject({ emoji: 'DONE', count: 1 });
      expect(r.urgent.user_ids).toEqual(['ou_zhang']);
      expect((await call('ou_zhang', 'GET', '/messages/urgent/pending')).json().items).toHaveLength(1);
    } finally { await app.close(); }
  });
});
