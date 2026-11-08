/**
 * 平台工具的公共骨架（AGENT_PLAN §2.1）：
 *   - 自动带上「代表谁」（会话 actor → X-On-Behalf-Of）和审计 id；
 *   - 统一返回 { ok, data, summary, links }，结果过大自动截断；
 *   - 风险分级（AGENT_PLAN M2）：策略交给运行时——destructive 动作、超过 BULK_CONFIRM 条的批量写入
 *     先发确认卡片（带预演说明），同学同意后运行时把卡片 id 放进 ctx.confirmation，
 *     这里随请求带上 X-Agent-Confirm，服务端核验后才放行删除。
 */

import { z } from 'zod';
import { automationTargetCode, automationToolCode, automationRequest, automationOperation, revisionOf } from '../../runtime/automation-execution.js';
import { COS_API_CATALOG } from '../../cos-sdk/catalog.generated.js';
import { matchTemplate, type CosClient } from '../../cos-sdk/client.js';
import type { CosRequest, CosResult, HttpMethod } from '../../cos-sdk/types.js';
import type { AgentRuntime, BoundAction, ToolCallContext, ToolRisk } from '../../runtime/types.js';
import { defaultToolLabel } from '../../runtime/policy.js';
import { zodToJsonSchema } from '../../runtime/zod-tool.js';
import { resolvePeople, SELF_WORDS } from './people.js';

export type { ToolRisk };

/** 一次写入超过这么多条就先请同学确认（预演）。 */
export const BULK_CONFIRM = 20;

// ---------------------------------------------------------------- 代发消息（代码审查 A4）

/** 代发消息的目标。person 是人名（或 user_id / 「我」），执行时才查成 user_id。 */
export type SendTarget = { chat_id: string } | { user_id: string } | { person: string };
/** 一次工具调用会代同学发出的一条消息。 */
export interface OutboundMessage { to: SendTarget; text: string }

/** 代发接口的路由模板（确认卡片 bound_action.route）。 */
export const BOT_MESSAGES_ROUTE = '/api/v1/bot/messages';
/** 平台里机器人的 user_id。 */
const BOT_USER_ID = 'bot';
/** 确认卡片上消息正文最多显示多少字。 */
export const OUTBOUND_PREVIEW_CHARS = 300;

type ActorLike = { userId?: string; chatId?: string; name?: string };

/**
 * 发到这里要不要先请同学确认：
 *   - 当前对话（chat_id === actor.chatId）：不用，这就是正常回复；
 *   - 私信同学本人（user_id 是本人 / 人名是「我」或本人名字）：不用，就是机器人和他自己的单聊；
 *   - 其他任何群、单聊，或私信给别人：要确认。
 * 不知道代表谁（没有 actor）时一律要确认。
 */
export function sendNeedsConfirm(to: SendTarget, actor?: ActorLike): boolean {
  if (!actor?.userId) return true;
  if ('chat_id' in to) return !(actor.chatId && to.chat_id === actor.chatId);
  if ('user_id' in to) return to.user_id !== actor.userId;
  const p = to.person.trim().replace(/^@/, '');
  return !(SELF_WORDS.test(p) || p === actor.userId || (!!actor.name && p === actor.name));
}

const asSendTarget = (t: { chat_id?: string; user_id?: string }): SendTarget => (t.chat_id ? { chat_id: t.chat_id } : { user_id: t.user_id ?? '' });

const boundIds = (a?: BoundAction): string[] => (a?.target_id === undefined ? [] : Array.isArray(a.target_id) ? a.target_id : [a.target_id]);

/**
 * 执行时的兜底：这次真要发的目标（人名已查成 user_id）有没有被同学确认过。
 * 返回 ok=false 时不能发；ok=true 且带 cardId 时，请求上带上这张卡（X-Agent-Confirm）。
 *   - 不需要确认的目标：直接放行；
 *   - 代发确认卡（bound_action 是 POST /bot/messages）：目标必须在卡片绑定的 target_id 里；
 *   - 其他工具自己的确认卡（如 Temi 送话，卡上已写明会改发私信）：必须是同学真点过的卡（有 cardId）。
 */
export function sendAllowed(
  ctx: { actor?: ActorLike; confirmation?: ToolCallContext['confirmation']; execution?: ToolCallContext['execution'] },
  target: { chat_id?: string; user_id?: string },
): { ok: boolean; cardId?: string } {
  if (ctx.execution) return { ok: !automationTargetCode(ctx.execution, { type: target.chat_id ? 'chat_id' : 'user_id', id: target.chat_id ?? target.user_id ?? '' }, ctx.actor?.userId) };
  const to = asSendTarget(target);
  if (!sendNeedsConfirm(to, ctx.actor)) return { ok: true };
  const c = ctx.confirmation;
  if (!c) return { ok: false };
  if (!c.cardId || !c.action || c.action.method.toUpperCase() !== 'POST' || c.action.route !== BOT_MESSAGES_ROUTE) return { ok: false };
  const id = 'chat_id' in to ? to.chat_id : 'user_id' in to ? to.user_id : '';
  return boundIds(c.action).includes(id) ? { ok: true, cardId: c.cardId } : { ok: false };
}

/** 只读调用：写请求一律不发（给确认卡片的预演、绑定用）。 */
function readOnly(call: Call): Call {
  return ((method, path, req) =>
    method === 'GET'
      ? call(method, path, req)
      : Promise.resolve({ ok: false, status: 0, error: '预演阶段不发写请求', code: 'DRY_RUN' })) as Call;
}

interface ResolvedTarget { msg: OutboundMessage; needs: boolean; id?: string; label: string }

async function userLabel(call: Call, id: string, cache: Map<string, string>): Promise<string> {
  if (cache.has(id)) return cache.get(id)!;
  const r = await call<{ name?: string }>('GET', `/users/${enc(id)}`);
  const name = r.ok && r.data?.name ? r.data.name : id;
  cache.set(id, name);
  return name;
}

/** 会话 → 给同学看的说明：单聊写对方名字，群写群名和人数、成员。 */
async function chatLabel(call: Call, chatId: string, actor: ActorLike | undefined, cache: Map<string, string>): Promise<string> {
  if (actor?.chatId && chatId === actor.chatId) return '当前对话';
  const r = await call<{ chat_type?: string; name?: string | null; member_ids?: string[] }>('GET', `/chats/${enc(chatId)}`);
  if (!r.ok) return `会话 ${chatId}（查不到会话信息${r.status === 404 ? '：不存在，或你不在里面' : ''}）`;
  const all = r.data.member_ids ?? [];
  const people = all.filter((id) => id !== BOT_USER_ID);
  const nameOf = (id: string) => (id === actor?.userId ? Promise.resolve('你') : userLabel(call, id, cache));
  const botNote = all.includes(BOT_USER_ID) ? '' : '，飞书同学不在这个会话里';
  if (r.data.chat_type === 'p2p') {
    const others = people.filter((id) => id !== actor?.userId);
    if (!others.length) return '你和飞书同学的单聊';
    return `你和${(await Promise.all(others.map(nameOf))).join('、')}的私聊（单聊${botNote}）`;
  }
  const SHOW = 8;
  const names = await Promise.all(people.slice(0, SHOW).map(nameOf));
  return `群「${r.data.name || chatId}」（${people.length} 人：${names.join('、')}${people.length > SHOW ? ' 等' : ''}${botNote}）`;
}

/** 把这次要发的消息逐条查清楚：目标 id、要不要确认、给同学看的名字。 */
async function resolveOutbound(call: Call, msgs: OutboundMessage[], actor: ActorLike | undefined): Promise<ResolvedTarget[]> {
  const cache = new Map<string, string>();
  const out: ResolvedTarget[] = [];
  for (const msg of msgs) {
    const needs = sendNeedsConfirm(msg.to, actor);
    const to = msg.to;
    if ('chat_id' in to) {
      out.push({ msg, needs, id: to.chat_id, label: await chatLabel(call, to.chat_id, actor, cache) });
    } else if ('user_id' in to) {
      const self = to.user_id === actor?.userId;
      out.push({ msg, needs, id: to.user_id, label: self ? '你自己（和飞书同学的单聊）' : `${await userLabel(call, to.user_id, cache)}（私信）` });
    } else {
      const p = await resolvePeople(call, [to.person]);
      const hit = p.found[to.person.trim()];
      if (hit) {
        const self = hit.user_id === actor?.userId;
        out.push({ msg, needs: needs && !self, id: hit.user_id, label: self ? '你自己（和飞书同学的单聊）' : `${hit.name}${hit.department ? `（${hit.department}）` : ''}（私信）` });
      } else {
        const amb = p.ambiguous[to.person.trim()];
        out.push({ msg, needs: true, label: amb ? `「${to.person}」（有 ${amb.length} 个同名的人，还没确定是谁，不会发出）` : `「${to.person}」（通讯录里找不到，不会发出）` });
      }
    }
  }
  return out;
}

const quoteText = (text: string): string => {
  const chars = [...text];
  return chars.length > OUTBOUND_PREVIEW_CHARS
    ? `${chars.slice(0, OUTBOUND_PREVIEW_CHARS).join('')}…\n（共 ${chars.length} 字，这里只显示前 ${OUTBOUND_PREVIEW_CHARS} 字）`
    : text;
};

/** 确认卡片上「发给谁、发什么、以谁的名义」那一段。 */
export function describeOutbound(targets: ResolvedTarget[]): string {
  const byText = new Map<string, string[]>();
  for (const t of targets) byText.set(t.msg.text, [...(byText.get(t.msg.text) ?? []), t.label]);
  const parts = ['将以你的名义发送消息（对方会看到「通过 AI 助手发送」的标注）：'];
  for (const [text, labels] of byText) {
    parts.push(`发给：\n${labels.map((l) => `· ${l}`).join('\n')}`);
    parts.push(`消息内容：\n${quoteText(text)}`);
  }
  return parts.join('\n');
}

/** 代发确认卡绑定的操作：POST /bot/messages + 目标 chat_id / user_id（A2：一次调用用一次）。 */
function outboundAction(targets: ResolvedTarget[]): BoundAction {
  const ids = [...new Set(targets.filter((t) => t.needs && t.id).map((t) => t.id!))];
  return { method: 'POST', route: BOT_MESSAGES_ROUTE, path: BOT_MESSAGES_ROUTE, ...(ids.length ? { target_id: ids.length === 1 ? ids[0] : ids } : {}) };
}

export interface CosToolResult {
  ok: boolean;
  data?: unknown;
  summary?: string;
  /** 应用内深链，回复里可以直接给同学点。 */
  links?: string[];
  error?: string;
  code?: string;
  details?: unknown;
  need_confirmation?: boolean;
}

export type Call = <T = unknown>(method: HttpMethod, path: string, req?: Omit<CosRequest, 'actor'>) => Promise<CosResult<T>>;

export interface CosToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** 按 action 声明风险；没列出的 action 按名字推断（inferActionRisk），不再一律当只读。 */
  risk?: Record<string, ToolRisk>;
  /** 整个工具只读（不带 action 的查询类工具）。 */
  readOnly?: boolean;
  /** 风险不由 action 决定时（如 cos_api 按 method / path）自己算。 */
  riskOf?: (input: z.infer<S>) => ToolRisk;
  /** 这次调用会动多少条数据（批量写入超过 BULK_CONFIRM 时要确认）。 */
  bulk?: (input: z.infer<S>) => number;
  /** 确认卡片上的预演说明：会改动 / 删除什么。可以先查一下平台（只读）。 */
  preview?: (input: z.infer<S>, call: Call) => Promise<string | undefined>;
  /**
   * 这次调用会代同学发出的消息（代码审查 A4）。有发到当前对话以外的，就先发确认卡片，
   * 卡片上同时写「做什么」（preview）和「发给谁、发什么」——一张卡，不连弹两张。
   */
  outbound?: (input: z.infer<S>) => OutboundMessage[];
  /** 其他按参数 / 会话要确认的情况（如 cos_api 加急消息）。 */
  confirmIf?: (input: z.infer<S>, ctx?: ToolCallContext) => boolean;
  run: (input: z.infer<S>, call: Call, ctx: ToolCallContext & { client: CosClient }) => Promise<CosToolResult>;
}

/** 没在 risk 表里的 action：看名字推断（代码审查 A3）。 */
export function inferActionRisk(action: string | undefined): ToolRisk {
  if (!action) return 'write';
  if (/(^|_)(delete|remove|purge|destroy|clear)(_|$)/.test(action)) return 'destructive';
  if (/^(list|get|search|query|find|view|read|me|freebusy|stats|summary|preview|check|count|status)(_|$)/.test(action)) return 'read';
  return 'write';
}

/** 接口目录里没收录、但会被删除类工具调用的路由模板。 */
const EXTRA_ROUTES: Array<{ method: string; path: string }> = [
  { method: 'POST', path: '/tables/:table_key/records/batch_delete' },
  { method: 'DELETE', path: '/tables/:table_key/fields/:field_name' },
  { method: 'DELETE', path: '/docs/:doc_id' },
  { method: 'DELETE', path: '/calendar/events/:event_id' },
  { method: 'DELETE', path: '/tasks/:task_id' },
  { method: 'DELETE', path: '/files/:file_key' },
  { method: 'DELETE', path: '/agent/triggers/:trigger_id' },
];

/** 具体请求 → 确认卡片绑定的操作（路由模板 + 对象 id）。字面段越多的模板越优先。 */
export function boundActionOf(method: string, path: string, body?: unknown, catalog: Array<{ method: string; path: string }> = COS_API_CATALOG): BoundAction {
  const M = method.toUpperCase();
  const clean = (path.startsWith('/api/v1/') ? path.slice('/api/v1'.length) : path).split('?')[0];
  const literal = (t: string) => t.split('/').filter((x) => x && !x.startsWith(':')).length;
  const template = [...catalog, ...EXTRA_ROUTES]
    .filter((e) => e.method === M && matchTemplate(e.path, clean))
    .sort((a, b) => literal(b.path) - literal(a.path))[0]?.path;
  let target: string | string[] | undefined;
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const ids = [b.record_ids, b.ids, b.file_keys].find((x) => Array.isArray(x) && x.length && x.every((y) => typeof y === 'string')) as string[] | undefined;
  if (ids) target = [...ids];
  else if (template) {
    const ts = template.split('/').filter(Boolean);
    const cs = clean.split('/').filter(Boolean);
    for (let k = ts.length - 1; k >= 0; k--) {
      if (ts[k].startsWith(':')) {
        target = decodeURIComponent(cs[k]);
        break;
      }
    }
  }
  return { method: M, route: `/api/v1${template ?? clean}`, path: `/api/v1${clean}`, ...(target !== undefined ? { target_id: target } : {}) };
}

class DryRunStop extends Error {}

/**
 * 演练一次：读请求照常发（只读），遇到第一个写请求就记下来并停止，不发送。
 * 用来在确认前算出这次会发什么写请求。
 */
async function captureWrite<S extends z.ZodTypeAny>(
  def: CosToolDef<S>,
  input: z.infer<S>,
  client: CosClient,
  ctx: ToolCallContext,
): Promise<{ method: string; path: string; body?: unknown } | undefined> {
  let captured: { method: string; path: string; body?: unknown } | undefined;
  const signal = AbortSignal.timeout(8_000);
  const call: Call = async (method, path, req = {}) => {
    if (method !== 'GET') {
      captured ??= { method, path, body: req.body };
      throw new DryRunStop();
    }
    return client.request(method, path, { ...req, signal, actor: { userId: ctx.actor?.userId, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId } });
  };
  const dryClient = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'request') return call;
      const v = Reflect.get(target, prop, receiver);
      // 绑定到代理本身：post / patch / uploadBytes 内部调用 this.request 时也会被拦下，
      // 不会在演练阶段真的发出写请求（例如代发消息走的 client.post）
      return typeof v === 'function' ? v.bind(receiver) : v;
    },
  });
  try {
    await def.run(input, call, { ...ctx, client: dryClient });
  } catch {
    /* DryRunStop 或参数不全：有记下的就用 */
  }
  return captured;
}

/** 已注册平台工具的元数据（风险等级等），供后续确认卡片 / 文档使用。 */
export const COS_TOOL_META = new Map<string, { risk: Record<string, ToolRisk> }>();

const MAX_RESULT_CHARS = 12_000;

export function truncate(result: CosToolResult): CosToolResult {
  const text = JSON.stringify(result.data ?? null);
  if (text.length <= MAX_RESULT_CHARS) return result;
  const data = result.data as Record<string, unknown> | unknown[];
  // 列表类结果：截掉多余条目，告诉模型还有多少
  const items = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown }).items) ? ((data as { items: unknown[] }).items) : undefined;
  if (items) {
    let keep = items.length;
    while (keep > 1 && JSON.stringify(items.slice(0, keep)).length > MAX_RESULT_CHARS) keep = Math.floor(keep * 0.7);
    const sliced = items.slice(0, keep);
    const nextData = Array.isArray(data) ? sliced : { ...(data as object), items: sliced };
    return { ...result, data: nextData, summary: `${result.summary ?? ''}（结果较多，只返回前 ${keep}/${items.length} 条，可加筛选条件或翻页）`.trim() };
  }
  return { ...result, data: `${text.slice(0, MAX_RESULT_CHARS)}…(已截断)` };
}

export function fromResult<T>(r: CosResult<T>, summary?: (d: T) => string, links?: (d: T) => string[]): CosToolResult {
  if (!r.ok) {
    const hint =
      r.code === 'BOT_CONFIRM_REQUIRED'
        ? '（平台没有收到同学的确认，这一步没有执行）'
        : r.code === 'BOT_SCOPE_DENIED'
        ? '（平台不允许机器人代办这个操作，请告诉同学在 App 里自己操作）'
        : r.code === 'NO_ACTOR'
          ? '（这次对话没有发消息人身份，无法代办）'
          : r.status === 404
            ? '（不存在，或这位同学没有权限看到）'
            : r.status === 403
              ? '（这位同学没有这个权限）'
              : '';
    return { ok: false, error: `${r.error}${hint}`, code: r.code, details: r.details };
  }
  return truncate({ ok: true, data: r.data, summary: summary?.(r.data), links: links?.(r.data) });
}

export function registerCosTool<S extends z.ZodTypeAny>(runtime: AgentRuntime, client: CosClient, def: CosToolDef<S>): void {
  const parameters = zodToJsonSchema(def.schema);
  COS_TOOL_META.set(def.name, { risk: def.risk ?? {} });
  const callFor = (ctx: ToolCallContext, signal?: AbortSignal): Call => {
    // 一张确认卡只用一次：只在这次调用的第一个写请求上带（代码审查 A2）。
    // 代发确认卡（绑定 POST /bot/messages）只给代发请求用，由 botSend 带上，不挂到建会议 / 写文档的请求上。
    let cardId = ctx.confirmation?.action?.route === BOT_MESSAGES_ROUTE ? undefined : ctx.confirmation?.cardId;
    return <T = unknown>(method: HttpMethod, path: string, req: Omit<CosRequest, 'actor'> = {}): Promise<CosResult<T>> => {
      const confirmCardId = method !== 'GET' ? cardId : undefined;
      if (confirmCardId) cardId = undefined;
      const request: CosRequest = {
        ...req,
        signal: req.signal ?? signal ?? ctx.signal,
        actor: { userId: ctx.actor?.userId, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId, confirmCardId },
      };
      return ctx.execution ? automationRequest<T>(ctx.execution, method, path, request) : client.request<T>(method, path, request);
    };
  };
  const riskOf = (raw: unknown): ToolRisk => {
    if (def.riskOf) {
      const p = def.schema.safeParse(raw);
      return p.success ? def.riskOf(p.data) : 'write';
    }
    const action = raw && typeof raw === 'object' ? (raw as { action?: unknown }).action : undefined;
    if (typeof action === 'string' && def.risk?.[action]) return def.risk[action];
    // 不带 action 的工具（如 cos_write_doc）：没声明风险就按 write
    if (def.readOnly) return 'read';
    return typeof action === 'string' ? inferActionRisk(action) : 'write';
  };
  const parse = (raw: unknown) => def.schema.safeParse(raw);
  /** 这次调用有没有要发到当前对话以外的消息。 */
  const outboundNeedsConfirm = (input: z.infer<S>, ctx?: ToolCallContext) =>
    !ctx?.execution && !!def.outbound?.(input).some((m) => sendNeedsConfirm(m.to, ctx?.actor));
  runtime.registerTool(
    def.name,
    parameters,
    async (raw, ctx) => {
      const parsed = parse(raw);
      if (!parsed.success) {
        return { ok: false, error: `参数不对：${parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'} ${i.message}`).join('；')}` };
      }
      if (ctx.execution) {
        const code = automationToolCode(ctx.execution, def.name, ctx.actor?.userId);
        if (code) return { ok: false, code, delivery: 'blocked' };
      }
      const input = parsed.data as z.infer<S> & { action?: string };
      // 兜底：没经过确认就到了这里（例如直接调用 execute），删除类一律不执行
      if (riskOf(input) === 'destructive' && !ctx.confirmation) {
        return {
          ok: false,
          need_confirmation: true,
          error: `「${input.action}」会删除数据且不能撤销，需要同学在确认卡片上点「确认」后才能执行。`,
        } satisfies CosToolResult;
      }
      // 兜底（代码审查 A4）：要往别的会话 / 别人发消息却没经过确认，整个调用都不做（不会建了会议才发现通知发不出去）
      if (!ctx.confirmation && outboundNeedsConfirm(input, ctx)) {
        return {
          ok: false,
          need_confirmation: true,
          code: 'SEND_NEEDS_CONFIRM',
          error: '这一步要以同学的名义往当前对话以外的会话或别人发消息，需要同学在确认卡片上点「确认」后才能执行。',
        } satisfies CosToolResult;
      }
      if (!ctx.confirmation && def.confirmIf?.(input, ctx)) {
        return { ok: false, need_confirmation: true, error: '这一步需要同学在确认卡片上点「确认」后才能执行。' } satisfies CosToolResult;
      }
      try {
        if (ctx.execution) {
          const operationId = `${def.name}:${revisionOf(parsed.data)}`;
          const trustedCtx = { ...ctx, toolCallId: operationId };
          return await automationOperation(ctx.execution, operationId, () => def.run(parsed.data, callFor(trustedCtx), { ...trustedCtx, client }));
        }
        return await def.run(parsed.data, callFor(ctx), { ...ctx, client });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      description: def.description,
      policy: {
        risk: riskOf,
        needsConfirm: (raw, risk, ctx) => {
          if (risk === 'destructive' || risk === 'physical') return true;
          const p = parse(raw);
          if (!p.success) return false;
          // 代发消息按「发到哪」判断（代码审查 A4）；其余写入按条数
          if (outboundNeedsConfirm(p.data, ctx)) return true;
          if (def.confirmIf?.(p.data, ctx)) return true;
          if (ctx?.execution && def.name === 'cos_broadcast') return false;
          return risk === 'write' && !!def.bulk && def.bulk(p.data) > BULK_CONFIRM;
        },
        label: (raw) => defaultToolLabel(def.name, raw),
        bind: async (raw, ctx) => {
          const p = parse(raw);
          if (!p.success) return undefined;
          if (outboundNeedsConfirm(p.data, ctx)) {
            // 代发：卡片绑定 POST /bot/messages + 目标 chat_id / user_id（人名先查成 user_id）
            const targets = await resolveOutbound(readOnly(callFor(ctx, AbortSignal.timeout(8_000))), def.outbound!(p.data), ctx.actor);
            return outboundAction(targets);
          }
          const w = await captureWrite(def, p.data, client, ctx);
          return w ? boundActionOf(w.method, w.path, w.body) : undefined;
        },
        preview:
          def.preview || def.outbound
            ? async (raw, ctx) => {
                const p = parse(raw);
                if (!p.success) return undefined;
                // 预演只读：超时 8 秒，失败就用默认说明
                const call = readOnly(callFor(ctx, AbortSignal.timeout(8_000)));
                const base = def.preview ? await def.preview(p.data, call).catch(() => undefined) : undefined;
                if (!outboundNeedsConfirm(p.data, ctx)) return base;
                const send = describeOutbound(await resolveOutbound(call, def.outbound!(p.data), ctx.actor));
                return [base, send].filter(Boolean).join('\n\n');
              }
            : undefined,
      },
    },
  );
}

/** 要求某些参数存在（flat schema + action 时按动作校验）。 */
export function need<T extends Record<string, unknown>>(input: T, action: string, keys: Array<keyof T & string>): CosToolResult | undefined {
  const missing = keys.filter((k) => input[k] === undefined || input[k] === null || input[k] === '');
  return missing.length ? { ok: false, error: `action=${action} 需要参数：${missing.join('、')}` } : undefined;
}

export const enc = encodeURIComponent;
