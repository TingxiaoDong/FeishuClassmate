import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import { DashboardRangeError, parseDashboardRange } from '../../classmateos/server/dashboard.js';

const users = [
  { user_id: 'owner', name: 'Owner', password: 'pw', role: 'member' as const },
  { user_id: 'other', name: 'Other', password: 'pw', role: 'member' as const },
];

async function setup() {
  const app = await buildApp({ secret: 's', notificationScanner: false, users });
  const tokens = new Map<string, string>();
  const h = async (u: string) => {
    if (!tokens.has(u)) tokens.set(u, (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json().access_token);
    return { authorization: `Bearer ${tokens.get(u)}` };
  };
  const call = async (u: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: await h(u), ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { app, call };
}

describe('云文档：文件夹、收藏、回收站（doc.folders）', () => {
  it('文件夹增改删、文档移动与按文件夹列出', async () => {
    const { app, call } = await setup();
    try {
      const a = await call('owner', 'POST', '/folders', { name: '课程', parent_id: null });
      expect(a.statusCode).toBe(201);
      const fa = a.json();
      expect(fa).toMatchObject({ name: '课程', parent_id: null });
      expect((await call('owner', 'POST', '/folders', { name: '课程', parent_id: null })).statusCode).toBe(409);
      expect((await call('owner', 'POST', '/folders', { name: '  ' })).statusCode).toBe(422);
      const fb = (await call('owner', 'POST', '/folders', { name: '作业', parent_id: fa.folder_id })).json();
      // 不能移到自己的下级
      expect((await call('owner', 'PATCH', `/folders/${fa.folder_id}`, { parent_id: fb.folder_id })).statusCode).toBe(400);
      expect((await call('owner', 'PATCH', `/folders/${fb.folder_id}`, { name: '作业2' })).json().name).toBe('作业2');
      // 文件夹是个人的
      expect((await call('other', 'GET', `/folders?parent_id=${fa.folder_id}`)).statusCode).toBe(404);
      expect((await call('owner', 'GET', '/folders')).json().items.map((f: any) => f.folder_id)).toEqual([fa.folder_id]);
      expect((await call('owner', 'GET', `/folders?parent_id=${fa.folder_id}`)).json().items).toHaveLength(1);

      const inFolder = (await call('owner', 'POST', '/docs', { title: '笔记', markdown: 'x', folder_id: fb.folder_id })).json();
      expect(inFolder.folder_id).toBe(fb.folder_id);
      const rootDoc = (await call('owner', 'POST', '/docs', { title: '根目录' })).json();
      const mineRoot = (await call('owner', 'GET', '/docs?scope=mine')).json().items.map((d: any) => d.doc_id);
      expect(mineRoot).toEqual([rootDoc.doc_id]);
      expect((await call('owner', 'GET', `/docs?scope=mine&folder_id=${fb.folder_id}`)).json().items.map((d: any) => d.doc_id)).toEqual([inFolder.doc_id]);
      // 移动到根目录
      const moved = await call('owner', 'PATCH', `/docs/${inFolder.doc_id}`, { folder_id: null });
      expect(moved.statusCode).toBe(200);
      expect(moved.json().folder_id).toBeNull();
      // 非所有者不能移动
      expect((await call('other', 'PATCH', `/docs/${inFolder.doc_id}`, { folder_id: null })).statusCode).toBe(403);
      // 删除文件夹：里面的文档进回收站
      await call('owner', 'PATCH', `/docs/${inFolder.doc_id}`, { folder_id: fb.folder_id });
      expect((await call('owner', 'DELETE', `/folders/${fa.folder_id}`)).statusCode).toBe(204);
      expect((await call('owner', 'GET', '/folders')).json().items).toHaveLength(0);
      expect((await call('owner', 'GET', '/docs?scope=trash')).json().items.map((d: any) => d.doc_id)).toEqual([inFolder.doc_id]);
    } finally { await app.close(); }
  });

  it('收藏、回收站、恢复与彻底删除', async () => {
    const { app, call } = await setup();
    try {
      const doc = (await call('owner', 'POST', '/docs', { title: '周报' })).json();
      expect((await call('owner', 'POST', `/docs/${doc.doc_id}/star`)).statusCode).toBe(204);
      const starred = (await call('owner', 'GET', '/docs?scope=starred')).json().items;
      expect(starred.map((d: any) => d.doc_id)).toEqual([doc.doc_id]);
      expect(starred[0].starred).toBe(true);
      expect((await call('other', 'GET', '/docs?scope=starred')).json().items).toHaveLength(0);

      // 打开过才出现在最近
      await call('owner', 'GET', `/docs/${doc.doc_id}`);
      const recent = await call('owner', 'GET', '/docs?scope=recent');
      expect(recent.statusCode).toBe(200);

      // 别人不能删
      expect((await call('other', 'DELETE', `/docs/${doc.doc_id}`)).statusCode).toBe(403);
      expect((await call('owner', 'DELETE', `/docs/${doc.doc_id}`)).statusCode).toBe(204);
      expect((await call('owner', 'GET', `/docs/${doc.doc_id}`)).statusCode).toBe(404);
      expect((await call('owner', 'GET', '/docs')).json().items.some((d: any) => d.doc_id === doc.doc_id)).toBe(false);
      expect((await call('owner', 'GET', '/docs?scope=starred')).json().items).toHaveLength(0);
      const trash = (await call('owner', 'GET', '/docs?scope=trash')).json().items;
      expect(trash).toHaveLength(1);
      expect(trash[0].deleted_at).toBeTruthy();
      expect((await call('other', 'GET', '/docs?scope=trash')).json().items).toHaveLength(0);

      expect((await call('other', 'POST', `/docs/${doc.doc_id}/restore`)).statusCode).toBe(403);
      expect((await call('owner', 'POST', `/docs/${doc.doc_id}/restore`)).statusCode).toBe(200);
      expect((await call('owner', 'POST', `/docs/${doc.doc_id}/restore`)).statusCode).toBe(409);
      expect((await call('owner', 'GET', `/docs/${doc.doc_id}`)).statusCode).toBe(200);
      expect((await call('owner', 'GET', '/docs?scope=starred')).json().items).toHaveLength(1);

      expect((await call('owner', 'DELETE', `/docs/${doc.doc_id}?permanent=true`)).statusCode).toBe(204);
      expect((await call('owner', 'GET', `/docs/${doc.doc_id}`)).statusCode).toBe(404);
      expect((await call('owner', 'GET', '/docs?scope=trash')).json().items).toHaveLength(0);
    } finally { await app.close(); }
  });
});

describe('报表时间范围（dashboard.range）', () => {
  // 2026-10-20 15:00 北京时间，周二
  const now = Date.parse('2026-10-20T07:00:00Z');

  it('week / month / semester / custom 按北京时间切日', () => {
    const iso = (r?: { start: number; end: number }) => r && [new Date(r.start).toISOString(), new Date(r.end).toISOString()];
    expect(parseDashboardRange({}, now)).toBeUndefined();
    expect(iso(parseDashboardRange({ range: 'week' }, now))).toEqual(['2026-10-18T16:00:00.000Z', '2026-10-25T16:00:00.000Z']);
    expect(iso(parseDashboardRange({ range: 'month' }, now))).toEqual(['2026-09-30T16:00:00.000Z', '2026-10-31T16:00:00.000Z']);
    expect(iso(parseDashboardRange({ range: 'semester' }, now, 480, {}))).toEqual(['2026-08-31T16:00:00.000Z', '2027-01-31T16:00:00.000Z']);
    expect(iso(parseDashboardRange({ range: 'semester' }, now, 480, { COS_SEMESTER_START: '2026-09-07', COS_SEMESTER_END: '2027-01-15' })))
      .toEqual(['2026-09-06T16:00:00.000Z', '2027-01-15T16:00:00.000Z']);
    expect(iso(parseDashboardRange({ range: 'custom', start_at: '2026-10-01T00:00:00Z', end_at: '2026-10-02T00:00:00Z' }, now)))
      .toEqual(['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z']);
    expect(() => parseDashboardRange({ range: 'custom', start_at: '2026-10-02T00:00:00Z', end_at: '2026-10-01T00:00:00Z' }, now)).toThrow(DashboardRangeError);
    expect(() => parseDashboardRange({ range: 'year' }, now)).toThrow(DashboardRangeError);
  });

  it('接口带 range 返回统计区间，参数错误返回 422', async () => {
    const { app, call } = await setup();
    try {
      const ok = await call('owner', 'GET', '/dashboard/summary?range=week');
      expect(ok.statusCode).toBe(200);
      expect(ok.json().range).toMatchObject({ range: 'week' });
      expect((await call('owner', 'GET', '/dashboard/summary')).json().range).toBeUndefined();
      expect((await call('owner', 'GET', '/dashboard/summary?range=custom')).statusCode).toBe(422);
    } finally { await app.close(); }
  });
});
