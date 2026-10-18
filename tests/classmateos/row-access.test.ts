/**
 * 行级权限测试（灰度安全需求）：projects 表 visibility=「保密」的记录
 * 仅 owner（owner_open_id 包含当前用户）与 admin 可见/可改；其余成员
 * list 过滤、get/patch/delete 一律 404。公开记录不受影响。
 */

import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';

const USERS = [
  { user_id: 'ou_alice', name: 'alice', password: 'pw1', role: 'admin' as const },
  { user_id: 'ou_bob', name: 'bob', password: 'pw2', role: 'member' as const },
  { user_id: 'ou_eve', name: 'eve', password: 'pw3', role: 'member' as const },
];

async function setup() {
  const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok' });
  const login = async (u: string, p: string) =>
    (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: p } })
    ).json().access_token as string;
  return {
    app,
    alice: await login('alice', 'pw1'),
    bob: await login('bob', 'pw2'),
    eve: await login('eve', 'pw3'),
  };
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createProject(app: Awaited<ReturnType<typeof buildApp>>, token: string, fields: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tables/projects/records',
    headers: auth(token),
    payload: { fields },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { record_id: string };
}

describe('row-access 行级权限（保密项目）', () => {
  it('保密项目：owner 与 admin 可见，其他成员 404 且 list 不含', async () => {
    const { app, alice, bob, eve } = await setup();
    // admin 建保密项目，owner 是 bob
    const rec = await createProject(app, alice, {
      project_id: 'P-SEC',
      title: '机密项目',
      owner_open_id: [{ id: 'ou_bob' }],
      visibility: '保密',
    });

    // owner bob：get 可见、patch 可改
    const getB = await app.inject({
      method: 'GET',
      url: `/api/v1/tables/projects/records/${rec.record_id}`,
      headers: auth(bob),
    });
    expect(getB.statusCode).toBe(200);
    const patchB = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tables/projects/records/${rec.record_id}`,
      headers: auth(bob),
      payload: { fields: { title: '机密项目·改' } },
    });
    expect(patchB.statusCode).toBe(200);

    // 无关成员 eve：get/patch/delete 全 404
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: `/api/v1/tables/projects/records/${rec.record_id}`,
        headers: auth(eve),
        payload: method === 'PATCH' ? { fields: { title: 'x' } } : undefined,
      });
      expect(res.statusCode).toBe(404);
    }

    // list：bob/alice 看得到，eve 看不到
    const listB = await app.inject({ method: 'GET', url: '/api/v1/tables/projects/records', headers: auth(bob) });
    expect(listB.json().items.map((r: { record_id: string }) => r.record_id)).toContain(rec.record_id);
    const listE = await app.inject({ method: 'GET', url: '/api/v1/tables/projects/records', headers: auth(eve) });
    expect(listE.json().items.map((r: { record_id: string }) => r.record_id)).not.toContain(rec.record_id);

    // admin alice：可见、可删
    const getA = await app.inject({
      method: 'GET',
      url: `/api/v1/tables/projects/records/${rec.record_id}`,
      headers: auth(alice),
    });
    expect(getA.statusCode).toBe(200);
    expect(
      (await app.inject({
        method: 'DELETE',
        url: `/api/v1/tables/projects/records/${rec.record_id}`,
        headers: auth(alice),
      })).statusCode,
    ).toBe(204);
  });

  it('公开项目对所有成员可见；无 visibility 字段的表不受规则影响', async () => {
    const { app, bob, eve } = await setup();
    const pub = await createProject(app, bob, {
      project_id: 'P-PUB',
      title: '公开项目',
      owner_open_id: [{ id: 'ou_bob' }],
      visibility: '可公开',
    });
    // eve 可见可改公开项目
    expect(
      (await app.inject({
        method: 'GET',
        url: `/api/v1/tables/projects/records/${pub.record_id}`,
        headers: auth(eve),
      })).statusCode,
    ).toBe(200);
    // lab_memes 表无 visibility+owner 组合 → 规则不生效，普通 CRUD 照常
    const meme = await app.inject({
      method: 'POST',
      url: '/api/v1/tables/lab_memes/records',
      headers: auth(bob),
      payload: { fields: { meme_id: 'M-1', content_text: '梗图' } },
    });
    expect(meme.statusCode).toBe(201);
    expect(
      (await app.inject({
        method: 'GET',
        url: `/api/v1/tables/lab_memes/records/${meme.json().record_id}`,
        headers: auth(eve),
      })).statusCode,
    ).toBe(200);
  });
});
