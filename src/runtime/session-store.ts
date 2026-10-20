/**
 * 会话存储（AGENT_PLAN §2.3 / M2）：让网关每轮带上之前的对话，支持多轮。
 *
 * 只存「用户说的话 + 助手的最终回复」，不存工具调用的中间过程（太长、且 tool_call_id 跨轮无意义）；
 * 另外记下「最近操作过的对象」（工具返回的 cos:// 链接 + 摘要），注入下一轮，
 * 支持「把刚才那张表加一列」。
 *
 * 超出轮数 / 字数预算时，最早的几轮不是直接丢掉，而是交给 summarize 压成「之前对话的摘要」（M2 上下文压缩）。
 *
 *   MemorySessionStore  开发和测试
 *   RemoteSessionStore  存进 ClassmateOS（/bot/sessions，平台用 Memory / PostgreSQL 落库），网关重启不丢
 */

import type { CosClient } from '../cos-sdk/client.js';
import type { ChatMessage, RunSessionResult } from './types.js';

export interface RecentObject {
  link: string;
  summary?: string;
  at: number;
}

export interface SessionSnapshot {
  history: ChatMessage[];
  recent: RecentObject[];
  /** 被压缩掉的早期对话的摘要。 */
  summary?: string | null;
}

export interface SessionStore {
  load(sessionId: string): Promise<SessionSnapshot>;
  save(sessionId: string, snap: SessionSnapshot): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export const emptySnapshot = (): SessionSnapshot => ({ history: [], recent: [], summary: null });

export class MemorySessionStore implements SessionStore {
  private readonly data = new Map<string, SessionSnapshot>();

  async load(sessionId: string): Promise<SessionSnapshot> {
    const s = this.data.get(sessionId);
    return s ? structuredClone(s) : emptySnapshot();
  }

  async save(sessionId: string, snap: SessionSnapshot): Promise<void> {
    this.data.set(sessionId, structuredClone(snap));
  }

  async clear(sessionId: string): Promise<void> {
    this.data.delete(sessionId);
  }
}

/** 存在 ClassmateOS 平台里（bot 专用接口）。读失败时按空会话继续，不影响回答。 */
export class RemoteSessionStore implements SessionStore {
  constructor(
    private readonly client: CosClient,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  private path(id: string) {
    return `/bot/sessions/${encodeURIComponent(id)}`;
  }

  async load(sessionId: string): Promise<SessionSnapshot> {
    const r = await this.client.request<SessionSnapshot>('GET', this.path(sessionId), { asBot: true });
    if (!r.ok) {
      this.onError(new Error(`load session failed: ${r.error}`));
      return emptySnapshot();
    }
    return { history: r.data.history ?? [], recent: r.data.recent ?? [], summary: r.data.summary ?? null };
  }

  async save(sessionId: string, snap: SessionSnapshot): Promise<void> {
    const r = await this.client.request('PUT', this.path(sessionId), { asBot: true, body: snap });
    if (!r.ok) this.onError(new Error(`save session failed: ${r.error}`));
  }

  async clear(sessionId: string): Promise<void> {
    const r = await this.client.request('DELETE', this.path(sessionId), { asBot: true });
    if (!r.ok) this.onError(new Error(`clear session failed: ${r.error}`));
  }
}

export interface CompactOptions {
  /** 最多保留多少轮原文（一问一答算一轮），默认 12。 */
  maxTurns?: number;
  /** 原文总字数上限，默认 16000。 */
  maxChars?: number;
  /** 最近对象保留几个，默认 6。 */
  maxRecent?: number;
  /** 摘要字数上限，默认 1500。 */
  maxSummaryChars?: number;
}

/**
 * 记一轮并压缩：返回新快照。被挤出去的早期轮次交给 summarize 合并进摘要；
 * 没有 summarize 或它失败时，退化为把被挤出的话截短拼进摘要（不会整段丢掉）。
 */
export async function recordTurn(
  snap: SessionSnapshot,
  turn: { user: ChatMessage; assistant?: ChatMessage; recent: RecentObject[] },
  opts: CompactOptions & { summarize?: (prev: string | null | undefined, dropped: ChatMessage[]) => Promise<string> } = {},
): Promise<SessionSnapshot> {
  const next: SessionSnapshot = { history: [...snap.history], recent: [...snap.recent], summary: snap.summary ?? null };
  next.history.push(turn.user);
  if (turn.assistant) next.history.push(turn.assistant);
  const dropped = trimHistory(next.history, opts.maxTurns ?? 12, opts.maxChars ?? 16_000);
  if (dropped.length) {
    const maxSum = opts.maxSummaryChars ?? 1500;
    let summary: string | undefined;
    if (opts.summarize) {
      try {
        summary = (await opts.summarize(next.summary, dropped)).trim();
      } catch {
        summary = undefined;
      }
    }
    if (!summary) {
      const lines = dropped.map((m) => `${m.role === 'user' ? '同学' : '助手'}：${m.content.slice(0, 80)}`);
      summary = [next.summary, ...lines].filter(Boolean).join('\n');
    }
    next.summary = summary.length > maxSum ? `…${summary.slice(-maxSum)}` : summary;
  }
  for (const r of turn.recent) {
    next.recent = next.recent.filter((x) => x.link !== r.link);
    next.recent.push(r);
  }
  const maxRecent = opts.maxRecent ?? 6;
  if (next.recent.length > maxRecent) next.recent.splice(0, next.recent.length - maxRecent);
  return next;
}

/** 就地裁剪：按轮次和字数从最早开始丢，保证以 user 开头；返回被丢掉的消息。 */
export function trimHistory(history: ChatMessage[], maxTurns: number, maxChars: number): ChatMessage[] {
  const dropped: ChatMessage[] = [];
  const userIdx = () => history.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  let starts = userIdx();
  while (starts.length > maxTurns) {
    dropped.push(...history.splice(0, starts[1]));
    starts = userIdx();
  }
  const size = () => history.reduce((n, m) => n + m.content.length, 0);
  while (size() > maxChars && starts.length > 1) {
    dropped.push(...history.splice(0, starts[1]));
    starts = userIdx();
  }
  // 只剩一轮还超长：截断这一轮的内容
  if (size() > maxChars) {
    for (const m of history) if (m.content.length > maxChars / 2) m.content = `${m.content.slice(0, maxChars / 2)}…(已截断)`;
  }
  return dropped;
}

/** 从一轮会话的工具结果里提取操作过的对象（cos:// 链接 + 摘要）。 */
export function extractRecentObjects(res: Pick<RunSessionResult, 'messages'>, now = Date.now()): RecentObject[] {
  const out = new Map<string, RecentObject>();
  for (const m of res.messages) {
    if (m.role !== 'tool') continue;
    let parsed: { ok?: boolean; links?: unknown; summary?: unknown } | undefined;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!parsed?.ok || !Array.isArray(parsed.links)) continue;
    for (const link of parsed.links) {
      if (typeof link === 'string' && link.startsWith('cos://')) {
        out.set(link, { link, summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 120) : undefined, at: now });
      }
    }
  }
  return [...out.values()];
}

/** 最近对象 → 注入给模型的一段说明。 */
export function recentObjectsNote(recent: RecentObject[]): string | undefined {
  if (!recent.length) return undefined;
  const lines = [...recent].reverse().map((r) => `- ${r.link}${r.summary ? `：${r.summary}` : ''}`);
  return `〔工作记忆〕这个对话里最近操作过的对象（越靠前越新；同学说「刚才那张表 / 那篇文档」时指的就是它们）：\n${lines.join('\n')}`;
}

/** 摘要 → 注入给模型的一段说明。 */
export function summaryNote(summary: string | null | undefined): string | undefined {
  return summary ? `〔之前对话的摘要〕更早的对话已压缩如下：\n${summary}` : undefined;
}

/** 用大模型把被挤出的对话合并进摘要。 */
export function llmSummarizer(llm: { chat: (req: { messages: ChatMessage[]; sessionId: string; turnType: 'user' | 'tool'; temperature?: number }) => Promise<{ content: string }> }) {
  return async (prev: string | null | undefined, dropped: ChatMessage[]): Promise<string> => {
    const transcript = dropped.map((m) => `${m.role === 'user' ? '同学' : '助手'}：${m.content}`).join('\n');
    const res = await llm.chat({
      sessionId: `summary_${Date.now()}`,
      turnType: 'user',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你在给一段对话做滚动摘要。把「已有摘要」和「新挤出的对话」合并成一段不超过 400 字的中文摘要：' +
            '保留同学的目标、做过的操作和结果、提到的表格 / 文档 / 人名 / 时间等事实、还没完成的事；不要寒暄，不要编造。只输出摘要本身。',
        },
        { role: 'user', content: `已有摘要：\n${prev || '（无）'}\n\n新挤出的对话：\n${transcript}` },
      ],
    });
    return res.content;
  };
}
