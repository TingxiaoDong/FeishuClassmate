/**
 * Minimal signed-token auth (P1 内部使用). HMAC-SHA256 over JSON payload,
 * base64url 编码 — 不引入 jwt 依赖。生产部署时换标准 JWT。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const b64u = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export interface TokenPayload {
  sub: string; // user_id
  name: string;
  role: 'admin' | 'member' | 'bot';
  exp: number; // ms epoch
}

export function signToken(payload: Omit<TokenPayload, 'exp'>, secret: string, ttlMs = 2 * 3600_000): string {
  const full: TokenPayload = { ...payload, exp: Date.now() + ttlMs };
  const body = b64u(JSON.stringify(full));
  const sig = b64u(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | undefined {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = b64u(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const payload = JSON.parse(unb64u(body).toString('utf8')) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}
