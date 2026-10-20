/**
 * 迭代 5 批次 2：管理后台（R-AD-01 成员管理、R-AD-03 角色、R-AD-04 操作日志）。
 * 部门树在 routes-departments.ts；安全设置、重置密码、强制下线在 routes-auth.ts。
 *
 * 防越权：
 *   - 成员管理要 admin.members；改角色（含 PATCH /users 里的 role_ids）还要 admin.roles；
 *   - 不能授予自己没有的权限点；超级管理员角色的成员只能由超级管理员变更；
 *   - 不能停用自己；超级管理员至少保留 1 名在职成员。
 *   - 这些接口机器人都不能代办。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword } from './auth.js';
import { passwordProblem, randomPassword } from './auth-service.js';
import { auditCsv, type AuditQuery } from './audit-log.js';
import { fail, invalid, pageOffset, pageResult, pageSize, type AuthedUser, type Ctx, type FieldError } from './context.js';
import type { Organization } from './organization.js';
import type { PermissionPoint } from './permissions.js';
import { nowIso, type UserRecord } from './repo.js';
import { RoleError, RoleService, SUPER, accountRoleFor } from './roles.js';
import { collectProfile, userView } from './routes-auth.js';
import type { JobData } from './routes-automation.js';

const USERNAME_RE = /^[\w.@-]{2,64}$/;

export function registerAdminRoutes(ctx: Ctx): void {
  const { app, repo } = ctx;

  const allUsers = async () => (await repo.listUsers({ limit: 1_000_000, offset: 0 })).items;
  const activeAudience = async () => (await allUsers()).filter((u) => !u.disabled && u.role !== 'bot').map((u) => u.user_id);

  /** 鉴权 + 不许机器人代办 + 权限点。通过返回当前用户。 */
  async function guard(req: FastifyRequest, reply: FastifyReply, ...points: PermissionPoint[]): Promise<AuthedUser | undefined> {
    const me = await ctx.requireUser(req, reply);
    if (!me) return undefined;
    if (me.via_bot) {
      fail(reply, 403, '这个操作不允许由机器人代办，请本人在 App 里操作', { code: 'BOT_SCOPE_DENIED' });
      return undefined;
    }
    for (const p of points) {
      if (!(await ctx.roles.has(me.user, p))) {
        fail(reply, 403, '没有权限执行这个操作', { code: 'FORBIDDEN', permission: p });
        return undefined;
      }
    }
    return me;
  }

  const roleFail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof RoleError) return fail(reply, e.status, e.message, { code: e.code });
    throw e;
  };

  async function adminView(u: UserRecord, org?: Organization) {
    const st = await ctx.auth.getState(u.user_id);
    return {
      ...(await userView(ctx, u, org)),
      username: u.user_id,
      status: u.disabled ? 'disabled' : 'active',
      last_login_at: st.last_login_at,
      role_ids: await ctx.roles.roleIds(u),
    };
  }

  const audit = (req: FastifyRequest, me: AuthedUser, action: string, target: { type: string; id: string; name: string | null }, detail: string | null) =>
    ctx.auditLog.record({ req, operator_id: me.sub, operator_name: me.user.name, action, target_type: target.type, target_id: target.id, target_name: target.name, detail });

  /**
   * 设置一批用户的角色（整体覆盖每人的角色列表），带防越权校验；同步账号身份、推 permissions.changed。
   * changes: user_id → 新角色列表。
   */
  async function applyRoles(me: AuthedUser, changes: Map<string, string[]>): Promise<void> {
    const myPerms = await ctx.roles.permissionsOf(me.user);
    if (!myPerms.includes('admin.roles')) throw new RoleError(403, '没有角色管理权限', 'FORBIDDEN');
    const iAmSuper = await ctx.roles.isSuper(me.user);
    const users = await allUsers();
    const byId = new Map(users.map((u) => [u.user_id, u]));
    const affected: string[] = [];
    await ctx.roles.change((s) => {
      affected.length = 0;
      for (const [uid, next] of changes) {
        const u = byId.get(uid);
        if (!u || u.role === 'bot') throw new RoleError(422, `成员不存在：${uid}`, 'VALIDATION_FAILED');
        const unknown = next.filter((id) => !s.roles.some((r) => r.role_id === id));
        if (unknown.length) throw new RoleError(422, `角色不存在：${unknown.join('、')}`, 'VALIDATION_FAILED');
        const cur = ctx.roles.roleIdsOf(s, u);
        const added = next.filter((id) => !cur.includes(id));
        const removed = cur.filter((id) => !next.includes(id));
        if (!added.length && !removed.length) continue;
        if ((added.includes(SUPER) || removed.includes(SUPER)) && !iAmSuper) throw new RoleError(403, '只有超级管理员可以变更超级管理员', 'FORBIDDEN');
        for (const id of added) {
          const beyond = (s.roles.find((r) => r.role_id === id)?.permissions ?? []).filter((p) => !myPerms.includes(p));
          if (beyond.length) throw new RoleError(403, `不能分配含有你自己没有的权限的角色（${beyond.join('、')}）`, 'FORBIDDEN');
        }
        s.assignments[uid] = [...new Set(next)];
        affected.push(uid);
      }
      const supers = users.filter((u) => !u.disabled && u.role !== 'bot' && ctx.roles.roleIdsOf(s, u).includes(SUPER));
      if (!supers.length) throw new RoleError(400, '至少要保留 1 名超级管理员');
    });
    for (const uid of affected) await afterRoleChange(uid);
  }

  async function afterRoleChange(uid: string) {
    const u = await repo.getUser(uid);
    if (!u || u.role === 'bot') return;
    const want = accountRoleFor(await ctx.roles.roleIds(u));
    if (u.role !== want) await repo.updateUser(uid, { role: want, updated_at: nowIso() });
    ctx.invalidateUser(uid);
    ctx.publish('permissions.changed', { user_id: uid }, [uid], { user_only: true });
  }

  /** 部门 / 上级字段校验并写入组织架构。 */
  async function applyOrg(uid: string, body: Record<string, unknown>, errors: FieldError[]): Promise<(() => Promise<void>) | undefined> {
    const keys = ['department_ids', 'primary_department_id', 'leader_id'].filter((k) => body[k] !== undefined);
    if (!keys.length) return undefined;
    const s = await ctx.org.read();
    let ids: string[] | undefined;
    if (body.department_ids !== undefined) {
      if (!Array.isArray(body.department_ids) || body.department_ids.some((x) => typeof x !== 'string')) errors.push({ field: 'department_ids', message: '必须是部门 ID 数组' });
      else {
        ids = [...new Set(body.department_ids as string[])];
        const bad = ids.filter((id) => !s.departments.some((d) => d.department_id === id));
        if (bad.length) errors.push({ field: 'department_ids', message: `部门不存在：${bad.join('、')}` });
      }
    }
    const primary = body.primary_department_id;
    if (primary !== undefined && primary !== null && typeof primary !== 'string') errors.push({ field: 'primary_department_id', message: '必须是部门 ID' });
    const leader = body.leader_id;
    if (leader !== undefined && leader !== null) {
      if (typeof leader !== 'string') errors.push({ field: 'leader_id', message: '必须是成员 ID' });
      else if (leader === uid) errors.push({ field: 'leader_id', message: '直属上级不能是自己' });
      else {
        const lu = await repo.getUser(leader);
        if (!lu || lu.role === 'bot') errors.push({ field: 'leader_id', message: '直属上级不存在' });
      }
    }
    return async () => {
      await ctx.org.change((o) => {
        const m = (o.members[uid] ??= { department_ids: [], primary_department_id: null, leader_id: null });
        if (ids) m.department_ids = ids.filter((id) => o.departments.some((d) => d.department_id === id));
        if (primary !== undefined) m.primary_department_id = (primary as string | null) ?? null;
        if (m.primary_department_id && !m.department_ids.includes(m.primary_department_id)) {
          if (primary !== undefined && primary !== null) m.department_ids.push(m.primary_department_id);
          else m.primary_department_id = m.department_ids[0] ?? null;
        }
        if (!m.primary_department_id) m.primary_department_id = m.department_ids[0] ?? null;
        if (leader !== undefined) m.leader_id = (leader as string | null) ?? null;
      });
      // 旧字段 department 同步为主部门名称（搜索、旧客户端仍读它）
      const o = await ctx.org.read();
      const m = o.members[uid];
      const name = o.departments.find((d) => d.department_id === m?.primary_department_id)?.name ?? null;
      await repo.updateUser(uid, { department: name, updated_at: nowIso() });
    };
  }

  function parseRoleIds(v: unknown, errors: FieldError[]): string[] | undefined {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      errors.push({ field: 'role_ids', message: '必须是角色 ID 数组' });
      return undefined;
    }
    return [...new Set(v as string[])];
  }

  // ======================================================== 成员（R-AD-01）

  app.get('/api/v1/users', async (req, reply) => {
    const q = req.query as { keyword?: string; q?: string; department_id?: string; status?: string; include?: string; page_size?: string; page_token?: string };
    const admin = q.include === 'admin';
    const me = admin ? await guard(req, reply, 'admin.members') : await ctx.requireUser(req, reply);
    if (!me) return;
    const org = await ctx.org.read();
    const kw = (q.q ?? q.keyword ?? '').trim().toLowerCase();
    let items = await allUsers();
    if (kw) items = items.filter((u) => [u.name, u.user_id, u.email ?? '', u.phone ?? ''].some((x) => x.toLowerCase().includes(kw)));
    if (q.department_id) items = items.filter((u) => org.members[u.user_id]?.department_ids.includes(q.department_id!));
    if (q.status === 'active') items = items.filter((u) => !u.disabled);
    else if (q.status === 'disabled') items = items.filter((u) => u.disabled);
    if (admin) items = items.filter((u) => u.role !== 'bot');
    const limit = pageSize(q.page_size, 500, 1000);
    const offset = pageOffset(q.page_token);
    const page = items.slice(offset, offset + limit);
    const out = [];
    for (const u of page) out.push(admin ? await adminView(u, org) : await userView(ctx, u, org));
    return pageResult(out, items.length, offset);
  });

  app.get('/api/v1/users/:user_id', async (req, reply) => {
    const admin = (req.query as { include?: string }).include === 'admin';
    const me = admin ? await guard(req, reply, 'admin.members') : await ctx.requireUser(req, reply);
    if (!me) return;
    const { user_id } = req.params as { user_id: string };
    const u = await repo.getUser(user_id);
    if (!u) return fail(reply, 404, '用户不存在', { code: 'NOT_FOUND' });
    return admin ? adminView(u) : userView(ctx, u);
  });

  app.post('/api/v1/users', async (req, reply) => {
    const me = await guard(req, reply, 'admin.members');
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const username = typeof body.username === 'string' ? body.username.trim() : typeof body.user_id === 'string' ? body.user_id.trim() : '';
    if (!USERNAME_RE.test(username)) errors.push({ field: 'username', message: '登录账号需 2～64 位，只能包含字母、数字和 _ . @ -' });
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push({ field: 'name', message: '不能为空' });
    const sec = await ctx.auth.getSecurity();
    let password: string;
    let generated = false;
    if (body.password !== undefined) {
      if (typeof body.password !== 'string') {
        errors.push({ field: 'password', message: '必须是字符串' });
        password = '';
      } else {
        password = body.password;
        const problem = passwordProblem(password, sec);
        if (problem) errors.push({ field: 'password', message: problem });
      }
    } else {
      password = randomPassword(Math.max(12, sec.password_min_length));
      generated = true;
    }
    const patch = collectProfile(body, errors, true);
    delete patch.role; // 角色走 role_ids
    const roleIds = parseRoleIds(body.role_ids, errors);
    const orgApply = await applyOrg(username, body, errors);
    if (errors.length) {
      const pw = errors.find((e) => e.field === 'password');
      if (pw && errors.length === 1) return fail(reply, 400, pw.message, { code: 'WEAK_PASSWORD' });
      return invalid(reply, errors, errors[0].message);
    }
    if ((await repo.getUser(username)) || (await repo.findUserByLogin(username))) {
      return fail(reply, 409, '这个登录账号已经存在', { code: 'USERNAME_EXISTS', errors: [{ field: 'username', message: '这个登录账号已经存在' }] });
    }
    const now = nowIso();
    const user: UserRecord = {
      user_id: username,
      name: (body.name as string).trim(),
      email: patch.email ?? null,
      role: 'member',
      avatar_url: patch.avatar_url ?? null,
      department: null,
      title: patch.title ?? null,
      phone: patch.phone ?? null,
      status_text: patch.status_text ?? null,
      password_hash: hashPassword(password),
      disabled: false,
      created_at: now,
      updated_at: now,
    };
    if (!(await repo.insertUserIfMissing(user))) return fail(reply, 409, '这个登录账号已经存在', { code: 'USERNAME_EXISTS' });
    // 旧格式（role: admin）兼容：换算成角色
    const legacyRole = body.role === 'admin' ? [SUPER] : undefined;
    try {
      if (orgApply) await orgApply();
      else await ctx.org.change((o) => void (o.members[username] ??= { department_ids: [], primary_department_id: null, leader_id: null }));
      const want = roleIds ?? legacyRole;
      if (want) await applyRoles(me, new Map([[username, want]]));
    } catch (e) {
      // 角色越权等：回滚刚建的账号（停用并改随机密码，避免留下可登录账号）
      await repo.updateUser(username, { disabled: true, password_hash: hashPassword(randomPassword(24)), updated_at: nowIso() });
      ctx.invalidateUser(username);
      return roleFail(reply, e);
    }
    await ctx.auth.updateState(username, (st) => ({ ...st, must_change_password: true }));
    ctx.invalidateUser(username);
    const created = (await repo.getUser(username))!;
    await audit(req, me, 'user.create', { type: 'user', id: username, name: created.name }, null);
    ctx.publish('user.updated', { user_id: username }, await activeAudience(), { user_only: true });
    return reply.code(201).send({ ...(await adminView(created)), ...(generated ? { initial_password: password } : {}) });
  });

  app.patch('/api/v1/users/:user_id', async (req, reply) => {
    const me = await guard(req, reply, 'admin.members');
    if (!me) return;
    const { user_id } = req.params as { user_id: string };
    const target = await repo.getUser(user_id);
    if (!target || target.role === 'bot') return fail(reply, 404, '用户不存在', { code: 'NOT_FOUND' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const patch = collectProfile(body, errors, true);
    const legacyRole = patch.role;
    delete patch.role;
    let disable: boolean | undefined;
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'disabled') errors.push({ field: 'status', message: '必须是 active 或 disabled' });
      else disable = body.status === 'disabled';
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== 'boolean') errors.push({ field: 'disabled', message: '必须是 true / false' });
      else disable = body.disabled;
    }
    if (body.password !== undefined) {
      if (typeof body.password !== 'string') errors.push({ field: 'password', message: '必须是字符串' });
      else {
        const problem = passwordProblem(body.password, await ctx.auth.getSecurity());
        if (problem) return fail(reply, 400, problem, { code: 'WEAK_PASSWORD' });
        patch.password_hash = hashPassword(body.password);
      }
    }
    let roleIds = parseRoleIds(body.role_ids, errors);
    if (!roleIds && legacyRole && legacyRole !== 'bot') {
      const cur = await ctx.roles.roleIds(target);
      roleIds = legacyRole === 'admin' ? [...new Set([...cur.filter((r) => r !== 'member'), SUPER])] : cur.filter((r) => r !== SUPER && r !== 'admin').concat(cur.includes('member') ? [] : ['member']);
    }
    const orgApply = await applyOrg(user_id, body, errors);
    if (errors.length) return invalid(reply, errors, errors[0].message);
    if (disable === true) {
      if (user_id === me.sub) return fail(reply, 400, '不能停用自己的账号', { code: 'CANNOT_DISABLE_SELF' });
      const s = await ctx.roles.read(true);
      if (ctx.roles.roleIdsOf(s, target).includes(SUPER)) {
        const others = (await allUsers()).filter((u) => u.user_id !== user_id && !u.disabled && u.role !== 'bot' && ctx.roles.roleIdsOf(s, u).includes(SUPER));
        if (!others.length) return fail(reply, 400, '不能停用最后一名超级管理员', { code: 'LAST_SUPER_ADMIN' });
      }
      if (!(await ctx.roles.isSuper(me.user)) && ctx.roles.roleIdsOf(s, target).includes(SUPER)) {
        return fail(reply, 403, '只有超级管理员可以停用超级管理员', { code: 'FORBIDDEN' });
      }
    }
    if (roleIds) {
      try {
        await applyRoles(me, new Map([[user_id, roleIds]]));
      } catch (e) {
        return roleFail(reply, e);
      }
    }
    if (orgApply) await orgApply();
    if (disable !== undefined) patch.disabled = disable;
    const updated = await repo.updateUser(user_id, patch);
    if (!updated) return fail(reply, 404, '用户不存在', { code: 'NOT_FOUND' });
    ctx.invalidateUser(user_id);
    if (patch.password_hash) await ctx.auth.updateState(user_id, (st) => ({ ...st, must_change_password: true, failed_count: 0, locked_until: null }));
    if (disable === true || patch.password_hash) await ctx.auth.revokeAll(user_id, user_id === me.sub ? me.sid : undefined);
    const changed = Object.keys(body).filter((k) => !['status', 'disabled', 'password'].includes(k));
    if (disable !== undefined && disable !== target.disabled) {
      await audit(req, me, disable ? 'user.disable' : 'user.enable', { type: 'user', id: user_id, name: updated.name }, null);
    }
    if (changed.length || patch.password_hash) {
      await audit(req, me, roleIds ? 'role.change' : 'user.update', { type: 'user', id: user_id, name: updated.name }, `修改：${[...changed, ...(patch.password_hash ? ['password'] : [])].join('、')}`);
    }
    ctx.publish('user.updated', { user_id }, await activeAudience(), { user_only: true });
    return adminView((await repo.getUser(user_id))!);
  });

  // ======================================================== 角色（R-AD-03）

  app.get('/api/v1/roles', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const perms = await ctx.roles.permissionsOf(me.user);
    if (!perms.includes('admin.roles') && !perms.includes('admin.members')) return fail(reply, 403, '没有角色管理权限', { code: 'FORBIDDEN' });
    const s = await ctx.roles.read(true);
    const users = (await allUsers()).filter((u) => !u.disabled);
    const items = s.roles.map((r) => ctx.roles.json(s, r, users));
    return { items, total: items.length, page_token: null, has_more: false };
  });

  const roleBody = (body: Record<string, unknown>, errors: FieldError[], partial: boolean) => {
    const out: { name?: string; description?: string; permissions?: unknown } = {};
    if (body.name !== undefined || !partial) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 50) errors.push({ field: 'name', message: '角色名称不能为空，最多 50 字' });
      else out.name = body.name.trim();
    }
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string' || body.description.length > 200) errors.push({ field: 'description', message: '描述最多 200 字' });
      else out.description = body.description.trim();
    }
    if (body.permissions !== undefined || !partial) out.permissions = body.permissions ?? [];
    return out;
  };

  const roleJson = async (roleId: string) => {
    const s = await ctx.roles.read(true);
    const users = (await allUsers()).filter((u) => !u.disabled);
    const r = s.roles.find((x) => x.role_id === roleId)!;
    return ctx.roles.json(s, r, users);
  };

  app.post('/api/v1/roles', async (req, reply) => {
    const me = await guard(req, reply, 'admin.roles');
    if (!me) return;
    const errors: FieldError[] = [];
    const b = roleBody((req.body ?? {}) as Record<string, unknown>, errors, false);
    if (errors.length) return invalid(reply, errors, errors[0].message);
    try {
      const perms = RoleService.checkPermissions(b.permissions, await ctx.roles.permissionsOf(me.user));
      const id = RoleService.newId();
      await ctx.roles.change((s) => {
        if (s.roles.some((r) => r.name.toLowerCase() === b.name!.toLowerCase())) throw new RoleError(409, '角色名称已存在', 'ROLE_NAME_EXISTS');
        s.roles.push({ role_id: id, name: b.name!, description: b.description ?? '', builtin: false, permissions: perms });
      });
      await audit(req, me, 'role.change', { type: 'role', id, name: b.name! }, `新建角色，权限：${perms.join('、') || '无'}`);
      return reply.code(201).send(await roleJson(id));
    } catch (e) {
      return roleFail(reply, e);
    }
  });

  app.patch('/api/v1/roles/:role_id', async (req, reply) => {
    const me = await guard(req, reply, 'admin.roles');
    if (!me) return;
    const { role_id } = req.params as { role_id: string };
    const errors: FieldError[] = [];
    const b = roleBody((req.body ?? {}) as Record<string, unknown>, errors, true);
    if (errors.length) return invalid(reply, errors, errors[0].message);
    try {
      const perms = b.permissions !== undefined ? RoleService.checkPermissions(b.permissions, await ctx.roles.permissionsOf(me.user)) : undefined;
      let changedPerms = false;
      let name = '';
      await ctx.roles.change((s) => {
        const r = s.roles.find((x) => x.role_id === role_id);
        if (!r) throw new RoleError(404, '角色不存在', 'NOT_FOUND');
        if (role_id === SUPER && perms && perms.length !== r.permissions.length) throw new RoleError(400, '超级管理员的权限不能修改');
        if (b.name && s.roles.some((x) => x.role_id !== role_id && x.name.toLowerCase() === b.name!.toLowerCase())) throw new RoleError(409, '角色名称已存在', 'ROLE_NAME_EXISTS');
        if (b.name) r.name = b.name;
        if (b.description !== undefined) r.description = b.description;
        if (perms && role_id !== SUPER) {
          changedPerms = perms.length !== r.permissions.length || perms.some((p) => !r.permissions.includes(p));
          r.permissions = perms;
        }
        name = r.name;
      });
      if (changedPerms) {
        const s = await ctx.roles.read(true);
        for (const uid of ctx.roles.membersOf(s, role_id, await allUsers())) await afterRoleChange(uid);
      }
      await audit(req, me, 'role.change', { type: 'role', id: role_id, name }, perms ? `权限：${perms.join('、') || '无'}` : '修改名称 / 描述');
      return roleJson(role_id);
    } catch (e) {
      return roleFail(reply, e);
    }
  });

  app.delete('/api/v1/roles/:role_id', async (req, reply) => {
    const me = await guard(req, reply, 'admin.roles');
    if (!me) return;
    const { role_id } = req.params as { role_id: string };
    const users = await allUsers();
    let members: string[] = [];
    let name = '';
    try {
      await ctx.roles.change((s) => {
        const r = s.roles.find((x) => x.role_id === role_id);
        if (!r) throw new RoleError(404, '角色不存在', 'NOT_FOUND');
        if (r.builtin) throw new RoleError(400, '内置角色不能删除');
        name = r.name;
        members = ctx.roles.membersOf(s, role_id, users);
        s.roles = s.roles.filter((x) => x.role_id !== role_id);
        for (const uid of Object.keys(s.assignments)) s.assignments[uid] = s.assignments[uid].filter((id) => id !== role_id);
      });
    } catch (e) {
      return roleFail(reply, e);
    }
    for (const uid of members) await afterRoleChange(uid);
    await audit(req, me, 'role.change', { type: 'role', id: role_id, name }, '删除角色');
    return reply.code(204).send();
  });

  app.put('/api/v1/roles/:role_id/members', async (req, reply) => {
    const me = await guard(req, reply, 'admin.roles');
    if (!me) return;
    const { role_id } = req.params as { role_id: string };
    const { user_ids } = (req.body ?? {}) as { user_ids?: unknown };
    if (!Array.isArray(user_ids) || user_ids.some((x) => typeof x !== 'string') || user_ids.length > 5000) {
      return invalid(reply, [{ field: 'user_ids', message: '必须是成员 ID 数组' }]);
    }
    const s = await ctx.roles.read(true);
    if (!s.roles.some((r) => r.role_id === role_id)) return fail(reply, 404, '角色不存在', { code: 'NOT_FOUND' });
    const users = await allUsers();
    const want = new Set(user_ids as string[]);
    if (role_id === SUPER && ![...want].some((id) => users.some((u) => u.user_id === id && !u.disabled))) {
      return fail(reply, 400, '超级管理员至少要保留 1 人');
    }
    const changes = new Map<string, string[]>();
    for (const u of users) {
      if (u.role === 'bot') continue;
      const cur = ctx.roles.roleIdsOf(s, u);
      const has = cur.includes(role_id);
      if (want.has(u.user_id) && !has) changes.set(u.user_id, [...cur, role_id]);
      if (!want.has(u.user_id) && has) changes.set(u.user_id, cur.filter((id) => id !== role_id));
    }
    const missing = [...want].filter((id) => !users.some((u) => u.user_id === id && u.role !== 'bot'));
    if (missing.length) return invalid(reply, [{ field: 'user_ids', message: `成员不存在：${missing.join('、')}` }]);
    try {
      if (changes.size) await applyRoles(me, changes);
    } catch (e) {
      return roleFail(reply, e);
    }
    const role = await roleJson(role_id);
    if (changes.size) await audit(req, me, 'role.change', { type: 'role', id: role_id, name: role.name }, `成员调整 ${changes.size} 人`);
    return role;
  });

  // ======================================================== 操作日志（R-AD-04）

  const auditQuery = (src: Record<string, unknown>, errors: FieldError[]): AuditQuery => {
    const q: AuditQuery = {};
    for (const k of ['start_at', 'end_at'] as const) {
      const v = src[k];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) errors.push({ field: k, message: '必须是 ISO 时间' });
      else q[k] = v;
    }
    for (const k of ['operator_id', 'action'] as const) {
      const v = src[k];
      if (typeof v === 'string' && v.trim()) q[k] = v.trim();
    }
    return q;
  };

  app.get('/api/v1/audit-logs', async (req, reply) => {
    const me = await guard(req, reply, 'admin.audit');
    if (!me) return;
    const raw = req.query as Record<string, string>;
    const errors: FieldError[] = [];
    const q = auditQuery(raw, errors);
    if (errors.length) return invalid(reply, errors, errors[0].message);
    const all = await ctx.auditLog.query(q);
    const limit = pageSize(raw.page_size, 50, 200);
    const offset = pageOffset(raw.page_token);
    return pageResult(all.slice(offset, offset + limit), all.length, offset);
  });

  app.post('/api/v1/audit-logs/exports', async (req, reply) => {
    const me = await guard(req, reply, 'admin.audit');
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    if (body.format !== undefined && body.format !== 'csv') errors.push({ field: 'format', message: '目前只支持 csv' });
    const q = auditQuery(body, errors);
    if (errors.length) return invalid(reply, errors, errors[0].message);
    const job = await createJob(me.sub, 'audit_export', '导出操作日志');
    void runJob(job, async (update) => {
      const items = await ctx.auditLog.query(q);
      await update({ progress: 0.5, message: `共 ${items.length} 条，正在生成文件` });
      const name = `操作日志_${new Date().toISOString().slice(0, 10)}.csv`;
      const file_key = await saveFile(me.sub, name, auditCsv(items), 'text/csv; charset=utf-8');
      return { file_key, file_name: name, total: items.length };
    });
    await audit(req, me, 'audit.export', { type: 'audit_log', id: job.job_id, name: '操作日志' }, JSON.stringify(q));
    return reply.code(202).send({ job_id: job.job_id });
  });

  // ---------------- 异步任务（复用 agent_job，GET /jobs/:job_id 已有） ----------------

  async function createJob(owner: string, kind: string, title: string): Promise<JobData> {
    const now = nowIso();
    const d: JobData = {
      job_id: `job_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      kind,
      title,
      status: 'pending',
      progress: 0,
      message: null,
      steps: [],
      result: {},
      owner_id: owner,
      chat_id: null,
      session_id: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    await repo.saveEntity({ kind: 'agent_job', id: d.job_id, scope: owner, data: { ...d }, version: 0, created_at: now, updated_at: now }, 0);
    return d;
  }

  async function patchJob(jobId: string, p: Partial<JobData>): Promise<void> {
    for (let i = 0; i < 6; i++) {
      const rec = await repo.getEntity('agent_job', jobId);
      if (!rec) return;
      const now = nowIso();
      const d = { ...(rec.data as unknown as JobData), ...p, updated_at: now };
      if (await repo.saveEntity({ ...rec, data: { ...d }, updated_at: now }, rec.version)) {
        ctx.publish('job.updated', { job: d }, [d.owner_id], { user_only: true });
        return;
      }
    }
  }

  async function runJob(job: JobData, fn: (update: (p: Partial<JobData>) => Promise<void>) => Promise<Record<string, unknown>>) {
    try {
      await patchJob(job.job_id, { status: 'running', progress: 0.1 });
      const result = await fn((p) => patchJob(job.job_id, p));
      await patchJob(job.job_id, { status: 'done', progress: 1, message: null, result, finished_at: nowIso() });
    } catch (e) {
      console.error('[job] failed', job.job_id, e);
      await patchJob(job.job_id, { status: 'failed', message: '任务失败，请稍后重试', finished_at: nowIso() }).catch(() => undefined);
    }
  }

  async function saveFile(owner: string, name: string, data: Buffer, contentType: string): Promise<string> {
    const key = `f_${randomUUID()}_${name.replace(/[^\w.-]/g, '_').slice(-64)}`;
    await ctx.fileStore.write(key, data);
    const now = nowIso();
    await repo.createFile({ file_key: key, file_name: name, size: data.length, content_type: contentType, kind: 'other', uploader_id: owner, created_at: now, uploaded_at: now, in_drive: false, drive_added_at: null });
    return key;
  }

  // ---------------- 删除类操作写日志（doc.delete / record.delete） ----------------

  const DELETE_ROUTES: Record<string, string> = {
    'DELETE /api/v1/docs/:doc_id': 'doc.delete',
    'DELETE /api/v1/tables/:table_key/records/:record_id': 'record.delete',
    'POST /api/v1/tables/:table_key/records/batch_delete': 'record.delete',
  };
  const PENDING = Symbol.for('cos.auditDelete');
  app.addHook('preHandler', async (req) => {
    const action = DELETE_ROUTES[`${req.method} ${req.routeOptions?.url}`];
    if (!action) return;
    const p = req.params as Record<string, string>;
    let name: string | null = null;
    if (action === 'doc.delete') name = (await repo.getDoc(p.doc_id).catch(() => undefined))?.title ?? null;
    (req as unknown as Record<symbol, unknown>)[PENDING] = { action, name };
  });
  app.addHook('onResponse', async (req, reply) => {
    const pending = (req as unknown as Record<symbol, { action: string; name: string | null } | undefined>)[PENDING];
    if (!pending || reply.statusCode >= 300) return;
    const obo = typeof req.headers['x-on-behalf-of'] === 'string' ? req.headers['x-on-behalf-of'] : undefined;
    let op: UserRecord | undefined;
    if (obo && ctx.isBot(req)) op = await repo.getUser(obo);
    else {
      const authed = await ctx.verifyWsToken(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
      op = 'user' in authed ? authed.user : undefined;
    }
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as { record_ids?: unknown };
    const target =
      pending.action === 'doc.delete'
        ? { type: 'doc', id: p.doc_id, name: pending.name }
        : { type: 'record', id: p.record_id ?? (Array.isArray(b.record_ids) ? b.record_ids.slice(0, 20).join(',') : null), name: null };
    await ctx.auditLog.record({
      req,
      operator_id: op?.user_id ?? null,
      operator_name: op ? (obo ? `${op.name}（机器人代办）` : op.name) : null,
      action: pending.action,
      target_type: target.type,
      target_id: target.id,
      target_name: target.name,
      detail: pending.action === 'record.delete' ? `表：${p.table_key}` : null,
    });
  });
}
