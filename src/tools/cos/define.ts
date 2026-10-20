/**
 * 平台工具的公共骨架（AGENT_PLAN §2.1）：
 *   - 自动带上「代表谁」（会话 actor → X-On-Behalf-Of）和审计 id；
 *   - 统一返回 { ok, data, summary, links }，结果过大自动截断；
 *   - 风险分级（AGENT_PLAN M2）：策略交给运行时——destructive 动作、超过 BULK_CONFIRM 条的批量写入
 *     先发确认卡片（带预演说明），同学同意后运行时把卡片 id 放进 ctx.confirmation，
 *     这里随请求带上 X-Agent-Confirm，服务端核验后才放行删除。
 */

import { z } from 'zod';
import { COS_API_CATALOG } from '../../cos-sdk/catalog.generated.js';
import { matchTemplate, type CosClient } from '../../cos-sdk/client.js';
import type { CosRequest, CosResult, HttpMethod } from '../../cos-sdk/types.js';
import type { AgentRuntime, BoundAction, ToolCallContext, ToolRisk } from '../../runtime/types.js';
import { defaultToolLabel } from '../../runtime/policy.js';
import { zodToJsonSchema } from '../../runtime/zod-tool.js';

export type { ToolRisk };

/** 一次写入超过这么多条就先请同学确认（预演）。 */
export const BULK_CONFIRM = 20;

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
      return typeof v === 'function' ? v.bind(target) : v;
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
    // 一张确认卡只用一次：只在这次调用的第一个写请求上带（代码审查 A2）
    let cardId = ctx.confirmation?.cardId;
    return (method, path, req = {}) => {
      const confirmCardId = method !== 'GET' ? cardId : undefined;
      if (confirmCardId) cardId = undefined;
      return client.request(method, path, {
        ...req,
        signal: req.signal ?? signal ?? ctx.signal,
        actor: { userId: ctx.actor?.userId, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId, confirmCardId },
      });
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
  runtime.registerTool(
    def.name,
    parameters,
    async (raw, ctx) => {
      const parsed = parse(raw);
      if (!parsed.success) {
        return { ok: false, error: `参数不对：${parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'} ${i.message}`).join('；')}` };
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
      try {
        return await def.run(parsed.data, callFor(ctx), { ...ctx, client });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      description: def.description,
      policy: {
        risk: riskOf,
        needsConfirm: (raw, risk) => {
          if (risk === 'destructive' || risk === 'physical') return true;
          if (risk !== 'write' || !def.bulk) return false;
          const p = parse(raw);
          return p.success && def.bulk(p.data) > BULK_CONFIRM;
        },
        label: (raw) => defaultToolLabel(def.name, raw),
        bind: async (raw, ctx) => {
          const p = parse(raw);
          if (!p.success) return undefined;
          const w = await captureWrite(def, p.data, client, ctx);
          return w ? boundActionOf(w.method, w.path, w.body) : undefined;
        },
        preview: def.preview
          ? async (raw, ctx) => {
              const p = parse(raw);
              if (!p.success) return undefined;
              // 预演只读：超时 8 秒，失败就用默认说明
              return def.preview!(p.data, callFor(ctx, AbortSignal.timeout(8_000)));
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
