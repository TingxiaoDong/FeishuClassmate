/**
 * 扫码登录（迭代 5 R-LG-02，开关 auth.qr_login）。
 *
 *   POST /auth/qr                     无鉴权，桌面端申请二维码 {device_name} → {qr_id, qr_content, expires_at}
 *   GET  /auth/qr/:qr_id              无鉴权，桌面端每 2 秒轮询 → {status, scanned_by_name?, device_name?, session?}
 *   POST /auth/qr/:qr_id/scan         手机端（已登录）扫码 → 同上，带 device_name
 *   POST /auth/qr/:qr_id/confirm      手机端确认 → 204
 *   POST /auth/qr/:qr_id/cancel       手机端取消 → 204
 *
 * status：waiting → scanned → confirmed，或 expired / canceled。confirmed 时 session 与 /auth/login 返回一致，
 * 只返回一次，之后再查返回 404。只能由扫码的那个人确认 / 取消；机器人不能扫码。
 *
 * 二维码状态只保存在本进程内存里（有效期 2 分钟），多实例部署需让 /auth/qr* 落到同一实例。
 * 无鉴权接口按 IP 限频：申请 20 次 / 分钟，轮询 120 次 / 分钟。
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fail, type Ctx } from './context.js';
import { createLoginSession, deviceInfo } from './routes-auth.js';
import type { DeviceInfo } from './auth-service.js';

export const QR_TTL_MS = 2 * 60_000;
const LIMITS = { create: 20, poll: 120 };

type Status = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'canceled';
interface QrState {
  qr_id: string;
  status: Status;
  expires_at: number;
  device: DeviceInfo;
  scanned_by?: string;
  scanned_by_name?: string;
  session?: Record<string, unknown>;
}

export function registerQrLoginRoutes(ctx: Ctx, now: () => number = Date.now): void {
  const { app } = ctx;
  const codes = new Map<string, QrState>();
  const hits = new Map<string, { at: number; n: number }>();

  const limited = (req: FastifyRequest, reply: FastifyReply, kind: keyof typeof LIMITS): boolean => {
    const key = `${kind}:${req.ip}`;
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.at >= 60_000) hits.set(key, { at: t, n: 1 });
    else if (++h.n > LIMITS[kind]) {
      fail(reply, 429, '请求太频繁，请稍后再试', { code: 'RATE_LIMITED' });
      return true;
    }
    return false;
  };

  const sweep = () => {
    const t = now();
    for (const [id, q] of codes) if (t > q.expires_at + QR_TTL_MS) codes.delete(id);
    if (hits.size > 10_000) for (const [k, h] of hits) if (t - h.at >= 60_000) hits.delete(k);
  };

  const current = (id: string): QrState | undefined => {
    const q = codes.get(id);
    if (!q) return undefined;
    if ((q.status === 'waiting' || q.status === 'scanned') && now() > q.expires_at) q.status = 'expired';
    return q;
  };

  const view = (q: QrState) => ({
    qr_id: q.qr_id,
    status: q.status,
    expires_at: new Date(q.expires_at).toISOString(),
    device_name: q.device.device_name,
    ...(q.scanned_by_name ? { scanned_by_name: q.scanned_by_name } : {}),
  });

  app.post('/api/v1/auth/qr', async (req, reply) => {
    if (limited(req, reply, 'create')) return;
    sweep();
    const info = deviceInfo(req);
    const qr_id = randomBytes(18).toString('base64url');
    const q: QrState = { qr_id, status: 'waiting', expires_at: now() + QR_TTL_MS, device: { ...info, device_name: info.device_name?.slice(0, 100) ?? '桌面端' } };
    codes.set(qr_id, q);
    return reply.code(201).send({ qr_id, qr_content: `classmateos://qr-login?qr_id=${qr_id}`, expires_at: new Date(q.expires_at).toISOString() });
  });

  app.get('/api/v1/auth/qr/:qr_id', async (req, reply) => {
    if (limited(req, reply, 'poll')) return;
    const q = current((req.params as { qr_id: string }).qr_id);
    if (!q) return fail(reply, 404, '二维码不存在或已过期', { code: 'NOT_FOUND' });
    if (q.status === 'confirmed') {
      // 会话只交付一次
      codes.delete(q.qr_id);
      return { ...view(q), session: q.session };
    }
    return view(q);
  });

  /** 手机端操作：鉴权、不许机器人、二维码有效。 */
  async function phone(req: FastifyRequest, reply: FastifyReply) {
    const me = await ctx.requireUser(req, reply);
    if (!me) return undefined;
    if (me.via_bot || me.user.role === 'bot') {
      fail(reply, 403, '机器人不能扫码登录', { code: 'BOT_SCOPE_DENIED' });
      return undefined;
    }
    const q = current((req.params as { qr_id: string }).qr_id);
    if (!q) {
      fail(reply, 404, '二维码不存在或已过期', { code: 'NOT_FOUND' });
      return undefined;
    }
    if (q.status === 'expired') {
      fail(reply, 410, '二维码已过期，请在电脑上刷新', { code: 'QR_EXPIRED' });
      return undefined;
    }
    if (q.status === 'canceled' || q.status === 'confirmed') {
      fail(reply, 409, '二维码已失效，请在电脑上刷新', { code: 'QR_USED' });
      return undefined;
    }
    if (q.scanned_by && q.scanned_by !== me.sub) {
      fail(reply, 409, '这个二维码已被其他人扫描', { code: 'QR_USED' });
      return undefined;
    }
    return { me, q };
  }

  app.post('/api/v1/auth/qr/:qr_id/scan', async (req, reply) => {
    const r = await phone(req, reply);
    if (!r) return;
    r.q.status = 'scanned';
    r.q.scanned_by = r.me.sub;
    r.q.scanned_by_name = r.me.user.name;
    return view(r.q);
  });

  app.post('/api/v1/auth/qr/:qr_id/confirm', async (req, reply) => {
    const r = await phone(req, reply);
    if (!r) return;
    if (r.q.status !== 'scanned') return fail(reply, 409, '请先扫码', { code: 'QR_NOT_SCANNED' });
    const user = await ctx.repo.getUser(r.me.sub);
    if (!user || user.disabled) return fail(reply, 403, '账号已被禁用', { code: 'ACCOUNT_DISABLED' });
    r.q.session = await createLoginSession(ctx, user, r.q.device);
    r.q.status = 'confirmed';
    await ctx.auditLog.record({ req, operator_id: user.user_id, operator_name: user.name, action: 'auth.login', target_type: 'user', target_id: user.user_id, target_name: user.name, detail: `扫码登录：${r.q.device.device_name ?? ''}` });
    return reply.code(204).send();
  });

  app.post('/api/v1/auth/qr/:qr_id/cancel', async (req, reply) => {
    const r = await phone(req, reply);
    if (!r) return;
    r.q.status = 'canceled';
    return reply.code(204).send();
  });
}
