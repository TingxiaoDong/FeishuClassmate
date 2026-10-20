/**
 * 消息里的 AI 助手字段（AGENT_PLAN M5 §2.6）。
 *
 *   content.agent_context  同学从文档 / 表格的「AI 助手」侧栏发问时附带：当前打开的是哪个对象、选中了什么。
 *                          只是给大脑的提示，大脑读写对象时仍按同学本人的权限核验，伪造它拿不到额外数据。
 *   content.agent_result   机器人回复附带的结果卡片：这一轮建好 / 改过的对象链接和步骤。只有机器人能写。
 */

export const AGENT_CONTEXT_KINDS = ['doc', 'table', 'wiki', 'file', 'task', 'calendar'] as const;
export type AgentContextKind = (typeof AGENT_CONTEXT_KINDS)[number];

export interface AgentContext {
  kind: AgentContextKind;
  id: string;
  title?: string;
  /** 选中的文字 / 单元格，最多 2000 字。 */
  selection?: string;
  /** 表格当前视图。 */
  view_id?: string;
}

export interface AgentResultLink {
  link: string;
  kind: string;
  id: string;
  summary?: string;
}

export interface AgentResult {
  links: AgentResultLink[];
  steps?: { label: string; ok: boolean }[];
}

const ID_RE = /^[A-Za-z0-9_.:\-]{1,200}$/;
const LINK_RE = /^cos:\/\/([a-z]+)\/([A-Za-z0-9_.:\-]{1,200})$/;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

/** 校验侧栏上下文；不合法返回错误说明。 */
export function parseAgentContext(v: unknown): { value?: AgentContext; error?: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: '必须是对象' };
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !(AGENT_CONTEXT_KINDS as readonly string[]).includes(o.kind)) {
    return { error: `kind 必须是 ${AGENT_CONTEXT_KINDS.join(' / ')} 之一` };
  }
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return { error: 'id 不合法' };
  if (o.view_id !== undefined && (typeof o.view_id !== 'string' || !ID_RE.test(o.view_id))) return { error: 'view_id 不合法' };
  return {
    value: {
      kind: o.kind as AgentContextKind,
      id: o.id,
      ...(str(o.title, 200) ? { title: str(o.title, 200) } : {}),
      ...(str(o.selection, 2000) ? { selection: str(o.selection, 2000) } : {}),
      ...(typeof o.view_id === 'string' ? { view_id: o.view_id } : {}),
    },
  };
}

/** 校验机器人回复里的结果卡片。 */
export function parseAgentResult(v: unknown): { value?: AgentResult; error?: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: '必须是对象' };
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.links) || o.links.length > 20) return { error: 'links 必须是不超过 20 项的列表' };
  const links: AgentResultLink[] = [];
  for (const l of o.links) {
    const link = (l as { link?: unknown })?.link;
    const m = typeof link === 'string' ? LINK_RE.exec(link) : null;
    if (!m) return { error: 'links 里有不合法的 cos:// 链接' };
    links.push({ link: link as string, kind: m[1], id: m[2], ...(str((l as { summary?: unknown }).summary, 200) ? { summary: str((l as { summary?: unknown }).summary, 200) } : {}) });
  }
  let steps: AgentResult['steps'];
  if (o.steps !== undefined) {
    if (!Array.isArray(o.steps) || o.steps.length > 50) return { error: 'steps 必须是不超过 50 项的列表' };
    steps = o.steps.map((s) => ({ label: String((s as { label?: unknown })?.label ?? '').slice(0, 100), ok: (s as { ok?: unknown })?.ok === true }));
  }
  return { value: { links, ...(steps ? { steps } : {}) } };
}
