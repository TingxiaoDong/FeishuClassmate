/**
 * 网关里的「自动化」触发器接线（cmdGateway 与端到端测试共用同一个入口，A-R01）。
 *
 * 网关始终注入可信调度器：
 * - 定时触发 → 可信调度器直接投递批准文档的受保护链接，不调用模型、不发模型正文；
 * - 事件触发、手动触发等不支持的情况 → 明确受阻（UNSUPPORTED_CAPABILITY），不回退普通 bot、不回当前会话；
 * - 没配专用密钥（或密钥太短 / 与 bot 令牌相同）→ SCHEDULER_NOT_CONFIGURED，同样受阻。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createTrustedScheduler } from './automation-scheduler-client.js';
import { createTriggerEngine, type TriggerEngine, type TriggerEngineOptions } from './trigger-engine.js';

export interface GatewayTriggerDeps extends Omit<TriggerEngineOptions, 'trustedScheduler' | 'automationBackend'> {
  baseUrl: string;
  botToken: string;
  env?: NodeJS.ProcessEnv;
  /** 仅测试：替换 HTTP 实现、时钟。生产不传。 */
  fetch?: typeof fetch;
  schedulerNow?: () => number;
}

export function automationStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLASSMATE_AUTOMATION_STATE_DIR || join(homedir(), '.classmate', 'automation');
}

export function createGatewayTriggers(deps: GatewayTriggerDeps): TriggerEngine | undefined {
  const env = deps.env ?? process.env;
  if (env.CLASSMATE_TRIGGERS === '0') return undefined;
  const { baseUrl, botToken, fetch: transport, schedulerNow, env: _env, ...engine } = deps;
  const trustedScheduler = createTrustedScheduler({
    baseUrl,
    botToken,
    schedulerToken: env.CLASSMATE_OS_AUTOMATION_SCHEDULER_TOKEN ?? '',
    stateDir: automationStateDir(env),
    ...(transport ? { fetch: transport } : {}),
    ...(schedulerNow ? { now: schedulerNow } : {}),
  });
  return createTriggerEngine({ ...engine, trustedScheduler });
}
