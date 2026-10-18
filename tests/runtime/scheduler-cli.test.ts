/**
 * A6/A7 tests: standalone scheduler registration + CLI status payload.
 */

import { describe, expect, it, vi } from 'vitest';
import cron from 'node-cron';
import { buildTaskSpecs, startScheduler } from '../../src/runtime/scheduler.js';
import { statusPayload } from '../../src/runtime/cli.js';
import { createFakeConfig } from '../helpers/fake-config.js';

describe('startScheduler (A6)', () => {
  it('registers all five jobs with valid cron expressions', () => {
    const cfg = createFakeConfig();
    const emit = vi.fn().mockResolvedValue(undefined);
    const logs: string[] = [];
    const handle = startScheduler({
      config: cfg,
      emit,
      onLog: (m) => logs.push(m),
    });
    expect(handle.jobIds).toEqual([
      'gantt-check',
      'equipment-patrol',
      'project-progress-check',
      'weekly-report',
      'idle-research',
    ]);
    for (const line of logs) {
      const expr = line.split('scheduled: ')[1];
      expect(expr).toBeTruthy();
      expect(cron.validate(expr)).toBe(true);
    }
    handle.stop();
  });

  it('buildTaskSpecs keeps prompts from the legacy gateway service', () => {
    const specs = buildTaskSpecs();
    const progress = specs.find((s) => s.id === 'project-progress-check');
    expect(progress?.prompt).toContain('manage-project');
    expect(progress?.prompt).toContain('temi');
    // 广播守卫：未配置 broadcastChatId 时给出 skip 原因
    const cfg = createFakeConfig();
    cfg.labInfo.broadcastChatId = undefined;
    expect(progress?.skipIf?.(cfg)).toMatch(/broadcastChatId/);
    // idle-research 无广播守卫
    const idle = specs.find((s) => s.id === 'idle-research');
    expect(idle?.skipIf).toBeUndefined();
  });
});

describe('classmate CLI (A7)', () => {
  it('statusPayload redacts secrets and mirrors the legacy CLI shape', () => {
    const cfg = createFakeConfig();
    const out = statusPayload(cfg) as {
      feishu: { appId: string };
      bitable: { appToken: string };
      schedules: Record<string, string>;
    };
    expect(out.feishu.appId).toBe('test_a...');
    expect(out.feishu.appId).not.toContain('test_app_id');
    expect(out.bitable.appToken).toBe('test_b...');
    expect(out.schedules.ganttCheckCron).toBeTruthy();
  });
});
