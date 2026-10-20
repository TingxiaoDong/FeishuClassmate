/**
 * Platform Abstraction Layer (PAL) — PLAN §2.3.
 *
 * Six capability groups abstracting 飞书 / ClassmateOS behind one contract,
 * so the skills + tools layer stays unchanged when the channel switches:
 *
 *   Auth     账号/组织（user_id 对齐 open_id）
 *   IM       单聊/群聊/bot 消息/卡片/ask_user_question
 *   Table    表格引擎（替代 Bitable，23 张核心表）
 *   Doc      文档（P1）
 *   Drive    云盘/文件（P1）
 *   Calendar 日历/任务（P1）
 *
 * Method shapes deliberately mirror the value semantics the existing tools
 * already use (Result<T>, ms-epoch dates, user id arrays), NOT any specific
 * platform's wire format.
 */

export type PalResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: number };

export class PalUnimplementedError extends Error {
  constructor(capability: string, adapter: string) {
    super(`${capability} is not implemented by adapter "${adapter}" (see PLAN §2.2 priorities)`);
    this.name = 'PalUnimplementedError';
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface PalUser {
  userId: string;
  name: string;
  email?: string;
  role?: 'admin' | 'member' | 'bot';
}

export interface AuthProvider {
  getCurrentUser(): Promise<PalResult<PalUser>>;
  listUsers(keyword?: string): Promise<PalResult<PalUser[]>>;
}

// ---------------------------------------------------------------------------
// IM
// ---------------------------------------------------------------------------

export type PalMessageType = 'text' | 'post' | 'image' | 'file' | 'interactive_card';

export interface PalMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  msgType: PalMessageType;
  content: Record<string, unknown>;
  createdAtMs: number;
}

export interface ImService {
  /** Send a message to a chat or a single user. */
  sendMessage(params: {
    receiveId: string;
    receiveIdType: 'chat_id' | 'user_id';
    msgType: PalMessageType;
    content: Record<string, unknown>;
    replyTo?: string;
  }): Promise<PalResult<PalMessage>>;

  /** Text shorthand. */
  sendText(receiveId: string, text: string, receiveIdType?: 'chat_id' | 'user_id'): Promise<PalResult<PalMessage>>;

  /**
   * ask_user_question 等价物：发一张交互卡片并等待回答。
   * 实现方可选择同步阻塞（带 timeout）或经事件回流恢复会话。
   */
  askUser(params: {
    userId: string;
    question: string;
    options?: string[];
    timeoutMs?: number;
  }): Promise<PalResult<{ answer: string; timedOut: boolean }>>;

  // ---- 可选能力（ClassmateOS 实现；飞书适配器没有时网关自动降级）----

  /** 编辑机器人自己发的文本消息（进度消息）。 */
  updateText?(messageId: string, text: string): Promise<PalResult<void>>;
  /** 卡片不再等待回答时标记过期。 */
  expireCard?(cardId: string): Promise<PalResult<void>>;
  /** 同学用文字回复「确认 / 取消」：凭这条消息替卡片记下答案（服务端核验）。 */
  answerCardByText?(cardId: string, messageId: string): Promise<PalResult<{ action: string }>>;
  /**
   * 查会话类型和成员（代码审查 A1：网关只回复单聊和群里 @ 机器人的消息）。
   * 以发消息的同学身份读取（同学一定是成员）；读不到时网关不回复。
   */
  getChat?(chatId: string, asUserId: string): Promise<PalResult<PalChatInfo>>;
}

export interface PalChatInfo {
  chatType: 'p2p' | 'group';
  memberIds: string[];
}

// ---------------------------------------------------------------------------
// Table（表格引擎）
// ---------------------------------------------------------------------------

export type PalRecordFields = Record<string, unknown>;

export interface PalRecord {
  recordId: string;
  fields: PalRecordFields;
}

export interface TableService {
  listRecords(params: {
    tableKey: string;
    filter?: string;
    sort?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<PalResult<{ records: PalRecord[]; hasMore: boolean; pageToken?: string }>>;

  createRecord(tableKey: string, fields: PalRecordFields): Promise<PalResult<PalRecord>>;

  updateRecord(tableKey: string, recordId: string, fields: PalRecordFields): Promise<PalResult<PalRecord>>;

  deleteRecord(tableKey: string, recordId: string): Promise<PalResult<void>>;
}

// ---------------------------------------------------------------------------
// Doc / Drive / Calendar（P1：接口先行，适配器可抛 PalUnimplementedError）
// ---------------------------------------------------------------------------

export interface DocService {
  createDocument(title: string, markdown: string): Promise<PalResult<{ docId: string; url: string }>>;
  getDocumentMarkdown(docId: string): Promise<PalResult<string>>;
}

export interface DriveService {
  uploadFile(fileName: string, data: Buffer, contentType?: string): Promise<PalResult<{ fileKey: string }>>;
  getDownloadUrl(fileKey: string): Promise<PalResult<{ url: string; expiresIn: number }>>;
}

export interface CalendarService {
  createEvent(params: {
    title: string;
    startMs: number;
    endMs: number;
    attendeeIds?: string[];
    description?: string;
  }): Promise<PalResult<{ eventId: string }>>;
  listEvents(userId: string, fromMs: number, toMs: number): Promise<PalResult<Array<{ eventId: string; title: string; startMs: number; endMs: number }>>>;
}

// ---------------------------------------------------------------------------
// Aggregated adapter
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
  /** 'feishu' | 'classmateos' — 灰度双跑时用于日志区分。 */
  readonly id: string;
  readonly auth: AuthProvider;
  readonly im: ImService;
  readonly table: TableService;
  readonly doc: DocService;
  readonly drive: DriveService;
  readonly calendar: CalendarService;
}
