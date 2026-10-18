/**
 * ClassmateOSAdapter — PAL over the self-hosted platform REST API
 * (classmateos/openapi.yaml, PLAN §2.3 目标线).
 *
 * Pure fetch client; no new dependencies. Bot 网关消息发送走
 * POST /bot/messages（X-Bot-Token），其余走用户态 bearer。
 */

import type {
  AuthProvider,
  CalendarService,
  DocService,
  DriveService,
  ImService,
  PalMessage,
  PalRecord,
  PalResult,
  PalUser,
  PlatformAdapter,
  TableService,
} from './types.js';
import { PalUnimplementedError } from './types.js';

export interface ClassmateOSAdapterOptions {
  /** e.g. http://localhost:8080/api/v1 */
  baseUrl: string;
  /** 用户态 JWT（auth/table/files）。 */
  accessToken?: string;
  /** Bot 令牌（/bot/* 端点，X-Bot-Token）。 */
  botToken?: string;
  timeoutMs?: number;
}

class Http {
  constructor(private readonly opts: ClassmateOSAdapterOptions) {}

  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    auth: 'user' | 'bot' | 'none' = 'user',
  ): Promise<PalResult<T>> {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth === 'user' && this.opts.accessToken) headers.Authorization = `Bearer ${this.opts.accessToken}`;
    if (auth === 'bot' && this.opts.botToken) headers['X-Bot-Token'] = this.opts.botToken;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.status === 204) return { ok: true, value: undefined as T };
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data as { message?: string; error?: string }).message
          ?? (data as { error?: string }).error
          ?? `HTTP ${res.status}`;
        return { ok: false, error: msg, code: res.status };
      }
      return { ok: true, value: data as T };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function toMessage(raw: Record<string, unknown>): PalMessage {
  return {
    messageId: String(raw.message_id ?? ''),
    chatId: String(raw.chat_id ?? ''),
    senderId: String(raw.sender_id ?? ''),
    msgType: (raw.msg_type as PalMessage['msgType']) ?? 'text',
    content: (raw.content as Record<string, unknown>) ?? {},
    createdAtMs: raw.created_at ? Date.parse(String(raw.created_at)) : Date.now(),
  };
}

class CosAuth implements AuthProvider {
  constructor(private readonly http: Http) {}
  async getCurrentUser(): Promise<PalResult<PalUser>> {
    const res = await this.http.call<Record<string, unknown>>('GET', '/users/me');
    if (!res.ok) return res;
    return { ok: true, value: toUser(res.value) };
  }
  async listUsers(keyword?: string): Promise<PalResult<PalUser[]>> {
    const q = keyword ? `?keyword=${encodeURIComponent(keyword)}` : '';
    const res = await this.http.call<{ items?: Array<Record<string, unknown>> }>('GET', `/users${q}`);
    if (!res.ok) return res;
    return { ok: true, value: (res.value.items ?? []).map(toUser) };
  }
}

function toUser(raw: Record<string, unknown>): PalUser {
  return {
    userId: String(raw.user_id ?? ''),
    name: String(raw.name ?? ''),
    email: raw.email ? String(raw.email) : undefined,
    role: raw.role as PalUser['role'],
  };
}

class CosIm implements ImService {
  constructor(private readonly http: Http) {}

  async sendMessage(params: Parameters<ImService['sendMessage']>[0]): Promise<PalResult<PalMessage>> {
    const res = await this.http.call<Record<string, unknown>>(
      'POST',
      '/bot/messages',
      {
        receive_id: params.receiveId,
        receive_id_type: params.receiveIdType,
        msg_type: params.msgType,
        content: params.content,
        reply_to: params.replyTo,
      },
      'bot',
    );
    if (!res.ok) return res;
    return { ok: true, value: toMessage(res.value) };
  }

  async sendText(receiveId: string, text: string, receiveIdType: 'chat_id' | 'user_id' = 'chat_id') {
    return this.sendMessage({
      receiveId,
      receiveIdType,
      msgType: 'text',
      content: { text },
    });
  }

  async askUser(params: Parameters<ImService['askUser']>[0]) {
    // P1：发卡片后经 /cards/{id}/actions + WS 事件回流。P0 先发卡不等回答。
    const res = await this.sendMessage({
      receiveId: params.userId,
      receiveIdType: 'user_id',
      msgType: 'interactive_card',
      content: {
        question: params.question,
        options: params.options ?? [],
      },
    });
    if (!res.ok) return res;
    return { ok: true, value: { answer: '', timedOut: true } };
  }
}

class CosTable implements TableService {
  constructor(private readonly http: Http) {}

  async listRecords(params: Parameters<TableService['listRecords']>[0]) {
    const q = new URLSearchParams();
    if (params.filter) q.set('filter', params.filter);
    if (params.sort) q.set('sort', params.sort);
    if (params.pageSize) q.set('page_size', String(params.pageSize));
    if (params.pageToken) q.set('page_token', params.pageToken);
    const qs = q.toString() ? `?${q}` : '';
    const res = await this.http.call<{
      items?: Array<{ record_id: string; fields: Record<string, unknown> }>;
      has_more?: boolean;
      page_token?: string;
    }>('GET', `/tables/${encodeURIComponent(params.tableKey)}/records${qs}`);
    if (!res.ok) return res;
    const records: PalRecord[] = (res.value.items ?? []).map((r) => ({
      recordId: r.record_id,
      fields: r.fields ?? {},
    }));
    return {
      ok: true as const,
      value: { records, hasMore: res.value.has_more ?? false, pageToken: res.value.page_token },
    };
  }

  async createRecord(tableKey: string, fields: Record<string, unknown>) {
    const res = await this.http.call<{ record_id: string; fields: Record<string, unknown> }>(
      'POST',
      `/tables/${encodeURIComponent(tableKey)}/records`,
      { fields },
    );
    if (!res.ok) return res;
    return { ok: true as const, value: { recordId: res.value.record_id, fields: res.value.fields } };
  }

  async updateRecord(tableKey: string, recordId: string, fields: Record<string, unknown>) {
    const res = await this.http.call<{ record_id: string; fields: Record<string, unknown> }>(
      'PATCH',
      `/tables/${encodeURIComponent(tableKey)}/records/${encodeURIComponent(recordId)}`,
      { fields },
    );
    if (!res.ok) return res;
    return { ok: true as const, value: { recordId: res.value.record_id, fields: res.value.fields } };
  }

  async deleteRecord(tableKey: string, recordId: string): Promise<PalResult<void>> {
    return this.http.call<void>(
      'DELETE',
      `/tables/${encodeURIComponent(tableKey)}/records/${encodeURIComponent(recordId)}`,
    );
  }
}

function unimplemented<T extends object>(capability: string): T {
  const thrower = () => {
    throw new PalUnimplementedError(capability, 'classmateos');
  };
  return new Proxy({} as Record<string, unknown>, { get: () => thrower }) as T;
}

export function createClassmateOSAdapter(opts: ClassmateOSAdapterOptions): PlatformAdapter {
  const http = new Http(opts);
  return {
    id: 'classmateos',
    auth: new CosAuth(http),
    im: new CosIm(http),
    table: new CosTable(http),
    doc: unimplemented<DocService>('doc'),
    drive: unimplemented<DriveService>('drive'),
    calendar: unimplemented<CalendarService>('calendar'),
  };
}
