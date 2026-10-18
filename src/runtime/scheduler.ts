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
        '请执行manage-project技能：检查甘特图多维表格中临近DDL（未来3天内）的任务；' +
        '汇总逾期任务，在广播群发送提醒。',
    },
    {
      id: 'equipment-patrol',
      cron: (s) => s.equipmentPatrolCron,
      skipIf: needBroadcast('equipment patrol'),
      prompt:
        '请执行器材巡检：检查设备多维表中长期借出未还（超过30天）与状态为"维修"的设备；' +
        '在广播群汇总报告，并私信提醒借用人归还。',
    },
    {
      id: 'project-progress-check',
      cron: (s) => s.projectProgressCheckCron,
      skipIf: needBroadcast('progress check'),
      prompt:
        '请执行manage-project技能：在北京时间14:00检查甘特图多维表格中DDL为今天的任务；' +
        '按负责人聚合任务并确保同一负责人当天仅提醒一次。每位负责人先驱动temi在实验室寻找并当面提醒；' +
        '若未找到，再通过私信发送合并提醒。',
    },
    {
      id: 'weekly-report',
      cron: (s) => s.weeklyReportCron,
      skipIf: needBroadcast('weekly report'),
      prompt:
        '请生成本周实验室周报：汇总甘特图进展、设备状态、研究动态，写入周报表并在广播群发布摘要。',
    },
    {
      id: 'idle-research',
      cron: (s) => s.idleLoopCron,
      // 闲置研究不依赖广播群——产出写入 research 表即可。
      prompt:
        '实验室处于空闲时段：请执行autonomous-research技能，从研究池中挑选一个课题做文献调研，' +
        '产出写入研究多维表。',
    },
  ];
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
