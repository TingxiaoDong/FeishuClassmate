import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../../classmateos/server/memory-repo.js';
import { AutomationAuthorizationStore, AuthorizationSpecSchema, aggregateRunStatus, canonicalJson, taskRevision, type AuthorizationPolicy, type AuthorizationRecord, type TaskSnapshot } from '../../classmateos/server/automation-authorization.js';

function fixture() {
  let now = Date.parse('2026-10-21T04:00:00Z');
  const task: TaskSnapshot = { taskKind: 'trigger', taskId: 't1', ownerId: 'u1', principalId: 'u1', enabled: true, securityConfig: { prompt: '报告', condition: null, cron: '0 9 * * *', targets: ['c1'] } };
  const spec = { taskKind: 'trigger', taskId: 't1', taskRevision: taskRevision(task), principalId: 'u1', recipients: { kind: 'fixed', targets: [{ type: 'chat', id: 'c1' }] }, resources: [{ type: 'doc', resourceId: 'd1' }], output: { mode: 'protected_doc_link', docIds: ['d1'] }, limits: { perRun: 2, perDay: 10, perTargetPerRun: 1, perTargetPerDay: 5, timezone: 'Asia/Shanghai' }, expiresAt: '2026-10-22T04:00:00Z' };
  const policy: AuthorizationPolicy = {
    loadTask: async () => task,
    assertCanApprove: async (user) => { if (user !== 'u1') throw new Error('PERMISSION_DENIED'); },
    assertCanRevoke: async (user) => { if (user !== 'u1') throw new Error('PERMISSION_DENIED'); },
  };
  const repo = new MemoryRepo();
  const store = new AutomationAuthorizationStore(repo, policy, () => now);
  const actor = { userId: 'u1', authentication: 'user' as const };
  return { task, spec, store, actor, advance: (ms: number) => { now += ms; } };
}
describe('自动化 v2 授权核心（非端到端验收）', () => {
  it('严格拒绝动态目标、自由正文、额外字段与任意资料规则', () => {
    const { spec } = fixture();
    expect(AuthorizationSpecSchema.safeParse(spec).success).toBe(true);
    for (const override of [{ recipients: { kind: 'dynamic', sql: 'select *' } }, { output: { mode: 'ai_text', text: '正文' } }, { extra: true }, { resources: [{ type: 'table', resourceId: 't', sql: 'select *' }] }])
      expect(AuthorizationSpecSchema.safeParse({ ...spec, ...override }).success).toBe(false);
  });
  it('拒绝重复目标、额度矛盾和越界文档链接', () => {
    const { spec } = fixture();
    expect(AuthorizationSpecSchema.safeParse({ ...spec, recipients: { kind: 'fixed', targets: [spec.recipients.targets[0], spec.recipients.targets[0]] } }).success).toBe(false);
    expect(AuthorizationSpecSchema.safeParse({ ...spec, limits: { ...spec.limits, perRun: 20 } }).success).toBe(false);
    expect(AuthorizationSpecSchema.safeParse({ ...spec, output: { mode: 'protected_doc_link', docIds: ['other'] } }).success).toBe(false);
  });
  it('摘要排序稳定且拒绝非 JSON 值', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(NaN)).toThrow();
  });
  it('并发审批仅一次成功，草稿不是授权', async () => {
    const { store, spec, actor } = fixture();
    const rec = await store.createDraft(spec);
    const d = rec.data as unknown as AuthorizationRecord;
    expect(d.grantId).toBeNull();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => store.approve(actor, rec.id, rec.version, d.draftDigest)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('bot、代办和非所有者不能批准', async () => {
    const { store, spec, actor } = fixture();
    const rec = await store.createDraft(spec);
    const digest = String(rec.data.draftDigest);
    for (const authentication of ['bot', 'delegated'] as const)
      await expect(store.approve({ ...actor, authentication }, rec.id, 1, digest)).rejects.toThrow('PERMISSION_DENIED');
    await expect(store.approve({ ...actor, userId: 'other' }, rec.id, 1, digest)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('过期草稿和错误摘要不能审批', async () => {
    const { store, spec, actor, advance } = fixture();
    const rec = await store.createDraft(spec);
    await expect(store.approve(actor, rec.id, 1, 'wrong')).rejects.toThrow('DRAFT_STALE');
    advance(30 * 60_000);
    await expect(store.approve(actor, rec.id, 1, String(rec.data.draftDigest))).rejects.toThrow('DRAFT_STALE');
  });
  it('安全配置变化、停用、身份变化拒绝旧草稿', async () => {
    for (const change of ['prompt', 'enabled', 'principal'] as const) {
      const { store, spec, actor, task } = fixture();
      const rec = await store.createDraft(spec);
      if (change === 'prompt') task.securityConfig.prompt = '新提示';
      if (change === 'enabled') task.enabled = false;
      if (change === 'principal') task.principalId = 'other';
      await expect(store.approve(actor, rec.id, 1, String(rec.data.draftDigest))).rejects.toThrow();
    }
  });
  it('撤销后不能重新批准复活', async () => {
    const { store, spec, actor } = fixture();
    const rec = await store.createDraft(spec);
    const digest = String(rec.data.draftDigest);
    await store.approve(actor, rec.id, 1, digest);
    expect((await store.revoke(actor, rec.id, 2)).status).toBe('revoked');
    await expect(store.approve(actor, rec.id, 3, digest)).rejects.toThrow('DRAFT_STALE');
  });
  it('运行状态以投递结果聚合，不以模型文本判断', () => {
    const result = { logicalMessageId: 'm', target: { type: 'chat' as const, id: 'c' } };
    expect(aggregateRunStatus([], false)).toBe('running');
    expect(aggregateRunStatus([], true)).toBe('blocked');
    expect(aggregateRunStatus([{ ...result, status: 'sent' }], true)).toBe('succeeded');
    expect(aggregateRunStatus([{ ...result, status: 'sent' }, { ...result, status: 'blocked' }], true)).toBe('partial');
    expect(aggregateRunStatus([{ ...result, status: 'failed' }], true)).toBe('failed');
  });
});
