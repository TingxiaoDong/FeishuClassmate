import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';

async function setup() {
  const app = await buildApp({ secret: 's', notificationScanner: false, users: [
    { user_id: 'alice', name: 'Alice', password: 'pw', role: 'member' },
    { user_id: 'bob', name: 'Bob', password: 'pw', role: 'member' },
  ] });
  const login = async (u: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json();
  const tokens: Record<string, string> = {};
  const call = async (u: string | undefined, method: string, url: string, payload?: unknown) => {
    if (u && !tokens[u]) tokens[u] = (await login(u)).access_token;
    return app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: u ? { authorization: `Bearer ${tokens[u]}` } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
  };
  return { app, call };
}

describe('工作台应用（workbench.apps）', () => {
  it('内置应用按开关过滤；快捷方式个人保存、整体覆盖、保留旧 id', async () => {
    const { app, call } = await setup();
    try {
      const apps = (await call('alice', 'GET', '/workbench/apps')).json();
      expect(apps.builtin).toContain('bitable');
      expect(apps.builtin).toContain('wiki'); // 知识库已开
      expect(apps.shortcuts).toEqual([]);
      const saved = await call('alice', 'PUT', '/workbench/shortcuts', { shortcuts: [
        { type: 'doc', target_id: 'doc_1', name: ' 周报 ' },
        { type: 'table_view', target_id: 'view_1', table_key: 'projects', name: '进行中', icon: 'star' },
      ] });
      expect(saved.statusCode).toBe(200);
      const list = saved.json().shortcuts;
      expect(list.map((s: any) => s.name)).toEqual(['周报', '进行中']);
      expect(list.every((s: any) => typeof s.id === 'string' && s.id)).toBe(true);
      // 调换顺序，旧 id 保留
      const again = (await call('alice', 'PUT', '/workbench/shortcuts', { shortcuts: [list[1], { ...list[0], id: 'fake' }] })).json().shortcuts;
      expect(again[0].id).toBe(list[1].id);
      expect(again[1].id).not.toBe('fake');
      expect((await call('bob', 'GET', '/workbench/apps')).json().shortcuts).toEqual([]);
      expect((await call('alice', 'PUT', '/workbench/shortcuts', { shortcuts: [{ type: 'table_view', target_id: 'v', name: 'x' }] })).statusCode).toBe(422);
      expect((await call('alice', 'PUT', '/workbench/shortcuts', { shortcuts: [{ type: 'approval_template', target_id: 'v', name: 'x' }] })).statusCode).toBe(422);
      expect((await call(undefined, 'GET', '/workbench/apps')).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});

describe('扫码登录（auth.qr_login）', () => {
  it('waiting → scanned → confirmed，会话只交付一次且可用', async () => {
    const { app, call } = await setup();
    try {
      const created = await call(undefined, 'POST', '/auth/qr', { device_name: 'MacBook' });
      expect(created.statusCode).toBe(201);
      const { qr_id, qr_content } = created.json();
      expect(qr_content).toBe(`classmateos://qr-login?qr_id=${qr_id}`);
      expect((await call(undefined, 'GET', `/auth/qr/${qr_id}`)).json().status).toBe('waiting');
      // 没扫码不能确认；未登录不能扫码
      expect((await call(undefined, 'POST', `/auth/qr/${qr_id}/scan`)).statusCode).toBe(401);
      expect((await call('alice', 'POST', `/auth/qr/${qr_id}/confirm`)).statusCode).toBe(409);
      const scanned = (await call('alice', 'POST', `/auth/qr/${qr_id}/scan`)).json();
      expect(scanned).toMatchObject({ status: 'scanned', device_name: 'MacBook', scanned_by_name: 'Alice' });
      expect((await call('bob', 'POST', `/auth/qr/${qr_id}/scan`)).statusCode).toBe(409);
      expect((await call(undefined, 'GET', `/auth/qr/${qr_id}`)).json()).toMatchObject({ status: 'scanned', scanned_by_name: 'Alice' });
      expect((await call('alice', 'POST', `/auth/qr/${qr_id}/confirm`)).statusCode).toBe(204);
      const done = (await call(undefined, 'GET', `/auth/qr/${qr_id}`)).json();
      expect(done.status).toBe('confirmed');
      expect(done.session.user.user_id).toBe('alice');
      expect((await call(undefined, 'GET', `/auth/qr/${qr_id}`)).statusCode).toBe(404);
      const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: { authorization: `Bearer ${done.session.access_token}` } });
      expect(me.statusCode).toBe(200);
      const sessions = (await call('alice', 'GET', '/users/me/sessions')).json().items;
      expect(sessions.some((s: any) => s.device_name === 'MacBook')).toBe(true);
    } finally { await app.close(); }
  });

  it('取消后失效；不存在的返回 404', async () => {
    const { app, call } = await setup();
    try {
      const { qr_id } = (await call(undefined, 'POST', '/auth/qr', { device_name: 'PC' })).json();
      await call('bob', 'POST', `/auth/qr/${qr_id}/scan`);
      expect((await call('bob', 'POST', `/auth/qr/${qr_id}/cancel`)).statusCode).toBe(204);
      expect((await call(undefined, 'GET', `/auth/qr/${qr_id}`)).json().status).toBe('canceled');
      expect((await call('bob', 'POST', `/auth/qr/${qr_id}/confirm`)).statusCode).toBe(409);
      expect((await call(undefined, 'GET', '/auth/qr/nope')).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
