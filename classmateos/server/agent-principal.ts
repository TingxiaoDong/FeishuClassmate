/**
 * Agent Principal（AGENT_PLAN §2.2）：机器人「代表某位同学」调用平台接口。
 *
 * 请求头：
 *   X-Bot-Token: <bot 令牌>
 *   X-On-Behalf-Of: <user_id>          代表谁操作（必填，否则仍按普通 bot 处理）
 *   X-Agent-Session: <session_id>      可选，审计用
 *   X-Agent-Tool-Call: <tool_call_id>  可选，审计用
 *
 * 权限 = 该同学自己的权限 ∩ 机器人作用域：
 *   - 业务接口照常按 user_id 鉴权（同学看不到的保密记录，机器人也拿不到）；
 *   - 作用域黑名单里的接口（登录、改账号、改文档权限、转让等）机器人一律不能代办。
 *
 * 审计：机器人代办的每个请求都记一条（谁、代谁、哪个接口、结果状态码、会话 / 工具调用 id），
 * GET /api/v1/bot/audit 可查（bot 令牌或管理员）。
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EntityRecord, MessageRecord } from './repo.js';

export interface AgentScopeOptions {
  /**
   * 禁止机器人代办的接口：「METHOD 路由」，METHOD 可写 *，路由按 Fastify 注册的路径写，
   * 末尾 * 表示前缀匹配。缺省用 DEFAULT_BOT_DENY。
   */
  deny?: string[];
  /** 在缺省黑名单之外再追加的条目。 */
  extraDeny?: string[];
  /** 允许机器人代办删除类操作（DELETE、批量删除）。缺省 false。 */
  allowDestructive?: boolean;
}

const DESTRUCTIVE_RULES = new Set(['DELETE *', 'POST /api/v1/tables/:table_key/records/batch_delete']);

export const DEFAULT_BOT_DENY: string[] = [
  '* /api/v1/auth/*',
  // 卡片只能由同学本人点：否则机器人可以替同学「确认」自己发的删除确认卡片
  '* /api/v1/cards/*',
  'DELETE *',
  'POST /api/v1/tables/:table_key/records/batch_delete',
  'GET /api/v1/dashboard/summary',
  'POST /api/v1/users',
  'PATCH /api/v1/users/:user_id',
  'PATCH /api/v1/users/me',
  '* /api/v1/devices*',
  'PUT /api/v1/users/me/notification-settings',
  'PUT /api/v1/docs/:doc_id/permissions',
  'POST /api/v1/docs/:doc_id/transfer',
  'POST /api/v1/docs/:doc_id/access-requests/*',
  'PUT /api/v1/tasklists/:list_id/members',
  // 迭代 5：账号安全 / 管理后台
  'POST /api/v1/users/me/password',
  '* /api/v1/users/me/sessions*',
  'POST /api/v1/users/me/logout-all',
  'POST /api/v1/users/:user_id/logout-all',
  'POST /api/v1/users/:user_id/reset-password',
  '* /api/v1/admin/*',
];

export class BotScopePolicy {
  private readonly rules: Array<{ method: string; path: string; prefix: boolean }>;

  constructor(opts: AgentScopeOptions = {}) {
    const list = [...(opts.deny ?? DEFAULT_BOT_DENY), ...(opts.extraDeny ?? [])].filter(
      (r) => !(opts.allowDestructive && DESTRUCTIVE_RULES.has(r.trim())),
    );
    this.rules = list.map((r) => {
      const [m, p = ''] = r.trim().split(/\s+/, 2);
      const prefix = p.endsWith('*');
      return { method: m.toUpperCase(), path: prefix ? p.slice(0, -1) : p, prefix };
    });
  }

  /** 命中的规则是不是「删除类」（这类规则可以凭同学确认过的卡片放行）。 */
  isDestructiveRule(rule: string): boolean {
    return DESTRUCTIVE_RULES.has(rule);
  }

  /** 返回 null 表示允许，否则返回命中的规则。 */
  check(method: string, routeUrl: string): string | null {
    const M = method.toUpperCase();
    for (const r of this.rules) {
      if (r.method !== '*' && r.method !== M) continue;
      if (r.prefix ? routeUrl.startsWith(r.path) : routeUrl === r.path) return `${r.method} ${r.path}${r.prefix ? '*' : ''}`;
    }
    return null;
  }
}

export interface AgentAuditEntry {
  at: string;
  actor: 'bot';
  on_behalf_of: string;
  method: string;
  route: string;
  url: string;
  status: number | null;
  session_id: string | null;
  tool_call_id: string | null;
  /** 删除类操作凭哪张确认卡片放行。 */
  confirm_card?: string | null;
}

/** 落库用到的仓库方法（Memory / PG 双实现都有）。 */
export interface AuditRepo {
  saveEntity(rec: EntityRecord, expectedVersion: number): Promise<boolean>;
  listEntities(kind: string, scope?: string): Promise<EntityRecord[]>;
}

const AUDIT_KIND = 'agent_audit';

/**
 * 代办审计日志。传 repo 时落库（实体 kind=agent_audit，scope=被代办人），
 * 服务重启不丢；不传时只在内存保留最近 max 条（测试用）。
 */
export class AgentAuditLog {
  private readonly items: AgentAuditEntry[] = [];
  constructor(
    private readonly max = 5000,
    private readonly repo?: AuditRepo,
  ) {}

  async add(e: AgentAuditEntry): Promise<void> {
    if (this.repo) {
      await this.repo.saveEntity(
        { kind: AUDIT_KIND, id: `aud_${randomUUID()}`, scope: e.on_behalf_of, data: { ...e }, version: 0, created_at: e.at, updated_at: e.at },
        0,
      );
      return;
    }
    this.items.push(e);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  async list(q: { on_behalf_of?: string; session_id?: string; writes_only?: boolean; limit?: number } = {}): Promise<AgentAuditEntry[]> {
    let out = this.repo
      ? (await this.repo.listEntities(AUDIT_KIND, q.on_behalf_of)).map((r) => r.data as unknown as AgentAuditEntry)
      : this.items;
    if (this.repo) out = [...out].sort((a, b) => a.at.localeCompare(b.at));
    if (q.on_behalf_of) out = out.filter((e) => e.on_behalf_of === q.on_behalf_of);
    if (q.session_id) out = out.filter((e) => e.session_id === q.session_id);
    if (q.writes_only) out = out.filter((e) => e.method !== 'GET');
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    return out.slice(-limit).reverse();
  }
}

/** requireUser 识别出代办请求后挂到 req 上，onResponse 钩子据此写审计。 */
export interface AgentRequestMark {
  on_behalf_of: string;
  session_id: string | null;
  tool_call_id: string | null;
  confirm_card?: string | null;
}

// ---------------------------------------------------------------- 确认卡片

/** 确认卡片的两个按钮（App 点按钮时 action = 按钮文字）。 */
export const CONFIRM_YES = '确认';
export const CONFIRM_NO = '取消';
/** 同学直接打字回复时认的词。 */
export const CONFIRM_YES_WORDS = new Set(['确认', '确定', '是', '是的', '好', '好的', '可以', '同意', '没问题', '执行', 'ok', 'yes', 'y']);
export const CONFIRM_NO_WORDS = new Set(['取消', '不', '不要', '不用', '不行', '否', '算了', '别', 'no', 'n']);
/** 确认后多久内有效。 */
export const CONFIRM_TTL_MS = 10 * 60_000;

export function normalizeReply(text: string): string {
  return text.trim().toLowerCase().replace(/[。.!！~～,，\s]+$/u, '').trim();
}

/** 按文字判断是同意还是拒绝；判断不了返回 undefined。 */
export function confirmWordOf(text: string): typeof CONFIRM_YES | typeof CONFIRM_NO | undefined {
  const t = normalizeReply(text);
  if (CONFIRM_YES_WORDS.has(t)) return CONFIRM_YES;
  if (CONFIRM_NO_WORDS.has(t)) return CONFIRM_NO;
  return undefined;
}

/**
 * 核验确认卡片：机器人发的 kind=confirm 卡片、由被代办的同学本人点了「确认」、在有效期内。
 * 通过才允许删除类代办（不需要打开 CLASSMATE_OS_BOT_ALLOW_DELETE）。
 */
export function isValidConfirmCard(msg: MessageRecord | undefined, userId: string, botId: string, now = Date.now()): boolean {
  if (!msg || msg.sender_id !== botId || msg.msg_type !== 'interactive_card') return false;
  const c = msg.content as {
    kind?: unknown;
    answerable_by?: unknown;
    expired?: unknown;
    answer?: { user_id?: unknown; action?: unknown; answered_at?: unknown } | null;
  };
  if (c.kind !== 'confirm' || c.expired === true || !c.answer) return false;
  if (Array.isArray(c.answerable_by) && !c.answerable_by.includes(userId)) return false;
  if (c.answer.user_id !== userId || c.answer.action !== CONFIRM_YES) return false;
  const at = Date.parse(String(c.answer.answered_at ?? ''));
  return Number.isFinite(at) && now - at <= CONFIRM_TTL_MS;
}

const MARK = Symbol.for('cos.agentMark');

export function markAgentRequest(req: FastifyRequest, mark: AgentRequestMark): void {
  (req as unknown as Record<symbol, AgentRequestMark>)[MARK] = mark;
}

export function agentMarkOf(req: FastifyRequest): AgentRequestMark | undefined {
  return (req as unknown as Record<symbol, AgentRequestMark | undefined>)[MARK];
}

export function headerStr(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim().slice(0, 200) : null;
}

export function routeOf(req: FastifyRequest): string {
  return req.routeOptions?.url ?? req.url.split('?')[0];
}

/** 注册审计钩子 + 查询接口。 */
export function registerAgentAudit(
  app: FastifyInstance,
  deps: {
    audit: AgentAuditLog;
    isBot: (req: FastifyRequest) => boolean;
    isAdmin: (req: FastifyRequest) => Promise<boolean>;
  },
): void {
  app.addHook('onResponse', async (req, reply) => {
    const mark = agentMarkOf(req);
    if (!mark) return;
    await deps.audit.add({
      at: new Date().toISOString(),
      actor: 'bot',
      on_behalf_of: mark.on_behalf_of,
      method: req.method,
      route: routeOf(req),
      url: req.url.slice(0, 500),
      status: reply.statusCode ?? null,
      session_id: mark.session_id,
      tool_call_id: mark.tool_call_id,
      confirm_card: mark.confirm_card ?? null,
    });
  });

  app.get('/api/v1/bot/audit', async (req, reply) => {
    // 只认纯 bot 令牌（不带 on-behalf-of）或管理员登录
    const pureBot = deps.isBot(req) && !headerStr(req, 'x-on-behalf-of');
    if (!pureBot && !(await deps.isAdmin(req))) {
      return reply.code(403).send({ message: '只有管理员或机器人服务可以查看', code: 'FORBIDDEN' });
    }
    const q = req.query as { on_behalf_of?: string; session_id?: string; writes_only?: string; limit?: string };
    return {
      items: await deps.audit.list({
        on_behalf_of: q.on_behalf_of,
        session_id: q.session_id,
        writes_only: q.writes_only === 'true' || q.writes_only === '1',
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });
}
