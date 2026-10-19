/**
 * Minimal signed-token auth. HMAC-SHA256 over JSON payload, base64url 编码 —
 * 不引入 jwt 依赖。生产部署时可换标准 JWT。
 *
 * 令牌载荷带 `typ`：
 *   - access：普通接口 / WebSocket 使用，默认 2 小时；
 *   - refresh：只能用于 POST /auth/refresh，默认 30 天，带 jti（服务端登记，可轮换 / 吊销）。
 * verifyToken 默认只接受 access；没有 typ 的旧令牌一律拒绝（防止 refresh_token 被当 access 用）。
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const b64u = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export type TokenType = 'access' | 'refresh';

export const ACCESS_TTL_MS = 2 * 3600_000;
export const REFRESH_TTL_MS = 30 * 24 * 3600_000;

export interface TokenPayload {
  sub: string; // user_id
  name: string;
  role: 'admin' | 'member' | 'bot';
  typ: TokenType;
  /** refresh 令牌的服务端登记 id。 */
  jti?: string;
  exp: number; // ms epoch
}

export function signToken(
  payload: Omit<TokenPayload, 'exp' | 'typ'> & { typ?: TokenType },
  secret: string,
  ttlMs = ACCESS_TTL_MS,
): string {
  const full: TokenPayload = { typ: 'access', ...payload, exp: Date.now() + ttlMs };
  const body = b64u(JSON.stringify(full));
  const sig = b64u(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(
  token: string,
  secret: string,
  expectedTyp: TokenType = 'access',
): TokenPayload | undefined {
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
    if (payload.typ !== expectedTyp) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

// ---------------- 密码哈希（scrypt） ----------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expect = Buffer.from(parts[2], 'base64');
  const got = scryptSync(password, salt, expect.length);
  return got.length === expect.length && timingSafeEqual(got, expect);
}
