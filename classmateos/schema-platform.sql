-- ClassmateOS 平台表（账号 / IM / 文件 / 日历 / 任务 / 文档 / 设备）
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
  platform     text NOT NULL CHECK (platform IN ('ios', 'android')),
  device_token text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cos_devices_user_idx ON cos_devices (user_id);

COMMIT;
