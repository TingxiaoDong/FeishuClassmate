/**
 * 平台数据层接口（账号、IM、文件、日历、任务、文档、设备）。
 *
 * 两个实现：
 *   - MemoryRepo（memory-repo.ts）：开发 / 测试默认，进程内存；
 *   - PgRepo（pg-repo.ts）：PostgreSQL 持久化，设置 DATABASE_URL 即启用。
 * 多维表格记录仍走 TableStore（store.ts / pg-store.ts）。
 *
 * 约定：时间戳一律由应用层生成 ISO 字符串（毫秒精度）传入，保证两种实现
 * 读写往返一致（文档并发保护按 updated_at 字符串比较）。
 */

export type Role = 'admin' | 'member' | 'bot';

export interface UserRecord {
  user_id: string;
  name: string;
  email: string | null;
  role: Role;
  avatar_url: string | null;
  department: string | null;
  title: string | null;
  phone: string | null;
  status_text: string | null;
  password_hash: string;
  disabled: boolean;
  created_at: string;
  updated_at: string;
}

export type PublicUser = Pick<
  UserRecord,
  'user_id' | 'name' | 'email' | 'role' | 'avatar_url' | 'department' | 'title' | 'phone' | 'status_text'
>;

export function publicUser(u: UserRecord): PublicUser {
  return {
    user_id: u.user_id,
    name: u.name,
    email: u.email,
    role: u.role,
    avatar_url: u.avatar_url,
    department: u.department,
    title: u.title,
    phone: u.phone,
    status_text: u.status_text,
  };
}

export type UserPatch = Partial<
  Pick<UserRecord, 'name' | 'email' | 'role' | 'avatar_url' | 'department' | 'title' | 'phone' | 'status_text' | 'disabled' | 'password_hash'>
> & { updated_at: string };

// ---------------- IM ----------------

export interface ChatRecord {
  chat_id: string;
  chat_type: 'p2p' | 'group';
  name: string | null;
  description: string | null;
  owner_id: string | null;
  kind: 'normal' | 'drive';
  /** 单聊去重键（两人 user_id 排序后拼接）；群聊为 null。 */
  p2p_key: string | null;
  member_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  message_id: string;
  chat_id: string;
  sender_id: string;
  msg_type: string;
  content: Record<string, unknown>;
  created_at: string;
  updated_at: string | null;
  recalled: boolean;
  reply_to_message_id: string | null;
  /** 内部：会话内单调递增序号（分页 / 未读计算）。 */
  seq: number;
  /** 内部：幂等键。 */
  client_msg_id: string | null;
  /** 内部：interactive_card 的 card_id。 */
  card_id: string | null;
}

export type PublicMessage = Omit<MessageRecord, 'seq' | 'client_msg_id' | 'card_id'>;

export function publicMessage(m: MessageRecord): PublicMessage {
  const { seq: _s, client_msg_id: _c, card_id: _k, ...rest } = m;
  return rest;
}

export interface ChatView {
  chat: ChatRecord;
  unread_count: number;
  last_message: MessageRecord | null;
  last_read_message_id: string | null;
  pinned: boolean;
  muted: boolean;
}

export interface NewMessage {
  message_id: string;
  chat_id: string;
  sender_id: string;
  msg_type: string;
  content: Record<string, unknown>;
  created_at: string;
  reply_to_message_id: string | null;
  client_msg_id: string | null;
  card_id: string | null;
}

// ---------------- 文件 ----------------

export type FileKind = 'image' | 'doc' | 'pdf' | 'sheet' | 'slide' | 'other';

export interface FileRecord {
  file_key: string;
  file_name: string;
  size: number;
  content_type: string;
  kind: FileKind;
  uploader_id: string;
  created_at: string;
  /** PUT 直传完成时间；null 表示还没上传完。 */
  uploaded_at: string | null;
  in_drive: boolean;
  drive_added_at: string | null;
}

export interface FileLink {
  file_key: string;
  source_type: 'chat' | 'table';
  chat_id: string | null;
  message_id: string | null;
  table_key: string | null;
  record_id: string | null;
  created_at: string;
}

export interface FileListEntry {
  file: FileRecord;
  source: { type: 'drive' | 'chat' | 'table'; chat_id?: string; message_id?: string };
}

// ---------------- 日历 / 任务 / 文档 / 设备 ----------------

export type Rsvp = 'pending' | 'accepted' | 'declined' | 'tentative';

export interface CalendarEventRecord {
  event_id: string;
  title: string;
  start_ms: number;
  end_ms: number;
  attendees: Array<{ user_id: string; rsvp: Rsvp }>;
  description: string | null;
  location: string | null;
  all_day: boolean;
  color: string | null;
  reminders: number[] | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TaskRecord {
  task_id: string;
  title: string;
  status: TaskStatus;
  assignee_id: string | null;
  due_ms: number | null;
  description: string | null;
  priority: TaskPriority;
  source: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DocRecord {
  doc_id: string;
  title: string;
  markdown: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
  /** 协同编辑持久化态（Yjs update base64）。 */
  yjs_update: string | null;
}

export interface DeviceRecord {
  device_id: string;
  user_id: string;
  platform: 'ios' | 'android';
  device_token: string;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface Repo {
  init?(): Promise<void>;

  // users
  listUsers(opts: { keyword?: string; limit: number; offset: number }): Promise<Page<UserRecord>>;
  getUser(userId: string): Promise<UserRecord | undefined>;
  findUserByLogin(username: string): Promise<UserRecord | undefined>;
  /** 种子账号：不存在才插入，返回是否插入。 */
  insertUserIfMissing(user: UserRecord): Promise<boolean>;
  updateUser(userId: string, patch: UserPatch): Promise<UserRecord | undefined>;

  // refresh tokens
  saveRefreshToken(jti: string, userId: string, expiresAt: string): Promise<void>;
  /** 原子地消费（吊销）一个有效 refresh 令牌，返回其 user_id。 */
  consumeRefreshToken(jti: string): Promise<string | undefined>;
  revokeRefreshToken(jti: string): Promise<void>;

  // chats
  /** 创建会话；p2p_key 已存在时返回已有会话（created=false）。 */
  createChat(chat: ChatRecord): Promise<{ chat: ChatRecord; created: boolean }>;
  getChat(chatId: string): Promise<ChatRecord | undefined>;
  findChatByP2PKey(key: string): Promise<ChatRecord | undefined>;
  updateChat(chatId: string, patch: { name?: string | null; description?: string | null; kind?: 'normal' | 'drive'; owner_id?: string | null }): Promise<ChatRecord | undefined>;
  /** 返回真正新加入的成员。 */
  addMembers(chatId: string, userIds: string[], at: string): Promise<string[]>;
  removeMember(chatId: string, userId: string): Promise<boolean>;
  listChatViews(userId: string, opts: { limit: number; offset: number }): Promise<Page<ChatView>>;
  getChatView(chatId: string, userId: string): Promise<ChatView | undefined>;
  /** 已读位置只前进不后退；messageId 不传 = 最新一条。消息不存在返回 undefined。 */
  markRead(
    chatId: string,
    userId: string,
    messageId?: string,
  ): Promise<{ changed: boolean; message_id: string | null } | undefined>;
  updateMemberSettings(chatId: string, userId: string, patch: { pinned?: boolean; muted?: boolean }): Promise<void>;

  // messages
  /** 插入消息并把会话 updated_at 推到消息时间；client_msg_id 重复时返回已有消息。 */
  insertMessage(m: NewMessage): Promise<{ message: MessageRecord; duplicate: boolean }>;
  getMessage(messageId: string): Promise<MessageRecord | undefined>;
  /** 游标消息不存在（或不在该会话）返回 undefined。 */
  listMessages(
    chatId: string,
    opts: { limit: number; beforeId?: string; afterId?: string },
  ): Promise<{ items: MessageRecord[]; has_more: boolean } | undefined>;
  findMessageByCardId(cardId: string): Promise<MessageRecord | undefined>;
  /** 未回答且未过期时写入 answer 并返回新消息；否则 undefined。 */
  answerCard(messageId: string, answer: Record<string, unknown>, at: string): Promise<MessageRecord | undefined>;
  updateMessage(
    messageId: string,
    patch: { content?: Record<string, unknown>; recalled?: boolean; updated_at: string },
  ): Promise<MessageRecord | undefined>;
  searchMessages(
    userId: string,
    opts: { keyword: string; chatId?: string; limit: number; offset: number },
  ): Promise<{ items: MessageRecord[]; has_more: boolean }>;

  // files
  createFile(f: FileRecord): Promise<void>;
  getFile(fileKey: string): Promise<FileRecord | undefined>;
  markFileUploaded(fileKey: string, size: number, at: string): Promise<void>;
  setFileDrive(fileKey: string, inDrive: boolean, at: string): Promise<void>;
  addFileLink(link: FileLink): Promise<void>;
  listFileLinks(fileKey: string): Promise<FileLink[]>;
  deleteFile(fileKey: string): Promise<void>;
  listFiles(
    userId: string,
    opts: { scope: 'all' | 'mine' | 'shared'; kind?: FileKind; keyword?: string; limit: number; offset: number },
  ): Promise<Page<FileListEntry>>;
  fileUsage(userId: string): Promise<number>;

  // calendar
  saveEvent(ev: CalendarEventRecord): Promise<void>;
  getEvent(eventId: string): Promise<CalendarEventRecord | undefined>;
  deleteEvent(eventId: string): Promise<boolean>;
  listEvents(userId: string, fromMs: number, toMs: number): Promise<CalendarEventRecord[]>;

  // tasks
  saveTask(task: TaskRecord): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  deleteTask(taskId: string): Promise<boolean>;
  listTasks(
    userId: string,
    opts: { assignee_id?: string; status?: string; created_by?: string },
  ): Promise<TaskRecord[]>;

  // docs
  createDoc(doc: DocRecord): Promise<void>;
  getDoc(docId: string): Promise<DocRecord | undefined>;
  /** ifUpdatedAt 给出时做乐观并发：当前 updated_at 不一致返回 false。 */
  updateDoc(doc: DocRecord, ifUpdatedAt?: string): Promise<boolean>;
  deleteDoc(docId: string): Promise<boolean>;
  listDocs(opts: {
    userId: string;
    scope: 'all' | 'mine' | 'shared';
    keyword?: string;
    limit: number;
    offset: number;
  }): Promise<Page<DocRecord>>;

  // devices
  upsertDevice(d: DeviceRecord): Promise<DeviceRecord>;
  getDevice(deviceId: string): Promise<DeviceRecord | undefined>;
  deleteDevice(deviceId: string): Promise<void>;
  listDevices(userIds: string[]): Promise<DeviceRecord[]>;
}

// ---------------- 公共工具 ----------------

export function p2pKeyOf(a: string, b: string): string {
  return JSON.stringify([a, b].sort());
}

const EXT_KIND: Record<string, FileKind> = {};
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic']) EXT_KIND[e] = 'image';
for (const e of ['doc', 'docx', 'md', 'txt']) EXT_KIND[e] = 'doc';
EXT_KIND.pdf = 'pdf';
for (const e of ['xls', 'xlsx', 'csv']) EXT_KIND[e] = 'sheet';
for (const e of ['ppt', 'pptx', 'key']) EXT_KIND[e] = 'slide';

export function extOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : '';
}

export function fileKindOf(fileName: string): FileKind {
  return EXT_KIND[extOf(fileName)] ?? 'other';
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  html: 'text/html',
  htm: 'text/html',
};

export function guessContentType(fileName: string): string {
  return EXT_MIME[extOf(fileName)] ?? 'application/octet-stream';
}

export function nowIso(): string {
  return new Date().toISOString();
}
