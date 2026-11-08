import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';

describe('自动化授权路由安全边界', () => {
  it('真实用户可查询，bot 不得审批，投递能力保持关闭', async () => {
    const app = await buildApp({ users: [{ user_id: 'u1', name: '测试用户', password: 'pw', role: 'member' }], secret: 'test-only', botToken: 'test-bot', notificationScanner: false });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/automation/drafts' })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'u1', password: 'pw' } });
      const headers = { authorization: `Bearer ${login.json().access_token}` };
      const caps = await app.inject({ method: 'GET', url: '/api/v1/automation/capabilities', headers });
      expect(caps.statusCode).toBe(200);
      expect(caps.json()).toMatchObject({ approval: true, fixedTargetDelivery: false, scheduler: false, aiText: false });
      const list = await app.inject({ method: 'GET', url: '/api/v1/automation/drafts', headers });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ items: [], total: 0, page_token: null });
      const bot = await app.inject({ method: 'POST', url: '/api/v1/automation/drafts/fake/approve', headers: { 'x-bot-token': 'test-bot', 'x-on-behalf-of': 'u1' }, payload: { expectedVersion: 1, expectedDigest: 'a'.repeat(64) } });
      expect(bot.statusCode).toBe(403);
      expect(bot.json().code).toBe('PERMISSION_DENIED');
      const unsupported = await app.inject({ method: 'GET', url: '/api/v1/automation/drafts?page_size=101', headers });
      expect(unsupported.statusCode).toBe(422);
    } finally { await app.close(); }
  });
});
