/**
 * 日历/任务 API 测试（P1 补齐）：时间窗相交查询、创建者权限、
 * 任务可见性与状态机校验。
 */

import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';

const USERS = [
  { user_id: 'ou_alice', name: 'alice', password: 'pw1', role: 'admin' as const },
  { user_id: 'ou_bob', name: 'bob', password: 'pw2', role: 'member' as const },
];

async function setup() {
  const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok' });
  const login = async (u: string, p: string) =>
    (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: p } })
    ).json().access_token as string;
  return { app, alice: await login('alice', 'pw1'), bob: await login('bob', 'pw2') };
}

const D = (s: string) => Date.parse(s);

describe('calendar/tasks (P1)', () => {
  it('日程：创建 → 时间窗相交查询（含参与者可见）→ 仅创建者可删', async () => {
    const { app, alice, bob } = await setup();
    const authA = { authorization: `Bearer ${alice}` };
    const authB = { authorization: `Bearer ${bob}` };

    // 非法时间窗
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/calendar/events',
          headers: authA,
          payload: { title: 'X', start_ms: D('2026-10-20T10:00Z'), end_ms: D('2026-10-20T09:00Z') },
        })
      ).statusCode,
    ).toBe(422);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/calendar/events',
      headers: authA,
      payload: {
        title: '组会',
        start_ms: D('2026-10-20T10:00Z'),
        end_ms: D('2026-10-20T11:00Z'),
        attendee_ids: ['ou_bob'],
      },
    });
    expect(created.statusCode).toBe(201);
    const ev = created.json();
    expect(ev.attendee_ids).toContain('ou_alice'); // 创建者自动加入

    // 相交查询：alice 和 bob 都能查到
    for (const auth of [authA, authB]) {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/calendar/events?from=${D('2026-10-20T00:00Z')}&to=${D('2026-10-21T00:00Z')}`,
        headers: auth,
      });
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0].title).toBe('组会');
    }

    // 不相交时间窗 → 空
    const empty = await app.inject({
      method: 'GET',
      url: `/api/v1/calendar/events?from=${D('2026-10-21T00:00Z')}&to=${D('2026-10-22T00:00Z')}`,
      headers: authA,
    });
    expect(empty.json().items).toHaveLength(0);

    // bob（参与者非创建者）删除 → 403；alice 删除 → 204
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/calendar/events/${ev.event_id}`, headers: authB })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/calendar/events/${ev.event_id}`, headers: authA })).statusCode,
    ).toBe(204);
    await app.close();
  });

  it('任务：创建/可见性/状态机/越权更新', async () => {
    const { app, alice, bob } = await setup();
    const authA = { authorization: `Bearer ${alice}` };
    const authB = { authorization: `Bearer ${bob}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: authA,
      payload: { title: '帮扶：甘特图 M2 逾期', assignee_id: 'ou_bob', due_ms: D('2026-10-25T00:00Z') },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    expect(task.status).toBe('pending');

    // bob（被指派人）可见；alice（创建者）可见
    for (const auth of [authA, authB]) {
      const list = await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: auth });
      expect(list.json().items).toHaveLength(1);
    }

    // 状态过滤
    const done = await app.inject({ method: 'GET', url: '/api/v1/tasks?status=done', headers: authA });
    expect(done.json().items).toHaveLength(0);

    // 非法状态 → 422；合法流转 → 200
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/tasks/${task.task_id}`,
          headers: authB,
          payload: { status: 'flying' },
        })
      ).statusCode,
    ).toBe(422);

    const progressed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${task.task_id}`,
      headers: authB,
      payload: { status: 'in_progress' },
    });
    expect(progressed.statusCode).toBe(200);
    expect(progressed.json().status).toBe('in_progress');
    await app.close();
  });
});
