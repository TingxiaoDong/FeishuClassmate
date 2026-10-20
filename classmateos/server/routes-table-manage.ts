/**
 * 多维表格：表权限、表管理、记录评论（迭代 4/5 R-BT-09、R-BT-10、R-BT-08；
 * 开关 table.permissions / table.manage / record.comments）。
 *
 *   GET    /tables/:key/permissions          {owner_id, visibility, members, version, my_role}
 *   PUT    /tables/:key/permissions          {visibility: all | members, members, version?}；要 can_manage
 *   PATCH  /tables/:key                      {name?, description?, icon?}；要 can_manage
 *   POST   /tables/:key/copy                 {name, with_records?}；要能看到原表 + 权限点 table.create
 *   DELETE /tables/:key                      要 can_delete（自定义表、can_manage、权限点 table.delete）
 *   GET    /tables/:key/records/:id/comments 按时间正序
 *   POST   /tables/:key/records/:id/comments {content: {text, mentions}}；能看到记录就能评论
 *   DELETE /tables/:key/records/:id/comments/:comment_id  本人或表管理者
 *
 * 能否看到表由 table-access.ts 的统一钩子先检查。
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { NotificationService } from './notifications.js';
import { fail, invalid, newId, pageResult, type AuthedUser, type Ctx, type FieldError } from './context.js';
import { CUSTOM_FIELD_TYPES } from './custom-tables.js';
import { parseRichText } from './doc-extras.js';
import { nowIso, type CustomTableRecord, type EntityRecord, type ResourceGrant } from './repo.js';
import { resourceRole, validateGrant } from './resource-access.js';
import { canAccessRecord } from './row-access.js';
import { tableAccessOf } from './table-access.js';
import { customSchema, describeSchema, schemaToDef } from './table-schema.js';
import { TABLE_META_KIND, type ResolvedTable, type TableService } from './table-service.js';

const MAX_NAME = 50;
const MAX_DESC = 500;
const COPY_MAX_RECORDS = 10_000;
const COMMENT = 'record_comment';
// 同一毫秒写入的评论 created_at 相同：再按写入序号排（进程内单调递增，跨重启也大于之前的值）
let lastCommentSeq = 0;
const nextCommentSeq = () => (lastCommentSeq = Math.max(lastCommentSeq + 1, Date.now() * 1000));
const commentOrder = (a: EntityRecord, b: EntityRecord) =>
  a.created_at.localeCompare(b.created_at) ||
  (Number(a.data.seq) || 0) - (Number(b.data.seq) || 0) ||
  a.id.localeCompare(b.id);

export function registerTableManageRoutes(ctx: Ctx, svc: TableService, opts: { reservedNames: Set<string>; notifications?: NotificationService }): void {
  const { app, repo, store } = ctx;
  const access = tableAccessOf(ctx);

  async function load(req: FastifyRequest, reply: FastifyReply, fresh = false) {
    const me = await ctx.requireUser(req, reply);
    if (!me) return undefined;
    const key = (req.params as { table_key: string }).table_key;
    const res = await svc.load(key, fresh);
    if (!res) {
      fail(reply, 404, `数据表不存在：${key}`, { code: 'TABLE_NOT_FOUND' });
      return undefined;
    }
    const grant = await access.grant(res.schema);
    const flags = await access.flags(me, res.schema, grant);
    if (!flags.can_view) {
      fail(reply, 403, '没有权限访问这张表', { code: 'TABLE_FORBIDDEN' });
      return undefined;
    }
    return { me, res, grant, flags };
  }

  /** 名称是否已被其他表占用（内置表原名 + 所有表的当前名称，大小写不敏感）。 */
  async function nameTaken(name: string, exceptKey?: string): Promise<boolean> {
    const n = name.trim().toLowerCase();
    if (opts.reservedNames.has(n)) return !exceptKey || !svc.isBuiltin(exceptKey);
    return (await svc.listAll()).some((r) => r.schema.key !== exceptKey && r.schema.name.trim().toLowerCase() === n);
  }

  const allUserIds = async () => (await repo.listUsers({ limit: 1_000_000, offset: 0 })).items.filter((u) => !u.disabled && u.role !== 'bot').map((u) => u.user_id);

  const grantJson = async (g: ResourceGrant, me: AuthedUser) => ({
    owner_id: g.owner_id || null,
    visibility: g.visibility,
    members: g.members,
    version: g.version,
    my_role: await resourceRole(repo, me.sub, g),
  });

  // ---------------------------------------------------------------- 表权限

  app.get('/api/v1/tables/:table_key/permissions', async (req, reply) => {
    const r = await load(req, reply);
    if (!r) return;
    return grantJson(r.grant, r.me);
  });

  app.put('/api/v1/tables/:table_key/permissions', async (req, reply) => {
    const r = await load(req, reply);
    if (!r) return;
    if (!r.flags.can_manage) return fail(reply, 403, '只有表的管理者可以设置权限', { code: 'FORBIDDEN' });
    const body = (req.body ?? {}) as { visibility?: unknown; members?: unknown; version?: unknown };
    if (body.version !== undefined && body.version !== r.grant.version) return fail(reply, 409, '权限已被别人修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
    const next: ResourceGrant = {
      ...r.grant,
      visibility: (body.visibility ?? r.grant.visibility) as ResourceGrant['visibility'],
      members: (body.members ?? r.grant.members) as ResourceGrant['members'],
    };
    // 内置表没有所有者：校验时用当前管理员占位
    const errors = await validateGrant(repo, next.owner_id ? next : { ...next, owner_id: r.me.sub });
    if (errors.length) return invalid(reply, errors, errors[0].message);
    if (!(await repo.saveResourceGrant(next, r.grant.version))) return fail(reply, 409, '权限已被别人修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
    const saved = (await repo.getResourceGrant('table', r.res.schema.key)) ?? next;
    await ctx.auditLog.record({ req, operator_id: r.me.sub, operator_name: r.me.user.name, action: 'table.permission', target_type: 'table', target_id: r.res.schema.key, target_name: r.res.schema.name, detail: `可见范围：${saved.visibility}，协作者 ${saved.members.length} 个` });
    ctx.publish('table.schema_changed', { table_key: r.res.schema.key, reason: 'permissions' }, await allUserIds(), { user_only: true });
    return grantJson(saved, r.me);
  });

  // ---------------------------------------------------------------- 表管理

  app.patch('/api/v1/tables/:table_key', async (req, reply) => {
    const r = await load(req, reply, true);
    if (!r) return;
    if (!r.flags.can_manage) return fail(reply, 403, '只有表的管理者可以修改表信息', { code: 'FORBIDDEN' });
    const body = (req.body ?? {}) as { name?: unknown; description?: unknown; icon?: unknown };
    const errors: FieldError[] = [];
    const key = r.res.schema.key;
    const cur = (await repo.getEntity(TABLE_META_KIND, key))?.data ?? {};
    const next: Record<string, unknown> = { ...cur };
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > MAX_NAME) errors.push({ field: 'name', message: `不能为空，且不超过 ${MAX_NAME} 字` });
      else if (await nameTaken(body.name, key)) return fail(reply, 409, `已经有名为「${body.name.trim()}」的数据表了，请换一个名称`, { code: 'TABLE_NAME_EXISTS' });
      else next.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (body.description !== null && (typeof body.description !== 'string' || body.description.length > MAX_DESC)) errors.push({ field: 'description', message: `不超过 ${MAX_DESC} 字` });
      else next.description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null;
    }
    if (body.icon !== undefined) {
      if (typeof body.icon !== 'string' || !body.icon.trim() || body.icon.length > 64) errors.push({ field: 'icon', message: '图标必须是 1～64 位字符串' });
      else next.icon = body.icon.trim();
    }
    if (errors.length) return invalid(reply, errors, errors[0].message);
    const now = nowIso();
    const meta = await repo.getEntity(TABLE_META_KIND, key);
    const ok = await repo.saveEntity({ kind: TABLE_META_KIND, id: key, scope: 'global', data: next, version: meta?.version ?? 0, created_at: meta?.created_at ?? now, updated_at: now }, meta?.version ?? 0);
    if (!ok) return fail(reply, 409, '表信息已被别人修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
    const fresh = (await svc.load(key, true))!;
    ctx.publish('table.schema_changed', { table_key: key, reason: 'meta' }, await allUserIds(), { user_only: true });
    return describeSchema(fresh.schema, r.me, await access.flags(r.me, fresh.schema));
  });

  app.post('/api/v1/tables/:table_key/copy', async (req, reply) => {
    const r = await load(req, reply);
    if (!r) return;
    if (!(await ctx.roles.has(r.me.user, 'table.create'))) return fail(reply, 403, '没有新建数据表的权限', { code: 'FORBIDDEN' });
    const body = (req.body ?? {}) as { name?: unknown; with_records?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > MAX_NAME) return invalid(reply, [{ field: 'name', message: `不能为空，且不超过 ${MAX_NAME} 字` }]);
    const name = body.name.trim();
    if (await nameTaken(name)) return fail(reply, 409, `已经有名为「${name}」的数据表了，请换一个名称`, { code: 'TABLE_NAME_EXISTS' });
    const src = r.res.schema;
    // 自定义表只支持部分字段类型：内置表里其他类型的字段不复制
    const fields = src.fields.filter((f) => f.type in CUSTOM_FIELD_TYPES).map((f) => ({
      field_name: f.field_name, title: f.title, type: f.type, required: f.required, description: f.description ?? null,
      ...(f.options ? { options: [...f.options], option_colors: { ...(f.option_colors ?? {}) } } : {}),
    }));
    const primary = fields.some((f) => f.field_name === src.primary_field) ? src.primary_field : fields.find((f) => f.type === 1)?.field_name;
    if (!primary) return fail(reply, 422, '这张表没有可以复制的文本字段作为主字段', { code: 'VALIDATION_FAILED' });
    let key = '';
    for (let i = 0; i < 10 && !key; i++) {
      const k = `tbl_${randomBytes(5).toString('hex')}`;
      if (!svc.isBuiltin(k) && !(await repo.getCustomTable(k))) key = k;
    }
    const now = nowIso();
    const rec: CustomTableRecord = {
      key, name, description: src.description, icon: src.icon ?? 'table', primary_field: primary, fields,
      created_by: r.me.sub, created_at: now, updated_at: now, client_request_id: null, version: 1,
    };
    if ((await repo.insertCustomTable(rec)) === 'name_exists') return fail(reply, 409, `已经有名为「${name}」的数据表了，请换一个名称`, { code: 'TABLE_NAME_EXISTS' });
    const schema = customSchema(rec);
    const res: ResolvedTable = { schema, def: schemaToDef(schema), hasOverride: true };
    ctx.customTables.set(key, rec);
    await svc.apply(res);
    let copied = 0;
    if (body.with_records === true) {
      const rows = (await svc.scanAll(src.key)).filter((x) => canAccessRecord(r.me, r.res.def, x)).slice(0, COPY_MAX_RECORDS);
      const names = new Set(fields.map((f) => f.field_name));
      for (const row of rows) {
        const data = Object.fromEntries(Object.entries(row.fields).filter(([k, v]) => names.has(k) && v !== null && v !== undefined));
        await store.create(key, data, r.me.sub);
        copied++;
      }
    }
    ctx.publish('table.created', { table_key: key }, undefined, { all: true, user_only: true });
    return reply.code(201).send({ ...describeSchema(schema, r.me, await access.flags(r.me, schema)), copied_records: copied });
  });

  app.delete('/api/v1/tables/:table_key', async (req, reply) => {
    const r = await load(req, reply, true);
    if (!r) return;
    if (r.res.schema.builtin) return fail(reply, 400, '内置数据表不能删除', { code: 'BUILTIN_TABLE' });
    if (!r.flags.can_delete) return fail(reply, 403, '没有删除这张表的权限', { code: 'FORBIDDEN' });
    const key = r.res.schema.key;
    await svc.withLock(key, async () => {
      for (const v of await repo.listViews(key)) await repo.deleteView(v.view_id);
      await repo.deleteEntity(TABLE_META_KIND, key);
      await repo.deleteCustomTable(key);
      svc.forget(key);
      ctx.tableDefs.delete(key);
      ctx.customTables.delete(key);
      await store.dropTable?.(key).catch(() => undefined);
    });
    await ctx.auditLog.record({ req, operator_id: r.me.sub, operator_name: r.me.user.name, action: 'table.delete', target_type: 'table', target_id: key, target_name: r.res.schema.name, detail: null });
    ctx.publish('table.deleted', { table_key: key }, undefined, { all: true, user_only: true });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- 记录评论

  async function record(req: FastifyRequest, reply: FastifyReply) {
    const r = await load(req, reply);
    if (!r) return undefined;
    const { record_id } = req.params as { record_id: string };
    const rec = await store.get(r.res.schema.key, record_id);
    if (!rec || !canAccessRecord(r.me, r.res.def, rec)) {
      fail(reply, 404, '记录不存在', { code: 'NOT_FOUND' });
      return undefined;
    }
    return { ...r, rec, scope: `${r.res.schema.key}:${record_id}` };
  }

  const commentJson = (e: EntityRecord, me: string, canManage: boolean) => ({
    comment_id: e.id,
    user_id: e.data.user_id,
    content: e.data.content,
    created_at: e.created_at,
    can_delete: e.data.user_id === me || canManage,
  });

  app.get('/api/v1/tables/:table_key/records/:record_id/comments', async (req, reply) => {
    const r = await record(req, reply);
    if (!r) return;
    const items = (await repo.listEntities(COMMENT, r.scope)).sort(commentOrder).map((e) => commentJson(e, r.me.sub, r.flags.can_manage));
    return pageResult(items, items.length, 0);
  });

  app.post('/api/v1/tables/:table_key/records/:record_id/comments', async (req, reply) => {
    const r = await record(req, reply);
    if (!r) return;
    if (!r.flags.can_comment) return fail(reply, 403, '没有评论权限', { code: 'FORBIDDEN' });
    const errors: FieldError[] = [];
    const content = parseRichText((req.body as { content?: unknown } | null)?.content, 'content', errors);
    if (errors.length || !content) return invalid(reply, errors, errors[0]?.message);
    const now = nowIso();
    const e: EntityRecord = { kind: COMMENT, id: newId('rc'), scope: r.scope, data: { user_id: r.me.sub, content, table_key: r.res.schema.key, record_id: r.rec.record_id, seq: nextCommentSeq() }, version: 0, created_at: now, updated_at: now };
    await repo.saveEntity(e, 0);
    if (opts.notifications) {
      const name = await ctx.userName(r.me.sub);
      const title = String(r.rec.fields[r.res.schema.primary_field ?? ''] ?? '').slice(0, 40) || '记录';
      for (const uid of new Set(content.mentions.map((m) => m.user_id))) {
        if (uid === r.me.sub) continue;
        const u = await repo.getUser(uid);
        if (!u || !(await access.canView({ sub: uid, role: u.role, user: u }, r.res.schema)) || !canAccessRecord({ sub: uid, role: u.role } as never, r.res.def, r.rec)) continue;
        await opts.notifications.notify({ user_id: uid, type: 'record.mention', actor_id: r.me.sub, title: `${name} 在「${r.res.schema.name}」的记录「${title}」中提到了你`, summary: content.text.slice(0, 80), target: { type: 'record', table_key: r.res.schema.key, id: r.rec.record_id, comment_id: e.id } });
      }
    }
    return reply.code(201).send(commentJson(e, r.me.sub, r.flags.can_manage));
  });

  app.delete('/api/v1/tables/:table_key/records/:record_id/comments/:comment_id', async (req, reply) => {
    const r = await record(req, reply);
    if (!r) return;
    const { comment_id } = req.params as { comment_id: string };
    const e = await repo.getEntity(COMMENT, comment_id);
    if (!e || e.scope !== r.scope) return fail(reply, 404, '评论不存在', { code: 'NOT_FOUND' });
    if (e.data.user_id !== r.me.sub && !r.flags.can_manage) return fail(reply, 403, '只能删除自己的评论', { code: 'FORBIDDEN' });
    await repo.deleteEntity(COMMENT, comment_id);
    return reply.code(204).send();
  });
}
