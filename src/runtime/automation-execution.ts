/** Agent 侧拟议契约 v1。不是现有 HTTP API；后端适配器接通前默认关闭。
 * 凭证只保留在 adapter 的闭包里，execution 是不透明句柄，不可序列化出权限。
 */
import { createHash } from 'node:crypto';
import type { CosRequest, CosResult, HttpMethod } from '../cos-sdk/types.js';

export interface AutomationTask {
  taskKind: 'trigger' | 'scheduler'; taskId: string; taskRevision: string; principalId: string;
  /** 调度器持久化的本次触发标识。恢复运行必须复用；不能由模型提供。 */
  occurrenceId: string;
}
export interface DeliveryTarget { type: 'chat_id' | 'user_id'; id: string }
export interface DeliveryResult {
  status: 'sent' | 'blocked' | 'failed'; code?: string; messageId?: string; retryable?: boolean;
}
export interface AutomationExecution { readonly kind: 'automation' }
export interface AutomationRun {
  task: AutomationTask; runId: string; grantId: string; expiresAt: number;
  scope: 'bot.messages.send'; targets: DeliveryTarget[];
  outputMode: 'controlled_summary' | 'permission_preserving_link';
  /** 必须是后端受限读取/写入客户端；禁止原样转发为普通 bot 请求。
   * 后端必须核验数据范围、写入操作与业务对象幂等；不得公开私有资源。
   */
  request?: <T>(method: HttpMethod, path: string, req?: CosRequest) => Promise<CosResult<T>>;
  /** 受控内容在可信层生成；不接收模型正文，后端核验链接权限和数据范围。 */
  deliver: (input: { logicalMessageId: string; target: DeliveryTarget; purpose: 'business' | 'final'; outputMode: AutomationRun['outputMode'] }) => Promise<DeliveryResult>;
}
export interface AutomationBackend {
  /** 仅开始已批准运行；不得在这里自动批准。凭证由实现保存在闭包。 */
  begin(task: AutomationTask): Promise<{ ok: true; run: AutomationRun } | { ok: false; code: string }>;
}
interface State { task: AutomationTask; run?: AutomationRun; code?: string; results: Map<string, DeliveryResult>; pending: Map<string, Promise<DeliveryResult>> }
const states = new WeakMap<AutomationExecution, State>();
const blocked = (code: string): DeliveryResult => ({ status: 'blocked', code, retryable: false });
const sameTask = (a: AutomationTask, b: AutomationTask) => ['taskKind', 'taskId', 'taskRevision', 'principalId', 'occurrenceId'].every(k => a[k as keyof AutomationTask] === b[k as keyof AutomationTask]);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
export const revisionOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export async function beginAutomation(task: AutomationTask, backend?: AutomationBackend): Promise<AutomationExecution> {
  const handle: AutomationExecution = Object.freeze({ kind: 'automation' });
  const state: State = { task: { ...task }, code: 'AUTHORIZATION_PENDING', results: new Map(), pending: new Map() };
  states.set(handle, state);
  if (!task.principalId || !task.taskRevision || !task.occurrenceId || !backend) return handle;
  try {
    const result = await backend.begin({ ...task });
    if (!result.ok) state.code = result.code;
    else if (!sameTask(task, result.run.task) || !result.run.runId || !result.run.grantId || result.run.scope !== 'bot.messages.send') state.code = 'RUN_INVALID';
    else { state.run = { ...result.run, task: { ...result.run.task }, targets: result.run.targets.map(t => ({ ...t })) }; state.code = undefined; }
  } catch { state.code = 'BACKEND_UNAVAILABLE'; }
  return handle;
}
export function executionCode(execution: AutomationExecution, principalId?: string): string | undefined {
  const s = states.get(execution);
  if (!s) return 'RUN_INVALID';
  if (s.code) return s.code;
  if (!s.run || s.run.expiresAt <= Date.now()) return 'RUN_EXPIRED';
  if (principalId !== undefined && principalId !== s.task.principalId) return 'PRINCIPAL_MISMATCH';
  return undefined;
}
export function automationTargetCode(execution: AutomationExecution, target: DeliveryTarget, principalId?: string): string | undefined {
  const code = executionCode(execution, principalId);
  if (code) return code;
  return states.get(execution)!.run!.targets.some(t => t.type === target.type && t.id === target.id) ? undefined : 'TARGET_OUT_OF_SCOPE';
}
/** 普通工具/原始 API 不得使用预授权绕过工具边界。 */
export function automationToolCode(execution: AutomationExecution, name: string, principalId?: string): string | undefined {
  if (!principalId) return 'PRINCIPAL_MISMATCH';
  const code = executionCode(execution, principalId);
  if (code) return code;
  const allowed = new Set(['cos_im', 'cos_broadcast', 'cos_schedule_meeting', 'cos_write_doc', 'cos_table', 'cos_table_stats', 'cos_doc', 'cos_wiki', 'cos_task', 'cos_calendar', 'cos_contact', 'cos_search', 'cos_workbench']);
  if (!allowed.has(name)) return 'AUTOMATION_TOOL_BLOCKED';
  if (!states.get(execution)?.run?.request) return 'READ_SCOPE_UNAVAILABLE';
  return undefined;
}
export async function automationRequest<T>(execution: AutomationExecution, method: HttpMethod, path: string, req: CosRequest = {}): Promise<CosResult<T>> {
  const code = executionCode(execution, req.actor?.userId);
  const request = states.get(execution)?.run?.request;
  if (code || !request) return { ok: false, status: 403, code: code ?? 'READ_SCOPE_UNAVAILABLE', error: '自动化受限调用不可用' };
  // 发送只能走 deliver；权限修改、加急和原始消息接口绝不透传。
  if (/messages|permissions|\/mail|\/notify|\/files|\/cards/.test(path)) return { ok: false, status: 403, code: 'AUTOMATION_TOOL_BLOCKED', error: '此操作不在自动化受限调用范围内' };
  try { return await request<T>(method, path, req); }
  catch { return { ok: false, status: 503, code: 'BACKEND_UNAVAILABLE', error: '自动化受限调用失败' }; }
}
export async function deliverAutomation(execution: AutomationExecution, target: DeliveryTarget, logicalMessageId: string, purpose: 'business' | 'final' = 'business', principalId?: string): Promise<DeliveryResult> {
  const code = automationTargetCode(execution, target, principalId);
  const key = JSON.stringify([logicalMessageId, target.type, target.id]);
  if (code) {
    const result = blocked(code);
    states.get(execution)?.results.set(key, result);
    return result;
  }
  const s = states.get(execution)!;
  const prev = s.results.get(key);
  if (prev && (prev.status !== 'failed' || !prev.retryable)) return prev;
  if (s.pending.has(key)) return s.pending.get(key)!;
  // 防止工具已发报告后又追加完整总结；这里只抑制重复，不替代服务端原子额度。
  if (purpose === 'final' && [...s.results.entries()].some(([k, r]) => r.status === 'sent' && JSON.parse(k)[1] === target.type && JSON.parse(k)[2] === target.id)) return { status: 'sent', code: 'ALREADY_DELIVERED' };
  const pending = (async () => {
    let result: DeliveryResult;
    try {
      result = await s.run!.deliver({ logicalMessageId, target, purpose, outputMode: s.run!.outputMode });
      if (!['sent', 'blocked', 'failed'].includes(result.status) || (result.status === 'sent' && !result.messageId)) result = blocked('INVALID_DELIVERY_RESULT');
      // 白名单拷贝，不将适配器返回的凭证/正文传播给模型。
      result = { status: result.status, code: result.code, messageId: result.messageId, retryable: result.status === 'failed' && result.retryable === true };
    } catch { result = { status: 'failed', code: 'DELIVERY_UNAVAILABLE', retryable: true }; }
    s.results.set(key, result);
    return result;
  })();
  s.pending.set(key, pending);
  try { return await pending; } finally { s.pending.delete(key); }
}
export function automationResults(execution: AutomationExecution): DeliveryResult[] { return [...(states.get(execution)?.results.values() ?? [])].map(r => ({ ...r })); }

/** 最终状态只由投递回执汇总，不采用模型的“已完成”。 */
export function automationStatus(execution: AutomationExecution): 'done' | 'partial' | 'blocked' | 'failed' {
  const rs = automationResults(execution);
  const sent = rs.some(r => r.status === 'sent');
  const notSent = rs.some(r => r.status !== 'sent');
  if (sent && notSent) return 'partial';
  if (sent) return 'done';
  return rs.some(r => r.status === 'failed') ? 'failed' : 'blocked';
}

const operations = new WeakMap<AutomationExecution, Map<string, Promise<unknown>>>();
/** 同一运行的同一业务意图只执行一次。持久幂等必须另由服务端保证。 */
export async function automationOperation<T>(execution: AutomationExecution, key: string, run: () => Promise<T>): Promise<T> {
  let entries = operations.get(execution);
  if (!entries) { entries = new Map(); operations.set(execution, entries); }
  const existing = entries.get(key);
  if (existing) return existing as Promise<T>;
  const pending = Promise.resolve().then(run);
  entries.set(key, pending);
  return pending;
}
