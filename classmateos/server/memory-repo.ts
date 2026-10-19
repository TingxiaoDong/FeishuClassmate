/**
 * MemoryRepo：进程内存实现（开发 / 测试默认）。语义与 PgRepo 保持一致，
 * 共享同一套契约测试（tests/classmateos/frontend-contract.test.ts）。
 */

import type {
  CalendarEventRecord,
  ChatRecord,
  ChatView,
  DeviceRecord,
  DocRecord,
  FileLink,
  FileListEntry,
  FileRecord,
  MessageRecord,
  NewMessage,
  Page,
  Repo,
  TaskRecord,
  UserPatch,
  UserRecord,
} from './repo.js';

interface MemberState {
  user_id: string;
  joined_at: string;
  last_read_seq: number;
  last_read_message_id: string | null;
  pinned: boolean;
  muted: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);
const includesCI = (hay: string | null | undefined, needle: string) =>
  !!hay && hay.toLowerCase().includes(needle.toLowerCase());

export class MemoryRepo implements Repo {
  private readonly users = new Map<string, UserRecord>();
  private readonly refresh = new Map<string, { user_id: string; expires_at: string; revoked: boolean }>();
  private readonly chats = new Map<string, Omit<ChatRecord, 'member_ids'>>();
  private readonly members = new Map<string, MemberState[]>(); // chat_id → 成员
  private readonly messages = new Map<string, MessageRecord[]>(); // chat_id → 按 seq 升序
  private readonly messageIndex = new Map<string, MessageRecord>();
  private seq = 0;
  private readonly files = new Map<string, FileRecord>();
  private readonly fileLinks: FileLink[] = [];
  private readonly events = new Map<string, CalendarEventRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly docs = new Map<string, DocRecord>();
  private readonly devices = new Map<string, DeviceRecord>();

  // ---------------- users ----------------

  async listUsers(opts: { keyword?: string; limit: number; offset: number }): Promise<Page<UserRecord>> {
    const kw = opts.keyword?.trim();
    const all = [...this.users.values()].filter(
      (u) => !kw || includesCI(u.name, kw) || includesCI(u.user_id, kw) || includesCI(u.email, kw),
    );
    return { items: all.slice(opts.offset, opts.offset + opts.limit).map(clone), total: all.length };
  }

  async getUser(userId: string) {
    const u = this.users.get(userId);
    return u ? clone(u) : undefined;
  }

  async findUserByLogin(username: string) {
    const u = this.users.get(username) ?? [...this.users.values()].find((x) => x.name === username);
    return u ? clone(u) : undefined;
  }

  async insertUserIfMissing(user: UserRecord) {
    if (this.users.has(user.user_id)) return false;
    this.users.set(user.user_id, clone(user));
    return true;
  }

  async updateUser(userId: string, patch: UserPatch) {
    const u = this.users.get(userId);
    if (!u) return undefined;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (u as unknown as Record<string, unknown>)[k] = v;
    }
    return clone(u);
  }

  // ---------------- refresh tokens ----------------

  async saveRefreshToken(jti: string, userId: string, expiresAt: string) {
    this.refresh.set(jti, { user_id: userId, expires_at: expiresAt, revoked: false });
  }

  async consumeRefreshToken(jti: string) {
    const r = this.refresh.get(jti);
    if (!r || r.revoked || Date.parse(r.expires_at) < Date.now()) return undefined;
    r.revoked = true;
    return r.user_id;
  }

  async revokeRefreshToken(jti: string) {
    const r = this.refresh.get(jti);
    if (r) r.revoked = true;
  }

  // ---------------- chats ----------------

  private chatRecord(chatId: string): ChatRecord | undefined {
    const c = this.chats.get(chatId);
    if (!c) return undefined;
    return { ...clone(c), member_ids: (this.members.get(chatId) ?? []).map((m) => m.user_id) };
  }

  async createChat(chat: ChatRecord) {
    if (chat.p2p_key) {
      const existing = await this.findChatByP2PKey(chat.p2p_key);
      if (existing) return { chat: existing, created: false };
    }
    const { member_ids, ...rest } = chat;
    this.chats.set(chat.chat_id, clone(rest));
    this.members.set(
      chat.chat_id,
      [...new Set(member_ids)].map((user_id) => ({
        user_id,
        joined_at: chat.created_at,
        last_read_seq: 0,
        last_read_message_id: null,
        pinned: false,
        muted: false,
      })),
    );
    this.messages.set(chat.chat_id, []);
    return { chat: this.chatRecord(chat.chat_id)!, created: true };
  }

  async getChat(chatId: string) {
    return this.chatRecord(chatId);
  }

  async findChatByP2PKey(key: string) {
    const c = [...this.chats.values()].find((x) => x.p2p_key === key);
    return c ? this.chatRecord(c.chat_id) : undefined;
  }

  async updateChat(chatId: string, patch: { name?: string | null; description?: string | null; kind?: 'normal' | 'drive'; owner_id?: string | null }) {
    const c = this.chats.get(chatId);
    if (!c) return undefined;
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.description !== undefined) c.description = patch.description;
    if (patch.kind !== undefined) c.kind = patch.kind;
    if (patch.owner_id !== undefined) c.owner_id = patch.owner_id;
    return this.chatRecord(chatId);
  }

  async addMembers(chatId: string, userIds: string[], at: string) {
    const list = this.members.get(chatId);
    if (!list) return [];
    const added: string[] = [];
    // 新成员从「加入时刻」开始算未读，不把历史全算成未读
    const msgs = this.messages.get(chatId) ?? [];
    const last = msgs[msgs.length - 1];
    for (const id of new Set(userIds)) {
      if (list.some((m) => m.user_id === id)) continue;
      list.push({
        user_id: id,
        joined_at: at,
        last_read_seq: last?.seq ?? 0,
        last_read_message_id: last?.message_id ?? null,
        pinned: false,
        muted: false,
      });
      added.push(id);
    }
    return added;
  }

  async removeMember(chatId: string, userId: string) {
    const list = this.members.get(chatId);
    if (!list) return false;
    const i = list.findIndex((m) => m.user_id === userId);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }

  private view(chatId: string, userId: string): ChatView | undefined {
    const chat = this.chatRecord(chatId);
    const state = this.members.get(chatId)?.find((m) => m.user_id === userId);
    if (!chat || !state) return undefined;
    const msgs = this.messages.get(chatId) ?? [];
    const unread = msgs.filter(
      (m) => m.seq > state.last_read_seq && m.sender_id !== userId && m.msg_type !== 'system' && !m.recalled,
    ).length;
    return {
      chat,
      unread_count: unread,
      last_message: msgs.length ? clone(msgs[msgs.length - 1]) : null,
      last_read_message_id: state.last_read_message_id,
      pinned: state.pinned,
      muted: state.muted,
    };
  }

  async listChatViews(userId: string, opts: { limit: number; offset: number }) {
    const views = [...this.chats.keys()]
      .map((id) => this.view(id, userId))
      .filter((v): v is ChatView => !!v)
      .sort((a, b) => b.chat.updated_at.localeCompare(a.chat.updated_at) || a.chat.chat_id.localeCompare(b.chat.chat_id));
    return { items: views.slice(opts.offset, opts.offset + opts.limit), total: views.length };
  }

  async getChatView(chatId: string, userId: string) {
    return this.view(chatId, userId);
  }

  async markRead(chatId: string, userId: string, messageId?: string) {
    const state = this.members.get(chatId)?.find((m) => m.user_id === userId);
    if (!state) return undefined;
    const msgs = this.messages.get(chatId) ?? [];
    const target = messageId ? msgs.find((m) => m.message_id === messageId) : msgs[msgs.length - 1];
    if (messageId && !target) return undefined;
    if (!target) return { changed: false, message_id: state.last_read_message_id };
    if (target.seq <= state.last_read_seq) return { changed: false, message_id: state.last_read_message_id };
    state.last_read_seq = target.seq;
    state.last_read_message_id = target.message_id;
    return { changed: true, message_id: target.message_id };
  }

  async updateMemberSettings(chatId: string, userId: string, patch: { pinned?: boolean; muted?: boolean }) {
    const state = this.members.get(chatId)?.find((m) => m.user_id === userId);
    if (!state) return;
    if (patch.pinned !== undefined) state.pinned = patch.pinned;
    if (patch.muted !== undefined) state.muted = patch.muted;
  }

  // ---------------- messages ----------------

  async insertMessage(m: NewMessage) {
    const list = this.messages.get(m.chat_id);
    if (!list) throw new Error(`chat not found: ${m.chat_id}`);
    if (m.client_msg_id) {
      const dup = list.find((x) => x.sender_id === m.sender_id && x.client_msg_id === m.client_msg_id);
      if (dup) return { message: clone(dup), duplicate: true };
    }
    const rec: MessageRecord = {
      ...clone(m),
      updated_at: null,
      recalled: false,
      seq: ++this.seq,
    };
    list.push(rec);
    this.messageIndex.set(rec.message_id, rec);
    const chat = this.chats.get(m.chat_id)!;
    if (m.created_at > chat.updated_at) chat.updated_at = m.created_at;
    return { message: clone(rec), duplicate: false };
  }

  async getMessage(messageId: string) {
    const m = this.messageIndex.get(messageId);
    return m ? clone(m) : undefined;
  }

  async listMessages(chatId: string, opts: { limit: number; beforeId?: string; afterId?: string }) {
    const msgs = this.messages.get(chatId) ?? [];
    if (opts.afterId) {
      const cursor = msgs.find((m) => m.message_id === opts.afterId);
      if (!cursor) return undefined;
      const newer = msgs.filter((m) => m.seq > cursor.seq);
      return { items: newer.slice(0, opts.limit).map(clone), has_more: newer.length > opts.limit };
    }
    let older = msgs;
    if (opts.beforeId) {
      const cursor = msgs.find((m) => m.message_id === opts.beforeId);
      if (!cursor) return undefined;
      older = msgs.filter((m) => m.seq < cursor.seq);
    }
    const desc = [...older].reverse();
    return { items: desc.slice(0, opts.limit).map(clone), has_more: desc.length > opts.limit };
  }

  async findMessageByCardId(cardId: string) {
    for (const m of this.messageIndex.values()) if (m.card_id === cardId) return clone(m);
    return undefined;
  }

  async answerCard(messageId: string, answer: Record<string, unknown>, at: string) {
    const m = this.messageIndex.get(messageId);
    if (!m) return undefined;
    if (m.content.answer != null || m.content.expired === true) return undefined;
    m.content = { ...m.content, answer };
    m.updated_at = at;
    return clone(m);
  }

  async updateMessage(messageId: string, patch: { content?: Record<string, unknown>; recalled?: boolean; updated_at: string }) {
    const m = this.messageIndex.get(messageId);
    if (!m) return undefined;
    if (patch.content !== undefined) m.content = clone(patch.content);
    if (patch.recalled !== undefined) m.recalled = patch.recalled;
    m.updated_at = patch.updated_at;
    return clone(m);
  }

  async searchMessages(userId: string, opts: { keyword: string; chatId?: string; limit: number; offset: number }) {
    const hits: MessageRecord[] = [];
    for (const [chatId, list] of this.messages) {
      if (opts.chatId && chatId !== opts.chatId) continue;
      if (!this.members.get(chatId)?.some((m) => m.user_id === userId)) continue;
      for (const m of list) {
        if (m.recalled || m.msg_type === 'system') continue;
        const c = m.content;
        if ([c.text, c.title, c.file_name].some((v) => typeof v === 'string' && includesCI(v, opts.keyword))) {
          hits.push(m);
        }
      }
    }
    hits.sort((a, b) => b.seq - a.seq);
    return {
      items: hits.slice(opts.offset, opts.offset + opts.limit).map(clone),
      has_more: hits.length > opts.offset + opts.limit,
    };
  }

  // ---------------- files ----------------

  async createFile(f: FileRecord) {
    this.files.set(f.file_key, clone(f));
  }

  async getFile(fileKey: string) {
    const f = this.files.get(fileKey);
    return f ? clone(f) : undefined;
  }

  async markFileUploaded(fileKey: string, size: number, at: string) {
    const f = this.files.get(fileKey);
    if (!f) return;
    f.size = size;
    f.uploaded_at = at;
  }

  async setFileDrive(fileKey: string, inDrive: boolean, at: string) {
    const f = this.files.get(fileKey);
    if (!f) return;
    f.in_drive = inDrive;
    f.drive_added_at = inDrive ? (f.drive_added_at ?? at) : null;
  }

  async addFileLink(link: FileLink) {
    const dup = this.fileLinks.some(
      (l) =>
        l.file_key === link.file_key &&
        l.source_type === link.source_type &&
        l.message_id === link.message_id &&
        l.table_key === link.table_key &&
        l.record_id === link.record_id,
    );
    if (!dup) this.fileLinks.push(clone(link));
  }

  async listFileLinks(fileKey: string) {
    return this.fileLinks.filter((l) => l.file_key === fileKey).map(clone);
  }

  async deleteFile(fileKey: string) {
    this.files.delete(fileKey);
    for (let i = this.fileLinks.length - 1; i >= 0; i--) {
      if (this.fileLinks[i].file_key === fileKey) this.fileLinks.splice(i, 1);
    }
  }

  async listFiles(
    userId: string,
    opts: { scope: 'all' | 'mine' | 'shared'; kind?: string; keyword?: string; limit: number; offset: number },
  ) {
    const byKey = new Map<string, FileListEntry>();
    if (opts.scope !== 'shared') {
      for (const f of this.files.values()) {
        if (f.uploader_id === userId && f.in_drive && f.uploaded_at) {
          byKey.set(f.file_key, { file: clone(f), source: { type: 'drive' } });
        }
      }
    }
    if (opts.scope !== 'mine') {
      const links = this.fileLinks
        .filter((l) => l.source_type === 'chat' && l.chat_id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      for (const l of links) {
        if (byKey.has(l.file_key)) continue;
        const chat = this.chats.get(l.chat_id!);
        if (!chat || chat.kind === 'drive') continue;
        if (!this.members.get(l.chat_id!)?.some((m) => m.user_id === userId)) continue;
        const f = this.files.get(l.file_key);
        if (!f?.uploaded_at) continue;
        byKey.set(l.file_key, {
          file: clone(f),
          source: { type: 'chat', chat_id: l.chat_id!, message_id: l.message_id ?? undefined },
        });
      }
    }
    const kw = opts.keyword?.trim();
    const all = [...byKey.values()]
      .filter((e) => (!opts.kind || e.file.kind === opts.kind) && (!kw || includesCI(e.file.file_name, kw)))
      .sort((a, b) => b.file.created_at.localeCompare(a.file.created_at) || a.file.file_key.localeCompare(b.file.file_key));
    return { items: all.slice(opts.offset, opts.offset + opts.limit), total: all.length };
  }

  async fileUsage(userId: string) {
    let used = 0;
    for (const f of this.files.values()) if (f.uploader_id === userId && f.uploaded_at) used += f.size;
    return used;
  }

  // ---------------- calendar ----------------

  async saveEvent(ev: CalendarEventRecord) {
    this.events.set(ev.event_id, clone(ev));
  }

  async getEvent(eventId: string) {
    const e = this.events.get(eventId);
    return e ? clone(e) : undefined;
  }

  async deleteEvent(eventId: string) {
    return this.events.delete(eventId);
  }

  async listEvents(userId: string, fromMs: number, toMs: number) {
    return [...this.events.values()]
      .filter(
        (e) =>
          (e.created_by === userId || e.attendees.some((a) => a.user_id === userId)) &&
          e.end_ms > fromMs &&
          e.start_ms < toMs,
      )
      .sort((a, b) => a.start_ms - b.start_ms)
      .map(clone);
  }

  // ---------------- tasks ----------------

  async saveTask(task: TaskRecord) {
    this.tasks.set(task.task_id, clone(task));
  }

  async getTask(taskId: string) {
    const t = this.tasks.get(taskId);
    return t ? clone(t) : undefined;
  }

  async deleteTask(taskId: string) {
    return this.tasks.delete(taskId);
  }

  async listTasks(userId: string, opts: { assignee_id?: string; status?: string; created_by?: string }) {
    return [...this.tasks.values()]
      .filter((t) => t.created_by === userId || t.assignee_id === userId)
      .filter((t) => !opts.assignee_id || t.assignee_id === opts.assignee_id)
      .filter((t) => !opts.status || t.status === opts.status)
      .filter((t) => !opts.created_by || t.created_by === opts.created_by)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(clone);
  }

  // ---------------- docs ----------------

  async createDoc(doc: DocRecord) {
    this.docs.set(doc.doc_id, clone(doc));
  }

  async getDoc(docId: string) {
    const d = this.docs.get(docId);
    return d ? clone(d) : undefined;
  }

  async updateDoc(doc: DocRecord, ifUpdatedAt?: string) {
    const cur = this.docs.get(doc.doc_id);
    if (!cur) return false;
    if (ifUpdatedAt !== undefined && cur.updated_at !== ifUpdatedAt) return false;
    this.docs.set(doc.doc_id, clone(doc));
    return true;
  }

  async deleteDoc(docId: string) {
    return this.docs.delete(docId);
  }

  async listDocs(opts: { userId: string; scope: 'all' | 'mine' | 'shared'; keyword?: string; limit: number; offset: number }) {
    const kw = opts.keyword?.trim();
    const all = [...this.docs.values()]
      .filter((d) => opts.scope === 'all' || (opts.scope === 'mine' ? d.created_by === opts.userId : d.created_by !== opts.userId))
      .filter((d) => !kw || includesCI(d.title, kw))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.doc_id.localeCompare(b.doc_id));
    return { items: all.slice(opts.offset, opts.offset + opts.limit).map(clone), total: all.length };
  }

  // ---------------- devices ----------------

  async upsertDevice(d: DeviceRecord) {
    const existing = [...this.devices.values()].find((x) => x.device_token === d.device_token);
    if (existing) {
      existing.user_id = d.user_id;
      existing.platform = d.platform;
      return clone(existing);
    }
    this.devices.set(d.device_id, clone(d));
    return clone(d);
  }

  async getDevice(deviceId: string) {
    const d = this.devices.get(deviceId);
    return d ? clone(d) : undefined;
  }

  async deleteDevice(deviceId: string) {
    this.devices.delete(deviceId);
  }

  async listDevices(userIds: string[]) {
    const set = new Set(userIds);
    return [...this.devices.values()].filter((d) => set.has(d.user_id)).map(clone);
  }
}
