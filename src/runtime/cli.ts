/**
 * `classmate` standalone CLI (PLAN §1.2-A7).
 *
 * Replaces `openclaw classmate <cmd>`. Zero new deps — hand-rolled argv
 * parsing is enough for three subcommands.
 *
 *   classmate status     打印配置/连通性健康状态（对齐旧 CLI 输出）
 *   classmate schema     重新生成 ClassmateOS DDL 到 stdout（等价 schema-to-sql）
 *   classmate scheduler  以前台进程运行全部定时任务（A6）
 *
 * Entry: bin.mjs next to this file (built output) or via `node --experimental-strip-types`.
 */

import { loadConfig } from './config-loader.js';
import { createRuntime } from './index.js';
import { startScheduler } from './scheduler.js';
import type { ClassmateConfig } from '../config.js';

const USAGE = `classmate <command>

Commands:
  status      打印配置与连通性状态
  schema      输出 ClassmateOS PostgreSQL DDL（同 scripts/schema-to-sql.mjs）
  scheduler   前台运行全部定时任务（Ctrl-C 退出）

Env:
  CLASSMATE_CONFIG   配置文件路径（yaml/json），缺省查找 ./classmate.config.*
  METACLAW_URL       MetaClaw proxy 地址，缺省 http://127.0.0.1:30000/v1
  CLASSMATE_MODEL    模型名
`;

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'scheduler':
      return cmdScheduler();
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
  const runtime = createRuntime({ config });
  const ac = new AbortController();

  const handle = startScheduler({
    config,
    signal: ac.signal,
    onLog: (m) => console.log(m),
    emit: async (task, jobId) => {
      try {
        const res = await runtime.runSession({
          sessionId: `sched_${jobId}_${Date.now()}`,
          messages: [{ role: 'user', content: task.prompt }],
        });
        console.log(`[scheduler/${jobId}] done: ${res.output.slice(0, 200)}`);
      } catch (err) {
        console.error(`[scheduler/${jobId}] failed:`, err instanceof Error ? err.message : err);
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
