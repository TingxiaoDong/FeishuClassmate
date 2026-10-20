/**
 * 工具护栏策略（AGENT_PLAN M2 §2.4）。
 *
 *   - 平台工具（cos_*）的策略在 src/tools/cos/ 里随工具一起声明；
 *   - 旧业务工具（Temi 等，经 compat-api 注册）在这里补：会让机器人移动的算 physical，要先确认；
 *     temi_stop 永远不拦（急停必须随时可用）。
 *   - defaultToolLabel：进度消息里显示的步骤名。
 */

import type { AgentRuntime, ToolPolicy } from './types.js';

const TOOL_LABELS: Record<string, string> = {
  cos_table: '多维表格',
  cos_doc: '云文档',
  cos_calendar: '日历',
  cos_task: '任务',
  cos_im: '消息',
  cos_drive: '云盘',
  cos_contact: '通讯录',
  cos_notify: '通知',
  cos_search: '搜索',
  cos_api_catalog: '查接口目录',
  cos_api: '调用平台接口',
  cos_find_people: '查找同学',
  cos_find_free_time: '查共同空闲时间',
  cos_schedule_meeting: '预约会议',
  cos_build_table: '建表并填数据',
  cos_table_add_rows: '往表格加行',
  cos_table_stats: '汇总表格',
  cos_write_doc: '写文档',
  cos_assign_tasks: '派任务',
  cos_daily_brief: '查看今日安排',
  cos_broadcast: '发通知',
  cos_automation: '设置自动化',
  feishu_classmate_temi_navigate_to: '让 Temi 前往',
  feishu_classmate_temi_speak: 'Temi 播报',
  feishu_classmate_temi_stop: 'Temi 停下',
  feishu_classmate_temi_wakeup: '唤醒 Temi',
  feishu_classmate_temi_control: '控制 Temi',
  feishu_classmate_temi_status: '查看 Temi 状态',
  feishu_classmate_temi_detect_person: 'Temi 找人',
  feishu_classmate_research_search_works: '检索论文',
  feishu_classmate_data_layout: '查看数据表结构',
  feishu_classmate_supervision_start: '开始专注监督',
  feishu_classmate_supervision_tick: '监督进度检查',
  feishu_classmate_supervision_summarize: '汇总专注记录',
  feishu_classmate_chat_pick_topic: '挑闲聊话题',
  feishu_classmate_chat_should_engage: '判断是否闲聊',
  feishu_classmate_research_arc_start: '提交研究验证',
  feishu_classmate_research_arc_status: '查看研究进度',
  feishu_classmate_research_arc_fetch: '取研究结果',
};

const ACTION_LABELS: Record<string, string> = {
  list_tables: '列出数据表', get_table: '查看表结构', create_table: '新建数据表', list_records: '查询记录',
  get_record: '查看记录', create_records: '新增记录', update_records: '修改记录', delete_records: '删除记录',
  add_field: '添加字段', update_field: '修改字段', delete_field: '删除字段', list_views: '查看视图', create_view: '新建视图',
  list: '列出', get: '查看', create: '新建', update: '修改', append: '追加内容', delete: '删除',
  list_comments: '查看评论', add_comment: '添加评论', comment: '评论', search: '搜索', me: '查看本人',
  send: '发送', rsvp: '回复邀请', upload_text: '上传文件', mark_read: '标为已读', freebusy: '查忙闲',
};

/** 进度消息里的步骤名：「多维表格 · 新增记录」。 */
export function defaultToolLabel(name: string, input: unknown): string {
  const base = TOOL_LABELS[name] ?? name.replace(/^feishu_classmate_/, '');
  const action = input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  if (name === 'cos_api' && input && typeof input === 'object') {
    const i = input as { method?: unknown; path?: unknown };
    return `${base} ${String(i.method ?? '')} ${String(i.path ?? '')}`.trim();
  }
  if (name === 'feishu_classmate_temi_navigate_to' && input && typeof input === 'object') {
    return `${base}「${String((input as { location?: unknown }).location ?? '')}」`;
  }
  return typeof action === 'string' ? `${base} · ${ACTION_LABELS[action] ?? action}` : base;
}

/** temi_control 的自然语言指令里有没有会让机器人移动的意思。 */
const MOVE_WORDS = /(去|走|前往|导航|移动|过来|回来|转|掉头|跟着|跟随|跟我|回充|充电桩|巡逻|带路|后退|前进|抬头|低头)/;

export const LEGACY_TOOL_POLICIES: Record<string, ToolPolicy> = {
  feishu_classmate_temi_navigate_to: {
    risk: () => 'physical',
    preview: async (i) => `让 Temi 机器人前往「${String((i as { location?: unknown }).location ?? '')}」。机器人会在实验室里移动，请确认路线上没有障碍、周围的人知道。`,
  },
  feishu_classmate_temi_control: {
    risk: (i) => (MOVE_WORDS.test(String((i as { instruction?: unknown }).instruction ?? '')) ? 'physical' : 'write'),
    preview: async (i) => `让 Temi 执行：「${String((i as { instruction?: unknown }).instruction ?? '')}」。机器人可能会移动。`,
  },
  feishu_classmate_temi_rfid_scan_route: {
    risk: () => 'physical',
    preview: async (i) => `让 Temi 沿路线「${String((i as { route?: unknown }).route ?? '默认路线')}」巡查 RFID 标签。机器人会在实验室里移动，请确认路线上没有障碍、周围的人知道。`,
  },
  feishu_classmate_temi_wakeup: { risk: () => 'write' },
  feishu_classmate_temi_speak: { risk: () => 'write' },
  feishu_classmate_temi_gesture: { risk: () => 'write' },
  feishu_classmate_temi_monitor_focus: { risk: () => 'write' },
  feishu_classmate_temi_status: { risk: () => 'read' },
  feishu_classmate_temi_detect_person: { risk: () => 'read' },
  // 急停：永远不需要确认
  feishu_classmate_temi_stop: { risk: () => 'physical', needsConfirm: () => false },
  // 其他旧业务工具（代码审查 A3：每个工具都要有显式策略，不靠默认值）
  feishu_classmate_data_layout: { risk: () => 'read' },
  feishu_classmate_supervision_start: { risk: () => 'write' },
  feishu_classmate_supervision_tick: { risk: () => 'write' },
  feishu_classmate_supervision_summarize: { risk: () => 'write' },
  feishu_classmate_chat_pick_topic: { risk: () => 'read' },
  feishu_classmate_chat_should_engage: { risk: () => 'write' },
  feishu_classmate_research_search_works: { risk: () => 'read' },
  feishu_classmate_research_arc_start: { risk: () => 'write' },
  feishu_classmate_research_arc_status: { risk: () => 'read' },
  feishu_classmate_research_arc_fetch: { risk: () => 'read' },
};

/**
 * 旧工具注册时用的策略表（代码审查 A3：物理工具必须在注册时带策略）。
 * confirmMoves=false（CLASSMATE_ROBOT_CONFIRM=off）时风险等级不变，只是移动不再弹确认。
 */
export function legacyPolicies(confirmMoves = robotConfirmEnabled()): Record<string, ToolPolicy> {
  if (confirmMoves) return LEGACY_TOOL_POLICIES;
  return Object.fromEntries(Object.entries(LEGACY_TOOL_POLICIES).map(([k, v]) => [k, { ...v, needsConfirm: () => false }]));
}

/** 给已注册的旧工具补上策略（没注册的跳过）。 */
export function applyLegacyPolicies(runtime: AgentRuntime, policies: Record<string, ToolPolicy> = LEGACY_TOOL_POLICIES): void {
  const names = new Set(runtime.listTools());
  for (const [name, policy] of Object.entries(policies)) {
    if (names.has(name)) runtime.setToolPolicy?.(name, policy);
  }
}

/**
 * 关闭机器人移动确认（例如导览现场由老师在旁边看着）：CLASSMATE_ROBOT_CONFIRM=off。
 * 删除类确认不能关。
 */
export function robotConfirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|off|false|no)$/i.test(env.CLASSMATE_ROBOT_CONFIRM ?? '');
}
