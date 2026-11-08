/**
 * Bitable schema for feishu-classmate.
 *
 * Field type numbers come from Feishu Bitable docs:
 *   1 Text, 2 Number, 3 SingleSelect, 4 MultiSelect, 5 DateTime,
 *   7 Checkbox, 11 User, 15 Url, 17 Attachment, 18 Link (to other table).
 *
 * Keep field names in Chinese to match the PDF spec; field names are what
 * tool callers pass as payload keys.
 */

export interface FieldDef {
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

export interface TableDef {
  key: string; // internal key to look up in tableIds config
  name: string;
  fields: FieldDef[];
}

const VISIBILITY_OPTIONS = [
  { name: '可公开', color: 0 },
  { name: '保密', color: 1 },
];

const PROJECT_STATUS_OPTIONS = [
  { name: '规划中', color: 0 },
  { name: '进行中', color: 2 },
  { name: '完成', color: 4 },
  { name: '搁置', color: 7 },
];

const GANTT_STATUS_OPTIONS = [
  { name: '未开始', color: 0 },
  { name: '进行中', color: 2 },
  { name: '完成', color: 4 },
  { name: '逾期', color: 1 },
];

const EQUIPMENT_STATE_OPTIONS = [
  { name: '在库', color: 4 },
  { name: '借出', color: 2 },
  { name: '维修', color: 0 },
  { name: '丢失', color: 1 },
];

const SUBMISSION_STATUS_OPTIONS = [
  { name: '准备中', color: 0 },
  { name: '已投', color: 2 },
  { name: '审稿中', color: 3 },
  { name: 'major revision', color: 7 },
  { name: 'minor revision', color: 5 },
  { name: '已接收', color: 4 },
  { name: '被拒', color: 1 },
  { name: '已撤回', color: 6 },
];

const PAPER_READ_STATUS_OPTIONS = [
  { name: '待读', color: 0 },
  { name: '在读', color: 2 },
  { name: '已读', color: 4 },
  { name: '引用', color: 5 },
];

const EXPERIMENT_STATUS_OPTIONS = [
  { name: '进行中', color: 2 },
  { name: '成功', color: 4 },
  { name: '失败', color: 1 },
  { name: '中断', color: 7 },
];

const RESERVATION_STATUS_OPTIONS = [
  { name: 'pending', color: 0 },
  { name: 'confirmed', color: 2 },
  { name: 'active', color: 3 },
  { name: 'completed', color: 4 },
  { name: 'cancelled', color: 1 },
];

const ASSIGNMENT_PRIORITY_OPTIONS = [
  { name: '低', color: 0 },
  { name: '中', color: 2 },
  { name: '高', color: 3 },
  { name: '紧急', color: 1 },
];

const ASSIGNMENT_STATUS_OPTIONS = [
  { name: '待接收', color: 0 },
  { name: '进行中', color: 2 },
  { name: '已完成', color: 4 },
  { name: '已取消', color: 7 },
  { name: '卡住', color: 1 },
];

const TRAINING_ALGORITHM_OPTIONS = [
  { name: 'PPO', color: 0 },
  { name: 'SAC', color: 2 },
  { name: 'GRPO', color: 3 },
  { name: 'DQN', color: 4 },
  { name: 'DDPG', color: 5 },
  { name: '其他', color: 7 },
];

const TRAINING_STATUS_OPTIONS = [
  { name: '训练中', color: 2 },
  { name: '完成', color: 4 },
  { name: '失败', color: 1 },
  { name: '中断', color: 7 },
];

const CHECKPOINT_DEPLOY_OPTIONS = [
  { name: '开发', color: 0 },
  { name: '测试', color: 2 },
  { name: '生产', color: 4 },
  { name: '已废弃', color: 1 },
];

const SIMULATOR_OPTIONS = [
  { name: 'MuJoCo', color: 0 },
  { name: 'IsaacGym', color: 2 },
  { name: 'PyBullet', color: 3 },
  { name: 'Gazebo', color: 4 },
  { name: 'RoboSuite', color: 5 },
  { name: '其他', color: 7 },
];

const SKILL_TAG_OPTIONS = [
  { name: 'MuJoCo', color: 0 },
  { name: 'IsaacGym', color: 1 },
  { name: 'PyBullet', color: 2 },
  { name: 'Gazebo', color: 3 },
  { name: 'ROS', color: 4 },
  { name: 'ROS2', color: 5 },
  { name: 'MoveIt', color: 6 },
  { name: 'PyTorch', color: 7 },
  { name: 'JAX', color: 0 },
  { name: 'TF2', color: 1 },
  { name: 'RL', color: 2 },
  { name: 'IL', color: 3 },
  { name: 'Diffusion-Policy', color: 4 },
  { name: 'Python', color: 5 },
  { name: 'C++', color: 6 },
  { name: 'CUDA', color: 7 },
  { name: 'Docker', color: 0 },
  { name: 'K8s', color: 1 },
  { name: 'Slurm', color: 2 },
  { name: 'URDF', color: 3 },
  { name: 'MJCF', color: 4 },
  { name: 'CAD', color: 5 },
  { name: 'Fusion360', color: 6 },
  { name: 'Solidworks', color: 7 },
  { name: 'SLAM', color: 0 },
  { name: 'RTABMap', color: 1 },
  { name: 'Cartographer', color: 2 },
  { name: 'ArUco', color: 3 },
  { name: 'AprilTag', color: 4 },
  { name: 'ORCA', color: 5 },
  { name: 'FCL', color: 6 },
  { name: 'OptiTrack', color: 7 },
  { name: 'Vicon', color: 0 },
  { name: 'Git', color: 1 },
  { name: 'Linux', color: 2 },
  { name: 'LaTeX', color: 3 },
  { name: 'HuggingFace', color: 4 },
  { name: 'OpenVLA', color: 5 },
  { name: 'RT-2', color: 6 },
  { name: 'Open3D', color: 7 },
  { name: 'PCL', color: 0 },
  { name: 'ROS-Perception', color: 1 },
];

const PROFICIENCY_OPTIONS = [
  { name: '入门', color: 0 },
  { name: '熟练', color: 2 },
  { name: '精通', color: 4 },
  { name: '可教', color: 5 },
];

const READING_GROUP_STATUS_OPTIONS = [
  { name: '未开始', color: 0 },
  { name: '已准备', color: 2 },
  { name: '进行中', color: 3 },
  { name: '已结束', color: 4 },
];

const FAILURE_CATEGORY_OPTIONS = [
  { name: '硬件', color: 0 },
  { name: '仿真', color: 2 },
  { name: '训练', color: 3 },
  { name: '调参', color: 4 },
  { name: '部署', color: 5 },
  { name: '数据', color: 6 },
  { name: '环境配置', color: 7 },
  { name: '其他', color: 1 },
];

const FAQ_CATEGORY_OPTIONS = [
  { name: '环境配置', color: 0 },
  { name: 'Python包', color: 2 },
  { name: 'Docker', color: 3 },
  { name: 'GPU驱动', color: 4 },
  { name: 'SSH连接', color: 5 },
  { name: 'VPN', color: 6 },
  { name: '飞书配置', color: 7 },
  { name: '硬件故障', color: 1 },
  { name: '其他', color: 0 },
];

const FAQ_DIFFICULTY_OPTIONS = [
  { name: '新手', color: 4 },
  { name: '中级', color: 2 },
  { name: '高级', color: 1 },
];

const MEME_TAG_OPTIONS = [
  { name: '口头禅', color: 0 },
  { name: '实验室事故', color: 1 },
  { name: '外来访客', color: 2 },
  { name: '深夜名言', color: 3 },
  { name: 'debug故事', color: 4 },
  { name: '食堂八卦', color: 5 },
  { name: '其他', color: 7 },
];

const MEME_STATUS_OPTIONS = [
  { name: '待审核', color: 0 },
  { name: '已发布', color: 4 },
  { name: '已撤回', color: 1 },
];

export const PROJECTS_TABLE: TableDef = {
  key: 'projects',
  name: 'Projects',
  fields: [
    { field_name: 'project_id', type: 1 }, // Text primary
    { field_name: 'title', type: 1 },
    { field_name: 'owner_open_id', type: 11 },
    {
      field_name: 'keywords',
      type: 4,
      property: { options: [] }, // populated at runtime as projects add keywords
    },
    {
      field_name: 'visibility',
      type: 3,
      property: { options: VISIBILITY_OPTIONS },
    },
    { field_name: 'abstract_doc_token', type: 15 }, // URL
    {
      field_name: 'status',
      type: 3,
      property: { options: PROJECT_STATUS_OPTIONS },
    },
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'updated_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

export const GANTT_TABLE: TableDef = {
  key: 'gantt',
  name: 'Gantt',
  fields: [
    { field_name: 'gantt_id', type: 1 },
    { field_name: 'project_id', type: 1 }, // not using Link to keep setup simple; FK by string
    { field_name: 'owner_open_id', type: 11 },
    { field_name: 'milestone', type: 1 },
    { field_name: 'due_date', type: 5, property: { date_formatter: 'yyyy-MM-dd' } },
    {
      field_name: 'progress',
      type: 2,
      property: { formatter: '0' },
    },
    {
      field_name: 'status',
      type: 3,
      property: { options: GANTT_STATUS_OPTIONS },
    },
    { field_name: 'notes', type: 1 },
  ],
};

export const EQUIPMENT_TABLE: TableDef = {
  key: 'equipment',
  name: 'Equipment',
  fields: [
    { field_name: 'equipment_id', type: 1 },
    { field_name: 'name', type: 1 },
    { field_name: 'location', type: 1 },
    {
      field_name: 'state',
      type: 3,
      property: { options: EQUIPMENT_STATE_OPTIONS },
    },
    { field_name: 'borrower_open_id', type: 11 },
    { field_name: 'borrow_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'expected_return', type: 5, property: { date_formatter: 'yyyy-MM-dd' } },
    { field_name: 'last_seen_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'notes', type: 1 },
  ],
};

export const RESEARCH_TABLE: TableDef = {
  key: 'research',
  name: 'Research',
  fields: [
    { field_name: 'report_id', type: 1 },
    { field_name: 'week', type: 1 }, // e.g. "2026-W16"
    { field_name: 'topic', type: 1 },
    { field_name: 'related_works', type: 1 }, // markdown blob
    { field_name: 'insights', type: 1 },
    { field_name: 'source_projects', type: 1 }, // comma-separated project_ids
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

export const WEEKLY_DIGESTS_TABLE: TableDef = {
  key: 'weekly_digests',
  name: 'WeeklyDigests',
  fields: [
    { field_name: 'digest_id', type: 1 },
    { field_name: 'week', type: 1 }, // e.g. "2026-W16"
    { field_name: 'doc_token', type: 15 }, // URL to generated doc
    { field_name: 'summary_md', type: 1 }, // markdown blob
    { field_name: 'completed_milestones', type: 2, property: { formatter: '0' } },
    { field_name: 'active_projects', type: 2, property: { formatter: '0' } },
    { field_name: 'published_papers', type: 2, property: { formatter: '0' } },
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

export const SUBMISSIONS_TABLE: TableDef = {
  key: 'submissions',
  name: 'Submissions',
  fields: [
    { field_name: 'submission_id', type: 1 },
    { field_name: 'paper_id', type: 1 }, // FK by string to Papers table
    { field_name: 'title', type: 1 },
    { field_name: 'venue', type: 1 },
    { field_name: 'author_open_ids', type: 11 }, // User multi
    {
      field_name: 'status',
      type: 3,
      property: { options: SUBMISSION_STATUS_OPTIONS },
    },
    { field_name: 'submitted_at', type: 5, property: { date_formatter: 'yyyy-MM-dd' } },
    { field_name: 'decision_due', type: 5, property: { date_formatter: 'yyyy-MM-dd' } },
    { field_name: 'decision_at', type: 5, property: { date_formatter: 'yyyy-MM-dd' } },
    { field_name: 'notes', type: 1 },
  ],
};

/**
 * Standups — daily standup aggregation.
 *
 * One row per (student, date). Written by the `daily-standup` skill after
 * 09:30 cron-driven broadcast + student replies. Also used for weekly digests
 * to recap progress velocity.
 */
export const STANDUPS_TABLE: TableDef = {
  key: 'standups',
  name: 'Standups',
  fields: [
    { field_name: 'standup_id', type: 1 }, // Text primary, e.g. "su_<ts>_<rand>"
    { field_name: 'date', type: 1 }, // "YYYY-MM-DD" for easy filter/group
    { field_name: 'student_open_id', type: 11 }, // User, [{id:"ou_xxx"}]
    { field_name: 'yesterday', type: 1 }, // yesterday progress summary
    { field_name: 'today', type: 1 }, // today plan
    { field_name: 'blockers', type: 1 }, // blockers, may be empty
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * ToolTrace — Phase 1 of 自我进化 (self-evolution).
 *
 * Every `feishu_classmate_*` tool call is logged here from the `after_tool_call`
 * hook in index.ts. This is the ground-truth telemetry Phase 2 auto-evolve
 * will consume (weekly stats, failing tools, success rate per skill).
 *
 * Writes are best-effort / fire-and-forget; hook in index.ts swallows errors.
 */
export const TOOL_TRACE_TABLE: TableDef = {
  key: 'tool_trace',
  name: 'ToolTrace',
  fields: [
    { field_name: 'trace_id', type: 1 }, // Text primary
    { field_name: 'tool_name', type: 1 },
    { field_name: 'session_key', type: 1 },
    { field_name: 'caller_open_id', type: 11 }, // User
    { field_name: 'params_json', type: 1 }, // JSON-stringified params, may be long
    { field_name: 'ok', type: 7 }, // Checkbox
    { field_name: 'error', type: 1 },
    { field_name: 'duration_ms', type: 2, property: { formatter: '0' } },
    { field_name: 'started_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * Papers — curated library of papers read / referenced by the lab.
 *
 * Written by the `manage-papers` skill when a student pastes an arXiv ID / DOI
 * or manually adds a paper. arXiv metadata is pulled via
 * `feishu_classmate_research_search_works`. One row per paper; dedup by
 * `arxiv_id` or `doi`.
 */
export const PAPERS_TABLE: TableDef = {
  key: 'papers',
  name: 'Papers',
  fields: [
    { field_name: 'paper_id', type: 1 }, // Text primary, e.g. "paper_<ts>_<rand>"
    { field_name: 'title', type: 1 },
    { field_name: 'authors', type: 1 }, // comma-separated
    { field_name: 'venue', type: 1 }, // "arXiv" / "NeurIPS 2025" / etc.
    { field_name: 'year', type: 2, property: { formatter: '0' } },
    { field_name: 'doi', type: 15 }, // Url, {link, text}
    { field_name: 'arxiv_id', type: 1 },
    { field_name: 'abstract', type: 1 },
    {
      field_name: 'keywords',
      type: 4,
      property: { options: [] }, // MultiSelect, populated at runtime
    },
    {
      field_name: 'read_status',
      type: 3,
      property: { options: PAPER_READ_STATUS_OPTIONS },
    },
    { field_name: 'notes', type: 1 },
    { field_name: 'shared_by_open_id', type: 11 }, // User
    { field_name: 'added_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * Experiments — structured metadata for each lab experiment.
 *
 * Written by the `log-experiment` skill. Detailed write-up lives in a separate
 * Feishu Doc; `doc_url` here points at it. Metrics stored as JSON string so the
 * schema doesn't have to evolve per-experiment.
 */
export const EXPERIMENTS_TABLE: TableDef = {
  key: 'experiments',
  name: 'Experiments',
  fields: [
    { field_name: 'exp_id', type: 1 }, // Text primary, e.g. "exp_<ts>_<rand>"
    { field_name: 'project_id', type: 1 }, // FK by string to Projects.project_id
    { field_name: 'student_open_id', type: 11 }, // User
    { field_name: 'title', type: 1 },
    { field_name: 'hypothesis', type: 1 },
    { field_name: 'setup_md', type: 1 }, // long markdown blob (fallback if doc fails)
    { field_name: 'metrics_json', type: 1 }, // JSON string, flat k/v
    { field_name: 'result_summary', type: 1 },
    {
      field_name: 'status',
      type: 3,
      property: { options: EXPERIMENT_STATUS_OPTIONS },
    },
    { field_name: 'doc_url', type: 15 }, // Url, link to detailed Doc
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'completed_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * Reservations — time-slot bookings for shared equipment (GPU / 3D printer /
 * microscope / etc.).
 *
 * Written by the `reserve-equipment` skill. Conflict detection is done by the
 * skill against this same table before write. `status` uses lowercase English
 * enum to stay distinct from Equipment.state's Chinese enum.
 */
export const RESERVATIONS_TABLE: TableDef = {
  key: 'reservations',
  name: 'Reservations',
  fields: [
    { field_name: 'reservation_id', type: 1 }, // Text primary, e.g. "res_<ts>_<rand>"
    { field_name: 'equipment_id', type: 1 }, // FK by string to Equipment.equipment_id
    { field_name: 'requester_open_id', type: 11 }, // User
    { field_name: 'start_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'end_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'purpose', type: 1 },
    {
      field_name: 'status',
      type: 3,
      property: { options: RESERVATION_STATUS_OPTIONS },
    },
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * Assignments — supervisor-assigned tasks for students.
 *
 * Written by the `supervisor-task-assign` skill when a supervisor issues a
 * task via natural language ("给 <同学> 派任务"). State transitions as the
 * student replies (accept / blocked / done / cancel).
 */
export const ASSIGNMENTS_TABLE: TableDef = {
  key: 'assignments',
  name: 'Assignments',
  fields: [
    { field_name: 'assign_id', type: 1 }, // Text primary, "assign_<ts>_<rand>"
    { field_name: 'assigner_open_id', type: 11 }, // User, supervisor
    { field_name: 'assignee_open_id', type: 11 }, // User, student
    { field_name: 'title', type: 1 }, // ≤ 40 chars
    { field_name: 'description', type: 1 }, // long text
    { field_name: 'parent_project_id', type: 1 }, // FK by string to Projects.project_id
    {
      field_name: 'priority',
      type: 3,
      property: { options: ASSIGNMENT_PRIORITY_OPTIONS },
    },
    { field_name: 'due_date', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    {
      field_name: 'status',
      type: 3,
      property: { options: ASSIGNMENT_STATUS_OPTIONS },
    },
    { field_name: 'assigned_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'completed_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * TrainingRuns — individual RL/ML training runs with hyperparams + tracker URLs.
 *
 * Written by the `training-run-tracker` skill. Each row is one run; indexed by
 * `run_id`. `hyperparams_json` is a JSON string, truncated to ~20KB if oversized.
 */
export const TRAINING_RUNS_TABLE: TableDef = {
  key: 'training_runs',
  name: 'TrainingRuns',
  fields: [
    { field_name: 'run_id', type: 1 }, // Text primary, "run_<ts>_<rand>"
    { field_name: 'project_id', type: 1 }, // FK by string to Projects.project_id
    { field_name: 'student_open_id', type: 11 }, // User
    {
      field_name: 'algorithm',
      type: 3,
      property: { options: TRAINING_ALGORITHM_OPTIONS },
    },
    { field_name: 'env_name', type: 1 }, // e.g. "HalfCheetah-v4"
    { field_name: 'commit_hash', type: 1 }, // short 7~12 char hash
    { field_name: 'seed', type: 2, property: { formatter: '0' } },
    { field_name: 'hyperparams_json', type: 1 }, // long text JSON
    { field_name: 'wandb_url', type: 15 }, // Url
    { field_name: 'tb_url', type: 15 }, // Url, TensorBoard
    { field_name: 'final_reward', type: 2, property: { formatter: '0.00' } },
    { field_name: 'best_reward', type: 2, property: { formatter: '0.00' } },
    {
      field_name: 'status',
      type: 3,
      property: { options: TRAINING_STATUS_OPTIONS },
    },
    { field_name: 'started_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'completed_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'gpu_hours', type: 2, property: { formatter: '0.0' } },
  ],
};

/**
 * Checkpoints — archived model weights with eval metrics + deploy state.
 *
 * Written by the `robot-checkpoint` skill. `success_rate` stored as 0~1 float,
 * formatted as percentage. `evaluated_on_real` required before promoting to 生产.
 */
export const CHECKPOINTS_TABLE: TableDef = {
  key: 'checkpoints',
  name: 'Checkpoints',
  fields: [
    { field_name: 'ckpt_id', type: 1 }, // Text primary, "ckpt_<ts>_<rand>"
    { field_name: 'run_id', type: 1 }, // FK by string to TrainingRuns.run_id
    { field_name: 'tag', type: 1 }, // e.g. "v1.2.3-best"
    { field_name: 'artifact_url', type: 15 }, // Url, S3/OSS
    { field_name: 'eval_env', type: 1 },
    { field_name: 'success_rate', type: 2, property: { formatter: '0.00%' } },
    { field_name: 'avg_reward', type: 2, property: { formatter: '0.00' } },
    { field_name: 'evaluated_on_real', type: 7 }, // Checkbox
    {
      field_name: 'deploy_status',
      type: 3,
      property: { options: CHECKPOINT_DEPLOY_OPTIONS },
    },
    { field_name: 'notes', type: 1 },
    { field_name: 'saved_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * SimRuns — simulation evaluation records with sim-to-real gap tracking.
 *
 * Written by the `simulation-log` skill. `sim_real_gap_percentage` is computed
 * locally by the agent (not a bitable formula), stored as raw percent (e.g. 22.8).
 */
export const SIM_RUNS_TABLE: TableDef = {
  key: 'sim_runs',
  name: 'SimRuns',
  fields: [
    { field_name: 'sim_id', type: 1 }, // Text primary, "sim_<ts>_<rand>"
    { field_name: 'ckpt_id', type: 1 }, // FK by string to Checkpoints.ckpt_id
    {
      field_name: 'simulator',
      type: 3,
      property: { options: SIMULATOR_OPTIONS },
    },
    { field_name: 'domain_rand_json', type: 1 }, // long text JSON
    { field_name: 'physics_params_json', type: 1 }, // long text JSON
    { field_name: 'sim_success_rate', type: 2, property: { formatter: '0.00%' } },
    { field_name: 'real_success_rate', type: 2, property: { formatter: '0.00%' } },
    { field_name: 'sim_real_gap_percentage', type: 2, property: { formatter: '0.0' } },
    { field_name: 'reproduce_command', type: 1 }, // required — core value prop
    { field_name: 'findings', type: 1 },
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * SkillTree — per-member tagged skill inventory (ROS / PyTorch / MuJoCo / ...).
 *
 * Written by the `skill-tree` skill. `skill_tag` is a MultiSelect constrained
 * to a ~50-tag preset list; LLM normalizes user input to preset values.
 * Feeds `mentor-dispatch` skill as the matcher source of truth.
 */
export const SKILL_TREE_TABLE: TableDef = {
  key: 'skill_tree',
  name: 'SkillTree',
  fields: [
    { field_name: 'entry_id', type: 1 }, // Text primary, "st_<ts>_<rand>"
    { field_name: 'student_open_id', type: 11 }, // User
    {
      field_name: 'skill_tag',
      type: 4,
      property: { options: SKILL_TAG_OPTIONS },
    },
    {
      field_name: 'proficiency',
      type: 3,
      property: { options: PROFICIENCY_OPTIONS },
    },
    { field_name: 'self_reported', type: 7 }, // Checkbox
    { field_name: 'verified_by_open_id', type: 11 }, // User, validator
    { field_name: 'example_project_id', type: 1 }, // FK by string to Projects
    { field_name: 'last_used_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'notes', type: 1 },
  ],
};

/**
 * ReadingGroup — weekly reading group rotation + session archive.
 *
 * Written by the `reading-group` skill. Rotation is computed locally: choose
 * the member with oldest-or-never `presenter_open_id` by `date` desc.
 */
export const READING_GROUP_TABLE: TableDef = {
  key: 'reading_group',
  name: 'ReadingGroup',
  fields: [
    { field_name: 'session_id', type: 1 }, // Text primary, "rg_<ts>_<rand>"
    { field_name: 'date', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'presenter_open_id', type: 11 }, // User
    { field_name: 'paper_id', type: 1 }, // FK by string to Papers.paper_id
    { field_name: 'paper_title', type: 1 },
    { field_name: 'paper_url', type: 15 }, // Url
    { field_name: 'discussion_points_md', type: 1 }, // pre-generated 3-5 Qs
    { field_name: 'actual_discussion_md', type: 1 }, // post-meeting notes
    { field_name: 'rating_avg', type: 2, property: { formatter: '0.0' } },
    { field_name: 'attendees', type: 11 }, // User multi
    {
      field_name: 'status',
      type: 3,
      property: { options: READING_GROUP_STATUS_OPTIONS },
    },
  ],
};

/**
 * OneOnOnes — supervisor ↔ student 1:1 meetings, including auto-generated agenda.
 *
 * Written by the `one-on-one-scheduler` skill. `doc_token` is the Feishu Doc URL
 * holding the full agenda; populated ~24h before the scheduled time.
 */
export const ONE_ON_ONES_TABLE: TableDef = {
  key: 'one_on_ones',
  name: 'OneOnOnes',
  fields: [
    { field_name: 'meeting_id', type: 1 }, // Text primary, "1on1_<ts>_<rand>"
    { field_name: 'supervisor_open_id', type: 11 }, // User
    { field_name: 'student_open_id', type: 11 }, // User
    { field_name: 'scheduled_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'doc_token', type: 15 }, // Url, agenda doc
    { field_name: 'attended', type: 7 }, // Checkbox
    { field_name: 'summary_md', type: 1 }, // long markdown
    { field_name: 'action_items_json', type: 1 }, // JSON string: [{owner,task,due}]
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * FailureArchive — post-mortem of failed experiments so future students don't
 * repeat the same mistakes ("失败博物馆").
 *
 * Written by the `failure-archive` skill. `tldr` (auto-generated ≤60 char
 * summary) is used for search-hit ranking. Long-form content may also live
 * in a separate Feishu Doc referenced via `doc_url`.
 */
export const FAILURE_ARCHIVE_TABLE: TableDef = {
  key: 'failure_archive',
  name: 'FailureArchive',
  fields: [
    { field_name: 'failure_id', type: 1 }, // Text primary, "fail_<ts>_<rand>"
    { field_name: 'reporter_open_id', type: 11 }, // User
    { field_name: 'title', type: 1 },
    {
      field_name: 'category',
      type: 3,
      property: { options: FAILURE_CATEGORY_OPTIONS },
    },
    { field_name: 'context_md', type: 1 }, // long
    { field_name: 'failure_description_md', type: 1 }, // long
    { field_name: 'root_cause_md', type: 1 }, // long
    { field_name: 'workaround_or_lesson_md', type: 1 }, // long
    { field_name: 'tldr', type: 1 }, // ≤60 char auto summary
    { field_name: 'related_project_id', type: 1 }, // FK by string to Projects
    {
      field_name: 'tags',
      type: 4,
      property: { options: [] }, // MultiSelect, populated at runtime
    },
    { field_name: 'related_paper_urls', type: 1 }, // comma-separated URLs
    { field_name: 'hours_wasted', type: 2, property: { formatter: '0' } },
    { field_name: 'doc_url', type: 15 }, // Url, optional long-form doc
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * LabFAQ — curated FAQ for common new-student questions (docker / cuda / vpn /
 * feishu config / etc.).
 *
 * Written by the `lab-faq-search` skill. `helpful_count` incremented on each hit;
 * `last_verified_at` periodically refreshed by admin to keep entries current.
 */
export const LAB_FAQ_TABLE: TableDef = {
  key: 'lab_faq',
  name: 'LabFAQ',
  fields: [
    { field_name: 'faq_id', type: 1 }, // Text primary, "faq_<ts>_<rand>"
    { field_name: 'question', type: 1 },
    { field_name: 'answer_md', type: 1 }, // long markdown
    {
      field_name: 'category',
      type: 3,
      property: { options: FAQ_CATEGORY_OPTIONS },
    },
    {
      field_name: 'difficulty',
      type: 3,
      property: { options: FAQ_DIFFICULTY_OPTIONS },
    },
    {
      field_name: 'tags',
      type: 4,
      property: { options: [] }, // MultiSelect, populated at runtime
    },
    { field_name: 'related_doc_urls', type: 1 }, // comma-separated wiki/doc URLs
    { field_name: 'helpful_count', type: 2, property: { formatter: '0' } },
    { field_name: 'last_verified_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'added_by_open_id', type: 11 }, // User
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/**
 * MentorAnswers — senior-student answers to juniors' questions, archived for
 * FAQ retrieval and institutional memory.
 *
 * Written by the `mentor-dispatch` skill. Doubles as a corpus source for
 * `lab-faq-search`. `tags` uses the same preset as `SkillTree.skill_tag`.
 */
export const MENTOR_ANSWERS_TABLE: TableDef = {
  key: 'mentor_answers',
  name: 'MentorAnswers',
  fields: [
    { field_name: 'answer_id', type: 1 }, // Text primary, "ma_<ts>_<rand>"
    { field_name: 'question_text', type: 1 },
    { field_name: 'asker_open_id', type: 11 }, // User
    { field_name: 'answerer_open_id', type: 11 }, // User
    { field_name: 'question_chat_id', type: 1 }, // chat_id for jump-back
    { field_name: 'answer_md', type: 1 }, // markdown
    {
      field_name: 'tags',
      type: 4,
      property: { options: SKILL_TAG_OPTIONS }, // same preset as SkillTree
    },
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'helpful', type: 7 }, // Checkbox — asker confirmed
  ],
};

/**
 * LabMemes — lab culture archive: memes / catchphrases / incidents.
 *
 * Written by the `lab-meme` skill. Tagging actual members requires their
 * consent (enforced by skill, not schema). `laugh_count` is periodically
 * refreshed by admin from group reactions.
 */
export const LAB_MEMES_TABLE: TableDef = {
  key: 'lab_memes',
  name: 'LabMemes',
  fields: [
    { field_name: 'meme_id', type: 1 }, // Text primary, "meme_<ts>_<rand>"
    { field_name: 'content_text', type: 1 },
    { field_name: 'image_attachments', type: 17 }, // Attachment
    { field_name: 'people_involved', type: 11 }, // User multi
    {
      field_name: 'tags',
      type: 4,
      property: { options: MEME_TAG_OPTIONS },
    },
    {
      field_name: 'status',
      type: 3,
      property: { options: MEME_STATUS_OPTIONS },
    },
    { field_name: 'origin_date', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'added_by_open_id', type: 11 }, // User
    { field_name: 'laugh_count', type: 2, property: { formatter: '0' } },
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

/** Task decomposition used by supervise-student skill — PDF requires it for 自我监督 */
export const TASK_DECOMPOSITION_TABLE: TableDef = {
  key: 'task_decomposition',
  name: 'TaskDecomposition',
  fields: [
    { field_name: 'task_id', type: 1 },
    { field_name: 'supervision_session_id', type: 1 },
    { field_name: 'student_open_id', type: 11 },
    { field_name: 'parent_goal', type: 1 },
    { field_name: 'subtasks_json', type: 1 }, // long text — JSON array of {name, duration_min, status, notes}
    { field_name: 'total_estimated_min', type: 2, property: { formatter: '0' } },
    { field_name: 'created_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
    { field_name: 'updated_at', type: 5, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  ],
};

export const ALL_TABLES: TableDef[] = [
  PROJECTS_TABLE,
  GANTT_TABLE,
  EQUIPMENT_TABLE,
  RESEARCH_TABLE,
  WEEKLY_DIGESTS_TABLE,
  SUBMISSIONS_TABLE,
  STANDUPS_TABLE,
  TOOL_TRACE_TABLE,
  PAPERS_TABLE,
  EXPERIMENTS_TABLE,
  RESERVATIONS_TABLE,
  ASSIGNMENTS_TABLE,
  TRAINING_RUNS_TABLE,
  CHECKPOINTS_TABLE,
  SIM_RUNS_TABLE,
  SKILL_TREE_TABLE,
  READING_GROUP_TABLE,
  ONE_ON_ONES_TABLE,
  FAILURE_ARCHIVE_TABLE,
  LAB_FAQ_TABLE,
  MENTOR_ANSWERS_TABLE,
  LAB_MEMES_TABLE,
  TASK_DECOMPOSITION_TABLE,
];
