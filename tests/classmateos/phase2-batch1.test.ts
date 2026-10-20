import { afterEach, afterAll, describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../classmateos/server/app.js';
import { MemoryRepo } from '../../classmateos/server/memory-repo.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { AuthService } from '../../classmateos/server/auth-service.js';
import type { Repo } from '../../classmateos/server/repo.js';
const url = process.env.CLASSMATEOS_TEST_PG_URL;
const pool = url ? new pg.Pool({ connectionString: url }) : undefined;
const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
afterAll(async () => { await pool?.end(); });
const users = [{ user_id: 'a', name: '管理员', role: 'admin' as const, password: 'pw' }, { user_id: 'b', name: '成员', role: 'member' as const, password: 'pw' }];
describe.each(['memory', ...(pool ? ['postgres'] : [])])('批次1 %s', (backend) => {
  async function setup() {
    let repo: Repo = new MemoryRepo();
    if (backend === 'postgres') {
      await pool!.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
      repo = new PgRepo(pool!); await repo.init!();
      const { rows } = await pool!.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
      await pool!.query(`TRUNCATE ${rows.map(r => '"' + r.tablename + '"').join(',')} CASCADE`);
    }
    const start = async () => { const app = await buildApp({ repo, users, secret: 'batch1', notificationScanner: false }); apps.push(app); return app; };
    const app = await start();
    const call = (token: string | undefined, method: any, path: string, payload?: any) => app.inject({ method, url: '/api/v1' + path, headers: token ? { authorization: 'Bearer ' + token } : {}, payload });
    const login = async (u = 'a', password = 'pw', device_name = '测试设备') => {
      const r = await call(undefined, 'POST', '/auth/login', { username: u, password, device_name, platform: 'macos' });
      expect(r.statusCode, r.body).toBe(200); return r.json();
    };
    return { app, repo, start, call, login };
  }
  it('会话列表不泄露令牌，刷新保留sid，越权踢人404，退出其他设备保留自己', async () => {
    const { call, login } = await setup();
    const a = await login(), a2 = await login(), b = await login('b');
    const list = (await call(a.access_token, 'GET', '/users/me/sessions')).json();
    expect(list.items).toHaveLength(2); expect(list.items.filter((x: any) => x.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('refresh_jti');
    expect((await call(b.access_token, 'DELETE', '/users/me/sessions/' + a.session_id)).statusCode).toBe(404);
    const fresh = (await call(undefined, 'POST', '/auth/refresh', { refresh_token: a.refresh_token })).json();
    expect(fresh.session_id).toBe(a.session_id);
    expect((await call(fresh.access_token, 'POST', '/users/me/logout-all')).statusCode).toBe(200);
    expect((await call(a2.access_token, 'GET', '/users/me')).statusCode).toBe(401);
    expect((await call(undefined, 'POST', '/auth/refresh', { refresh_token: a2.refresh_token })).statusCode).toBe(401);
    expect((await call(fresh.access_token, 'GET', '/users/me')).statusCode).toBe(200);
    expect((await call(fresh.access_token, 'DELETE', '/users/me/sessions/' + a.session_id)).statusCode).toBe(204);
    expect((await call(fresh.access_token, 'GET', '/users/me')).statusCode).toBe(401);
  });
  it('改密检查旧密码与规则，其他会话失效，当前会话可刷新', async () => {
    const { call, login } = await setup(); const a = await login(), other = await login();
    expect((await call(a.access_token, 'POST', '/users/me/password', { old_password: 'bad', new_password: 'Password123' })).json().code).toBe('INVALID_PASSWORD');
    expect((await call(a.access_token, 'POST', '/users/me/password', { old_password: 'pw', new_password: 'weak' })).json().code).toBe('WEAK_PASSWORD');
    expect((await call(a.access_token, 'POST', '/users/me/password', { old_password: 'pw', new_password: 'Password123' })).statusCode).toBe(204);
    expect((await call(other.access_token, 'GET', '/users/me')).statusCode).toBe(401);
    expect((await call(a.access_token, 'GET', '/users/me')).statusCode).toBe(200);
    expect((await call(undefined, 'POST', '/auth/refresh', { refresh_token: a.refresh_token })).statusCode).toBe(200);
    expect((await call(undefined, 'POST', '/auth/login', { username: 'a', password: 'pw' })).statusCode).toBe(401);
    await login('a', 'Password123');
  });
  it('安全设置校验与权限、失败锁定、成功后失败计数归零', async () => {
    const { call, login } = await setup(); const a = await login(), b = await login('b');
    expect((await call(b.access_token, 'PUT', '/admin/security-settings', { lock_after_failures: 0 })).statusCode).toBe(403);
    expect((await call(a.access_token, 'PUT', '/admin/security-settings', { access_token_ttl_minutes: -1 })).statusCode).toBe(422);
    expect((await call(a.access_token, 'PUT', '/admin/security-settings', { lock_after_failures: 2, access_token_ttl_minutes: 5 })).statusCode).toBe(200);
    const bad = () => call(undefined, 'POST', '/auth/login', { username: 'b', password: 'bad' });
    expect((await bad()).statusCode).toBe(401);
    expect((await login('b')).expires_in).toBe(300);
    expect((await bad()).statusCode).toBe(401); expect((await bad()).statusCode).toBe(423);
    expect((await call(undefined, 'POST', '/auth/login', { username: 'b', password: 'pw' })).json().code).toBe('ACCOUNT_LOCKED');
  });
  it('管理员重置后必须改密码，业务接口受限，改密后解除', async () => {
    const { call, login } = await setup(); const a = await login(), b = await login('b');
    const reset = await call(a.access_token, 'POST', '/users/b/reset-password'); expect(reset.statusCode).toBe(200);
    expect((await call(b.access_token, 'GET', '/users/me')).statusCode).toBe(401);
    const next = await login('b', reset.json().password); expect(next.must_change_password).toBe(true); expect(next.user.must_change_password).toBe(true);
    expect((await call(next.access_token, 'GET', '/chats')).json().code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await call(next.access_token, 'POST', '/users/me/password', { old_password: reset.json().password, new_password: 'Password123' })).statusCode).toBe(204);
    expect((await call(next.access_token, 'GET', '/chats')).statusCode).toBe(200);
    expect((await login('b', 'Password123')).must_change_password).toBe(false);
  });
  it('重建服务后设置、会话吊销仍保留；空闲超时同时阻止刷新', async () => {
    const { call, login, repo, app, start } = await setup(); const a = await login(), b = await login('b');
    await call(a.access_token, 'PUT', '/admin/security-settings', { idle_timeout_minutes: 5 });
    await call(a.access_token, 'POST', '/users/b/logout-all');
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const restarted = await start();
    const r = await restarted.inject({ url: '/api/v1/users/me', headers: { authorization: 'Bearer ' + b.access_token } }); expect(r.statusCode).toBe(401);
    const service = new AuthService(repo); expect((await service.getSecurity()).idle_timeout_minutes).toBe(5);
    const rec = (await repo.getEntity('auth_session', a.session_id))!;
    rec.data.last_active_at = new Date(Date.now() - 10 * 60000).toISOString(); await repo.saveEntity(rec, rec.version);
    expect(await service.checkAccess({ sub: 'a', sid: a.session_id })).toBe('idle');
    expect((await restarted.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: a.refresh_token } })).statusCode).toBe(401);
  });
});
