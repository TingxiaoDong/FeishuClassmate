/**
 * 《后端待改问题_2026-10-20》C1 / C2 的回归测试。
 *   C1 新建文档默认仅所有者可见（老文档不变）
 *   C2 代同学发群消息：走 /bot/messages + X-On-Behalf-Of，带代发标记；不许以本人名义代发
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type PlatformUser } from '../../classmateos/server/app.js';

const USERS: PlatformUser[] = [
  { user_id: 'ou_admin', name: '管理员', password: 'admin', role: 'admin' },
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
    tokens[u] ??= (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: USERS.find((x) => x.user_id === u)!.password } })).json().access_token;
    return app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${tokens[u]}` }, payload: payload as Ev });
  };
  const bot = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { 'x-bot-token': 'btok', ...headers }, payload: payload as Ev });
  const obo = (user: string, method: string, url: string, payload?: unknown) => bot(method, url, payload, { 'x-on-behalf-of': user });
  return { app, as, bot, obo };
}

describe('C1 新建文档默认仅自己可见', () => {
  it('别人读不到、搜不到、机器人代办也读不到；分享给组织后可以', async () => {
    const { app, as, obo } = await setup();
    const d = (await as('u_li', 'POST', '/docs', { title: '李华的私人笔记', markdown: '银行卡尾号 6688，体检结果待复查。' })).json();
    const perm = (await as('u_li', 'GET', `/docs/${d.doc_id}/permissions`)).json();
    expect(perm.link_share).not.toBe('org_view');
    expect((await as('u_li', 'GET', `/docs/${d.doc_id}`)).statusCode).toBe(200);

    expect((await as('u_zhang', 'GET', `/docs/${d.doc_id}`)).statusCode).toBe(403);
    expect((await obo('u_zhang', 'GET', `/docs/${d.doc_id}`)).statusCode).toBe(403);
    const s = (await as('u_zhang', 'GET', '/search?q=6688&type=doc')).body;
    expect(s).not.toContain('6688');
    expect(s).not.toContain(d.doc_id);
    expect((await as('u_zhang', 'GET', '/docs?scope=recent')).body).not.toContain(d.doc_id);
    // 管理员仍可见（系统管理员是所有资源的管理者，规则没变）
    expect((await as('ou_admin', 'GET', `/docs/${d.doc_id}`)).statusCode).toBe(200);

    // 分享给组织后可读、可搜
    const put = await as('u_li', 'PUT', `/docs/${d.doc_id}/permissions`, { link_share: 'org_view', members: [] });
    expect(put.statusCode, put.body).toBe(200);
    expect((await as('u_zhang', 'GET', `/docs/${d.doc_id}`)).statusCode).toBe(200);
    expect((await as('u_zhang', 'GET', '/search?q=6688&type=doc')).body).toContain(d.doc_id);

    // 老文档（没有授权记录）保持组织内可读
    const repo = (app as any).cos.ctx.repo;
    const now = new Date().toISOString();
    await repo.createDoc({ doc_id: 'doc_legacy', title: '老文档', markdown: '旧内容', created_by: 'u_li', created_at: now, updated_at: now, updated_by: 'u_li', yjs_update: null });
    expect((await as('u_zhang', 'GET', '/docs/doc_legacy')).statusCode).toBe(200);
  });

  it('机器人代同学新建的文档，所有者是这位同学，别人看不到', async () => {
    const { as, obo } = await setup();
    const d = (await obo('u_zhang', 'POST', '/docs', { title: '周会纪要', markdown: '进度正常' })).json();
    expect(d.created_by).toBe('u_zhang');
    expect((await as('u_zhang', 'GET', `/docs/${d.doc_id}`)).statusCode).toBe(200);
    expect((await as('u_li', 'GET', `/docs/${d.doc_id}`)).statusCode).toBe(403);
  });

  it('知识库页面仍继承空间权限（所有人可阅读的空间，别人能读）', async () => {
    const { as } = await setup();
    const sp = (await as('u_li', 'POST', '/wiki/spaces', { name: '新人手册' })).json();
    const page = (await as('u_li', 'POST', `/wiki/spaces/${sp.space_id}/nodes`, { title: '第一页', parent_id: null })).json();
    expect((await as('u_zhang', 'GET', `/docs/${page.obj_id}`)).statusCode).toBe(200);
    expect((await as('u_zhang', 'PATCH', `/docs/${page.obj_id}`, { markdown: 'x' })).statusCode).toBe(403);
  });
});

describe('C2 代同学往群里发消息', () => {
  it('同学在、机器人不在的群：可以代发，消息带代发标记并进审计', async () => {
    const { as, obo, bot } = await setup();
    const g = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: '课题组', member_ids: ['u_li', 'u_wang'] })).json();
    // 代码审查 A4 后端兜底：机器人不在的群，每次代发都要带同学确认过、绑定这个群的卡片
    let seq = 0;
    const send = async (payload: Ev = {}) => {
      const card = `card_c2_${++seq}`;
      const route = '/api/v1/bot/messages';
      await bot('POST', '/bot/messages', {
        receive_id: 'u_zhang', receive_id_type: 'user_id', msg_type: 'interactive_card',
        content: { card_id: card, kind: 'confirm', question: '代发？', options: ['确认', '取消'], answerable_by: ['u_zhang'], bound_action: { method: 'POST', route, path: route, target_id: g.chat_id } },
      });
      await as('u_zhang', 'POST', `/cards/${card}/actions`, { action: '确认' });
      return bot('POST', '/bot/messages', { receive_id: g.chat_id, receive_id_type: 'chat_id', msg_type: 'text', content: { text: '明天组会改到下午' }, ...payload }, { 'x-on-behalf-of': 'u_zhang', 'x-agent-confirm': card });
    };
    expect((await obo('u_zhang', 'POST', '/bot/messages', { receive_id: g.chat_id, receive_id_type: 'chat_id', msg_type: 'text', content: { text: '未确认' } })).json().code).toBe('BOT_CONFIRM_REQUIRED');
    const r = await send();
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().sender_id).toBe('bot');
    expect(r.json().content.sent_on_behalf_of).toEqual({ user_id: 'u_zhang', name: '张晓明' });
    // 群成员拉历史也能看到标记
    const hist = (await as('u_li', 'GET', `/chats/${g.chat_id}/messages`)).json().items as Ev[];
    expect(hist.find((m) => m.message_id === r.json().message_id)?.content.sent_on_behalf_of?.user_id).toBe('u_zhang');
    // 标记不能伪造
    const fake = await send({ content: { text: 'hi', sent_on_behalf_of: { user_id: 'u_wang', name: '王芳' } } });
    expect(fake.json().content.sent_on_behalf_of.user_id).toBe('u_zhang');
    // 审计
    const audit = (await bot('GET', '/bot/audit?on_behalf_of=u_zhang&writes_only=1')).json().items as Ev[];
    expect(audit.some((a) => a.route === '/api/v1/bot/messages' && a.status === 201)).toBe(true);
  });

  it('同学不在的群：一律拒绝（机器人在不在都一样）', async () => {
    const { as, obo } = await setup();
    const noBot = (await as('u_li', 'POST', '/chats', { chat_type: 'group', name: '李华的群', member_ids: ['u_wang'] })).json();
    const withBot = (await as('u_li', 'POST', '/chats', { chat_type: 'group', name: '有机器人', member_ids: ['u_wang', 'bot'] })).json();
    for (const c of [noBot, withBot]) {
      const r = await obo('u_zhang', 'POST', '/bot/messages', { receive_id: c.chat_id, receive_id_type: 'chat_id', msg_type: 'text', content: { text: 'hi' } });
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe('CHAT_NOT_MEMBER');
    }
    // 无效的代办身份
    expect((await obo('u_nobody', 'POST', '/bot/messages', { receive_id: withBot.chat_id, receive_id_type: 'chat_id', msg_type: 'text', content: { text: 'hi' } })).statusCode).toBe(403);
  });

  it('机器人回同学本人的单聊不加标记；替同学私发给别人加标记', async () => {
    const { obo } = await setup();
    const self = await obo('u_zhang', 'POST', '/bot/messages', { receive_id: 'u_zhang', receive_id_type: 'user_id', msg_type: 'text', content: { text: '好的' } });
    expect(self.statusCode).toBe(201);
    expect(self.json().content.sent_on_behalf_of).toBeUndefined();
    const other = await obo('u_zhang', 'POST', '/bot/messages', { receive_id: 'u_li', receive_id_type: 'user_id', msg_type: 'text', content: { text: '张晓明让我提醒你交报告' } });
    expect(other.json().content.sent_on_behalf_of.user_id).toBe('u_zhang');
  });

  it('不带代办身份时仍按 B1：机器人不在的群 403 BOT_NOT_IN_CHAT', async () => {
    const { as, bot } = await setup();
    const g = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: '课题组', member_ids: ['u_li'] })).json();
    const r = await bot('POST', '/bot/messages', { receive_id: g.chat_id, receive_id_type: 'chat_id', msg_type: 'text', content: { text: 'hi' } });
    expect(r.json().code).toBe('BOT_NOT_IN_CHAT');
  });

  it('机器人代办不能以同学本人名义发消息或转发', async () => {
    const { as, obo } = await setup();
    const g = (await as('u_zhang', 'POST', '/chats', { chat_type: 'group', name: '课题组', member_ids: ['u_li'] })).json();
    const r = await obo('u_zhang', 'POST', `/chats/${g.chat_id}/messages`, { msg_type: 'text', content: { text: '冒充本人' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('BOT_SCOPE_DENIED');
    const m = (await as('u_zhang', 'POST', `/chats/${g.chat_id}/messages`, { msg_type: 'text', content: { text: '本人发的' } })).json();
    const f = await obo('u_zhang', 'POST', '/messages/forward', { message_ids: [m.message_id], target_chat_ids: [g.chat_id], mode: 'single' });
    expect(f.statusCode).toBe(403);
    // 同学本人照常能发
    expect((await as('u_zhang', 'POST', `/chats/${g.chat_id}/messages`, { msg_type: 'text', content: { text: '本人' } })).statusCode).toBe(201);
  });
});
