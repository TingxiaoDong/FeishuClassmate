import { describe, it, expect, vi } from 'vitest';
import { beginAutomation, deliverAutomation, automationRequest, automationToolCode, executionCode, type AutomationBackend, type AutomationTask, type AutomationRun } from '../../src/runtime/automation-execution.js';
import { ClassmateRuntime } from '../../src/runtime/agent-runtime.js';
import { CosClient } from '../../src/cos-sdk/client.js';
import { registerCosResourceTools, botSend } from '../../src/tools/cos/resources.js';
import { registerCosTaskTools } from '../../src/tools/cos/tasks.js';
import { sendAllowed } from '../../src/tools/cos/define.js';
import { runScheduledAutomation } from '../../src/runtime/scheduler.js';
import { createTriggerEngine, type Trigger } from '../../src/runtime/trigger-engine.js';
import { createFakeConfig } from '../helpers/fake-config.js';
const task: AutomationTask = { taskKind: 'trigger', taskId: 't', taskRevision: 'v1', principalId: 'alice', occurrenceId: 'occ1' };
const target = { type: 'chat_id' as const, id: 'approved' };
function fixture(overrides: Partial<AutomationRun> = {}) {
  const deliver = vi.fn().mockResolvedValue({ status: 'sent', messageId: 'msg1' });
  const request = vi.fn().mockImplementation(async (_m, path) => ({ ok: true, status: 200, data: path === '/users' ? { items: [{ user_id: 'bob', name: 'Bob' }] } : { doc_id: 'doc1', user_id: 'alice', name: 'Alice', items: [] } }));
  const backend: AutomationBackend = { begin: vi.fn(async t => ({ ok: true as const, run: { task: t, runId: 'run1', grantId: 'g1', scope: 'bot.messages.send' as const, expiresAt: Date.now() + 60000, targets: [target, { type: 'user_id', id: 'bob' }], outputMode: 'controlled_summary' as const, request, deliver, ...overrides } })) };
  return { backend, request, deliver };
}
const client = new CosClient({ baseUrl: 'http://invalid.test/api/v1', botToken: 'never-used', fetchImpl: vi.fn(() => { throw new Error('ordinary client must not be called'); }) as any });
function runtime() {
  const rt = new ClassmateRuntime({ llm: { chat: async () => ({ content: 'done', toolCalls: [] }) } });
  registerCosResourceTools(rt, client); registerCosTaskTools(rt, client); return rt;
}
describe('Agent 自动化预授权（隔离适配器）', () => {
  it('默认关闭、伪造句柄及跨任务运行失败', async () => {
    expect(executionCode(await beginAutomation(task))).toBe('AUTHORIZATION_PENDING');
    expect(executionCode({ kind: 'automation' })).toBe('RUN_INVALID');
    const f = fixture({ task: { ...task, taskId: 'other' } });
    expect(executionCode(await beginAutomation(task, f.backend))).toBe('RUN_INVALID');
  });
  it.each(['GRANT_REVOKED', 'GRANT_EXPIRED', 'TASK_REVISION_CHANGED', 'PRINCIPAL_INVALID', 'TASK_DISABLED'])('后端拒绝 %s 不外发', async code => {
    const e = await beginAutomation(task, { begin: async () => ({ ok: false, code }) });
    expect(await deliverAutomation(e, target, 'm')).toMatchObject({ status: 'blocked', code });
  });
  it('固定目标可多次运行，不包含凭证或模型正文', async () => {
    const f = fixture();
    for (const occurrenceId of ['1', '2']) {
      const e = await beginAutomation({ ...task, occurrenceId }, f.backend);
      expect(JSON.stringify(e)).toBe('{"kind":"automation"}');
      const r = await botSend(client, { execution: e, actor: { userId: 'alice', chatId: 'different' }, sessionId: 's', toolCallId: 'c' }, { chat_id: 'approved' }, '机密模型正文');
      expect(r.ok).toBe(true);
    }
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.deliver.mock.calls)).not.toContain('机密');
  });
  it('配置当前群也不能越界，身份不符也不放行', async () => {
    const f = fixture(); const e = await beginAutomation(task, f.backend);
    expect(sendAllowed({ execution: e, actor: { userId: 'alice', chatId: 'evil' } }, { chat_id: 'evil' }).ok).toBe(false);
    expect(await deliverAutomation(e, target, 'm', 'business', 'mallory')).toMatchObject({ code: 'PRINCIPAL_MISMATCH' });
    expect(await deliverAutomation(e, { ...target, id: 'evil' }, 'm')).toMatchObject({ code: 'TARGET_OUT_OF_SCOPE' });
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it('并发/重试使用同一逻辑 ID；已成功不重发，最终总结不追加', async () => {
    const f = fixture(); const e = await beginAutomation(task, f.backend);
    await Promise.all([deliverAutomation(e, target, 'm'), deliverAutomation(e, target, 'm')]);
    await deliverAutomation(e, target, 'm'); await deliverAutomation(e, target, 'final', 'final');
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it('仅重试可重试失败，后端额度拒绝不重试', async () => {
    const f = fixture(); f.deliver.mockResolvedValueOnce({ status: 'failed', code: 'TEMPORARY', retryable: true });
    const e = await beginAutomation(task, f.backend);
    await deliverAutomation(e, target, 'm'); await deliverAutomation(e, target, 'm');
    expect(f.deliver.mock.calls.map(c => c[0].logicalMessageId)).toEqual(['m', 'm']);
    f.deliver.mockResolvedValue({ status: 'blocked', code: 'QUOTA_EXCEEDED' });
    await deliverAutomation(e, target, 'm2'); await deliverAutomation(e, target, 'm2');
    expect(f.deliver).toHaveBeenCalledTimes(3);
  });
  it('读取隔离缺失、任意请求、邮件、公开权限、加急被阻止', async () => {
    const f = fixture(); const e = await beginAutomation(task, f.backend);
    for (const name of ['cos_api', 'cos_drive', 'cos_notify', 'send_email', 'temi_move']) expect(automationToolCode(e, name, 'alice')).toBe('AUTOMATION_TOOL_BLOCKED');
    for (const path of ['/docs/d/permissions', '/messages/m/urgent', '/messages/forward']) expect((await automationRequest(e, 'POST', path)).ok).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    const noRead = await beginAutomation(task, fixture({ request: undefined }).backend);
    expect(automationToolCode(noRead, 'cos_doc', 'alice')).toBe('READ_SCOPE_UNAVAILABLE');
  });
  it('统一工具策略：后台广播不被20人阈值拦截，删除仍确认', async () => {
    const rt = runtime(); const e = await beginAutomation(task, fixture().backend);
    const ctx = { execution: e, actor: { userId: 'alice' }, toolCallId: 'c', sessionId: 's' };
    expect(rt.getTool('cos_broadcast')!.policy!.needsConfirm!({ people: Array(30).fill('Bob'), text: 'x' }, 'write', ctx)).toBe(false);
    expect(rt.getTool('cos_doc')!.policy!.needsConfirm!({ action: 'delete', doc_id: 'd' }, 'destructive', ctx)).toBe(true);
    expect(rt.getTool('cos_im')!.policy!.needsConfirm!({ action: 'send', chat_id: 'approved', text: 'x' }, 'write', ctx)).toBe(false);
    expect(rt.getTool('cos_im')!.policy!.needsConfirm!({ action: 'send', chat_id: 'approved', text: 'x' }, 'write', { ...ctx, execution: undefined })).toBe(true);
  });
  it('写文档成功与分享受阻分别记录，不借普通 client 外发', async () => {
    const f = fixture(); const e = await beginAutomation(task, f.backend); const rt = runtime();
    const result: any = await rt.getTool('cos_write_doc')!.execute({ title: '报告', markdown: '正文', share_chat_id: 'evil' }, { execution: e, actor: { userId: 'alice' }, toolCallId: 'doc', sessionId: 's' });
    expect(result.data).toMatchObject({ created: true, doc_id: 'doc1' });
    expect(result.data.deliveries[0].delivery).toMatchObject({ status: 'blocked', code: 'TARGET_OUT_OF_SCOPE' });
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it('独立 scheduler 无授权不运行，有授权最终输出使用受控投递', async () => {
    const config = createFakeConfig(); config.labInfo.broadcastChatId = 'approved';
    const rt = { runSession: vi.fn().mockResolvedValue({ output: '私密正文' }) } as any;
    const opts = { runtime: rt, config, task: { prompt: '报告' }, jobId: 'weekly', principalId: 'alice', occurrenceId: '1' };
    expect((await runScheduledAutomation(opts)).status).toBe('blocked'); expect(rt.runSession).not.toHaveBeenCalled();
    const f = fixture(); expect((await runScheduledAutomation({ ...opts, backend: f.backend })).status).toBe('done');
    expect(rt.runSession.mock.calls[0][0].actor.chatId).toBeUndefined();
    expect(JSON.stringify(f.deliver.mock.calls)).not.toContain('私密正文');
  });
  it('trigger 最终输出不调用纯 bot sendText，状态不含正文', async () => {
    const t: Trigger = { trigger_id: 't', owner_id: 'alice', name: '测试', event: 'schedule', filter: {}, cron: '* * * * *', condition: null, prompt: '报告', chat_id: 'approved', enabled: true, cooldown_sec: 0 };
    const post = vi.fn().mockResolvedValue({ ok: true, data: {} }); const sendText = vi.fn();
    const f = fixture(); const rt = { runSession: vi.fn().mockResolvedValue({ output: '私密正文' }) } as any;
    const engine = createTriggerEngine({ client: { get: vi.fn().mockResolvedValue({ ok: true, data: { items: [t] } }), post } as any, runtime: rt, im: { sendText } as any, automationBackend: f.backend, cron: false });
    await engine.start(); expect((await engine.fire('t'))?.status).toBe('done'); engine.stop();
    expect(sendText).not.toHaveBeenCalled(); expect(f.deliver).toHaveBeenCalledOnce();
    expect(JSON.stringify(post.mock.calls)).not.toContain('私密正文');
  });
  it('模型换工具调用编号不会在同一运行重复创建文档', async () => {
    const f = fixture(); const e = await beginAutomation(task, f.backend); const rt = runtime();
    const args = { title: '报告', markdown: '正文', share_chat_id: 'approved' };
    for (const id of ['call1', 'call2']) await rt.getTool('cos_write_doc')!.execute(args, { execution: e, actor: { userId: 'alice' }, toolCallId: id, sessionId: 's' });
    expect(f.request.mock.calls.filter(c => c[0] === 'POST' && c[1] === '/docs')).toHaveLength(1);
    expect(f.deliver).toHaveBeenCalledOnce();
  });
  it('模型伪造 execution 参数不能使交互会话取得授权', async () => {
    let turn = 0;
    const rt = new ClassmateRuntime({ llm: { chat: async () => ++turn === 1 ? { content: '', toolCalls: [{ id: 'fake', name: 'cos_im', arguments: JSON.stringify({ action: 'send', chat_id: 'approved', text: 'x', execution: { kind: 'automation', grantId: 'g1', runId: 'run1' } }) }] } : { content: 'done', toolCalls: [] } } });
    registerCosResourceTools(rt, client);
    const res = await rt.runSession({ messages: [{ role: 'user', content: 'x' }], actor: { userId: 'alice' } });
    const reply = JSON.parse(res.messages.find(m => m.role === 'tool')!.content);
    expect(reply).toMatchObject({ ok: false, need_confirmation: true });
  });

});
