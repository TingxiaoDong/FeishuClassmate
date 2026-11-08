/**
 * 代码审查 A4 后端兜底：代发到机器人不在的会话时，必须带同学已确认、且绑定这个目标的卡片。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sendConfirmCardStatus, CONFIRM_TTL_MS } from '../../classmateos/server/agent-principal.js';
import type { MessageRecord } from '../../classmateos/server/repo.js';
import { buildApp, type PlatformUser } from '../../classmateos/server/app.js';

const USERS: PlatformUser[] = [
  { user_id: 'u_zhang', name: '张晓明', password: 'pw', role: 'member' },
  { user_id: 'u_li', name: '李华', password: 'pw', role: 'member' },
  { user_id: 'u_wang', name: '王芳', password: 'pw', role: 'member' },
];
type Ev = Record<string, any>;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function setup() {
  const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok', notificationScanner: false });
  apps.push(app);
  const tokens: Record<string, string> = {};
  const as = async (u: string, method: string, url: string, payload?: unknown) => {
    tokens[u] ??= (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json().access_token;
    return app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${tokens[u]}` }, payload: payload as Ev });
  };
  const bot = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { 'x-bot-token': 'btok', ...headers }, payload: payload as Ev });
  const send = (receive_id: string, text: string, card?: string, type: 'chat_id' | 'user_id' = 'chat_id') =>
    bot('POST', '/bot/messages', { receive_id, receive_id_type: type, msg_type: 'text', content: { text } }, { 'x-on-behalf-of': 'u_zhang', ...(card ? { 'x-agent-confirm': card } : {}) });
  /** 机器人在张晓明的单聊里发确认卡，张晓明点「确认」。 */
  let seq = 0;
  const confirmed = async (target: string | string[], user = 'u_zhang', route = '/api/v1/bot/messages') => {
    const id = `card_send_${++seq}`;
    const sent = await bot('POST', '/bot/messages', {
      receive_id: 'u_zhang', receive_id_type: 'user_id', msg_type: 'interactive_card',
      content: { card_id: id, kind: 'confirm', question: '代发确认', options: ['确认', '取消'], answerable_by: ['u_zhang'], bound_action: { method: 'POST', route, path: route, target_id: target } },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await as(user, 'POST', `/cards/${id}/actions`, { action: '确认' })).statusCode).toBe(202);
    return id;
  };
  return { as, bot, send, confirmed };
}

describe('A4 后端兜底：代发到机器人不在的会话', () => {
  it('同学之间的私聊：没卡、错目标、别的操作卡都拒绝；确认后只能发一次', async () => {
    const { as, send, confirmed } = await setup();
    const dm = (await as('u_zhang', 'POST', '/chats', { chat_type: 'p2p', member_ids: ['u_li'] })).json().chat_id as string;
    const other = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: '项目组', member_ids: ['u_li'] })).json().chat_id as string;

    expect((await send(dm, '未确认')).json().code).toBe('BOT_CONFIRM_REQUIRED');
    expect((await send(dm, '伪造', 'card_fake')).json().code).toBe('BOT_CONFIRM_REQUIRED');
    expect((await send(dm, '错目标', await confirmed(other))).json().code).toBe('BOT_CONFIRM_MISMATCH');
    expect((await send(dm, '删除卡', await confirmed(dm, 'u_zhang', '/api/v1/tables/:table_key/records/batch_delete'))).json().code).toBe('BOT_CONFIRM_MISMATCH');

    const card = await confirmed(dm);
    const ok = await send(dm, '已确认的私聊消息', card);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().content.sent_on_behalf_of?.user_id).toBe('u_zhang');
    expect((await send(dm, '重放', card)).json().code).toBe('CARD_CONSUMED');
    expect(JSON.stringify((await as('u_li', 'GET', `/chats/${dm}/messages`)).json())).not.toContain('未确认');
  });

  it('一张群发卡按目标逐个核销', async () => {
    const { as, send, confirmed } = await setup();
    const a = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: 'A', member_ids: ['u_li'] })).json().chat_id as string;
    const b = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: 'B', member_ids: ['u_wang'] })).json().chat_id as string;
    const card = await confirmed([a, b]);
    expect((await send(a, '发 A', card)).statusCode).toBe(201);
    expect((await send(b, '发 B', card)).statusCode).toBe(201);
    expect((await send(a, '再发 A', card)).json().code).toBe('CARD_CONSUMED');
  });

  it('只能用本人确认过的卡；机器人所在会话和私信个人不受这道兜底影响', async () => {
    const { as, send, confirmed } = await setup();
    const group = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: '项目组', member_ids: ['u_li'] })).json().chat_id as string;
    const card = await confirmed(group, 'u_zhang');
    expect((await send(group, '通过', card)).statusCode).toBe(201);
    const withBot = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: '课题组', member_ids: ['u_li', 'bot'] })).json().chat_id as string;
    expect((await send(withBot, '机器人在群里')).statusCode).toBe(201);
    expect((await send('u_li', '私信', undefined, 'user_id')).statusCode).toBe(201);
  });
});

describe('代发卡片有效性与重放', () => {
  it('拒绝非本人、拒绝、未回答、过期和整体已核销的卡片', () => {
    const now = Date.now();
    const content = { kind: 'confirm', answerable_by: ['u_zhang'], bound_action: { method: 'POST', route: '/api/v1/bot/messages', target_id: ['chat_a', 'chat_b'] }, answer: { user_id: 'u_zhang', action: '确认', answered_at: new Date(now).toISOString() } };
    const msg = { sender_id: 'bot', msg_type: 'interactive_card', content } as unknown as MessageRecord;
    expect(sendConfirmCardStatus(msg, 'u_zhang', 'bot', 'chat_a', now)).toBe('ok');
    expect(sendConfirmCardStatus(msg, 'u_li', 'bot', 'chat_a', now)).toBe('invalid');
    expect(sendConfirmCardStatus(msg, 'u_zhang', 'bot', 'chat_a', now + CONFIRM_TTL_MS + 1)).toBe('invalid');
    for (const patch of [{ expired: true }, { answer: null }, { answer: { ...content.answer, action: '取消' } }]) {
      expect(sendConfirmCardStatus({ ...msg, content: { ...content, ...patch } }, 'u_zhang', 'bot', 'chat_a', now)).toBe('invalid');
    }
    expect(sendConfirmCardStatus({ ...msg, content: { ...content, consumed_at: new Date(now).toISOString() } }, 'u_zhang', 'bot', 'chat_a', now)).toBe('consumed');
  });
  it('并发重放同一个目标，只放行一次且只产生一条消息', async () => {
    const { as, send, confirmed } = await setup();
    const id = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: '并发测试', member_ids: ['u_li'] })).json().chat_id as string;
    const card = await confirmed(id);
    const results = await Promise.all([send(id, '并发消息', card), send(id, '并发消息', card)]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409]);
    const items = (await as('u_li', 'GET', `/chats/${id}/messages`)).json().items as Ev[];
    expect(items.filter(m => m.content.text === '并发消息')).toHaveLength(1);
  });
});
