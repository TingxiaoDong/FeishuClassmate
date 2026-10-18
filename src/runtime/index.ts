/**
 * Runtime module entry — factory wiring config → MetaClaw LLM client → runtime
 * (PLAN §1.2-A3). This is the single place a new brain gets constructed.
 */

import { ClassmateRuntime } from './agent-runtime.js';
import { loadConfig } from './config-loader.js';
import { MetaClawLlmClient } from './llm-client.js';
import { loadSkills, buildSkillsPrompt, selectSkills, type SkillDoc } from './skills-loader.js';
import type { ClassmateConfig } from '../config.js';

export { ClassmateRuntime } from './agent-runtime.js';
export { MetaClawLlmClient } from './llm-client.js';
export { registerZodTool, zodToJsonSchema } from './zod-tool.js';
export { loadConfig, findConfigFile, parseConfigFile } from './config-loader.js';
export { loadSkills, selectSkills, buildSkillsPrompt } from './skills-loader.js';
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
  /** Override MetaClaw proxy URL; default env METACLAW_URL or http://127.0.0.1:30000/v1. */
  metaclawUrl?: string;
  /** Model name; default env CLASSMATE_MODEL or 'kimi-k2'. */
  model?: string;
  apiKey?: string;
  onError?: (err: unknown) => void;
}

/** Build a ready-to-use runtime pointed at the MetaClaw proxy. */
export function createRuntime(opts: CreateRuntimeOptions = {}): ClassmateRuntime {
  void (opts.config ?? loadConfig()); // loaded now so PAL adapters can share it later

  const llm = new MetaClawLlmClient({
    baseUrl: opts.metaclawUrl ?? process.env.METACLAW_URL ?? 'http://127.0.0.1:30000/v1',
    model: opts.model ?? process.env.CLASSMATE_MODEL ?? 'kimi-k2',
    apiKey: opts.apiKey ?? process.env.METACLAW_API_KEY,
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
    flushSession: (sessionId) => llm.flushSession(sessionId),
    onError: opts.onError,
  });
}
