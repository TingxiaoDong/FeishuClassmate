import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../classmateos/server/app.js';
import { parseMarkdown } from '../../classmateos/server/doc-export.js';
import { readCsv, readXlsx, writeXlsx, zipRead } from '../../classmateos/server/office.js';
import { suggestType } from '../../classmateos/server/routes-import-export.js';

async function setup() {
  const app = await buildApp({ secret: 's', notificationScanner: false, users: [
    { user_id: 'admin', name: 'Admin', password: 'pw', role: 'admin' },
    { user_id: 'alice', name: 'Alice', password: 'pw', role: 'member' },
    { user_id: 'bob', name: 'Bob', password: 'pw', role: 'member' },
  ] });
  const tokens: Record<string, string> = {};
  const auth = async (u: string) => {
    tokens[u] ??= (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: u, password: 'pw' } })).json().access_token;
    return { authorization: `Bearer ${tokens[u]}` };
  };
  const call = async (u: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: await auth(u), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const upload = async (u: string, name: string, data: Buffer) => {
    const g = (await call(u, 'POST', '/files/upload-url', { file_name: name, size: data.length, content_type: 'application/octet-stream' })).json();
    expect((await app.inject({ method: 'PUT', url: g.upload_url, payload: data })).statusCode).toBe(201);
    return g.file_key as string;
  };
  const download = async (u: string, key: string) => {
    const dl = (await call(u, 'GET', `/files/${encodeURIComponent(key)}/download-url`)).json();
    const r = await app.inject({ method: 'GET', url: dl.download_url });
    return { body: r.rawPayload, disposition: String(r.headers['content-disposition'] ?? '') };
  };
  const waitJob = async (u: string, id: string) => {
    for (let i = 0; i < 100; i++) {
      const j = (await call(u, 'GET', `/jobs/${id}`)).json();
      if (j.status === 'done' || j.status === 'failed') return j;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('job timeout');
  };
  return { app, call, upload, download, waitJob };
}

const tableBody = {
  name: '器材登记', primary_field: 'name',
  fields: [
    { field_name: 'name', title: '名称', type: 1, required: true },
    { field_name: 'state', title: '状态', type: 3, options: ['空闲', '借出'] },
    { field_name: 'qty', title: '数量', type: 2 },
    { field_name: 'due', title: '归还日期', type: 5 },
    { field_name: 'owner', title: '负责人', type: 11 },
    { field_name: 'ok', title: '已检查', type: 7 },
  ],
};

describe('办公文件读写', () => {
  it('xlsx 写出再读回一致；CSV 识别 GBK 与 BOM；类型推荐', () => {
    const rows = [['名称', '数量'], ['示波器', '3'], ['万用表 "A"', '']];
    expect(readXlsx(writeXlsx(rows))).toEqual([['名称', '数量'], ['示波器', '3'], ['万用表 "A"']]);
    expect(readCsv(Buffer.from('C3FBB3C62CD7B4CCAC0D0ACABEB2A8C6F72CBFD5CFD0', 'hex'))).toEqual([['名称', '状态'], ['示波器', '空闲']]);
    expect(readCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,"b,c"\n1,"x""y"\n')]))).toEqual([['a', 'b,c'], ['1', 'x"y']]);
    expect(suggestType(['1', '2.5', '1,000'])).toBe(2);
    expect(suggestType(['2026-10-01', '2026/9/1'])).toBe(5);
    expect(suggestType(['是', '否', '是'])).toBe(7);
    expect(suggestType(['空闲', '借出', '空闲', '空闲', '借出'])).toBe(3);
    expect(suggestType(['abc', 'def'])).toBe(1);
  });

  it('Markdown 解析：标题、列表、图片拆块、表格', () => {
    const b = parseMarkdown('# 标题\n\n正文 **粗** 文字\n\n- 一\n1. 二\n\n![图](cos-file://f_1_a.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(b.map((x) => x.kind)).toEqual(['h', 'p', 'li', 'li', 'img', 'table']);
    expect((b[1] as any).runs.find((r: any) => r.bold).text).toBe('粗');
  });
});

describe('多维表格导入导出（table.import / table.export）', () => {
  it('预览 → 追加导入（格式错的行计入失败并出明细）→ 按主字段更新 → 导出 xlsx / csv', async () => {
    const { app, call, upload, download, waitJob } = await setup();
    try {
      const t = (await call('alice', 'POST', '/tables', tableBody)).json();
      const csv = '名称,状态,数量,归还日期,负责人,已检查,备注\n示波器,空闲,3,2026-10-20,Bob,是,x\n万用表,借出,abc,,,,\n电源,坏了,1,,,,\n';
      const key = await upload('alice', '器材.csv', Buffer.from(csv));
      const pv = (await call('alice', 'POST', '/tables/imports/preview', { file_key: key })).json();
      expect(pv.headers).toEqual(['名称', '状态', '数量', '归还日期', '负责人', '已检查', '备注']);
      expect(pv.total_rows).toBe(3);
      expect(pv.rows).toHaveLength(3);
      expect(pv.suggested_types['归还日期']).toBe(5);
      // 别人的文件不能用
      expect((await call('bob', 'POST', '/tables/imports/preview', { file_key: key })).statusCode).toBe(404);

      const mapping = { 名称: 'name', 状态: 'state', 数量: 'qty', 归还日期: 'due', 负责人: 'owner', 已检查: 'ok' };
      const badMap = await call('alice', 'POST', `/tables/${t.key}/imports`, { file_key: key, mode: 'append', mapping: { 名称: 'nope' } });
      expect(badMap.statusCode).toBe(422);
      const im = await call('alice', 'POST', `/tables/${t.key}/imports`, { file_key: key, mode: 'append', mapping });
      expect(im.statusCode).toBe(202);
      const job = await waitJob('alice', im.json().job_id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ succeeded: 1, failed: 2 });
      const errFile = readXlsx((await download('alice', job.result.error_file_key)).body);
      expect(errFile[0].slice(0, 2)).toEqual(['行号', '失败原因']);
      expect(errFile.map((r) => r[0]).slice(1)).toEqual(['3', '4']);
      const recs = (await call('alice', 'GET', `/tables/${t.key}/records`)).json().items;
      expect(recs).toHaveLength(1);
      expect(recs[0].fields).toMatchObject({ name: '示波器', state: '空闲', qty: 3, ok: true, owner: [{ id: 'bob' }] });
      expect(recs[0].fields.due).toBe(Date.parse('2026-10-19T16:00:00Z'));

      // upsert：示波器更新数量，新行追加
      const key2 = await upload('alice', '更新.xlsx', writeXlsx([['名称', '数量'], ['示波器', '5'], ['信号源', '2']]));
      const job2 = await waitJob('alice', (await call('alice', 'POST', `/tables/${t.key}/imports`, { file_key: key2, mode: 'upsert', mapping: { 名称: 'name', 数量: 'qty' } })).json().job_id);
      expect(job2.result).toMatchObject({ succeeded: 2, failed: 0 });
      const after = (await call('alice', 'GET', `/tables/${t.key}/records`)).json().items;
      expect(after).toHaveLength(2);
      expect(after.find((r: any) => r.fields.name === '示波器').fields.qty).toBe(5);

      // 只读成员不能导入，但可以导出
      await call('alice', 'PUT', `/tables/${t.key}/permissions`, { visibility: 'members', members: [{ member_type: 'user', member_id: 'bob', role: 'viewer' }] });
      expect((await call('bob', 'POST', `/tables/${t.key}/imports`, { file_key: key2, mode: 'append', mapping: { 名称: 'name' } })).statusCode).toBe(403);
      const ex = await call('bob', 'POST', `/tables/${t.key}/exports`, { format: 'xlsx' });
      expect(ex.statusCode).toBe(202);
      const exJob = await waitJob('bob', ex.json().job_id);
      expect(exJob.status).toBe('done');
      expect(exJob.result.file_name).toMatch(/^器材登记_.*\.xlsx$/);
      const file = await download('bob', exJob.result.file_key);
      expect(file.disposition).toContain('filename');
      const sheet = readXlsx(file.body);
      expect(sheet[0]).toEqual(['名称', '状态', '数量', '归还日期', '负责人', '已检查']);
      const row = sheet.find((r) => r[0] === '示波器')!;
      expect(row).toEqual(['示波器', '空闲', '5', '2026-10-20', 'Bob', '是']);

      const ids = [after[0].record_id];
      const csvJob = await waitJob('bob', (await call('bob', 'POST', `/tables/${t.key}/exports`, { format: 'csv', record_ids: ids })).json().job_id);
      const csvRows = readCsv((await download('bob', csvJob.result.file_key)).body);
      expect(csvRows).toHaveLength(2);
      // 别人的任务看不到
      expect((await call('alice', 'GET', `/jobs/${csvJob.job_id}`)).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe('文档导出（doc.export）', () => {
  // 2×1 红色 PNG
  const png = (() => {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
  })();

  it('导出 docx（含图片）和 pdf；无权访问的文档 403', async () => {
    const { app, call, upload, download, waitJob } = await setup();
    try {
      const img = await upload('alice', 'red.png', png);
      const doc = (await call('alice', 'POST', '/docs', { title: '实验报告', markdown: `# 目的\n\n测量**电压**。\n\n![波形](cos-file://${img})\n\n- 步骤一\n- 步骤二\n\n\`\`\`\ncode\n\`\`\`` })).json();
      const dj = await waitJob('alice', (await call('alice', 'POST', `/docs/${doc.doc_id}/exports`, { format: 'docx' })).json().job_id);
      expect(dj.status).toBe('done');
      expect(dj.result.file_name).toBe('实验报告.docx');
      const z = zipRead((await download('alice', dj.result.file_key)).body);
      expect(z.get('word/document.xml')!.toString()).toContain('电压');
      expect([...z.keys()].some((k) => k.startsWith('word/media/image1'))).toBe(true);

      const pj = await waitJob('alice', (await call('alice', 'POST', `/docs/${doc.doc_id}/exports`, { format: 'pdf' })).json().job_id);
      expect(pj.status).toBe('done');
      const pdf = (await download('alice', pj.result.file_key)).body;
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.toString('latin1')).toContain('/Subtype /Image');
      expect(pdf.toString('latin1')).toContain('%%EOF');

      expect((await call('alice', 'POST', `/docs/${doc.doc_id}/exports`, { format: 'txt' })).statusCode).toBe(422);
      await call('alice', 'PUT', `/docs/${doc.doc_id}/permissions`, { link_share: 'off', members: [] });
      expect((await call('bob', 'POST', `/docs/${doc.doc_id}/exports`, { format: 'pdf' })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});

describe('成员批量导入（user.import）', () => {
  it('模板 → 预览校验 → 导入，初始密码文件只给管理员；普通成员 403', async () => {
    const { app, call, upload, download, waitJob } = await setup();
    try {
      expect((await call('alice', 'GET', '/users/import/template')).statusCode).toBe(403);
      const tpl = (await call('admin', 'GET', '/users/import/template')).json();
      expect(readXlsx((await download('admin', tpl.file_key)).body)[0]).toEqual(['登录账号', '姓名', '邮箱', '手机号', '职务', '部门', '直属上级', '角色']);
      const dep = (await call('admin', 'POST', '/departments', { name: '物理系', parent_id: null })).json();
      const file = writeXlsx([
        ['登录账号', '姓名', '邮箱', '部门', '直属上级', '角色'],
        ['wang', '王五', 'wang@x.cn', '物理系', 'Alice', '普通成员'],
        ['alice', '重复', '', '', '', ''],
        ['zhao', '赵六', 'bad-mail', '', '', ''],
        ['qian', '钱七', '', '化学系', '', ''],
        ['sun', '孙八', '', '', '', ''],
      ]);
      const key = await upload('admin', '成员.xlsx', file);
      const pv = (await call('admin', 'POST', '/users/import/preview', { file_key: key })).json();
      expect(pv.total_rows).toBe(5);
      expect(pv.errors.map((e: any) => e.row)).toEqual([1, 2, 3]);
      const job = await waitJob('admin', (await call('admin', 'POST', '/users/import', { file_key: key })).json().job_id);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ succeeded: 2, failed: 3 });
      const pw = readXlsx((await download('admin', job.result.file_key)).body);
      expect(pw.map((r) => r[0])).toEqual(['登录账号', 'wang', 'sun']);
      expect(pw[1][2].length).toBeGreaterThanOrEqual(12);
      const wang = (await call('admin', 'GET', '/users/wang?include=admin')).json();
      expect(wang).toMatchObject({ name: '王五', leader_id: 'alice', primary_department_id: dep.department_id, role_ids: ['member'] });
      // 新成员能用初始密码登录（需改密）
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'wang', password: pw[1][2] } });
      expect(login.json().must_change_password).toBe(true);
      const logs = (await call('admin', 'GET', '/audit-logs?action=user.import')).json().items;
      expect(logs).toHaveLength(1);
    } finally { await app.close(); }
  });
});
