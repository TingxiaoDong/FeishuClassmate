/**
 * 请求级「代办上下文」（AGENT_PLAN M2）。
 *
 * requireUser 识别出机器人代办请求后，把「代谁、经哪张确认卡片」记到当前请求的
 * AsyncLocalStorage 里。记录历史、文档版本、任务动态等写入点直接读取，
 * 不用把 via_bot 一层层传参（也覆盖请求里起的定时器，例如文档版本的「停止编辑」计时）。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';

export interface RequestAgentState {
  /** 这个请求是机器人代某位同学发起的。 */
  via_bot?: boolean;
  on_behalf_of?: string;
  /** 经同学确认过的卡片 id（删除类操作的放行凭证）。 */
  confirm_card?: string | null;
}

const als = new AsyncLocalStorage<RequestAgentState>();

export function registerAgentContext(app: FastifyInstance): void {
  app.addHook('onRequest', (_req, _reply, done) => {
    als.run({}, done);
  });
}

export function agentState(): RequestAgentState | undefined {
  return als.getStore();
}

/** 当前请求是不是机器人代 `userId` 操作的（写入点用来打「代办」标记）。 */
export function viaBotFor(userId: string | null | undefined): boolean {
  const s = als.getStore();
  return !!s?.via_bot && !!userId && s.on_behalf_of === userId;
}

/** 测试用：在指定上下文里运行。 */
export function runWithAgentState<T>(state: RequestAgentState, fn: () => T): T {
  return als.run(state, fn);
}
