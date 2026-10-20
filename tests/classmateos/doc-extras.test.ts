/**
 * 二期迭代 2：文档评论（R-DC-02）、历史版本（R-DC-03）、附件绑定（R-DC-04）。
 * 设置 CLASSMATEOS_TEST_PG_URL 时同时在 PostgreSQL 上跑（会清空该库）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import { diffCount } from '../../classmateos/server/doc-extras.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
let pool: pg.Pool | undefined;
afterAll(async () => { await pool?.end(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];

describe.each(backends)('迭代2 文档评论 / 版本 / 附件（$name）', ({ usePg }) => {
  async function makeApp(reset = true) {
    const o: AppOptions = {
      secret: 's', notificationScanner: false, docVersionIdleMs: 30,
      users: [
        { user_id: 'owner', name: '所有者', password: 'pw', role: 'member' },
        { user_id: 'reader', name: '阅读者', password: 'pw', role: 'member' },
        { user_id: 'stranger', name: '陌生人', password: 'pw', role: 'member' },
      ],
    };
    if (usePg) {
      pool ??= new pg.Pool({ connectionString: PG_URL, max: 5 });
      if (reset) {
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        await pool.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
        await new PgRepo(pool).init();
      }
      const st = new PgTableStore(pool);
      await st.ensureMetaColumns();
      o.repo = new PgRepo(pool);
      o.store = st;
    }
    const app = await buildApp(o);
    const tokens: Record<string, string> = {};
    const call = async (u: string, method: string, url: string, payload?: unknown) => {
      tokens[u] ??= (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json().access_token;
      return app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${tokens[u]}` }, payload: payload as Record<string, unknown> });
    };
    return { app, call };
  }

  it('评论：@ 通知、回复、只能改删自己的、解决、权限', async () => {
    const { app, call } = await makeApp();
    try {
      const doc = (await call('owner', 'POST', '/docs', { title: '组会纪要', markdown: '第一段 重要结论' })).json();
      await call('owner', 'PUT', `/docs/${doc.doc_id}/permissions`, { link_share: 'off', members: [{ member_type: 'user', member_id: 'reader', role: 'commenter' }] });
      const c = await call('reader', 'POST', `/docs/${doc.doc_id}/comments`, { quote: '重要结论', anchor: { offset: 4, length: 4 }, content: { text: '@所有者 看下', mentions: [{ user_id: 'owner', name: '所有者', offset: 0, length: 4 }] } });
      expect(c.statusCode).toBe(201);
      const cm = c.json();
      expect(cm.anchor).toEqual({ offset: 4, length: 4 });
      expect(cm.replies).toHaveLength(1);
      // 陌生人看不到也不能评论
      expect((await call('stranger', 'GET', `/docs/${doc.doc_id}/comments`)).statusCode).toBe(403);
      // 划词评论必须带原文
      expect((await call('reader', 'POST', `/docs/${doc.doc_id}/comments`, { content: { text: 'x' } })).statusCode).toBe(422);
      const ntf = (await call('owner', 'GET', '/notifications')).json();
      expect(ntf.items.some((n: any) => n.type === 'doc.mention' && n.target.comment_id === cm.comment_id)).toBe(true);
      const r = (await call('owner', 'POST', `/docs/${doc.doc_id}/comments/${cm.comment_id}/replies`, { content: { text: '收到' } })).json();
      expect((await call('reader', 'PATCH', `/docs/${doc.doc_id}/comments/${cm.comment_id}/replies/${r.reply_id}`, { content: { text: '改别人的' } })).statusCode).toBe(403);
      expect((await call('owner', 'PATCH', `/docs/${doc.doc_id}/comments/${cm.comment_id}/replies/${r.reply_id}`, { content: { text: '收到，已改' } })).statusCode).toBe(200);
      expect((await call('owner', 'PATCH', `/docs/${doc.doc_id}/comments/${cm.comment_id}`, { solved: true })).json().solved).toBe(true);
      expect((await call('owner', 'GET', `/docs/${doc.doc_id}/comments?solved=false`)).json().items).toHaveLength(0);
      const all = (await call('owner', 'GET', `/docs/${doc.doc_id}/comments?solved=true`)).json().items;
      expect(all[0].replies.map((x: any) => x.content.text)).toEqual(['@所有者 看下', '收到，已改']);
      // 原文被删光时 quote_deleted
      await call('owner', 'PATCH', `/docs/${doc.doc_id}`, { markdown: '第一段' });
      expect((await call('owner', 'GET', `/docs/${doc.doc_id}/comments`)).json().items[0].quote_deleted).toBe(true);
      // 阅读者降为 viewer 后不能再评论
      await call('owner', 'PUT', `/docs/${doc.doc_id}/permissions`, { link_share: 'off', members: [{ member_type: 'user', member_id: 'reader', role: 'viewer' }] });
      expect((await call('reader', 'POST', `/docs/${doc.doc_id}/comments`, { is_whole: true, content: { text: '还能评论吗' } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('历史版本：自动存版、命名、还原（还原也生成新版本），重启后仍在', async () => {
    let { app, call } = await makeApp();
    let docId = '';
    try {
      const doc = (await call('owner', 'POST', '/docs', { title: '实验记录', markdown: 'v1' })).json();
      docId = doc.doc_id;
      await call('owner', 'PATCH', `/docs/${docId}`, { markdown: 'v1 加了一段' });
      await sleep(120); // 停止编辑后自动存一版
      const list = (await call('owner', 'GET', `/docs/${docId}/versions`)).json().items;
      expect(list).toHaveLength(2);
      expect(list[0].added).toBe(5); // 「 加了一段」含前导空格
      const first = list[list.length - 1];
      expect((await call('owner', 'GET', `/docs/${docId}/versions/${first.version_id}`)).json().markdown).toBe('v1');
      expect((await call('owner', 'PATCH', `/docs/${docId}/versions/${first.version_id}`, { name: '组会前定稿' })).json().name).toBe('组会前定稿');
      expect((await call('stranger', 'POST', `/docs/${docId}/versions/${first.version_id}/restore`)).statusCode).toBe(403);
      expect((await call('owner', 'POST', `/docs/${docId}/versions/${first.version_id}/restore`)).statusCode).toBe(200);
      expect((await call('owner', 'GET', `/docs/${docId}`)).json().markdown).toBe('v1');
      expect((await call('owner', 'GET', `/docs/${docId}/versions`)).json().items).toHaveLength(3);
    } finally { await app.close(); }
    if (!usePg) return;
    ({ app, call } = await makeApp(false));
    try {
      const list = (await call('owner', 'GET', `/docs/${docId}/versions`)).json().items;
      expect(list).toHaveLength(3);
      expect(list.some((v: any) => v.name === '组会前定稿')).toBe(true);
    } finally { await app.close(); }
  });

  it('附件绑定文档：能看文档的人能下载，看不到的人 404', async () => {
    const { app, call } = await makeApp();
    try {
      const doc = (await call('owner', 'POST', '/docs', { title: '带图', markdown: '' })).json();
      await call('owner', 'PUT', `/docs/${doc.doc_id}/permissions`, { link_share: 'off', members: [{ member_type: 'user', member_id: 'reader', role: 'viewer' }] });
      expect((await call('reader', 'POST', '/files/upload-url', { file_name: 'a.png', size: 3, ref: { type: 'doc', id: doc.doc_id } })).statusCode).toBe(403);
      const up = (await call('owner', 'POST', '/files/upload-url', { file_name: 'a.png', size: 3, ref: { type: 'doc', id: doc.doc_id } })).json();
      const put = await app.inject({ method: 'PUT', url: new URL(up.upload_url, 'http://x').pathname + new URL(up.upload_url, 'http://x').search, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('abc') });
      expect(put.statusCode).toBeLessThan(300);
      expect((await call('reader', 'GET', `/files/${up.file_key}/download-url`)).statusCode).toBe(200);
      expect((await call('stranger', 'GET', `/files/${up.file_key}/download-url`)).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe('diffCount', () => {
  it('按前后缀对齐统计增删字数', () => {
    expect(diffCount('abcdef', 'abXXef')).toEqual({ added: 2, removed: 2 });
    expect(diffCount('', 'hello')).toEqual({ added: 5, removed: 0 });
  });
});
