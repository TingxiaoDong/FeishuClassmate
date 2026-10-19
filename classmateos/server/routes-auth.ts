/**
 * 认证与用户（《前端接口需求文档》第 4 节）。
 */

import { randomUUID } from 'node:crypto';
import {
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken,
} from './auth.js';
import { fail, invalid, optText, pageOffset, pageResult, pageSize, type Ctx, type FieldError } from './context.js';
import { nowIso, publicUser, type Role, type UserPatch, type UserRecord } from './repo.js';

const ROLES = new Set<Role>(['admin', 'member', 'bot']);

export function registerAuthRoutes(ctx: Ctx): void {
  const { app, repo, secret } = ctx;

  const issueTokens = async (user: UserRecord) => {
    const jti = randomUUID();
    const base = { sub: user.user_id, name: user.name, role: user.role };
    await repo.saveRefreshToken(jti, user.user_id, new Date(Date.now() + REFRESH_TTL_MS).toISOString());
    return {
      access_token: signToken({ ...base, typ: 'access' }, secret, ACCESS_TTL_MS),
      refresh_token: signToken({ ...base, typ: 'refresh', jti }, secret, REFRESH_TTL_MS),
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      user: publicUser(user),
    };
  };

  app.post('/api/v1/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== 'string' || typeof password !== 'string') {
      return fail(reply, 401, 'invalid credentials');
    }
    const user = await repo.findUserByLogin(username);
    // 登录失败的 message 保持 invalid credentials（前端据此区分「密码错误」和「登录过期」）
    if (!user || !verifyPassword(password, user.password_hash)) {
      return fail(reply, 401, 'invalid credentials');
    }
    if (user.disabled) return fail(reply, 403, '账号已被禁用', { code: 'ACCOUNT_DISABLED' });
    return issueTokens(user);
  });

  app.post('/api/v1/auth/refresh', async (req, reply) => {
    const { refresh_token } = (req.body ?? {}) as { refresh_token?: unknown };
    const p = typeof refresh_token === 'string' ? verifyToken(refresh_token, secret, 'refresh') : undefined;
    const userId = p?.jti ? await repo.consumeRefreshToken(p.jti) : undefined;
    const user = userId ? await repo.getUser(userId) : undefined;
    if (!user || user.disabled) return fail(reply, 401, 'refresh token expired', { code: 'REFRESH_EXPIRED' });
    return issueTokens(user);
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const { refresh_token } = (req.body ?? {}) as { refresh_token?: unknown };
    const p = typeof refresh_token === 'string' ? verifyToken(refresh_token, secret, 'refresh') : undefined;
    if (p?.jti) await repo.revokeRefreshToken(p.jti);
    return reply.code(204).send();
  });

  app.get('/api/v1/users/me', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    return publicUser(me.user);
  });

  app.patch('/api/v1/users/me', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const adminOnly = ['name', 'role', 'department', 'title', 'email'].filter((k) => body[k] !== undefined);
    if (adminOnly.length > 0 && me.role !== 'admin') {
      return fail(reply, 403, `只有管理员可以修改：${adminOnly.join('、')}`);
    }
    const errors: FieldError[] = [];
    const patch = collectProfile(body, errors, me.role === 'admin');
    if (errors.length) return invalid(reply, errors);
    const updated = await repo.updateUser(me.sub, patch);
    ctx.invalidateUser(me.sub);
    return publicUser(updated!);
  });

  app.get('/api/v1/users', async (req, reply) => {
    if (!(await ctx.requireUser(req, reply))) return;
    const q = req.query as { keyword?: string; page_size?: string; page_token?: string };
    const limit = pageSize(q.page_size, 500, 1000);
    const offset = pageOffset(q.page_token);
    const page = await repo.listUsers({ keyword: q.keyword, limit, offset });
    return pageResult(page.items.map(publicUser), page.total, offset);
  });

  app.get('/api/v1/users/:user_id', async (req, reply) => {
    if (!(await ctx.requireUser(req, reply))) return;
    const { user_id } = req.params as { user_id: string };
    const u = await repo.getUser(user_id);
    if (!u) return fail(reply, 404, '用户不存在');
    return publicUser(u);
  });

  // ---------------- 管理员：账号管理 ----------------

  app.post('/api/v1/users', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    if (me.role !== 'admin') return fail(reply, 403, '只有管理员可以添加成员');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    if (typeof body.user_id !== 'string' || !/^[\w.@-]{1,64}$/.test(body.user_id)) {
      errors.push({ field: 'user_id', message: '只能包含字母、数字和 _ . @ -，最长 64 位' });
    }
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push({ field: 'name', message: '不能为空' });
    if (typeof body.password !== 'string' || body.password.length < 4) {
      errors.push({ field: 'password', message: '至少 4 位' });
    }
    const patch = collectProfile(body, errors, true);
    if (errors.length) return invalid(reply, errors);
    const now = nowIso();
    const user: UserRecord = {
      user_id: body.user_id as string,
      name: (body.name as string).trim(),
      email: (patch.email as string | null | undefined) ?? null,
      role: (patch.role as Role | undefined) ?? 'member',
      avatar_url: patch.avatar_url ?? null,
      department: patch.department ?? null,
      title: patch.title ?? null,
      phone: patch.phone ?? null,
      status_text: patch.status_text ?? null,
      password_hash: hashPassword(body.password as string),
      disabled: false,
      created_at: now,
      updated_at: now,
    };
    if (!(await repo.insertUserIfMissing(user))) return fail(reply, 409, '这个 user_id 已经存在');
    return reply.code(201).send(publicUser(user));
  });

  app.patch('/api/v1/users/:user_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    if (me.role !== 'admin') return fail(reply, 403, '只有管理员可以修改其他成员');
    const { user_id } = req.params as { user_id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const patch = collectProfile(body, errors, true);
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== 'boolean') errors.push({ field: 'disabled', message: '必须是 true / false' });
      else patch.disabled = body.disabled;
    }
    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 4) {
        errors.push({ field: 'password', message: '至少 4 位' });
      } else patch.password_hash = hashPassword(body.password);
    }
    if (errors.length) return invalid(reply, errors);
    const updated = await repo.updateUser(user_id, patch);
    if (!updated) return fail(reply, 404, '用户不存在');
    ctx.invalidateUser(user_id);
    return publicUser(updated);
  });
}

function collectProfile(body: Record<string, unknown>, errors: FieldError[], admin: boolean): UserPatch {
  const patch: UserPatch = { updated_at: nowIso() };
  const avatar = optText(body, 'avatar_url', errors, 2000);
  if (avatar !== undefined) patch.avatar_url = avatar;
  const status = optText(body, 'status_text', errors, 100);
  if (status !== undefined) patch.status_text = status;
  const phone = optText(body, 'phone', errors, 40);
  if (phone !== undefined) patch.phone = phone;
  if (!admin) return patch;
  const name = optText(body, 'name', errors, 64);
  if (name !== undefined) {
    if (!name?.trim()) errors.push({ field: 'name', message: '不能为空' });
    else patch.name = name.trim();
  }
  const email = optText(body, 'email', errors, 200);
  if (email !== undefined) patch.email = email;
  const dept = optText(body, 'department', errors, 100);
  if (dept !== undefined) patch.department = dept;
  const title = optText(body, 'title', errors, 100);
  if (title !== undefined) patch.title = title;
  if (body.role !== undefined) {
    if (typeof body.role !== 'string' || !ROLES.has(body.role as Role)) {
      errors.push({ field: 'role', message: '必须是以下之一：admin、member、bot' });
    } else patch.role = body.role as Role;
  }
  return patch;
}
