/**
 * AGENT_PLAN §2.2：机器人代表同学操作（X-Bot-Token + X-On-Behalf-Of）+ 作用域 + 审计。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type PlatformUser } from '../../classmateos/server/app.js';
import { BotScopePolicy } from '../../classmateos/server/agent-principal.js';

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

async function setup() {
  const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok', notificationScanner: false });
  apps.push(app);
  const login = async (u: string, pw: string) =>
    (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: pw } })).json()
      .access_token as string;
  const asUser = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as Ev });
  const asBot = (obo: string, method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: { 'x-bot-token': 'btok', 'x-on-behalf-of': obo, ...extra },
      payload: payload as Ev,
    });
  return { app, login, asUser, asBot };
}

describe('机器人代办', () => {
  it('代同学建文档，创建者记为该同学，并写审计', async () => {
    const { asBot, app } = await setup();
    const r = await asBot('u_zhang', 'POST', '/docs', { title: '器材清单', markdown: '# 器材' }, {
      'x-agent-session': 'chat_c1',
      'x-agent-tool-call': 'call_1',
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().created_by).toBe('u_zhang');

    const audit = (await app.inject({ method: 'GET', url: '/api/v1/bot/audit?writes_only=1', headers: { 'x-bot-token': 'btok' } })).json();
    expect(audit.items[0]).toMatchObject({
      actor: 'bot',
      on_behalf_of: 'u_zhang',
      method: 'POST',
      route: '/api/v1/docs',
      status: 201,
      session_id: 'chat_c1',
      tool_call_id: 'call_1',
    });
  });

  it('权限按被代办人算：保密记录只有本人能通过机器人拿到', async () => {
    const { asBot, login, asUser } = await setup();
    const a = await login('ou_admin', 'admin');
    const rec = (
      await asUser(a, 'POST', '/tables/projects/records', {
        fields: { project_id: 'P-SEC', title: '机密项目', owner_open_id: [{ id: 'u_li' }], visibility: '保密' },
      })
    ).json();
    expect((await asBot('u_zhang', 'GET', `/tables/projects/records/${rec.record_id}`)).statusCode).toBe(404);
    expect((await asBot('u_li', 'GET', `/tables/projects/records/${rec.record_id}`)).statusCode).toBe(200);
    const list = (await asBot('u_zhang', 'GET', '/tables/projects/records')).json();
    expect(list.items.map((r: Ev) => r.record_id)).not.toContain(rec.record_id);
  });

  it('作用域黑名单：不能代改账号、文档权限', async () => {
    const { asBot } = await setup();
    const r = await asBot('ou_admin', 'POST', '/users', { user_id: 'x', name: 'x', password: 'p' });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('BOT_SCOPE_DENIED');
    const d = (await asBot('u_zhang', 'POST', '/docs', { title: 't' })).json();
    expect((await asBot('u_zhang', 'PUT', `/docs/${d.doc_id}/permissions`, { link_share: 'none' })).json().code).toBe('BOT_SCOPE_DENIED');
  });

  it('令牌错 401、代办对象不存在 403、不能代 bot 自己', async () => {
    const { app, asBot } = await setup();
    const bad = await app.inject({ method: 'GET', url: '/api/v1/docs', headers: { 'x-bot-token': 'nope', 'x-on-behalf-of': 'u_zhang' } });
    expect(bad.statusCode).toBe(401);
    expect((await asBot('ghost', 'GET', '/docs')).json().code).toBe('ON_BEHALF_OF_INVALID');
    expect((await asBot('bot', 'GET', '/docs')).json().code).toBe('ON_BEHALF_OF_INVALID');
  });

  it('没有 X-On-Behalf-Of 时 bot 令牌仍不能访问用户接口', async () => {
    const { app } = await setup();
    const r = await app.inject({ method: 'GET', url: '/api/v1/docs', headers: { 'x-bot-token': 'btok' } });
    expect(r.statusCode).toBe(401);
  });

  it('审计接口：普通成员不能看，管理员可以', async () => {
    const { app, login } = await setup();
    const z = await login('u_zhang', 'pw');
    const a = await login('ou_admin', 'admin');
    const get = (t: string) => app.inject({ method: 'GET', url: '/api/v1/bot/audit', headers: { authorization: `Bearer ${t}` } });
    expect((await get(z)).statusCode).toBe(403);
    expect((await get(a)).statusCode).toBe(200);
  });
});

describe('BotScopePolicy', () => {
  it('精确与前缀匹配、方法通配', () => {
    const p = new BotScopePolicy({ deny: ['DELETE /api/v1/tables/:table_key', '* /api/v1/auth/*'] });
    expect(p.check('DELETE', '/api/v1/tables/:table_key')).not.toBeNull();
    expect(p.check('GET', '/api/v1/tables/:table_key')).toBeNull();
    expect(p.check('post', '/api/v1/auth/login')).not.toBeNull();
  });
});
