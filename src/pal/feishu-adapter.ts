/**
 * FeishuAdapter — PAL over the existing FeishuClient (PLAN §2.3 保底线).
 *
 * Used during 灰度双跑: skills/tools can move to PAL calls while the channel
 * is still Feishu. Doc/Drive/Calendar throw PalUnimplementedError (P1 scope).
 */

import type { ClassmateConfig } from '../config.js';
import type { FeishuClient } from '../util/feishu-api.js';
import { getFeishuClient } from '../util/feishu-api.js';
import type {
  AuthProvider,
  CalendarService,
  DocService,
  DriveService,
  ImService,
  PalMessage,
  PalRecord,
  PalResult,
  PlatformAdapter,
  TableService,
} from './types.js';
import { PalUnimplementedError } from './types.js';

type TableKey = keyof ClassmateConfig['bitable']['tableIds'];

class FeishuIm implements ImService {
  constructor(private readonly client: FeishuClient) {}

  async sendMessage(params: Parameters<ImService['sendMessage']>[0]): Promise<PalResult<PalMessage>> {
    if (params.msgType !== 'text') {
      return { ok: false, error: `FeishuAdapter.sendMessage only supports text in P0 (got ${params.msgType})` };
    }
    const text = String(params.content.text ?? '');
    return this.sendText(params.receiveId, text, params.receiveIdType);
  }

  async sendText(
    receiveId: string,
    text: string,
    receiveIdType: 'chat_id' | 'user_id' = 'chat_id',
  ): Promise<PalResult<PalMessage>> {
    const res = await this.client.sendText({
      receive_id: receiveId,
      receive_id_type: receiveIdType === 'user_id' ? 'open_id' : 'chat_id',
      text,
    });
    if (!res.ok) return res;
    return {
      ok: true,
      value: {
        messageId: res.value.message_id,
        chatId: receiveIdType === 'chat_id' ? receiveId : '',
        senderId: 'bot',
        msgType: 'text',
        content: { text },
        createdAtMs: Date.now(),
      },
    };
  }

  async askUser(): Promise<PalResult<{ answer: string; timedOut: boolean }>> {
    // 飞书通道的 ask_user_question 由 openclaw-lark 通道层提供，
    // P0 阶段不经过 PAL（见 PLAN §0.3 — IM 交互确认走通道原生能力）。
    return { ok: false, error: 'askUser goes through the channel layer in P0, not PAL' };
  }
}

class FeishuTable implements TableService {
  constructor(
    private readonly client: FeishuClient,
    private readonly cfg: ClassmateConfig,
  ) {}

  private tableId(tableKey: string): string | undefined {
    return this.cfg.bitable.tableIds?.[tableKey as TableKey];
  }

  private noTable(tableKey: string): PalResult<never> {
    return { ok: false, error: `tableId not configured for key "${tableKey}" — run setup-bitable` };
  }

  async listRecords(params: Parameters<TableService['listRecords']>[0]) {
    const tableId = this.tableId(params.tableKey);
    if (!tableId) return this.noTable(params.tableKey);
    const res = await this.client.listRecords(this.cfg.bitable.appToken, tableId, {
      filter: params.filter,
      sort: params.sort,
      pageSize: params.pageSize,
    });
    if (!res.ok) return res;
    const records: PalRecord[] = res.value.map((r) => ({ recordId: r.record_id, fields: r.fields }));
    // FeishuClient.listRecords 不暴露 page_token；P0 单页足够（pageSize<=500）。
    return { ok: true as const, value: { records, hasMore: false } };
  }

  async createRecord(tableKey: string, fields: Record<string, unknown>) {
    const tableId = this.tableId(tableKey);
    if (!tableId) return this.noTable(tableKey);
    const res = await this.client.createRecord(this.cfg.bitable.appToken, tableId, fields);
    if (!res.ok) return res;
    return { ok: true as const, value: { recordId: res.value.record_id, fields } };
  }

  async updateRecord(tableKey: string, recordId: string, fields: Record<string, unknown>) {
    const tableId = this.tableId(tableKey);
    if (!tableId) return this.noTable(tableKey);
    const res = await this.client.updateRecord(this.cfg.bitable.appToken, tableId, recordId, fields);
    if (!res.ok) return res;
    return { ok: true as const, value: { recordId, fields } };
  }

  async deleteRecord(): Promise<PalResult<void>> {
    return { ok: false, error: 'FeishuAdapter.deleteRecord not wired in P0 (tools use lark raw tools)' };
  }
}

function unimplemented<T extends object>(capability: string): T {
  const thrower = () => {
    throw new PalUnimplementedError(capability, 'feishu');
  };
  return new Proxy({} as Record<string, unknown>, {
    get: () => thrower,
  }) as T;
}

export function createFeishuAdapter(cfg: ClassmateConfig): PlatformAdapter {
  const client = getFeishuClient(cfg);
  return {
    id: 'feishu',
    auth: unimplemented<AuthProvider>('auth'),
    im: new FeishuIm(client),
    table: new FeishuTable(client, cfg),
    doc: unimplemented<DocService>('doc'),
    drive: unimplemented<DriveService>('drive'),
    calendar: unimplemented<CalendarService>('calendar'),
  };
}
