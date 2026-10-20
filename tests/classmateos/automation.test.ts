import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
const tokens: Record<string, string> = {};
beforeAll(async () => {
  app = await buildApp({ secret: 's', botToken: 'btok', notificationScanner: false, users: [
    { user_id: 'a', name: '甲', password: 'pw', role: 'member' },
    { user_id: 'b', name: '乙', password: 'pw', role: 'member' },
  ] });
  for (const id of ['a', 'b']) tokens[id] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: id, password: 'pw' } })).json().access_token;
});
afterAll(async () => app.close());
const request = (user: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) => app.inject({ method, url: `/api/v1${path}`, headers: user === 'bot' ? { 'x-bot-token': 'btok' } : { authorization: `Bearer ${tokens[user]}` }, payload });

describe('M3 自动化后端', () => {
  it('触发器隔离、字段校验与停用', async () => {
    const bad = await request('a', 'POST', '/agent/triggers', { name: '错误', event: 'record.changed', prompt: '检查' });
    expect(bad.statusCode).toBe(422);
    const created = await request('a', 'POST', '/agent/triggers', { name: '每周检查', event: 'schedule', cron: '0 9 * * 1', prompt: '检查我能访问的项目' });
    expect(created.statusCode).toBe(201);
    const id = created.json().trigger_id;
    expect((await request('b', 'GET', '/agent/triggers')).json().items).toHaveLength(0);
    expect((await request('b', 'PATCH', `/agent/triggers/${id}`, { enabled: false })).statusCode).toBe(404);
    expect((await request('a', 'GET', '/bot/triggers')).statusCode).toBe(401);
    expect((await request('bot', 'GET', '/bot/triggers')).json().items.some((t: any) => t.trigger_id === id)).toBe(true);
    expect((await request('a', 'PATCH', `/agent/triggers/${id}`, { enabled: false })).statusCode).toBe(200);
    expect((await request('bot', 'GET', '/bot/triggers')).json().items.some((t: any) => t.trigger_id === id)).toBe(false);
  });

  it('后台任务只允许机器人更新，本人查询，结束后不可复活', async () => {
    expect((await request('a', 'POST', '/bot/jobs', { title: '测试', owner_id: 'a' })).statusCode).toBe(401);
    const created = await request('bot', 'POST', '/bot/jobs', { title: '测试', owner_id: 'a' });
    expect(created.statusCode).toBe(201);
    const id = created.json().job_id;
    expect((await request('b', 'GET', `/jobs/${id}`)).statusCode).toBe(404);
    expect((await request('a', 'GET', `/jobs/${id}`)).statusCode).toBe(200);
    const done = await request('bot', 'PATCH', `/bot/jobs/${id}`, { status: 'done', result: { message: '完成' } });
    expect(done.json().progress).toBe(1);
    expect((await request('bot', 'PATCH', `/bot/jobs/${id}`, { status: 'running' })).statusCode).toBe(409);
  });
});
