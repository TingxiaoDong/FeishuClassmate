/**
 * PgRepo：PostgreSQL 持久化实现，表结构见 classmateos/schema-platform.sql。
 * 与 MemoryRepo 语义一致（同一套契约测试）。
 */

import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import type {
  CalendarEventRecord,
  ChatRecord,
  ChatView,
  DeviceRecord,
  DocRecord,
  FileKind,
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

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
};
const isoReq = (v: unknown): string => iso(v) ?? new Date(0).toISOString();
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const USER_COLS = [
  'user_id', 'name', 'email', 'role', 'avatar_url', 'department', 'title', 'phone',
  'status_text', 'password_hash', 'disabled', 'created_at', 'updated_at',
] as const;

function toUser(r: Row): UserRecord {
  return {
    user_id: String(r.user_id),
    name: String(r.name),
    email: (r.email as string) ?? null,
    role: r.role as UserRecord['role'],
    avatar_url: (r.avatar_url as string) ?? null,
    department: (r.department as string) ?? null,
    title: (r.title as string) ?? null,
    phone: (r.phone as string) ?? null,
    status_text: (r.status_text as string) ?? null,
    password_hash: String(r.password_hash),
    disabled: Boolean(r.disabled),
    created_at: isoReq(r.created_at),
    updated_at: isoReq(r.updated_at),
  };
}

function toMessage(r: Row): MessageRecord {
  return {
    message_id: String(r.message_id),
    chat_id: String(r.chat_id),
    sender_id: String(r.sender_id),
    msg_type: String(r.msg_type),
    content: (typeof r.content === 'string' ? JSON.parse(r.content) : r.content) as Record<string, unknown>,
    created_at: isoReq(r.created_at),
    updated_at: iso(r.updated_at),
    recalled: Boolean(r.recalled),
    reply_to_message_id: (r.reply_to_message_id as string) ?? null,
    seq: num(r.seq),
    client_msg_id: (r.client_msg_id as string) ?? null,
    card_id: (r.card_id as string) ?? null,
  };
}

function toChat(r: Row): ChatRecord {
  return {
    chat_id: String(r.chat_id),
    chat_type: r.chat_type as ChatRecord['chat_type'],
    name: (r.name as string) ?? null,
    description: (r.description as string) ?? null,
    owner_id: (r.owner_id as string) ?? null,
    kind: (r.kind as ChatRecord['kind']) ?? 'normal',
    p2p_key: (r.p2p_key as string) ?? null,
    member_ids: (r.member_ids as string[] | null) ?? [],
    created_at: isoReq(r.created_at),
    updated_at: isoReq(r.updated_at),
  };
}

function toFile(r: Row): FileRecord {
  return {
    file_key: String(r.file_key),
    file_name: String(r.file_name),
    size: num(r.size),
    content_type: String(r.content_type),
    kind: r.kind as FileKind,
    uploader_id: String(r.uploader_id),
    created_at: isoReq(r.created_at),
    uploaded_at: iso(r.uploaded_at),
    in_drive: Boolean(r.in_drive),
    drive_added_at: iso(r.drive_added_at),
  };
}

function toEvent(r: Row): CalendarEventRecord {
  return {
    event_id: String(r.event_id),
    title: String(r.title),
    start_ms: num(r.start_ms),
    end_ms: num(r.end_ms),
    attendees: (r.attendees as CalendarEventRecord['attendees']) ?? [],
    description: (r.description as string) ?? null,
    location: (r.location as string) ?? null,
    all_day: Boolean(r.all_day),
    color: (r.color as string) ?? null,
    reminders: (r.reminders as number[] | null) ?? null,
    created_by: String(r.created_by),
    created_at: isoReq(r.created_at),
    updated_at: isoReq(r.updated_at),
  };
}

function toTask(r: Row): TaskRecord {
  return {
    task_id: String(r.task_id),
    title: String(r.title),
    status: r.status as TaskRecord['status'],
    assignee_id: (r.assignee_id as string) ?? null,
    due_ms: numOrNull(r.due_ms),
    description: (r.description as string) ?? null,
    priority: (r.priority as TaskRecord['priority']) ?? 'normal',
    source: (r.source as Record<string, unknown> | null) ?? null,
    created_by: String(r.created_by),
    created_at: isoReq(r.created_at),
    updated_at: isoReq(r.updated_at),
    completed_at: iso(r.completed_at),
  };
}

function toDoc(r: Row): DocRecord {
  return {
    doc_id: String(r.doc_id),
    title: String(r.title),
    markdown: String(r.markdown ?? ''),
    created_by: String(r.created_by),
    created_at: isoReq(r.created_at),
    updated_at: isoReq(r.updated_at),
    updated_by: String(r.updated_by ?? r.created_by),
    yjs_update: (r.yjs_update as string) ?? null,
  };
}

function toDevice(r: Row): DeviceRecord {
  return {
    device_id: String(r.device_id),
    user_id: String(r.user_id),
    platform: r.platform as DeviceRecord['platform'],
    device_token: String(r.device_token),
    created_at: isoReq(r.created_at),
  };
}

const CHAT_SELECT = `
  SELECT c.*, ARRAY(
    SELECT m.user_id FROM cos_chat_members m WHERE m.chat_id = c.chat_id ORDER BY m.joined_at, m.user_id
  ) AS member_ids
  FROM cos_chats c`;

export class PgRepo implements Repo {
  constructor(private readonly pool: Pool) {}

  /** 执行 schema-platform.sql（幂等）。 */
  async init(): Promise<void> {
    const sql = await readFile(new URL('../schema-platform.sql', import.meta.url), 'utf8');
    await this.pool.query(sql);
  }

  private async q(text: string, params: unknown[] = []): Promise<Row[]> {
    const res = await this.pool.query(text, params);
    return res.rows as Row[];
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------- users ----------------

  async listUsers(opts: { keyword?: string; limit: number; offset: number }): Promise<Page<UserRecord>> {
    const kw = opts.keyword?.trim();
    const rows = await this.q(
      `SELECT *, count(*) OVER() AS _total FROM cos_users
       WHERE ($1::text IS NULL OR name ILIKE $1 OR user_id ILIKE $1 OR email ILIKE $1)
       ORDER BY created_at, user_id LIMIT $2 OFFSET $3`,
      [kw ? like(kw) : null, opts.limit, opts.offset],
    );
    const total = rows.length ? num(rows[0]._total) : (await this.countUsers(kw));
    return { items: rows.map(toUser), total };
  }

  private async countUsers(kw?: string): Promise<number> {
    const rows = await this.q(
      `SELECT count(*) AS n FROM cos_users WHERE ($1::text IS NULL OR name ILIKE $1 OR user_id ILIKE $1 OR email ILIKE $1)`,
      [kw ? like(kw) : null],
    );
    return num(rows[0]?.n);
  }

  async getUser(userId: string) {
    const rows = await this.q('SELECT * FROM cos_users WHERE user_id = $1', [userId]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async findUserByLogin(username: string) {
    const rows = await this.q(
      'SELECT * FROM cos_users WHERE user_id = $1 OR name = $1 ORDER BY (user_id = $1) DESC, created_at LIMIT 1',
      [username],
    );
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async insertUserIfMissing(user: UserRecord) {
    const vals = USER_COLS.map((c) => user[c]);
    const rows = await this.q(
      `INSERT INTO cos_users (${USER_COLS.join(', ')}) VALUES (${USER_COLS.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      vals,
    );
    return rows.length > 0;
  }

  async updateUser(userId: string, patch: UserPatch) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return this.getUser(userId);
    const sets = entries.map(([k], i) => `"${k}" = $${i + 2}`).join(', ');
    const rows = await this.q(`UPDATE cos_users SET ${sets} WHERE user_id = $1 RETURNING *`, [
      userId,
      ...entries.map(([, v]) => v),
    ]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  // ---------------- refresh tokens ----------------

  async saveRefreshToken(jti: string, userId: string, expiresAt: string) {
    await this.q('INSERT INTO cos_refresh_tokens (jti, user_id, expires_at) VALUES ($1, $2, $3)', [jti, userId, expiresAt]);
  }

  async consumeRefreshToken(jti: string) {
    const rows = await this.q(
      `UPDATE cos_refresh_tokens SET revoked_at = now()
       WHERE jti = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`,
      [jti],
    );
    return rows[0] ? String(rows[0].user_id) : undefined;
  }

  async revokeRefreshToken(jti: string) {
    await this.q('UPDATE cos_refresh_tokens SET revoked_at = now() WHERE jti = $1 AND revoked_at IS NULL', [jti]);
  }

  // ---------------- chats ----------------

  async createChat(chat: ChatRecord) {
    const created = await this.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO cos_chats (chat_id, chat_type, name, description, owner_id, kind, p2p_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (p2p_key) DO NOTHING RETURNING chat_id`,
        [chat.chat_id, chat.chat_type, chat.name, chat.description, chat.owner_id, chat.kind, chat.p2p_key, chat.created_at, chat.updated_at],
      );
      if (ins.rowCount === 0) return false;
      for (const uid of new Set(chat.member_ids)) {
        await c.query('INSERT INTO cos_chat_members (chat_id, user_id, joined_at) VALUES ($1, $2, $3)', [
          chat.chat_id,
          uid,
          chat.created_at,
        ]);
      }
      return true;
    });
    if (!created) {
      const existing = await this.findChatByP2PKey(chat.p2p_key!);
      return { chat: existing!, created: false };
    }
    return { chat: (await this.getChat(chat.chat_id))!, created: true };
  }

  async getChat(chatId: string) {
    const rows = await this.q(`${CHAT_SELECT} WHERE c.chat_id = $1`, [chatId]);
    return rows[0] ? toChat(rows[0]) : undefined;
  }

  async findChatByP2PKey(key: string) {
    const rows = await this.q(`${CHAT_SELECT} WHERE c.p2p_key = $1`, [key]);
    return rows[0] ? toChat(rows[0]) : undefined;
  }

  async updateChat(chatId: string, patch: { name?: string | null; description?: string | null; kind?: 'normal' | 'drive'; owner_id?: string | null }) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      const sets = entries.map(([k], i) => `"${k}" = $${i + 2}`).join(', ');
      await this.q(`UPDATE cos_chats SET ${sets} WHERE chat_id = $1`, [chatId, ...entries.map(([, v]) => v)]);
    }
    return this.getChat(chatId);
  }

  async addMembers(chatId: string, userIds: string[], at: string) {
    const rows = await this.q(
      `WITH last AS (
         SELECT seq, message_id FROM cos_messages WHERE chat_id = $1 ORDER BY seq DESC LIMIT 1
       )
       INSERT INTO cos_chat_members (chat_id, user_id, joined_at, last_read_seq, last_read_message_id)
       SELECT $1, u, $3, COALESCE((SELECT seq FROM last), 0), (SELECT message_id FROM last)
       FROM unnest($2::text[]) AS u
       ON CONFLICT (chat_id, user_id) DO NOTHING
       RETURNING user_id`,
      [chatId, [...new Set(userIds)], at],
    );
    return rows.map((r) => String(r.user_id));
  }

  async removeMember(chatId: string, userId: string) {
    const rows = await this.q('DELETE FROM cos_chat_members WHERE chat_id = $1 AND user_id = $2 RETURNING user_id', [
      chatId,
      userId,
    ]);
    return rows.length > 0;
  }

  private async views(userId: string, where: string, params: unknown[], limit: number, offset: number) {
    const rows = await this.q(
      `SELECT c.*,
         ARRAY(SELECT x.user_id FROM cos_chat_members x WHERE x.chat_id = c.chat_id ORDER BY x.joined_at, x.user_id) AS member_ids,
         m.last_read_message_id, m.pinned, m.muted,
         (SELECT count(*) FROM cos_messages g
            WHERE g.chat_id = c.chat_id AND g.seq > m.last_read_seq AND g.sender_id <> $1
              AND g.msg_type <> 'system' AND NOT g.recalled) AS unread_count,
         (SELECT to_jsonb(g) FROM cos_messages g WHERE g.chat_id = c.chat_id ORDER BY g.seq DESC LIMIT 1) AS last_message,
         count(*) OVER() AS _total
       FROM cos_chat_members m JOIN cos_chats c ON c.chat_id = m.chat_id
       WHERE m.user_id = $1 ${where}
       ORDER BY c.updated_at DESC, c.chat_id
       LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      [userId, ...params],
    );
    const items: ChatView[] = rows.map((r) => ({
      chat: toChat(r),
      unread_count: num(r.unread_count),
      last_message: r.last_message ? toMessage(r.last_message as Row) : null,
      last_read_message_id: (r.last_read_message_id as string) ?? null,
      pinned: Boolean(r.pinned),
      muted: Boolean(r.muted),
    }));
    return { items, total: rows.length ? num(rows[0]._total) : 0 };
  }

  async listChatViews(userId: string, opts: { limit: number; offset: number }) {
    const page = await this.views(userId, '', [], opts.limit, opts.offset);
    if (page.items.length === 0 && opts.offset > 0) {
      const n = await this.q('SELECT count(*) AS n FROM cos_chat_members WHERE user_id = $1', [userId]);
      page.total = num(n[0]?.n);
    }
    return page;
  }

  async getChatView(chatId: string, userId: string) {
    const page = await this.views(userId, 'AND c.chat_id = $2', [chatId], 1, 0);
    return page.items[0];
  }

  async markRead(chatId: string, userId: string, messageId?: string) {
    const member = await this.q('SELECT last_read_message_id FROM cos_chat_members WHERE chat_id = $1 AND user_id = $2', [
      chatId,
      userId,
    ]);
    if (!member[0]) return undefined;
    const target = messageId
      ? await this.q('SELECT seq, message_id FROM cos_messages WHERE chat_id = $1 AND message_id = $2', [chatId, messageId])
      : await this.q('SELECT seq, message_id FROM cos_messages WHERE chat_id = $1 ORDER BY seq DESC LIMIT 1', [chatId]);
    if (messageId && !target[0]) return undefined;
    const current = (member[0].last_read_message_id as string) ?? null;
    if (!target[0]) return { changed: false, message_id: current };
    const upd = await this.q(
      `UPDATE cos_chat_members SET last_read_seq = $3, last_read_message_id = $4
       WHERE chat_id = $1 AND user_id = $2 AND last_read_seq < $3 RETURNING user_id`,
      [chatId, userId, target[0].seq, target[0].message_id],
    );
    return upd.length > 0
      ? { changed: true, message_id: String(target[0].message_id) }
      : { changed: false, message_id: current };
  }

  async updateMemberSettings(chatId: string, userId: string, patch: { pinned?: boolean; muted?: boolean }) {
    await this.q(
      `UPDATE cos_chat_members SET pinned = COALESCE($3, pinned), muted = COALESCE($4, muted)
       WHERE chat_id = $1 AND user_id = $2`,
      [chatId, userId, patch.pinned ?? null, patch.muted ?? null],
    );
  }

  // ---------------- messages ----------------

  async insertMessage(m: NewMessage) {
    const rows = await this.q(
      `WITH ins AS (
         INSERT INTO cos_messages (message_id, chat_id, sender_id, msg_type, content, created_at,
                                   reply_to_message_id, client_msg_id, card_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
         ON CONFLICT (chat_id, sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL DO NOTHING
         RETURNING *
       ), upd AS (
         UPDATE cos_chats SET updated_at = GREATEST(updated_at, $6::timestamptz)
         WHERE chat_id = $2 AND EXISTS (SELECT 1 FROM ins)
       )
       SELECT * FROM ins`,
      [m.message_id, m.chat_id, m.sender_id, m.msg_type, JSON.stringify(m.content), m.created_at,
        m.reply_to_message_id, m.client_msg_id, m.card_id],
    );
    if (rows[0]) return { message: toMessage(rows[0]), duplicate: false };
    const dup = await this.q(
      'SELECT * FROM cos_messages WHERE chat_id = $1 AND sender_id = $2 AND client_msg_id = $3',
      [m.chat_id, m.sender_id, m.client_msg_id],
    );
    return { message: toMessage(dup[0]), duplicate: true };
  }

  async getMessage(messageId: string) {
    const rows = await this.q('SELECT * FROM cos_messages WHERE message_id = $1', [messageId]);
    return rows[0] ? toMessage(rows[0]) : undefined;
  }

  async listMessages(chatId: string, opts: { limit: number; beforeId?: string; afterId?: string }) {
    const cursorId = opts.afterId ?? opts.beforeId;
    let cursorSeq: number | undefined;
    if (cursorId) {
      const c = await this.q('SELECT seq FROM cos_messages WHERE chat_id = $1 AND message_id = $2', [chatId, cursorId]);
      if (!c[0]) return undefined;
      cursorSeq = num(c[0].seq);
    }
    const lim = opts.limit + 1;
    let rows: Row[];
    if (opts.afterId) {
      rows = await this.q('SELECT * FROM cos_messages WHERE chat_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3', [
        chatId,
        cursorSeq,
        lim,
      ]);
    } else if (opts.beforeId) {
      rows = await this.q('SELECT * FROM cos_messages WHERE chat_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3', [
        chatId,
        cursorSeq,
        lim,
      ]);
    } else {
      rows = await this.q('SELECT * FROM cos_messages WHERE chat_id = $1 ORDER BY seq DESC LIMIT $2', [chatId, lim]);
    }
    return { items: rows.slice(0, opts.limit).map(toMessage), has_more: rows.length > opts.limit };
  }

  async findMessageByCardId(cardId: string) {
    const rows = await this.q('SELECT * FROM cos_messages WHERE card_id = $1 ORDER BY seq DESC LIMIT 1', [cardId]);
    return rows[0] ? toMessage(rows[0]) : undefined;
  }

  async answerCard(messageId: string, answer: Record<string, unknown>, at: string) {
    const rows = await this.q(
      `UPDATE cos_messages SET content = jsonb_set(content, '{answer}', $2::jsonb, true), updated_at = $3
       WHERE message_id = $1
         AND (content->'answer' IS NULL OR content->'answer' = 'null'::jsonb)
         AND (content->>'expired') IS DISTINCT FROM 'true'
       RETURNING *`,
      [messageId, JSON.stringify(answer), at],
    );
    return rows[0] ? toMessage(rows[0]) : undefined;
  }

  async updateMessage(messageId: string, patch: { content?: Record<string, unknown>; recalled?: boolean; updated_at: string }) {
    const rows = await this.q(
      `UPDATE cos_messages SET content = COALESCE($2::jsonb, content), recalled = COALESCE($3, recalled), updated_at = $4
       WHERE message_id = $1 RETURNING *`,
      [messageId, patch.content === undefined ? null : JSON.stringify(patch.content), patch.recalled ?? null, patch.updated_at],
    );
    return rows[0] ? toMessage(rows[0]) : undefined;
  }

  async searchMessages(userId: string, opts: { keyword: string; chatId?: string; limit: number; offset: number }) {
    const rows = await this.q(
      `SELECT g.* FROM cos_messages g
       JOIN cos_chat_members m ON m.chat_id = g.chat_id AND m.user_id = $1
       WHERE NOT g.recalled AND g.msg_type <> 'system'
         AND ($3::text IS NULL OR g.chat_id = $3)
         AND (g.content->>'text' ILIKE $2 OR g.content->>'title' ILIKE $2 OR g.content->>'file_name' ILIKE $2)
       ORDER BY g.seq DESC LIMIT $4 OFFSET $5`,
      [userId, like(opts.keyword), opts.chatId ?? null, opts.limit + 1, opts.offset],
    );
    return { items: rows.slice(0, opts.limit).map(toMessage), has_more: rows.length > opts.limit };
  }

  // ---------------- files ----------------

  async createFile(f: FileRecord) {
    await this.q(
      `INSERT INTO cos_files (file_key, file_name, size, content_type, kind, uploader_id, created_at, uploaded_at, in_drive, drive_added_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [f.file_key, f.file_name, f.size, f.content_type, f.kind, f.uploader_id, f.created_at, f.uploaded_at, f.in_drive, f.drive_added_at],
    );
  }

  async getFile(fileKey: string) {
    const rows = await this.q('SELECT * FROM cos_files WHERE file_key = $1', [fileKey]);
    return rows[0] ? toFile(rows[0]) : undefined;
  }

  async markFileUploaded(fileKey: string, size: number, at: string) {
    await this.q('UPDATE cos_files SET size = $2, uploaded_at = $3 WHERE file_key = $1', [fileKey, size, at]);
  }

  async setFileDrive(fileKey: string, inDrive: boolean, at: string) {
    await this.q(
      `UPDATE cos_files SET in_drive = $2,
         drive_added_at = CASE WHEN $2 THEN COALESCE(drive_added_at, $3::timestamptz) ELSE NULL END
       WHERE file_key = $1`,
      [fileKey, inDrive, at],
    );
  }

  async addFileLink(l: FileLink) {
    await this.q(
      `INSERT INTO cos_file_links (file_key, source_type, chat_id, message_id, table_key, record_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [l.file_key, l.source_type, l.chat_id, l.message_id, l.table_key, l.record_id, l.created_at],
    );
  }

  async listFileLinks(fileKey: string) {
    const rows = await this.q('SELECT * FROM cos_file_links WHERE file_key = $1 ORDER BY id', [fileKey]);
    return rows.map((r) => ({
      file_key: String(r.file_key),
      source_type: r.source_type as FileLink['source_type'],
      chat_id: (r.chat_id as string) ?? null,
      message_id: (r.message_id as string) ?? null,
      table_key: (r.table_key as string) ?? null,
      record_id: (r.record_id as string) ?? null,
      created_at: isoReq(r.created_at),
    }));
  }

  async deleteFile(fileKey: string) {
    await this.q('DELETE FROM cos_files WHERE file_key = $1', [fileKey]);
  }

  async listFiles(
    userId: string,
    opts: { scope: 'all' | 'mine' | 'shared'; kind?: FileKind; keyword?: string; limit: number; offset: number },
  ) {
    const parts: string[] = [];
    if (opts.scope !== 'shared') {
      parts.push(`SELECT f.*, 'drive' AS src_type, NULL::text AS src_chat, NULL::text AS src_msg,
                         f.drive_added_at AS linked_at, 0 AS pri
                  FROM cos_files f WHERE f.uploader_id = $1 AND f.in_drive AND f.uploaded_at IS NOT NULL`);
    }
    if (opts.scope !== 'mine') {
      parts.push(`SELECT f.*, 'chat' AS src_type, l.chat_id AS src_chat, l.message_id AS src_msg,
                         l.created_at AS linked_at, 1 AS pri
                  FROM cos_file_links l
                  JOIN cos_files f ON f.file_key = l.file_key AND f.uploaded_at IS NOT NULL
                  JOIN cos_chats c ON c.chat_id = l.chat_id AND c.kind <> 'drive'
                  JOIN cos_chat_members m ON m.chat_id = l.chat_id AND m.user_id = $1
                  WHERE l.source_type = 'chat'`);
    }
    const kw = opts.keyword?.trim();
    const rows = await this.q(
      `WITH visible AS (${parts.join(' UNION ALL ')}),
       dedup AS (SELECT DISTINCT ON (file_key) * FROM visible ORDER BY file_key, pri, linked_at DESC)
       SELECT *, count(*) OVER() AS _total FROM dedup
       WHERE ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR file_name ILIKE $3)
       ORDER BY created_at DESC, file_key LIMIT $4 OFFSET $5`,
      [userId, opts.kind ?? null, kw ? like(kw) : null, opts.limit, opts.offset],
    );
    const items: FileListEntry[] = rows.map((r) => ({
      file: toFile(r),
      source:
        r.src_type === 'drive'
          ? { type: 'drive' }
          : { type: 'chat', chat_id: String(r.src_chat), message_id: (r.src_msg as string) ?? undefined },
    }));
    let total = rows.length ? num(rows[0]._total) : 0;
    if (!rows.length && opts.offset > 0) {
      total = (await this.listFiles(userId, { ...opts, limit: 1, offset: 0 })).total;
    }
    return { items, total };
  }

  async fileUsage(userId: string) {
    const rows = await this.q(
      'SELECT COALESCE(sum(size), 0) AS used FROM cos_files WHERE uploader_id = $1 AND uploaded_at IS NOT NULL',
      [userId],
    );
    return num(rows[0]?.used);
  }

  // ---------------- calendar ----------------

  async saveEvent(ev: CalendarEventRecord) {
    await this.q(
      `INSERT INTO cos_calendar_events (event_id, title, start_ms, end_ms, attendees, description, location, all_day,
                                        color, reminders, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
       ON CONFLICT (event_id) DO UPDATE SET
         title = EXCLUDED.title, start_ms = EXCLUDED.start_ms, end_ms = EXCLUDED.end_ms,
         attendees = EXCLUDED.attendees, description = EXCLUDED.description, location = EXCLUDED.location,
         all_day = EXCLUDED.all_day, color = EXCLUDED.color, reminders = EXCLUDED.reminders,
         updated_at = EXCLUDED.updated_at`,
      [ev.event_id, ev.title, ev.start_ms, ev.end_ms, JSON.stringify(ev.attendees), ev.description, ev.location,
        ev.all_day, ev.color, ev.reminders == null ? null : JSON.stringify(ev.reminders), ev.created_by,
        ev.created_at, ev.updated_at],
    );
  }

  async getEvent(eventId: string) {
    const rows = await this.q('SELECT * FROM cos_calendar_events WHERE event_id = $1', [eventId]);
    return rows[0] ? toEvent(rows[0]) : undefined;
  }

  async deleteEvent(eventId: string) {
    return (await this.q('DELETE FROM cos_calendar_events WHERE event_id = $1 RETURNING event_id', [eventId])).length > 0;
  }

  async listEvents(userId: string, fromMs: number, toMs: number) {
    const rows = await this.q(
      `SELECT * FROM cos_calendar_events
       WHERE (created_by = $1 OR attendees @> $2::jsonb) AND end_ms > $3 AND start_ms < $4
       ORDER BY start_ms, event_id`,
      [userId, JSON.stringify([{ user_id: userId }]), fromMs, toMs],
    );
    return rows.map(toEvent);
  }

  // ---------------- tasks ----------------

  async saveTask(t: TaskRecord) {
    await this.q(
      `INSERT INTO cos_tasks (task_id, title, status, assignee_id, due_ms, description, priority, source,
                              created_by, created_at, updated_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       ON CONFLICT (task_id) DO UPDATE SET
         title = EXCLUDED.title, status = EXCLUDED.status, assignee_id = EXCLUDED.assignee_id,
         due_ms = EXCLUDED.due_ms, description = EXCLUDED.description, priority = EXCLUDED.priority,
         source = EXCLUDED.source, updated_at = EXCLUDED.updated_at, completed_at = EXCLUDED.completed_at`,
      [t.task_id, t.title, t.status, t.assignee_id, t.due_ms, t.description, t.priority,
        t.source == null ? null : JSON.stringify(t.source), t.created_by, t.created_at, t.updated_at, t.completed_at],
    );
  }

  async getTask(taskId: string) {
    const rows = await this.q('SELECT * FROM cos_tasks WHERE task_id = $1', [taskId]);
    return rows[0] ? toTask(rows[0]) : undefined;
  }

  async deleteTask(taskId: string) {
    return (await this.q('DELETE FROM cos_tasks WHERE task_id = $1 RETURNING task_id', [taskId])).length > 0;
  }

  async listTasks(userId: string, opts: { assignee_id?: string; status?: string; created_by?: string }) {
    const rows = await this.q(
      `SELECT * FROM cos_tasks
       WHERE (created_by = $1 OR assignee_id = $1)
         AND ($2::text IS NULL OR assignee_id = $2)
         AND ($3::text IS NULL OR status = $3)
         AND ($4::text IS NULL OR created_by = $4)
       ORDER BY created_at, task_id`,
      [userId, opts.assignee_id ?? null, opts.status ?? null, opts.created_by ?? null],
    );
    return rows.map(toTask);
  }

  // ---------------- docs ----------------

  async createDoc(d: DocRecord) {
    await this.q(
      `INSERT INTO cos_docs (doc_id, title, markdown, created_by, created_at, updated_at, updated_by, yjs_update)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [d.doc_id, d.title, d.markdown, d.created_by, d.created_at, d.updated_at, d.updated_by, d.yjs_update],
    );
  }

  async getDoc(docId: string) {
    const rows = await this.q('SELECT * FROM cos_docs WHERE doc_id = $1', [docId]);
    return rows[0] ? toDoc(rows[0]) : undefined;
  }

  async updateDoc(d: DocRecord, ifUpdatedAt?: string) {
    const rows = await this.q(
      `UPDATE cos_docs SET title = $2, markdown = $3, updated_at = $4, updated_by = $5, yjs_update = $6
       WHERE doc_id = $1 AND ($7::timestamptz IS NULL OR updated_at = $7::timestamptz) RETURNING doc_id`,
      [d.doc_id, d.title, d.markdown, d.updated_at, d.updated_by, d.yjs_update, ifUpdatedAt ?? null],
    );
    return rows.length > 0;
  }

  async deleteDoc(docId: string) {
    return (await this.q('DELETE FROM cos_docs WHERE doc_id = $1 RETURNING doc_id', [docId])).length > 0;
  }

  async listDocs(opts: { userId: string; scope: 'all' | 'mine' | 'shared'; keyword?: string; limit: number; offset: number }) {
    const kw = opts.keyword?.trim();
    const rows = await this.q(
      `SELECT doc_id, title, left(markdown, 400) AS markdown, created_by, created_at, updated_at, updated_by,
              NULL AS yjs_update, count(*) OVER() AS _total
       FROM cos_docs
       WHERE ($2 = 'all' OR ($2 = 'mine' AND created_by = $1) OR ($2 = 'shared' AND created_by <> $1))
         AND ($3::text IS NULL OR title ILIKE $3)
       ORDER BY updated_at DESC, doc_id LIMIT $4 OFFSET $5`,
      [opts.userId, opts.scope, kw ? like(kw) : null, opts.limit, opts.offset],
    );
    return { items: rows.map(toDoc), total: rows.length ? num(rows[0]._total) : 0 };
  }

  // ---------------- devices ----------------

  async upsertDevice(d: DeviceRecord) {
    const rows = await this.q(
      `INSERT INTO cos_devices (device_id, user_id, platform, device_token, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (device_token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform
       RETURNING *`,
      [d.device_id, d.user_id, d.platform, d.device_token, d.created_at],
    );
    return toDevice(rows[0]);
  }

  async getDevice(deviceId: string) {
    const rows = await this.q('SELECT * FROM cos_devices WHERE device_id = $1', [deviceId]);
    return rows[0] ? toDevice(rows[0]) : undefined;
  }

  async deleteDevice(deviceId: string) {
    await this.q('DELETE FROM cos_devices WHERE device_id = $1', [deviceId]);
  }

  async listDevices(userIds: string[]) {
    if (userIds.length === 0) return [];
    const rows = await this.q('SELECT * FROM cos_devices WHERE user_id = ANY($1::text[])', [userIds]);
    return rows.map(toDevice);
  }
}
