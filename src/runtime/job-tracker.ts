/**
 * 后台任务登记（AGENT_PLAN M3 §2.4）：网关处理超过几秒的请求时在平台建一条 job，
 * 随步骤更新，App 的「后台任务」里能看到进度；结束时标记完成 / 失败。
 * 全部是尽力而为：平台出错只记日志，不影响回复同学。
 */

import type { CosClient } from '../cos-sdk/client.js';

export interface JobStep {
  label: string;
  state: string;
}

export interface JobUpdate {
  status?: 'running' | 'done' | 'failed';
  progress?: number;
  message?: string | null;
  steps?: JobStep[];
  result?: Record<string, unknown>;
}

export interface JobTracker {
  create(input: { title: string; ownerId: string; chatId?: string; sessionId?: string }): Promise<string | undefined>;
  update(jobId: string, patch: JobUpdate): Promise<void>;
}

export function createCosJobTracker(client: CosClient, onError: (e: unknown) => void = () => {}): JobTracker {
  return {
    async create(i) {
      const r = await client.post<{ job_id: string }>(
        '/bot/jobs',
        { title: i.title.slice(0, 100), owner_id: i.ownerId, chat_id: i.chatId ?? null, session_id: i.sessionId ?? null, kind: 'agent_request' },
        { asBot: true },
      );
      if (!r.ok) {
        onError(new Error(`job create failed: ${r.error}`));
        return undefined;
      }
      return r.data.job_id;
    },
    async update(jobId, patch) {
      const r = await client.patch(`/bot/jobs/${encodeURIComponent(jobId)}`, patch, { asBot: true });
      if (!r.ok) onError(new Error(`job update failed: ${r.error}`));
    },
  };
}

/** 记录进度用：步骤 → 进度（完成数 / 总数，未结束时最多 0.95）。 */
export function progressOf(steps: Array<{ state: string }>): number {
  if (!steps.length) return 0;
  const done = steps.filter((s) => s.state === 'ok' || s.state === 'failed').length;
  return Math.min(0.95, Math.round((done / steps.length) * 100) / 100);
}
