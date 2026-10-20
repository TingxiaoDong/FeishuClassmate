import { describe, it, expect } from 'vitest';
import { MockSidecar } from '../../src/robot/sidecar.js';
import { RobotGuard } from '../../src/robot/safety.js';
import { StaticLocationRegistry } from '../../src/robot/locations.js';
import { RobotController } from '../../src/robot/controller.js';
const actor = { userId: 'a', sessionId: 'a' };
const loc = { name: '实验室', label: '实验室', aliases: [], kind: 'room' as const, allowed: true };
const setup = () => {
  const sidecar = new MockSidecar({ travelMs: 5 });
  const guard = new RobotGuard({ quietHours: 'off' });
  const controller = new RobotController({ sidecar, guard, locations: new StaticLocationRegistry([loc]) });
  return { sidecar, guard, controller };
};
describe('M4 机器人基础模块', () => {
  it('低电量、未知电量和离线禁止导航', async () => {
    const { sidecar, guard, controller } = setup();
    sidecar.state.battery = 5;
    expect(guard.checkMove(actor, loc, sidecar.state).ok).toBe(false);
    sidecar.state.battery = null;
    expect(guard.checkMove(actor, loc, sidecar.state).ok).toBe(false);
    expect(guard.checkMove(actor, loc, undefined).ok).toBe(false);
    controller.close();
  });
  it('其他控制者和未知地点不能移动', () => {
    const { sidecar, guard, controller } = setup();
    guard.acquire(actor);
    expect(guard.checkMove({ userId: 'b', sessionId: 'b' }, loc, sidecar.state).ok).toBe(false);
    expect(guard.checkMove(actor, undefined, sidecar.state).ok).toBe(false);
    controller.close();
  });
  it('模拟导航到达后返回 arrived', async () => {
    const { controller } = setup();
    const r = await controller.goto(actor, '实验室');
    expect(r.ok && r.arrived).toBe(true);
    controller.close();
  });
  it('任何人可以急停并中断导航', async () => {
    const { controller, sidecar, guard } = setup();
    sidecar.opts.travelMs = 200;
    const r = await controller.goto(actor, '实验室', { wait: false });
    expect(r.ok).toBe(true);
    await controller.stop({ userId: 'b' });
    expect(guard.lockHolder()).toBeUndefined();
    if (r.ok) expect(controller.getAction(r.action_id)?.state).toBe('failed');
    expect(sidecar.state.is_moving).toBe(false);
    controller.close();
  });
});

import { createBrain } from '../../src/runtime/brain.js';
describe('M4 模拟大脑集成', () => {
  it('启用后注册新工具、隐藏旧工具，并落实确认规则', async () => {
    process.env.CLASSMATE_ROBOT_M4 = '1';
    try {
      const b = createBrain({ llm: { chat: async () => ({ content: '', toolCalls: [] }) }, cos: false, telemetry: false, logger: { info() {}, warn() {}, error() {}, debug() {} } });
      expect(b.runtime.listTools()).toContain('temi_goto');
      expect(b.runtime.listTools()).not.toContain('feishu_classmate_temi_navigate_to');
      const ctx = { toolCallId: 't', sessionId: 's', actor: { userId: 'a' } };
      expect(await b.runtime.getTool('temi_goto')!.execute({ location: '入口' }, ctx)).toMatchObject({ ok: false, need_confirmation: true });
      expect(b.runtime.getTool('temi_stop')!.policy!.needsConfirm!({}, 'physical')).toBe(false);
      expect(b.systemPromptFor('Temi')).toBeUndefined();
      expect(JSON.stringify(b.runtime)).toContain('temi_stop');
    } finally {
      delete process.env.CLASSMATE_ROBOT_M4;
    }
  });
});

describe('M4 到达确认', () => {
  it('sidecar 没确认到达时保持前往中，等到达事件', async () => {
    class Unconfirmed extends MockSidecar {
      async goto(location: string, actionId: string) {
        this.emit({ type: 'nav.started', location, action_id: actionId });
        return { ok: true, data: { arrived: false } };
      }
    }
    const sidecar = new Unconfirmed();
    const controller = new RobotController({ sidecar, guard: new RobotGuard({ quietHours: 'off' }), locations: new StaticLocationRegistry([loc]) });
    const r = await controller.goto(actor, '实验室', { timeoutMs: 50 });
    expect(r).toMatchObject({ ok: true, arrived: false, state: 'moving' });
    if (!r.ok) return;
    sidecar.emit({ type: 'nav.arrived', location: '实验室', action_id: r.action_id });
    expect(controller.getAction(r.action_id)?.state).toBe('arrived');
    controller.close();
  });
});
