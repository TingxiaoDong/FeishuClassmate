/**
 * `classmate` standalone CLI (PLAN §1.2-A7).
 *
 * Replaces `classmate <cmd>`. Zero new deps — hand-rolled argv
 * parsing is enough for three subcommands.
 *
 *   classmate status     打印配置/连通性健康状态（对齐旧 CLI 输出）
 *   classmate schema     重新生成 ClassmateOS DDL 到 stdout（等价 schema-to-sql）
 *   classmate scheduler  以前台进程运行全部定时任务（A6）
 *
 * Entry: bin.mjs next to this file (built output) or via `node --experimental-strip-types`.
 */

import { createGatewayTriggers } from './gateway-triggers.js';
import { loadConfig } from './config-loader.js';
import { runScheduledAutomation } from './scheduler.js';
import { startScheduler } from './scheduler.js';
import { createCosJobTracker } from './job-tracker.js';
import { createBrain } from './brain.js';
import { createBotGateway } from './bot-gateway.js';
import { attachPlatformMetrics } from './agent-metrics.js';
import { bridgePlatformEstop, createVoiceChannel } from '../robot/voice-channel.js';
import { MemorySessionStore, RemoteSessionStore, llmSummarizer } from './session-store.js';
import { WsBotEventSource } from '../pal/bot-events.js';
import { createClassmateOSAdapter } from '../pal/classmateos-adapter.js';
import type { ClassmateConfig } from '../config.js';

const USAGE = `classmate <command>

Commands:
  status      打印配置与连通性状态
  schema      输出 ClassmateOS PostgreSQL DDL（同 scripts/schema-to-sql.mjs）
  scheduler   前台运行全部定时任务（Ctrl-C 退出）
  gateway     前台运行 Bot 网关：ClassmateOS 事件 → 大脑 → 回复（Ctrl-C 退出）

Env:
  CLASSMATE_CONFIG   配置文件路径（yaml/json），缺省查找 ./classmate.config.*
  LLM_BASE_URL      OpenAI 兼容接口地址，缺省 http://127.0.0.1:8080/v1
  LLM_API_KEY       大模型 API Key（直连服务时填写）
  CLASSMATE_MODEL    模型名
  CLASSMATE_OS_URL   平台 API，缺省 http://localhost:8080/api/v1
  CLASSMATE_OS_BOT_TOKEN  Bot 令牌
  CLASSMATE_OS_AGENT_USER 定时任务使用的服务账号 user_id（scheduler 用平台工具时必填）
  CLASSMATE_OS_AUTOMATION_SCHEDULER_TOKEN  可信调度器专用密钥（不配置则禁止外发）
  CLASSMATE_AUTOMATION_STATE_DIR  持久恢复目录（默认用户目录下 .classmate/automation）
  CLASSMATE_TRIGGERS      设为 0 关闭「自动化」触发器引擎
`;

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'scheduler':
      return cmdScheduler();
    case 'gateway':
      return cmdGateway();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

async function cmdStatus(): Promise<number> {
  const cfg = loadConfig();
  console.log(JSON.stringify(statusPayload(cfg), null, 2));
  return 0;
}

/** Extracted for tests: the same shape the old CLI printed. */
export function statusPayload(cfg: ClassmateConfig): Record<string, unknown> {
  return {
    feishu: {
      appId: cfg.feishu.appId ? `${cfg.feishu.appId.slice(0, 6)}...` : '(not set)',
      domain: cfg.feishu.domain,
    },
    bitable: {
      appToken: cfg.bitable.appToken ? `${cfg.bitable.appToken.slice(0, 6)}...` : '(not set)',
      tables: cfg.bitable.tableIds ?? {},
    },
    temi: {
      sidecarUrl: cfg.temi.sidecarUrl,
      mockMode: cfg.temi.mockMode,
    },
    arc: { sidecarUrl: cfg.arc.sidecarUrl, mockMode: cfg.arc.mockMode },
    labInfo: {
      name: cfg.labInfo.name,
      supervisor: cfg.labInfo.supervisorName,
      broadcastChatId: cfg.labInfo.broadcastChatId ?? '(not set)',
    },
    schedules: cfg.schedules,
  };
}

async function cmdScheduler(): Promise<number> {
  const config = loadConfig();
  const botToken = process.env.CLASSMATE_OS_BOT_TOKEN ?? '';
  const agentUser = process.env.CLASSMATE_OS_AGENT_USER || undefined;
  if (!botToken) {
    console.error('CLASSMATE_OS_BOT_TOKEN is required for scheduler');
    return 2;
  }
  const brain = createBrain({ config, skillsDir: process.env.CLASSMATE_SKILLS_DIR ?? 'skills', cos: { baseUrl: process.env.CLASSMATE_OS_URL ?? 'http://localhost:8080/api/v1', botToken } });
  if (!agentUser) console.warn('[scheduler] CLASSMATE_OS_AGENT_USER 未设置：平台工具会拒绝执行');
  const runtime = brain.runtime;
  const ac = new AbortController();

  const handle = startScheduler({
    config,
    signal: ac.signal,
    onLog: (m) => console.log(m),
    emit: async (task, jobId) => {
      try {
        const result = await runScheduledAutomation({ runtime, config, task, jobId, principalId: agentUser ?? '', systemPrompt: brain?.systemPromptFor(task.prompt) });
        console.log(`[scheduler/${jobId}] ${result.status}`);
      } catch (err) {
        console.error(`[scheduler/${jobId}] failed`);
      }
    },
  });
  console.log(`scheduler running with jobs: ${handle.jobIds.join(', ')}`);

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });
  ac.abort();
  handle.stop();
  console.log('scheduler stopped.');
  return 0;
}

async function cmdGateway(): Promise<number> {
  const baseUrl = process.env.CLASSMATE_OS_URL ?? 'http://localhost:8080/api/v1';
  const botToken = process.env.CLASSMATE_OS_BOT_TOKEN ?? '';
  if (!botToken) {
    console.error('CLASSMATE_OS_BOT_TOKEN is required for gateway');
    return 2;
  }
  const config = loadConfig();
  const brain = createBrain({ config, skillsDir: process.env.CLASSMATE_SKILLS_DIR ?? 'skills', cos: { baseUrl, botToken } });
  const { runtime } = brain;
  const logErr = (e: unknown) => console.error('[gateway]', e instanceof Error ? e.message : e);
  // 会话记忆存平台（网关重启不丢）；CLASSMATE_SESSION_STORE=memory 时只放内存
  const sessionStore =
    process.env.CLASSMATE_SESSION_STORE === 'memory' || !brain.cos ? new MemorySessionStore() : new RemoteSessionStore(brain.cos, logErr);
  const progressMs = Number(process.env.CLASSMATE_PROGRESS_DELAY_MS ?? 3000);
  const pal = createClassmateOSAdapter({
    baseUrl,
    botToken,
  });
  const eventSource = new WsBotEventSource({ baseUrl, botToken });
  const gateway = createBotGateway({
    runtime,
    eventSource,
    im: pal.im,
    onLog: (m) => console.log(m),
    onError: logErr,
    sessionStore,
    summarize: llmSummarizer(brain.llm),
    systemPromptFor: brain.systemPromptFor,
    progressDelayMs: progressMs > 0 ? progressMs : false,
    jobs: brain.cos ? createCosJobTracker(brain.cos, logErr) : undefined,
  });
  await gateway.start();
  console.log(`bot gateway running against ${baseUrl}`);

  // 「自动化」触发器（AGENT_PLAN M3 §2.5）：同学在平台上建的规则，事件 / 定时触发后以他的身份跑一轮
  const triggers = brain.cos
    ? createGatewayTriggers({ baseUrl, botToken, client: brain.cos, runtime, im: pal.im, eventSource, systemPromptFor: brain.systemPromptFor, onLog: (m) => console.log(m), onError: logErr })
    : undefined;
  await triggers?.start().catch(logErr);

  // 工具调用指标（AGENT_PLAN M5 §4）：只报工具名 / 成败 / 耗时，工作台「AI 助手」卡片展示
  const metrics =
    brain.cos && process.env.CLASSMATE_AGENT_METRICS !== '0'
      ? attachPlatformMetrics(runtime, brain.cos, { onError: (m) => console.error(m) })
      : undefined;

  // Temi（AGENT_PLAN M4）：App 急停 → 机器人急停；访客对 Temi 说话 → 大脑 → Temi 播报
  const robot = brain.robot;
  const stopEstop = robot ? bridgePlatformEstop(eventSource, robot, logErr) : undefined;
  const voice =
    robot && process.env.CLASSMATE_TEMI_VOICE !== '0'
      ? createVoiceChannel({ controller: robot, runtime, onLog: (m) => console.log(m), onError: logErr })
      : undefined;

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });
  triggers?.stop();
  metrics?.stop();
  await metrics?.flush().catch(logErr);
  voice?.stop();
  stopEstop?.();
  robot?.close();
  gateway.stop();
  console.log('bot gateway stopped.');
  return 0;
}
