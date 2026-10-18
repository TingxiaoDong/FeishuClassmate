-- ClassmateOS core schema — generated from src/bitable/schema.ts
-- DO NOT EDIT BY HAND; regenerate with: node scripts/schema-to-sql.mjs
-- Tables: 23

BEGIN;

CREATE TABLE IF NOT EXISTS "projects" (
  record_id text PRIMARY KEY,
  "project_id" text,
  "title" text,
  "owner_open_id" jsonb,
  "keywords" text[],
  "visibility" text CHECK ("visibility" IS NULL OR "visibility" IN ('可公开', '保密')),
  "abstract_doc_token" text,
  "status" text CHECK ("status" IS NULL OR "status" IN ('规划中', '进行中', '完成', '搁置')),
  "created_at" timestamptz,
  "updated_at" timestamptz
);
COMMENT ON TABLE "projects" IS 'Projects';

CREATE TABLE IF NOT EXISTS "gantt" (
  record_id text PRIMARY KEY,
  "gantt_id" text,
  "project_id" text,
  "owner_open_id" jsonb,
  "milestone" text,
  "due_date" timestamptz,
  "progress" double precision,
  "status" text CHECK ("status" IS NULL OR "status" IN ('未开始', '进行中', '完成', '逾期')),
  "notes" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "gantt" IS 'Gantt';

CREATE TABLE IF NOT EXISTS "equipment" (
  record_id text PRIMARY KEY,
  "equipment_id" text,
  "name" text,
  "location" text,
  "state" text CHECK ("state" IS NULL OR "state" IN ('在库', '借出', '维修', '丢失')),
  "borrower_open_id" jsonb,
  "borrow_at" timestamptz,
  "expected_return" timestamptz,
  "last_seen_at" timestamptz,
  "notes" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "equipment" IS 'Equipment';

CREATE TABLE IF NOT EXISTS "research" (
  record_id text PRIMARY KEY,
  "report_id" text,
  "week" text,
  "topic" text,
  "related_works" text,
  "insights" text,
  "source_projects" text,
  "created_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "research" IS 'Research';

CREATE TABLE IF NOT EXISTS "weekly_digests" (
  record_id text PRIMARY KEY,
  "digest_id" text,
  "week" text,
  "doc_token" text,
  "summary_md" text,
  "completed_milestones" double precision,
  "active_projects" double precision,
  "published_papers" double precision,
  "created_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "weekly_digests" IS 'WeeklyDigests';

CREATE TABLE IF NOT EXISTS "submissions" (
  record_id text PRIMARY KEY,
  "submission_id" text,
  "paper_id" text,
  "title" text,
  "venue" text,
  "author_open_ids" jsonb,
  "status" text CHECK ("status" IS NULL OR "status" IN ('准备中', '已投', '审稿中', 'major revision', 'minor revision', '已接收', '被拒', '已撤回')),
  "submitted_at" timestamptz,
  "decision_due" timestamptz,
  "decision_at" timestamptz,
  "notes" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "submissions" IS 'Submissions';

CREATE TABLE IF NOT EXISTS "standups" (
  record_id text PRIMARY KEY,
  "standup_id" text,
  "date" text,
  "student_open_id" jsonb,
  "yesterday" text,
  "today" text,
  "blockers" text,
  "created_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "standups" IS 'Standups';

CREATE TABLE IF NOT EXISTS "tool_trace" (
  record_id text PRIMARY KEY,
  "trace_id" text,
  "tool_name" text,
  "session_key" text,
  "caller_open_id" jsonb,
  "params_json" text,
  "ok" boolean,
  "error" text,
  "duration_ms" double precision,
  "started_at" timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "tool_trace" IS 'ToolTrace';

CREATE TABLE IF NOT EXISTS "papers" (
  record_id text PRIMARY KEY,
  "paper_id" text,
  "title" text,
  "authors" text,
  "venue" text,
  "year" double precision,
  "doi" text,
  "arxiv_id" text,
  "abstract" text,
  "keywords" text[],
  "read_status" text CHECK ("read_status" IS NULL OR "read_status" IN ('待读', '在读', '已读', '引用')),
  "notes" text,
  "shared_by_open_id" jsonb,
  "added_at" timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "papers" IS 'Papers';

CREATE TABLE IF NOT EXISTS "experiments" (
  record_id text PRIMARY KEY,
  "exp_id" text,
  "project_id" text,
  "student_open_id" jsonb,
  "title" text,
  "hypothesis" text,
  "setup_md" text,
  "metrics_json" text,
  "result_summary" text,
  "status" text CHECK ("status" IS NULL OR "status" IN ('进行中', '成功', '失败', '中断')),
  "doc_url" text,
  "created_at" timestamptz,
  "completed_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "experiments" IS 'Experiments';

CREATE TABLE IF NOT EXISTS "reservations" (
  record_id text PRIMARY KEY,
  "reservation_id" text,
  "equipment_id" text,
  "requester_open_id" jsonb,
  "start_at" timestamptz,
  "end_at" timestamptz,
  "purpose" text,
  "status" text CHECK ("status" IS NULL OR "status" IN ('pending', 'confirmed', 'active', 'completed', 'cancelled')),
  "created_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "reservations" IS 'Reservations';

CREATE TABLE IF NOT EXISTS "assignments" (
  record_id text PRIMARY KEY,
  "assign_id" text,
  "assigner_open_id" jsonb,
  "assignee_open_id" jsonb,
  "title" text,
  "description" text,
  "parent_project_id" text,
  "priority" text CHECK ("priority" IS NULL OR "priority" IN ('低', '中', '高', '紧急')),
  "due_date" timestamptz,
  "status" text CHECK ("status" IS NULL OR "status" IN ('待接收', '进行中', '已完成', '已取消', '卡住')),
  "assigned_at" timestamptz,
  "completed_at" timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "assignments" IS 'Assignments';

CREATE TABLE IF NOT EXISTS "training_runs" (
  record_id text PRIMARY KEY,
  "run_id" text,
  "project_id" text,
  "student_open_id" jsonb,
  "algorithm" text CHECK ("algorithm" IS NULL OR "algorithm" IN ('PPO', 'SAC', 'GRPO', 'DQN', 'DDPG', '其他')),
  "env_name" text,
  "commit_hash" text,
  "seed" double precision,
  "hyperparams_json" text,
  "wandb_url" text,
  "tb_url" text,
  "final_reward" double precision,
  "best_reward" double precision,
  "status" text CHECK ("status" IS NULL OR "status" IN ('训练中', '完成', '失败', '中断')),
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "gpu_hours" double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "training_runs" IS 'TrainingRuns';

CREATE TABLE IF NOT EXISTS "checkpoints" (
  record_id text PRIMARY KEY,
  "ckpt_id" text,
  "run_id" text,
  "tag" text,
  "artifact_url" text,
  "eval_env" text,
  "success_rate" double precision,
  "avg_reward" double precision,
  "evaluated_on_real" boolean,
  "deploy_status" text CHECK ("deploy_status" IS NULL OR "deploy_status" IN ('开发', '测试', '生产', '已废弃')),
  "notes" text,
  "saved_at" timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "checkpoints" IS 'Checkpoints';

CREATE TABLE IF NOT EXISTS "sim_runs" (
  record_id text PRIMARY KEY,
  "sim_id" text,
  "ckpt_id" text,
  "simulator" text CHECK ("simulator" IS NULL OR "simulator" IN ('MuJoCo', 'IsaacGym', 'PyBullet', 'Gazebo', 'RoboSuite', '其他')),
  "domain_rand_json" text,
  "physics_params_json" text,
  "sim_success_rate" double precision,
  "real_success_rate" double precision,
  "sim_real_gap_percentage" double precision,
  "reproduce_command" text,
  "findings" text,
  "created_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "sim_runs" IS 'SimRuns';

CREATE TABLE IF NOT EXISTS "skill_tree" (
  record_id text PRIMARY KEY,
  "entry_id" text,
  "student_open_id" jsonb,
  "skill_tag" text[] CHECK ("skill_tag" IS NULL OR "skill_tag" <@ ARRAY['MuJoCo', 'IsaacGym', 'PyBullet', 'Gazebo', 'ROS', 'ROS2', 'MoveIt', 'PyTorch', 'JAX', 'TF2', 'RL', 'IL', 'Diffusion-Policy', 'Python', 'C++', 'CUDA', 'Docker', 'K8s', 'Slurm', 'URDF', 'MJCF', 'CAD', 'Fusion360', 'Solidworks', 'SLAM', 'RTABMap', 'Cartographer', 'ArUco', 'AprilTag', 'ORCA', 'FCL', 'OptiTrack', 'Vicon', 'Git', 'Linux', 'LaTeX', 'HuggingFace', 'OpenVLA', 'RT-2', 'Open3D', 'PCL', 'ROS-Perception']::text[]),
  "proficiency" text CHECK ("proficiency" IS NULL OR "proficiency" IN ('入门', '熟练', '精通', '可教')),
  "self_reported" boolean,
  "verified_by_open_id" jsonb,
  "example_project_id" text,
  "last_used_at" timestamptz,
  "notes" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "skill_tree" IS 'SkillTree';

CREATE TABLE IF NOT EXISTS "reading_group" (
  record_id text PRIMARY KEY,
  "session_id" text,
  "date" timestamptz,
  "presenter_open_id" jsonb,
  "paper_id" text,
  "paper_title" text,
  "paper_url" text,
  "discussion_points_md" text,
  "actual_discussion_md" text,
  "rating_avg" double precision,
  "attendees" jsonb,
  "status" text CHECK ("status" IS NULL OR "status" IN ('未开始', '已准备', '进行中', '已结束')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "reading_group" IS 'ReadingGroup';

CREATE TABLE IF NOT EXISTS "one_on_ones" (
  record_id text PRIMARY KEY,
  "meeting_id" text,
  "supervisor_open_id" jsonb,
  "student_open_id" jsonb,
  "scheduled_at" timestamptz,
  "doc_token" text,
  "attended" boolean,
  "summary_md" text,
  "action_items_json" text,
  "created_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "one_on_ones" IS 'OneOnOnes';

CREATE TABLE IF NOT EXISTS "failure_archive" (
  record_id text PRIMARY KEY,
  "failure_id" text,
  "reporter_open_id" jsonb,
  "title" text,
  "category" text CHECK ("category" IS NULL OR "category" IN ('硬件', '仿真', '训练', '调参', '部署', '数据', '环境配置', '其他')),
  "context_md" text,
  "failure_description_md" text,
  "root_cause_md" text,
  "workaround_or_lesson_md" text,
  "tldr" text,
  "related_project_id" text,
  "tags" text[],
  "related_paper_urls" text,
  "hours_wasted" double precision,
  "doc_url" text,
  "created_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "failure_archive" IS 'FailureArchive';

CREATE TABLE IF NOT EXISTS "lab_faq" (
  record_id text PRIMARY KEY,
  "faq_id" text,
  "question" text,
  "answer_md" text,
  "category" text CHECK ("category" IS NULL OR "category" IN ('环境配置', 'Python包', 'Docker', 'GPU驱动', 'SSH连接', 'VPN', '飞书配置', '硬件故障', '其他')),
  "difficulty" text CHECK ("difficulty" IS NULL OR "difficulty" IN ('新手', '中级', '高级')),
  "tags" text[],
  "related_doc_urls" text,
  "helpful_count" double precision,
  "last_verified_at" timestamptz,
  "added_by_open_id" jsonb,
  "created_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "lab_faq" IS 'LabFAQ';

CREATE TABLE IF NOT EXISTS "mentor_answers" (
  record_id text PRIMARY KEY,
  "answer_id" text,
  "question_text" text,
  "asker_open_id" jsonb,
  "answerer_open_id" jsonb,
  "question_chat_id" text,
  "answer_md" text,
  "tags" text[] CHECK ("tags" IS NULL OR "tags" <@ ARRAY['MuJoCo', 'IsaacGym', 'PyBullet', 'Gazebo', 'ROS', 'ROS2', 'MoveIt', 'PyTorch', 'JAX', 'TF2', 'RL', 'IL', 'Diffusion-Policy', 'Python', 'C++', 'CUDA', 'Docker', 'K8s', 'Slurm', 'URDF', 'MJCF', 'CAD', 'Fusion360', 'Solidworks', 'SLAM', 'RTABMap', 'Cartographer', 'ArUco', 'AprilTag', 'ORCA', 'FCL', 'OptiTrack', 'Vicon', 'Git', 'Linux', 'LaTeX', 'HuggingFace', 'OpenVLA', 'RT-2', 'Open3D', 'PCL', 'ROS-Perception']::text[]),
  "created_at" timestamptz,
  "helpful" boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "mentor_answers" IS 'MentorAnswers';

CREATE TABLE IF NOT EXISTS "lab_memes" (
  record_id text PRIMARY KEY,
  "meme_id" text,
  "content_text" text,
  "image_attachments" jsonb,
  "people_involved" jsonb,
  "tags" text[] CHECK ("tags" IS NULL OR "tags" <@ ARRAY['口头禅', '实验室事故', '外来访客', '深夜名言', 'debug故事', '食堂八卦', '其他']::text[]),
  "status" text CHECK ("status" IS NULL OR "status" IN ('待审核', '已发布', '已撤回')),
  "origin_date" timestamptz,
  "added_by_open_id" jsonb,
  "laugh_count" double precision,
  "created_at" timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "lab_memes" IS 'LabMemes';

CREATE TABLE IF NOT EXISTS "task_decomposition" (
  record_id text PRIMARY KEY,
  "task_id" text,
  "supervision_session_id" text,
  "student_open_id" jsonb,
  "parent_goal" text,
  "subtasks_json" text,
  "total_estimated_min" double precision,
  "created_at" timestamptz,
  "updated_at" timestamptz
);
COMMENT ON TABLE "task_decomposition" IS 'TaskDecomposition';

COMMIT;
