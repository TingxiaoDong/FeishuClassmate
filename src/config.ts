/** ClassmateOS Agent 与服务端共用的配置模型。 */

export interface ClassmateConfig {
  feishu: {
    appId: string;
    appSecret: string;
    domain: 'feishu' | 'lark';
  };
  bitable: {
    appToken: string;
    tableIds: {
      projects?: string;
      gantt?: string;
      equipment?: string;
      research?: string;
      weekly_digests?: string;
      submissions?: string;
      standups?: string;
      tool_trace?: string;
      papers?: string;
      experiments?: string;
      reservations?: string;
      assignments?: string;
      training_runs?: string;
      checkpoints?: string;
      sim_runs?: string;
      skill_tree?: string;
      reading_group?: string;
      one_on_ones?: string;
      failure_archive?: string;
      lab_faq?: string;
      mentor_answers?: string;
      lab_memes?: string;
      task_decomposition?: string;
    };
  };
  docs: {
    publicProjects?: string;
    privateProjects?: string;
    researchReports?: string;
    /** @deprecated — kept for backward compat, prefer dailyRecordShortTerm */
    dailyRecord?: string;
    dailyRecordShortTerm?: string;
    dailyRecordLongTerm?: string;
    /** 导览母版 Doc token/url；也可用环境变量 FEISHU_DOC_TOUR_TEMPLATE */
    tourTemplate?: string;
  };
  labInfo: {
    name: string;
    supervisorName: string;
    memberCount: number;
    broadcastChatId?: string;
    specialAreas: Array<{ name: string; narration: string }>;
  };
  temi: {
    sidecarUrl: string;
    mockMode: boolean;
  };
  /** AutoResearchClaw sidecar — async 23-stage pipeline for validating lab ideas. */
  arc: {
    sidecarUrl: string;
    mockMode: boolean;
  };
  schedules: {
    ganttCheckCron: string;
    equipmentPatrolCron: string;
    idleLoopCron: string;
    projectProgressCheckCron: string;
    weeklyReportCron: string;
  };
  supervision: {
    defaultIntervalMinutes: number;
    maxDurationHours: number;
  };
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Merge plugin config with env-var fallbacks. Env wins only when config absent.
 */
export function readConfig(raw: unknown): ClassmateConfig {
  const cfg = (raw ?? {}) as Partial<ClassmateConfig>;

  return {
    feishu: {
      appId: cfg.feishu?.appId || process.env.FEISHU_APP_ID || '',
      appSecret: cfg.feishu?.appSecret || process.env.FEISHU_APP_SECRET || '',
      domain: (cfg.feishu?.domain || process.env.FEISHU_DOMAIN || 'feishu') as 'feishu' | 'lark',
    },
    bitable: {
      appToken: cfg.bitable?.appToken || process.env.FEISHU_BITABLE_APP_TOKEN || '',
      tableIds: cfg.bitable?.tableIds || {},
    },
    docs: {
      ...(cfg.docs || {}),
      tourTemplate:
        cfg.docs?.tourTemplate || process.env.FEISHU_DOC_TOUR_TEMPLATE || undefined,
    },
    labInfo: {
      name: cfg.labInfo?.name || 'Our Lab',
      supervisorName: cfg.labInfo?.supervisorName || '',
      memberCount: cfg.labInfo?.memberCount ?? 6,
      broadcastChatId: cfg.labInfo?.broadcastChatId,
      specialAreas: cfg.labInfo?.specialAreas || [],
    },
    temi: {
      sidecarUrl: cfg.temi?.sidecarUrl || process.env.TEMI_SIDECAR_URL || 'http://127.0.0.1:8091',
      mockMode: cfg.temi?.mockMode ?? envBool('TEMI_MOCK', true),
    },
    arc: {
      sidecarUrl: cfg.arc?.sidecarUrl || process.env.ARC_SIDECAR_URL || 'http://127.0.0.1:8092',
      mockMode: cfg.arc?.mockMode ?? envBool('ARC_MOCK', true),
    },
    schedules: {
      ganttCheckCron: cfg.schedules?.ganttCheckCron || '0 9 * * *',
      equipmentPatrolCron: cfg.schedules?.equipmentPatrolCron || '30 8 * * *',
      idleLoopCron: cfg.schedules?.idleLoopCron || '0 22 * * 1-5',
      projectProgressCheckCron: cfg.schedules?.projectProgressCheckCron || '0 14 * * *',
      weeklyReportCron: cfg.schedules?.weeklyReportCron || '0 18 * * 0',
    },
    supervision: {
      defaultIntervalMinutes: cfg.supervision?.defaultIntervalMinutes ?? 10,
      maxDurationHours: cfg.supervision?.maxDurationHours ?? 8,
    },
  };
}

/**
 * Fatal-fail check for credentials required to talk to Feishu.
 */
export function assertFeishuConfigured(cfg: ClassmateConfig): void {
  if (!cfg.feishu.appId || !cfg.feishu.appSecret) {
    throw new Error(
      'feishu-classmate: feishu.appId / feishu.appSecret missing. ' +
        'Set FEISHU_APP_ID + FEISHU_APP_SECRET env vars, or 在 ClassmateOS 配置中设置 FEISHU_APP_ID / FEISHU_APP_SECRET',
    );
  }
}

