import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import { MemoryRepo } from '../../classmateos/server/memory-repo.js';

async function fixture() {
  const repo = new MemoryRepo();
  const app = await buildApp({ repo, users: ['u1', 'u2'].map(user_id => ({ user_id, name: user_id, password: 'pw', role: 'member' as const })), secret: 'test-only', botToken: 'test-bot', notificationScanner: false });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'u1', password: 'pw' } });
  const headers = { authorization: `Bearer ${login.json().access_token}` };
  const trigger = await app.inject({ method: 'POST', url: '/api/v1/agent/triggers', headers, payload: { name: '隔离测试', event: 'schedule', cron: '0 9 * * *', prompt: '报告' } });
  expect(trigger.statusCode).toBe(201);
  const taskId = trigger.json().trigger_id;
  const doc = await app.inject({ method: 'POST', url: '/api/v1/docs', headers, payload: { title: '隔离测试文档', markdown: '不发送正文' } });
  expect(doc.statusCode).toBe(201);
  const docId = doc.json().doc_id;
  expect(typeof docId).toBe('string');
  const createDraft = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/automation/drafts', headers, payload: {
      taskKind: 'trigger', taskId, recipients: { kind: 'fixed', targets: [{ type: 'user', id: 'u2' }] },
      resources: [{ type: 'doc', resourceId: docId }], output: { mode: 'protected_doc_link', docIds: [docId] },
      limits: { perRun: 1, perDay: 5, perTargetPerRun: 1, perTargetPerDay: 5, timezone: 'Asia/Shanghai' }, expiresAt: new Date(Date.now() + 3600000).toISOString(),
    } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  };
  const approve = (d: any) => app.inject({ method: 'POST', url: `/api/v1/automation/drafts/${d.draftId}/approve`, headers, payload: { expectedVersion: d.version, expectedDigest: d.draftDigest } });
  const patch = async (payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/agent/triggers/${taskId}`, headers, payload });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  return { app, repo, headers, taskId, createDraft, approve, patch };
}

describe('自动化授权 HTTP 生命周期（隔离 Memory）', () => {
  it('完整创建、批准、撤销，重复批准冲突且不开放投递', async () => {
    const f = await fixture();
    try {
      const d = await f.createDraft();
      const approved = await f.approve(d);
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json()).toMatchObject({ status: 'active', version: 2, deliveryEnabled: false });
      expect((await f.approve(d)).statusCode).toBe(409);
      const revoked = await f.app.inject({ method: 'POST', url: `/api/v1/automation/drafts/${d.draftId}/revoke`, headers: f.headers, payload: { expectedVersion: 2 } });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toMatchObject({ status: 'revoked', version: 3 });
      expect((await f.approve({ ...d, version: 3 })).statusCode).toBe(409);
    } finally { await f.app.close(); }
  });
  it.each(['restore', 'reenable'])('安全变更不可恢复旧草稿：%s', async mode => {
    const f = await fixture();
    try {
      const d = await f.createDraft();
      if (mode === 'restore') { await f.patch({ prompt: '新报告' }); await f.patch({ prompt: '报告' }); }
      else { await f.patch({ enabled: false }); await f.patch({ enabled: true }); }
      const res = await f.approve(d);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('TASK_REVISION_CHANGED');
      expect((await f.approve(await f.createDraft())).statusCode).toBe(200);
    } finally { await f.app.close(); }
  });
  it('名称和运行统计变化不废弃草稿，客户端不能指定安全标记', async () => {
    const f = await fixture();
    try {
      const before = await f.repo.getEntity('agent_trigger', f.taskId);
      const d = await f.createDraft();
      await f.patch({ name: '新名称', security_revision: 'forged' });
      const fired = await f.app.inject({ method: 'POST', url: `/api/v1/bot/triggers/${f.taskId}/fired`, headers: { 'x-bot-token': 'test-bot' }, payload: { result: '仅统计' } });
      expect(fired.statusCode).toBe(200);
      expect((await f.repo.getEntity('agent_trigger', f.taskId))?.data.security_revision).toBe(before?.data.security_revision);
      expect((await f.approve(d)).statusCode).toBe(200);
    } finally { await f.app.close(); }
  });
  it('其他用户不可见或审批草稿', async () => {
    const f = await fixture();
    try {
      const d = await f.createDraft();
      const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'u2', password: 'pw' } });
      const headers = { authorization: `Bearer ${login.json().access_token}` };
      const list = await f.app.inject({ method: 'GET', url: '/api/v1/automation/drafts', headers });
      expect(list.json().items).toEqual([]);
      const res = await f.app.inject({ method: 'POST', url: `/api/v1/automation/drafts/${d.draftId}/approve`, headers, payload: { expectedVersion: 1, expectedDigest: d.draftDigest } });
      expect(res.statusCode).toBe(404);
    } finally { await f.app.close(); }
  });
});
