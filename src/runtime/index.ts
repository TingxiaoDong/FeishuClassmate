/**
 * Runtime module entry — factory wiring config → OpenAI-compatible LLM client → runtime
 * (PLAN §1.2-A3). This is the single place a new brain gets constructed.
 */

import { ClassmateRuntime } from './agent-runtime.js';
import { loadConfig } from './config-loader.js';
import { OpenAiLlmClient } from './openai-client.js';
import { loadSkills, buildSkillsPrompt, selectSkills, type SkillDoc } from './skills-loader.js';
import type { ClassmateConfig } from '../config.js';

export { ClassmateRuntime } from './agent-runtime.js';
export { OpenAiLlmClient } from './openai-client.js';
export { registerZodTool, zodToJsonSchema } from './zod-tool.js';
export { loadConfig, findConfigFile, parseConfigFile } from './config-loader.js';
export { loadSkills, selectSkills, buildSkillsPrompt, buildSkillsIndex, searchTerms } from './skills-loader.js';
export type { SkillDoc } from './skills-loader.js';
export type {
  AgentRuntime,
  ChatMessage,
  JsonSchema,
  RunSessionInput,
  RunSessionResult,
  RuntimeTool,
  ToolCallContext,
  ToolCallEvent,
  ToolCallHook,
} from './types.js';

export interface CreateRuntimeOptions {
  /** Pre-loaded config; defaults to loadConfig() (YAML/JSON file + env). */
  config?: ClassmateConfig;
  /** Directory containing SKILL.md files (one subdirectory per skill). Omit to skip skill injection. */
  skillsDir?: string;
  /** Override the OpenAI-compatible LLM URL; default env LLM_BASE_URL. */
  llmBaseUrl?: string;
  /** Model name; default env CLASSMATE_MODEL or 'deepseek-chat'. */
  model?: string;
  apiKey?: string;
  onError?: (err: unknown) => void;
}

/** Build a ready-to-use runtime pointed at an OpenAI-compatible endpoint. */
export function createRuntime(opts: CreateRuntimeOptions = {}): ClassmateRuntime {
  void (opts.config ?? loadConfig()); // loaded now so PAL adapters can share it later

  const llm = new OpenAiLlmClient({
    baseUrl: opts.llmBaseUrl ?? process.env.LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1',
    model: opts.model ?? process.env.CLASSMATE_MODEL ?? 'deepseek-chat',
    apiKey: opts.apiKey ?? process.env.LLM_API_KEY,
  });

  let skills: SkillDoc[] = [];
  if (opts.skillsDir) skills = loadSkills(opts.skillsDir);

  const systemPrompt = [
    '你是飞书同学，实验室的智能助手。',
    opts.skillsDir ? buildSkillsPrompt(selectSkills(skills, '', 8)) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return new ClassmateRuntime({
    llm,
    systemPrompt,
    onError: opts.onError,
  });
}
