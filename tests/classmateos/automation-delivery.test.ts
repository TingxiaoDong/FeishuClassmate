/**
 * 自动化预授权 v2 原子投递：Memory 必跑；设置 CLASSMATEOS_TEST_PG_URL 时在 PostgreSQL 上同样跑（会清空该库）。
 * 不向真实群发送任何消息：所有会话、用户都在隔离存储里新建。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { MemoryRepo } from '../../classmateos/server/memory-repo.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import type { Repo, UserRecord } from '../../classmateos/server/repo.js';
import { AutomationAuthorizationStore, taskRevision, type AuthorizationPolicy, type TaskSnapshot } from '../../classmateos/server/automation-authorization.js';
import { AutomationRunCredentials, hash } from '../../classmateos/server/automation-run-credentials.js';
import { AutomationDeliveryService } from '../../classmateos/server/automation-delivery.js';
import { shanghaiDayKey } from '../../classmateos/server/automation-delivery-core.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
let pool: pg.Pool | undefined;
afterAll(async () => { await pool?.end(); });
const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];
const T0 = Date.parse('2026-10-21T04:00:00Z'); // 北京时间 12:00

async function makeRepo(usePg: boolean): Promise<Repo> {
  if (!usePg) return new MemoryRepo();
  pool ??= new pg.Pool({ connectionString: PG_URL, max: 12 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
  const repo = new PgRepo(pool);
  await repo.init();
  return repo;
}

const user = (user_id: string, name: string): UserRecord => ({ user_id, name, email: null, role: 'member', avatar_url: null, department: null, title: null, phone: null, status_text: null, password_hash: 'x', disabled: false, created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString() });

async function fixture(usePg: boolean, limits = { perRun: 2, perDay: 3, perTargetPerRun: 2, perTargetPerDay: 3, timezone: 'Asia/Shanghai' as const }) {
  let now = T0;
  let permitted = true;
  const repo = await makeRepo(usePg);
  for (const [id, name] of [['u1', '张三'], ['u2', '李四'], ['u3', '王五']]) await repo.insertUserIfMissing(user(id, name));
  const at = new Date(T0).toISOString();
  const base = { description: null, kind: 'normal' as const, p2p_key: null, created_at: at, updated_at: at };
  await repo.createChat({ ...base, chat_id: 'c1', chat_type: 'group', name: '课题组', owner_id: 'u1', member_ids: ['u1', 'u2'] });
  await repo.createChat({ ...base, chat_id: 'c2', chat_type: 'group', name: '别的群', owner_id: 'u3', member_ids: ['u3'] });
  const task: TaskSnapshot = { taskKind: 'trigger', taskId: 't1', ownerId: 'u1', principalId: 'u1', enabled: true, securityConfig: { prompt: '日报' } };
  await repo.saveEntity({ kind: 'test_task', id: 't1', scope: 'u1', data: task as unknown as Record<string, unknown>, version: 0, created_at: at, updated_at: at }, 0);
  const policy: AuthorizationPolicy = {
    loadTask: async (_k, id) => (await repo.getEntity('test_task', id))?.data as unknown as TaskSnapshot | undefined,
    assertCanApprove: async () => { if (!permitted) throw new Error('PERMISSION_DENIED'); },
    assertCanRevoke: async () => {},
  };
  const clock = () => now;
  const store = new AutomationAuthorizationStore(repo, policy, clock);
  const spec = { taskKind: 'trigger', taskId: 't1', taskRevision: taskRevision(task), principalId: 'u1',
    recipients: { kind: 'fixed', targets: [{ type: 'chat', id: 'c1' }, { type: 'user', id: 'u2' }] },
    resources: [{ type: 'doc', resourceId: 'd1' }, { type: 'doc', resourceId: 'd2' }], output: { mode: 'protected_doc_link', docIds: ['d1', 'd2'] },
    limits, expiresAt: new Date(T0 + 3 * 86400_000).toISOString() };
  const draft = await store.createDraft(spec);
  const actor = { userId: 'u1', authentication: 'user' as const };
  await store.approve(actor, draft.id, 1, String(draft.data.draftDigest));
  const credentials = new AutomationRunCredentials(repo, policy, clock);
  const sent: string[] = [];
  const service = new AutomationDeliveryService(repo, policy, credentials,
    { entityKind: () => 'test_task', revisionOf: (_k, _id, data) => taskRevision(data as unknown as TaskSnapshot) },
    { messageSent: (_chat, m) => { sent.push(m.message_id); } }, clock);
  const issue = () => credentials.issue(draft.id, spec.taskRevision);
  const doc = (logicalMessageId: string, target: { type: 'chat' | 'user'; id: string } = { type: 'chat', id: 'c1' }, docId = 'd1') => ({ logicalMessageId, target, payload: { mode: 'protected_doc_link', docId } });
  const botMessages = async (chatId: string) => ((await repo.listMessages(chatId, { limit: 100 }))?.items ?? []).filter(m => m.sender_id === 'bot');
  return { repo, store, draft, actor, credentials, service, issue, doc, botMessages, sent, task, spec, at,
    advance: (ms: number) => { now += ms; }, deny: () => { permitted = false; } };
}

describe.each(backends)('自动化原子投递（$name）', ({ usePg }) => {
  it('固定群和固定用户都能发出；正文由后端生成，带代发标记，不带标题和摘要', async () => {
    const f = await fixture(usePg);
    const ctx = await f.issue();
    const a = await f.service.deliver(ctx, f.doc('m1'));
    const b = await f.service.deliver(ctx, f.doc('m2', { type: 'user', id: 'u2' }));
    expect(a).toMatchObject({ status: 'sent', duplicate: false });
    expect(b).toMatchObject({ status: 'sent', duplicate: false });
    const [msg] = await f.botMessages('c1');
    expect(msg.content).toMatchObject({ sent_on_behalf_of: { user_id: 'u1', name: '张三' }, agent_result: { links: [{ link: 'cos://doc/d1', kind: 'doc', id: 'd1' }] } });
    expect(JSON.stringify(msg.content)).not.toContain(ctx.sendCredential);
    expect(b.message!.chat_id).not.toBe('c1'); // 发给用户走机器人单聊
    expect(f.sent).toHaveLength(2);
    const rows = await f.service.listDeliveries(ctx.grantId);
    expect(rows.map(r => r.status).sort()).toEqual(['sent', 'sent']);
    expect(JSON.stringify(rows)).not.toContain(ctx.sendCredential);
  });

  it('同一逻辑消息：顺序重试和 10 个并发请求都只发一条；同键不同内容冲突', async () => {
    const f = await fixture(usePg);
    const ctx = await f.issue();
    const first = await f.service.deliver(ctx, f.doc('same'));
    const again = await f.service.deliver(ctx, f.doc('same'));
    expect(again).toMatchObject({ status: 'sent', duplicate: true, messageId: first.messageId });
    const results = await Promise.all(Array.from({ length: 10 }, () => f.service.deliver(ctx, f.doc('burst'))));
    expect(new Set(results.map(r => r.messageId)).size).toBe(1);
    expect(results.filter(r => !r.duplicate)).toHaveLength(1);
    expect(await f.botMessages('c1')).toHaveLength(2);
    expect(f.sent).toHaveLength(2); // 重复请求不再推送事件
    await expect(f.service.deliver(ctx, f.doc('same', { type: 'chat', id: 'c1' }, 'd2'))).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('并发共享额度：每次运行上限 2、每天上限 3，超出的全部拦截；第二天恢复，同一逻辑消息可补发', async () => {
    const f = await fixture(usePg);
    const ctx = await f.issue();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => f.service.deliver(ctx, f.doc(`q${i}`))));
    expect(results.filter(r => r.status === 'sent')).toHaveLength(2);
    expect(results.filter(r => r.status === 'blocked').every(r => r.code === 'QUOTA_EXCEEDED')).toBe(true);
    const ctx2 = await f.issue();
    const second = await Promise.all(Array.from({ length: 5 }, (_, i) => f.service.deliver(ctx2, f.doc(`r${i}`))));
    expect(second.filter(r => r.status === 'sent')).toHaveLength(1); // 每天上限 3
    expect(await f.botMessages('c1')).toHaveLength(3);
    f.advance(86400_000); // 北京时间第二天
    expect(shanghaiDayKey(T0 + 86400_000)).toBe('2026-10-22');
    const ctx3 = await f.issue();
    const retry = await f.service.deliver(ctx3, f.doc('r4')); // 昨天被额度拦下的逻辑消息
    expect(retry.status).toBe('sent');
    expect(await f.botMessages('c1')).toHaveLength(4);
  });

  it('多次运行并发：每天额度和同一逻辑消息在不同运行之间也不会超发 / 重发', async () => {
    // 每次运行各自最多 3 条，5 次运行同时发，只能共享当天的 3 条。
    const f = await fixture(usePg, { perRun: 3, perDay: 3, perTargetPerRun: 3, perTargetPerDay: 3, timezone: 'Asia/Shanghai' });
    const runs = await Promise.all(Array.from({ length: 5 }, () => f.issue()));
    const results = await Promise.all(runs.flatMap((ctx, r) => Array.from({ length: 4 }, (_, i) => f.service.deliver(ctx, f.doc(`day-${r}-${i}`)))));
    expect(results.filter(r => r.status === 'sent')).toHaveLength(3);
    expect(await f.botMessages('c1')).toHaveLength(3);
    const g = await fixture(usePg, { perRun: 10, perDay: 20, perTargetPerRun: 10, perTargetPerDay: 20, timezone: 'Asia/Shanghai' });
    const gruns = await Promise.all(Array.from({ length: 6 }, () => g.issue()));
    const same = await Promise.all(gruns.map(ctx => g.service.deliver(ctx, g.doc('shared-key'))));
    expect(new Set(same.map(r => r.messageId)).size).toBe(1);
    expect(await g.botMessages('c1')).toHaveLength(1);
  });

  it('越界目标、未批准的文档和受控模板都被拦截并留下记录，不发消息', async () => {
    const f = await fixture(usePg);
    const ctx = await f.issue();
    expect(await f.service.deliver(ctx, f.doc('x1', { type: 'chat', id: 'c2' }))).toMatchObject({ status: 'blocked', code: 'TARGET_OUT_OF_SCOPE' });
    expect(await f.service.deliver(ctx, f.doc('x2', { type: 'user', id: 'u3' }))).toMatchObject({ status: 'blocked', code: 'TARGET_OUT_OF_SCOPE' });
    expect(await f.service.deliver(ctx, f.doc('x3', { type: 'chat', id: 'c1' }, 'd9'))).toMatchObject({ status: 'blocked', code: 'CONTENT_MODE_NOT_ALLOWED' });
    expect(await f.service.deliver(ctx, { logicalMessageId: 'x4', target: { type: 'chat', id: 'c1' }, payload: { mode: 'controlled_template', templateId: 'tpl', templateVersion: 1 } })).toMatchObject({ status: 'blocked', code: 'CONTENT_MODE_NOT_ALLOWED' });
    await expect(f.service.deliver(ctx, { ...f.doc('x5'), text: '模型正文' })).rejects.toThrow();
    expect(await f.botMessages('c1')).toHaveLength(0);
    expect(await f.botMessages('c2')).toHaveLength(0);
    expect((await f.service.listDeliveries(ctx.grantId)).filter(r => r.status === 'blocked')).toHaveLength(4);
  });

  it('伪造、借用、已结束的凭证直接拒绝，不留记录', async () => {
    const f = await fixture(usePg);
    const ctx = await f.issue();
    const other = await f.issue();
    for (const bad of [{ ...ctx, sendCredential: 'x'.repeat(43) }, { ...ctx, sendCredential: other.sendCredential }, { ...ctx, runId: other.runId }])
      await expect(f.service.deliver(bad, f.doc('c'))).rejects.toThrow('RUN_CREDENTIAL_INVALID');
    await f.credentials.finish(ctx);
    await expect(f.service.deliver(ctx, f.doc('c'))).rejects.toThrow('RUN_CREDENTIAL_INVALID');
    f.advance(300_000);
    await expect(f.service.deliver(other, f.doc('c'))).rejects.toThrow('RUN_CREDENTIAL_INVALID');
    expect(await f.service.listDeliveries(ctx.grantId)).toEqual([]);
  });

  it('撤销、任务停用、权限失效后，已签发的凭证不能再发送', async () => {
    for (const mode of ['revoke', 'disable', 'permission'] as const) {
      const f = await fixture(usePg);
      const ctx = await f.issue();
      if (mode === 'revoke') await f.store.revoke(f.actor, f.draft.id, 2);
      if (mode === 'disable') {
        const rec = (await f.repo.getEntity('test_task', 't1'))!;
        await f.repo.saveEntity({ ...rec, data: { ...rec.data, enabled: false } }, rec.version);
      }
      if (mode === 'permission') f.deny();
      const r = await f.service.deliver(ctx, f.doc('after'));
      expect(r, mode).toMatchObject({ status: 'blocked', code: { revoke: 'GRANT_REVOKED', disable: 'TASK_DISABLED', permission: 'PERMISSION_DENIED' }[mode] });
      expect(await f.botMessages('c1')).toHaveLength(0);
    }
  });

  it('撤销与发送并发：撤销完成后不会再有新消息', async () => {
    const f = await fixture(usePg, { perRun: 20, perDay: 50, perTargetPerRun: 20, perTargetPerDay: 50, timezone: 'Asia/Shanghai' });
    const ctx = await f.issue();
    const sends = Array.from({ length: 8 }, (_, i) => f.service.deliver(ctx, f.doc(`race${i}`)));
    await f.store.revoke(f.actor, f.draft.id, 2);
    const settled = await Promise.all(sends);
    const after = await Promise.all(Array.from({ length: 3 }, (_, i) => f.service.deliver(ctx, f.doc(`late${i}`))));
    expect(after.every(r => r.status === 'blocked' && r.code === 'GRANT_REVOKED')).toBe(true);
    const sentCount = settled.filter(r => r.status === 'sent').length;
    expect(await f.botMessages('c1')).toHaveLength(sentCount);
  });

  it('事务内重查：绕过前置检查直接提交时，任务版本变化和成员被移出仍会拦截', async () => {
    const f = await fixture(usePg);
    const ctx = await f.issue();
    const run = (await f.repo.getEntity('automation_run_v2', ctx.runId))!.data;
    const commit = (key: string, credential = ctx.sendCredential) => f.repo.commitAutomationDelivery({
      grantKind: 'automation_authorization_v2', draftId: f.draft.id, grantId: ctx.grantId, runKind: 'automation_run_v2', runId: ctx.runId,
      credentialHash: hash(credential),
      task: { kind: 'test_task', id: 't1', expectedRevision: String(run.taskRevision), revisionOf: d => taskRevision(d as unknown as TaskSnapshot) },
      memberCheck: { chatId: 'c1', userId: 'u1' }, deliveryKey: key, payloadDigest: 'p', targetKey: 'chat:c1', dayKey: shanghaiDayKey(T0),
      limits: { perRun: 9, perDay: 9, perTargetPerRun: 9, perTargetPerDay: 9 }, blockedCode: null,
      message: { message_id: `msg_${key}`, chat_id: 'c1', sender_id: 'bot', msg_type: 'text', content: { text: 't' }, created_at: f.at, reply_to_message_id: null, client_msg_id: `auto_${key}`, card_id: null },
      record: {}, nowMs: T0,
    });
    await f.repo.removeMember('c1', 'u1');
    expect(await commit('k1')).toEqual({ status: 'blocked', code: 'PERMISSION_DENIED' });
    await f.repo.addMembers('c1', ['u1'], f.at);
    const rec = (await f.repo.getEntity('test_task', 't1'))!;
    await f.repo.saveEntity({ ...rec, data: { ...rec.data, securityConfig: { prompt: '改过' } } }, rec.version);
    expect(await commit('k2')).toEqual({ status: 'blocked', code: 'TASK_REVISION_CHANGED' });
    expect(await commit('k2')).toEqual({ status: 'blocked', code: 'TASK_REVISION_CHANGED' });
    expect(await f.botMessages('c1')).toHaveLength(0);
    expect(await commit('k3', 'y'.repeat(43))).toEqual({ status: 'rejected', code: 'RUN_CREDENTIAL_INVALID' });
  });

  it.runIf(usePg)('PostgreSQL：写投递记录时失败，消息一并回滚；修复后重试只发一条', async () => {
    const f = await fixture(usePg);
    const ctx = await f.issue();
    await pool!.query(`CREATE FUNCTION _fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.kind = 'automation_delivery_v2' AND NEW.data->>'status' = 'sent' THEN RAISE EXCEPTION 'simulated crash'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER _fail_delivery BEFORE INSERT OR UPDATE ON cos_entities FOR EACH ROW EXECUTE FUNCTION _fail_delivery();`);
    try {
      expect(await f.service.deliver(ctx, f.doc('crash'))).toMatchObject({ status: 'failed' });
      expect(await f.botMessages('c1')).toHaveLength(0);
      expect(await f.service.listDeliveries(ctx.grantId)).toEqual([]);
    } finally {
      await pool!.query('DROP TRIGGER _fail_delivery ON cos_entities; DROP FUNCTION _fail_delivery();');
    }
    expect(await f.service.deliver(ctx, f.doc('crash'))).toMatchObject({ status: 'sent', duplicate: false });
    expect(await f.service.deliver(ctx, f.doc('crash'))).toMatchObject({ status: 'sent', duplicate: true });
    expect(await f.botMessages('c1')).toHaveLength(1);
  });
});
