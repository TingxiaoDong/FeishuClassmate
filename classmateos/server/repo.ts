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
  /** 迭代 4：话题模式群。 */
  thread_mode?: boolean;
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
  /** 迭代 4：话题回复所属的根消息。 */
  thread_root_id?: string | null;
  /** 迭代 4：话题回复同时发到群。 */
  also_send_to_chat?: boolean;
  /** 迭代 4：单条转发来的消息的来源。 */
  forwarded_from?: Record<string, unknown> | null;
}

export type PublicMessage = Omit<MessageRecord, 'seq' | 'client_msg_id' | 'card_id'>;

export function publicMessage(m: MessageRecord): PublicMessage {
  const { seq: _s, client_msg_id: _c, card_id: _k, ...rest } = m;
  return { ...rest, thread_root_id: m.thread_root_id ?? null, also_send_to_chat: !!m.also_send_to_chat, forwarded_from: m.forwarded_from ?? null };
}

/** 只出现在话题面板里的回复（不进主会话、不算未读、不更新最后一条消息）。 */
export const isThreadOnly = (m: { thread_root_id?: string | null; also_send_to_chat?: boolean }) => !!m.thread_root_id && !m.also_send_to_chat;

export interface ThreadStat {
  reply_count: number;
  last_reply_at: string | null;
  last_seq: number;
  /** 回复过的人（按第一次回复先后）。 */
  participants: string[];
}

/**
 * 迭代 4 通用关系表：表情回应、话题关注 / 已读、加急、收藏、Pin、最近访问、防重复提交等
 * 「某人对某物的一条小记录」。主键 (kind, k1, k2, k3)。
 */
export interface RelRow {
  kind: string;
  k1: string;
  k2: string;
  k3: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
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
  thread_root_id?: string | null;
  also_send_to_chat?: boolean;
  forwarded_from?: Record<string, unknown> | null;
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
  /** 二期 R-CA-01：RRULE（只有系列主日程有）；null / 缺省 = 不重复。 */
  recurrence?: string | null;
  /** 例外实例：所属系列主日程 ID。 */
  recurring_event_id?: string | null;
  /** 例外实例：最初的开始时间。 */
  original_start_ms?: number | null;
  /** 主日程：被删除或被单独修改的实例的原始开始时间。 */
  exdates?: number[];
  /** 迭代 3 收尾：IANA 时区（如 Asia/Shanghai）；重复规则按它的本地时间展开。null = 服务器默认日历时区。 */
  timezone?: string | null;
}

/** 一次原子提交的多条日程改动（拆分系列、单独修改某一次等）。 */
export interface EventCommit {
  /** 提交前要求这条日程（通常是系列主日程）仍是读取时的状态；不一致返回 false，什么都不写。 */
  expect?: { event_id: string; updated_at: string };
  save: CalendarEventRecord[];
  remove: string[];
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
  /** 二期 R-TK-01：父任务；null = 顶层。 */
  parent_id?: string | null;
  /** 同一父任务下的排序。 */
  position?: number | null;
  /** 二期 R-TK-02：关注人。 */
  follower_ids?: string[];
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

/** 自定义数据表的字段定义（POST /tables 创建）。 */
export interface CustomFieldRecord {
  field_name: string;
  title: string;
  type: number;
  required: boolean;
  options?: string[];
  option_colors?: Record<string, string>;
  description?: string | null;
}

/** 表结构里的一个字段（内置表覆盖层 / 自定义表通用）。builtin = 内置表自带字段。 */
export interface FieldMetaRecord extends CustomFieldRecord {
  builtin?: boolean;
}

/**
 * 内置表的结构覆盖层（字段改名、改选项、新增自定义字段、默认顺序）。
 * 没有记录时按 src/bitable/schema.ts + table-meta.ts 生成，version = 1。
 */
export interface TableSchemaRecord {
  table_key: string;
  version: number;
  fields: FieldMetaRecord[];
  updated_at: string;
}

export type ViewType = 'grid' | 'kanban' | 'calendar' | 'gantt' | 'gallery';

export interface TableViewRecord {
  view_id: string;
  table_key: string;
  name: string;
  type: ViewType;
  personal: boolean;
  owner_id: string | null;
  config: Record<string, unknown>;
  version: number;
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationRecord {
  notification_id: string;
  user_id: string;
  type: string;
  actor_id: string | null;
  title: string;
  summary: string;
  target: Record<string, unknown>;
  read: boolean;
  created_at: string;
  /** 去重键（同一用户同一键只记一次，如任务到期提醒）。 */
  dedupe_key: string | null;
}

export interface NotificationSettings {
  enabled: boolean;
  categories: Record<string, boolean>;
  dnd: { enabled: boolean; start: string; end: string };
  mute_mobile_when_desktop_online: boolean;
  show_preview: boolean;
}

/** 自定义数据表定义；key 同时是 PostgreSQL 里的物理表名。 */
export interface CustomTableRecord {
  key: string;
  name: string;
  description: string | null;
  icon: string;
  primary_field: string;
  fields: CustomFieldRecord[];
  created_by: string;
  created_at: string;
  updated_at: string;
  client_request_id: string | null;
  /** 表结构版本（字段接口的 base_version），新建为 1。 */
  version: number;
}

export type DevicePlatform = 'ios' | 'android' | 'macos';

export interface DeviceRecord {
  device_id: string;
  user_id: string;
  platform: DevicePlatform;
  device_token: string;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface ResourceGrant {
  resource_type: 'doc' | 'table' | 'wiki' | 'tasklist';
  resource_id: string;
  owner_id: string;
  visibility: 'off' | 'org_view' | 'org_edit' | 'all' | 'members';
  members: Array<{ member_type: 'user' | 'department' | 'chat'; member_id: string; role: 'viewer' | 'commenter' | 'editor' | 'manager' }>;
  version: number;
}

export interface DocAccessRequest {
  request_id: string;
  doc_id: string;
  user_id: string;
  role: 'viewer' | 'commenter' | 'editor';
  note: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

/** 迭代 2 的通用持久化对象（评论、版本、附件关系等）；version 用于乐观并发。 */
export interface EntityRecord {
  kind: string;
  id: string;
  scope: string;
  data: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  getEntity(kind: string, id: string): Promise<EntityRecord | undefined>;
  /** 按 created_at、id 正序。 */
  listEntities(kind: string, scope?: string): Promise<EntityRecord[]>;
  /** expectedVersion=0 只插入；否则版本一致才更新。写入后 version = expectedVersion + 1。 */
  saveEntity(rec: EntityRecord, expectedVersion: number): Promise<boolean>;
  deleteEntity(kind: string, id: string): Promise<boolean>;

  getDocAccessRequest(id: string): Promise<DocAccessRequest | undefined>;
  saveDocAccessRequest(request: DocAccessRequest): Promise<boolean>;
  /** 原子审批：申请状态与授权版本一起检查并提交。 */
  resolveDocAccessRequest(id: string, status: 'approved' | 'rejected', grant: ResourceGrant): Promise<boolean>;

  getResourceGrant(type: ResourceGrant['resource_type'], id: string): Promise<ResourceGrant | undefined>;
  /** expectedVersion=0 means insert only; updates use optimistic concurrency. */
  saveResourceGrant(grant: ResourceGrant, expectedVersion: number): Promise<boolean>;

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
  updateChat(chatId: string, patch: { name?: string | null; description?: string | null; kind?: 'normal' | 'drive'; owner_id?: string | null; thread_mode?: boolean }): Promise<ChatRecord | undefined>;
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
  // ---- 迭代 4 ----
  /** 话题回复，按 seq 正序；afterSeq 为游标。 */
  listThreadReplies(rootId: string, opts: { afterSeq?: number; limit: number }): Promise<{ items: MessageRecord[]; has_more: boolean }>;
  /** 每个根消息的话题统计（没有回复的不返回）。 */
  threadStats(rootIds: string[]): Promise<Map<string, ThreadStat>>;
  /** 会话每个成员的已读位置。 */
  chatReadStates(chatId: string): Promise<Array<{ user_id: string; last_read_seq: number }>>;
  /**
   * 写关系表。默认只插入（已存在返回 exists）；upsert 时覆盖 data。
   * maxPerK1：同一 (kind, k1) 下最多几条，满了返回 limit（检查和插入是原子的）。
   */
  relPut(row: Omit<RelRow, 'created_at' | 'updated_at'> & { at: string }, opts?: { upsert?: boolean; maxPerK1?: number }): Promise<'inserted' | 'updated' | 'exists' | 'limit'>;
  relGet(kind: string, k1: string, k2: string, k3?: string): Promise<RelRow | undefined>;
  /** k2 / k3 不传表示删掉 k1 下的全部。返回删除条数。 */
  relDelete(kind: string, k1: string, k2?: string, k3?: string): Promise<number>;
  /** 按 updated_at 排序（默认倒序）。k1 可以是列表。 */
  relList(kind: string, filter: { k1?: string | string[]; k2?: string; k3?: string }, opts?: { limit?: number; offset?: number; order?: 'asc' | 'desc' }): Promise<{ items: RelRow[]; total: number }>;
  /** 未回答且未过期时写入 answer 并返回新消息；否则 undefined。 */
  answerCard(messageId: string, answer: Record<string, unknown>, at: string): Promise<MessageRecord | undefined>;
  updateMessage(
    messageId: string,
    patch: { content?: Record<string, unknown>; recalled?: boolean; updated_at: string },
  ): Promise<MessageRecord | undefined>;
  searchMessages(
    userId: string,
    opts: { keyword: string; chatId?: string; senderId?: string; sinceIso?: string; limit: number; offset: number },
  ): Promise<{ items: MessageRecord[]; has_more: boolean; total: number }>;
  /** 迭代 4 全局搜索：标题或正文包含关键词的文档（不做权限过滤），按更新时间倒序，最多 limit 篇。 */
  searchDocs(opts: { keyword: string; sinceIso?: string; limit: number }): Promise<DocRecord[]>;

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
  /** 普通日程和例外实例（不含重复系列主日程）。 */
  listEvents(userId: string, fromMs: number, toMs: number): Promise<CalendarEventRecord[]>;
  /** 用户参与的、首次开始早于 beforeMs 的重复系列主日程。 */
  listRecurringEvents(userId: string, beforeMs: number): Promise<CalendarEventRecord[]>;
  /** 某个系列的全部例外实例。 */
  listEventExceptions(masterId: string): Promise<CalendarEventRecord[]>;
  /** 原子地保存 / 删除一组日程；expect 不满足（被别人改过或已删除）时返回 false 且不写入。 */
  commitEvents(c: EventCommit): Promise<boolean>;

  // tasks
  saveTask(task: TaskRecord): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  deleteTask(taskId: string): Promise<boolean>;
  /**
   * 可见范围：创建人 / 负责人 / 关注人，或 extra_ids 里的任务（清单成员可见）。
   * parent：'top' 只要顶层；任务 ID 只要它的直接子任务；缺省不限。
   */
  listTasks(
    userId: string,
    opts: { assignee_id?: string; status?: string; created_by?: string; follower_id?: string; parent?: string; extra_ids?: string[] },
  ): Promise<TaskRecord[]>;
  /** 直接子任务（不做可见性过滤），按 position、created_at。 */
  listSubtasks(parentId: string): Promise<TaskRecord[]>;

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

  // custom tables（多维表格自定义数据表定义）
  /** 名称（去空格、大小写不敏感）已被占用时返回 'name_exists'，不插入。 */
  insertCustomTable(t: CustomTableRecord): Promise<'ok' | 'name_exists'>;
  getCustomTable(key: string): Promise<CustomTableRecord | undefined>;
  /** 按 created_at 正序。 */
  listCustomTables(): Promise<CustomTableRecord[]>;
  findCustomTableByName(name: string): Promise<CustomTableRecord | undefined>;
  /** 同一用户在 sinceIso 之后用同一 client_request_id 建的表。 */
  findCustomTableByRequest(userId: string, clientRequestId: string, sinceIso: string): Promise<CustomTableRecord | undefined>;
  deleteCustomTable(key: string): Promise<boolean>;
  /** 改自定义表的字段定义：当前 version 等于 ifVersion 才写入（乐观并发），返回是否写入。 */
  updateCustomTableFields(key: string, fields: CustomFieldRecord[], version: number, updatedAt: string, ifVersion: number): Promise<boolean>;

  // 内置表结构覆盖层
  getTableSchema(key: string): Promise<TableSchemaRecord | undefined>;
  /** ifVersion = null：只在还没有覆盖层时插入；否则当前 version 等于 ifVersion 才更新。 */
  saveTableSchema(rec: TableSchemaRecord, ifVersion: number | null): Promise<boolean>;

  // 多维表格视图
  /** 某张表的全部视图（含所有人的个人视图），按 position、created_at 排序。 */
  listViews(tableKey: string): Promise<TableViewRecord[]>;
  getView(viewId: string): Promise<TableViewRecord | undefined>;
  /** view_id 已存在时不插入，返回 false。 */
  insertView(v: TableViewRecord): Promise<boolean>;
  /** 当前 version 等于 ifVersion 才写入。 */
  updateView(v: TableViewRecord, ifVersion: number): Promise<boolean>;
  deleteView(viewId: string): Promise<boolean>;
  setViewPositions(tableKey: string, positions: Array<{ view_id: string; position: number }>): Promise<void>;

  // 通知中心
  /** dedupe_key 已存在（同一用户）时不插入，返回 false。 */
  insertNotification(n: NotificationRecord): Promise<boolean>;
  listNotifications(userId: string, opts: { mentionOnly: boolean; limit: number; offset: number }): Promise<Page<NotificationRecord>>;
  countUnreadNotifications(userId: string): Promise<number>;
  /** 返回实际标为已读的条数。ids = 'all' 表示全部。 */
  markNotificationsRead(userId: string, ids: string[] | 'all'): Promise<number>;
  getNotificationSettings(userId: string): Promise<NotificationSettings | undefined>;
  saveNotificationSettings(userId: string, s: NotificationSettings, at: string): Promise<void>;

  /** 截止时间在 [fromMs, toMs) 内、有负责人、未完成的任务（到期提醒用）。 */
  listTasksDueBetween(fromMs: number, toMs: number): Promise<TaskRecord[]>;

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
