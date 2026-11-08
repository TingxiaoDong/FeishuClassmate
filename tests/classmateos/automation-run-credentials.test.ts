import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../../classmateos/server/memory-repo.js';
import { AutomationAuthorizationStore, taskRevision, type AuthorizationPolicy, type TaskSnapshot } from '../../classmateos/server/automation-authorization.js';
import { AutomationRunCredentials } from '../../classmateos/server/automation-run-credentials.js';

async function fixture() {
  let now = Date.parse('2026-10-21T04:00:00Z');
  let permitted = true;
  const repo = new MemoryRepo();
  const task: TaskSnapshot = { taskKind: 'trigger', taskId: 't', ownerId: 'u', principalId: 'u', enabled: true, securityConfig: { revision: 'one' } };
  const policy: AuthorizationPolicy = { loadTask: async () => task, assertCanApprove: async () => { if (!permitted) throw new Error('PERMISSION_DENIED'); }, assertCanRevoke: async () => {} };
  const store = new AutomationAuthorizationStore(repo, policy, () => now);
  const spec = { taskKind: 'trigger', taskId: 't', taskRevision: taskRevision(task), principalId: 'u', recipients: { kind: 'fixed', targets: [{ type: 'user', id: 'u2' }] }, resources: [{ type: 'doc', resourceId: 'd' }], output: { mode: 'protected_doc_link', docIds: ['d'] }, limits: { perRun: 1, perDay: 5, perTargetPerRun: 1, perTargetPerDay: 5, timezone: 'Asia/Shanghai' }, expiresAt: new Date(now + 3600000).toISOString() };
  const draft = await store.createDraft(spec);
  const actor = { userId: 'u', authentication: 'user' as const };
  await store.approve(actor, draft.id, 1, String(draft.data.draftDigest));
  const runs = new AutomationRunCredentials(repo, policy, () => now);
  return { repo, store, draft, actor, runs, task, spec, issue: () => runs.issue(draft.id, spec.taskRevision), advance: (ms: number) => { now += ms; }, deny: () => { permitted = false; } };
}
describe('自动化短期运行凭证（内部核心，非投递验收）', () => {
  it('明文仅签发时返回，持久层只有散列；结束后失效', async () => {
    const f = await fixture(); const c = await f.issue();
    const row = await f.repo.getEntity('automation_run_v2', c.runId);
    expect(JSON.stringify(row)).not.toContain(c.sendCredential);
    expect(row?.data.credentialHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.runs.verify(c)).run.grantVersion).toBe(2);
    await f.runs.finish(c);
    await expect(f.runs.verify(c)).rejects.toThrow('RUN_CREDENTIAL_INVALID');
  });
  it('伪造、借用另一运行、改变绑定和过长有效期全部拒绝', async () => {
    const f = await fixture(); const c = await f.issue(); const other = await f.issue();
    for (const patch of [{ sendCredential: 'x'.repeat(43) }, { runId: other.runId }, { grantId: 'other' }, { principalId: 'other' }, { taskRevision: 'f'.repeat(64) }, { expiresAt: '2099-01-01T00:00:00Z' }])
      await expect(f.runs.verify({ ...c, ...patch })).rejects.toThrow('RUN_CREDENTIAL_INVALID');
    await expect(f.runs.issue(f.draft.id, f.spec.taskRevision, 300001)).rejects.toThrow('RUN_CREDENTIAL_INVALID');
  });
  it.each(['expired', 'revoked', 'disabled', 'revision', 'permission', 'grantVersion'])('重新检查实时状态：%s', async mode => {
    const f = await fixture(); const c = await f.issue();
    const expected = { expired: 'RUN_CREDENTIAL_INVALID', revoked: 'GRANT_REVOKED', disabled: 'TASK_DISABLED', revision: 'TASK_REVISION_CHANGED', permission: 'PERMISSION_DENIED', grantVersion: 'RUN_CREDENTIAL_INVALID' }[mode];
    if (mode === 'expired') f.advance(300000);
    if (mode === 'revoked') await f.store.revoke(f.actor, f.draft.id, 2);
    if (mode === 'disabled') f.task.enabled = false;
    if (mode === 'revision') f.task.securityConfig.revision = 'two';
    if (mode === 'permission') f.deny();
    if (mode === 'grantVersion') { const row = (await f.repo.getEntity('automation_authorization_v2', f.draft.id))!; await f.repo.saveEntity(row, row.version); }
    await expect(f.runs.verify(c)).rejects.toThrow(expected);
  });
});
