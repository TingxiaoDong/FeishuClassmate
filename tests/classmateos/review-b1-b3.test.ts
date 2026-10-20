/**
 * 代码审查（2026-10-20）后端 B1 / B2 / B3 的回归测试。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type PlatformUser } from '../../classmateos/server/app.js';
import { eventVisibleToBot, type BotEvent } from '../../classmateos/server/events.js';
import { checkStartupConfig, DEV_BOT_TOKEN, DEV_SECRET } from '../../classmateos/server/startup-guard.js';

const USERS: PlatformUser[] = [
  { user_id: 'ou_admin', name: '管理员', password: 'admin', role: 'admin' },
  { user_id: 'u_zhang', name: '张晓明', password: 'pw', role: 'member' },
  { user_id: 'u_li', name: '李华', password: 'pw', role: 'member' },
];

type Ev = Record<string, any>;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function setup(users: PlatformUser[] = USERS) {
  const app = await buildApp({ users, secret: 's', botToken: 'btok', notificationScanner: false });
  apps.push(app);
  const tokens: Record<string, string> = {};
  const pw = (u: string) => users.find((x) => x.user_id === u)!.password;
  const as = async (u: string, method: string, url: string, payload?: unknown) => {
    tokens[u] ??= (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: pw(u) } })).json().access_token;
    return app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${tokens[u]}` }, payload: payload as Ev });
  };
  const bot = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { 'x-bot-token': 'btok', ...headers }, payload: payload as Ev });
  const obo = (user: string, method: string, url: string, payload?: unknown, card?: string) =>
    bot(method, url, payload, { 'x-on-behalf-of': user, ...(card ? { 'x-agent-confirm': card } : {}) });
  // 大脑 WS 收到的事件（和 routes-realtime 用同一个过滤函数）
  const brain: BotEvent[] = [];
  (app as any).cos.ctx.eventBus.subscribe((e: BotEvent) => { if (eventVisibleToBot(e)) brain.push(e); });
  return { app, as, bot, obo, brain };
}

describe('B1 机器人只在自己所在的会话里', () => {
  it('同学之间的私聊不推给大脑；机器人往不在的会话发消息 403', async () => {
    const { as, bot, brain } = await setup();
    const p2p = (await as('u_zhang', 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_li'] })).json();
    expect(p2p.chat_id).toBeTruthy();
    brain.length = 0;
    expect((await as('u_zhang', 'POST', `/chats/${p2p.chat_id}/messages`, { msg_type: 'text', content: { text: '晚上一起吃饭？' } })).statusCode).toBe(201);
    expect(brain.filter((e) => JSON.stringify(e).includes('晚上一起吃饭'))).toHaveLength(0);
    expect(brain.filter((e) => e.event_type.startsWith('message.') || e.event_type.startsWith('chat.'))).toHaveLength(0);

    const r = await bot('POST', '/bot/messages', { receive_id: p2p.chat_id, receive_id_type: 'chat_id', msg_type: 'text', content: { text: '你好' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('BOT_NOT_IN_CHAT');

    // 机器人在的群：大脑收得到，也能发
    const g = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: '课题组', member_ids: ['u_li', 'bot'] })).json();
    brain.length = 0;
    await as('u_zhang', 'POST', `/chats/${g.chat_id}/messages`, { msg_type: 'text', content: { text: '@飞书同学 帮我查下' } });
    expect(brain.some((e) => e.event_type === 'message.receive' && (e.message as Ev)?.chat_id === g.chat_id)).toBe(true);
    expect((await bot('POST', '/bot/messages', { receive_id: g.chat_id, receive_id_type: 'chat_id', msg_type: 'text', content: { text: '好的' } })).statusCode).toBe(201);
    // 私聊同学：自动建机器人单聊，可以
    expect((await bot('POST', '/bot/messages', { receive_id: 'u_li', receive_id_type: 'user_id', msg_type: 'text', content: { text: '提醒' } })).statusCode).toBe(201);
  });

  it('机器人发卡片时不能自带「已确认」', async () => {
    const { bot, app } = await setup();
    const r = await bot('POST', '/bot/messages', {
      receive_id: 'u_zhang', receive_id_type: 'user_id', msg_type: 'interactive_card',
      content: { card_id: 'c_forge', kind: 'confirm', question: '删？', options: ['确认', '取消'], answer: { user_id: 'u_zhang', action: '确认', answered_at: new Date().toISOString() } },
    });
    expect(r.statusCode).toBe(201);
    const msg = await (app as any).cos.ctx.repo.findMessageByCardId('c_forge');
    expect(msg.content.answer ?? null).toBeNull();
  });
});

describe('B3 确认卡片绑定操作、只能用一次', () => {
  async function confirmedCard(t: Awaited<ReturnType<typeof setup>>, cardId: string, bound?: Ev) {
    const sent = await t.bot('POST', '/bot/messages', {
      receive_id: 'u_zhang', receive_id_type: 'user_id', msg_type: 'interactive_card',
      content: { card_id: cardId, kind: 'confirm', question: '确定删除？', options: ['确认', '取消'], answerable_by: ['u_zhang'], ...(bound ? { bound_action: bound } : {}) },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await t.as('u_zhang', 'POST', `/cards/${cardId}/actions`, { action: '确认' })).statusCode).toBe(202);
  }

  it('同一张卡第二次用被拒；绑 A 删 B 被拒；没绑操作的卡不能放行', async () => {
    const t = await setup();
    const a = (await t.as('u_zhang', 'POST', '/docs', { title: 'A' })).json();
    const b = (await t.as('u_zhang', 'POST', '/docs', { title: 'B' })).json();
    const c = (await t.as('u_zhang', 'POST', '/docs', { title: 'C' })).json();
    // 不带卡片：要确认
    expect((await t.obo('u_zhang', 'DELETE', `/docs/${a.doc_id}`)).json().code).toBe('BOT_CONFIRM_REQUIRED');

    await confirmedCard(t, 'card_a', { method: 'DELETE', route: '/api/v1/docs/:doc_id', path: `/api/v1/docs/${a.doc_id}`, target_id: a.doc_id });
    // 拿删 A 的卡去删 B
    const wrong = await t.obo('u_zhang', 'DELETE', `/docs/${b.doc_id}`, undefined, 'card_a');
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().code).toBe('BOT_CONFIRM_MISMATCH');
    // 删 A：放行一次
    expect((await t.obo('u_zhang', 'DELETE', `/docs/${a.doc_id}`, undefined, 'card_a')).statusCode).toBe(204);
    // 第二次：已用过
    const again = await t.obo('u_zhang', 'DELETE', `/docs/${a.doc_id}`, undefined, 'card_a');
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('CARD_CONSUMED');

    // 没绑操作的旧卡片
    await confirmedCard(t, 'card_old');
    expect((await t.obo('u_zhang', 'DELETE', `/docs/${c.doc_id}`, undefined, 'card_old')).json().code).toBe('BOT_CONFIRM_MISMATCH');

    // 绑的是 DELETE，拿去调别的写接口（不在删除规则里的接口本来就不需要卡片，这里验证 POST 批量删除）
    const tbl = (await t.as('u_zhang', 'POST', '/tables', {
      name: '设备', primary_field: 'name', client_request_id: 'tb1',
      fields: [{ field_name: 'name', title: '名称', type: 1, required: true }],
    })).json();
    const rec = (await t.as('u_zhang', 'POST', `/tables/${tbl.key ?? tbl.table_key}/records`, { fields: { name: 'x' } })).json();
    const rid = rec.record_id ?? rec.record?.record_id;
    expect(rid, JSON.stringify({ tbl, rec })).toBeTruthy();
    await confirmedCard(t, 'card_del', { method: 'DELETE', route: '/api/v1/docs/:doc_id', target_id: c.doc_id });
    const batch = await t.obo('u_zhang', 'POST', `/tables/${tbl.key ?? tbl.table_key}/records/batch_delete`, { record_ids: [rid] }, 'card_del');
    expect(batch.json().code).toBe('BOT_CONFIRM_MISMATCH');
    // 批量删除：按集合比对
    await confirmedCard(t, 'card_batch', { method: 'POST', route: '/api/v1/tables/:table_key/records/batch_delete', target_id: [rid] });
    const ok = await t.obo('u_zhang', 'POST', `/tables/${tbl.key ?? tbl.table_key}/records/batch_delete`, { record_ids: [rid] }, 'card_batch');
    expect(ok.statusCode, ok.body).toBeLessThan(300);
  });

  it('bound_action 格式不对时发卡失败', async () => {
    const t = await setup();
    const r = await t.bot('POST', '/bot/messages', {
      receive_id: 'u_zhang', receive_id_type: 'user_id', msg_type: 'interactive_card',
      content: { card_id: 'c_bad', kind: 'confirm', question: '删？', bound_action: { method: 'RM', route: 'docs' } },
    });
    expect(r.statusCode).toBe(422);
  });
});

describe('B2 启动保护', () => {
  it('生产模式缺密钥、用默认值、弱密码都拒绝启动', () => {
    expect(checkStartupConfig({ NODE_ENV: 'production' }).errors.length).toBeGreaterThanOrEqual(2);
    expect(checkStartupConfig({ NODE_ENV: 'production', CLASSMATE_OS_SECRET: DEV_SECRET, CLASSMATE_OS_BOT_TOKEN: DEV_BOT_TOKEN }).errors).toEqual([
      'CLASSMATE_OS_SECRET 不能使用开发默认值',
      'CLASSMATE_OS_BOT_TOKEN 不能使用开发默认值',
    ]);
    const good = { NODE_ENV: 'production', CLASSMATE_OS_SECRET: 'x'.repeat(32), CLASSMATE_OS_BOT_TOKEN: 'y'.repeat(32) };
    const ok = checkStartupConfig(good);
    expect(ok.errors).toEqual([]);
    expect(ok.users).toEqual([]); // 不建 admin/admin
    expect(ok.host).toBe('0.0.0.0');
    expect(checkStartupConfig({ ...good, CLASSMATE_OS_USERS: JSON.stringify([{ user_id: 'a', name: 'a', password: 'admin', role: 'admin' }]) }).errors).toEqual(['种子账号 a 的密码太弱']);
  });

  it('开发模式允许默认值，只监听本机', () => {
    const dev = checkStartupConfig({});
    expect(dev.errors).toEqual([]);
    expect(dev.warnings.length).toBe(2);
    expect(dev.host).toBe('127.0.0.1');
    expect(dev.users.map((u) => u.user_id)).toEqual(['ou_admin', 'ou_demo']);
    expect(checkStartupConfig({ NODE_ENV: 'production', CLASSMATE_OS_DEV: '1' }).errors).toEqual([]);
  });

  it('生产种子账号首次登录必须改密；bot 令牌错一位就拒绝', async () => {
    const t = await setup([...USERS, { user_id: 'u_new', name: '新管理员', password: 'S3cure-pass!', role: 'admin', must_change_password: true }]);
    const r = await t.as('u_new', 'GET', '/docs');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/bot/audit', headers: { 'x-bot-token': 'btoK' } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/bot/audit', headers: { 'x-bot-token': 'btok' } })).statusCode).toBe(200);
  });
});
