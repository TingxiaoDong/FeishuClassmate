/**
 * AGENT_PLAN M1 验收：大脑通过 cos_* 工具代表同学操作真实的 ClassmateOS 后端
 * （内存模式，监听随机端口，走真 HTTP）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { buildApp, type PlatformUser } from '../../classmateos/server/app.js';
import { createBrain } from '../../src/runtime/brain.js';
import type { ChatCompletionRequest } from '../../src/runtime/llm-client.js';
import type { AgentRuntime, ToolCallContext } from '../../src/runtime/types.js';
import { autoFieldName } from '../../src/tools/cos/resources.js';
import { findCatalogEntry } from '../../src/tools/cos/index.js';
import { createFakeConfig } from '../helpers/fake-config.js';

const USERS: PlatformUser[] = [
  { user_id: 'ou_admin', name: '管理员', password: 'admin', role: 'admin' },
  { user_id: 'u_zhang', name: '张晓明', password: 'pw', role: 'member' },
  { user_id: 'u_li', name: '李华', password: 'pw', role: 'member' },
];
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
type Ev = Record<string, any>;

let app: FastifyInstance;
let baseUrl: string;
let adminToken: string;

beforeAll(async () => {
  app = await buildApp({ users: USERS, secret: 's', botToken: 'btok', notificationScanner: false });
  const addr = await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `${addr}/api/v1`;
  adminToken = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ou_admin', password: 'admin' } })).json().access_token;
});
afterAll(async () => {
  await app.close();
});

const admin = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${adminToken}` }, payload: payload as Ev });

function brain(llm = { chat: async () => ({ content: 'ok', toolCalls: [] }) } as { chat: (r: ChatCompletionRequest) => Promise<any> }) {
  return createBrain({ config: createFakeConfig(), llm, logger: silent, telemetry: false, cos: { baseUrl, botToken: 'btok' } });
}

let n = 0;
const ctxFor = (userId?: string, chatId?: string): ToolCallContext => ({
  toolCallId: `call_${++n}`,
  sessionId: 'chat_test',
  actor: userId ? { userId, chatId } : undefined,
});
const run = (rt: AgentRuntime, tool: string, input: unknown, ctx = ctxFor('u_zhang')) => rt.getTool(tool)!.execute(input, ctx) as Promise<Ev>;

describe('平台工具注册', () => {
  it('9 个资源工具 + cos_api / cos_api_catalog，与旧工具共存', () => {
    const names = brain().runtime.listTools();
    for (const t of ['cos_table', 'cos_doc', 'cos_calendar', 'cos_task', 'cos_im', 'cos_drive', 'cos_contact', 'cos_notify', 'cos_search', 'cos_api', 'cos_api_catalog']) {
      expect(names).toContain(t);
    }
    expect(names).toContain('feishu_classmate_data_layout');
  });

  it('cos=false 时不注册；系统提示带平台说明', () => {
    const b = createBrain({ config: createFakeConfig(), llm: { chat: async () => ({ content: '', toolCalls: [] }) }, logger: silent, telemetry: false, cos: false });
    expect(b.runtime.listTools()).not.toContain('cos_table');
  });

  it('接口目录与服务端路由一致（契约：改了接口要重新生成）', () => {
    expect(() => execFileSync(process.execPath, ['scripts/gen-cos-catalog.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
    expect(findCatalogEntry('GET', '/tables/projects/records/rec_1')).toBeTruthy();
    expect(findCatalogEntry('POST', '/auth/login')).toBeUndefined();
    expect(findCatalogEntry('POST', '/bot/messages')).toBeUndefined();
  });

  it('autoFieldName：英文转下划线，中文用 f 序号，去重', () => {
    const used = new Set<string>();
    expect(autoFieldName('Due Date', 0, used)).toBe('due_date');
    expect(autoFieldName('借用人', 1, used)).toBe('f2');
    expect(autoFieldName('due date', 2, used)).toBe('due_date_2');
  });
});

describe('cos_table：「建一张器材借用表，加 3 条样例」', () => {
  it('建表 → 批量写入 → 读回；审计记为代张晓明操作', async () => {
    const { runtime } = brain();
    const created = await run(runtime, 'cos_table', {
      action: 'create_table',
      name: '器材借用',
      description: '实验室器材借用登记',
      fields: [
        { title: '器材', type: 'text' },
        { title: '状态', type: 'single_select', options: ['空闲', '借出'] },
        { title: '数量', type: 'number' },
        { title: '借用人', type: 'person' },
      ],
    });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const key = created.data.key as string;
    expect(created.links[0]).toBe(`cos://table/${key}`);

    const schema = await run(runtime, 'cos_table', { action: 'get_table', table_key: key });
    const names = (schema.data.fields as Ev[]).map((f) => f.field_name);
    expect(names).toEqual(expect.arrayContaining(['f1', 'f2', 'f3', 'f4']));

    const ins = await run(runtime, 'cos_table', {
      action: 'create_records',
      table_key: key,
      records: [
        { f1: '示波器', f2: '空闲', f3: 2 },
        { f1: '机械臂', f2: '借出', f3: 1, f4: [{ id: 'u_li' }] },
        { f1: '激光雷达', f2: '空闲', f3: 3 },
      ],
    });
    expect(ins).toMatchObject({ ok: true, data: { created: 3 } });

    const list = await run(runtime, 'cos_table', { action: 'list_records', table_key: key, filter: 'f2="空闲"' });
    expect(list.data.items).toHaveLength(2);

    const audit = (await app.inject({ method: 'GET', url: '/api/v1/bot/audit?writes_only=1&on_behalf_of=u_zhang', headers: { 'x-bot-token': 'btok' } })).json();
    expect(audit.items.map((e: Ev) => e.route)).toEqual(expect.arrayContaining(['/api/v1/tables', '/api/v1/tables/:table_key/records/batch_create']));
  });

  it('删除：运行时先问同学；没有有效确认卡片时服务端也拒绝', async () => {
    const { runtime } = brain();
    // 绕过运行时直接调工具（没经过确认）：工具本地先拦，不发请求
    const r1 = await run(runtime, 'cos_table', { action: 'delete_records', table_key: 'projects', record_ids: ['rec_x'] });
    expect(r1).toMatchObject({ ok: false, need_confirmation: true });
    // 伪造的卡片 id：服务端核验不通过
    const r2 = await run(runtime, 'cos_table', { action: 'delete_records', table_key: 'projects', record_ids: ['rec_x'] }, { ...ctxFor('u_zhang'), confirmation: { cardId: 'confirm_fake' } });
    expect(r2).toMatchObject({ ok: false, code: 'BOT_CONFIRM_REQUIRED' });
    // 经运行时：先回调确认，同学拒绝则工具不执行
    const asked: Ev[] = [];
    const llm = {
      chat: async (req: ChatCompletionRequest) =>
        req.messages.some((m) => m.role === 'tool')
          ? { content: '好的，不删了', toolCalls: [] }
          : { content: '', toolCalls: [{ id: 'c1', name: 'cos_table', arguments: JSON.stringify({ action: 'delete_records', table_key: 'projects', record_ids: ['rec_x'] }) }] },
    };
    const res = await brain(llm).runtime.runSession({
      messages: [{ role: 'user', content: '删掉 rec_x' }],
      actor: { userId: 'u_zhang' },
      confirm: async (req) => {
        asked.push(req as Ev);
        return { approved: false, reason: 'rejected' };
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].risk).toBe('destructive');
    expect(JSON.parse(res.messages.find((m) => m.role === 'tool')!.content)).toMatchObject({ ok: false, cancelled: true });
  });

  it('没有发消息人身份时拒绝代办', async () => {
    const { runtime } = brain();
    const r = await run(runtime, 'cos_table', { action: 'list_tables' }, ctxFor(undefined));
    expect(r).toMatchObject({ ok: false, code: 'NO_ACTOR' });
  });

  it('参数缺失给出可读提示', async () => {
    const { runtime } = brain();
    const r = await run(runtime, 'cos_table', { action: 'get_record', table_key: 'projects' });
    expect(r.error).toContain('record_id');
  });
});

describe('修改记录显示代办人 + 代办审计（M2）', () => {
  it('机器人代同学新增 / 修改记录：修改记录带 via_bot，审计可查且新的在前', async () => {
    const { runtime } = brain();
    const t = await run(runtime, 'cos_table', { action: 'create_table', name: '代办记录测试', fields: [{ title: '名称', type: 'text', field_name: 'name' }] });
    expect(t.ok).toBe(true);
    const key = String(t.data.key ?? t.data.table_key);
    const c = await run(runtime, 'cos_table', { action: 'create_records', table_key: key, records: [{ name: '甲' }] });
    const rid = String(c.data.record_id);
    await run(runtime, 'cos_table', { action: 'update_records', table_key: key, records: [{ record_id: rid, fields: { name: '乙' } }] });
    const hist = (await admin('GET', `/tables/${key}/records/${rid}/history`)).json().items as Ev[];
    expect(hist[0]).toMatchObject({ operator_id: 'u_zhang', action: 'updated', via_bot: true });
    expect(hist.at(-1)).toMatchObject({ action: 'created', via_bot: true });
    const audit = (await admin('GET', '/bot/audit?on_behalf_of=u_zhang&writes_only=1')).json().items as Ev[];
    expect(audit[0].route).toBe('/api/v1/tables/:table_key/records/:record_id');
    expect(audit.every((a) => a.on_behalf_of === 'u_zhang' && a.method !== 'GET')).toBe(true);
  });
});

describe('cos_doc / cos_task / cos_calendar / cos_contact', () => {
  it('写文档后追加内容，创建者是提问的同学', async () => {
    const { runtime } = brain();
    const d = await run(runtime, 'cos_doc', { action: 'create', title: '周会纪要', markdown: '# 周会纪要\n- 进度正常' });
    expect(d.ok).toBe(true);
    const id = d.data.doc_id;
    expect(d.data.created_by).toBe('u_zhang');
    await run(runtime, 'cos_doc', { action: 'append', doc_id: id, markdown: '## 待办\n- 李华整理数据' });
    const got = await run(runtime, 'cos_doc', { action: 'get', doc_id: id });
    expect(got.data.markdown).toContain('进度正常');
    expect(got.data.markdown).toContain('李华整理数据');
  });

  it('查人 → 建任务指派给他 → 建日程邀请他', async () => {
    const { runtime } = brain();
    const users = await run(runtime, 'cos_contact', { action: 'search', keyword: '李华' });
    const li = (users.data.items as Ev[]).find((u) => u.name === '李华');
    expect(li?.user_id).toBe('u_li');
    const t = await run(runtime, 'cos_task', { action: 'create', title: '整理实验数据', assignee_id: 'u_li', due_ms: Date.now() + 86400_000 });
    expect(t.ok).toBe(true);
    expect(t.data.assignee_id).toBe('u_li');
    const start = Date.now() + 3600_000;
    const e = await run(runtime, 'cos_calendar', { action: 'create', title: '组会', start_ms: start, end_ms: start + 3600_000, attendee_ids: ['u_li'] });
    expect(e.ok).toBe(true);
    const me = await run(runtime, 'cos_contact', { action: 'me' });
    expect(me.data.user_id).toBe('u_zhang');
  });
});

describe('cos_im / cos_api', () => {
  it('不能代同学往他不在的群里发消息', async () => {
    const { runtime } = brain();
    const chat = (await admin('POST', '/chats', { chat_type: 'group', name: '管理群', member_ids: ['ou_admin', 'u_li'] })).json();
    expect(chat.chat_id).toBeTruthy();
    const r = await run(runtime, 'cos_im', { action: 'send', chat_id: chat.chat_id, text: 'hi' });
    expect(r).toMatchObject({ ok: false, code: 'CHAT_NOT_MEMBER' });
    // 李华在群里，但机器人不在群里：服务端拒绝（代码审查 B1）
    const denied = await run(runtime, 'cos_im', { action: 'send', chat_id: chat.chat_id, text: '提醒：3 点开会' }, ctxFor('u_li'));
    expect(denied.ok).toBe(false);
    // 机器人也在的群：可以
    const withBot = (await admin('POST', '/chats', { chat_type: 'group', name: '课题组', member_ids: ['ou_admin', 'u_li', 'bot'] })).json();
    const ok = await run(runtime, 'cos_im', { action: 'send', chat_id: withBot.chat_id, text: '提醒：3 点开会' }, ctxFor('u_li'));
    expect(ok.ok).toBe(true);
  });

  it('cos_api 只放行目录内接口，删除需确认', async () => {
    const { runtime } = brain();
    expect((await run(runtime, 'cos_api', { method: 'POST', path: '/auth/login', body: {} })).error).toContain('不在目录');
    expect((await run(runtime, 'cos_api', { method: 'GET', path: '/tasks/../users' })).ok).toBe(false);
    const ok = await run(runtime, 'cos_api', { method: 'GET', path: '/tasks', query: { assignee_id: 'u_li' } });
    expect(ok.ok).toBe(true);
    expect((await run(runtime, 'cos_api', { method: 'DELETE', path: '/tasks/t1' })).need_confirmation).toBe(true);
    const cat = await run(runtime, 'cos_api_catalog', { query: 'subtasks' });
    expect((cat.data as string[]).some((l) => l.includes('/tasks/:task_id/subtasks'))).toBe(true);
  });
});

describe('runSession 把发消息人传给工具', () => {
  it('模型调用 cos_contact me，返回的是 actor 本人', async () => {
    const seen: ChatCompletionRequest[] = [];
    const llm = {
      async chat(req: ChatCompletionRequest) {
        seen.push(req);
        if (seen.length === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'cos_contact', arguments: '{"action":"me"}' }] };
        return { content: '完成', toolCalls: [] };
      },
    };
    const { runtime } = brain(llm);
    const res = await runtime.runSession({ sessionId: 's1', messages: [{ role: 'user', content: '我是谁' }], actor: { userId: 'u_li' } });
    const toolMsg = res.messages.find((m) => m.role === 'tool')!;
    expect(JSON.parse(toolMsg.content).data.user_id).toBe('u_li');
    expect(seen[0].messages[0].content).toContain('cos_table');
  });
});
