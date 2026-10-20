/**
 * Standalone scheduler (PLAN §1.2-A6).
 *
 * Decouples the six cron jobs from the OpenClaw gateway: instead of
 * `api.emitAgentTask`, tasks are emitted through an injected `emit` callback —
 * the standalone process wires it to `runtime.runSession`, tests wire it to a
 * spy. Cron expressions keep coming from ClassmateConfig.schedules, so config
 * semantics are unchanged.
 *
 * Job set and prompts are ported 1:1 from src/services/project-scheduler.ts.
 */

import { scheduleCron, type CronHandle } from '../util/cron.js';
import type { ClassmateConfig } from '../config.js';

export interface ScheduledTaskSpec {
  /** Stable job id for logs. */
  id: string;
  cron: (cfg: ClassmateConfig['schedules']) => string;
  /** Guard: return a skip reason, or null to run. */
  skipIf?: (cfg: ClassmateConfig) => string | null;
  prompt: string;
}

export type EmitTaskFn = (task: { prompt: string; scope: 'scheduled' }, jobId: string) => Promise<void>;

/**
 * The five lab jobs (the sixth, idle-research loop, is registered separately
 * below because its prompt depends on config).
 */
export function buildTaskSpecs(): ScheduledTaskSpec[] {
  const needBroadcast = (what: string) => (cfg: ClassmateConfig) =>
    cfg.labInfo.broadcastChatId ? null : `${what} skipped: broadcastChatId unset`;

  return [
    {
      id: 'gantt-check',
      cron: (s) => s.ganttCheckCron,
      skipIf: needBroadcast('gantt check'),
      prompt:
        '请执行manage-project技能：用 cos_table 查甘特图 / 项目进度表中临近DDL（未来3天内）和已逾期的任务；' +
        '按负责人汇总，用 cos_im 在广播群发送提醒。',
    },
    {
      id: 'equipment-patrol',
      cron: (s) => s.equipmentPatrolCron,
      skipIf: needBroadcast('equipment patrol'),
      prompt:
        '请执行器材巡检：用 cos_table 查设备 / 器材借用表中长期借出未还（超过30天）与状态为"维修"的设备；' +
        '用 cos_im 在广播群汇总报告，并用 cos_broadcast 私信提醒借用人归还。',
    },
    {
      id: 'project-progress-check',
      cron: (s) => s.projectProgressCheckCron,
      skipIf: needBroadcast('progress check'),
      prompt:
        '请执行manage-project技能：在北京时间14:00检查甘特图多维表格中DDL为今天的任务；' +
        '按负责人聚合任务并确保同一负责人当天仅提醒一次。每位负责人先驱动temi在实验室寻找并当面提醒；' +
        '若未找到，再用 cos_broadcast 私信发送合并提醒。',
    },
    {
      id: 'weekly-report',
      cron: (s) => s.weeklyReportCron,
      skipIf: needBroadcast('weekly report'),
      prompt:
        '请按 weekly-report 技能生成本周实验室周报：用 cos_table_stats 汇总项目进度表 / 设备表，' +
        '用 cos_task、cos_calendar 补充本周完成的任务和开过的会；' +
        '用 cos_write_doc 写成文档《实验室周报 本周日期》，并用 share_chat_id 把链接和三句话摘要发到广播群。',
    },
    {
      id: 'idle-research',
      cron: (s) => s.idleLoopCron,
      // 闲置研究不依赖广播群——产出写入 research 表即可。
      prompt:
        '实验室处于空闲时段：请执行autonomous-research技能，从研究池中挑选一个课题做文献调研，' +
        '产出用 cos_write_doc 写成调研文档，并在研究表（cos_table）登记一条。',
    },
  ];
}

/**
 * 定时任务交给大脑前补上的上下文（AGENT_PLAN M3）：广播群 id、以谁的身份、不能确认。
 * 定时任务以服务账号（CLASSMATE_OS_AGENT_USER）身份运行，权限按这个账号算。
 */
export function scheduledPrompt(prompt: string, config: ClassmateConfig, agentUser?: string): string {
  const chat = config.labInfo.broadcastChatId;
  return [
    `〔定时任务〕${prompt}`,
    chat ? `广播群 chat_id=${chat}。` : '',
    agentUser ? `你以实验室服务账号（user_id=${agentUser}）的身份工作，只能看到这个账号有权限的数据。` : '',
    '现在没有同学在对话里：不能请人确认，删除数据、让机器人移动这类需要确认的操作会被系统跳过，不要尝试。',
    '数据一律先用工具读取，不要编造；某张表找不到就在报告里如实写「未找到」。',
  ].filter(Boolean).join('\n');
}

export interface SchedulerHandle {
  stop: () => void;
  jobIds: string[];
}

/**
 * Register all jobs against node-cron. Returns a handle for clean shutdown
 * (standalone process: wire to SIGINT/SIGTERM).
 */
export function startScheduler(opts: {
  config: ClassmateConfig;
  emit: EmitTaskFn;
  signal?: AbortSignal;
  onLog?: (msg: string) => void;
}): SchedulerHandle {
  const { config, emit, signal } = opts;
  const log = opts.onLog ?? (() => {});
  const handles: CronHandle[] = [];
  const jobIds: string[] = [];

  for (const spec of buildTaskSpecs()) {
    const expression = spec.cron(config.schedules);
    handles.push(
      scheduleCron(
        expression,
        async () => {
          const skip = spec.skipIf?.(config);
          if (skip) {
            log(`[scheduler/${spec.id}] ${skip}`);
            return;
          }
          log(`[scheduler/${spec.id}] firing`);
          await emit({ prompt: spec.prompt, scope: 'scheduled' }, spec.id);
        },
        signal,
      ),
    );
    jobIds.push(spec.id);
    log(`[scheduler/${spec.id}] scheduled: ${expression}`);
  }

  return { stop: () => handles.forEach((h) => h.stop()), jobIds };
}
