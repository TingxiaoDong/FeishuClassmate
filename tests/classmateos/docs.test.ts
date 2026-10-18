/**
 * 文档 API + PAL DocService 端到端测试（P1 能力面最后一项）。
 */

import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import { createClassmateOSAdapter } from '../../src/pal/classmateos-adapter.js';

const USERS = [
  { user_id: 'ou_alice', name: 'alice', password: 'pw1', role: 'admin' as const },
  { user_id: 'ou_bob', name: 'bob', password: 'pw2', role: 'member' as const },
];

describe('docs API + PAL DocService', () => {
  it('REST：创建/列表/读取/更新权限', async () => {
    const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok' });
    const login = async (u: string, p: string) =>
      (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: p } })
      ).json().access_token as string;
    const authA = { authorization: `Bearer ${await login('alice', 'pw1')}` };
    const authB = { authorization: `Bearer ${await login('bob', 'pw2')}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/docs',
      headers: authA,
      payload: { title: '导览讲解稿', markdown: '# 欢迎\n\n这里是机器人实验室。' },
    });
    expect(created.statusCode).toBe(201);
    const docId = created.json().doc_id;

    // 列表不含正文
    const list = await app.inject({ method: 'GET', url: '/api/v1/docs', headers: authA });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].markdown).toBeUndefined();

    const got = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}`, headers: authA });
    expect(got.json().markdown).toContain('机器人实验室');

    // 非创建者更新 → 403
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/docs/${docId}`,
          headers: authB,
          payload: { markdown: '篡改' },
        })
      ).statusCode,
    ).toBe(403);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/docs/${docId}`,
      headers: authA,
      payload: { markdown: '# 欢迎 v2' },
    });
    expect(patched.json().markdown).toBe('# 欢迎 v2');
    await app.close();
  });

  it('PAL：createDocument/getDocumentMarkdown 打真 server', async () => {
    const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'pw1' },
    });

    const pal = createClassmateOSAdapter({
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: login.json().access_token,
    });
    const created = await pal.doc.createDocument('研究报告', '# 结论\n\n方法有效。');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const md = await pal.doc.getDocumentMarkdown(created.value.docId);
    expect(md.ok && md.value).toContain('方法有效');

    const missing = await pal.doc.getDocumentMarkdown('doc_nonexistent');
    expect(missing.ok).toBe(false);
    await app.close();
  });
});
