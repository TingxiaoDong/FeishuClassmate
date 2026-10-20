import { describe, it, expect } from 'vitest';
import { MockSidecar } from '../../src/robot/sidecar.js';
import { RobotGuard } from '../../src/robot/safety.js';
import { StaticLocationRegistry } from '../../src/robot/locations.js';
import { RobotController } from '../../src/robot/controller.js';
import { createVoiceChannel, bridgePlatformEstop, toSpeech, VISITOR_ACTOR } from '../../src/robot/voice-channel.js';
import { CosClient } from '../../src/cos-sdk/client.js';
import { eventVisibleTo } from '../../classmateos/server/events.js';
import type { AgentRuntime, RunSessionInput } from '../../src/runtime/types.js';

const loc = { name: '实验室', label: '实验室', aliases: [], kind: 'room' as const, allowed: true };
const mk = () => {
  const sidecar = new MockSidecar({ travelMs: 200 });
  const said: string[] = [];
  const orig = sidecar.say.bind(sidecar);
  sidecar.say = async (t: string) => { said.push(t); return orig(t); };
  const controller = new RobotController({ sidecar, guard: new RobotGuard({ quietHours: 'off' }), locations: new StaticLocationRegistry([loc]) });
  return { sidecar, controller, said };
};
const fakeRuntime = (reply: (i: RunSessionInput) => string | Promise<string>) => {
  const calls: RunSessionInput[] = [];
  const rt = { runSession: async (i: RunSessionInput) => { calls.push(i); return { sessionId: i.sessionId ?? 's', output: await reply(i), messages: [], turns: 1 }; } } as unknown as AgentRuntime;
  return { rt, calls };
};

describe('M4 Temi 语音通道', () => {
  it('asr 事件进大脑，回答整理后由 Temi 播报，带上前文', async () => {
    const { sidecar, controller, said } = mk();
    const { rt, calls } = fakeRuntime(() => '**你好**！我是飞书同学。\n- 实验室在三楼 https://x.y');
    const ch = createVoiceChannel({ controller, runtime: rt });
    sidecar.emit({ type: 'asr', text: '你好' });
    await new Promise((r) => setTimeout(r, 20));
    expect(said[0]).toBe('你好！我是飞书同学。实验室在三楼');
    await ch.handle('实验室在哪');
    expect(calls[1].messages.map((m) => m.content)).toEqual(['你好', said[0], '实验室在哪']);
    expect(calls[0].actor).toEqual({ userId: '', name: '访客' });
    expect(calls[0].confirm).toBeUndefined();
    ch.stop(); controller.close();
  });

  it('上一句没答完时提示稍等，不并发跑大脑', async () => {
    const { controller, said } = mk();
    let release!: () => void;
    const { rt, calls } = fakeRuntime(() => new Promise<string>((r) => { release = () => r('好的'); }));
    const ch = createVoiceChannel({ controller, runtime: rt });
    const first = ch.handle('第一句');
    await new Promise((r) => setTimeout(r, 5));
    await ch.handle('第二句');
    expect(said).toContain('我还在想上一个问题，请稍等一下。');
    release(); await first;
    expect(calls).toHaveLength(1);
    ch.stop(); controller.close();
  });

  it('闲置超时清空上下文', async () => {
    const { controller } = mk();
    let t = 0;
    const { rt, calls } = fakeRuntime(() => '嗯');
    const ch = createVoiceChannel({ controller, runtime: rt, now: () => t, idleResetMs: 1000 });
    await ch.handle('一'); t = 5000; await ch.handle('二');
    expect(calls[1].messages).toHaveLength(1);
    expect(calls[1].sessionId).not.toBe(calls[0].sessionId);
    ch.stop(); controller.close();
  });

  it('访客身份借不到服务账号：空 userId 直接拒绝', async () => {
    let fetched = false;
    const client = new CosClient({ baseUrl: 'http://x/api/v1', botToken: 't', defaultUserId: 'service', fetchImpl: (async () => { fetched = true; return new Response('{}'); }) as typeof fetch });
    const r = await client.get('/users/me', { actor: { userId: VISITOR_ACTOR.userId } });
    expect(r).toMatchObject({ ok: false, code: 'NO_ACTOR' });
    expect(fetched).toBe(false);
    expect(client.resolveUserId(undefined)).toBe('service');
  });

  it('长回答截到适合播报的长度', () => {
    const s = toSpeech('第一句。'.repeat(80), 50);
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s.endsWith('。')).toBe(true);
  });
});

describe('M4 App 急停桥', () => {
  it('robot.estop 事件让机器人急停并中断导航；其他机器人的事件忽略', async () => {
    const { controller, sidecar } = mk();
    let fn!: (e: any) => void;
    const off = bridgePlatformEstop({ onEvent: (f) => { fn = f; return () => {}; } }, controller);
    const g = await controller.goto({ userId: 'a', sessionId: 'a' }, '实验室', { wait: false });
    fn({ event_type: 'robot.estop', robot_id: 'other', user_id: 'b' });
    expect(sidecar.state.is_moving).toBe(true);
    fn({ event_type: 'robot.estop', robot_id: 'temi', user_id: 'b', name: '乙' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sidecar.state.is_moving).toBe(false);
    if (g.ok) expect(controller.getAction(g.action_id)?.state).toBe('failed');
    off(); controller.close();
  });

  it('急停事件不推给任何同学的 WS', () => {
    const e = { event_id: '1', event_type: 'robot.estop' as const, created_at: '', scope: { all: true } };
    expect(eventVisibleTo(e, { id: 'a', role: 'admin' }, new Set())).toBe(false);
  });
});
