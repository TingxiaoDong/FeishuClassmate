/**
 * P4 迁移测试：fake reader（冒充飞书）→ 真 Fastify server（经 PAL adapter）
 * 验证端到端迁移、校验失败隔离、dry-run、未配置表跳过。
 */

import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import { migrateTables, formatReport, type BitableReader } from '../../classmateos/server/migrate.js';
import { createClassmateOSAdapter } from '../../src/pal/classmateos-adapter.js';
import { createFakeConfig } from '../helpers/fake-config.js';

const READER_DATA: Record<string, Array<{ record_id: string; fields: Record<string, unknown> }>> = {
  tbl_projects: [
    { record_id: 'rec_src_1', fields: { title: 'Alpha', status: '进行中' } },
    { record_id: 'rec_src_2', fields: { title: 'Beta', status: '完成' } },
    // 一条非法记录（单选越界）——应隔离为单条失败，不中断整表
    { record_id: 'rec_src_3', fields: { title: 'Gamma', status: '不存在' } },
  ],
  tbl_gantt: [{ record_id: 'rec_src_g1', fields: { milestone: 'M1', progress: 50 } }],
  tbl_equipment: [],
  tbl_research: [],
  tbl_tool_trace: [],
};

function fakeReader(): BitableReader {
  return {
    async listRecords(_appToken, tableId) {
      return { ok: true, value: READER_DATA[tableId] ?? [] };
    },
  };
}

async function setup() {
  const app = buildApp({
    users: [{ user_id: 'ou_admin', name: 'admin', password: 'pw', role: 'admin' }],
    secret: 's',
    botToken: 'b',
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'admin', password: 'pw' },
  });
  const token = login.json().access_token as string;
  const writer = createClassmateOSAdapter({
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    accessToken: token,
  }).table;
  const cfg = createFakeConfig();
  return { app, writer, cfg, token };
}

describe('migrateTables (P4)', () => {
  it('端到端迁移：成功记录写入平台并可回读，非法记录隔离为失败', async () => {
    const { app, writer, cfg, token } = await setup();
    const reports = await migrateTables({
      config: cfg,
      reader: fakeReader(),
      writer,
      tableKeys: ['projects'],
    });

    const r = reports[0];
    expect(r.sourceCount).toBe(3);
    expect(r.migrated).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toContain('rec_src_3');

    // 回读验证：feishu_record_id 溯源字段落库
    const back = await app.inject({
      method: 'GET',
      url: '/api/v1/tables/projects/records',
      headers: { authorization: `Bearer ${token}` },
    });
    const items = back.json().items as Array<{ fields: Record<string, unknown> }>;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.fields.feishu_record_id).sort()).toEqual(['rec_src_1', 'rec_src_2']);
    await app.close();
  });

  it('dry-run 只统计不写入；未配置 tableId 的表跳过', async () => {
    const { app, writer, cfg, token } = await setup();
    cfg.bitable.tableIds = { ...cfg.bitable.tableIds, gantt: undefined };

    const dry = await migrateTables({
      config: cfg,
      reader: fakeReader(),
      writer,
      tableKeys: ['projects', 'gantt'],
      dryRun: true,
    });
    expect(dry[0].sourceCount).toBe(3);
    expect(dry[0].migrated).toBe(0);
    expect(dry[1].skipped).toBe(true);

    const back = await app.inject({
      method: 'GET',
      url: '/api/v1/tables/projects/records',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(back.json().items).toHaveLength(0);

    // 报告格式
    const text = formatReport(dry);
    expect(text).toContain('projects: 0/3 migrated');
    expect(text).toContain('gantt: SKIPPED');
    await app.close();
  });
});
