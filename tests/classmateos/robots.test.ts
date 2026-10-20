import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import type { FastifyInstance } from 'fastify';
let app: FastifyInstance;
const tokens: Record<string, string> = {};
beforeAll(async () => {
  app = await buildApp({ secret: 's', botToken: 'btok', notificationScanner: false, users: [
    { user_id: 'admin', name: '管', password: 'pw', role: 'admin' }, { user_id: 'a', name: '甲', password: 'pw', role: 'member' },
  ] });
  for (const id of ['admin', 'a']) tokens[id] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: id, password: 'pw' } })).json().access_token;
});
afterAll(async () => app.close());
const req = (who: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object, extra: Record<string, string> = {}) =>
  app.inject({ method, url: `/api/v1${url}`, payload, headers: who === 'bot' ? { 'x-bot-token': 'btok', ...extra } : { authorization: `Bearer ${tokens[who]}` } });
describe('M4 平台机器人接口', () => {
  it('地点只能由管理员本人维护，机器人只能读取', async () => {
    expect((await req('a', 'POST', '/robots/temi/locations', { name: '会议室', allowed: true })).statusCode).toBe(403);
    expect((await req('admin', 'POST', '/robots/temi/locations', { name: '会议室', aliases: ['302'], allowed: true })).statusCode).toBe(201);
    expect((await req('bot', 'GET', '/bot/robots/temi/locations')).json().items[0].name).toBe('会议室');
    expect((await req('bot', 'GET', '/bot/robots/temi/locations', undefined, { 'x-on-behalf-of': 'a' })).statusCode).toBe(401);
  });
  it('状态和日志只能由机器人身份上报，日志仅管理员可看', async () => {
    const status = { online: true, mock: true, battery: 80, charging: false, is_moving: false, location: '会议室', current_action: null, controller: null };
    expect((await req('a', 'PUT', '/bot/robots/temi/status', status)).statusCode).toBe(401);
    expect((await req('bot', 'PUT', '/bot/robots/temi/status', status)).statusCode).toBe(200);
    expect((await req('a', 'GET', '/robots/temi/status')).json()).toMatchObject({ online: true, battery: 80, stale: false });
    expect((await req('bot', 'POST', '/bot/robots/temi/logs', { kind: 'say', text: '播报测试', ok: true })).statusCode).toBe(201);
    expect((await req('a', 'GET', '/robots/temi/logs')).statusCode).toBe(403);
    expect((await req('admin', 'GET', '/robots/temi/logs')).json().items[0].text).toBe('播报测试');
  });
  it('同学本人能按 App 急停，事件只推给大脑，机器人身份不能按', async () => {
    const r = await req('a', 'POST', '/robots/temi/estop');
    expect(r.statusCode).toBe(200);
    expect((await req('bot', 'POST', '/robots/temi/estop')).statusCode).not.toBe(200);
    expect((await req('bot', 'POST', '/robots/temi/estop', undefined, { 'x-on-behalf-of': 'a' })).statusCode).toBe(403);
    expect((await req('admin', 'GET', '/robots/temi/logs')).json().items.some((x: any) => x.text === '甲在 App 里按了急停')).toBe(true);
  });
});

