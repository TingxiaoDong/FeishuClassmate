import type { RelRow, ThreadStat } from './repo.js';
import { isThreadOnly } from './repo.js';
import type { EntityRecord } from './repo.js';
import type { DocAccessRequest } from './repo.js';
import type { ResourceGrant } from './repo.js';
/**
 * MemoryRepo：进程内存实现（开发 / 测试默认）。语义与 PgRepo 保持一致，
 * 共享同一套契约测试（tests/classmateos/frontend-contract.test.ts）。
 */

import type {
  CalendarEventRecord,
  EventCommit,
  ChatRecord,
  ChatView,
  CustomFieldRecord,
  CustomTableRecord,
  NotificationRecord,
  NotificationSettings,
  TableSchemaRecord,
  TableViewRecord,
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
  private readonly entities = new Map<string, EntityRecord>();
  async getEntity(kind: string, id: string) {
    const e = this.entities.get(`${kind}\u0000${id}`);
    return e ? structuredClone(e) : undefined;
  }
  async listEntities(kind: string, scope?: string) {
    return [...this.entities.values()]
      .filter((e) => e.kind === kind && (scope === undefined || e.scope === scope))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((e) => structuredClone(e));
  }
  async saveEntity(rec: EntityRecord, expectedVersion: number) {
    const key = `${rec.kind}\u0000${rec.id}`;
    if ((this.entities.get(key)?.version ?? 0) !== expectedVersion) return false;
    this.entities.set(key, structuredClone({ ...rec, version: expectedVersion + 1 }));
    return true;
  }
  async deleteEntity(kind: string, id: string) {
    return this.entities.delete(`${kind}\u0000${id}`);
  }

  private readonly accessRequests = new Map<string, DocAccessRequest>();
  async getDocAccessRequest(id: string) {
    const r = this.accessRequests.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async saveDocAccessRequest(r: DocAccessRequest) {
    if ([...this.accessRequests.values()].some(x => x.doc_id === r.doc_id && x.user_id === r.user_id && x.status === 'pending')) return false;
    this.accessRequests.set(r.request_id, structuredClone(r));
    return true;
  }
  async resolveDocAccessRequest(id: string, status: 'approved' | 'rejected', grant: ResourceGrant) {
    const r = this.accessRequests.get(id);
    const key = `doc:${grant.resource_id}`;
    if (!r || r.status !== 'pending' || r.doc_id !== grant.resource_id || (this.resourceGrants.get(key)?.version ?? 0) !== grant.version) return false;
    if (status === 'approved') this.resourceGrants.set(key, structuredClone({ ...grant, version: grant.version + 1 }));
    r.status = status;
    return true;
  }

  private readonly resourceGrants = new Map<string, ResourceGrant>();
  async getResourceGrant(type: ResourceGrant['resource_type'], id: string): Promise<ResourceGrant | undefined> {
    const value = this.resourceGrants.get(`${type}:${id}`);
    return value ? structuredClone(value) : undefined;
  }
  async saveResourceGrant(grant: ResourceGrant, expectedVersion: number): Promise<boolean> {
    const key = `${grant.resource_type}:${grant.resource_id}`;
    if ((this.resourceGrants.get(key)?.version ?? 0) !== expectedVersion) return false;
    this.resourceGrants.set(key, structuredClone({ ...grant, version: expectedVersion + 1 }));
    return true;
  }

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
  private readonly customTables = new Map<string, CustomTableRecord>();
  private readonly tableSchemas = new Map<string, TableSchemaRecord>();
  private readonly views = new Map<string, TableViewRecord>();
  private readonly notifications: NotificationRecord[] = [];
  private readonly notificationSettings = new Map<string, NotificationSettings>();

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

  async updateChat(chatId: string, patch: { name?: string | null; description?: string | null; kind?: 'normal' | 'drive'; owner_id?: string | null; thread_mode?: boolean }) {
    const c = this.chats.get(chatId);
    if (!c) return undefined;
    if (patch.thread_mode !== undefined) c.thread_mode = patch.thread_mode;
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
    const msgs = (this.messages.get(chatId) ?? []).filter((m) => !isThreadOnly(m));
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
      thread_root_id: m.thread_root_id ?? null,
      also_send_to_chat: !!m.also_send_to_chat,
      forwarded_from: m.forwarded_from ?? null,
      updated_at: null,
      recalled: false,
      seq: ++this.seq,
    };
    list.push(rec);
    this.messageIndex.set(rec.message_id, rec);
    const chat = this.chats.get(m.chat_id)!;
    if (!isThreadOnly(rec) && m.created_at > chat.updated_at) chat.updated_at = m.created_at;
    return { message: clone(rec), duplicate: false };
  }

  async getMessage(messageId: string) {
    const m = this.messageIndex.get(messageId);
    return m ? clone(m) : undefined;
  }

  async listMessages(chatId: string, opts: { limit: number; beforeId?: string; afterId?: string }) {
    const all = this.messages.get(chatId) ?? [];
    const msgs = all.filter((m) => !isThreadOnly(m));
    if (opts.afterId) {
      const cursor = all.find((m) => m.message_id === opts.afterId);
      if (!cursor) return undefined;
      const newer = msgs.filter((m) => m.seq > cursor.seq);
      return { items: newer.slice(0, opts.limit).map(clone), has_more: newer.length > opts.limit };
    }
    let older = msgs;
    if (opts.beforeId) {
      const cursor = all.find((m) => m.message_id === opts.beforeId);
      if (!cursor) return undefined;
      older = msgs.filter((m) => m.seq < cursor.seq);
    }
    const desc = [...older].reverse();
    return { items: desc.slice(0, opts.limit).map(clone), has_more: desc.length > opts.limit };
  }

  async listThreadReplies(rootId: string, opts: { afterSeq?: number; limit: number }) {
    const root = this.messageIndex.get(rootId);
    const list = (root ? this.messages.get(root.chat_id) ?? [] : []).filter((m) => m.thread_root_id === rootId && m.seq > (opts.afterSeq ?? 0));
    return { items: list.slice(0, opts.limit).map(clone), has_more: list.length > opts.limit };
  }

  async threadStats(rootIds: string[]) {
    const out = new Map<string, ThreadStat>();
    const want = new Set(rootIds);
    for (const id of want) {
      const root = this.messageIndex.get(id);
      if (!root) continue;
      for (const m of this.messages.get(root.chat_id) ?? []) {
        if (m.thread_root_id !== id || m.recalled) continue;
        const s = out.get(id) ?? { reply_count: 0, last_reply_at: null, last_seq: 0, participants: [] };
        s.reply_count++;
        s.last_reply_at = m.created_at;
        s.last_seq = m.seq;
        if (!s.participants.includes(m.sender_id)) s.participants.push(m.sender_id);
        out.set(id, s);
      }
    }
    return out;
  }

  async chatReadStates(chatId: string) {
    return (this.members.get(chatId) ?? []).map((m) => ({ user_id: m.user_id, last_read_seq: m.last_read_seq }));
  }

  private readonly rels = new Map<string, RelRow & { _seq: number }>();
  private relSeq = 0;
  private relKey = (kind: string, k1: string, k2: string, k3: string) => [kind, k1, k2, k3].join('\u0000');

  async relPut(row: Omit<RelRow, 'created_at' | 'updated_at'> & { at: string }, opts: { upsert?: boolean; maxPerK1?: number } = {}) {
    const key = this.relKey(row.kind, row.k1, row.k2, row.k3);
    const cur = this.rels.get(key);
    if (cur) {
      if (!opts.upsert) return 'exists' as const;
      cur.data = clone(row.data);
      cur.updated_at = row.at;
      return 'updated' as const;
    }
    if (opts.maxPerK1 !== undefined) {
      let n = 0;
      for (const r of this.rels.values()) if (r.kind === row.kind && r.k1 === row.k1) n++;
      if (n >= opts.maxPerK1) return 'limit' as const;
    }
    this.rels.set(key, { kind: row.kind, k1: row.k1, k2: row.k2, k3: row.k3, data: clone(row.data), created_at: row.at, updated_at: row.at, _seq: ++this.relSeq });
    return 'inserted' as const;
  }

  async relGet(kind: string, k1: string, k2: string, k3 = '') {
    const r = this.rels.get(this.relKey(kind, k1, k2, k3));
    if (!r) return undefined;
    const { _seq, ...row } = r;
    return clone(row);
  }

  async relDelete(kind: string, k1: string, k2?: string, k3?: string) {
    let n = 0;
    for (const [key, r] of this.rels) {
      if (r.kind === kind && r.k1 === k1 && (k2 === undefined || r.k2 === k2) && (k3 === undefined || r.k3 === k3)) {
        this.rels.delete(key);
        n++;
      }
    }
    return n;
  }

  async relList(kind: string, filter: { k1?: string | string[]; k2?: string; k3?: string }, opts: { limit?: number; offset?: number; order?: 'asc' | 'desc' } = {}) {
    const k1s = filter.k1 === undefined ? undefined : new Set(Array.isArray(filter.k1) ? filter.k1 : [filter.k1]);
    const all = [...this.rels.values()]
      .filter((r) => r.kind === kind && (!k1s || k1s.has(r.k1)) && (filter.k2 === undefined || r.k2 === filter.k2) && (filter.k3 === undefined || r.k3 === filter.k3))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a._seq - b._seq);
    if (opts.order !== 'asc') all.reverse();
    const off = opts.offset ?? 0;
    return { items: all.slice(off, opts.limit === undefined ? undefined : off + opts.limit).map(({ _seq, ...r }) => clone(r)), total: all.length };
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

  async searchMessages(userId: string, opts: { keyword: string; chatId?: string; senderId?: string; sinceIso?: string; limit: number; offset: number }) {
    const hits: MessageRecord[] = [];
    for (const [chatId, list] of this.messages) {
      if (opts.chatId && chatId !== opts.chatId) continue;
      if (!this.members.get(chatId)?.some((m) => m.user_id === userId)) continue;
      for (const m of list) {
        if (m.recalled || m.msg_type === 'system') continue;
        if (opts.senderId && m.sender_id !== opts.senderId) continue;
        if (opts.sinceIso && m.created_at < opts.sinceIso) continue;
        const c = m.content;
        if ([c.text, c.title, c.markdown, c.file_name].some((v) => typeof v === 'string' && includesCI(v, opts.keyword))) {
          hits.push(m);
        }
      }
    }
    hits.sort((a, b) => b.seq - a.seq);
    return {
      items: hits.slice(opts.offset, opts.offset + opts.limit).map(clone),
      has_more: hits.length > opts.offset + opts.limit,
      total: hits.length,
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
          !e.recurrence &&
          e.end_ms > fromMs &&
          e.start_ms < toMs,
      )
      .sort((a, b) => a.start_ms - b.start_ms)
      .map(clone);
  }

  async listRecurringEvents(userId: string, beforeMs: number) {
    return [...this.events.values()]
      .filter((e) => !!e.recurrence && e.start_ms < beforeMs && (e.created_by === userId || e.attendees.some((a) => a.user_id === userId)))
      .sort((a, b) => a.start_ms - b.start_ms)
      .map(clone);
  }

  async commitEvents(c: EventCommit) {
    // 同步完成检查和写入，中间没有 await，不会和其他请求交错
    if (c.expect) {
      const cur = this.events.get(c.expect.event_id);
      if (!cur || cur.updated_at !== c.expect.updated_at) return false;
    }
    for (const id of c.remove) this.events.delete(id);
    for (const ev of c.save) this.events.set(ev.event_id, clone(ev));
    return true;
  }

  async listEventExceptions(masterId: string) {
    return [...this.events.values()].filter((e) => e.recurring_event_id === masterId).map(clone);
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

  async listSubtasks(parentId: string) {
    return [...this.tasks.values()]
      .filter((t) => t.parent_id === parentId)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id))
      .map(clone);
  }

  async listTasks(userId: string, opts: { assignee_id?: string; status?: string; created_by?: string; follower_id?: string; parent?: string; extra_ids?: string[] }) {
    const extra = new Set(opts.extra_ids ?? []);
    return [...this.tasks.values()]
      .filter((t) => t.created_by === userId || t.assignee_id === userId || (t.follower_ids ?? []).includes(userId) || extra.has(t.task_id))
      .filter((t) => !opts.follower_id || (t.follower_ids ?? []).includes(opts.follower_id))
      .filter((t) => opts.parent === undefined || (opts.parent === 'top' ? !t.parent_id : t.parent_id === opts.parent))
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

  async searchDocs(opts: { keyword: string; sinceIso?: string; limit: number }) {
    return [...this.docs.values()]
      .filter((d) => (includesCI(d.title, opts.keyword) || includesCI(d.markdown, opts.keyword)) && (!opts.sinceIso || d.updated_at >= opts.sinceIso))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.doc_id.localeCompare(b.doc_id))
      .slice(0, opts.limit)
      .map(clone);
  }

  // ---------------- custom tables ----------------

  async insertCustomTable(t: CustomTableRecord) {
    if (await this.findCustomTableByName(t.name)) return 'name_exists' as const;
    this.customTables.set(t.key, clone(t));
    return 'ok' as const;
  }

  async getCustomTable(key: string) {
    const t = this.customTables.get(key);
    return t ? clone(t) : undefined;
  }

  async listCustomTables() {
    return [...this.customTables.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key))
      .map(clone);
  }

  async findCustomTableByName(name: string) {
    const n = name.trim().toLowerCase();
    const t = [...this.customTables.values()].find((x) => x.name.trim().toLowerCase() === n);
    return t ? clone(t) : undefined;
  }

  async findCustomTableByRequest(userId: string, clientRequestId: string, sinceIso: string) {
    const t = [...this.customTables.values()].find(
      (x) => x.created_by === userId && x.client_request_id === clientRequestId && x.created_at >= sinceIso,
    );
    return t ? clone(t) : undefined;
  }

  async deleteCustomTable(key: string) {
    return this.customTables.delete(key);
  }

  async updateCustomTableFields(key: string, fields: CustomFieldRecord[], version: number, updatedAt: string, ifVersion: number) {
    const t = this.customTables.get(key);
    if (!t || (t.version ?? 1) !== ifVersion) return false;
    t.fields = clone(fields);
    t.version = version;
    t.updated_at = updatedAt;
    return true;
  }

  // ---------------- 内置表结构覆盖层 ----------------

  async getTableSchema(key: string) {
    const s = this.tableSchemas.get(key);
    return s ? clone(s) : undefined;
  }

  async saveTableSchema(rec: TableSchemaRecord, ifVersion: number | null) {
    const cur = this.tableSchemas.get(rec.table_key);
    if (ifVersion === null ? !!cur : !cur || cur.version !== ifVersion) return false;
    this.tableSchemas.set(rec.table_key, clone(rec));
    return true;
  }

  // ---------------- 视图 ----------------

  async listViews(tableKey: string) {
    return [...this.views.values()]
      .filter((v) => v.table_key === tableKey)
      .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.view_id.localeCompare(b.view_id))
      .map(clone);
  }

  async getView(viewId: string) {
    const v = this.views.get(viewId);
    return v ? clone(v) : undefined;
  }

  async insertView(v: TableViewRecord) {
    if (this.views.has(v.view_id)) return false;
    this.views.set(v.view_id, clone(v));
    return true;
  }

  async updateView(v: TableViewRecord, ifVersion: number) {
    const cur = this.views.get(v.view_id);
    if (!cur || cur.version !== ifVersion) return false;
    this.views.set(v.view_id, clone(v));
    return true;
  }

  async deleteView(viewId: string) {
    return this.views.delete(viewId);
  }

  async setViewPositions(tableKey: string, positions: Array<{ view_id: string; position: number }>) {
    for (const p of positions) {
      const v = this.views.get(p.view_id);
      if (v && v.table_key === tableKey) v.position = p.position;
    }
  }

  // ---------------- 通知 ----------------

  async insertNotification(n: NotificationRecord) {
    if (n.dedupe_key && this.notifications.some((x) => x.user_id === n.user_id && x.dedupe_key === n.dedupe_key)) return false;
    this.notifications.push(clone(n));
    return true;
  }

  async listNotifications(userId: string, opts: { mentionOnly: boolean; limit: number; offset: number }) {
    // 插入顺序即时间顺序；倒序返回
    const all = this.notifications
      .filter((n) => n.user_id === userId && (!opts.mentionOnly || n.type.endsWith('.mention')))
      .reverse();
    return { items: all.slice(opts.offset, opts.offset + opts.limit).map(clone), total: all.length };
  }

  async countUnreadNotifications(userId: string) {
    return this.notifications.filter((n) => n.user_id === userId && !n.read).length;
  }

  async markNotificationsRead(userId: string, ids: string[] | 'all') {
    const set = ids === 'all' ? undefined : new Set(ids);
    let n = 0;
    for (const x of this.notifications) {
      if (x.user_id !== userId || x.read || (set && !set.has(x.notification_id))) continue;
      x.read = true;
      n++;
    }
    return n;
  }

  async getNotificationSettings(userId: string) {
    const s = this.notificationSettings.get(userId);
    return s ? clone(s) : undefined;
  }

  async saveNotificationSettings(userId: string, s: NotificationSettings) {
    this.notificationSettings.set(userId, clone(s));
  }

  async listTasksDueBetween(fromMs: number, toMs: number) {
    return [...this.tasks.values()]
      .filter(
        (t) =>
          t.assignee_id &&
          t.due_ms != null &&
          t.due_ms >= fromMs &&
          t.due_ms < toMs &&
          (t.status === 'pending' || t.status === 'in_progress'),
      )
      .map(clone);
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
