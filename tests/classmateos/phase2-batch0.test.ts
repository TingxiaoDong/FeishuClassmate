/**
 * 迭代 5 适配批次 0：功能开关、web_url、user.permissions、文档协同在线头像（doc.presence）。
 * 对照《二期前端开发进度总览.md》第 2～4 节、《二期迭代5_前端接口需求与进度.md》第 2、3 节、
 * 《二期迭代2_前端进度与待联调.md》3.6。
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { MEMBER_DEFAULT, PERMISSION_POINTS } from '../../classmateos/server/permissions.js';

const USERS: AppOptions['users'] = [
  { user_id: 'ou_alice', name: '王老师', password: 'pw', role: 'admin' },
  { user_id: 'ou_bob', name: '李同学', password: 'pw', role: 'member' },
  { user_id: 'ou_carol', name: '张同学', password: 'pw', role: 'member' },
];

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const a of apps.splice(0)) await a.close();
});

async function makeApp(extra: Partial<AppOptions> = {}) {
  const app = await buildApp({ users: USERS, secret: 's', notificationScanner: false, ...extra });
  apps.push(app);
  const tokens: Record<string, any> = {};
  const login = async (u: string) => (tokens[u] ??= (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json());
  const call = async (u: string | undefined, method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: u ? { authorization: `Bearer ${(await login(u)).access_token}` } : {},
      payload: payload as Record<string, unknown>,
    });
  return { app, login, call };
}

// ---- 前端 collab_presence.dart 的编码 ----
type Entry = { clientId: number; clock: number; state: Record<string, unknown> | null };
function encodeAwareness(entries: Entry[]): Uint8Array {
  const u = encoding.createEncoder();
  encoding.writeVarUint(u, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(u, e.clientId);
    encoding.writeVarUint(u, e.clock);
    encoding.writeVarString(u, JSON.stringify(e.state));
  }
  const b = encoding.createEncoder();
  encoding.writeVarUint(b, 1);
  encoding.writeVarUint8Array(b, encoding.toUint8Array(u));
  return encoding.toUint8Array(b);
}
function decodeAwareness(data: Uint8Array): Entry[] | null {
  const d = decoding.createDecoder(data);
  if (decoding.readVarUint(d) !== 1) return null;
  const u = decoding.createDecoder(decoding.readVarUint8Array(d));
  const n = decoding.readVarUint(u);
  const out: Entry[] = [];
  for (let i = 0; i < n; i++) out.push({ clientId: decoding.readVarUint(u), clock: decoding.readVarUint(u), state: JSON.parse(decoding.readVarString(u)) });
  return out;
}

class PresenceClient {
  readonly received: Entry[] = [];
  closeCode?: number;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw: Buffer) => {
      const e = decodeAwareness(new Uint8Array(raw));
      if (e) this.received.push(...e);
    });
    ws.on('close', (code) => { this.closeCode = code; });
  }
  send(entries: Entry[]) { this.ws.send(encodeAwareness(entries)); }
}

async function connect(app: FastifyInstance, docId: string, token: string): Promise<PresenceClient> {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/docs/${docId}/collab?token=${token}`);
  sockets.push(ws);
  const c = new PresenceClient(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  await sleep(80); // 等服务端鉴权、入房
  return c;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('功能开关与 web_url', () => {
  it('打开 doc.permissions / comments / versions / presence / folders、管理后台与组织架构；wiki 等未做的仍关闭', async () => {
    const { call } = await makeApp();
    const body = (await call(undefined, 'GET', '/capabilities')).json();
    for (const k of ['doc.permissions', 'doc.comments', 'doc.versions', 'doc.presence', 'doc.folders', 'admin', 'org.departments', 'dashboard.range', 'workbench.apps', 'auth.qr_login', 'table.permissions', 'table.manage', 'record.comments', 'table.import', 'table.export', 'doc.export', 'user.import', 'wiki']) expect(body.features[k], k).toBe(true);
    for (const k of ['sheet', 'approval']) {
      expect(body.features[k], k).toBeFalsy();
    }
    expect(body).not.toHaveProperty('web_url');
  });

  it('配置了 webUrl 时返回 web_url，去掉末尾斜杠', async () => {
    const { call } = await makeApp({ webUrl: 'https://cos.lab/' });
    expect((await call(undefined, 'GET', '/capabilities')).json().web_url).toBe('https://cos.lab');
  });
});

describe('user.permissions', () => {
  it('登录、刷新、GET/PATCH /users/me 都带 permissions；管理员全部，成员默认集合', async () => {
    const { login, call } = await makeApp();
    const admin = await login('ou_alice');
    expect([...admin.user.permissions].sort()).toEqual([...PERMISSION_POINTS].sort());
    const bob = await login('ou_bob');
    expect(bob.user.permissions).toEqual([...MEMBER_DEFAULT]);
    expect(bob.user.permissions.some((p: string) => p.startsWith('admin.'))).toBe(false);

    const refreshed = (await call(undefined, 'POST', '/auth/refresh', { refresh_token: bob.refresh_token })).json();
    expect(refreshed.user.permissions).toEqual([...MEMBER_DEFAULT]);
    expect((await call('ou_bob', 'GET', '/users/me')).json().permissions).toEqual([...MEMBER_DEFAULT]);
    const patched = (await call('ou_bob', 'PATCH', '/users/me', { status_text: '在实验室' })).json();
    expect(patched.status_text).toBe('在实验室');
    expect(patched.permissions).toEqual([...MEMBER_DEFAULT]);
    // 看别人的资料不带 permissions
    expect((await call('ou_bob', 'GET', '/users/ou_alice')).json()).not.toHaveProperty('permissions');
  });
});

describe('doc.presence：协同在线状态', () => {
  it('只读用户能连；user_id / name 改写为本人；不能抢别人的 clientID；断开广播离开', async () => {
    const { app, login, call } = await makeApp();
    const doc = (await call('ou_alice', 'POST', '/docs', { title: '协同头像', markdown: '# a' })).json();
    expect((await call('ou_alice', 'PUT', `/docs/${doc.doc_id}/permissions`, { link_share: 'off', members: [{ member_type: 'user', member_id: 'ou_bob', role: 'viewer' }] })).statusCode).toBe(200);

    const alice = await connect(app, doc.doc_id, (await login('ou_alice')).access_token);
    const bob = await connect(app, doc.doc_id, (await login('ou_bob')).access_token);
    expect(bob.closeCode).toBeUndefined();

    // 李同学（只读）冒充王老师
    bob.send([{ clientId: 777, clock: 1, state: { user_id: 'ou_alice', name: '王老师', color: '#f00', cursor: { line: 3 } } }]);
    await sleep(120);
    const got = alice.received.find((e) => e.clientId === 777)!;
    expect(got.state).toEqual({ user_id: 'ou_bob', name: '李同学', color: '#f00', cursor: { line: 3 } });

    // 王老师的 clientID 不能被李同学改写
    alice.send([{ clientId: 555, clock: 1, state: { user_id: 'ou_alice', name: '王老师' } }]);
    await sleep(80);
    expect(bob.received.find((e) => e.clientId === 555)?.state).toMatchObject({ user_id: 'ou_alice' });
    bob.send([{ clientId: 555, clock: 9, state: null }]);
    await sleep(80);
    expect(alice.received.filter((e) => e.clientId === 555)).toEqual([]); // 自己的不回发，也没被抢占

    // 断开：替李同学广播 null 状态
    const before = alice.received.length;
    bob.ws.close();
    await sleep(150);
    const leave = alice.received.slice(before).find((e) => e.clientId === 777)!;
    expect(leave.state).toBeNull();
    expect(leave.clock).toBeGreaterThan(1);
  });

  it('没有查看权限的人被以 4410 断开', async () => {
    const { app, login, call } = await makeApp();
    const doc = (await call('ou_alice', 'POST', '/docs', { title: '私密', markdown: 'x' })).json();
    await call('ou_alice', 'PUT', `/docs/${doc.doc_id}/permissions`, { link_share: 'off', members: [] });
    const carol = await connect(app, doc.doc_id, (await login('ou_carol')).access_token);
    await sleep(100);
    expect(carol.closeCode).toBe(4410);
  });
});
