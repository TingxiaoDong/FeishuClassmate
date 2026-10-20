/**
 * 多维表格服务层：表结构解析（内置表 + 覆盖层 / 自定义表）、结构变更串行化、
 * 全表扫描、视图读取、实时事件（R-BT-05）。字段 / 视图 / 记录三组路由共用。
 */

import { ALL_TABLES, type TableDef } from '../../src/bitable/schema.js';
import { newId, type AuthedUser, type Ctx } from './context.js';
import { agentState, viaBotFor } from './agent-context.js';
import { nowIso, type TableViewRecord } from './repo.js';
import { hasRowAccessRule } from './row-access.js';
import type { StoredRecord } from './store.js';
import { builtinSchema, customSchema, schemaToDef, type TableSchema } from './table-schema.js';
import { defaultViewConfig, sanitizeViewConfig, type Clock } from './view-engine.js';
import { personIdsOf } from './validation.js';

/** 表名 / 描述 / 图标覆盖层（通用实体表，id = 表 key）。 */
export const TABLE_META_KIND = 'table_meta';

export interface ResolvedTable {
  schema: TableSchema;
  def: TableDef;
  /** 内置表是否已有覆盖层（决定保存时插入还是按版本更新）。 */
  hasOverride: boolean;
}

const BUILTIN = new Map(ALL_TABLES.map((t) => [t.key, t]));
const CACHE_MS = 3_000;
const CUSTOM_KEY_RE = /^tbl_[a-z0-9]+$/;

export function recordJson(r: StoredRecord) {
  return {
    record_id: r.record_id,
    fields: r.fields,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by ?? null,
    updated_by: r.updated_by ?? null,
  };
}

export class TableService {
  private readonly cache = new Map<string, { at: number; res: ResolvedTable }>();
  private readonly registered = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ctx: Ctx,
    readonly clock: Clock,
  ) {}

  isBuiltin(key: string): boolean {
    return BUILTIN.has(key);
  }

  builtinDef(key: string): TableDef | undefined {
    return BUILTIN.get(key);
  }

  /** 同一张表的结构 / 视图变更串行执行（跨实例靠版本号兜底）。 */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  /** 解析表结构；fresh = 跳过缓存（结构变更前用）。不存在返回 undefined。 */
  async load(key: string, fresh = false): Promise<ResolvedTable | undefined> {
    const hit = this.cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.res;
    const { repo } = this.ctx;
    let res: ResolvedTable | undefined;
    const base = BUILTIN.get(key);
    if (base) {
      const override = await repo.getTableSchema(key);
      const schema = builtinSchema(base, override);
      res = { schema, def: override ? schemaToDef(schema, base) : base, hasOverride: !!override };
    } else if (CUSTOM_KEY_RE.test(key)) {
      const t = await repo.getCustomTable(key);
      if (t) {
        const schema = customSchema(t);
        res = { schema, def: schemaToDef(schema), hasOverride: true };
        this.ctx.customTables.set(key, t);
      }
    }
    if (!res) {
      this.cache.delete(key);
      return undefined;
    }
    // 表名 / 描述 / 图标的修改（PATCH /tables/:key）单独存，内置表和自定义表都适用
    const meta = await repo.getEntity(TABLE_META_KIND, key);
    if (meta) {
      const m = meta.data as { name?: string; description?: string | null; icon?: string };
      res = {
        ...res,
        schema: { ...res.schema, ...(m.name ? { name: m.name } : {}), ...(m.description !== undefined ? { description: m.description } : {}), ...(m.icon ? { icon: m.icon } : {}) },
        def: m.name ? { ...res.def, name: m.name } : res.def,
      };
    }
    await this.apply(res, hit?.res.schema.version !== res.schema.version || !hit);
    return res;
  }

  /** 把结构写进缓存、ctx.tableDefs 和存储层。 */
  async apply(res: ResolvedTable, changed = true): Promise<void> {
    const key = res.schema.key;
    if (!res.schema.builtin && !this.registered.has(key)) {
      await this.ctx.store.registerTable?.(res.def);
      this.registered.add(key);
    } else if (changed) {
      await this.ctx.store.updateDef?.(res.def);
    }
    this.ctx.tableDefs.set(key, res.def);
    this.cache.set(key, { at: Date.now(), res });
  }

  forget(key: string): void {
    this.cache.delete(key);
    this.registered.delete(key);
  }

  /** 内置表（固定顺序）+ 自定义表（按创建时间）。 */
  async listAll(): Promise<ResolvedTable[]> {
    const out: ResolvedTable[] = [];
    for (const t of ALL_TABLES) {
      const r = await this.load(t.key);
      if (r) out.push(r);
    }
    for (const t of await this.ctx.repo.listCustomTables()) {
      const hit = this.cache.get(t.key);
      if (hit && hit.res.schema.version === (t.version ?? 1)) {
        out.push(hit.res);
        continue;
      }
      const schema = customSchema(t);
      const res = { schema, def: schemaToDef(schema), hasOverride: true };
      this.ctx.customTables.set(t.key, t);
      await this.apply(res);
      out.push(res);
    }
    return out;
  }

  /** 全表记录（按创建时间），confidentialFor 给出时过滤掉该用户看不到的保密记录。 */
  async scanAll(
    key: string,
    opts: { filter?: string; keyword?: string; confidentialFor?: string } = {},
  ): Promise<StoredRecord[]> {
    const out: StoredRecord[] = [];
    let token: string | undefined;
    for (;;) {
      const page = await this.ctx.store.list(key, {
        ...opts,
        sort: 'created_at asc',
        pageSize: 5000,
        pageToken: token,
      });
      out.push(...page.items);
      if (!page.has_more || !page.page_token) break;
      token = page.page_token;
    }
    return out;
  }

  // ---------------- 视图 ----------------

  /** 这张表的视图；还没有公共视图时自动建默认的「表格视图」（固定 id，多实例幂等）。 */
  async views(key: string): Promise<TableViewRecord[]> {
    const { repo } = this.ctx;
    let list = await repo.listViews(key);
    if (!list.some((v) => !v.personal)) {
      const now = nowIso();
      await repo.insertView({
        view_id: `vew_default_${key}`,
        table_key: key,
        name: '表格视图',
        type: 'grid',
        personal: false,
        owner_id: null,
        config: defaultViewConfig(),
        version: 1,
        position: 0,
        created_by: 'system',
        created_at: now,
        updated_at: now,
      });
      list = await repo.listViews(key);
    }
    return list;
  }

  viewVisible(v: TableViewRecord, me: { sub: string }): boolean {
    return !v.personal || v.owner_id === me.sub;
  }

  viewJson(v: TableViewRecord, res: ResolvedTable, me: AuthedUser, canEditTable: boolean) {
    const mine = v.personal ? v.owner_id === me.sub : canEditTable;
    return {
      view_id: v.view_id,
      name: v.name,
      type: v.type,
      personal: v.personal,
      owner_id: v.owner_id,
      config: sanitizeViewConfig(v.config, res.schema.fields),
      version: v.version,
      created_by: v.created_by,
      created_at: v.created_at,
      updated_at: v.updated_at,
      permissions: { can_view: true, can_edit: mine, can_comment: false, can_manage: mine, can_delete: mine },
    };
  }

  // ---------------- 实时事件 ----------------

  emitSchemaChanged(key: string, version: number): void {
    this.ctx.publish('table.schema_changed', { table_key: key, version }, undefined, {
      topic: `table:${key}`,
      all: true,
      user_only: true,
    });
  }

  /**
   * table.view_changed：公共视图推给订阅了这张表的所有人，个人视图只推给本人。
   * 公共 ↔ 个人切换时（prev 是改之前的状态），其他人分别收到 deleted / created。
   */
  emitViewChanged(
    key: string,
    v: TableViewRecord,
    action: 'created' | 'updated' | 'deleted',
    prev?: { personal: boolean; owner_id: string | null },
  ): void {
    const topic = `table:${key}`;
    const send = (act: string, audience: string[] | undefined, scope: Record<string, unknown>) =>
      this.ctx.publish('table.view_changed', { table_key: key, view_id: v.view_id, action: act }, audience, {
        topic,
        user_only: true,
        ...scope,
      });
    const ownerOf = (o: string | null) => (o ? [o] : []);
    if (prev && prev.personal !== v.personal) {
      if (v.personal) {
        // 公共 → 个人：其他人看到「删除」
        send('deleted', undefined, { all: true, deny: ownerOf(v.owner_id) });
        send(action, ownerOf(v.owner_id), {});
      } else {
        // 个人 → 公共：其他人看到「新建」
        send('created', undefined, { all: true, deny: ownerOf(prev.owner_id) });
        send(action, ownerOf(prev.owner_id), {});
      }
      return;
    }
    if (v.personal) send(action, ownerOf(v.owner_id), {});
    else send(action, undefined, { all: true });
  }

  /**
   * record.changed：保密记录只推给负责人和管理员；
   * 记录从公开变成保密时，其他人收到 deleted（行从他们的表格里消失）。
   */
  async emitRecord(
    def: TableDef,
    action: 'created' | 'updated' | 'deleted',
    recordId: string,
    operatorId: string,
    opts: { record?: StoredRecord; before?: StoredRecord; changed?: string[] } = {},
  ): Promise<void> {
    await this.saveHistory(def, action, recordId, operatorId, opts).catch(() => undefined);
    this.publishRecord(def, action, recordId, operatorId, opts);
  }

  /**
   * 记录修改记录（AGENT_PLAN M2）：每次增 / 改 / 删记一条，机器人代办的标 via_bot，
   * App 显示「飞书同学 代 XX 修改」。实体 kind=record_history，scope=表|记录。
   */
  private async saveHistory(
    def: TableDef,
    action: 'created' | 'updated' | 'deleted',
    recordId: string,
    operatorId: string,
    opts: { record?: StoredRecord; before?: StoredRecord; changed?: string[] },
  ): Promise<void> {
    const short = (v: unknown) => {
      const t = JSON.stringify(v ?? null);
      return t.length > 500 ? `${t.slice(0, 500)}…` : v ?? null;
    };
    let changes: Array<{ field_name: string; before: unknown; after: unknown }> = [];
    if (action === 'created' && opts.record) {
      changes = Object.entries(opts.record.fields)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => ({ field_name: k, before: null, after: short(v) }));
    } else if (action === 'updated') {
      changes = (opts.changed ?? [])
        .filter((k) => JSON.stringify(opts.before?.fields[k] ?? null) !== JSON.stringify(opts.record?.fields[k] ?? null))
        .map((k) => ({ field_name: k, before: short(opts.before?.fields[k]), after: short(opts.record?.fields[k]) }));
      if (!changes.length) return;
    }
    const now = nowIso();
    const st = agentState();
    const viaBot = viaBotFor(operatorId);
    await this.ctx.repo.saveEntity(
      {
        kind: 'record_history',
        id: newId('rh'),
        scope: `${def.key}|${recordId}`,
        data: {
          operator_id: operatorId,
          at: now,
          action,
          changes,
          ...(viaBot ? { via_bot: true, operator_via: 'bot', confirm_card: st?.confirm_card ?? null } : {}),
        },
        version: 0,
        created_at: now,
        updated_at: now,
      },
      0,
    );
  }

  private publishRecord(
    def: TableDef,
    action: 'created' | 'updated' | 'deleted',
    recordId: string,
    operatorId: string,
    opts: { record?: StoredRecord; before?: StoredRecord; changed?: string[] } = {},
  ): void {
    const topic = `table:${def.key}`;
    const confidential = (r?: StoredRecord) => !!r && hasRowAccessRule(def) && r.fields.visibility === '保密';
    const owners = (r: StoredRecord) => personIdsOf(r.fields.owner_open_id);
    const base: Record<string, unknown> = {
      table_key: def.key,
      action,
      record_id: recordId,
      operator_id: operatorId,
      ...(opts.changed ? { changed_fields: opts.changed } : {}),
    };
    const pub = (payload: Record<string, unknown>, audience: string[] | undefined, scope: Record<string, unknown>) =>
      this.ctx.publish('record.changed', payload, audience, { topic, user_only: true, ...scope });

    if (action === 'deleted') {
      const b = opts.before;
      if (b && confidential(b)) pub(base, owners(b), { admins: true });
      else pub(base, undefined, { all: true });
      return;
    }
    const rec = opts.record!;
    const payload = { ...base, record: recordJson(rec) };
    if (confidential(rec)) {
      pub(payload, owners(rec), { admins: true });
      if (action === 'updated' && opts.before && !confidential(opts.before)) {
        pub({ ...base, action: 'deleted' }, undefined, { all: true, deny: owners(rec), deny_admins: true });
      }
    } else {
      pub(payload, undefined, { all: true });
    }
  }
}
