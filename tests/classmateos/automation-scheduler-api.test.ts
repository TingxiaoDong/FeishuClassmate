/**
 * 自动化预授权 v2：调度器 HTTP 接口 + 前端审阅快照 / 运行查询 / 审批并启用。
 * Memory 必跑；设置 CLASSMATEOS_TEST_PG_URL 时在 PostgreSQL 上同样跑（会清空该库）。
 * 所有用户、群、文档都在隔离存储里新建，不向真实群发送消息。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import { usableSchedulerToken } from '../../classmateos/server/routes-automation-scheduler.js';
import { verifyScheduleOccurrence } from '../../classmateos/server/automation-occurrence.js';
import { COS_API_CATALOG } from '../../src/cos-sdk/catalog.generated.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
let pool: pg.Pool | undefined;
afterAll(async () => { await pool?.end(); });
const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];
const SCHED = 's'.repeat(40);
const minuteSlot = (offsetMin = 0) => { const d = new Date(Date.now() + offsetMin * 60_000); d.setUTCSeconds(0, 0); return `schedule:${d.toISOString().replace('.000Z', 'Z')}`; };

describe('触发证据核验（纯函数）', () => {
  it('只接受 cron 真实触发时刻，窗口 6 小时；北京时间计算', () => {
    const now = Date.parse('2026-10-21T04:30:00Z'); // 北京时间 12:30
    const t = { event: 'schedule', cron: '0 12 * * *' };
    expect(verifyScheduleOccurrence(t, 'schedule:2026-10-21T12:00:00+08:00', now)).toBe('schedule:2026-10-21T04:00:00.000Z');
    expect(verifyScheduleOccurrence(t, 'schedule:2026-10-21T04:00:00Z', now)).toBe('schedule:2026-10-21T04:00:00.000Z');
    for (const bad of ['schedule:2026-10-21T04:01:00Z', 'schedule:2026-10-20T04:00:00Z', 'schedule:2026-10-21T04:00:00.500Z', 'schedule:2026-10-21T04:00:00', 'cron:2026-10-21T04:00:00Z', 'schedule:abc'])
      expect(() => verifyScheduleOccurrence(t, bad, now), bad).toThrow('RUN_CREDENTIAL_INVALID');
    expect(() => verifyScheduleOccurrence({ event: 'record.changed', cron: null }, 'schedule:2026-10-21T04:00:00Z', now)).toThrow('UNSUPPORTED_CAPABILITY');
  });
  it('调度器内部接口不进模型可见的接口目录', () => {
    expect(COS_API_CATALOG.filter(e => e.path.startsWith('/internal/'))).toEqual([]);
  });
  it('调度器密钥太短、或与 bot 令牌相同，都视为未配置', () => {
    expect(usableSchedulerToken('short', 'b')).toBeUndefined();
    expect(usableSchedulerToken(SCHED, SCHED)).toBeUndefined();
    expect(usableSchedulerToken(SCHED, 'bot')).toBe(SCHED);
  });
});

describe.each(backends)('调度器接口与审阅快照（$name）', ({ usePg }) => {
  async function setup(opts: { scheduler?: boolean; cron?: string; enabled?: boolean; leaseMs?: number } = {}) {
    const o: AppOptions = {
      secret: 'test-only', botToken: 'test-bot', notificationScanner: false,
      automationSchedulerToken: opts.scheduler === false ? undefined : SCHED, automationResumeLeaseMs: opts.leaseMs ?? 0,
      users: [['u1', '张三'], ['u2', '李四'], ['u3', '王五']].map(([user_id, name]) => ({ user_id, name, password: 'pw', role: 'member' as const })),
    };
    if (usePg) {
      pool ??= new pg.Pool({ connectionString: PG_URL, max: 8 });
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await pool.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
      await new PgRepo(pool).init();
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
    const sched = (method: string, url: string, payload?: unknown, credential?: string, token = SCHED) => app.inject({
      method: method as 'GET', url: `/api/v1/internal/automation${url}`, payload: payload as Record<string, unknown>,
      headers: { 'x-automation-scheduler-token': token, ...(credential !== undefined ? { 'x-automation-run-credential': credential } : {}) },
    });
    const chatId = (await call('u1', 'POST', '/chats', { chat_type: 'group', name: '课题组', member_ids: ['u2'] })).json().chat_id as string;
    const otherChat = (await call('u3', 'POST', '/chats', { chat_type: 'group', name: '别的群', member_ids: ['u1'] })).json().chat_id as string;
    const trig = await call('u1', 'POST', '/agent/triggers', { name: '日报', event: 'schedule', cron: opts.cron ?? '* * * * *', prompt: '整理日报', enabled: opts.enabled ?? true });
    expect(trig.statusCode, trig.body).toBe(201);
    const taskId = trig.json().trigger_id as string;
    const docId = (await call('u1', 'POST', '/docs', { title: '机密周报标题', markdown: '正文' })).json().doc_id as string;
    const createDraft = async () => {
      const r = await call('u1', 'POST', '/automation/drafts', {
        taskKind: 'trigger', taskId, recipients: { kind: 'fixed', targets: [{ type: 'chat', id: chatId }, { type: 'user', id: 'u3' }] },
        resources: [{ type: 'doc', resourceId: docId }], output: { mode: 'protected_doc_link', docIds: [docId] },
        limits: { perRun: 5, perDay: 20, perTargetPerRun: 3, perTargetPerDay: 10, timezone: 'Asia/Shanghai' }, expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json();
    };
    const approve = async (d: { draftId: string; version: number; draftDigest: string }, extra: Record<string, unknown> = {}) =>
      call('u1', 'POST', `/automation/drafts/${d.draftId}/approve`, { expectedVersion: d.version, expectedDigest: d.draftDigest, ...extra });
    const doc = (logicalMessageId: string, target: { type: string; id: string }) => ({ logicalMessageId, target, purpose: 'final', payload: { mode: 'protected_doc_link', docId } });
    const botMsgs = async (u: string, chat: string) => ((await call(u, 'GET', `/chats/${chat}/messages`)).json().items as Array<{ sender_id: string; message_id: string }>).filter(m => m.sender_id === 'bot');
    return { app, call, sched, chatId, otherChat, taskId, docId, createDraft, approve, doc, botMsgs };
  }

  it('最小调用链：快照 → 开始运行 → 投递 → 查询 → 恢复换发凭证 → 原键重放不重发 → 结束 → 撤销后拒绝', async () => {
    const f = await setup();
    try {
      const draft = await f.createDraft();
      expect((await f.approve(draft)).json()).toMatchObject({ status: 'active', taskEnabled: true, deliveryEnabled: true });
      expect((await f.call('u1', 'GET', '/automation/capabilities')).json()).toMatchObject({ fixedTargetDelivery: true, atomicDelivery: true, taskKinds: { trigger: { schedule: true, events: false }, scheduler: false }, restrictedRead: false, businessOperations: false, aiText: false });

      const snap = (await f.sched('GET', `/tasks/trigger/${f.taskId}`)).json();
      expect(snap).toMatchObject({ taskKind: 'trigger', principalId: 'u1', enabled: true, deliveryReady: true, grant: { draftId: draft.draftId, effectiveStatus: 'active' } });
      expect(snap.taskRevision).toBe(draft.spec.taskRevision);

      const occ = minuteSlot();
      const begin = await f.sched('POST', '/runs', { taskKind: 'trigger', taskId: f.taskId, expectedTaskRevision: snap.taskRevision, occurrenceId: occ });
      expect(begin.statusCode, begin.body).toBe(201);
      const run = begin.json();
      expect(run).toMatchObject({ resumed: false, status: 'running', scope: 'bot.messages.send', principalId: 'u1', credential: { header: 'X-Automation-Run-Credential' } });
      const cred1 = run.credential.sendCredential as string;

      const a = await f.sched('POST', `/runs/${run.runId}/deliveries`, f.doc('daily', { type: 'chat', id: f.chatId }), cred1);
      expect(a.json()).toMatchObject({ status: 'sent', duplicate: false, retryable: false });
      const b = await f.sched('POST', `/runs/${run.runId}/deliveries`, f.doc('daily', { type: 'user', id: 'u3' }), cred1);
      expect(b.json()).toMatchObject({ status: 'sent' });
      expect(JSON.stringify(a.json())).not.toContain('机密周报标题');

      // 用户侧运行查询：逐目标结果、显示名，不含凭证
      const runs = await f.call('u1', 'GET', `/automation/runs?taskKind=trigger&taskId=${f.taskId}`);
      expect(runs.statusCode, runs.body).toBe(200);
      expect(runs.json()).toMatchObject({ total: 1, items: [{ runId: run.runId, status: 'running', occurrenceId: occ.replace('Z', '.000Z'), documentCreated: false }] });
      expect(runs.json().items[0].deliveries.map((d: { target: { displayName: string } }) => d.target.displayName).sort()).toEqual(['王五', '课题组']);
      expect(runs.body).not.toContain(cred1);
      expect(runs.body).not.toContain('credentialHash');
      expect((await f.call('u2', 'GET', `/automation/runs/${run.runId}`)).statusCode).toBe(404);

      // 重启后同一次触发：同一 runId，换发凭证，旧凭证失效；原键重放不重发
      const again = await f.sched('POST', '/runs', { taskKind: 'trigger', taskId: f.taskId, expectedTaskRevision: snap.taskRevision, occurrenceId: occ });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ runId: run.runId, resumed: true });
      expect(again.json().deliveries).toHaveLength(2);
      const cred2 = again.json().credential.sendCredential as string;
      expect(cred2).not.toBe(cred1);
      const old = await f.sched('POST', `/runs/${run.runId}/deliveries`, f.doc('daily', { type: 'chat', id: f.chatId }), cred1);
      expect(old.statusCode).toBe(401);
      expect(old.json().code).toBe('RUN_CREDENTIAL_INVALID');
      const replay = await f.sched('POST', `/runs/${run.runId}/deliveries`, f.doc('daily', { type: 'chat', id: f.chatId }), cred2);
      expect(replay.json()).toMatchObject({ status: 'sent', duplicate: true, messageId: a.json().messageId });
      expect(await f.botMsgs('u2', f.chatId)).toHaveLength(1);

      // 按任务 + occurrence 查询（恢复用）
      expect((await f.sched('GET', `/runs?taskKind=trigger&taskId=${f.taskId}&occurrenceId=${encodeURIComponent(occ)}`)).json()).toMatchObject({ runId: run.runId });

      const fin = await f.sched('POST', `/runs/${run.runId}/finish`, {}, cred2);
      expect(fin.json()).toMatchObject({ status: 'succeeded' });
      expect((await f.sched('POST', `/runs/${run.runId}/finish`, {})).json()).toMatchObject({ status: 'succeeded' });
      const afterFinish = await f.sched('POST', '/runs', { taskKind: 'trigger', taskId: f.taskId, expectedTaskRevision: snap.taskRevision, occurrenceId: occ });
      expect(afterFinish.json()).toMatchObject({ resumed: true, status: 'succeeded', credential: null });

      // 撤销后：新的一次触发拿不到凭证
      const grantVersion = (await f.call('u1', 'GET', `/automation/drafts/${draft.draftId}`)).json().version;
      expect((await f.call('u1', 'POST', `/automation/drafts/${draft.draftId}/revoke`, { expectedVersion: grantVersion })).json()).toMatchObject({ status: 'revoked', deliveryEnabled: false });
      const denied = await f.sched('POST', '/runs', { taskKind: 'trigger', taskId: f.taskId, expectedTaskRevision: snap.taskRevision, occurrenceId: minuteSlot(-1) });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe('AUTHORIZATION_REQUIRED');
    } finally { await f.app.close(); }
  });

  it('部分成功、越界拦截、同键不同载荷 409、多余字段 422；撤销后恢复运行被拒', async () => {
    const f = await setup();
    try {
      const draft = await f.createDraft();
      await f.approve(draft);
      const rev = draft.spec.taskRevision;
      const run = (await f.sched('POST', '/runs', { taskKind: 'trigger', taskId: f.taskId, expectedTaskRevision: rev, occurrenceId: minuteSlot() })).json();
      const c = run.credential.sendCredential;
      expect((await f.sched('POST', `/runs/${run.runId}/deliveries`, f.doc('m', { type: 'chat', id: f.chatId }), c)).json().status).toBe('sent');
      const out = (await f.sched('POST', `/runs/${run.runId}/deliveries`, f.doc('m', { type: 'chat', id: f.otherChat }), c)).json();
      expect(out).toMatchObject({ status: 'blocked', code: 'TARGET_OUT_OF_SCOPE', retryable: false });
      expect(await f.botMsgs('u3', f.otherChat)).toHaveLength(0);
      const conflict = await f.sched('POST', `/runs/${run.runId}/deliveries`, { ...f.doc('m', { type: 'chat', id: f.chatId }), payload: { mode: 'controlled_template', templateId: 't', templateVersion: 1 } }, c);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe('IDEMPOTENCY_CONFLICT');
      const extra = await f.sched('POST', `/runs/${run.runId}/deliveries`, { ...f.doc('n', { type: 'chat', id: f.chatId }), text: '模型正文' }, c);
      expect(extra.statusCode).toBe(422);
      expect((await f.sched('POST', `/runs/${run.runId}/finish`, {}, c)).json()).toMatchObject({ status: 'partial' });

      // 新运行进行中被撤销：恢复被拒，旧凭证也发不出去
      const run2 = (await f.sched('POST', '/runs', { taskKind: 'trigger', taskId: f.taskId, expectedTaskRevision: rev, occurrenceId: minuteSlot(-1) })).json();
      const v = (await f.call('u1', 'GET', `/automation/drafts/${draft.draftId}`)).json().version;
      await f.call('u1', 'POST', `/automation/drafts/${draft.draftId}/revoke`, { expectedVersion: v });
      const resume = await f.sched('POST', '/runs', { taskKind: 'trigger', taskId: f.taskId, expectedTaskRevision: rev, occurrenceId: minuteSlot(-1) });
      expect(resume.json().code).toBe('GRANT_REVOKED');
      const late = await f.sched('POST', `/runs/${run2.runId}/deliveries`, f.doc('late', { type: 'chat', id: f.chatId }), run2.credential.sendCredential);
      expect(late.json()).toMatchObject({ status: 'blocked', code: 'GRANT_REVOKED' });
      expect(await f.botMsgs('u2', f.chatId)).toHaveLength(1);
    } finally { await f.app.close(); }
  });

  it('调度器鉴权：未配置 503；bot 令牌、用户令牌、错误密钥 401；能力开关随之关闭', async () => {
    const off = await setup({ scheduler: false });
    try {
      expect((await off.sched('GET', `/tasks/trigger/${off.taskId}`)).statusCode).toBe(503);
      expect((await off.call('u1', 'GET', '/automation/capabilities')).json()).toMatchObject({ fixedTargetDelivery: false, durableResume: false });
      const d = await off.createDraft();
      expect((await off.approve(d)).json()).toMatchObject({ status: 'active', deliveryEnabled: false });
    } finally { await off.app.close(); }
    const f = await setup();
    try {
      expect((await f.sched('GET', `/tasks/trigger/${f.taskId}`, undefined, undefined, 'test-bot')).statusCode).toBe(401);
      expect((await f.sched('GET', `/tasks/trigger/${f.taskId}`, undefined, undefined, 'x'.repeat(40))).statusCode).toBe(401);
      expect((await f.app.inject({ method: 'GET', url: `/api/v1/internal/automation/tasks/trigger/${f.taskId}`, headers: { 'x-bot-token': 'test-bot' } })).statusCode).toBe(401);
      expect((await f.call('u1', 'GET', `/internal/automation/tasks/trigger/${f.taskId}`)).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });

  it('触发证据：非触发时刻、过旧、版本不一致、未批准都拿不到凭证；10 个并发开始同一次触发只建一个运行', async () => {
    const f = await setup({ cron: '0 3 * * *' });
    try {
      const draft = await f.createDraft();
      await f.approve(draft);
      const rev = draft.spec.taskRevision;
      const begin = (occurrenceId: string, expectedTaskRevision = rev) => f.sched('POST', '/runs', { taskKind: 'trigger', taskId: f.taskId, expectedTaskRevision, occurrenceId });
      const notSlot = await begin(minuteSlot());
      // 当前分钟若恰好是北京时间 03:00 会命中，跳过这种极小概率情况
      if (new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 16) !== '03:00') expect(notSlot.json().code).toBe('RUN_CREDENTIAL_INVALID');
      expect((await begin('schedule:2020-01-01T19:00:00Z')).statusCode).toBe(401);
      expect((await f.sched('POST', '/runs', { taskKind: 'scheduler', taskId: 'x', expectedTaskRevision: rev, occurrenceId: 'schedule:2020-01-01T19:00:00Z' })).statusCode).toBe(422);
    } finally { await f.app.close(); }
    const g = await setup({ leaseMs: 15_000 });
    try {
      const draft = await g.createDraft();
      const occ = minuteSlot();
      const begin = (expectedTaskRevision: string) => g.sched('POST', '/runs', { taskKind: 'trigger', taskId: g.taskId, expectedTaskRevision, occurrenceId: occ });
      expect((await begin(draft.spec.taskRevision)).json().code).toBe('AUTHORIZATION_REQUIRED'); // 未批准
      await g.approve(draft);
      expect((await begin('0'.repeat(64))).statusCode).toBe(409);
      const all = await Promise.all(Array.from({ length: 10 }, () => begin(draft.spec.taskRevision)));
      // 只有一个拿到凭证（201）；其余是 409 RUN_BUSY，指向同一个运行，不会顶掉赢家的凭证
      expect(all.filter(r => r.statusCode === 201)).toHaveLength(1);
      const busy = all.filter(r => r.statusCode !== 201);
      expect(busy.every(r => r.statusCode === 409 && r.json().code === 'RUN_BUSY' && r.json().retryAfterMs > 0), busy.map(r => r.body).join('\n')).toBe(true);
      const winner = all.find(r => r.statusCode === 201)!.json();
      expect(new Set(all.map(r => r.json().runId)).size).toBe(1);
      const sent = await g.sched('POST', `/runs/${winner.runId}/deliveries`, g.doc('only', { type: 'chat', id: g.chatId }), winner.credential.sendCredential);
      expect(sent.json()).toMatchObject({ status: 'sent' });
      // 租约期内再次开始：仍是 RUN_BUSY，赢家凭证继续有效
      expect((await begin(draft.spec.taskRevision)).json().code).toBe('RUN_BUSY');
      expect((await g.call('u1', 'GET', '/automation/runs')).json().total).toBe(1);
    } finally { await g.app.close(); }
  });

  it('停用任务：可建草稿；审批须 enableTask，原子启用同一修订；之后停用再启用会让授权失效', async () => {
    const f = await setup({ enabled: false });
    try {
      const draft = await f.createDraft();
      const detail = (await f.call('u1', 'GET', `/automation/drafts/${draft.draftId}`)).json();
      expect(detail).toMatchObject({
        task: { name: '日报', enabled: false, cron: '* * * * *', scheduleTimezone: 'Asia/Shanghai', revisionMatches: true, deliverySupported: true },
        principal: { id: 'u1', name: '张三', accountType: 'user', active: true },
        permissions: { canApprove: true, canRevoke: true, requiresEnableTask: true },
        effectiveStatus: 'pending', deliveryEnabled: false,
      });
      expect(detail.targets).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'chat', displayName: '课题组', memberCount: 2 }), expect.objectContaining({ type: 'user', id: 'u3', displayName: '王五' })]));
      expect(detail.resources[0]).toMatchObject({ type: 'doc', displayName: '机密周报标题' });
      expect((await f.call('u2', 'GET', `/automation/drafts/${draft.draftId}`)).statusCode).toBe(404);

      const plain = await f.approve(draft);
      expect(plain.statusCode).toBe(403);
      expect(plain.json().code).toBe('TASK_DISABLED');
      const before = (await f.call('u1', 'GET', '/agent/triggers')).json();
      const revBefore = (before.items ?? before).find((t: { trigger_id: string }) => t.trigger_id === f.taskId).security_revision;
      const ok = await f.approve(draft, { enableTask: true });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ status: 'active', taskEnabled: true, deliveryEnabled: true });
      const afterList = (await f.call('u1', 'GET', '/agent/triggers')).json();
      const after = (afterList.items ?? afterList).find((t: { trigger_id: string }) => t.trigger_id === f.taskId);
      expect(after).toMatchObject({ enabled: true, security_revision: revBefore });
      const snap = (await f.sched('GET', `/tasks/trigger/${f.taskId}`)).json();
      expect(snap).toMatchObject({ deliveryReady: true, grant: { draftId: draft.draftId } });
      const detail2 = (await f.call('u1', 'GET', `/automation/drafts/${draft.draftId}`)).json();
      expect(detail2.permissions).toMatchObject({ canApprove: false, approveBlockedReasons: ['DRAFT_STALE'] });

      for (const enabled of [false, true]) expect((await f.call('u1', 'PATCH', `/agent/triggers/${f.taskId}`, { enabled })).statusCode).toBe(200);
      const snap2 = (await f.sched('GET', `/tasks/trigger/${f.taskId}`)).json();
      expect(snap2).toMatchObject({ enabled: true, grant: null, deliveryReady: false });
      const r = await f.sched('POST', '/runs', { taskKind: 'trigger', taskId: f.taskId, expectedTaskRevision: snap2.taskRevision, occurrenceId: minuteSlot() });
      expect(r.json().code).toBe('AUTHORIZATION_REQUIRED');
      const list = (await f.call('u1', 'GET', '/automation/drafts')).json();
      expect(list.items[0]).toMatchObject({ draftId: draft.draftId, status: 'active', deliveryEnabled: false });
    } finally { await f.app.close(); }
  });
});
