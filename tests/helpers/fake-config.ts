/**
 * Returns a fully-populated ClassmateConfig with sensible test defaults.
 * All four table IDs are pre-set so tools never throw "run setup-bitable first".
 */
import type { ClassmateConfig } from '../../src/config.js';

export function createFakeConfig(overrides?: Partial<ClassmateConfig>): ClassmateConfig {
  const base: ClassmateConfig = {
    feishu: {
      appId: 'test_app_id',
      appSecret: 'test_app_secret',
      domain: 'feishu',
    },
    bitable: {
      appToken: 'test_bitable_token',
      tableIds: {
        projects: 'tbl_projects',
        gantt: 'tbl_gantt',
        equipment: 'tbl_equipment',
        research: 'tbl_research',
      },
    },
    docs: {
      publicProjects: 'doc_public',
      privateProjects: 'doc_private',
      researchReports: 'doc_research',
      dailyRecord: 'doc_daily',
    },
    labInfo: {
      name: 'Test Lab',
      supervisorName: 'Prof. Test',
      memberCount: 4,
      broadcastChatId: 'oc_test_chat',
      specialAreas: [{ name: '工位区', narration: '这里是工位区' }],
    },
    temi: {
      sidecarUrl: 'http://127.0.0.1:8091',
      mockMode: true,
    },
    arc: {
      sidecarUrl: 'http://127.0.0.1:8092',
      mockMode: true,
    },
    schedules: {
      ganttCheckCron: '0 9 * * *',
      equipmentPatrolCron: '30 8 * * *',
      idleLoopCron: '0 22 * * 1-5',
      projectProgressCheckCron: '0 14 * * *',
      weeklyReportCron: '0 18 * * 0',
    },
    supervision: {
      defaultIntervalMinutes: 10,
      maxDurationHours: 8,
    },
  };

  if (!overrides) return base;

  // Shallow-merge top-level keys
  return {
    ...base,
    ...overrides,
    feishu: { ...base.feishu, ...overrides.feishu },
    bitable: {
      ...base.bitable,
      ...overrides.bitable,
      tableIds: { ...base.bitable.tableIds, ...overrides.bitable?.tableIds },
    },
    temi: { ...base.temi, ...overrides.temi },
  };
}
