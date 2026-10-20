import { describe, it, expect, vi } from 'vitest';
import { createTriggerEngine, matchTrigger, type Trigger } from '../../src/runtime/trigger-engine.js';
import { createCosJobTracker, progressOf } from '../../src/runtime/job-tracker.js';
import { scheduledPrompt } from '../../src/runtime/scheduler.js';
import { createFakeConfig } from '../helpers/fake-config.js';
import type { CosClient } from '../../src/cos-sdk/client.js';
import type { AgentRuntime } from '../../src/runtime/types.js';

const trigger = (patch: Partial<Trigger> = {}): Trigger => ({ trigger_id: 't1', owner_id: 'alice', name: '规则', event: 'record.changed', filter: { table_key: 'table1' }, cron: null, condition: null, prompt: '检查进展', chat_id: null, enabled: true, cooldown_sec: 60, ...patch });
function fixture(t = trigger(), allowed = true, output = '已完成') {
  const get = vi.fn(async (path: string) => path === '/bot/triggers' ? { ok: true, data: { items: [t] } } : { ok: allowed, data: {} });
  const post = vi.fn(async () => ({ ok: true, data: {} }));
  const runSession = vi.fn(async () => ({ output }));
  const sendText = vi.fn(async () => ({ ok: true, data: {} }));
  const engine = createTriggerEngine({ client: { get, post } as unknown as CosClient, runtime: { runSession } as unknown as AgentRuntime, im: { sendText } as any, cron: false });
  return { engine, get, post, runSession, sendText };
}
const event = { event_type: 'record.changed', table_key: 'table1', record_id: 'r1', action: 'updated' };
describe('M3 自动化运行时', () => {
  it('匹配字段与表，忽略机器人自己的写入', () => {
    expect(matchTrigger(trigger(), event)).toBe(true);
    expect(matchTrigger(trigger(), { ...event, via_bot: true })).toBe(false);
    expect(matchTrigger(trigger(), { ...event, table_key: 'other' })).toBe(false);
    expect(matchTrigger(trigger({ filter: { table_key: 'table1', fields_any: ['status'] } }), { ...event, changed_fields: ['name'] })).toBe(false);
  });
  it('以主人身份重新读取对象，无权限不运行', async () => {
    const f = fixture(trigger(), false); await f.engine.start();
    expect(await f.engine.handleEvent(event)).toEqual([]);
    expect(f.get).toHaveBeenLastCalledWith('/tables/table1/records/r1', { actor: { userId: 'alice', sessionId: 'trg_t1' } });
    expect(f.runSession).not.toHaveBeenCalled(); f.engine.stop();
  });
  it('任务邀请也按主人身份核验对象', async () => {
    const f = fixture(trigger({ event: 'task.assigned', filter: {} }), false); await f.engine.start();
    expect(await f.engine.handleEvent({ event_type: 'task.assigned', actor_id: 'bob', task: { task_id: 'task1', assignee_id: 'alice' } })).toEqual([]);
    expect(f.get).toHaveBeenLastCalledWith('/tasks/task1', expect.anything()); f.engine.stop();
  });
  it('排队后被停用则跳过', async () => {
    const f = fixture(); await f.engine.start();
    f.get.mockResolvedValueOnce({ ok: true, data: { items: [] } }); await f.engine.reload();
    expect(await f.engine.fire('t1')).toBeUndefined(); expect(f.runSession).not.toHaveBeenCalled(); f.engine.stop();
  });
  it('执行、私信、回写结果，并受冷却限制', async () => {
    const f = fixture(); await f.engine.start();
    expect(await f.engine.handleEvent(event)).toEqual(['t1']); await f.engine.idle();
    expect(f.runSession).toHaveBeenCalledWith(expect.objectContaining({ actor: { userId: 'alice', chatId: undefined } }));
    expect(f.sendText).toHaveBeenCalledWith('alice', expect.stringContaining('已完成'), 'user_id');
    expect(f.post).toHaveBeenCalledWith('/bot/triggers/t1/fired', expect.anything(), { asBot: true });
    expect((await f.engine.fire('t1'))?.status).toBe('cooldown'); f.engine.stop();
  });
  it('SKIP 不发消息，停止后不执行', async () => {
    const f = fixture(trigger(), true, 'SKIP'); await f.engine.start();
    expect((await f.engine.fire('t1'))?.status).toBe('skipped');
    expect(f.sendText).not.toHaveBeenCalled(); f.engine.stop();
    expect(await f.engine.fire('t1')).toBeUndefined();
  });
  it('job 登记、更新与进度上限', async () => {
    const post = vi.fn(async () => ({ ok: true, data: { job_id: 'j1' } }));
    const patch = vi.fn(async () => ({ ok: true }));
    const jobs = createCosJobTracker({ post, patch } as unknown as CosClient);
    expect(await jobs.create({ title: '周报', ownerId: 'alice' })).toBe('j1');
    await jobs.update('j1', { status: 'done' });
    expect(patch).toHaveBeenCalledWith('/bot/jobs/j1', { status: 'done' }, { asBot: true });
    expect(progressOf([{ state: 'ok' }])).toBe(0.95);
    expect(progressOf([])).toBe(0);
  });
  it('定时任务携带身份、广播群和无确认约束', () => {
    const cfg = createFakeConfig(); cfg.labInfo.broadcastChatId = 'group1';
    const p = scheduledPrompt('写周报', cfg, 'service');
    expect(p).toContain('chat_id=group1'); expect(p).toContain('user_id=service'); expect(p).toContain('不要尝试');
  });
});
