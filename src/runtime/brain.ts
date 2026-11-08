/**
 * ClassmateOS Agent 组装入口：连接配置、运行时、平台工具和遥测。
 * 网关、调度器和客户端都通过这里构建同一套新栈 Agent。
 */

import { ClassmateRuntime } from './agent-runtime.js';
import { consoleLogger, type LoggerLike } from './logger.js';
import { loadConfig } from './config-loader.js';
import { OpenAiLlmClient, type LlmClientLike } from './openai-client.js';
import { resolveLlmEnv } from './llm-env.js';
import { loadSkills, buildSkillsPrompt, buildSkillsIndex, selectSkills } from './skills-loader.js';
import { attachToolTraceTelemetry } from './tool-trace.js';
import { registerCosTools, COS_TOOLS_PROMPT } from '../tools/cos/index.js';
import { registerM4Simulation } from '../robot/assembly.js';
import { ROBOT_TOOLS_PROMPT } from '../tools/robot/index.js';
import type { CosClient, CosClientOptions } from '../cos-sdk/client.js';
import type { ClassmateConfig } from '../config.js';

export interface BrainOptions {
  /** 可选视觉模型适配器；未配置时机器人只返回感知数据。 */
  describeImage?: import('../tools/robot/index.js').RobotToolsOptions['describeImage'];
  config?: ClassmateConfig;
  /** Test hook: inject a mock LLM instead of the network client. */
  llm?: LlmClientLike;
  skillsDir?: string;
  llmBaseUrl?: string;
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
    new OpenAiLlmClient({
      baseUrl: opts.llmBaseUrl ?? llmEnv.baseUrl,
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

  const runtime = new ClassmateRuntime({
    llm,
    systemPrompt,
    onError: (err) => logger.warn?.(`[brain] non-fatal: ${err instanceof Error ? err.message : err}`),
  });

  const cos = cosOpts ? registerCosTools(runtime, { client: cosOpts }) : undefined;
  const m4Robot = process.env.CLASSMATE_ROBOT_M4 === '1';
  const robot = m4Robot ? registerM4Simulation(runtime, config, cos, opts.describeImage) : undefined;

  if (opts.telemetry !== false) {
    attachToolTraceTelemetry(runtime, { getConfig: () => config, logger });
  }

  logger.info(`[brain] ready: ${runtime.listTools().length} tools registered`);
  return { runtime, config, cos, llm, systemPromptFor, robot };
}
