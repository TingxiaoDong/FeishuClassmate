/**
 * 大模型连接配置（AGENT_PLAN M5 真实评测）。
 *
 * 两种接法，都是 OpenAI 兼容的 /chat/completions：
 *   - deepseek：直连 DeepSeek（LLM_PROVIDER=deepseek，或填了 DEEPSEEK_API_KEY 且没设 METACLAW_URL）
 *       DEEPSEEK_API_KEY   必填
 *       DEEPSEEK_BASE_URL  默认 https://api.deepseek.com/v1
 *       CLASSMATE_MODEL    默认 deepseek-chat
 *   - metaclaw：经 MetaClaw 代理（原来的方式）
 *       METACLAW_URL / METACLAW_API_KEY / CLASSMATE_MODEL
 * DeepSeek 没有 MetaClaw 的 /memory/flush_session，直连时不调用。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type LlmProvider = 'deepseek' | 'metaclaw';

export interface LlmEnv {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 会话结束时要不要调 MetaClaw 的 flush_session。 */
  flush: boolean;
}

export const DEEPSEEK_DEFAULT_URL = 'https://api.deepseek.com/v1';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';

export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnv {
  const want = (env.LLM_PROVIDER ?? '').trim().toLowerCase();
  const dsKey = env.DEEPSEEK_API_KEY?.trim() || undefined;
  const provider: LlmProvider =
    want === 'deepseek' || (want !== 'metaclaw' && dsKey && !env.METACLAW_URL) ? 'deepseek' : 'metaclaw';
  if (provider === 'deepseek') {
    return {
      provider,
      baseUrl: env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULT_URL,
      model: env.CLASSMATE_MODEL?.trim() || DEEPSEEK_DEFAULT_MODEL,
      apiKey: dsKey,
      flush: false,
    };
  }
  return {
    provider,
    baseUrl: env.METACLAW_URL?.trim() || 'http://127.0.0.1:30000/v1',
    model: env.CLASSMATE_MODEL?.trim() || 'kimi-k2',
    apiKey: env.METACLAW_API_KEY?.trim() || undefined,
    flush: true,
  };
}

/** 选了 DeepSeek 却没填 Key 时返回提示，否则 undefined。 */
export function llmEnvProblem(e: LlmEnv): string | undefined {
  if (e.provider === 'deepseek' && !e.apiKey) {
    return '没有填 DeepSeek 的 API Key：请在项目根目录的 .env 里填上 DEEPSEEK_API_KEY=你的 Key';
  }
  return undefined;
}

/**
 * 读项目根目录的 .env（Node 自带 process.loadEnvFile，不覆盖已有的环境变量）。
 * 文件不存在时什么也不做；VITEST 下不读，避免本机 Key 影响单元测试。
 */
export function loadDotEnv(file = resolve(process.cwd(), '.env')): boolean {
  if (process.env.VITEST || !existsSync(file)) return false;
  const load = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof load !== 'function') return false;
  // loadEnvFile 会覆盖已有变量；先记下来再恢复，保证命令行里临时设的值优先
  const before = { ...process.env };
  load(file);
  for (const [k, v] of Object.entries(before)) process.env[k] = v;
  return true;
}
