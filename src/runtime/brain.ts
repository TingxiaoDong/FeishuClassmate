/**
 * Brain assembly entry (PLAN §1.2-A9): wires config → runtime → compat api →
 * existing tool registry → ToolTrace telemetry. This replaces the OpenClaw
 * plugin entry (index.ts) for the new stack.
 *
 * Everything the old plugin did that still matters:
 *   - registerAllTools        → identical, via compat api
 *   - after_tool_call hook    → attachToolTraceTelemetry
 *   - scheduler               → separate process (src/runtime/scheduler.ts)
 *   - commands                → CLI (src/runtime/cli.ts)
 */

import { ClassmateRuntime } from './agent-runtime.js';
import { createCompatApi, consoleLogger, type CompatApi, type LoggerLike } from './compat-api.js';
import { loadConfig } from './config-loader.js';
import { MetaClawLlmClient, type LlmClientLike } from './llm-client.js';
import { loadSkills, buildSkillsPrompt, selectSkills } from './skills-loader.js';
import { attachToolTraceTelemetry } from './tool-trace.js';
import { registerAllTools } from '../tools/index.js';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ClassmateConfig } from '../config.js';

export interface BrainOptions {
  config?: ClassmateConfig;
  /** Test hook: inject a mock LLM instead of the MetaClaw proxy client. */
  llm?: LlmClientLike;
  skillsDir?: string;
  metaclawUrl?: string;
  model?: string;
  logger?: LoggerLike;
  /** Set false to disable ToolTrace writes (tests). Default true. */
  telemetry?: boolean;
}

export interface Brain {
  runtime: ClassmateRuntime;
  config: ClassmateConfig;
  api: CompatApi;
}

export function createBrain(opts: BrainOptions = {}): Brain {
  const config = opts.config ?? loadConfig();
  const logger = opts.logger ?? consoleLogger;

  const llm =
    opts.llm ??
    new MetaClawLlmClient({
      baseUrl: opts.metaclawUrl ?? process.env.METACLAW_URL ?? 'http://127.0.0.1:30000/v1',
      model: opts.model ?? process.env.CLASSMATE_MODEL ?? 'kimi-k2',
      apiKey: process.env.METACLAW_API_KEY,
    });

  const skills = opts.skillsDir ? loadSkills(opts.skillsDir) : [];
  const systemPrompt = [
    '你是飞书同学，实验室的智能助手。',
    skills.length > 0 ? buildSkillsPrompt(selectSkills(skills, '', 8)) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const flushTarget = 'flushSession' in llm && typeof llm.flushSession === 'function'
    ? (llm as MetaClawLlmClient)
    : undefined;

  const runtime = new ClassmateRuntime({
    llm,
    systemPrompt,
    flushSession: flushTarget ? (sid) => flushTarget.flushSession(sid) : undefined,
    onError: (err) => logger.warn?.(`[brain] non-fatal: ${err instanceof Error ? err.message : err}`),
  });

  const api = createCompatApi({ runtime, config, logger });
  // registerAllTools expects OpenClawPluginApi; the compat shim covers the
  // exact surface the tools use (registerTool / pluginConfig / logger).
  registerAllTools(api as unknown as OpenClawPluginApi);

  if (opts.telemetry !== false) {
    attachToolTraceTelemetry(runtime, { getConfig: () => config, logger });
  }

  logger.info(`[brain] ready: ${runtime.listTools().length} tools registered`);
  return { runtime, config, api };
}
