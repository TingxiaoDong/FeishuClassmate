-- ClassmateOS 平台表（账号 / IM / 文件 / 日历 / 任务 / 文档 / 设备 / 自定义数据表定义）
-- 多维表格的 23 张业务表在 schema.sql（由 scripts/schema-to-sql.mjs 生成）。
-- 全部 IF NOT EXISTS，可重复执行；服务启动时自动执行（CLASSMATE_OS_AUTO_MIGRATE=0 可关闭）。

BEGIN;

CREATE TABLE IF NOT EXISTS cos_users (
  user_id       text PRIMARY KEY,
  name          text NOT NULL,
  email         text,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'bot')),
  avatar_url    text,
  department    text,
  title         text,
  phone         text,
  status_text   text,
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cos_users_name_idx ON cos_users (name);

CREATE TABLE IF NOT EXISTS cos_refresh_tokens (
  jti        text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES cos_users (user_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cos_refresh_tokens_user_idx ON cos_refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS cos_chats (
  chat_id     text PRIMARY KEY,
  chat_type   text NOT NULL CHECK (chat_type IN ('p2p', 'group')),
  name        text,
  description text,
  owner_id    text,
  kind        text NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'drive')),
  p2p_key     text UNIQUE,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cos_chats_updated_idx ON cos_chats (updated_at DESC);

CREATE TABLE IF NOT EXISTS cos_chat_members (
  chat_id              text NOT NULL REFERENCES cos_chats (chat_id) ON DELETE CASCADE,
  user_id              text NOT NULL,
  joined_at            timestamptz NOT NULL,
  last_read_seq        bigint NOT NULL DEFAULT 0,
  last_read_message_id text,
  pinned               boolean NOT NULL DEFAULT false,
  muted                boolean NOT NULL DEFAULT false,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS cos_chat_members_user_idx ON cos_chat_members (user_id);

CREATE TABLE IF NOT EXISTS cos_messages (
  seq                 bigserial UNIQUE,
  message_id          text PRIMARY KEY,
  chat_id             text NOT NULL REFERENCES cos_chats (chat_id) ON DELETE CASCADE,
  sender_id           text NOT NULL,
  msg_type            text NOT NULL,
  content             jsonb NOT NULL,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz,
  recalled            boolean NOT NULL DEFAULT false,
  reply_to_message_id text,
  client_msg_id       text,
  card_id             text
);
CREATE INDEX IF NOT EXISTS cos_messages_chat_seq_idx ON cos_messages (chat_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS cos_messages_client_msg_idx
  ON cos_messages (chat_id, sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cos_messages_card_idx ON cos_messages (card_id) WHERE card_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cos_files (
  file_key       text PRIMARY KEY,
  file_name      text NOT NULL,
  size           bigint NOT NULL,
  content_type   text NOT NULL,
  kind           text NOT NULL,
  uploader_id    text NOT NULL,
  created_at     timestamptz NOT NULL,
  uploaded_at    timestamptz,
  in_drive       boolean NOT NULL DEFAULT false,
  drive_added_at timestamptz
);
CREATE INDEX IF NOT EXISTS cos_files_uploader_idx ON cos_files (uploader_id);

CREATE TABLE IF NOT EXISTS cos_file_links (
  id          bigserial PRIMARY KEY,
  file_key    text NOT NULL REFERENCES cos_files (file_key) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('chat', 'table')),
  chat_id     text,
  message_id  text,
  table_key   text,
  record_id   text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cos_file_links_file_idx ON cos_file_links (file_key);
CREATE INDEX IF NOT EXISTS cos_file_links_chat_idx ON cos_file_links (chat_id);
CREATE UNIQUE INDEX IF NOT EXISTS cos_file_links_uniq_idx ON cos_file_links
  (file_key, source_type, COALESCE(message_id, ''), COALESCE(table_key, ''), COALESCE(record_id, ''));

CREATE TABLE IF NOT EXISTS cos_calendar_events (
  event_id    text PRIMARY KEY,
  title       text NOT NULL,
  start_ms    bigint NOT NULL,
  end_ms      bigint NOT NULL,
  attendees   jsonb NOT NULL DEFAULT '[]'::jsonb,
  description text,
  location    text,
  all_day     boolean NOT NULL DEFAULT false,
  color       text,
  reminders   jsonb,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cos_calendar_events_time_idx ON cos_calendar_events (start_ms, end_ms);
CREATE INDEX IF NOT EXISTS cos_calendar_events_attendees_idx ON cos_calendar_events USING gin (attendees jsonb_path_ops);

CREATE TABLE IF NOT EXISTS cos_tasks (
  task_id      text PRIMARY KEY,
  title        text NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
  assignee_id  text,
  due_ms       bigint,
  description  text,
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  source       jsonb,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS cos_tasks_assignee_idx ON cos_tasks (assignee_id);
CREATE INDEX IF NOT EXISTS cos_tasks_creator_idx ON cos_tasks (created_by);

CREATE TABLE IF NOT EXISTS cos_docs (
  doc_id     text PRIMARY KEY,
  title      text NOT NULL,
  markdown   text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  yjs_update text
);
CREATE INDEX IF NOT EXISTS cos_docs_updated_idx ON cos_docs (updated_at DESC);

CREATE TABLE IF NOT EXISTS cos_devices (
  device_id    text PRIMARY KEY,
  user_id      text NOT NULL,
  platform     text NOT NULL CONSTRAINT cos_devices_platform_check CHECK (platform IN ('ios', 'android', 'macos')),
  device_token text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cos_devices_user_idx ON cos_devices (user_id);

-- 多维表格自定义数据表定义（POST /api/v1/tables）；记录存在以 table_key 命名的物理表里
CREATE TABLE IF NOT EXISTS cos_custom_tables (
  table_key         text PRIMARY KEY,
  name              text NOT NULL,
  description       text,
  icon              text NOT NULL DEFAULT 'table',
  primary_field     text NOT NULL,
  fields            jsonb NOT NULL,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  client_request_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS cos_custom_tables_name_uq ON cos_custom_tables (lower(btrim(name)));
CREATE INDEX IF NOT EXISTS cos_custom_tables_req_idx ON cos_custom_tables (created_by, client_request_id);

-- ---------------- 二期迭代 1 ----------------

-- 推送设备：macOS 也走 APNs
ALTER TABLE cos_devices DROP CONSTRAINT IF EXISTS cos_devices_platform_check;
ALTER TABLE cos_devices ADD CONSTRAINT cos_devices_platform_check CHECK (platform IN ('ios', 'android', 'macos'));

-- 表结构版本（字段管理的 base_version）
ALTER TABLE cos_custom_tables ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- 内置表的结构覆盖层：字段改名 / 改选项 / 新增自定义字段 / 默认顺序
CREATE TABLE IF NOT EXISTS cos_table_schemas (
  table_key  text PRIMARY KEY,
  version    integer NOT NULL,
  fields     jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

-- 多维表格视图（公共视图 + 个人视图）
CREATE TABLE IF NOT EXISTS cos_table_views (
  view_id    text PRIMARY KEY,
  table_key  text NOT NULL,
  name       text NOT NULL,
  type       text NOT NULL,
  personal   boolean NOT NULL DEFAULT false,
  owner_id   text,
  config     jsonb NOT NULL,
  version    integer NOT NULL DEFAULT 1,
  position   double precision NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cos_table_views_table_idx ON cos_table_views (table_key, position);

-- 通知中心
CREATE TABLE IF NOT EXISTS cos_notifications (
  seq             bigserial,
  notification_id text PRIMARY KEY,
  user_id         text NOT NULL,
  type            text NOT NULL,
  actor_id        text,
  title           text NOT NULL,
  summary         text NOT NULL DEFAULT '',
  target          jsonb NOT NULL,
  is_read         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL,
  dedupe_key      text
);
CREATE INDEX IF NOT EXISTS cos_notifications_user_idx ON cos_notifications (user_id, seq DESC);
CREATE INDEX IF NOT EXISTS cos_notifications_unread_idx ON cos_notifications (user_id) WHERE NOT is_read;
CREATE UNIQUE INDEX IF NOT EXISTS cos_notifications_dedupe_uq ON cos_notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS cos_notification_settings (
  user_id    text PRIMARY KEY,
  settings   jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS cos_tasks_due_idx ON cos_tasks (due_ms) WHERE assignee_id IS NOT NULL;

COMMIT;

-- Iteration 2: shared resource grants, optimistic concurrency.
CREATE TABLE IF NOT EXISTS cos_resource_grants (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('doc','table','wiki')),
  resource_id TEXT NOT NULL,
  data JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY(resource_type, resource_id)
);

-- 迭代2：文档权限申请；仅允许每位用户对同一文档有一条待处理申请。
CREATE TABLE IF NOT EXISTS cos_doc_access_requests (
 request_id text PRIMARY KEY,
 doc_id text NOT NULL,
 user_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','approved','rejected')),
 data jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cos_doc_access_pending_uq ON cos_doc_access_requests(doc_id,user_id) WHERE status='pending';

-- 迭代2：评论、历史版本、附件绑定等对象；version 用于乐观并发。
CREATE TABLE IF NOT EXISTS cos_entities (
 kind text NOT NULL,
 id text NOT NULL,
 scope text NOT NULL DEFAULT '',
 data jsonb NOT NULL,
 version integer NOT NULL CHECK(version > 0),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(kind,id)
);
CREATE INDEX IF NOT EXISTS cos_entities_scope_idx ON cos_entities(kind,scope,created_at,id);


-- 二期迭代 3：子任务 / 关注人（R-TK-01、02）、重复日程（R-CA-01）
ALTER TABLE cos_tasks ADD COLUMN IF NOT EXISTS parent_id text;
ALTER TABLE cos_tasks ADD COLUMN IF NOT EXISTS position double precision;
ALTER TABLE cos_tasks ADD COLUMN IF NOT EXISTS follower_ids text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS cos_tasks_parent_idx ON cos_tasks (parent_id);
CREATE INDEX IF NOT EXISTS cos_tasks_followers_idx ON cos_tasks USING gin (follower_ids);
ALTER TABLE cos_calendar_events ADD COLUMN IF NOT EXISTS recurrence text;
ALTER TABLE cos_calendar_events ADD COLUMN IF NOT EXISTS recurring_event_id text;
ALTER TABLE cos_calendar_events ADD COLUMN IF NOT EXISTS original_start_ms bigint;
ALTER TABLE cos_calendar_events ADD COLUMN IF NOT EXISTS exdates jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS cos_calendar_events_series_idx ON cos_calendar_events (recurring_event_id);
ALTER TABLE cos_calendar_events ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE cos_resource_grants DROP CONSTRAINT IF EXISTS cos_resource_grants_resource_type_check;
ALTER TABLE cos_resource_grants ADD CONSTRAINT cos_resource_grants_resource_type_check CHECK (resource_type IN ('doc','table','wiki','tasklist'));

-- 二期迭代 4：消息增强
ALTER TABLE cos_messages ADD COLUMN IF NOT EXISTS thread_root_id text;
ALTER TABLE cos_messages ADD COLUMN IF NOT EXISTS also_send_to_chat boolean NOT NULL DEFAULT false;
ALTER TABLE cos_messages ADD COLUMN IF NOT EXISTS forwarded_from jsonb;
CREATE INDEX IF NOT EXISTS cos_messages_thread_idx ON cos_messages (thread_root_id, seq) WHERE thread_root_id IS NOT NULL;
ALTER TABLE cos_chats ADD COLUMN IF NOT EXISTS thread_mode boolean NOT NULL DEFAULT false;
-- 通用关系表：表情回应、话题关注 / 已读、加急、收藏、Pin、最近访问、防重复提交
CREATE TABLE IF NOT EXISTS cos_relations (
  kind       text NOT NULL,
  k1         text NOT NULL,
  k2         text NOT NULL,
  k3         text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  seq        bigserial,
  PRIMARY KEY (kind, k1, k2, k3)
);
CREATE INDEX IF NOT EXISTS cos_relations_k2_idx ON cos_relations (kind, k2);
CREATE INDEX IF NOT EXISTS cos_relations_recent_idx ON cos_relations (kind, k1, updated_at DESC);

-- 迭代 4 全局搜索：中文按子串匹配（ILIKE），pg_trgm 可用时建 trigram 索引加速；没有权限装扩展时跳过，功能不受影响
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE $i$CREATE INDEX IF NOT EXISTS cos_messages_search_trgm ON cos_messages USING gin ((coalesce(content->>'text','') || ' ' || coalesce(content->>'title','') || ' ' || coalesce(content->>'markdown','') || ' ' || coalesce(content->>'file_name','')) gin_trgm_ops)$i$;
    EXECUTE $i$CREATE INDEX IF NOT EXISTS cos_docs_search_trgm ON cos_docs USING gin ((title || ' ' || markdown) gin_trgm_ops)$i$;
  END IF;
END $$;
