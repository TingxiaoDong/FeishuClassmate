import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';

describe('迭代2 文档分享权限', () => {
  it('关闭链接分享后隔离陌生人，协作者权限即时生效', async () => {
    const app = await buildApp({ secret: 's', notificationScanner: false, users: [
      { user_id: 'owner', name: 'Owner', password: 'pw', role: 'member' },
      { user_id: 'editor', name: 'Editor', password: 'pw', role: 'member' },
      { user_id: 'stranger', name: 'Stranger', password: 'pw', role: 'member' },
    ] });
    try {
      const token = async (u: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json().access_token;
      const h = async (u: string) => ({ authorization: `Bearer ${await token(u)}` });
      const doc = (await app.inject({ method: 'POST', url: '/api/v1/docs', headers: await h('owner'), payload: { title: '私密', markdown: 'secret' } })).json();
      const put = await app.inject({ method: 'PUT', url: `/api/v1/docs/${doc.doc_id}/permissions`, headers: await h('owner'), payload: { link_share: 'off', members: [{ member_type: 'user', member_id: 'editor', role: 'editor' }] } });
      expect(put.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/v1/docs/${doc.doc_id}`, headers: await h('stranger') })).statusCode).toBe(403);
      const list = await app.inject({ method: 'GET', url: '/api/v1/docs', headers: await h('stranger') });
      expect(list.json().items.some((d: any) => d.doc_id === doc.doc_id)).toBe(false);
      expect(await (app as any).cos.ctx.authorizeTopic({ sub: 'stranger', role: 'member' }, `doc:${doc.doc_id}`)).toBe('FORBIDDEN');
      const edited = await app.inject({ method: 'PATCH', url: `/api/v1/docs/${doc.doc_id}`, headers: await h('editor'), payload: { markdown: 'edited' } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().permissions.can_edit).toBe(true);
      expect((await app.inject({ method: 'PUT', url: `/api/v1/docs/${doc.doc_id}/permissions`, headers: await h('editor'), payload: { link_share: 'org_edit', members: [] } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url: `/api/v1/docs/${doc.doc_id}/permissions`, headers: await h('owner'), payload: { version: 1, link_share: 'off', members: [{ member_type: 'user', member_id: 'editor', role: 'viewer' }] } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/docs/${doc.doc_id}`, headers: await h('editor'), payload: { markdown: 'blocked' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url: `/api/v1/docs/${doc.doc_id}/permissions`, headers: await h('owner'), payload: { version: 1, link_share: 'off', members: [] } })).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it('权限申请原子审批，不降级既有权限，并支持所有者转移', async () => {
    const app = await buildApp({ secret: 's', notificationScanner: false, users: [
      { user_id: 'owner', name: 'Owner', password: 'pw', role: 'member' },
      { user_id: 'req', name: 'Requester', password: 'pw', role: 'member' },
      { user_id: 'next', name: 'Next', password: 'pw', role: 'member' },
    ] });
    try {
      const h = async (u: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json().access_token}` });
      const doc = (await app.inject({ method: 'POST', url: '/api/v1/docs', headers: await h('owner'), payload: { title: '申请' } })).json();
      await app.inject({ method: 'PUT', url: `/api/v1/docs/${doc.doc_id}/permissions`, headers: await h('owner'), payload: { link_share: 'off', members: [] } });
      const created = await app.inject({ method: 'POST', url: `/api/v1/docs/${doc.doc_id}/access-requests`, headers: await h('req'), payload: { role: 'editor', note: '需要修改' } });
      expect(created.statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: `/api/v1/docs/${doc.doc_id}/access-requests`, headers: await h('req'), payload: { role: 'viewer' } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: `/api/v1/docs/${doc.doc_id}/access-requests/${created.json().request_id}/approve`, headers: await h('req') })).statusCode).toBe(403);
      const approved = await Promise.all([1, 2].map(async () => app.inject({ method: 'POST', url: `/api/v1/docs/${doc.doc_id}/access-requests/${created.json().request_id}/approve`, headers: await h('owner') })));
      expect(approved.map(r => r.statusCode).sort()).toEqual([200, 409]);
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/docs/${doc.doc_id}`, headers: await h('req'), payload: { markdown: 'ok' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/v1/docs/${doc.doc_id}/transfer`, headers: await h('req'), payload: { owner_id: 'req' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/v1/docs/${doc.doc_id}/transfer`, headers: await h('owner'), payload: { owner_id: 'next' } })).statusCode).toBe(200);
      const perms = (await app.inject({ method: 'GET', url: `/api/v1/docs/${doc.doc_id}/permissions`, headers: await h('next') })).json();
      expect(perms.owner_id).toBe('next');
      expect(perms.members).toContainEqual({ member_type: 'user', member_id: 'owner', role: 'manager' });
    } finally { await app.close(); }
  });
});
