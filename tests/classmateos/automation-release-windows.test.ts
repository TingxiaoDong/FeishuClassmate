/**
 * 自动化预授权 v2 · 发布前已知窗口（B-R03）。
 * 1. 提交时复核：事务前检查通过后、提交前被收回权限（文档权限 / 执行身份 / 收件用户），投递必须被拦。
 *    另外直接验证权限围栏：投递持有围栏时，收回权限类写操作必须等待；反过来也一样（PG）。
 * 2. 发给用户被拦时，不推送新建的机器人单聊。
 * 4. 同一逻辑消息 A 运行被拦、B 运行补发：A 运行仍显示自己的“被拦”，并附后续结果。
 * Memory 必跑；设置 CLASSMATEOS_TEST_PG_URL 时在 PostgreSQL 上同样跑（会清空该库）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import { AUTOMATION_ACL_FENCE_KEY, type AutomationDeliveryCommit } from '../../classmateos/server/automation-delivery-core.js';
import type { Repo } from '../../classmateos/server/repo.js';
import type { BotEvent } from '../../classmateos/server/events.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
let pool: pg.Pool | undefined;
afterAll(async () => { await pool?.end(); });
const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe.each(backends)('自动化发布前窗口（$name）', ({ usePg }) => {
  async function setup() {
    const o: AppOptions = {
      secret: 'test-only', botToken: 'test-bot', notificationScanner: false,
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
    const cos = (app as unknown as { cos: { ctx: { repo: Repo; eventBus: { subscribe(fn: (e: BotEvent) => void): void } } } }).cos.ctx;
    const events: BotEvent[] = [];
    cos.eventBus.subscribe((e) => events.push(e));
    const chatId = (await call('u1', 'POST', '/chats', { chat_type: 'group', name: '课题组', member_ids: ['u2'] })).json().chat_id as string;
    const taskId = (await call('u1', 'POST', '/agent/triggers', { name: '日报', event: 'schedule', cron: '0 9 * * *', prompt: '整理日报' })).json().trigger_id as string;
    // 文档属于 u2，只分享给 u1（查看）；不开链接分享。这样 u2 可以随时收回 u1 的权限。
    const docId = (await call('u2', 'POST', '/docs', { title: '李四的周报', markdown: '正文' })).json().doc_id as string;
    const shared = await call('u2', 'PUT', `/docs/${docId}/permissions`, { link_share: 'off', members: [{ member_type: 'user', member_id: 'u1', role: 'viewer' }] });
    expect(shared.statusCode, shared.body).toBe(200);
    const draftRes = await call('u1', 'POST', '/automation/drafts', {
      taskKind: 'trigger', taskId, recipients: { kind: 'fixed', targets: [{ type: 'chat', id: chatId }, { type: 'user', id: 'u3' }] },
      resources: [{ type: 'doc', resourceId: docId }], output: { mode: 'protected_doc_link', docIds: [docId] },
      limits: { perRun: 5, perDay: 10, perTargetPerRun: 5, perTargetPerDay: 10, timezone: 'Asia/Shanghai' }, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(draftRes.statusCode, draftRes.body).toBe(201);
    const draft = draftRes.json();
    const approved = await call('u1', 'POST', `/automation/drafts/${draft.draftId}/approve`, { expectedVersion: draft.version, expectedDigest: draft.draftDigest });
    expect(approved.statusCode, approved.body).toBe(200);
    const services = app.automationServices;
    const issue = () => services.credentials.issue(draft.draftId, draft.spec.taskRevision);
    const repo = cos.repo;
    /** 在事务前检查之后、存储层提交之前插入一个动作（模拟恰好落在窗口里的撤权）。 */
    const betweenCheckAndCommit = (fn: () => Promise<unknown>) => {
      const orig = repo.commitAutomationDelivery.bind(repo);
      let fired = false;
      repo.commitAutomationDelivery = async (input) => { if (!fired) { fired = true; await fn(); } return orig(input); };
      return () => { repo.commitAutomationDelivery = orig; };
    };
    const botMessages = async (u: string, chat: string) => ((await call(u, 'GET', `/chats/${chat}/messages`)).json().items as Array<{ sender_id: string }>).filter(m => m.sender_id === 'bot');
    const docLink = (logicalMessageId: string, target: { type: 'chat' | 'user'; id: string }) => ({ logicalMessageId, target, payload: { mode: 'protected_doc_link' as const, docId } });
    return { app, call, events, chatId, taskId, docId, draft, services, issue, repo, betweenCheckAndCommit, botMessages, docLink, shareVersion: shared.json().version as number };
  }

  it('B-R03-1：事务前检查后、提交前收回执行人的文档权限，投递被拦，群里没有消息', async () => {
    const f = await setup();
    try {
      const ctx = await f.issue();
      const restore = f.betweenCheckAndCommit(async () => {
        const r = await f.call('u2', 'PUT', `/docs/${f.docId}/permissions`, { link_share: 'off', members: [], version: f.shareVersion });
        expect(r.statusCode, r.body).toBe(200);
      });
      const out = await f.services.delivery.deliver(ctx, f.docLink('w1', { type: 'chat', id: f.chatId }));
      restore();
      expect(out).toMatchObject({ status: 'blocked', code: 'PERMISSION_DENIED', retryable: false });
      expect(await f.botMessages('u2', f.chatId)).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it('B-R03-1：提交前执行人被停用 / 收件用户被停用，投递都被拦；发给用户被拦时不推送新建单聊', async () => {
    const f = await setup();
    try {
      const ctx = await f.issue();
      const mark = f.events.length;
      let restore = f.betweenCheckAndCommit(() => f.repo.updateUser('u3', { disabled: true }));
      const toUser = await f.services.delivery.deliver(ctx, f.docLink('w2', { type: 'user', id: 'u3' }));
      restore();
      expect(toUser).toMatchObject({ status: 'blocked', code: 'PERMISSION_DENIED' });
      expect(f.events.slice(mark).some(e => e.event_type === 'chat.created')).toBe(false);
      await f.repo.updateUser('u3', { disabled: false });

      restore = f.betweenCheckAndCommit(() => f.repo.updateUser('u1', { disabled: true }));
      const toChat = await f.services.delivery.deliver(ctx, f.docLink('w3', { type: 'chat', id: f.chatId }));
      restore();
      expect(toChat.status).toBe('blocked');
      expect(['PRINCIPAL_INVALID', 'PERMISSION_DENIED']).toContain(toChat.code);
      expect(await f.botMessages('u2', f.chatId)).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it('B-R03-1：投递持有权限围栏时，收回权限类写操作必须等它提交后才能执行', async () => {
    const f = await setup();
    try {
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      let rechecking!: () => void;
      const entered = new Promise<void>(r => { rechecking = r; });
      // 构造一条凭证不匹配的提交：复核期间卡住，之后在判定阶段被拒（不写记录）。
      const input = {
        grantKind: 'automation_authorization_v2', draftId: 'x', grantId: 'x', runKind: 'automation_run_v2', runId: 'x', credentialHash: 'x',
        task: { kind: 'agent_trigger', id: 'x', expectedRevision: 'x', revisionOf: () => 'x' }, memberCheck: null, deliveryKey: 'fence-test', payloadDigest: 'x',
        targetKey: 'chat:x', dayKey: '2026-10-21', limits: { perRun: 1, perDay: 1, perTargetPerRun: 1, perTargetPerDay: 1 }, blockedCode: null, message: null, record: {}, nowMs: Date.now(),
        recheck: async () => { rechecking(); await gate; return null; },
      } satisfies AutomationDeliveryCommit;
      const commit = f.repo.commitAutomationDelivery(input);
      await entered;
      const order: string[] = [];
      const writes = [
        f.repo.updateUser('u3', { title: '围栏测试' }).then(() => order.push('updateUser')),
        f.repo.removeMember(f.chatId, 'u2').then(() => order.push('removeMember')),
        f.repo.saveEntity({ kind: 'doc_trash', id: 'fence-doc', scope: 'global', data: {}, version: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, 0).then(() => order.push('trash')),
        f.repo.getResourceGrant('doc', f.docId).then(g => f.repo.saveResourceGrant({ ...g!, members: [] }, g!.version)).then(() => order.push('grant')),
      ];
      await sleep(150);
      order.push('released');
      release();
      expect(await commit).toEqual({ status: 'rejected', code: 'RUN_CREDENTIAL_INVALID' });
      await Promise.all(writes);
      expect(order[0]).toBe('released');
      expect(order).toHaveLength(5);
      // 普通读和与权限无关的写不受围栏影响
      expect((await f.repo.getUser('u3'))?.title).toBe('围栏测试');
    } finally { await f.app.close(); }
  });

  it.runIf(usePg)('B-R03-1（PG）：收回权限的写事务进行中时，投递等它提交，并看到收回后的结果', async () => {
    const f = await setup();
    try {
      const ctx = await f.issue();
      const c = await pool!.connect();
      try {
        // 模拟一个已经拿到共享围栏、正在收回权限的写事务
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [AUTOMATION_ACL_FENCE_KEY]);
        await c.query(`UPDATE cos_resource_grants SET data = jsonb_set(data, '{members}', '[]'::jsonb), version = version + 1 WHERE resource_type='doc' AND resource_id=$1`, [f.docId]);
        let settled = false;
        const pending = f.services.delivery.deliver(ctx, f.docLink('pg-fence', { type: 'chat', id: f.chatId })).finally(() => { settled = true; });
        await sleep(300);
        expect(settled).toBe(false);
        await c.query('COMMIT');
        expect(await pending).toMatchObject({ status: 'blocked', code: 'PERMISSION_DENIED' });
      } finally { c.release(); }
      expect(await f.botMessages('u2', f.chatId)).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it('B-R03-4：A 运行被拦、B 运行用同一逻辑消息补发成功后，A 运行仍显示被拦并附后续结果', async () => {
    const f = await setup();
    try {
      const a = await f.issue();
      await f.repo.removeMember(f.chatId, 'u1');
      expect(await f.services.delivery.deliver(a, f.docLink('same', { type: 'chat', id: f.chatId }))).toMatchObject({ status: 'blocked' });
      await f.repo.addMembers(f.chatId, ['u1'], new Date().toISOString());
      const b = await f.issue();
      const sent = await f.services.delivery.deliver(b, f.docLink('same', { type: 'chat', id: f.chatId }));
      expect(sent.status).toBe('sent');
      await f.services.credentials.finish(a);
      await f.services.credentials.finish(b);
      const viewA = (await f.call('u1', 'GET', `/automation/runs/${a.runId}`)).json();
      const viewB = (await f.call('u1', 'GET', `/automation/runs/${b.runId}`)).json();
      expect(viewA.status).toBe('blocked');
      expect(viewA.deliveries).toHaveLength(1);
      expect(viewA.deliveries[0]).toMatchObject({ status: 'blocked', messageId: null, laterAttempt: { runId: b.runId, status: 'sent', messageId: sent.messageId } });
      expect(viewB.status).toBe('succeeded');
      expect(viewB.deliveries[0]).toMatchObject({ status: 'sent', messageId: sent.messageId, laterAttempt: null });
      // 列表里两条运行各自的状态也一致（内部 issue() 建的运行不带任务字段，所以不按任务筛选）
      const list = (await f.call('u1', 'GET', '/automation/runs')).json().items as Array<{ runId: string; status: string }>;
      expect(Object.fromEntries(list.filter(r => [a.runId, b.runId].includes(r.runId)).map(r => [r.runId, r.status]))).toEqual({ [a.runId]: 'blocked', [b.runId]: 'succeeded' });
    } finally { await f.app.close(); }
  });
});
