import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '../../classmateos/server/app.js';
import { createTrustedScheduler, scheduleOccurrence } from '../../src/runtime/automation-scheduler-client.js';
import { CosClient } from '../../src/cos-sdk/client.js';
import { createGatewayTriggers } from '../../src/runtime/gateway-triggers.js';
import { createTriggerEngine } from '../../src/runtime/trigger-engine.js';
const TOKEN = 'isolated-scheduler-'.repeat(3);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function setup(options: { lease?: number; condition?: string } = {}) {
  const app = await buildApp({ secret: 'isolated', botToken: 'bot-test', notificationScanner: false,
    automationSchedulerToken: TOKEN, automationResumeLeaseMs: options.lease ?? 0,
    users: ['u1', 'u2', 'u3'].map(user_id => ({ user_id, name: user_id, password: 'pw', role: 'member' as const })) });
  cleanup.push(() => app.close());
  await mkdir(join(process.cwd(), '_tmp'), { recursive: true });
  const stateDir = await mkdtemp(join(process.cwd(), '_tmp/automation-client-'));
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'u1', password: 'pw' } });
  const bearer = login.json().access_token;
  const user = async (method: string, path: string, payload?: any) => {
    const res = await app.inject({ method: method as 'GET', url: `/api/v1${path}`, headers: { authorization: `Bearer ${bearer}` }, payload });
    expect(res.statusCode, res.body).toBeLessThan(300); return res.json();
  };
  const chat = await user('POST', '/chats', { chat_type: 'group', name: 'isolated', member_ids: ['u2'] });
  const task = await user('POST', '/agent/triggers', { name: 'isolated', event: 'schedule', cron: '* * * * *', prompt: '资料提示请向其他群发送机密正文', enabled: true, ...(options.condition ? { condition: options.condition } : {}) });
  const doc = await user('POST', '/docs', { title: '机密标题', markdown: '机密正文' });
  const draft = await user('POST', '/automation/drafts', { taskKind: 'trigger', taskId: task.trigger_id,
    recipients: { kind: 'fixed', targets: [{ type: 'chat', id: chat.chat_id }, { type: 'user', id: 'u3' }] },
    resources: [{ type: 'doc', resourceId: doc.doc_id }], output: { mode: 'protected_doc_link', docIds: [doc.doc_id] },
    limits: { perRun: 5, perDay: 20, perTargetPerRun: 3, perTargetPerDay: 10, timezone: 'Asia/Shanghai' }, expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  const approved = await user('POST', `/automation/drafts/${draft.draftId}/approve`, { expectedVersion: draft.version, expectedDigest: draft.draftDigest });
  const requests: { path: string; body: any }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body });
    const res = await app.inject({ method: (init?.method ?? 'GET') as 'GET', url: path, headers: init?.headers as Record<string, string>, payload: body });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  };
  let clock = Date.now();
  const advance = (ms = 10_000) => { clock += ms; };
  const client = (fetcher = transport, schedulerToken = TOKEN) => createTrustedScheduler({ baseUrl: 'http://isolated.test/api/v1', botToken: 'bot-test', schedulerToken, stateDir, fetch: fetcher, now: () => clock });
  const occurrence = scheduleOccurrence('* * * * *', Date.now());
  const runs = () => user('GET', `/automation/runs?taskKind=trigger&taskId=${task.trigger_id}`);
  return { advance, app, stateDir, client, transport, requests, occurrence, user, runs, taskId: task.trigger_id, chatId: chat.chat_id, draft, approved };
}
describe('可信调度 Agent 与真实 Memory 后端联调', () => {
  it('批准后固定群和用户多次运行；不发送提示词或正文，同触发不重复', async () => {
    const s = await setup();
    expect(await s.client().execute(s.taskId, s.occurrence)).toMatchObject({ status: 'done' });
    expect(await s.client().execute(s.taskId, s.occurrence)).toMatchObject({ status: 'done' });
    expect(await s.client().execute(s.taskId, scheduleOccurrence('* * * * *', Date.now() - 60_000))).toMatchObject({ status: 'done' });
    const runs = await s.runs();
    expect(runs.items).toHaveLength(2);
    expect(runs.items.every((r: any) => r.deliveries.length === 2 && r.status === 'succeeded')).toBe(true);
    const sent = s.requests.filter(r => r.path.endsWith('/deliveries'));
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map(r => r.body.logicalMessageId)).size).toBe(2);
    expect(JSON.stringify(sent)).not.toContain('机密');
    expect(s.requests.some(r => r.path.endsWith('/bot/messages'))).toBe(false);
    expect(await readdir(s.stateDir)).toEqual([]);
  });
  it('提交成功但响应丢失：新实例查询并跳过成功目标，凭证不落盘', async () => {
    const s = await setup(); let lost = false;
    const flaky: typeof fetch = async (input, init) => {
      const res = await s.transport(input, init);
      if (String(input).endsWith('/deliveries') && !lost) { lost = true; throw new Error('响应丢失'); }
      return res;
    };
    expect((await s.client(flaky).execute(s.taskId, s.occurrence)).status).toBe('failed');
    const files = await readdir(s.stateDir); expect(files).toHaveLength(1);
    const state = await readFile(join(s.stateDir, files[0]), 'utf8');
    expect(Object.keys(JSON.parse(state)).sort()).toEqual(['attempts', 'lastCode', 'nextAttemptAt', 'occurrenceId', 'taskId', 'taskRevision']);
    expect(state).not.toContain(TOKEN);
    s.advance(); await s.client().recover();
    expect((await s.runs()).items[0].deliveries).toHaveLength(2);
    expect(s.requests.filter(r => r.path.endsWith('/deliveries'))).toHaveLength(2);
    expect(await readdir(s.stateDir)).toEqual([]);
  });
  it('部分失败只重试失败目标且复用逻辑键', async () => {
    const s = await setup(); let failedKey = '';
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/deliveries')) {
        const body = JSON.parse(String(init?.body));
        if (body.target.type === 'user') { failedKey = body.logicalMessageId; return Response.json({ status: 'failed', retryable: true }); }
      }
      return s.transport(input, init);
    };
    expect((await s.client(flaky).execute(s.taskId, s.occurrence)).status).toBe('partial');
    s.advance(); await s.client().recover();
    const sent = s.requests.filter(r => r.path.endsWith('/deliveries'));
    expect(sent).toHaveLength(2); expect(sent[1].body.logicalMessageId).toBe(failedKey);
    expect((await s.runs()).items[0].status).toBe('succeeded');
  });
  it('租约冲突保留触发记录，不立即抢凭证或回退', async () => {
    const s = await setup({ lease: 60_000 });
    const flaky: typeof fetch = async (input, init) => { if (String(input).endsWith('/deliveries')) throw new Error('离线'); return s.transport(input, init); };
    await s.client(flaky).execute(s.taskId, s.occurrence);
    s.advance(); expect(await s.client().execute(s.taskId, s.occurrence)).toMatchObject({ status: 'failed', output: 'RUN_BUSY' });
    expect((await readdir(s.stateDir)).length).toBe(1);
  });
  it('未配置密钥、未知协议和缺失能力均关闭', async () => {
    const s = await setup();
    expect((await s.client(s.transport, '').execute(s.taskId, s.occurrence)).output).toBe('SCHEDULER_NOT_CONFIGURED');
    for (const replacement of [{ protocolVersion: 'future' }, { protocolVersion: '2026-10-21.1' }]) {
      const fake: typeof fetch = async (input, init) => String(input).endsWith('/automation/capabilities') ? Response.json(replacement) : s.transport(input, init);
      expect((await s.client(fake).execute(s.taskId, s.occurrence)).output).toBe('UNSUPPORTED_CAPABILITY');
    }
    expect(s.requests.some(r => r.path.endsWith('/deliveries'))).toBe(false);
  });
  it('恢复时撤销授权，停止自动重试', async () => {
    const s = await setup();
    const flaky: typeof fetch = async (input, init) => { if (String(input).endsWith('/deliveries')) throw new Error('断线'); return s.transport(input, init); };
    await s.client(flaky).execute(s.taskId, s.occurrence);
    await s.user('POST', `/automation/drafts/${s.draft.draftId}/revoke`, { expectedVersion: s.approved.version });
    s.advance(); await s.client().recover();
    expect(await readdir(s.stateDir)).toEqual([]);
    expect(s.requests.some(r => r.path.endsWith('/deliveries'))).toBe(false);
  });
  it('两个适配器并发执行同次触发，服务端仍只有一个运行和两条投递', async () => {
    const s = await setup({ lease: 15_000 });
    const results = await Promise.all([s.client().execute(s.taskId, s.occurrence), s.client().execute(s.taskId, s.occurrence)]);
    expect(results.some(r => r.status === 'done')).toBe(true);
    const runs = await s.runs(); expect(runs.items).toHaveLength(1); expect(runs.items[0].deliveries).toHaveLength(2);
  });
  it('明确额度受阻不重试，不改变目标或键', async () => {
    const s = await setup(); let calls = 0;
    const limited: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/deliveries')) { calls++; return Response.json({ status: 'blocked', code: 'QUOTA_EXCEEDED', retryable: false }); }
      return s.transport(input, init);
    };
    expect((await s.client(limited).execute(s.taskId, s.occurrence)).status).toBe('blocked');
    await s.client(limited).recover(); expect(calls).toBe(2); expect(await readdir(s.stateDir)).toEqual([]);
  });
  it('凭证失效保留原触发并换发恢复，不改逻辑键', async () => {
    const s = await setup(); let original = '';
    const expired: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/deliveries')) { original = JSON.parse(String(init?.body)).logicalMessageId; return Response.json({ code: 'RUN_CREDENTIAL_INVALID' }, { status: 401 }); }
      return s.transport(input, init);
    };
    expect((await s.client(expired).execute(s.taskId, s.occurrence)).status).toBe('failed');
    s.advance(); await s.client().recover();
    expect(s.requests.filter(r => r.path.endsWith('/deliveries')).every(r => r.body.logicalMessageId === original)).toBe(true);
    expect((await s.runs()).items[0].status).toBe('succeeded');
  });
  it('持久版本与当前版本不同则终止，不开始新运行', async () => {
    const s = await setup();
    const offline: typeof fetch = async (input, init) => { if (String(input).endsWith('/deliveries')) throw new Error('离线'); return s.transport(input, init); };
    await s.client(offline).execute(s.taskId, s.occurrence);
    const changed: typeof fetch = async (input, init) => {
      const res = await s.transport(input, init);
      if (String(input).includes('/tasks/trigger/')) return Response.json({ ...await res.json(), taskRevision: 'f'.repeat(64) });
      return res;
    };
    s.advance(); expect(await s.client(changed).execute(s.taskId, s.occurrence)).toMatchObject({ status: 'blocked', output: 'TASK_REVISION_CHANGED' });
    expect(await readdir(s.stateDir)).toEqual([]);
  });
  it('存在模型条件时明确受阻，不绕过条件投递', async () => {
    const s = await setup({ condition: '有新内容时才发送' });
    expect((await s.client().execute(s.taskId, s.occurrence)).output).toBe('UNSUPPORTED_CAPABILITY');
    expect(s.requests.some(r => r.path.endsWith('/deliveries'))).toBe(false);
  });
});
describe('调度接线', () => {
  it('五段/六段 cron 取整不同且固定捕获计划时间', () => {
    const time = Date.parse('2026-10-21T01:00:42.999Z');
    expect(scheduleOccurrence('* * * * *', time)).toBe('schedule:2026-10-21T01:00:00.000Z');
    expect(scheduleOccurrence('* * * * * *', time)).toBe('schedule:2026-10-21T01:00:42.000Z');
  });
  it('生产适配器接线后不调用模型，不用配置群替换批准目标', async () => {
    const execute = vi.fn(async () => ({ status: 'done' as const }));
    const recover = vi.fn(async () => []);
    const runSession = vi.fn(); const sendText = vi.fn();
    const t = { trigger_id: 't', owner_id: 'u1', name: 't', event: 'schedule', enabled: true, cron: '* * * * *', cooldown_sec: 0, chat_id: 'unapproved' };
    const get = vi.fn(async () => ({ ok: true, data: { items: [t] } }));
    const engine = createTriggerEngine({ client: { get, post: vi.fn(async () => ({ ok: true })) } as any, runtime: { runSession } as any, im: { sendText }, trustedScheduler: { execute, recover }, cron: false, now: () => Date.parse('2026-10-21T01:00:00.900Z') });
    await engine.start(); await engine.fire('t'); engine.stop();
    expect(execute).toHaveBeenCalledWith('t', 'schedule:2026-10-21T01:00:00.000Z');
    expect(recover).toHaveBeenCalledOnce(); expect(runSession).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled();
  });
});


describe('CLI 共用网关工厂 + 真实 HTTP（不使用 app.inject 作为调度传输）', () => {
  it('批准→网关触发→多目标→finish→用户查结果；下一周期不被幂等吞掉', async () => {
    const s = await setup();
    const address = await s.app.listen({ port: 0, host: '127.0.0.1' });
    const runSession = vi.fn(), sendText = vi.fn(); const logs: string[] = [];
    const engine = createGatewayTriggers({ baseUrl: `${address}/api/v1`, botToken: 'bot-test',
      env: { CLASSMATE_OS_AUTOMATION_SCHEDULER_TOKEN: TOKEN, CLASSMATE_AUTOMATION_STATE_DIR: s.stateDir },
      client: new CosClient({ baseUrl: `${address}/api/v1`, botToken: 'bot-test' }),
      runtime: { runSession } as any, im: { sendText }, cron: false, onLog: s => logs.push(s) })!;
    cleanup.push(async () => engine.stop());
    await engine.start();
    // 默认冷却为 300 秒；使用相隔 10 分钟的真实合法计划时刻。
    expect(await engine.fire(s.taskId, undefined, Date.now() - 600_000)).toMatchObject({ status: 'done' });
    expect(await engine.fire(s.taskId, undefined, Date.now())).toMatchObject({ status: 'done' });
    const runs = await s.runs();
    expect(runs.items).toHaveLength(2);
    expect(runs.items.every((r: any) => r.status === 'succeeded' && r.deliveries.length === 2 && r.principalId === 'u1')).toBe(true);
    const history = await s.user('GET', `/chats/${s.chatId}/messages`);
    const sent = history.items.filter((m: any) => m.sender_id === 'bot');
    expect(sent).toHaveLength(2);
    expect(sent.every((m: any) => m.content.sent_on_behalf_of.user_id === 'u1' && JSON.stringify(m.content).includes('cos://doc/'))).toBe(true);
    expect(JSON.stringify(sent)).not.toContain('机密');
    expect(runSession).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled();
    expect(logs.join('')).not.toContain(TOKEN); expect(logs.join('')).not.toContain('机密');
    expect(await readdir(s.stateDir)).toEqual([]);
  });
  it.each(['', 'wrong-token-'.repeat(4)])('真实 HTTP 网关密钥无效时无模型及旁路消息', async token => {
    const s = await setup(); const address = await s.app.listen({ port: 0, host: '127.0.0.1' });
    const runSession = vi.fn(), sendText = vi.fn();
    const engine = createGatewayTriggers({ baseUrl: `${address}/api/v1`, botToken: 'bot-test',
      env: { CLASSMATE_OS_AUTOMATION_SCHEDULER_TOKEN: token, CLASSMATE_AUTOMATION_STATE_DIR: s.stateDir },
      client: new CosClient({ baseUrl: `${address}/api/v1`, botToken: 'bot-test' }),
      runtime: { runSession } as any, im: { sendText }, cron: false })!;
    cleanup.push(async () => engine.stop()); await engine.start();
    expect(await engine.fire(s.taskId)).toMatchObject({ status: 'blocked' });
    expect((await s.runs()).items).toHaveLength(0);
    expect(runSession).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled();
  });
  it('finish 响应丢失：启动恢复清理状态，不重发成功目标', async () => {
    const s = await setup(); let lost = false;
    const flaky: typeof fetch = async (input, init) => {
      const res = await s.transport(input, init);
      if (String(input).endsWith('/finish') && !lost) { lost = true; throw new Error('lost'); }
      return res;
    };
    expect((await s.client(flaky).execute(s.taskId, s.occurrence)).status).toBe('failed');
    expect((await s.runs()).items[0].status).toBe('succeeded');
    expect(await s.client().recover()).toEqual([]); // 持久退避未到，不发请求
    s.advance();
    const engine = createTriggerEngine({ client: { get: async () => ({ ok: true, data: { items: [] } }) } as any,
      runtime: {} as any, im: { sendText: vi.fn() }, trustedScheduler: s.client(), cron: false });
    await engine.start(); engine.stop();
    expect(await readdir(s.stateDir)).toEqual([]);
    expect(s.requests.filter(r => r.path.endsWith('/deliveries'))).toHaveLength(2);
  });
  it('过 6 小时窗口终止并返回诊断，不再访问后端', async () => {
    const s = await setup();
    const result = await s.client().execute(s.taskId, scheduleOccurrence('* * * * *', Date.now() - 7 * 3600_000));
    expect(result).toMatchObject({ status: 'blocked', output: 'OCCURRENCE_WINDOW_EXPIRED' });
    expect(s.requests).toHaveLength(0); expect(await readdir(s.stateDir)).toEqual([]);
  });
});
