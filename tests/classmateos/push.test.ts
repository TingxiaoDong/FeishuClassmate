/**
 * 推送通知骨架测试（P3）：
 * 1. 设备注册/查询/注销（幂等换绑、他人设备 403）；
 * 2. 发消息 → 会话成员（除发送者）设备收到推送，内容含发送者与正文；
 * 3. 发送者自己的设备不推送；bot 发的消息同样触发（成员均收）。
 */

import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import { MemoryPushProvider } from '../../classmateos/server/push.js';

const USERS = [
  { user_id: 'ou_alice', name: 'alice', password: 'pw1', role: 'admin' as const },
  { user_id: 'ou_bob', name: 'bob', password: 'pw2', role: 'member' as const },
];

async function setup() {
  const push = new MemoryPushProvider();
  const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok', pushProvider: push });
  const login = async (u: string, p: string) =>
    (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: p } })
    ).json().access_token as string;
  return { app, push, alice: await login('alice', 'pw1'), bob: await login('bob', 'pw2') };
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('push 推送通知骨架', () => {
  it('设备注册：幂等换绑、仅本人可查可删、他人删除 403', async () => {
    const { app, alice, bob } = await setup();
    // bob 注册 iOS 设备
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: auth(bob),
      payload: { platform: 'ios', device_token: 'apns-token-1' },
    });
    expect(reg.statusCode).toBe(201);
    const deviceId = reg.json().device_id;

    // alice 用同 token 注册 → 幂等换绑到 alice
    const rebind = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: auth(alice),
      payload: { platform: 'ios', device_token: 'apns-token-1' },
    });
    expect(rebind.statusCode).toBe(200);
    expect(rebind.json().device_id).toBe(deviceId);
    expect(rebind.json().user_id).toBe('ou_alice');

    // 列表只见本人设备
    const listB = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(bob) });
    expect(listB.json().items).toHaveLength(0);
    const listA = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(alice) });
    expect(listA.json().items).toHaveLength(1);

    // bob 删别人的设备 → 403；本人删除 → 204
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/devices/${deviceId}`, headers: auth(bob) })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/devices/${deviceId}`, headers: auth(alice) })).statusCode,
    ).toBe(204);

    // 参数校验
    expect(
      (await app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        headers: auth(bob),
        payload: { platform: 'windows', device_token: 'x' },
      })).statusCode,
    ).toBe(400);
  });

  it('发消息触发推送：成员（除发送者）设备收到，发送者不推送', async () => {
    const { app, push, alice, bob } = await setup();
    // alice 一台 iOS，bob 一台 Android + 一台 iOS
    await app.inject({
      method: 'POST', url: '/api/v1/devices', headers: auth(alice),
      payload: { platform: 'ios', device_token: 'alice-ios' },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/devices', headers: auth(bob),
      payload: { platform: 'android', device_token: 'bob-android' },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/devices', headers: auth(bob),
      payload: { platform: 'ios', device_token: 'bob-ios' },
    });

    const chat = await app.inject({
      method: 'POST', url: '/api/v1/chats', headers: auth(alice),
      payload: { member_ids: ['ou_bob', 'bot'] }, // 机器人要在会话里（代码审查 B1）
    });
    const chatId = chat.json().chat_id;

    await app.inject({
      method: 'POST', url: `/api/v1/chats/${chatId}/messages`, headers: auth(alice),
      payload: { msg_type: 'text', content: { text: '今晚开组会' } },
    });
    // 推送为异步触发，等一拍
    await new Promise((r) => setTimeout(r, 50));

    // bob 两台设备都收到，alice 的没有（她是发送者）
    const tokens = push.sent.map((s) => s.device_token).sort();
    expect(tokens).toEqual(['bob-android', 'bob-ios']);
    expect(push.sent[0].msg.body).toBe('alice: 今晚开组会');
    expect(push.sent[0].msg.data?.chat_id).toBe(chatId);
    const platforms = Object.fromEntries(push.sent.map((s) => [s.device_token, s.platform]));
    expect(platforms['bob-android']).toBe('android');

    // bot 发消息 → 两名成员都收到（发送者 'bot' 无设备）
    await app.inject({
      method: 'POST', url: '/api/v1/bot/messages',
      headers: { 'x-bot-token': 'btok' },
      payload: { receive_id: chatId, msg_type: 'text', content: { text: '机器人提醒' } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(push.sent.filter((s) => s.device_token === 'alice-ios')).toHaveLength(1);
    expect(push.sent).toHaveLength(5);
  });
});
