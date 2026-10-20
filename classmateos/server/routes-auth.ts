/**
 * 认证与用户（《前端接口需求文档》第 4 节）。
 */

import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { REFRESH_TTL_MS, hashPassword, signToken, verifyPassword, verifyToken } from './auth.js';
import { mergeSecurity, passwordProblem, randomPassword, type DeviceInfo } from './auth-service.js';
import { fail, invalid, optText, pageOffset, pageResult, pageSize, type Ctx, type FieldError } from './context.js';
import type { Organization } from './organization.js';
import { nowIso, publicUser, type Role, type UserPatch, type UserRecord } from './repo.js';

const ROLES = new Set<Role>(['admin', 'member', 'bot']);

/** 本人视角的 user：多带 permissions（权限点并集，迭代 5 第 3 节）。 */
export async function selfUser(ctx: Ctx, user: UserRecord) {
  return { ...(await userView(ctx, user)), permissions: await ctx.roles.permissionsOf(user) };
}

/** 通讯录视角的 user：原有字段 + 部门 ID、主部门、直属上级（department 文字取主部门名称）。 */
export async function userView(ctx: Ctx, user: UserRecord, org?: Organization) {
  const s = org ?? (await ctx.org.read());
  const m = s.members[user.user_id];
  const primary = m?.primary_department_id ? s.departments.find((d) => d.department_id === m.primary_department_id) : undefined;
  return {
    ...publicUser(user),
    department: m ? (primary?.name ?? null) : user.department,
    department_ids: m?.department_ids ?? [],
    primary_department_id: m?.primary_department_id ?? null,
    leader_id: m?.leader_id ?? null,
  };
}

/** 从请求里取设备信息：body.device_name / platform，或 X-Device-Name / X-Platform 头，再退回 User-Agent。 */
export function deviceInfo(req: FastifyRequest): DeviceInfo {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const h = (k: string) => {
    const v = req.headers[k];
    return typeof v === 'string' ? v : undefined;
  };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  let name = str(b.device_name) ?? h('x-device-name');
  try {
    if (name && /%[0-9a-f]{2}/i.test(name)) name = decodeURIComponent(name);
  } catch {
    // 原样使用
  }
  return { device_name: name ?? null, platform: str(b.platform) ?? h('x-platform') ?? null, ip: req.ip ?? null, user_agent: h('user-agent') ?? null };
}

async function signPair(ctx: Ctx, user: UserRecord, sid: string, jti: string) {
  const ttl = await ctx.auth.accessTtlMs();
  const base = { sub: user.user_id, name: user.name, role: user.role, sid };
  return {
    access_token: signToken({ ...base, typ: 'access' }, ctx.secret, ttl),
    refresh_token: signToken({ ...base, typ: 'refresh', jti }, ctx.secret, REFRESH_TTL_MS),
    token_type: 'Bearer',
    expires_in: Math.floor(ttl / 1000),
  };
}

/** 新建一个登录设备会话并签发令牌（密码登录、扫码登录共用）。返回结构即 /auth/login 的返回。 */
export async function createLoginSession(ctx: Ctx, user: UserRecord, info: DeviceInfo) {
  const jti = randomUUID();
  await ctx.repo.saveRefreshToken(jti, user.user_id, new Date(Date.now() + REFRESH_TTL_MS).toISOString());
  const sid = await ctx.auth.createSession(user.user_id, info, jti, REFRESH_TTL_MS);
  const st = await ctx.auth.recordLogin(user.user_id);
  const sec = await ctx.auth.getSecurity();
  const must = sec.force_change_on_first_login && st.must_change_password;
  return {
    ...(await signPair(ctx, user, sid, jti)),
    session_id: sid,
    must_change_password: must,
    user: { ...(await selfUser(ctx, user)), must_change_password: must },
  };
}

/** 对外网址前缀：CLASSMATE_OS_PUBLIC_URL，没配置时按请求的 Host 推出。 */
function publicBase(req: FastifyRequest): string {
  const env = (process.env.CLASSMATE_OS_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (env) return env;
  const fp = req.headers['x-forwarded-proto'];
  const fh = req.headers['x-forwarded-host'];
  const proto = (typeof fp === 'string' && fp.split(',')[0].trim()) || req.protocol || 'http';
  const host = (typeof fh === 'string' && fh.split(',')[0].trim()) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

export function registerAuthRoutes(ctx: Ctx): void {
  const { app, repo, secret } = ctx;

  app.post('/api/v1/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== 'string' || typeof password !== 'string') {
      return fail(reply, 401, 'invalid credentials');
    }
    const user = await repo.findUserByLogin(username);
    if (user) {
      const locked = await ctx.auth.lockedMinutes(user.user_id);
      if (locked > 0) {
        return fail(reply, 423, `登录失败次数过多，账号已锁定，请 ${locked} 分钟后再试`, { code: 'ACCOUNT_LOCKED', retry_after_minutes: locked });
      }
    }
    // 登录失败的 message 保持 invalid credentials（前端据此区分「密码错误」和「登录过期」）
    if (!user || !verifyPassword(password, user.password_hash)) {
      if (user && user.role !== 'bot') {
        const r = await ctx.auth.recordFailure(user.user_id);
        if (r.locked) {
          return fail(reply, 423, `登录失败次数过多，账号已锁定，请 ${r.minutes} 分钟后再试`, { code: 'ACCOUNT_LOCKED', retry_after_minutes: r.minutes });
        }
      }
      await ctx.auditLog.record({ req, operator_id: user?.user_id ?? null, operator_name: user?.name ?? null, action: 'auth.login_failed', target_type: 'user', target_id: user?.user_id ?? null, target_name: user?.name ?? username.slice(0, 64), detail: user ? '密码错误' : '账号不存在' });
      return fail(reply, 401, 'invalid credentials');
    }
    if (user.disabled) return fail(reply, 403, '账号已被禁用', { code: 'ACCOUNT_DISABLED' });
    const out = await createLoginSession(ctx, user, deviceInfo(req));
    await ctx.auditLog.record({ req, operator_id: user.user_id, operator_name: user.name, action: 'auth.login', target_type: 'user', target_id: user.user_id, target_name: user.name, detail: null });
    return out;
  });

  app.post('/api/v1/auth/refresh', async (req, reply) => {
    const { refresh_token } = (req.body ?? {}) as { refresh_token?: unknown };
    const expired = () => fail(reply, 401, 'refresh token expired', { code: 'REFRESH_EXPIRED' });
    const p = typeof refresh_token === 'string' ? verifyToken(refresh_token, secret, 'refresh') : undefined;
    const userId = p?.jti ? await repo.consumeRefreshToken(p.jti) : undefined;
    const user = userId ? await repo.getUser(userId) : undefined;
    if (!p?.jti || !user || user.disabled) return expired();
    const jti = randomUUID();
    let sid = p.sid;
    if (sid) {
      if (!(await ctx.auth.rotateRefresh(sid, user.user_id, p.jti, jti, REFRESH_TTL_MS))) return expired();
      await repo.saveRefreshToken(jti, user.user_id, new Date(Date.now() + REFRESH_TTL_MS).toISOString());
    } else {
      // 升级前签发的 refresh：补建一个设备会话（账号做过「退出全部设备」等操作后不再接受）
      if ((await ctx.auth.getState(user.user_id, true)).legacy_revoked) return expired();
      await repo.saveRefreshToken(jti, user.user_id, new Date(Date.now() + REFRESH_TTL_MS).toISOString());
      sid = await ctx.auth.createSession(user.user_id, deviceInfo(req), jti, REFRESH_TTL_MS);
    }
    const st = await ctx.auth.getState(user.user_id);
    const sec = await ctx.auth.getSecurity();
    const must = sec.force_change_on_first_login && st.must_change_password;
    return {
      ...(await signPair(ctx, user, sid, jti)),
      session_id: sid,
      must_change_password: must,
      user: { ...(await selfUser(ctx, user)), must_change_password: must },
    };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const { refresh_token } = (req.body ?? {}) as { refresh_token?: unknown };
    const p = typeof refresh_token === 'string' ? verifyToken(refresh_token, secret, 'refresh') : undefined;
    if (p?.jti) await repo.revokeRefreshToken(p.jti);
    if (p?.sub) await ctx.auditLog.record({ req, operator_id: p.sub, operator_name: p.name, action: 'auth.logout', target_type: 'user', target_id: p.sub, target_name: p.name, detail: null });
    if (p?.sid) {
      const ses = await ctx.auth.getSession(p.sid);
      if (ses && ses.user_id === p.sub) await ctx.auth.revokeSession(p.sid);
    }
    return reply.code(204).send();
  });

  // ---------------- 迭代 5：「我的」页 ----------------

  const noBot = (me: { via_bot?: boolean }, reply: Parameters<typeof fail>[0]) => {
    if (!me.via_bot) return false;
    fail(reply, 403, '这个操作不允许由机器人代办，请本人在 App 里操作', { code: 'BOT_SCOPE_DENIED' });
    return true;
  };

  app.post('/api/v1/users/me/password', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me || noBot(me, reply)) return;
    const { old_password, new_password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof old_password !== 'string' || typeof new_password !== 'string') {
      return invalid(reply, [
        ...(typeof old_password !== 'string' ? [{ field: 'old_password', message: '不能为空' }] : []),
        ...(typeof new_password !== 'string' ? [{ field: 'new_password', message: '不能为空' }] : []),
      ]);
    }
    const user = await repo.getUser(me.sub);
    if (!user || !verifyPassword(old_password, user.password_hash)) {
      return fail(reply, 400, '当前密码不正确', { code: 'INVALID_PASSWORD' });
    }
    const problem = passwordProblem(new_password, await ctx.auth.getSecurity());
    if (problem) return fail(reply, 400, problem, { code: 'WEAK_PASSWORD' });
    if (old_password === new_password) return fail(reply, 400, '新密码不能和当前密码相同', { code: 'WEAK_PASSWORD' });
    await repo.updateUser(me.sub, { password_hash: hashPassword(new_password), updated_at: nowIso() });
    ctx.invalidateUser(me.sub);
    await ctx.auth.updateState(me.sub, (st) => ({ ...st, must_change_password: false }));
    // 其他设备立即失效，当前设备保留
    await ctx.auth.revokeAll(me.sub, me.sid);
    return reply.code(204).send();
  });

  app.get('/api/v1/users/me/sessions', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me || noBot(me, reply)) return;
    const items = (await ctx.auth.listSessions(me.sub)).map((x) => ({
      session_id: x.session_id,
      device_name: x.device_name,
      platform: x.platform,
      ip: x.ip,
      last_active_at: x.last_active_at,
      created_at: x.created_at,
      current: x.session_id === me.sid,
    }));
    return { items, total: items.length, page_token: null, has_more: false };
  });

  app.delete('/api/v1/users/me/sessions/:session_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me || noBot(me, reply)) return;
    const { session_id } = req.params as { session_id: string };
    const ses = await ctx.auth.getSession(session_id);
    if (!ses || ses.user_id !== me.sub || ses.revoked) return fail(reply, 404, '登录设备不存在或已退出', { code: 'NOT_FOUND' });
    await ctx.auth.revokeSession(session_id);
    return reply.code(204).send();
  });

  app.post('/api/v1/users/me/logout-all', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me || noBot(me, reply)) return;
    const revoked = await ctx.auth.revokeAll(me.sub, me.sid);
    return { revoked };
  });

  // 头像：公开地址（图片组件无法带令牌）。只返回用户主动设置为头像的图片。
  app.get('/api/v1/users/:user_id/avatar', async (req, reply) => {
    const { user_id } = req.params as { user_id: string };
    const st = await ctx.auth.getState(user_id);
    const key = st.avatar_file_key;
    const meta = key ? await repo.getFile(key) : undefined;
    if (!key || !meta || !ctx.fileStore.exists(key)) return fail(reply, 404, '没有头像', { code: 'NOT_FOUND' });
    reply
      .header('content-type', meta.content_type ?? 'image/png')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=86400')
      .header('content-length', ctx.fileStore.sizeOf(key));
    return reply.send(ctx.fileStore.stream(key));
  });

  // ---------------- 迭代 5：安全设置（R-AD-05） ----------------

  app.get('/api/v1/admin/security-settings', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    if (!(await ctx.roles.has(me.user, 'admin.security'))) return fail(reply, 403, '没有安全设置权限', { code: 'FORBIDDEN' });
    return ctx.auth.getSecurity();
  });

  app.put('/api/v1/admin/security-settings', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me || noBot(me, reply)) return;
    if (!(await ctx.roles.has(me.user, 'admin.security'))) return fail(reply, 403, '没有安全设置权限', { code: 'FORBIDDEN' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { settings, errors } = mergeSecurity(await ctx.auth.getSecurity(), body);
    if (errors.length) return invalid(reply, errors, errors[0].message);
    const before = await ctx.auth.getSecurity();
    await ctx.auth.saveSecurity(settings);
    const diff = Object.keys(settings).filter((k) => (before as unknown as Record<string, unknown>)[k] !== (settings as unknown as Record<string, unknown>)[k]).map((k) => `${k}: ${(before as unknown as Record<string, unknown>)[k]} → ${(settings as unknown as Record<string, unknown>)[k]}`);
    await ctx.auditLog.record({ req, operator_id: me.sub, operator_name: me.user.name, action: 'security.update', target_type: 'security', target_id: 'security', target_name: '安全设置', detail: diff.join('；') || '无变化' });
    return settings;
  });

  // ---------------- 迭代 5：管理员强制下线 / 重置密码（R-AD-01） ----------------

  app.post('/api/v1/users/:user_id/logout-all', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me || noBot(me, reply)) return;
    if (!(await ctx.roles.has(me.user, 'admin.members'))) return fail(reply, 403, '没有成员管理权限', { code: 'FORBIDDEN' });
    const { user_id } = req.params as { user_id: string };
    if (!(await repo.getUser(user_id))) return fail(reply, 404, '用户不存在', { code: 'NOT_FOUND' });
    const target = (await repo.getUser(user_id))!;
    const revoked = await ctx.auth.revokeAll(user_id, user_id === me.sub ? me.sid : undefined);
    await ctx.auditLog.record({ req, operator_id: me.sub, operator_name: me.user.name, action: 'user.logout_all', target_type: 'user', target_id: user_id, target_name: target.name, detail: `下线 ${revoked} 台设备` });
    return { revoked };
  });

  app.post('/api/v1/users/:user_id/reset-password', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me || noBot(me, reply)) return;
    if (!(await ctx.roles.has(me.user, 'admin.members'))) return fail(reply, 403, '没有成员管理权限', { code: 'FORBIDDEN' });
    const { user_id } = req.params as { user_id: string };
    const target = await repo.getUser(user_id);
    if (!target || target.role === 'bot') return fail(reply, 404, '用户不存在', { code: 'NOT_FOUND' });
    const password = randomPassword((await ctx.auth.getSecurity()).password_min_length);
    await repo.updateUser(user_id, { password_hash: hashPassword(password), updated_at: nowIso() });
    ctx.invalidateUser(user_id);
    await ctx.auth.updateState(user_id, (st) => ({ ...st, must_change_password: true, failed_count: 0, locked_until: null }));
    await ctx.auth.revokeAll(user_id, user_id === me.sub ? me.sid : undefined);
    await ctx.auditLog.record({ req, operator_id: me.sub, operator_name: me.user.name, action: 'user.reset_password', target_type: 'user', target_id: user_id, target_name: target.name, detail: null });
    return { password };
  });

  app.get('/api/v1/users/me', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    return selfUser(ctx, me.user);
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
    // 迭代 5：头像用上传后的 file_key（null 清除）
    let avatarKey: string | null | undefined;
    if (body.avatar_file_key !== undefined) {
      if (body.avatar_file_key === null || body.avatar_file_key === '') avatarKey = null;
      else if (typeof body.avatar_file_key !== 'string') errors.push({ field: 'avatar_file_key', message: '必须是字符串' });
      else {
        const f = await repo.getFile(body.avatar_file_key);
        if (!f || !f.uploaded_at || !(await ctx.canAccessFile(me, f))) errors.push({ field: 'avatar_file_key', message: '文件不存在或还没上传完成' });
        else if (!/^image\/(png|jpeg|gif|webp)$/.test(f.content_type ?? '')) errors.push({ field: 'avatar_file_key', message: '头像必须是图片' });
        else avatarKey = f.file_key;
      }
    }
    if (errors.length) return invalid(reply, errors);
    if (avatarKey !== undefined) {
      await ctx.auth.updateState(me.sub, (st) => ({ ...st, avatar_file_key: avatarKey ?? null }));
      patch.avatar_url = avatarKey
        ? `${publicBase(req)}/api/v1/users/${encodeURIComponent(me.sub)}/avatar?v=${encodeURIComponent(avatarKey.slice(-12))}`
        : null;
    }
    const updated = await repo.updateUser(me.sub, patch);
    ctx.invalidateUser(me.sub);
    return selfUser(ctx, updated!);
  });

}

export function collectProfile(body: Record<string, unknown>, errors: FieldError[], admin: boolean): UserPatch {
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
