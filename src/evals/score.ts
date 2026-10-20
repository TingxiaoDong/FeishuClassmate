/**
 * Agent 评测打分（AGENT_PLAN M2 / M5 §评测）。纯函数：输入题目 + 实际观察到的结果，输出是否通过和原因。
 * 题目格式见 evals/agent-cases.json；跑题见 scripts/run-evals.ts。
 */

export interface EvalStateCheck {
  path: string;
  contains?: string;
  not_contains?: string;
}

export interface EvalSetupStep {
  as: string;
  method: 'POST' | 'PATCH' | 'PUT';
  path: string;
  body?: unknown;
  /** 记下返回 JSON 的字段给后面用：{"doc": "doc_id"} → 之后可写 {{doc}}。 */
  save?: Record<string, string>;
}

/** M5 侧栏上下文：每一句都带着它发出（同学在文档 / 表格右侧的 AI 助手里提问）。 */
export interface EvalAgentContext {
  kind: 'doc' | 'table' | 'wiki' | 'file' | 'task' | 'calendar';
  id: string;
  title?: string;
  selection?: string;
  view_id?: string;
}

export interface EvalExpect {
  tools_any?: string[];
  tools_all?: string[];
  tools_none?: string[];
  actions_any?: string[];
  actions_none?: string[];
  confirm?: boolean;
  state?: EvalStateCheck[];
  output_any?: string[];
  output_none?: string[];
}

export interface EvalCase {
  id: string;
  category: string;
  turns: string[];
  setup?: EvalSetupStep[];
  requires?: string[];
  confirm_answer?: 'approve' | 'reject';
  context?: EvalAgentContext;
  expect: EvalExpect;
}

export interface EvalFile {
  version: number;
  cases: EvalCase[];
}

export interface ObservedCall {
  name: string;
  action?: string;
}

export interface Observed {
  /** 最后一句里调用过的工具（按顺序）。 */
  calls: ObservedCall[];
  /** 最后一句里有没有弹确认。 */
  confirmAsked: boolean;
  /** 最后一句的最终回复。 */
  output: string;
  /** 各状态检查的 GET 结果（与 expect.state 一一对应）。 */
  state: Array<{ status: number; body: string }>;
}

export interface Score {
  pass: boolean;
  failures: string[];
}

/** 校验题目文件结构，返回问题列表（空 = 合格）。 */
export function validateCases(file: EvalFile): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(file.cases) || !file.cases.length) return ['cases 不能为空'];
  for (const c of file.cases) {
    const at = `case ${c.id ?? '?'}`;
    if (!c.id || typeof c.id !== 'string') errs.push(`${at}: 缺 id`);
    if (ids.has(c.id)) errs.push(`${at}: id 重复`);
    ids.add(c.id);
    if (!Array.isArray(c.turns) || !c.turns.length || c.turns.some((t) => typeof t !== 'string' || !t.trim())) errs.push(`${at}: turns 必须是非空文本列表`);
    if (!c.expect || typeof c.expect !== 'object') errs.push(`${at}: 缺 expect`);
    else if (!Object.keys(c.expect).length) errs.push(`${at}: expect 至少要有一项检查`);
    if (c.confirm_answer && !['approve', 'reject'].includes(c.confirm_answer)) errs.push(`${at}: confirm_answer 只能是 approve / reject`);
    const saved = new Set((c.setup ?? []).flatMap((s) => Object.keys(s.save ?? {})));
    for (const s of c.setup ?? []) {
      for (const [k, v] of Object.entries(s.save ?? {})) if (!/^\w+$/.test(k) || typeof v !== 'string' || !v) errs.push(`${at}: setup.save 写法不对（${k}）`);
    }
    if (c.context) {
      if (!['doc', 'table', 'wiki', 'file', 'task', 'calendar'].includes(c.context.kind)) errs.push(`${at}: context.kind 不合法`);
      if (typeof c.context.id !== 'string' || !c.context.id) errs.push(`${at}: context.id 不能为空`);
      for (const m of JSON.stringify(c.context).matchAll(/\{\{(\w+)\}\}/g)) {
        if (!saved.has(m[1])) errs.push(`${at}: context 用到的 {{${m[1]}}} 没有在 setup.save 里记下`);
      }
    }
    for (const s of c.expect?.state ?? []) {
      if (!s.path?.startsWith('/')) errs.push(`${at}: state.path 必须以 / 开头`);
      if (s.contains === undefined && s.not_contains === undefined) errs.push(`${at}: state 需要 contains 或 not_contains`);
    }
  }
  return errs;
}

/** 从工具参数 JSON 里取 action。 */
export function actionOf(args: string): string | undefined {
  try {
    const a = (JSON.parse(args) as { action?: unknown }).action;
    return typeof a === 'string' ? a : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 组合工具 → 它所属的底层工具和等价动作。
 * 例如 cos_build_table 一次完成「建表 + 加记录」，按 cos_table 的 create_table / create_records 计分；
 * 平台状态检查不受影响（真没建成照样不过）。
 */
export const TOOL_FAMILY: Record<string, { family: string; actions: string[] }> = {
  cos_build_table: { family: 'cos_table', actions: ['create_table', 'create_records'] },
  cos_table_add_rows: { family: 'cos_table', actions: ['create_records'] },
  cos_table_stats: { family: 'cos_table', actions: ['list_records'] },
  cos_write_doc: { family: 'cos_doc', actions: ['create', 'append'] },
  cos_schedule_meeting: { family: 'cos_calendar', actions: ['create'] },
  cos_find_free_time: { family: 'cos_calendar', actions: ['freebusy'] },
  cos_assign_tasks: { family: 'cos_task', actions: ['create'] },
  cos_broadcast: { family: 'cos_im', actions: ['send'] },
};

export function scoreCase(c: EvalCase, o: Observed): Score {
  const f: string[] = [];
  const e = c.expect;
  const raw = new Set(o.calls.map((x) => x.name));
  const names = new Set([...raw, ...[...raw].map((n) => TOOL_FAMILY[n]?.family).filter((x): x is string => !!x)]);
  const actions = new Set([
    ...o.calls.map((x) => x.action).filter((x): x is string => !!x),
    ...o.calls.flatMap((x) => TOOL_FAMILY[x.name]?.actions ?? []),
  ]);
  const called = [...raw].join(', ') || '（没调工具）';

  if (e.tools_any && !e.tools_any.some((t) => names.has(t))) f.push(`应调用 ${e.tools_any.join(' / ')} 之一，实际：${called}`);
  for (const t of e.tools_all ?? []) if (!names.has(t)) f.push(`应调用 ${t}，实际：${called}`);
  for (const t of e.tools_none ?? []) if (names.has(t)) f.push(`不应调用 ${t}`);
  if (e.actions_any && !e.actions_any.some((a) => actions.has(a))) {
    f.push(`应执行 ${e.actions_any.join(' / ')} 之一，实际 action：${[...actions].join(', ') || '无'}`);
  }
  for (const a of e.actions_none ?? []) if (actions.has(a)) f.push(`不应执行 ${a}`);
  if (e.confirm === true && !o.confirmAsked) f.push('应先弹确认卡片，实际没有');
  if (e.confirm === false && o.confirmAsked) f.push('不该弹确认卡片，实际弹了');
  const out = o.output;
  if (e.output_any && !e.output_any.some((w) => out.includes(w))) f.push(`回复里应提到 ${e.output_any.join(' / ')} 之一`);
  for (const w of e.output_none ?? []) if (out.includes(w)) f.push(`回复里不应出现「${w}」`);
  (e.state ?? []).forEach((s, i) => {
    const got = o.state[i];
    if (!got) return f.push(`状态检查 ${s.path} 没有结果`);
    if (got.status >= 400) return f.push(`状态检查 ${s.path} 返回 ${got.status}`);
    if (s.contains !== undefined && !got.body.includes(s.contains)) f.push(`平台上找不到「${s.contains}」（${s.path}）`);
    if (s.not_contains !== undefined && got.body.includes(s.not_contains)) f.push(`平台上不应有「${s.not_contains}」（${s.path}）`);
  });
  return { pass: f.length === 0, failures: f };
}

/** 路径 / 请求体里的占位符：{{from}} {{to}} 前后 60 天；{{tomorrow_10}} {{tomorrow_11}} 明天 10 / 11 点。 */
export type EvalVars = Record<string, number | string>;

export function placeholders(now = new Date()): EvalVars {
  const day = 86_400_000;
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10).getTime();
  return { from: now.getTime() - 60 * day, to: now.getTime() + 60 * day, tomorrow_10: t, tomorrow_11: t + 3_600_000 };
}

/** 替换占位符：整个值就是占位符时换成数字，嵌在文本里时换成文本。 */
export function fill<T>(v: T, vars: EvalVars): T {
  if (typeof v === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(v);
    if (whole && whole[1] in vars) return vars[whole[1]] as unknown as T;
    return v.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) as unknown as T;
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars)) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)])) as T;
  return v;
}
