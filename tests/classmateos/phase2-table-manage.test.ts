import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';

async function setup() {
  const app = await buildApp({ secret: 's', notificationScanner: false, users: [
    { user_id: 'admin', name: 'Admin', password: 'pw', role: 'admin' },
    { user_id: 'alice', name: 'Alice', password: 'pw', role: 'member' },
    { user_id: 'bob', name: 'Bob', password: 'pw', role: 'member' },
    { user_id: 'carol', name: 'Carol', password: 'pw', role: 'member' },
  ] });
  const tokens: Record<string, string> = {};
  const call = async (u: string, method: string, url: string, payload?: unknown) => {
    tokens[u] ??= (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json().access_token;
    return app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${tokens[u]}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  };
  const table = async (u: string, name: string) => (await call(u, 'POST', '/tables', {
    name, primary_field: 'name',
    fields: [
      { field_name: 'name', title: '名称', type: 1, required: true },
      { field_name: 'state', title: '状态', type: 3, options: ['空闲', '借出'] },
    ],
  })).json();
  return { app, call, table };
}

describe('多维表格：表权限（table.permissions）', () => {
  it('默认所有人可编辑；改成 members 后只有协作者能看，viewer 只读', async () => {
    const { app, call, table } = await setup();
    try {
      const t = await table('alice', '借用登记');
      expect(t.permissions).toMatchObject({ can_view: true, can_manage: true });
      const rec = (await call('bob', 'POST', `/tables/${t.key}/records`, { fields: { name: '示波器' } }));
      expect(rec.statusCode).toBe(201);
      const perm = (await call('bob', 'GET', `/tables/${t.key}/permissions`)).json();
      expect(perm).toMatchObject({ owner_id: 'alice', visibility: 'all', members: [] });
      // 非管理者不能改权限
      expect((await call('bob', 'PUT', `/tables/${t.key}/permissions`, { visibility: 'members', members: [] })).statusCode).toBe(403);
      const put = await call('alice', 'PUT', `/tables/${t.key}/permissions`, { visibility: 'members', members: [{ member_type: 'user', member_id: 'bob', role: 'viewer' }] });
      expect(put.statusCode).toBe(200);
      expect(put.json().visibility).toBe('members');
      // carol 看不到
      expect((await call('carol', 'GET', '/tables')).json().items.some((x: any) => x.key === t.key)).toBe(false);
      expect((await call('carol', 'GET', `/tables/${t.key}`)).statusCode).toBe(403);
      expect((await call('carol', 'GET', `/tables/${t.key}/records`)).statusCode).toBe(403);
      // bob 只读
      const bobMeta = (await call('bob', 'GET', `/tables/${t.key}`)).json();
      expect(bobMeta.permissions).toMatchObject({ can_view: true, can_edit: false, can_manage: false });
      expect((await call('bob', 'GET', `/tables/${t.key}/records`)).statusCode).toBe(200);
      expect((await call('bob', 'POST', `/tables/${t.key}/records`, { fields: { name: 'x' } })).statusCode).toBe(403);
      // 管理员总能管理
      expect((await call('admin', 'GET', `/tables/${t.key}/records`)).statusCode).toBe(200);
      // 校验：commenter 不支持
      expect((await call('alice', 'PUT', `/tables/${t.key}/permissions`, { visibility: 'members', members: [{ member_type: 'user', member_id: 'bob', role: 'commenter' }] })).statusCode).toBe(422);
      // 内置表：管理员可以设置权限
      expect((await call('admin', 'PUT', '/tables/projects/permissions', { visibility: 'all', members: [] })).statusCode).toBe(200);
      expect((await call('alice', 'PUT', '/tables/projects/permissions', { visibility: 'members', members: [] })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});

describe('多维表格：表管理（table.manage）', () => {
  it('改名、复制（含记录）、删除，重名 409，权限检查', async () => {
    const { app, call, table } = await setup();
    try {
      const t = await table('alice', '设备');
      await table('alice', '耗材');
      await call('alice', 'POST', `/tables/${t.key}/records`, { fields: { name: '示波器', state: '空闲' } });
      expect((await call('bob', 'PATCH', `/tables/${t.key}`, { name: '新名' })).statusCode).toBe(403);
      expect((await call('alice', 'PATCH', `/tables/${t.key}`, { name: '耗材' })).statusCode).toBe(409);
      const renamed = await call('alice', 'PATCH', `/tables/${t.key}`, { name: '实验设备', description: '说明', icon: 'star' });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ name: '实验设备', description: '说明', icon: 'star' });
      expect((await call('bob', 'GET', '/tables')).json().items.find((x: any) => x.key === t.key).name).toBe('实验设备');
      // 改名后旧名可以再用，新名不能重复建
      expect((await call('alice', 'POST', '/tables', { name: '实验设备', primary_field: 'name', fields: [{ field_name: 'name', title: '名称', type: 1, required: true }, { field_name: 'state', title: '状态', type: 3, options: ['空闲'] }] })).statusCode).toBe(409);

      const copy = await call('bob', 'POST', `/tables/${t.key}/copy`, { name: '设备副本', with_records: true });
      expect(copy.statusCode).toBe(201);
      const c = copy.json();
      expect(c.copied_records).toBe(1);
      expect(c.created_by).toBe('bob');
      expect(c.fields.map((f: any) => f.field_name)).toEqual(['name', 'state']);
      const rows = (await call('bob', 'GET', `/tables/${c.key}/records`)).json().items;
      expect(rows[0].fields.name).toBe('示波器');

      // 删除：创建人可以删；被授予管理权限的普通成员（没有 table.delete）不能删；管理员可以；内置表不能删
      await call('bob', 'PUT', `/tables/${c.key}/permissions`, { visibility: 'all', members: [{ member_type: 'user', member_id: 'carol', role: 'manager' }] });
      expect((await call('carol', 'GET', `/tables/${c.key}`)).json().permissions).toMatchObject({ can_manage: true, can_delete: false });
      expect((await call('carol', 'DELETE', `/tables/${c.key}`)).statusCode).toBe(403);
      expect((await call('bob', 'GET', `/tables/${c.key}`)).json().permissions.can_delete).toBe(true);
      expect((await call('admin', 'DELETE', `/tables/${c.key}`)).statusCode).toBe(204);
      expect((await call('bob', 'GET', `/tables/${c.key}`)).statusCode).toBe(404);
      expect((await call('admin', 'DELETE', '/tables/projects')).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});

describe('多维表格：记录评论（record.comments）', () => {
  it('能看到记录就能评论；@ 提到的人收到通知；只能删自己的', async () => {
    const { app, call, table } = await setup();
    try {
      const t = await table('alice', '问题跟踪');
      const rec = (await call('alice', 'POST', `/tables/${t.key}/records`, { fields: { name: '投影仪坏了' } })).json();
      const url = `/tables/${t.key}/records/${rec.record_id}/comments`;
      const c = await call('bob', 'POST', url, { content: { text: '@Alice 看一下', mentions: [{ user_id: 'alice', name: 'Alice', offset: 0, length: 6 }] } });
      expect(c.statusCode).toBe(201);
      expect(c.json()).toMatchObject({ user_id: 'bob', content: { text: '@Alice 看一下' } });
      await call('alice', 'POST', url, { content: '收到' });
      const list = (await call('carol', 'GET', url)).json().items;
      expect(list.map((x: any) => x.content.text)).toEqual(['@Alice 看一下', '收到']);
      expect((await call('alice', 'POST', url, { content: { text: '  ' } })).statusCode).toBe(422);
      expect((await call('alice', 'GET', `/tables/${t.key}/records/nope/comments`)).statusCode).toBe(404);
      const notes = (await call('alice', 'GET', '/notifications')).json().items;
      expect(notes.some((n: any) => n.type === 'record.mention')).toBe(true);
      // carol 不能删 bob 的；表所有者 alice 可以
      const id = list[0].comment_id;
      expect((await call('carol', 'DELETE', `${url}/${id}`)).statusCode).toBe(403);
      expect((await call('alice', 'DELETE', `${url}/${id}`)).statusCode).toBe(204);
      // 收紧表权限后，看不到表的人也看不到评论
      await call('alice', 'PUT', `/tables/${t.key}/permissions`, { visibility: 'members', members: [] });
      expect((await call('carol', 'GET', url)).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
