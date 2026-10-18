/**
 * PAL tests: ClassmateOSAdapter wire format against a local HTTP server
 * (冒充 classmateos/openapi.yaml 实现)，FeishuAdapter 的表 key→tableId 映射。
 */

import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClassmateOSAdapter } from '../../src/pal/classmateos-adapter.js';
import { createFeishuAdapter } from '../../src/pal/feishu-adapter.js';
import { PalUnimplementedError } from '../../src/pal/types.js';
import { createFakeConfig } from '../helpers/fake-config.js';

interface Received {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  body: unknown;
}

async function withMockPlatform(
  handler: (req: Received, respond: (status: number, body: unknown) => void) => void,
  fn: (baseUrl: string, received: Received[]) => Promise<void>,
): Promise<void> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const respond = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const rec: Received = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as Record<string, unknown>,
        body: raw ? JSON.parse(raw) : null,
      };
      received.push(rec);
      handler(rec, respond);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}/api/v1`, received);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('ClassmateOSAdapter', () => {
  it('bot sendText hits /bot/messages with X-Bot-Token', async () => {
    await withMockPlatform(
      (req, respond) => {
        expect(req.url).toBe('/api/v1/bot/messages');
        respond(201, {
          message_id: 'm1',
          chat_id: 'chat_9',
          sender_id: 'bot',
          msg_type: 'text',
          content: { text: '你好' },
          created_at: '2026-10-19T00:00:00Z',
        });
      },
      async (baseUrl, received) => {
        const pal = createClassmateOSAdapter({ baseUrl, botToken: 'btok' });
        const res = await pal.im.sendText('chat_9', '你好');
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value.messageId).toBe('m1');
          expect(res.value.chatId).toBe('chat_9');
        }
        expect(received[0].headers['x-bot-token']).toBe('btok');
        expect(received[0].body).toMatchObject({
          receive_id: 'chat_9',
          receive_id_type: 'chat_id',
          msg_type: 'text',
        });
      },
    );
  });

  it('table CRUD maps to /tables/{key}/records with bearer auth', async () => {
    await withMockPlatform(
      (req, respond) => {
        if (req.method === 'POST') {
          respond(201, { record_id: 'rec_1', fields: { title: 'T' } });
        } else if (req.method === 'PATCH') {
          respond(200, { record_id: 'rec_1', fields: { title: 'T2' } });
        } else if (req.method === 'GET') {
          respond(200, {
            items: [{ record_id: 'rec_1', fields: { title: 'T2' } }],
            has_more: false,
          });
        } else {
          respond(204, undefined);
        }
      },
      async (baseUrl, received) => {
        const pal = createClassmateOSAdapter({ baseUrl, accessToken: 'jwt' });

        const created = await pal.table.createRecord('projects', { title: 'T' });
        expect(created.ok && created.value.recordId).toBe('rec_1');

        const updated = await pal.table.updateRecord('projects', 'rec_1', { title: 'T2' });
        expect(updated.ok && updated.value.fields.title).toBe('T2');

        const listed = await pal.table.listRecords({ tableKey: 'projects', filter: 'status="进行中"' });
        expect(listed.ok && listed.value.records).toHaveLength(1);

        const del = await pal.table.deleteRecord('projects', 'rec_1');
        expect(del.ok).toBe(true);

        expect(received.map((r) => `${r.method} ${r.url}`)).toEqual([
          'POST /api/v1/tables/projects/records',
          'PATCH /api/v1/tables/projects/records/rec_1',
          'GET /api/v1/tables/projects/records?filter=status%3D%22%E8%BF%9B%E8%A1%8C%E4%B8%AD%22',
          'DELETE /api/v1/tables/projects/records/rec_1',
        ]);
        expect(received[0].headers.authorization).toBe('Bearer jwt');
      },
    );
  });

  it('surfaces platform errors as PalResult errors', async () => {
    await withMockPlatform(
      (_req, respond) => respond(422, { message: '字段校验失败' }),
      async (baseUrl) => {
        const pal = createClassmateOSAdapter({ baseUrl, accessToken: 'jwt' });
        const res = await pal.table.createRecord('projects', { bad: 1 });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error).toBe('字段校验失败');
          expect(res.code).toBe(422);
        }
      },
    );
  });
});

describe('FeishuAdapter', () => {
  it('maps tableKey → configured tableId; unconfigured key is a clean error', async () => {
    const cfg = createFakeConfig();
    const pal = createFeishuAdapter(cfg);
    expect(pal.id).toBe('feishu');
    const res = await pal.table.listRecords({ tableKey: 'nonexistent_table' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/tableId not configured/);
  });

  it('P1 capability groups throw PalUnimplementedError', () => {
    const pal = createFeishuAdapter(createFakeConfig());
    expect(() => pal.doc.createDocument).toBeDefined();
    expect(() => (pal.doc as { createDocument: unknown }).createDocument()).toThrow(
      PalUnimplementedError,
    );
  });
});
