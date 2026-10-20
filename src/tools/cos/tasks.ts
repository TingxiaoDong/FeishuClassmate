/**
 * L1 任务型工具（AGENT_PLAN M3 §2.1）：一次调用完成一件同学说得出口的事，
 * 内部组合多个 L2 接口，减少模型的步数和出错机会。
 *
 *   cos_find_people         人名 → user_id（批量、报告重名 / 找不到）
 *   cos_find_free_time      几个人共同的空闲时段（工作日 9-18 点）
 *   cos_schedule_meeting    按人名约会：查冲突 → 建日程 → 可选在群里通知
 *   cos_build_table         按「列标题」建表并填数据（值自动转换：人名、日期、数字、勾选）
 *   cos_table_add_rows      按「列标题」往已有表加行
 *   cos_table_stats         表格汇总：总数、单选字段分布、数字字段合计
 *   cos_write_doc           写文档（Markdown），可选把链接发到群 / 发给某人
 *   cos_assign_tasks        批量按人名派任务
 *   cos_daily_brief         我的今天 / 本周：日程 + 未完成任务 + 未读通知
 *   cos_broadcast           给几个人（按人名）发同一条消息
 *   cos_automation          「某件事发生时 / 每周几点」自动帮我做（触发器增删改查）
 *
 * 全部代表发消息的同学执行；写入类按风险登记，批量超过 BULK_CONFIRM 条或删除时由运行时发确认卡片。
 */

import { z } from 'zod';
import type { CosClient } from '../../cos-sdk/client.js';
import type { AgentRuntime } from '../../runtime/types.js';
import { BULK_CONFIRM, enc, fromResult, registerCosTool, type Call, type CosToolResult } from './define.js';
import { autoFieldName, FIELD_TYPE_IDS } from './resources.js';

// ---------------------------------------------------------------- 时间（北京时间）

const TZ_OFFSET_MS = 8 * 3_600_000;
const DAY = 86_400_000;

/** 北京时间某天 0 点的时间戳。 */
export function startOfDayCn(ms: number): number {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;
}

/** 北京时间的「YYYY-MM-DD HH:mm」。 */
export function fmtCn(ms: number): string {
  const d = new Date(ms + TZ_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 解析日期文本（按北京时间）：2026-10-21 / 2026/10/21 / 2026-10-21 14:30 / 10月21日；纯数字当时间戳。 */
export function parseDateCn(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\d{10,13}$/.test(s)) return Number(s.length === 10 ? `${s}000` : s);
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2})[:：](\d{2}))?$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) - TZ_OFFSET_MS;
  m = /^(\d{1,2})月(\d{1,2})日?$/.exec(s);
  if (m) {
    const y = new Date(Date.now() + TZ_OFFSET_MS).getUTCFullYear();
    return Date.UTC(y, +m[1] - 1, +m[2]) - TZ_OFFSET_MS;
  }
  return undefined;
}

// ---------------------------------------------------------------- 找人

interface PersonHit { user_id: string; name: string; department?: string | null }
export interface PeopleResolution {
  found: Record<string, PersonHit>;
  ambiguous: Record<string, PersonHit[]>;
  missing: string[];
}

/** 名字（或 user_id）→ 人。完全同名优先；同名多人算「有歧义」，交给模型问同学。 */
export async function resolvePeople(call: Call, names: string[]): Promise<PeopleResolution> {
  const out: PeopleResolution = { found: {}, ambiguous: {}, missing: [] };
  for (const raw of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
    const name = raw.replace(/^@/, '');
    if (/^(我|me|自己|本人)$/i.test(name)) {
      const me = await call<PersonHit>('GET', '/users/me');
      if (me.ok) { out.found[raw] = { user_id: me.data.user_id, name: me.data.name }; continue; }
    }
    const r = await call<{ items: PersonHit[] }>('GET', '/users', { query: { keyword: name, page_size: 20 } });
    const items = r.ok ? r.data.items : [];
    const exact = items.filter((u) => u.name === name || u.user_id === name);
    const pick = exact.length ? exact : items;
    if (pick.length === 1) out.found[raw] = { user_id: pick[0].user_id, name: pick[0].name, department: pick[0].department };
    else if (pick.length > 1) out.ambiguous[raw] = pick.slice(0, 5).map((u) => ({ user_id: u.user_id, name: u.name, department: u.department }));
    else out.missing.push(raw);
  }
  return out;
}

/** 找人没全部找到时的统一回复。 */
function unresolved(p: PeopleResolution): CosToolResult | undefined {
  const amb = Object.entries(p.ambiguous);
  if (!amb.length && !p.missing.length) return undefined;
  const parts: string[] = [];
  if (p.missing.length) parts.push(`通讯录里找不到：${p.missing.join('、')}`);
  for (const [n, list] of amb) parts.push(`「${n}」有 ${list.length} 个人：${list.map((u) => `${u.name}(${u.user_id}${u.department ? `，${u.department}` : ''})`).join('；')}`);
  return { ok: false, code: 'PEOPLE_UNRESOLVED', error: `${parts.join('。')}。请向同学确认后用 user_id 重试。`, details: p };
}

// ---------------------------------------------------------------- 空闲时间

interface Busy { start_ms: number; end_ms: number; all_day?: boolean }

async function busyOf(call: Call, userId: string, meId: string, from: number, to: number): Promise<Busy[] | string> {
  const r = await call<{ items: Busy[] }>('GET', '/calendar/events', { query: { start_ms: from, end_ms: to, user_id: userId === meId ? undefined : userId } });
  return r.ok ? r.data.items : r.error;
}

/** 在 [from, to) 里找所有人都空的时段：只看工作日 day_start-day_end 点，按 step 分钟对齐。 */
export function freeSlots(busy: Busy[], from: number, to: number, durationMin: number, opts: { dayStart?: number; dayEnd?: number; weekends?: boolean; stepMin?: number; max?: number } = {}): Array<{ start_ms: number; end_ms: number }> {
  const dayStart = opts.dayStart ?? 9;
  const dayEnd = opts.dayEnd ?? 18;
  const step = (opts.stepMin ?? 30) * 60_000;
  const dur = durationMin * 60_000;
  const max = opts.max ?? 8;
  const out: Array<{ start_ms: number; end_ms: number }> = [];
  for (let day = startOfDayCn(from); day < to && out.length < max; day += DAY) {
    const wd = new Date(day + TZ_OFFSET_MS).getUTCDay();
    if (!opts.weekends && (wd === 0 || wd === 6)) continue;
    for (let s = day + dayStart * 3_600_000; s + dur <= day + dayEnd * 3_600_000 && out.length < max; s += step) {
      if (s < from || s + dur > to) continue;
      const e = s + dur;
      const clash = busy.some((b) => (b.all_day ? b.start_ms < day + DAY && b.end_ms > day : b.start_ms < e && b.end_ms > s));
      if (!clash) {
        out.push({ start_ms: s, end_ms: e });
        // 同一天的候选间隔开一点，给同学更多选择
        s += Math.max(0, 60 * 60_000 - step);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 表格：按列标题写值

interface FieldMeta { field_name: string; title: string; type: number; options?: Array<string | { name?: string }> }

async function fieldsOf(call: Call, tableKey: string): Promise<{ name: string; fields: FieldMeta[] } | CosToolResult> {
  const r = await call<{ name: string; fields: FieldMeta[] }>('GET', `/tables/${enc(tableKey)}`);
  if (!r.ok) return fromResult(r);
  return { name: r.data.name, fields: r.data.fields ?? [] };
}

/**
 * 把「列标题 → 值」转成平台记录：人员列填人名会自动查 user_id，日期列接受 2026-10-21，
 * 数字列接受 "12"，勾选列接受 是/否。返回转换后的记录和问题清单。
 */
export async function rowsByTitle(call: Call, fields: FieldMeta[], rows: Array<Record<string, unknown>>): Promise<{ records: Array<Record<string, unknown>>; problems: string[] }> {
  const byKey = new Map<string, FieldMeta>();
  for (const f of fields) {
    byKey.set(f.title, f);
    byKey.set(f.field_name, f);
  }
  const problems: string[] = [];
  // 先把所有人名一次查完
  const names = new Set<string>();
  for (const row of rows) for (const [k, v] of Object.entries(row)) {
    if (byKey.get(k)?.type === 11) for (const n of Array.isArray(v) ? v : String(v ?? '').split(/[,，、]/)) if (typeof n === 'string' && n.trim()) names.add(n.trim());
  }
  const people = names.size ? await resolvePeople(call, [...names]) : { found: {}, ambiguous: {}, missing: [] };

  const records = rows.map((row, ri) => {
    const rec: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      const f = byKey.get(k);
      if (!f) { problems.push(`第 ${ri + 1} 行：表里没有列「${k}」，已忽略`); continue; }
      if (v === null || v === undefined || v === '') continue;
      switch (f.type) {
        case 2: {
          const n = typeof v === 'number' ? v : Number(String(v).replace(/[,，\s]/g, ''));
          if (Number.isFinite(n)) rec[f.field_name] = n;
          else problems.push(`第 ${ri + 1} 行「${f.title}」不是数字：${String(v)}`);
          break;
        }
        case 5: {
          const t = parseDateCn(v);
          if (t !== undefined) rec[f.field_name] = t;
          else problems.push(`第 ${ri + 1} 行「${f.title}」看不懂的日期：${String(v)}（请用 2026-10-21 这种格式）`);
          break;
        }
        case 7:
          rec[f.field_name] = typeof v === 'boolean' ? v : /^(是|true|yes|y|1|✓|√|已完成|完成)$/i.test(String(v).trim());
          break;
        case 4:
          rec[f.field_name] = Array.isArray(v) ? v.map(String) : String(v).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
          break;
        case 11: {
          const list = (Array.isArray(v) ? v : String(v).split(/[,，、]/)).map((x) => (typeof x === 'string' ? x.trim() : x)).filter(Boolean);
          const ids: Array<{ id: string }> = [];
          for (const x of list) {
            if (x && typeof x === 'object' && 'id' in (x as object)) { ids.push({ id: String((x as { id: unknown }).id) }); continue; }
            const hit = people.found[String(x)];
            if (hit) ids.push({ id: hit.user_id });
            else problems.push(`第 ${ri + 1} 行「${f.title}」找不到唯一的人：${String(x)}`);
          }
          if (ids.length) rec[f.field_name] = ids;
          break;
        }
        default:
          rec[f.field_name] = typeof v === 'string' ? v : f.type === 1 ? JSON.stringify(v) : v;
      }
    }
    return rec;
  });
  return { records, problems };
}

async function insertRows(call: Call, tableKey: string, records: Array<Record<string, unknown>>): Promise<{ created: number; failed: Array<{ index: number; message: string }>; error?: string }> {
  let created = 0;
  const failed: Array<{ index: number; message: string }> = [];
  for (let i = 0; i < records.length; i += 100) {
    const part = records.slice(i, i + 100);
    const r = await call<{ succeeded?: unknown[]; failed?: Array<{ index: number; message: string }> }>('POST', `/tables/${enc(tableKey)}/records/batch_create`, {
      body: { records: part.map((fields) => ({ fields })) },
    });
    if (!r.ok) return { created, failed, error: r.error };
    created += r.data.succeeded?.length ?? 0;
    for (const f of r.data.failed ?? []) failed.push({ index: f.index + i, message: f.message });
  }
  return { created, failed };
}

// ---------------------------------------------------------------- 发消息（机器人身份，先核对群成员）

export async function botSend(client: CosClient, call: Call, ctx: { actor?: { userId?: string }; sessionId: string; toolCallId: string; signal?: AbortSignal }, target: { chat_id?: string; user_id?: string }, text: string): Promise<CosToolResult> {
  if (!ctx.actor?.userId) return { ok: false, code: 'NO_ACTOR', error: '缺少发消息人身份' };
  if (target.chat_id) {
    const chk = await call('GET', `/chats/${enc(target.chat_id)}`);
    if (!chk.ok) return { ok: false, code: 'CHAT_NOT_MEMBER', error: '你不在这个会话里，不能代你往里面发消息' };
  }
  const r = await client.post(
    '/bot/messages',
    { receive_id: target.chat_id ?? target.user_id, receive_id_type: target.chat_id ? 'chat_id' : 'user_id', msg_type: 'text', content: { text } },
    { asBot: true, actor: { sessionId: ctx.sessionId, toolCallId: ctx.toolCallId }, signal: ctx.signal },
  );
  return fromResult(r, () => '消息已发送');
}

// ---------------------------------------------------------------- 注册

const msTime = z.number().int().describe('毫秒时间戳（北京时间换算后的 epoch ms）');
const peopleList = z.array(z.string()).describe('人名或 user_id；「我」表示提问的同学');

const fieldDef = z.object({
  title: z.string(),
  type: z.string().optional().describe('text / number / single_select / multi_select / date / checkbox / person / url，默认 text'),
  options: z.array(z.string()).optional(),
});

export function registerCosTaskTools(runtime: AgentRuntime, client: CosClient): void {
  // ---- 找人
  registerCosTool(runtime, client, {
    name: 'cos_find_people',
    description: '按名字批量找同学的 user_id。重名会列出候选（带部门），找不到会说明。约会、派任务、发消息前用。',
    schema: z.object({ names: peopleList.min(1).max(30) }),
    async run(i, call) {
      const p = await resolvePeople(call, i.names);
      return { ok: true, data: p, summary: `找到 ${Object.keys(p.found).length} 人${Object.keys(p.ambiguous).length ? `，${Object.keys(p.ambiguous).length} 个名字有重名` : ''}${p.missing.length ? `，${p.missing.length} 个找不到` : ''}` };
    },
  });

  // ---- 共同空闲
  registerCosTool(runtime, client, {
    name: 'cos_find_free_time',
    description: '找几个人（含提问的同学自己）共同的空闲时段。默认在接下来 5 个工作日的 9:00-18:00 里找，只能看到别人的忙闲，看不到日程内容。',
    schema: z.object({
      people: peopleList.min(1).max(20),
      duration_min: z.number().int().min(15).max(480).default(60),
      from_ms: msTime.optional().describe('从什么时候开始找，默认现在'),
      to_ms: msTime.optional().describe('找到什么时候，默认 7 天后'),
      day_start_hour: z.number().int().min(0).max(23).optional(),
      day_end_hour: z.number().int().min(1).max(24).optional(),
      include_weekends: z.boolean().optional(),
    }),
    async run(i, call) {
      const p = await resolvePeople(call, ['我', ...i.people]);
      const bad = unresolved(p);
      if (bad) return bad;
      const meId = p.found['我'].user_id;
      const from = i.from_ms ?? Date.now();
      const to = i.to_ms ?? from + 7 * DAY;
      if (to <= from || to - from > 31 * DAY) return { ok: false, error: '时间范围要在 1 个月以内，结束晚于开始' };
      const ids = [...new Set(Object.values(p.found).map((u) => u.user_id))];
      const busy: Busy[] = [];
      const unknown: string[] = [];
      for (const id of ids) {
        const b = await busyOf(call, id, meId, from, to);
        if (typeof b === 'string') unknown.push(id);
        else busy.push(...b);
      }
      const slots = freeSlots(busy, from, to, i.duration_min, { dayStart: i.day_start_hour, dayEnd: i.day_end_hour, weekends: i.include_weekends });
      return {
        ok: true,
        data: { slots: slots.map((s) => ({ ...s, text: `${fmtCn(s.start_ms)} - ${fmtCn(s.end_ms).slice(11)}` })), people: Object.values(p.found).map((u) => u.name), unknown_busy: unknown },
        summary: slots.length ? `找到 ${slots.length} 个大家都有空的时段` : '这段时间里没有大家都有空的时段，可以放宽时间范围或缩短时长',
      };
    },
  });

  // ---- 约会议
  registerCosTool(runtime, client, {
    name: 'cos_schedule_meeting',
    description:
      '按人名约会议：自动找参会人 user_id、检查冲突、建日程并发邀请，可选在群里发通知。' +
      '时间没定时先用 cos_find_free_time 给同学挑；有人冲突时默认不建，返回冲突名单（force=true 才强行建）。',
    schema: z.object({
      title: z.string().min(1),
      start_ms: msTime,
      end_ms: msTime,
      attendees: peopleList.default([]),
      location: z.string().optional(),
      description: z.string().optional(),
      notify_chat_id: z.string().optional().describe('建好后把会议通知发到这个群'),
      force: z.boolean().optional().describe('有人冲突也照样建'),
    }),
    riskOf: () => 'write',
    async run(i, call, ctx) {
      if (i.end_ms <= i.start_ms) return { ok: false, error: '结束时间要晚于开始时间' };
      const p = await resolvePeople(call, ['我', ...i.attendees]);
      const bad = unresolved(p);
      if (bad) return bad;
      const meId = p.found['我'].user_id;
      const uniq = [...new Map(Object.values(p.found).map((u) => [u.user_id, u])).values()];
      const conflicts: string[] = [];
      for (const u of uniq) {
        const b = await busyOf(call, u.user_id, meId, i.start_ms, i.end_ms);
        if (Array.isArray(b) && b.some((x) => x.start_ms < i.end_ms && x.end_ms > i.start_ms)) conflicts.push(u.name);
      }
      if (conflicts.length && !i.force) {
        return { ok: false, code: 'TIME_CONFLICT', error: `${conflicts.join('、')} 在 ${fmtCn(i.start_ms)} 这个时间已有安排。可以用 cos_find_free_time 换个时间，或同学坚持时用 force=true。`, details: { conflicts } };
      }
      const attendeeIds = uniq.map((u) => u.user_id).filter((id) => id !== meId);
      const r = await call<{ event_id: string }>('POST', '/calendar/events', {
        body: { title: i.title, start_ms: i.start_ms, end_ms: i.end_ms, attendee_ids: attendeeIds, location: i.location, description: i.description },
      });
      if (!r.ok) return fromResult(r);
      let notice = '';
      if (i.notify_chat_id) {
        const names = uniq.filter((u) => u.user_id !== meId).map((u) => u.name).join('、');
        const s = await botSend(client, call, ctx, { chat_id: i.notify_chat_id }, `【会议通知】${i.title}\n时间：${fmtCn(i.start_ms)} - ${fmtCn(i.end_ms).slice(11)}${i.location ? `\n地点：${i.location}` : ''}${names ? `\n参会：${names}` : ''}`);
        notice = s.ok ? '，已在群里通知' : `，但群通知没发出去：${s.error}`;
      }
      return {
        ok: true,
        data: { event_id: r.data.event_id, attendees: uniq.map((u) => u.name), conflicts },
        summary: `已约「${i.title}」${fmtCn(i.start_ms)}，邀请了 ${attendeeIds.length} 人${conflicts.length ? `（${conflicts.join('、')} 有冲突）` : ''}${notice}`,
        links: [`cos://calendar/${r.data.event_id}`],
      };
    },
  });

  // ---- 建表 + 填数据
  registerCosTool(runtime, client, {
    name: 'cos_build_table',
    description:
      '一步建好一张多维表格并填数据：字段按「列标题 + 类型」给，rows 每行写 {列标题: 值}。' +
      '人员列可以直接写人名，日期列写 2026-10-21，数字列写数字，勾选列写 是/否，系统自动转换。',
    schema: z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      fields: z.array(fieldDef).min(1).max(50).describe('第一个字段是主字段'),
      rows: z.array(z.record(z.string(), z.unknown())).max(500).default([]),
    }),
    riskOf: () => 'write',
    bulk: (i) => i.rows.length,
    preview: async (i) => `将新建数据表「${i.name}」（${i.fields.map((f) => f.title).join('、')}），并写入 ${i.rows.length} 行。`,
    async run(i, call, ctx) {
      const used = new Set<string>();
      const fields = i.fields.map((f, idx) => {
        const type = FIELD_TYPE_IDS[f.type ?? 'text'] ?? 1;
        return { field_name: autoFieldName(f.title, idx, used), title: f.title, type, required: idx === 0, ...(f.options && (type === 3 || type === 4) ? { options: f.options } : {}) };
      });
      const t = await call<{ key?: string; table_key?: string }>('POST', '/tables', {
        body: { name: i.name, description: i.description, primary_field: fields[0].field_name, fields, client_request_id: `agent_${ctx.toolCallId}`.slice(0, 128) },
      });
      if (!t.ok) return fromResult(t);
      const key = String(t.data.key ?? t.data.table_key);
      const link = [`cos://table/${key}`];
      if (!i.rows.length) return { ok: true, data: { table_key: key, fields }, summary: `已建表「${i.name}」`, links: link };
      const conv = await rowsByTitle(call, fields, i.rows);
      const ins = await insertRows(call, key, conv.records);
      const problems = [...conv.problems, ...ins.failed.map((f) => `第 ${f.index + 1} 行没写进去：${f.message}`), ...(ins.error ? [`写入中断：${ins.error}`] : [])];
      return {
        ok: !ins.error,
        data: { table_key: key, fields: fields.map((f) => ({ title: f.title, field_name: f.field_name })), created: ins.created, problems },
        summary: `已建表「${i.name}」并写入 ${ins.created}/${i.rows.length} 行${problems.length ? `，有 ${problems.length} 个问题` : ''}`,
        links: link,
      };
    },
  });

  // ---- 按列标题加行
  registerCosTool(runtime, client, {
    name: 'cos_table_add_rows',
    description: '往已有表格加行：rows 每行写 {列标题: 值}（不用先查字段英文名），人名、日期、数字自动转换。',
    schema: z.object({ table_key: z.string(), rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }),
    riskOf: () => 'write',
    bulk: (i) => i.rows.length,
    preview: async (i, call) => {
      const t = await fieldsOf(call, i.table_key);
      const name = 'fields' in t ? t.name : i.table_key;
      return `将向「${name}」新增 ${i.rows.length} 行，示例：\n${i.rows.slice(0, 3).map((r) => `· ${Object.entries(r).slice(0, 4).map(([k, v]) => `${k}=${String(v).slice(0, 20)}`).join('，')}`).join('\n')}`;
    },
    async run(i, call) {
      const t = await fieldsOf(call, i.table_key);
      if (!('fields' in t)) return t;
      const conv = await rowsByTitle(call, t.fields, i.rows);
      const ins = await insertRows(call, i.table_key, conv.records);
      const problems = [...conv.problems, ...ins.failed.map((f) => `第 ${f.index + 1} 行没写进去：${f.message}`), ...(ins.error ? [`写入中断：${ins.error}`] : [])];
      return { ok: !ins.error && ins.created > 0, data: { created: ins.created, problems }, summary: `向「${t.name}」写入 ${ins.created}/${i.rows.length} 行`, links: [`cos://table/${i.table_key}`] };
    },
  });

  // ---- 表格汇总
  registerCosTool(runtime, client, {
    name: 'cos_table_stats',
    description: '汇总一张表：总行数、每个单选 / 多选 / 人员列的分布、数字列的合计和平均。做周报、看进度时用，比逐条读省事。',
    schema: z.object({ table_key: z.string(), filter: z.string().optional().describe('同 cos_table list_records 的 filter') }),
    async run(i, call) {
      const t = await fieldsOf(call, i.table_key);
      if (!('fields' in t)) return t;
      const rows: Array<Record<string, unknown>> = [];
      let token: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await call<{ items: Array<{ fields: Record<string, unknown> }>; has_more?: boolean; page_token?: string }>('GET', `/tables/${enc(i.table_key)}/records`, { query: { filter: i.filter, page_size: 500, page_token: token } });
        if (!r.ok) return fromResult(r);
        rows.push(...r.data.items.map((x) => x.fields ?? {}));
        if (!r.data.has_more || !r.data.page_token) break;
        token = r.data.page_token;
      }
      const stats: Record<string, unknown> = {};
      for (const f of t.fields) {
        const vals = rows.map((r) => r[f.field_name]).filter((v) => v !== undefined && v !== null && v !== '');
        if (f.type === 2) {
          const nums = vals.map(Number).filter(Number.isFinite);
          const sum = nums.reduce((a, b) => a + b, 0);
          stats[f.title] = { 合计: sum, 平均: nums.length ? Math.round((sum / nums.length) * 100) / 100 : null, 有值: nums.length };
        } else if (f.type === 7) {
          const yes = rows.filter((r) => r[f.field_name] === true).length;
          stats[f.title] = { 分布: { 是: yes, 否: rows.length - yes } };
        } else if ([3, 4, 11].includes(f.type)) {
          const count: Record<string, number> = {};
          for (const v of vals) {
            const keys = (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === 'object' ? String((x as { name?: unknown; id?: unknown }).name ?? (x as { id?: unknown }).id) : String(x)));
            for (const k of keys) count[k] = (count[k] ?? 0) + 1;
          }
          stats[f.title] = { 分布: count, 空: rows.length - vals.length };
        } else if (f.type === 5) {
          const ts = vals.map(Number).filter(Number.isFinite);
          if (ts.length) stats[f.title] = { 最早: fmtCn(Math.min(...ts)).slice(0, 10), 最晚: fmtCn(Math.max(...ts)).slice(0, 10), 空: rows.length - ts.length };
        } else {
          stats[f.title] = { 有值: vals.length, 空: rows.length - vals.length };
        }
      }
      return { ok: true, data: { table: t.name, total: rows.length, stats, capped: rows.length >= 10_000 }, summary: `「${t.name}」共 ${rows.length} 行` };
    },
  });

  // ---- 写文档并分享
  registerCosTool(runtime, client, {
    name: 'cos_write_doc',
    description: '写一篇云文档（Markdown，标题用 #，列表用 -），可选写好后把文档标题和链接发到某个群或发给某人。周报、纪要、指南都用它。',
    schema: z.object({
      title: z.string().min(1).max(200),
      markdown: z.string().min(1),
      share_chat_id: z.string().optional(),
      share_to: z.string().optional().describe('发给某人（人名或 user_id）'),
      share_note: z.string().max(500).optional().describe('分享时附带的一句话'),
    }),
    riskOf: () => 'write',
    async run(i, call, ctx) {
      const r = await call<{ doc_id: string }>('POST', '/docs', { body: { title: i.title, markdown: i.markdown } });
      if (!r.ok) return fromResult(r);
      const link = `cos://doc/${r.data.doc_id}`;
      const shared: string[] = [];
      const text = `${i.share_note ? `${i.share_note}\n` : ''}📄 《${i.title}》\n${link}`;
      if (i.share_chat_id) {
        const s = await botSend(client, call, ctx, { chat_id: i.share_chat_id }, text);
        shared.push(s.ok ? '已发到群里' : `发群失败：${s.error}`);
      }
      if (i.share_to) {
        const p = await resolvePeople(call, [i.share_to]);
        const u = p.found[i.share_to];
        if (!u) shared.push(`发给「${i.share_to}」失败：${unresolved(p)?.error ?? '找不到人'}`);
        else {
          const s = await botSend(client, call, ctx, { user_id: u.user_id }, text);
          shared.push(s.ok ? `已发给${u.name}` : `发给${u.name}失败：${s.error}`);
        }
      }
      return { ok: true, data: { doc_id: r.data.doc_id, shared }, summary: `已写好文档《${i.title}》${shared.length ? `，${shared.join('，')}` : ''}`, links: [link] };
    },
  });

  // ---- 批量派任务
  registerCosTool(runtime, client, {
    name: 'cos_assign_tasks',
    description: '一次给多人派任务：每项写 标题、负责人名字、截止时间。找不到 / 重名的人会整体先不派，返回名单让同学确认。',
    schema: z.object({
      tasks: z.array(z.object({
        title: z.string().min(1),
        assignee: z.string().optional().describe('负责人名字或 user_id，不填就是自己'),
        due_ms: msTime.optional(),
        description: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      })).min(1).max(100),
    }),
    riskOf: () => 'write',
    bulk: (i) => i.tasks.length,
    preview: async (i) => `将创建 ${i.tasks.length} 个任务：\n${i.tasks.slice(0, 5).map((t) => `· ${t.title} → ${t.assignee ?? '自己'}`).join('\n')}`,
    async run(i, call) {
      const p = await resolvePeople(call, i.tasks.map((t) => t.assignee ?? '我'));
      const bad = unresolved(p);
      if (bad) return bad;
      const done: Array<{ title: string; assignee: string; task_id: string }> = [];
      const failed: string[] = [];
      for (const t of i.tasks) {
        const u = p.found[(t.assignee ?? '我').trim()];
        const r = await call<{ task_id: string }>('POST', '/tasks', { body: { title: t.title, assignee_id: u.user_id, due_ms: t.due_ms, description: t.description, priority: t.priority } });
        if (r.ok) done.push({ title: t.title, assignee: u.name, task_id: r.data.task_id });
        else failed.push(`${t.title}：${r.error}`);
      }
      return { ok: failed.length === 0, data: { created: done, failed }, summary: `派了 ${done.length} 个任务${failed.length ? `，${failed.length} 个失败` : ''}`, links: done.map((d) => `cos://task/${d.task_id}`) };
    },
  });

  // ---- 我的今天 / 本周
  registerCosTool(runtime, client, {
    name: 'cos_daily_brief',
    description: '提问同学的安排概览：日程、没完成的任务（含逾期）、未读通知数。「我今天有什么事」「这周忙不忙」用它。',
    schema: z.object({ range: z.enum(['today', 'tomorrow', 'week']).default('today') }),
    async run(i, call) {
      const now = Date.now();
      const today = startOfDayCn(now);
      const [from, to] = i.range === 'tomorrow' ? [today + DAY, today + 2 * DAY] : i.range === 'week' ? [today, today + 7 * DAY] : [today, today + DAY];
      const me = await call<{ user_id: string }>('GET', '/users/me');
      if (!me.ok) return fromResult(me);
      const [ev, tasks, unread] = await Promise.all([
        call<{ items: Array<{ title: string; start_ms: number; end_ms: number; location?: string; all_day?: boolean }> }>('GET', '/calendar/events', { query: { start_ms: from, end_ms: to } }),
        call<{ items: Array<{ title: string; status: string; due_ms?: number | null; task_id: string }> }>('GET', '/tasks', { query: { assignee_id: me.data.user_id } }),
        call<{ count?: number; unread?: number }>('GET', '/notifications/unread-count'),
      ]);
      const events = ev.ok ? ev.data.items.sort((a, b) => a.start_ms - b.start_ms).map((e) => ({ title: e.title, time: e.all_day ? `${fmtCn(e.start_ms).slice(0, 10)} 全天` : `${fmtCn(e.start_ms)}-${fmtCn(e.end_ms).slice(11)}`, location: e.location })) : [];
      const open = tasks.ok ? tasks.data.items.filter((t) => t.status !== 'done' && t.status !== 'cancelled') : [];
      const overdue = open.filter((t) => t.due_ms && t.due_ms < now);
      const dueSoon = open.filter((t) => t.due_ms && t.due_ms >= now && t.due_ms < to);
      return {
        ok: true,
        data: {
          range: `${fmtCn(from).slice(0, 10)} ~ ${fmtCn(to - 1).slice(0, 10)}`,
          events,
          overdue_tasks: overdue.map((t) => ({ title: t.title, due: fmtCn(t.due_ms!) })),
          due_in_range: dueSoon.map((t) => ({ title: t.title, due: fmtCn(t.due_ms!) })),
          open_task_count: open.length,
          unread_notifications: unread.ok ? (unread.data.count ?? unread.data.unread ?? 0) : null,
          errors: [ev, tasks].filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error)),
        },
        summary: `${events.length} 个日程，${open.length} 个未完成任务${overdue.length ? `（${overdue.length} 个已逾期）` : ''}`,
      };
    },
  });

  // ---- 群发
  registerCosTool(runtime, client, {
    name: 'cos_broadcast',
    description: '给几个人（按名字）分别发同一条私信，比如「通知张三、李四明天带电脑」。往群里发用 cos_im send。',
    schema: z.object({ people: peopleList.min(1).max(BULK_CONFIRM * 2), text: z.string().min(1).max(2000) }),
    riskOf: () => 'write',
    bulk: (i) => i.people.length,
    preview: async (i) => `将以「飞书同学」的名义分别私信 ${i.people.length} 人：${i.people.join('、')}\n内容：${i.text.slice(0, 100)}`,
    async run(i, call, ctx) {
      const p = await resolvePeople(call, i.people);
      const bad = unresolved(p);
      if (bad) return bad;
      const sent: string[] = [];
      const failed: string[] = [];
      for (const u of new Map(Object.values(p.found).map((x) => [x.user_id, x])).values()) {
        const r = await botSend(client, call, ctx, { user_id: u.user_id }, i.text);
        (r.ok ? sent : failed).push(r.ok ? u.name : `${u.name}：${r.error}`);
      }
      return { ok: failed.length === 0, data: { sent, failed }, summary: `已发给 ${sent.join('、') || '0 人'}${failed.length ? `；失败 ${failed.length} 人` : ''}` };
    },
  });

  // ---- 自动化（触发器）
  registerCosTool(runtime, client, {
    name: 'cos_automation',
    description:
      '设置「自动帮我做」：某件事发生时（表格记录变化 record.changed、有人给我派任务 task.assigned、任务更新 task.updated、日程邀请 calendar.invited、文档评论 doc.comment_changed）' +
      '或定时（schedule + cron，如每周一 9 点「0 9 * * 1」）由飞书同学以这位同学的身份执行 prompt，结果发到 chat_id（不填就私聊他）。' +
      'condition 写成自然语言（如「状态变成已完成」），触发时先判断满足才执行。',
    schema: z.object({
      action: z.enum(['list', 'create', 'update', 'delete']),
      trigger_id: z.string().optional(),
      name: z.string().max(50).optional(),
      event: z.enum(['record.changed', 'task.assigned', 'task.updated', 'calendar.invited', 'doc.comment_changed', 'schedule']).optional(),
      cron: z.string().optional().describe('5 段 cron（分 时 日 月 周），按北京时间'),
      table_key: z.string().optional().describe('record.changed 必填：盯哪张表'),
      record_actions: z.array(z.enum(['created', 'updated', 'deleted'])).optional(),
      fields_any: z.array(z.string()).optional().describe('只在这些字段（英文名）变化时触发'),
      condition: z.string().max(500).nullable().optional(),
      prompt: z.string().max(2000).optional().describe('触发时要做的事，写成给飞书同学的一句指令'),
      chat_id: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
      cooldown_sec: z.number().int().optional(),
    }),
    risk: { create: 'write', update: 'write', delete: 'destructive' },
    preview: async (i) => (i.action === 'delete' ? `将删除自动化 ${i.trigger_id ?? ''}，删除后不会再自动执行。` : undefined),
    async run(i, call) {
      const body = () => {
        const b: Record<string, unknown> = {};
        for (const k of ['name', 'event', 'cron', 'condition', 'prompt', 'chat_id', 'enabled', 'cooldown_sec'] as const) if (i[k] !== undefined) b[k] = i[k];
        if (i.table_key || i.record_actions || i.fields_any) b.filter = { table_key: i.table_key, actions: i.record_actions, fields_any: i.fields_any };
        return b;
      };
      switch (i.action) {
        case 'list':
          return fromResult(await call<{ items: Array<{ name: string }> }>('GET', '/agent/triggers'), (d) => `共 ${d.items.length} 个自动化`);
        case 'create':
          if (!i.name || !i.event || !i.prompt) return { ok: false, error: 'create 需要 name、event、prompt' };
          return fromResult(await call<{ trigger_id: string; name: string }>('POST', '/agent/triggers', { body: body() }), (d) => `已设置自动化「${d.name}」(${d.trigger_id})`);
        case 'update':
          if (!i.trigger_id) return { ok: false, error: 'update 需要 trigger_id' };
          return fromResult(await call('PATCH', `/agent/triggers/${enc(i.trigger_id)}`, { body: body() }), () => '自动化已修改');
        case 'delete':
          if (!i.trigger_id) return { ok: false, error: 'delete 需要 trigger_id' };
          return fromResult(await call('DELETE', `/agent/triggers/${enc(i.trigger_id)}`), () => '自动化已删除');
      }
    },
  });
}

export const COS_TASK_TOOLS_PROMPT = [
  '## 一步到位的任务工具（优先使用）',
  '- 找人 cos_find_people；约会议先 cos_find_free_time 再 cos_schedule_meeting；',
  '- 建表并填数据 cos_build_table，往表里加行 cos_table_add_rows（都按列标题写值，不用查字段英文名），汇总 cos_table_stats；',
  '- 写文档并分享 cos_write_doc；批量派任务 cos_assign_tasks；私信几个人 cos_broadcast；「我今天 / 这周有什么事」cos_daily_brief；',
  '- 同学说「以后每当… / 每周几… 就帮我…」时用 cos_automation 设置自动化，并复述触发条件让他知道。',
  '- 工具返回 PEOPLE_UNRESOLVED 时把候选人列给同学选，不要自己猜。',
].join('\n');
