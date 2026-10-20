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
import { resolveLlmEnv } from './llm-env.js';
import { loadSkills, buildSkillsPrompt, buildSkillsIndex, selectSkills } from './skills-loader.js';
import { legacyPolicies } from './policy.js';
import { attachToolTraceTelemetry } from './tool-trace.js';
import { registerAllTools } from '../tools/index.js';
import { registerCosTools, COS_TOOLS_PROMPT } from '../tools/cos/index.js';
import { registerM4Simulation } from '../robot/assembly.js';
import { ROBOT_TOOLS_PROMPT } from '../tools/robot/index.js';
import type { CosClient, CosClientOptions } from '../cos-sdk/client.js';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ClassmateConfig } from '../config.js';

export interface BrainOptions {
  /** 可选视觉模型适配器；未配置时机器人只返回感知数据。 */
  describeImage?: import('../tools/robot/index.js').RobotToolsOptions['describeImage'];
  config?: ClassmateConfig;
  /** Test hook: inject a mock LLM instead of the MetaClaw proxy client. */
  llm?: LlmClientLike;
  skillsDir?: string;
  metaclawUrl?: string;
  model?: string;
  logger?: LoggerLike;
  /** Set false to disable ToolTrace writes (tests). Default true. */
  telemetry?: boolean;
  /**
   * ClassmateOS 平台工具（AGENT_PLAN M1）。传客户端或参数即注册 cos_* 工具；
   * 不传时若设置了 CLASSMATE_OS_URL + CLASSMATE_OS_BOT_TOKEN 则自动注册；传 false 关闭。
   */
  cos?: CosClient | CosClientOptions | false;
}

export interface Brain {
  robot?: import('../robot/controller.js').RobotController;
  runtime: ClassmateRuntime;
  config: ClassmateConfig;
  api: CompatApi;
  /** 已注册平台工具时的客户端。 */
  cos?: CosClient;
  /** 大模型客户端（网关用来做会话摘要）。 */
  llm: LlmClientLike;
  /**
   * 按同学这一句话生成系统提示（AGENT_PLAN M2）：只展开最相关的几个 skills，
   * 其余只列名字。没有 skills 时返回 undefined（用默认提示）。
   */
  systemPromptFor(text: string): string | undefined;
}

function resolveCosOptions(opt: BrainOptions['cos']): CosClient | CosClientOptions | undefined {
  if (opt === false) return undefined;
  if (opt) return opt;
  const baseUrl = process.env.CLASSMATE_OS_URL;
  const botToken = process.env.CLASSMATE_OS_BOT_TOKEN;
  if (!baseUrl || !botToken) return undefined;
  return { baseUrl, botToken, defaultUserId: process.env.CLASSMATE_OS_AGENT_USER || undefined };
}

export function createBrain(opts: BrainOptions = {}): Brain {
  const config = opts.config ?? loadConfig();
  const logger = opts.logger ?? consoleLogger;

  const llmEnv = resolveLlmEnv();
  const llm =
    opts.llm ??
    new MetaClawLlmClient({
      baseUrl: opts.metaclawUrl ?? llmEnv.baseUrl,
      model: opts.model ?? llmEnv.model,
      apiKey: llmEnv.apiKey,
    });

  const skills = opts.skillsDir ? loadSkills(opts.skillsDir) : [];
  const cosOpts = resolveCosOptions(opts.cos);
  const base = ['你是飞书同学，实验室的智能助手。', cosOpts ? COS_TOOLS_PROMPT : '', process.env.CLASSMATE_ROBOT_M4 === '1' ? ROBOT_TOOLS_PROMPT : ''].filter(Boolean);
  const systemPrompt = [...base, skills.length > 0 ? buildSkillsPrompt(selectSkills(skills, '', 8)) : '']
    .filter(Boolean)
    .join('\n\n');
  const maxSkills = Number(process.env.CLASSMATE_SKILLS_PER_TURN ?? 3) || 3;
  const systemPromptFor = (text: string): string | undefined => {
    if (!skills.length) return undefined;
    const picked = selectSkills(skills, text, maxSkills);
    const rest = skills.filter((s) => !picked.includes(s));
    return [...base, buildSkillsPrompt(picked), buildSkillsIndex(rest)].filter(Boolean).join('\n\n');
  };

  const flushTarget = (opts.llm || llmEnv.flush || opts.metaclawUrl) && 'flushSession' in llm && typeof llm.flushSession === 'function'
    ? (llm as MetaClawLlmClient)
    : undefined;

  const runtime = new ClassmateRuntime({
    llm,
    systemPrompt,
    flushSession: flushTarget ? (sid) => flushTarget.flushSession(sid) : undefined,
    onError: (err) => logger.warn?.(`[brain] non-fatal: ${err instanceof Error ? err.message : err}`),
  });

  // 旧业务工具（Temi 等）注册时就带上风险策略；CLASSMATE_ROBOT_CONFIRM=off 时移动不弹确认，急停永远不拦
  const api = createCompatApi({ runtime, config, logger, policies: legacyPolicies() });
  // registerAllTools expects OpenClawPluginApi; the compat shim covers the
  // exact surface the tools use (registerTool / pluginConfig / logger).
  const m4Robot = process.env.CLASSMATE_ROBOT_M4 === '1';
  registerAllTools(api as unknown as OpenClawPluginApi, { legacyTemi: !m4Robot });
  const cos = cosOpts ? registerCosTools(runtime, { client: cosOpts }) : undefined;
  const robot = m4Robot ? registerM4Simulation(runtime, config, cos, opts.describeImage) : undefined;

  if (opts.telemetry !== false) {
    attachToolTraceTelemetry(runtime, { getConfig: () => config, logger });
  }

  logger.info(`[brain] ready: ${runtime.listTools().length} tools registered`);
  return { runtime, config, api, cos, llm, systemPromptFor, robot };
}
