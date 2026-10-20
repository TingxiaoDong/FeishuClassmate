/**
 * L2 资源工具（AGENT_PLAN §2.1）：每类平台资源一个工具，用 action 区分。
 *   cos_table / cos_doc / cos_calendar / cos_task / cos_im / cos_drive / cos_contact / cos_notify / cos_search
 * 对应旧栈的 feishu_bitable_* / feishu_*_doc / feishu_calendar / feishu_task / feishu_send_message …
 *
 * 所有调用都「代表发消息的同学」执行：权限、保密记录、审计都按这位同学算。
 */

import { z } from 'zod';
import type { CosClient } from '../../cos-sdk/client.js';
import type { AgentRuntime } from '../../runtime/types.js';
import { enc, fromResult, need, registerCosTool, type Call, type CosToolResult } from './define.js';

// ---------------------------------------------------------------- 确认卡片上的预演说明

const clip = (v: unknown, n = 40) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

interface TableInfo { name: string; primary?: string; titles: Map<string, string> }

async function tableInfo(call: Call, key: string): Promise<TableInfo> {
  const r = await call<{ name?: string; primary_field?: string | null; fields?: Array<{ field_name: string; title?: string }> }>('GET', `/tables/${enc(key)}`);
  if (!r.ok) return { name: key, titles: new Map() };
  return {
    name: r.data.name ?? key,
    primary: r.data.primary_field ?? r.data.fields?.[0]?.field_name,
    titles: new Map((r.data.fields ?? []).map((f) => [f.field_name, f.title ?? f.field_name])),
  };
}

const describeFields = (t: TableInfo, fields: unknown) =>
  Object.entries((fields ?? {}) as Record<string, unknown>)
    .slice(0, 4)
    .map(([k, v]) => `${t.titles.get(k) ?? k}=${clip(v, 24)}`)
    .join('，');

const recFields = (r: unknown): Record<string, unknown> =>
  (r && typeof r === 'object' && 'fields' in r && typeof (r as { fields: unknown }).fields === 'object' ? (r as { fields: Record<string, unknown> }).fields : (r as Record<string, unknown>)) ?? {};

/** 预演：把要删 / 要改的内容列给同学看。 */
async function previewTable(i: { action: string; table_key?: string; record_ids?: string[]; records?: unknown[]; field_name?: string }, call: Call): Promise<string | undefined> {
  if (!i.table_key) return undefined;
  const t = await tableInfo(call, i.table_key);
  switch (i.action) {
    case 'delete_records': {
      const ids = i.record_ids ?? [];
      const lines: string[] = [];
      for (const id of ids.slice(0, 5)) {
        const r = await call<{ fields: Record<string, unknown> }>('GET', `/tables/${enc(i.table_key)}/records/${enc(id)}`);
        lines.push(`· ${r.ok ? clip(t.primary ? r.data.fields[t.primary] : describeFields(t, r.data.fields)) || id : `${id}（找不到或没有权限）`}`);
      }
      const more = ids.length > 5 ? `\n……另外还有 ${ids.length - 5} 条` : '';
      return `将从「${t.name}」删除 ${ids.length} 条记录：\n${lines.join('\n')}${more}\n删除后不能撤销。`;
    }
    case 'delete_field':
      return `将删除「${t.name}」的字段「${t.titles.get(i.field_name ?? '') ?? i.field_name}」，这一列的数据会全部丢失，不能撤销。`;
    case 'update_records': {
      const recs = i.records ?? [];
      const sample = recs.slice(0, 3).map((r) => `· ${String((r as { record_id?: unknown }).record_id ?? '')}：${describeFields(t, recFields(r))}`);
      return `将修改「${t.name}」的 ${recs.length} 条记录，示例：\n${sample.join('\n')}`;
    }
    case 'create_records': {
      const recs = i.records ?? [];
      const sample = recs.slice(0, 3).map((r) => `· ${describeFields(t, recFields(r))}`);
      return `将向「${t.name}」新增 ${recs.length} 条记录，示例：\n${sample.join('\n')}`;
    }
  }
  return undefined;
}

/** 删除单个对象前：取标题给同学看。 */
async function previewDelete(call: Call, kind: string, path: string, titleOf: (d: Record<string, unknown>) => unknown): Promise<string> {
  const r = await call<Record<string, unknown>>('GET', path);
  const title = r.ok ? clip(titleOf(r.data), 60) : '';
  return `将删除${kind}${title ? `「${title}」` : ''}，删除后不能撤销。`;
}

// ---------------------------------------------------------------- 公共

const msTime = z.number().int().describe('毫秒时间戳（北京时间换算后的 epoch ms）');

/** 字段类型：友好名 → 平台类型编号（与 classmateos/server/table-schema.ts FIELD_TYPES 一致）。 */
export const FIELD_TYPE_IDS: Record<string, number> = {
  text: 1, 文本: 1,
  number: 2, 数字: 2,
  single_select: 3, 单选: 3,
  multi_select: 4, 多选: 4,
  date: 5, 日期: 5,
  checkbox: 7, 复选框: 7,
  person: 11, 人员: 11,
  url: 15, 超链接: 15,
  attachment: 17, 附件: 17,
};
const fieldType = z
  .union([z.enum(Object.keys(FIELD_TYPE_IDS) as [string, ...string[]]), z.number().int()])
  .describe('字段类型：text / number / single_select / multi_select / date / checkbox / person / url / attachment');
const typeId = (t: string | number) => (typeof t === 'number' ? t : FIELD_TYPE_IDS[t]);

const fieldDef = z.object({
  title: z.string().describe('字段显示名，如「借用人」'),
  type: fieldType,
  field_name: z.string().optional().describe('字段英文名（小写字母开头，只含小写字母数字下划线）；不填自动生成'),
  options: z.array(z.string()).optional().describe('单选 / 多选的选项'),
  required: z.boolean().optional(),
});

/** 字段英文名：标题本身是英文就转 snake_case，否则 f1、f2…（平台只接受小写字母开头）。 */
export function autoFieldName(title: string, index: number, used: Set<string>): string {
  let base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base) || base.length > 40) base = `f${index + 1}`;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
  used.add(name);
  return name;
}

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// ---------------------------------------------------------------- cos_table

const tableSchema = z.object({
  action: z.enum([
    'list_tables', 'get_table', 'create_table',
    'list_records', 'get_record', 'create_records', 'update_records', 'delete_records',
    'add_field', 'update_field', 'delete_field',
    'list_views', 'create_view',
  ]),
  table_key: z.string().optional().describe('数据表 key（list_tables 返回的 key）'),
  name: z.string().optional().describe('create_table：表名；create_view：视图名'),
  description: z.string().optional(),
  fields: z.array(fieldDef).min(1).optional().describe('create_table：字段列表，第一个字段默认作为主字段'),
  record_id: z.string().optional(),
  records: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('create_records：每项是 {字段英文名: 值}；update_records：每项是 {record_id, fields:{…}}。人员字段值写 [{"id":"user_id"}]，日期写毫秒时间戳'),
  record_ids: z.array(z.string()).optional().describe('delete_records'),
  filter: z.string().optional().describe('list_records 筛选，如 status="进行中" AND budget>=1000'),
  sort: z.string().optional().describe('list_records 排序，如「due desc」'),
  keyword: z.string().optional(),
  view_id: z.string().optional(),
  page_size: z.number().int().min(1).max(500).optional(),
  page_token: z.string().optional(),
  field_name: z.string().optional().describe('update_field / delete_field'),
  field: fieldDef.partial().optional().describe('add_field：新字段；update_field：要改的属性'),
  view_type: z.enum(['grid', 'kanban', 'calendar', 'gantt', 'gallery']).optional(),
  view_config: z.record(z.string(), z.unknown()).optional().describe('如看板 {kanban_field:"status"}'),
});

function registerTable(runtime: AgentRuntime, client: CosClient) {
  registerCosTool(runtime, client, {
    name: 'cos_table',
    description:
      'ClassmateOS 多维表格：列表 / 查看结构 / 新建数据表，记录的查、增、改、删，字段和视图管理。' +
      '操作记录前先 get_table 看字段英文名和类型。删除、或一次改动超过 20 条时，系统会自动发确认卡片给同学，直接调用即可。',
    schema: tableSchema,
    risk: {
      create_table: 'write', create_records: 'write', update_records: 'write', add_field: 'write',
      update_field: 'write', create_view: 'write', delete_records: 'destructive', delete_field: 'destructive',
    },
    bulk: (i) => (i.action === 'create_records' || i.action === 'update_records' ? (i.records?.length ?? 0) : 0),
    preview: (i, call) => previewTable(i as Parameters<typeof previewTable>[0], call),
    async run(i, call, ctx) {
      const t = i.table_key ? `/tables/${enc(i.table_key)}` : '';
      const miss = (keys: Array<keyof typeof i & string>) => need(i, i.action, keys);
      switch (i.action) {
        case 'list_tables': {
          const r = await call<{ items: Array<Record<string, unknown>> }>('GET', '/tables');
          if (!r.ok) return fromResult(r);
          const items = r.data.items.map((x) => ({ key: x.key ?? x.table_key, name: x.name, description: x.description, record_count: x.record_count }));
          return { ok: true, data: items, summary: `共 ${items.length} 张数据表` };
        }
        case 'get_table':
          return miss(['table_key']) ?? fromResult(await call('GET', t), undefined, () => [`cos://table/${i.table_key}`]);
        case 'create_table': {
          const m = miss(['name', 'fields']);
          if (m) return m;
          const used = new Set<string>();
          const fields = i.fields!.map((f, idx) => {
            const type = typeId(f.type);
            return {
              field_name: f.field_name ?? autoFieldName(f.title, idx, used),
              title: f.title,
              type,
              // 平台要求主字段（第一个）必填
              required: idx === 0 ? true : (f.required ?? false),
              ...(f.options && (type === 3 || type === 4) ? { options: f.options } : {}),
            };
          });
          const r = await call<Record<string, unknown>>('POST', '/tables', {
            body: {
              name: i.name,
              description: i.description,
              primary_field: fields[0].field_name,
              fields,
              client_request_id: `agent_${ctx.toolCallId}`.slice(0, 128),
            },
          });
          return fromResult(r, (d) => `已建表「${i.name}」，key=${String(d.key ?? d.table_key)}`, (d) => [`cos://table/${String(d.key ?? d.table_key)}`]);
        }
        case 'list_records': {
          const m = miss(['table_key']);
          if (m) return m;
          const r = await call<{ items: unknown[]; total?: number; has_more?: boolean }>('GET', `${t}/records`, {
            query: { filter: i.filter, sort: i.sort, keyword: i.keyword, view_id: i.view_id, page_size: i.page_size ?? 50, page_token: i.page_token },
          });
          return fromResult(r, (d) => `本页 ${d.items.length} 条${d.total !== undefined ? `，共 ${d.total} 条` : ''}${d.has_more ? '，还有更多（用 page_token 翻页）' : ''}`);
        }
        case 'get_record':
          return miss(['table_key', 'record_id']) ?? fromResult(await call('GET', `${t}/records/${enc(i.record_id!)}`));
        case 'create_records': {
          const m = miss(['table_key', 'records']);
          if (m) return m;
          const recs = i.records!.map((r) => ('fields' in r && typeof r.fields === 'object' ? r.fields : r));
          if (recs.length === 1) {
            const r = await call<{ record_id: string }>('POST', `${t}/records`, { body: { fields: recs[0] } });
            return fromResult(r, (d) => `已新增 1 条记录 ${d.record_id}`, () => [`cos://table/${i.table_key}`]);
          }
          let ok = 0;
          const failed: unknown[] = [];
          for (const [ci, part] of chunk(recs, 100).entries()) {
            const r = await call<{ succeeded?: unknown[]; failed?: Array<{ index: number; message: string }> }>('POST', `${t}/records/batch_create`, {
              body: { records: part.map((fields) => ({ fields })) },
            });
            if (!r.ok) return { ...fromResult(r), summary: `前 ${ok} 条已成功写入` };
            ok += r.data.succeeded?.length ?? 0;
            for (const f of r.data.failed ?? []) failed.push({ ...f, index: f.index + ci * 100 });
          }
          return { ok: failed.length === 0, data: { created: ok, failed }, summary: `新增 ${ok} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`, links: [`cos://table/${i.table_key}`] };
        }
        case 'update_records': {
          const m = miss(['table_key', 'records']);
          if (m) return m;
          const bad = i.records!.find((r) => typeof r.record_id !== 'string' || typeof r.fields !== 'object');
          if (bad) return { ok: false, error: 'update_records 每项都要有 record_id 和 fields' };
          if (i.records!.length === 1) {
            const one = i.records![0] as { record_id: string; fields: unknown };
            return fromResult(await call('PATCH', `${t}/records/${enc(one.record_id)}`, { body: { fields: one.fields } }), () => '已更新 1 条记录');
          }
          return fromResult(await call('POST', `${t}/records/batch_update`, { body: { records: i.records } }), () => `已提交 ${i.records!.length} 条记录的修改`);
        }
        case 'delete_records': {
          const m = miss(['table_key', 'record_ids']);
          if (m) return m;
          return fromResult(await call('POST', `${t}/records/batch_delete`, { body: { record_ids: i.record_ids } }), () => `已删除 ${i.record_ids!.length} 条记录`);
        }
        case 'add_field': {
          const m = miss(['table_key', 'field']);
          if (m) return m;
          const f = i.field!;
          if (!f.title || f.type === undefined) return { ok: false, error: 'add_field 需要 field.title 和 field.type' };
          const body: Record<string, unknown> = { title: f.title, type: typeId(f.type) };
          if (f.field_name) body.field_name = f.field_name;
          if (f.options) body.options = f.options;
          if (f.required !== undefined) body.required = f.required;
          return fromResult(await call('POST', `${t}/fields`, { body }), () => `已加字段「${f.title}」`);
        }
        case 'update_field': {
          const m = miss(['table_key', 'field_name', 'field']);
          if (m) return m;
          const body: Record<string, unknown> = { ...i.field };
          if (body.type !== undefined) body.type = typeId(body.type as string | number);
          return fromResult(await call('PATCH', `${t}/fields/${enc(i.field_name!)}`, { body }), () => '字段已修改');
        }
        case 'delete_field':
          return miss(['table_key', 'field_name']) ?? fromResult(await call('DELETE', `${t}/fields/${enc(i.field_name!)}`), () => '字段已删除');
        case 'list_views':
          return miss(['table_key']) ?? fromResult(await call('GET', `${t}/views`));
        case 'create_view': {
          const m = miss(['table_key', 'name', 'view_type']);
          if (m) return m;
          return fromResult(await call('POST', `${t}/views`, { body: { name: i.name, type: i.view_type, config: i.view_config ?? {} } }), () => `已建视图「${i.name}」`);
        }
      }
    },
  });
}

// ---------------------------------------------------------------- cos_doc

const docSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'append', 'delete', 'list_comments', 'add_comment']),
  doc_id: z.string().optional(),
  title: z.string().optional(),
  markdown: z.string().optional().describe('create / update（整体替换）/ append（追加到末尾）的 Markdown 正文'),
  keyword: z.string().optional(),
  text: z.string().optional().describe('add_comment：评论内容（针对全文）'),
  page_size: z.number().int().min(1).max(100).optional(),
});

function registerDoc(runtime: AgentRuntime, client: CosClient) {
  registerCosTool(runtime, client, {
    name: 'cos_doc',
    description:
      'ClassmateOS 云文档（Markdown）：搜索列表、读取、新建、整体改写、追加内容、删除、评论。' +
      '改已有文档优先用 append；update 会整体替换正文，改之前先 get 拿到原文。',
    schema: docSchema,
    risk: { create: 'write', update: 'write', append: 'write', add_comment: 'write', delete: 'destructive' },
    preview: async (i, call) => (i.action === 'delete' && i.doc_id ? previewDelete(call, '文档', `/docs/${enc(i.doc_id)}`, (d) => d.title) : undefined),
    async run(i, call) {
      const d = i.doc_id ? `/docs/${enc(i.doc_id)}` : '';
      const link = (x: { doc_id?: string }) => (x.doc_id ? [`cos://doc/${x.doc_id}`] : []);
      switch (i.action) {
        case 'list':
          return fromResult(await call('GET', '/docs', { query: { keyword: i.keyword, page_size: i.page_size ?? 30 } }));
        case 'get':
          return need(i, 'get', ['doc_id']) ?? fromResult(await call<{ doc_id: string }>('GET', d), undefined, link);
        case 'create': {
          const m = need(i, 'create', ['title']);
          if (m) return m;
          return fromResult(
            await call<{ doc_id: string }>('POST', '/docs', { body: { title: i.title, markdown: i.markdown ?? '' } }),
            (x) => `已创建文档「${i.title}」(${x.doc_id})`,
            link,
          );
        }
        case 'update': {
          const m = need(i, 'update', ['doc_id']);
          if (m) return m;
          if (i.title === undefined && i.markdown === undefined) return { ok: false, error: 'update 需要 title 或 markdown' };
          const current = await call<{ updated_at: string }>('GET', d);
          if (!current.ok) return fromResult(current);
          return fromResult(await call<{ doc_id: string }>('PATCH', d, { body: { title: i.title, markdown: i.markdown, base_updated_at: current.data.updated_at } }), () => '文档已更新', link);
        }
        case 'append': {
          const m = need(i, 'append', ['doc_id', 'markdown']);
          if (m) return m;
          // 读 → 拼 → 带 base_updated_at 写；有人同时在改（409）就重试一次
          for (let attempt = 0; attempt < 2; attempt++) {
            const cur = await call<{ markdown: string; updated_at: string }>('GET', d);
            if (!cur.ok) return fromResult(cur);
            const sep = cur.data.markdown && !cur.data.markdown.endsWith('\n') ? '\n\n' : cur.data.markdown ? '\n' : '';
            const r = await call<{ doc_id: string }>('PATCH', d, {
              body: { markdown: `${cur.data.markdown}${sep}${i.markdown}`, base_updated_at: cur.data.updated_at },
            });
            if (r.ok || r.status !== 409) return fromResult(r, () => '已追加到文档末尾', link);
          }
          return { ok: false, error: '文档正被别人频繁修改，追加失败，请稍后再试' };
        }
        case 'delete':
          return need(i, 'delete', ['doc_id']) ?? fromResult(await call('DELETE', d), () => '文档已删除');
        case 'list_comments':
          return need(i, 'list_comments', ['doc_id']) ?? fromResult(await call('GET', `${d}/comments`));
        case 'add_comment': {
          const m = need(i, 'add_comment', ['doc_id', 'text']);
          if (m) return m;
          return fromResult(await call('POST', `${d}/comments`, { body: { is_whole: true, content: { text: i.text, mentions: [] } } }), () => '评论已发布');
        }
      }
    },
  });
}

// ---------------------------------------------------------------- cos_calendar

const calSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete', 'rsvp']),
  event_id: z.string().optional(),
  start_ms: msTime.optional(),
  end_ms: msTime.optional(),
  user_id: z.string().optional().describe('list：查看某位同学的日程（忙闲）'),
  title: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendee_ids: z.array(z.string()).optional().describe('参会人 user_id（用 cos_contact search 查）'),
  all_day: z.boolean().optional(),
  rsvp: z.enum(['accepted', 'declined', 'tentative', 'pending']).optional(),
});

function registerCalendar(runtime: AgentRuntime, client: CosClient) {
  registerCosTool(runtime, client, {
    name: 'cos_calendar',
    description: 'ClassmateOS 日历：按时间段查日程（可查别人忙闲）、建日程并邀请参会人、修改、取消、回复邀请。时间一律用毫秒时间戳。',
    schema: calSchema,
    risk: { create: 'write', update: 'write', rsvp: 'write', delete: 'destructive' },
    preview: async (i, call) =>
      i.action === 'delete' && i.event_id ? previewDelete(call, '日程', `/calendar/events/${enc(i.event_id)}`, (d) => d.title ?? d.summary) : undefined,
    async run(i, call) {
      const e = i.event_id ? `/calendar/events/${enc(i.event_id)}` : '';
      const body = () => {
        const b: Record<string, unknown> = {};
        for (const k of ['title', 'description', 'location', 'attendee_ids', 'all_day', 'start_ms', 'end_ms'] as const) {
          if (i[k] !== undefined) b[k] = i[k];
        }
        return b;
      };
      switch (i.action) {
        case 'list':
          return need(i, 'list', ['start_ms', 'end_ms']) ?? fromResult(await call('GET', '/calendar/events', { query: { start_ms: i.start_ms, end_ms: i.end_ms, user_id: i.user_id } }));
        case 'get':
          return need(i, 'get', ['event_id']) ?? fromResult(await call('GET', e));
        case 'create':
          return need(i, 'create', ['title', 'start_ms', 'end_ms']) ??
            fromResult(await call<{ event_id: string }>('POST', '/calendar/events', { body: body() }), (x) => `已建日程「${i.title}」`, (x) => [`cos://calendar/${x.event_id}`]);
        case 'update':
          return need(i, 'update', ['event_id']) ?? fromResult(await call('PATCH', e, { body: body() }), () => '日程已修改');
        case 'delete':
          return need(i, 'delete', ['event_id']) ?? fromResult(await call('DELETE', e), () => '日程已取消');
        case 'rsvp':
          return need(i, 'rsvp', ['event_id', 'rsvp']) ?? fromResult(await call('POST', `${e}/rsvp`, { body: { rsvp: i.rsvp } }), () => '已回复');
      }
    },
  });
}

// ---------------------------------------------------------------- cos_task

const taskSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete', 'comment', 'list_comments', 'subtasks', 'list_tasklists']),
  task_id: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  assignee_id: z.string().nullable().optional().describe('负责人 user_id'),
  due_ms: msTime.nullable().optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  parent_id: z.string().optional().describe('create：作为某任务的子任务'),
  list_id: z.string().optional().describe('create：放进哪个任务清单'),
  created_by: z.string().optional().describe('list 筛选'),
  text: z.string().optional().describe('comment：评论内容'),
});

function registerTask(runtime: AgentRuntime, client: CosClient) {
  registerCosTool(runtime, client, {
    name: 'cos_task',
    description: 'ClassmateOS 任务：查任务（按负责人 / 状态筛）、建任务并指派、改状态 / 截止时间 / 负责人、评论、子任务、任务清单。',
    schema: taskSchema,
    risk: { create: 'write', update: 'write', comment: 'write', delete: 'destructive' },
    preview: async (i, call) => (i.action === 'delete' && i.task_id ? previewDelete(call, '任务', `/tasks/${enc(i.task_id)}`, (d) => d.title) : undefined),
    async run(i, call) {
      const tk = i.task_id ? `/tasks/${enc(i.task_id)}` : '';
      const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => (i as Record<string, unknown>)[k] !== undefined).map((k) => [k, (i as Record<string, unknown>)[k]]));
      switch (i.action) {
        case 'list':
          return fromResult(await call('GET', '/tasks', { query: { assignee_id: i.assignee_id ?? undefined, status: i.status, created_by: i.created_by } }));
        case 'get':
          return need(i, 'get', ['task_id']) ?? fromResult(await call('GET', tk));
        case 'create':
          return need(i, 'create', ['title']) ??
            fromResult(
              await call<{ task_id: string }>('POST', '/tasks', { body: pick(['title', 'description', 'assignee_id', 'due_ms', 'priority', 'parent_id', 'list_id']) }),
              (x) => `已建任务「${i.title}」(${x.task_id})`,
              (x) => [`cos://task/${x.task_id}`],
            );
        case 'update':
          return need(i, 'update', ['task_id']) ?? fromResult(await call('PATCH', tk, { body: pick(['title', 'description', 'assignee_id', 'due_ms', 'status', 'priority']) }), () => '任务已更新');
        case 'delete':
          return need(i, 'delete', ['task_id']) ?? fromResult(await call('DELETE', tk), () => '任务已删除');
        case 'comment':
          return need(i, 'comment', ['task_id', 'text']) ?? fromResult(await call('POST', `${tk}/comments`, { body: { content: { text: i.text, mentions: [] } } }), () => '评论已发布');
        case 'list_comments':
          return need(i, 'list_comments', ['task_id']) ?? fromResult(await call('GET', `${tk}/comments`));
        case 'subtasks':
          return need(i, 'subtasks', ['task_id']) ?? fromResult(await call('GET', `${tk}/subtasks`));
        case 'list_tasklists':
          return fromResult(await call('GET', '/tasklists'));
      }
    },
  });
}

// ---------------------------------------------------------------- cos_im

const imSchema = z.object({
  action: z.enum(['list_chats', 'history', 'send', 'search']),
  chat_id: z.string().optional(),
  user_id: z.string().optional().describe('send：私聊发给这位同学'),
  text: z.string().optional().describe('send：消息正文（以「飞书同学」身份发出）'),
  keyword: z.string().optional(),
  page_size: z.number().int().min(1).max(100).optional(),
});

function registerIm(runtime: AgentRuntime, client: CosClient) {
  registerCosTool(runtime, client, {
    name: 'cos_im',
    description:
      'ClassmateOS 消息：列出同学所在的会话、读会话历史、搜索消息、以「飞书同学」身份发消息（发到群需要提问的同学也在群里，或私聊发给某位同学）。',
    schema: imSchema,
    risk: { send: 'write' },
    async run(i, call, ctx) {
      switch (i.action) {
        case 'list_chats':
          return fromResult(await call('GET', '/chats'));
        case 'history':
          return need(i, 'history', ['chat_id']) ?? fromResult(await call('GET', `/chats/${enc(i.chat_id!)}/messages`, { query: { page_size: i.page_size ?? 30 } }));
        case 'search':
          return need(i, 'search', ['keyword']) ?? fromResult(await call('GET', '/messages/search', { query: { keyword: i.keyword, chat_id: i.chat_id, page_size: i.page_size ?? 20 } }));
        case 'send': {
          const m = need(i, 'send', ['text']);
          if (m) return m;
          if (!i.chat_id && !i.user_id) return { ok: false, error: 'send 需要 chat_id 或 user_id' };
          // 防越权：往群里发之前，确认提问的同学是这个群的成员（当前会话除外）
          if (!ctx.actor?.userId) return { ok: false, code: 'NO_ACTOR', error: '缺少发消息人身份' };
          if (i.chat_id) {
            const chk = await call('GET', `/chats/${enc(i.chat_id)}`);
            if (!chk.ok) return { ok: false, error: '你不在这个会话里，不能代你往里面发消息', code: 'CHAT_NOT_MEMBER' };
          }
          const r = await ctx.client.post(
            '/bot/messages',
            {
              receive_id: i.chat_id ?? i.user_id,
              receive_id_type: i.chat_id ? 'chat_id' : 'user_id',
              msg_type: 'text',
              content: { text: i.text },
            },
            { asBot: true, actor: { sessionId: ctx.sessionId, toolCallId: ctx.toolCallId }, signal: ctx.signal },
          );
          return fromResult(r, () => '消息已发送');
        }
      }
    },
  });
}

// ---------------------------------------------------------------- cos_drive

const driveSchema = z.object({
  action: z.enum(['list', 'usage', 'download_url', 'upload_text', 'delete']),
  file_key: z.string().optional(),
  keyword: z.string().optional(),
  scope: z.enum(['all', 'mine', 'shared']).optional(),
  kind: z.string().optional().describe('文件类型筛选，如 image / doc / pdf'),
  file_name: z.string().optional().describe('upload_text：文件名，如 实验记录.csv'),
  content: z.string().optional().describe('upload_text：文件内容（文本，如 CSV / Markdown / JSON）'),
  add_to_drive: z.boolean().optional().describe('upload_text：上传后放进同学的云盘，默认 true'),
});

function registerDrive(runtime: AgentRuntime, client: CosClient) {
  registerCosTool(runtime, client, {
    name: 'cos_drive',
    description: 'ClassmateOS 云盘：列文件、查容量、拿下载链接、把一段文本（CSV/Markdown/JSON）存成文件放进同学云盘、删除文件。',
    schema: driveSchema,
    risk: { upload_text: 'write', delete: 'destructive' },
    preview: async (i) => (i.action === 'delete' && i.file_key ? `将删除云盘文件 ${i.file_key}，删除后不能撤销。` : undefined),
    async run(i, call, ctx) {
      switch (i.action) {
        case 'list':
          return fromResult(await call('GET', '/files', { query: { scope: i.scope, kind: i.kind, keyword: i.keyword } }));
        case 'usage':
          return fromResult(await call('GET', '/files/usage'));
        case 'download_url':
          return need(i, 'download_url', ['file_key']) ?? fromResult(await call('GET', `/files/${enc(i.file_key!)}/download-url`));
        case 'delete':
          return need(i, 'delete', ['file_key']) ?? fromResult(await call('DELETE', `/files/${enc(i.file_key!)}`), () => '文件已删除');
        case 'upload_text': {
          const m = need(i, 'upload_text', ['file_name', 'content']);
          if (m) return m;
          const up = await ctx.client.uploadBytes(i.file_name!, new TextEncoder().encode(i.content!), {
            actor: { userId: ctx.actor?.userId, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId },
          });
          if (!up.ok) return fromResult(up);
          if (i.add_to_drive !== false) {
            const d = await call('POST', `/files/${enc(up.data.file_key)}/drive`);
            if (!d.ok) return { ...fromResult(d), data: up.data, summary: '文件已上传，但放进云盘失败' };
          }
          return { ok: true, data: up.data, summary: `已保存「${i.file_name}」`, links: [`cos://file/${up.data.file_key}`] };
        }
      }
    },
  });
}

// ---------------------------------------------------------------- cos_contact / cos_notify / cos_search

function registerContact(runtime: AgentRuntime, client: CosClient) {
  registerCosTool(runtime, client, {
    name: 'cos_contact',
    description: 'ClassmateOS 通讯录：查当前提问的同学是谁（me）、按姓名搜同学拿 user_id（search）、查某人资料（get）。',
    schema: z.object({
      action: z.enum(['me', 'search', 'get']),
      keyword: z.string().optional(),
      user_id: z.string().optional(),
    }),
    async run(i, call) {
      switch (i.action) {
        case 'me':
          return fromResult(await call('GET', '/users/me'));
        case 'search':
          return fromResult(await call('GET', '/users', { query: { keyword: i.keyword, page_size: 20 } }));
        case 'get':
          return need(i, 'get', ['user_id']) ?? fromResult(await call('GET', `/users/${enc(i.user_id!)}`));
      }
    },
  });
}

function registerNotify(runtime: AgentRuntime, client: CosClient) {
  registerCosTool(runtime, client, {
    name: 'cos_notify',
    description: 'ClassmateOS 通知中心：看同学的通知（被 @、被指派任务、日程邀请等）、未读数、标为已读。',
    schema: z.object({
      action: z.enum(['list', 'unread_count', 'mark_read']),
      ids: z.array(z.string()).optional().describe('mark_read：通知 id；不填则全部标为已读'),
    }),
    risk: { mark_read: 'write' },
    async run(i, call) {
      switch (i.action) {
        case 'list':
          return fromResult(await call('GET', '/notifications'));
        case 'unread_count':
          return fromResult(await call('GET', '/notifications/unread-count'));
        case 'mark_read':
          return fromResult(await call('POST', '/notifications/read', { body: i.ids?.length ? { ids: i.ids } : { all: true } }), () => '已标为已读');
      }
    },
  });
}

function registerSearch(runtime: AgentRuntime, client: CosClient) {
  registerCosTool(runtime, client, {
    name: 'cos_search',
    description: '在 ClassmateOS 里一次搜文档、消息、同学、云盘文件（替代旧的 feishu_search_doc_wiki）。不确定东西在哪时先用它。',
    schema: z.object({
      query: z.string().min(1),
      scopes: z.array(z.enum(['docs', 'messages', 'users', 'files'])).optional().describe('默认全部'),
    }),
    async run(i, call) {
      const scopes = i.scopes?.length ? i.scopes : ['docs', 'messages', 'users', 'files'];
      const q = { keyword: i.query, page_size: 10 };
      const jobs: Record<string, Promise<CosToolResult>> = {};
      if (scopes.includes('docs')) jobs.docs = call('GET', '/docs', { query: q }).then((r) => fromResult(r));
      if (scopes.includes('messages')) jobs.messages = call('GET', '/messages/search', { query: q }).then((r) => fromResult(r));
      if (scopes.includes('users')) jobs.users = call('GET', '/users', { query: q }).then((r) => fromResult(r));
      if (scopes.includes('files')) jobs.files = call('GET', '/files', { query: { keyword: i.query } }).then((r) => fromResult(r));
      const out: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(jobs)) {
        const r = await p;
        out[k] = r.ok ? r.data : { error: r.error };
      }
      return { ok: true, data: out };
    },
  });
}

export function registerCosResourceTools(runtime: AgentRuntime, client: CosClient): void {
  registerTable(runtime, client);
  registerDoc(runtime, client);
  registerCalendar(runtime, client);
  registerTask(runtime, client);
  registerIm(runtime, client);
  registerDrive(runtime, client);
  registerContact(runtime, client);
  registerNotify(runtime, client);
  registerSearch(runtime, client);
}
