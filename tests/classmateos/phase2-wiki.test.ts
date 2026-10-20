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
  return { app, call };
}

describe('知识库：空间与成员（R-WK-01）', () => {
  it('新建、可见范围、成员角色、改设置、删除', async () => {
    const { app, call } = await setup();
    try {
      const r = await call('alice', 'POST', '/wiki/spaces', { name: '新人指南', description: '入门', icon: 'book', color: 'green' });
      expect(r.statusCode).toBe(201);
      const sp = r.json();
      expect(sp).toMatchObject({ name: '新人指南', visibility: 'org', my_role: 'admin', page_count: 0 });
      expect((await call('bob', 'POST', '/wiki/spaces', { name: '新人指南' })).statusCode).toBe(409);
      // 所有人可阅读
      expect((await call('bob', 'GET', `/wiki/spaces/${sp.space_id}`)).json().my_role).toBe('viewer');
      expect((await call('bob', 'PATCH', `/wiki/spaces/${sp.space_id}`, { name: 'x' })).statusCode).toBe(403);
      // 仅成员：bob 可编辑，carol 看不到
      const m = await call('alice', 'PUT', `/wiki/spaces/${sp.space_id}/members`, { visibility: 'members', members: [{ member_type: 'user', member_id: 'bob', role: 'editor' }] });
      expect(m.statusCode).toBe(200);
      expect(m.json()).toMatchObject({ visibility: 'members', members: [{ member_id: 'bob', role: 'editor' }] });
      expect((await call('bob', 'GET', `/wiki/spaces/${sp.space_id}`)).json().my_role).toBe('editor');
      expect((await call('carol', 'GET', `/wiki/spaces/${sp.space_id}`)).statusCode).toBe(403);
      expect((await call('carol', 'GET', '/wiki/spaces')).json().items).toHaveLength(0);
      expect((await call('admin', 'GET', `/wiki/spaces/${sp.space_id}`)).json().my_role).toBe('admin');
      expect((await call('alice', 'PUT', `/wiki/spaces/${sp.space_id}/members`, { visibility: 'members', members: [{ member_type: 'user', member_id: 'bob', role: 'owner' }] })).statusCode).toBe(422);
      const p = await call('alice', 'PATCH', `/wiki/spaces/${sp.space_id}`, { description: '新简介', visibility: 'org' });
      expect(p.json()).toMatchObject({ description: '新简介', visibility: 'org' });
      expect((await call('carol', 'GET', `/wiki/spaces/${sp.space_id}`)).statusCode).toBe(200);
      // 删除：页面文档进回收站
      const page = (await call('alice', 'POST', `/wiki/spaces/${sp.space_id}/nodes`, { title: '第一页', parent_id: null })).json();
      expect((await call('bob', 'DELETE', `/wiki/spaces/${sp.space_id}`)).statusCode).toBe(403);
      expect((await call('alice', 'DELETE', `/wiki/spaces/${sp.space_id}`)).statusCode).toBe(204);
      expect((await call('alice', 'GET', `/wiki/spaces/${sp.space_id}`)).statusCode).toBe(404);
      expect((await call('alice', 'GET', '/docs?scope=trash')).json().items.map((d: any) => d.doc_id)).toContain(page.obj_id);
    } finally { await app.close(); }
  });
});

describe('知识库：目录树、页面即文档（R-WK-02 / 03）', () => {
  it('建页、排序、移动（含跨空间）、复制、删除、面包屑、权限继承', async () => {
    const { app, call } = await setup();
    try {
      const a = (await call('alice', 'POST', '/wiki/spaces', { name: 'Lab 知识库' })).json();
      const b = (await call('alice', 'POST', '/wiki/spaces', { name: '项目档案', visibility: 'members' })).json();
      const nodes = `/wiki/spaces/${a.space_id}/nodes`;
      const p1 = (await call('alice', 'POST', nodes, { title: '设备', parent_id: null })).json();
      const p2 = (await call('alice', 'POST', nodes, { title: '安全', parent_id: null })).json();
      const p0 = (await call('alice', 'POST', nodes, { title: '首页', parent_id: null, after_node_id: null })).json();
      const c1 = (await call('alice', 'POST', nodes, { title: '示波器', parent_id: p1.node_id })).json();
      const g1 = (await call('alice', 'POST', nodes, { title: '校准', parent_id: c1.node_id })).json();
      expect(p1.obj_type).toBe('doc');
      expect(p1.obj_id).toMatch(/^doc/);
      // 只读成员不能建页
      expect((await call('bob', 'POST', nodes, { title: 'x' })).statusCode).toBe(403);
      const top = (await call('bob', 'GET', nodes)).json().items;
      expect(top.map((n: any) => n.title)).toEqual(['首页', '设备', '安全']);
      expect(top[1].has_children).toBe(true);
      expect((await call('bob', 'GET', `${nodes}?parent_id=${p1.node_id}`)).json().items.map((n: any) => n.node_id)).toEqual([c1.node_id]);
      // 面包屑
      expect((await call('bob', 'GET', `/wiki/nodes/${g1.node_id}/ancestors`)).json().items.map((n: any) => n.title)).toEqual(['设备', '示波器']);

      // 页面即文档：权限继承空间，标题以文档为准
      const doc = (await call('bob', 'GET', `/docs/${p1.obj_id}`)).json();
      expect(doc.permissions).toMatchObject({ can_view: true, can_edit: false });
      expect(doc.wiki_space_id).toBe(a.space_id);
      const perm = (await call('alice', 'GET', `/docs/${p1.obj_id}/permissions`)).json();
      expect(perm.inherited_from).toEqual({ space_id: a.space_id, name: 'Lab 知识库' });
      await call('alice', 'PUT', `/wiki/spaces/${a.space_id}/members`, { visibility: 'org', members: [{ member_type: 'user', member_id: 'bob', role: 'editor' }] });
      expect((await call('bob', 'PATCH', `/docs/${p1.obj_id}`, { markdown: '# 设备清单\n示波器 3 台' })).statusCode).toBe(200);
      const renamed = await call('bob', 'PATCH', `/wiki/nodes/${p1.node_id}`, { title: '实验设备' });
      expect(renamed.json().title).toBe('实验设备');
      expect((await call('alice', 'GET', `/docs/${p1.obj_id}`)).json().title).toBe('实验设备');
      // 知识库页面不出现在「我的空间」
      expect((await call('alice', 'GET', '/docs?scope=mine')).json().items.some((d: any) => d.doc_id === p1.obj_id)).toBe(false);

      // 移动：安全 → 设备下面的第一个
      const mv = await call('alice', 'POST', `/wiki/nodes/${p2.node_id}/move`, { space_id: a.space_id, parent_id: p1.node_id, after_node_id: null });
      expect(mv.statusCode).toBe(200);
      expect((await call('alice', 'GET', `${nodes}?parent_id=${p1.node_id}`)).json().items.map((n: any) => n.title)).toEqual(['安全', '示波器']);
      // 不能移到自己的子页面下
      expect((await call('alice', 'POST', `/wiki/nodes/${p1.node_id}/move`, { space_id: a.space_id, parent_id: g1.node_id, after_node_id: null })).statusCode).toBe(400);
      // 跨空间：整棵子树搬走，权限按新空间（仅成员）
      const cross = await call('alice', 'POST', `/wiki/nodes/${c1.node_id}/move`, { space_id: b.space_id, parent_id: null, after_node_id: null });
      expect(cross.json().space_id).toBe(b.space_id);
      expect((await call('alice', 'GET', `/wiki/spaces/${b.space_id}/nodes?parent_id=${c1.node_id}`)).json().items.map((n: any) => n.node_id)).toEqual([g1.node_id]);
      expect((await call('carol', 'GET', `/docs/${g1.obj_id}`)).statusCode).toBe(403);
      // bob 在 B 空间里没有编辑权限，不能把页面移进去
      expect((await call('bob', 'POST', `/wiki/nodes/${p2.node_id}/move`, { space_id: b.space_id, parent_id: null })).statusCode).toBe(403);

      // 复制（含子页面）
      const cp = await call('alice', 'POST', `/wiki/nodes/${p1.node_id}/copy`, { with_children: true });
      expect(cp.statusCode).toBe(201);
      const copy = cp.json();
      expect(copy.title).toBe('实验设备 副本');
      expect(copy.obj_id).not.toBe(p1.obj_id);
      expect((await call('alice', 'GET', `/docs/${copy.obj_id}`)).json().markdown).toContain('示波器 3 台');
      expect((await call('alice', 'GET', `${nodes}?parent_id=${copy.node_id}`)).json().items.map((n: any) => n.title)).toEqual(['安全']);
      expect((await call('alice', 'GET', nodes)).json().items.map((n: any) => n.title)).toEqual(['首页', '实验设备', '实验设备 副本']);

      // 删除：子页面一起，文档进回收站
      expect((await call('alice', 'DELETE', `/wiki/nodes/${p1.node_id}`)).statusCode).toBe(204);
      expect((await call('alice', 'GET', `/wiki/nodes/${p2.node_id}`)).statusCode).toBe(404);
      const trash = (await call('alice', 'GET', '/docs?scope=trash')).json().items.map((d: any) => d.doc_id);
      expect(trash).toEqual(expect.arrayContaining([p1.obj_id, p2.obj_id]));
      expect((await call('alice', 'GET', `/wiki/spaces/${a.space_id}`)).json().page_count).toBe(3);
      void p0;
    } finally { await app.close(); }
  });

  it('移入已有文档、搜索、最近访问、收藏', async () => {
    const { app, call } = await setup();
    try {
      const sp = (await call('alice', 'POST', '/wiki/spaces', { name: '手册' })).json();
      const doc = (await call('alice', 'POST', '/docs', { title: '标定流程', markdown: '机械臂标定需要先归零' })).json();
      expect((await call('bob', 'POST', `/wiki/spaces/${sp.space_id}/import`, { doc_id: doc.doc_id })).statusCode).toBe(403);
      const n = await call('alice', 'POST', `/wiki/spaces/${sp.space_id}/import`, { doc_id: doc.doc_id, parent_id: null });
      expect(n.statusCode).toBe(201);
      const node = n.json();
      expect(node).toMatchObject({ title: '标定流程', obj_id: doc.doc_id, space_name: '手册' });
      expect((await call('alice', 'POST', `/wiki/spaces/${sp.space_id}/import`, { doc_id: doc.doc_id })).statusCode).toBe(409);

      // 空间内搜索（scope=wiki 读顶层 items）
      const s = (await call('bob', 'GET', `/search?scope=wiki&space_id=${sp.space_id}&q=归零`)).json();
      expect(s.items).toHaveLength(1);
      expect(s.items[0]).toMatchObject({ type: 'wiki', node_id: node.node_id, space_name: '手册', path: '手册' });
      expect(s.items[0].snippet).toContain('<em>归零</em>');
      // 全局搜索（带 types）
      const g = (await call('bob', 'GET', '/search?q=标定&types=wiki')).json();
      expect(g.groups[0].items[0].id).toBe(node.node_id);

      // 收藏
      expect((await call('bob', 'POST', `/wiki/nodes/${node.node_id}/star`)).statusCode).toBe(204);
      const starred = (await call('bob', 'GET', '/wiki/starred')).json().items;
      expect(starred).toHaveLength(1);
      expect(starred[0]).toMatchObject({ starred: true, space_name: '手册' });
      expect((await call('bob', 'DELETE', `/wiki/nodes/${node.node_id}/star`)).statusCode).toBe(204);
      expect((await call('bob', 'GET', '/wiki/starred')).json().items).toHaveLength(0);
      // 最近访问：打开过的页面
      await call('bob', 'GET', `/docs/${doc.doc_id}`);
      const recent = (await call('bob', 'GET', '/wiki/recent')).json().items;
      expect(recent.map((x: any) => x.node_id)).toEqual([node.node_id]);
      // 实时：能看到空间才能订阅
      await call('alice', 'PUT', `/wiki/spaces/${sp.space_id}/members`, { visibility: 'members', members: [] });
      expect(await (app as any).cos.ctx.authorizeTopic({ sub: 'bob', role: 'member' }, `wiki:${sp.space_id}`)).toBe('FORBIDDEN');
      expect(await (app as any).cos.ctx.authorizeTopic({ sub: 'alice', role: 'member' }, `wiki:${sp.space_id}`)).toBeNull();
      expect((await call('bob', 'GET', '/wiki/recent')).json().items).toHaveLength(0);
    } finally { await app.close(); }
  });
});
