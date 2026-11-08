/**
 * 自动化预授权 v2 端到端（后端内部）：真实触发器 + 真实审批接口 + 后端装配好的投递服务。
 * 签发凭证还没有 HTTP 入口（等独立调度器鉴权），这里直接用 app.automationServices 代替可信调度器。
 * Memory 必跑；设置 CLASSMATEOS_TEST_PG_URL 时在 PostgreSQL 上同样跑（会清空该库）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import type { BotEvent } from '../../classmateos/server/events.js';

const PG_URL = process.env.CLASSMATEOS_TEST_PG_URL;
let pool: pg.Pool | undefined;
afterAll(async () => { await pool?.end(); });
const backends = [{ name: 'memory', usePg: false }, ...(PG_URL ? [{ name: 'postgres', usePg: true }] : [])];

describe.each(backends)('自动化投递端到端（$name）', ({ usePg }) => {
  async function setup() {
    const o: AppOptions = {
      secret: 'test-only', botToken: 'test-bot', notificationScanner: false,
      users: [['u1', '张三'], ['u2', '李四'], ['u3', '王五']].map(([user_id, name]) => ({ user_id, name, password: 'pw', role: 'member' as const })),
    };
    if (usePg) {
      pool ??= new pg.Pool({ connectionString: PG_URL, max: 5 });
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
    const events: BotEvent[] = [];
    (app as unknown as { cos: { ctx: { eventBus: { subscribe(fn: (e: BotEvent) => void): void } } } }).cos.ctx.eventBus.subscribe((e) => events.push(e));
    const chatId = (await call('u1', 'POST', '/chats', { chat_type: 'group', name: '课题组', member_ids: ['u2'] })).json().chat_id as string;
    const trigger = await call('u1', 'POST', '/agent/triggers', { name: '日报', event: 'schedule', cron: '0 9 * * *', prompt: '整理日报' });
    expect(trigger.statusCode, trigger.body).toBe(201);
    const taskId = trigger.json().trigger_id as string;
    const docId = (await call('u1', 'POST', '/docs', { title: '机密周报标题', markdown: '正文不应外发' })).json().doc_id as string;
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
    return { app, call, events, chatId, taskId, docId, draft, services, issue };
  }

  it('审批后可按授权发到固定群和固定用户，接收者通过普通消息接口看到代发标记，正文不含文档标题', async () => {
    const f = await setup();
    try {
      const ctx = await f.issue();
      const toChat = await f.services.delivery.deliver(ctx, { logicalMessageId: 'daily-1', target: { type: 'chat', id: f.chatId }, payload: { mode: 'protected_doc_link', docId: f.docId } });
      expect(toChat, JSON.stringify(toChat)).toMatchObject({ status: 'sent', duplicate: false });
      const seen = (await f.call('u2', 'GET', `/chats/${f.chatId}/messages`)).json().items as Array<{ message_id: string; sender_id: string; content: Record<string, unknown> }>;
      const msg = seen.find(m => m.message_id === toChat.messageId)!;
      expect(msg.sender_id).toBe('bot');
      expect(msg.content).toMatchObject({ sent_on_behalf_of: { user_id: 'u1', name: '张三' }, agent_result: { links: [{ link: `cos://doc/${f.docId}` }] } });
      expect(JSON.stringify(msg.content)).not.toContain('机密周报标题');
      expect(JSON.stringify(msg.content)).not.toContain(ctx.sendCredential);
      expect(f.events.some(e => e.event_type === 'message.receive' && JSON.stringify(e).includes(toChat.messageId!))).toBe(true);

      const toUser = await f.services.delivery.deliver(ctx, { logicalMessageId: 'daily-1', target: { type: 'user', id: 'u3' }, payload: { mode: 'protected_doc_link', docId: f.docId } });
      expect(toUser.status).toBe('sent');
      const dm = (await f.call('u3', 'GET', `/chats/${toUser.message!.chat_id}/messages`)).json().items as Array<{ message_id: string }>;
      expect(dm.map(m => m.message_id)).toContain(toUser.messageId);
      // 未被授权的 u3 仍按原有 ACL：不会因为收到链接就能读文档
      expect((await f.call('u3', 'GET', `/docs/${f.docId}`)).statusCode).toBe(403);
    } finally { await f.app.close(); }
  });

  it('改过触发器（哪怕又改回原样）后，已签发的凭证不能再发送；能力开关仍然关闭', async () => {
    const f = await setup();
    try {
      const ctx = await f.issue();
      for (const prompt of ['改成周报', '整理日报']) expect((await f.call('u1', 'PATCH', `/agent/triggers/${f.taskId}`, { prompt })).statusCode).toBe(200);
      const r = await f.services.delivery.deliver(ctx, { logicalMessageId: 'after-edit', target: { type: 'chat', id: f.chatId }, payload: { mode: 'protected_doc_link', docId: f.docId } });
      expect(r).toMatchObject({ status: 'blocked', code: 'TASK_REVISION_CHANGED' });
      await expect(f.issue()).rejects.toThrow('TASK_REVISION_CHANGED');
      const caps = (await f.call('u1', 'GET', '/automation/capabilities')).json();
      expect(caps).toMatchObject({ fixedTargetDelivery: false, scheduler: false, aiText: false });
    } finally { await f.app.close(); }
  });
});
