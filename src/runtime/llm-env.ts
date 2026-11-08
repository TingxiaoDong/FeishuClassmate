/**
 * ClassmateOS Agent 的 OpenAI 兼容大模型连接配置。
 *
 * 支持直接连接 DeepSeek，也支持任意兼容 /chat/completions 的服务端点。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type LlmProvider = 'deepseek' | 'compatible';

export interface LlmEnv {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  flush: false;
}

export const DEEPSEEK_DEFAULT_URL = 'https://api.deepseek.com/v1';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';

export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnv {
  const baseUrl = env.LLM_BASE_URL?.trim() || env.DEEPSEEK_BASE_URL?.trim() || (env.DEEPSEEK_API_KEY ? DEEPSEEK_DEFAULT_URL : 'http://127.0.0.1:8080/v1');
  const apiKey = env.LLM_API_KEY?.trim() || env.DEEPSEEK_API_KEY?.trim() || undefined;
  return {
    provider: env.DEEPSEEK_API_KEY && !env.LLM_BASE_URL ? 'deepseek' : 'compatible',
    baseUrl,
    model: env.CLASSMATE_MODEL?.trim() || DEEPSEEK_DEFAULT_MODEL,
    apiKey,
    flush: false,
  };
}

export function llmEnvProblem(e: LlmEnv): string | undefined {
  if ((e.provider === 'deepseek' || e.provider === 'compatible') && !e.apiKey && e.baseUrl.includes('deepseek.com')) {
    return '没有填大模型 API Key：请在项目根目录的 .env 里填上 LLM_API_KEY 或 DEEPSEEK_API_KEY';
  }
  return undefined;
}

export function loadDotEnv(file = resolve(process.cwd(), '.env')): boolean {
  if (process.env.VITEST || !existsSync(file)) return false;
  const load = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof load !== 'function') return false;
  const before = { ...process.env };
  load(file);
  for (const [k, v] of Object.entries(before)) process.env[k] = v;
  return true;
}
