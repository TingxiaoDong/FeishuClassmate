/**
 * 后台异步任务（导入导出共用，迭代 5 第 4.8 节）。复用 agent_job 实体，GET /jobs/:job_id 在 routes-automation.ts。
 * 每次进度变化推 WS job.updated 给发起人。
 */
import { randomUUID } from 'node:crypto';
import type { Ctx } from './context.js';
import { nowIso } from './repo.js';
import type { JobData } from './routes-automation.js';

export class JobFailure extends Error {}

export interface JobRunner {
  create(owner: string, kind: string, title: string): Promise<JobData>;
  patch(jobId: string, p: Partial<JobData>): Promise<void>;
  /** 后台执行；fn 抛 JobFailure 时把它的 message 原样给用户，其他异常显示通用失败。 */
  run(job: JobData, fn: (update: (p: Partial<JobData>) => Promise<void>) => Promise<Record<string, unknown>>): Promise<void>;
  saveFile(owner: string, name: string, data: Buffer, contentType: string): Promise<string>;
}

const cache = new WeakMap<Ctx, JobRunner>();

export function jobsOf(ctx: Ctx): JobRunner {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const { repo } = ctx;
  const runner: JobRunner = {
    async create(owner, kind, title) {
      const now = nowIso();
      const d: JobData = {
        job_id: `job_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        kind, title, status: 'pending', progress: 0, message: null, steps: [], result: {},
        owner_id: owner, chat_id: null, session_id: null, created_at: now, updated_at: now, finished_at: null,
      };
      await repo.saveEntity({ kind: 'agent_job', id: d.job_id, scope: owner, data: { ...d }, version: 0, created_at: now, updated_at: now }, 0);
      return d;
    },
    async patch(jobId, p) {
      for (let i = 0; i < 6; i++) {
        const rec = await repo.getEntity('agent_job', jobId);
        if (!rec) return;
        const now = nowIso();
        const d = { ...(rec.data as unknown as JobData), ...p, updated_at: now };
        if (await repo.saveEntity({ ...rec, data: { ...d }, updated_at: now }, rec.version)) {
          ctx.publish('job.updated', { job: d }, [d.owner_id], { user_only: true });
          return;
        }
      }
    },
    async run(job, fn) {
      try {
        await runner.patch(job.job_id, { status: 'running', progress: 0.1 });
        const result = await fn((p) => runner.patch(job.job_id, p));
        await runner.patch(job.job_id, { status: 'done', progress: 1, message: null, result, finished_at: nowIso() });
      } catch (e) {
        if (!(e instanceof JobFailure)) console.error('[job] failed', job.job_id, e);
        const message = e instanceof JobFailure ? e.message : '任务失败，请稍后重试';
        await runner.patch(job.job_id, { status: 'failed', message, finished_at: nowIso() }).catch(() => undefined);
      }
    },
    async saveFile(owner, name, data, contentType) {
      const key = `f_${randomUUID()}_${name.replace(/[^\w.-]/g, '_').slice(-64)}`;
      await ctx.fileStore.write(key, data);
      const now = nowIso();
      await repo.createFile({ file_key: key, file_name: name, size: data.length, content_type: contentType, kind: 'other', uploader_id: owner, created_at: now, uploaded_at: now, in_drive: false, drive_added_at: null });
      return key;
    },
  };
  cache.set(ctx, runner);
  return runner;
}
