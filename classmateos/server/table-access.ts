/**
 * 多维表格表级权限（迭代 4/5 R-BT-09，开关 table.permissions）。
 *
 * 授权存在资源授权表（resource_type = 'table'）：
 *   visibility  all     组织内所有人可编辑（默认，和一期行为一致）
 *               members 只有所有者、管理员和 members 里的人能看到
 *   members     [{member_type: user | department | chat, member_id, role: viewer | editor | manager}]
 * 所有者：自定义表是创建人；内置表没有所有者（owner_id 为空），由系统管理员管理。
 *
 * 权限：
 *   can_view     看表、记录、视图；可评论记录、导出
 *   can_edit     增删改记录、导入、建共享视图
 *   can_manage   改表名 / 描述 / 图标、字段管理、表权限
 *   can_delete   删表：表的创建人可以删；其他管理者还要有权限点 table.delete；内置表不能删
 * 机器人本身（不是代办）不受表权限限制；机器人代办按被代办同学的权限。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthedUser, Ctx } from './context.js';
import { fail } from './context.js';
import type { ResourceGrant } from './repo.js';
import { permissionFlags, resourceRole, type ResourceRole } from './resource-access.js';
import type { TableSchema } from './table-schema.js';

export interface TableFlags { can_view: boolean; can_edit: boolean; can_comment: boolean; can_manage: boolean; can_delete: boolean }

type Who = { sub: string; role: string; user?: AuthedUser['user']; via_bot?: boolean };

const ALL: TableFlags = { can_view: true, can_edit: true, can_comment: true, can_manage: true, can_delete: true };

export class TableAccess {
  constructor(private ctx: Ctx) {}

  async grant(schema: TableSchema): Promise<ResourceGrant> {
    return (await this.ctx.repo.getResourceGrant('table', schema.key)) ?? {
      resource_type: 'table', resource_id: schema.key, owner_id: schema.builtin ? '' : (schema.created_by ?? ''),
      visibility: 'all', members: [], version: 0,
    };
  }

  async role(who: Who, schema: TableSchema, grant?: ResourceGrant): Promise<ResourceRole | null> {
    return resourceRole(this.ctx.repo, who.sub, grant ?? (await this.grant(schema)));
  }

  async flags(who: Who, schema: TableSchema, grant?: ResourceGrant): Promise<TableFlags> {
    if (who.role === 'bot' && !who.via_bot) return { ...ALL, can_delete: !schema.builtin };
    const role = await this.role(who, schema, grant);
    const f = permissionFlags(role);
    let canDeletePoint = false;
    if (f.can_manage && !schema.builtin) {
      const g = grant ?? (await this.grant(schema));
      const user = who.user ?? (await this.ctx.repo.getUser(who.sub));
      canDeletePoint = g.owner_id === who.sub || (!!user && (await this.ctx.roles.has(user, 'table.delete')));
    }
    return { can_view: f.can_view, can_edit: f.can_edit, can_comment: f.can_view, can_manage: f.can_manage, can_delete: f.can_manage && canDeletePoint };
  }

  async canView(who: Who, schema: TableSchema): Promise<boolean> {
    return (await this.flags(who, schema)).can_view;
  }

  /**
   * 统一挡在 /api/v1/tables/:table_key/** 前面：看不到表 → 403；写操作要 can_edit。
   * 管理类接口（改表、删表、改权限、字段管理）在各自的处理函数里再检查 can_manage / can_delete。
   */
  install(load: (key: string) => Promise<{ schema: TableSchema } | undefined>) {
    const { app } = this.ctx;
    const prefix = '/api/v1/tables/:table_key';
    /** 只要能看就能调的非 GET 接口。 */
    const viewOnly = new Set([`POST ${prefix}/records/:record_id/comments`, `POST ${prefix}/copy`, `POST ${prefix}/exports`]);
    /** 自己在处理函数里判断权限的接口。 */
    const selfChecked = new Set([`PUT ${prefix}/permissions`, `PATCH ${prefix}`, `DELETE ${prefix}`]);
    app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      const url = req.routeOptions?.url ?? '';
      if (url !== prefix && !url.startsWith(`${prefix}/`)) return;
      const key = (req.params as { table_key?: string }).table_key;
      if (!key) return;
      const me = await this.ctx.requireUser(req, reply);
      if (!me) return reply;
      const res = await load(key);
      if (!res) return; // 交给处理函数返回 404
      const sig = `${req.method} ${url}`;
      // 视图接口：个人视图看得到表就能建 / 改，由视图路由自己细分
      const isView = url.startsWith(`${prefix}/views`);
      const f = await this.flags(me, res.schema);
      if (!f.can_view) return fail(reply, 403, '没有权限访问这张表', { code: 'TABLE_FORBIDDEN' });
      if (req.method === 'GET' || viewOnly.has(sig) || selfChecked.has(sig) || isView) return;
      if (!f.can_edit) return fail(reply, 403, '没有编辑这张表的权限', { code: 'FORBIDDEN' });
    });
  }
}

const cache = new WeakMap<Ctx, TableAccess>();
export function tableAccessOf(ctx: Ctx): TableAccess {
  let a = cache.get(ctx);
  if (!a) cache.set(ctx, (a = new TableAccess(ctx)));
  return a;
}
