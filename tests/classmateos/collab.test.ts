/**
 * 文档协同编辑测试（Yjs over WS）：
 * 1. 双客户端连接同一文档，Y.Text 编辑实时收敛；
 * 2. 全部断开后协同态持久化，REST GET 读到合并后的 markdown；
 * 3. 新会话从持久化态恢复（断点续协同）；
 * 4. 错误 token → 4401；不存在文档 → 4404。
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../classmateos/server/app.js';

const USERS = [
  { user_id: 'ou_alice', name: 'alice', password: 'pw1', role: 'admin' as const },
  { user_id: 'ou_bob', name: 'bob', password: 'pw2', role: 'member' as const },
];

async function setup(): Promise<{ app: FastifyInstance; base: string; alice: string; bob: string }> {
  const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const login = async (u: string, p: string) =>
    (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: p } })
    ).json().access_token as string;
  return { app, base: `127.0.0.1:${port}`, alice: await login('alice', 'pw1'), bob: await login('bob', 'pw2') };
}

const providers: WebsocketProvider[] = [];
function connect(base: string, docId: string, token: string, ydoc = new Y.Doc()): WebsocketProvider {
  const p = new WebsocketProvider(`ws://${base}`, `api/v1/docs/${docId}/collab?token=${token}`, ydoc);
  providers.push(p);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitSynced(p: WebsocketProvider): Promise<void> {
  if (p.synced) return;
  await new Promise<void>((resolve) => p.once('sync', () => resolve()));
}

afterEach(() => {
  while (providers.length) providers.pop()!.destroy();
});

describe('docs 协同编辑（Yjs）', () => {
  it('双客户端编辑收敛，断开后持久化，REST 读到合并结果', async () => {
    const { app, base, alice, bob } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/docs',
      headers: { authorization: `Bearer ${alice}` },
      payload: { title: '协同文档', markdown: '# 初稿\n' },
    });
    const { doc_id } = created.json();

    const p1 = connect(base, doc_id, alice);
    const p2 = connect(base, doc_id, bob);
    await Promise.all([waitSynced(p1), waitSynced(p2)]);
    // 初始 markdown 播种到双方
    expect(p1.doc.getText('markdown').toString()).toBe('# 初稿\n');
    expect(p2.doc.getText('markdown').toString()).toBe('# 初稿\n');

    // alice 在开头插入，bob 在结尾追加 → 两端收敛到同一份文本
    p1.doc.getText('markdown').insert(0, '> alice 批注\n');
    p2.doc.getText('markdown').insert(p2.doc.getText('markdown').length, 'bob 的补充\n');
    await sleep(150);
    const merged = p1.doc.getText('markdown').toString();
    expect(p2.doc.getText('markdown').toString()).toBe(merged);
    expect(merged).toContain('alice 批注');
    expect(merged).toContain('bob 的补充');

    // 全部断开 → 持久化；REST 读到合并文本
    p1.destroy();
    p2.destroy();
    providers.length = 0;
    await sleep(100);
    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/docs/${doc_id}`,
      headers: { authorization: `Bearer ${alice}` },
    });
    expect(got.json().markdown).toBe(merged);

    // 新会话从持久化态恢复
    const p3 = connect(base, doc_id, alice);
    await waitSynced(p3);
    expect(p3.doc.getText('markdown').toString()).toBe(merged);
    await app.close();
  });

  it('鉴权与存在性：错误 token 4401，不存在文档 4404', async () => {
    const { app, base, alice } = await setup();
    const closeCode = (p: WebsocketProvider) =>
      new Promise<number>((resolve) =>
        p.on('connection-close', (event: CloseEvent) => resolve(event.code)),
      );

    const bad = connect(base, 'doc_none', 'bad-token');
    expect(await closeCode(bad)).toBe(4401);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/docs',
      headers: { authorization: `Bearer ${alice}` },
      payload: { title: 't', markdown: '' },
    });
    const missing = connect(base, 'doc_missing', alice);
    expect(await closeCode(missing)).toBe(4404);
    expect(created.statusCode).toBe(201);
    await app.close();
  });
});
