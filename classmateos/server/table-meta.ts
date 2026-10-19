/**
 * 多维表格的展示元数据（《前端接口需求文档》8.1）：
 * 中文表名 / 说明 / 图标 / 主字段 / 字段中文名 / 选项颜色。
 * 表结构本身仍以 src/bitable/schema.ts 为准，这里只补充给人看的信息。
 */

import type { FieldDef, TableDef } from '../../src/bitable/schema.js';

interface TableMeta {
  name: string;
  description: string;
  icon: string;
  primary_field: string;
  /** 表内特有的字段名翻译（覆盖 FIELD_TITLES）。 */
  titles?: Record<string, string>;
  required?: string[];
}

export const TABLE_META: Record<string, TableMeta> = {
  projects: { name: '项目', description: '实验室在研项目', icon: 'folder', primary_field: 'title' },
  gantt: { name: '甘特节点', description: '项目里程碑与进度', icon: 'timeline', primary_field: 'milestone' },
  equipment: { name: '器材', description: '器材台账与借还状态', icon: 'devices', primary_field: 'name', titles: { name: '器材名称' } },
  research: { name: '调研周报', description: '每周相关工作调研', icon: 'search', primary_field: 'topic' },
  weekly_digests: { name: '周报汇总', description: '实验室每周动态汇总', icon: 'article', primary_field: 'week' },
  submissions: { name: '投稿', description: '论文投稿管线', icon: 'send', primary_field: 'title' },
  standups: { name: '站会', description: '每日站会记录', icon: 'groups', primary_field: 'date' },
  tool_trace: { name: '工具调用记录', description: '机器人工具调用日志', icon: 'build', primary_field: 'tool_name' },
  papers: { name: '论文库', description: '论文阅读与引用', icon: 'menu_book', primary_field: 'title' },
  experiments: { name: '实验', description: '实验设计与结果', icon: 'science', primary_field: 'title' },
  reservations: { name: '器材预约', description: '器材预约与使用', icon: 'event_available', primary_field: 'equipment_id' },
  assignments: { name: '任务指派', description: '导师指派的任务', icon: 'assignment', primary_field: 'title' },
  training_runs: { name: '训练记录', description: '强化学习训练运行', icon: 'model_training', primary_field: 'run_id' },
  checkpoints: { name: '模型检查点', description: '训练产出的检查点', icon: 'save', primary_field: 'tag' },
  sim_runs: { name: '仿真记录', description: '仿真评测与 Sim2Real 差距', icon: 'view_in_ar', primary_field: 'sim_id' },
  skill_tree: { name: '技能树', description: '成员技能与熟练度', icon: 'account_tree', primary_field: 'skill_tag' },
  reading_group: { name: '读书会', description: '论文读书会安排', icon: 'local_library', primary_field: 'paper_title' },
  one_on_ones: { name: '一对一面谈', description: '导师与学生面谈', icon: 'forum', primary_field: 'meeting_id' },
  failure_archive: { name: '失败归档', description: '踩过的坑与教训', icon: 'report', primary_field: 'title' },
  lab_faq: { name: '实验室问答', description: '常见问题', icon: 'help', primary_field: 'question' },
  mentor_answers: { name: '导师答疑', description: '导师回答过的问题', icon: 'question_answer', primary_field: 'question_text' },
  lab_memes: { name: '实验室趣事', description: '实验室梗与趣事', icon: 'mood', primary_field: 'content_text' },
  task_decomposition: { name: '任务拆解', description: '目标拆解为子任务', icon: 'checklist', primary_field: 'parent_goal' },
};

export const FIELD_TITLES: Record<string, string> = {
  // 通用
  title: '标题',
  status: '状态',
  notes: '备注',
  created_at: '创建时间',
  updated_at: '更新时间',
  completed_at: '完成时间',
  started_at: '开始时间',
  project_id: '项目编号',
  paper_id: '论文编号',
  keywords: '关键词',
  tags: '标签',
  category: '分类',
  week: '周次',
  date: '日期',
  priority: '优先级',
  description: '描述',
  doc_url: '文档链接',
  doc_token: '文档链接',
  summary_md: '摘要',
  venue: '会议 / 期刊',
  ok: '是否成功',
  error: '错误信息',
  // 人员
  owner_open_id: '负责人',
  borrower_open_id: '借用人',
  author_open_ids: '作者',
  student_open_id: '学生',
  caller_open_id: '调用人',
  shared_by_open_id: '分享人',
  requester_open_id: '预约人',
  assigner_open_id: '指派人',
  assignee_open_id: '负责人',
  verified_by_open_id: '认证人',
  presenter_open_id: '主讲人',
  supervisor_open_id: '导师',
  reporter_open_id: '记录人',
  added_by_open_id: '添加人',
  asker_open_id: '提问人',
  answerer_open_id: '回答人',
  people_involved: '相关成员',
  attendees: '参加人',
  // projects
  visibility: '可见性',
  abstract_doc_token: '摘要文档',
  // gantt
  gantt_id: '节点编号',
  milestone: '里程碑',
  due_date: '截止日期',
  progress: '进度',
  // equipment
  equipment_id: '器材编号',
  name: '名称',
  location: '存放位置',
  state: '状态',
  borrow_at: '借出时间',
  expected_return: '预计归还',
  last_seen_at: '最后出现时间',
  // research
  report_id: '报告编号',
  topic: '主题',
  related_works: '相关工作',
  insights: '洞见',
  source_projects: '来源项目',
  // weekly_digests
  digest_id: '周报编号',
  completed_milestones: '完成里程碑数',
  active_projects: '活跃项目数',
  published_papers: '发表论文数',
  // submissions
  submission_id: '投稿编号',
  submitted_at: '投稿时间',
  decision_due: '预计出结果',
  decision_at: '出结果时间',
  // standups
  standup_id: '站会编号',
  yesterday: '昨天完成',
  today: '今天计划',
  blockers: '阻碍',
  // tool_trace
  trace_id: '记录编号',
  tool_name: '工具名',
  session_key: '会话',
  params_json: '参数',
  duration_ms: '耗时（毫秒）',
  // papers
  authors: '作者',
  year: '年份',
  doi: 'DOI',
  arxiv_id: 'arXiv 编号',
  abstract: '摘要',
  read_status: '阅读状态',
  added_at: '添加时间',
  // experiments
  exp_id: '实验编号',
  hypothesis: '假设',
  setup_md: '实验设置',
  metrics_json: '指标',
  result_summary: '结果总结',
  // reservations
  reservation_id: '预约编号',
  start_at: '开始时间',
  end_at: '结束时间',
  purpose: '用途',
  // assignments
  assign_id: '指派编号',
  parent_project_id: '所属项目',
  assigned_at: '指派时间',
  // training_runs
  run_id: '运行编号',
  algorithm: '算法',
  env_name: '环境',
  commit_hash: '提交哈希',
  seed: '随机种子',
  hyperparams_json: '超参数',
  wandb_url: 'W&B 链接',
  tb_url: 'TensorBoard 链接',
  final_reward: '最终回报',
  best_reward: '最佳回报',
  gpu_hours: 'GPU 小时',
  // checkpoints
  ckpt_id: '检查点编号',
  tag: '标签',
  artifact_url: '文件地址',
  eval_env: '评测环境',
  success_rate: '成功率',
  avg_reward: '平均回报',
  evaluated_on_real: '真机评测',
  deploy_status: '部署状态',
  saved_at: '保存时间',
  // sim_runs
  sim_id: '仿真编号',
  simulator: '仿真器',
  domain_rand_json: '域随机化参数',
  physics_params_json: '物理参数',
  sim_success_rate: '仿真成功率',
  real_success_rate: '真机成功率',
  sim_real_gap_percentage: 'Sim2Real 差距（%）',
  reproduce_command: '复现命令',
  findings: '发现',
  // skill_tree
  entry_id: '条目编号',
  skill_tag: '技能',
  proficiency: '熟练度',
  self_reported: '自评',
  example_project_id: '示例项目',
  last_used_at: '最近使用',
  // reading_group
  session_id: '场次编号',
  paper_title: '论文标题',
  paper_url: '论文链接',
  discussion_points_md: '讨论要点',
  actual_discussion_md: '实际讨论',
  rating_avg: '平均评分',
  // one_on_ones
  meeting_id: '面谈编号',
  scheduled_at: '预约时间',
  attended: '已参加',
  action_items_json: '待办事项',
  // failure_archive
  failure_id: '归档编号',
  context_md: '背景',
  failure_description_md: '失败描述',
  root_cause_md: '根因',
  workaround_or_lesson_md: '解决办法 / 教训',
  tldr: '一句话总结',
  related_project_id: '相关项目',
  related_paper_urls: '相关论文',
  hours_wasted: '耗费小时',
  // lab_faq
  faq_id: '问答编号',
  question: '问题',
  answer_md: '回答',
  difficulty: '难度',
  related_doc_urls: '相关文档',
  helpful_count: '有用次数',
  last_verified_at: '最近核实',
  // mentor_answers
  answer_id: '答疑编号',
  question_text: '问题',
  question_chat_id: '提问会话',
  helpful: '有帮助',
  // lab_memes
  meme_id: '编号',
  content_text: '内容',
  image_attachments: '图片',
  origin_date: '起源日期',
  laugh_count: '笑点数',
  // task_decomposition
  task_id: '任务编号',
  supervision_session_id: '督导会话',
  parent_goal: '总目标',
  subtasks_json: '子任务',
  total_estimated_min: '预计总时长（分钟）',
};

/** Bitable 选项颜色序号 → 前端调色板名。 */
const COLOR_NAMES = ['gray', 'red', 'blue', 'purple', 'green', 'turquoise', 'carmine', 'orange', 'yellow', 'wathet'];

export function fieldTitle(table: TableDef, field: FieldDef): string {
  return TABLE_META[table.key]?.titles?.[field.field_name] ?? FIELD_TITLES[field.field_name] ?? field.field_name;
}

export function describeTable(t: TableDef) {
  const meta = TABLE_META[t.key];
  const required = new Set(meta?.required ?? []);
  const primary =
    meta?.primary_field && t.fields.some((f) => f.field_name === meta.primary_field)
      ? meta.primary_field
      : t.fields.find((f) => f.type === 1)?.field_name;
  return {
    key: t.key,
    name: meta?.name ?? t.name,
    description: meta?.description ?? null,
    icon: meta?.icon ?? null,
    primary_field: primary ?? null,
    fields: t.fields.map((f) => {
      const raw = Array.isArray(f.property?.options) ? (f.property.options as Array<{ name: string; color?: number }>) : undefined;
      const optionColors: Record<string, string> = {};
      for (const o of raw ?? []) {
        if (typeof o.color === 'number') optionColors[o.name] = COLOR_NAMES[o.color % COLOR_NAMES.length];
      }
      return {
        field_name: f.field_name,
        title: fieldTitle(t, f),
        type: f.type,
        options: raw ? raw.map((o) => o.name) : undefined,
        option_colors: raw ? optionColors : undefined,
        required: required.has(f.field_name),
        description: null,
      };
    }),
  };
}

export function requiredFieldsOf(t: TableDef): string[] {
  return TABLE_META[t.key]?.required ?? [];
}
