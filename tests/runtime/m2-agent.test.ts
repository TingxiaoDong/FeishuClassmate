/**
 * AGENT_PLAN M2 验收：确认卡片（服务端核验）、skills 按问题挑选、上下文压缩、评测集与评测脚本。
 * 端到端部分经真实 Bot 网关 + 内存版 ClassmateOS，用脚本化的模型代替真实大模型。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCase } from '../../scripts/run-evals.js';
import { fill, placeholders, scoreCase, validateCases, type EvalCase, type EvalFile } from '../../src/evals/score.js';
import { createBrain } from '../../src/runtime/brain.js';
import type { ChatCompletionRequest, LlmClientLike } from '../../src/runtime/llm-client.js';
import { recordTurn } from '../../src/runtime/session-store.js';
import { loadSkills, selectSkills, searchTerms } from '../../src/runtime/skills-loader.js';
import type { ChatMessage } from '../../src/runtime/types.js';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 脚本化模型：建表加一条记录；或者查记录后删除，按工具结果给最终回复。 */
function scriptedLlm(): LlmClientLike {
  let n = 0;
  const call = (name: string, args: unknown) => ({ content: '', toolCalls: [{ id: `call_${++n}`, name, arguments: JSON.stringify(args) }] });
  return {
    async chat(req: ChatCompletionRequest) {
      const msgs = req.messages as ChatMessage[];
      const lastUser = msgs.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).at(-1)!;
      const text = msgs[lastUser].content;
      const tools = msgs.slice(lastUser).filter((m) => m.role === 'tool');
      const lastTool = tools.at(-1)?.content ?? '';
      if (text.includes('建表')) {
        if (tools.length === 0) return call('cos_table', { action: 'create_table', name: '临时测试表', fields: [{ title: '名称', type: 'text', field_name: 'name' }] });
        if (tools.length === 1) {
          const key = /cos:\/\/table\/([\w-]+)/.exec(lastTool)?.[1];
          return call('cos_table', { action: 'create_records', table_key: key, records: [{ name: '样例A' }] });
        }
        return { content: '建好了', toolCalls: [] };
      }
      // 删除：表 key 从「工作记忆」里取（多轮）
      const key = msgs.map((m) => /cos:\/\/table\/([\w-]+)/.exec(m.content)?.[1]).filter(Boolean).at(-1);
      if (tools.length === 0) return call('cos_table', { action: 'list_records', table_key: key });
      if (tools.length === 1) {
        const id = /"record_id":"([^"]+)"/.exec(lastTool)?.[1];
        return call('cos_table', { action: 'delete_records', table_key: key, record_ids: [id] });
      }
      const r = JSON.parse(lastTool) as { ok?: boolean; error?: string };
      return { content: r.ok ? '已删除样例A' : `没有删除：${r.error ?? ''}`, toolCalls: [] };
    },
  };
}

const deleteCase = (answer: 'approve' | 'reject', expectOut: string): EvalCase => ({
  id: `delete-${answer}`,
  category: '删除确认',
  turns: ['帮我建表', '把样例A删掉'],
  confirm_answer: answer,
  expect: { tools_any: ['cos_table'], actions_any: answer === 'approve' ? ['delete_records'] : undefined, confirm: true, output_any: [expectOut] },
});

describe('确认卡片端到端（网关 → 卡片 → 同学点按钮 → 服务端核验）', () => {
  it('同学点「确认」：服务端凭卡片放行删除', async () => {
    const r = await runCase(deleteCase('approve', '已删除'), { llm: scriptedLlm() });
    expect(r.failures).toEqual([]);
    expect(r.status).toBe('pass');
    expect(r.confirmAsked).toBe(true);
  }, 30_000);

  it('同学点「取消」：工具不执行，回复说明没删', async () => {
    const r = await runCase(deleteCase('reject', '没有删除'), { llm: scriptedLlm() });
    expect(r.failures).toEqual([]);
    expect(r.output).toContain('没有删除');
  }, 30_000);

  it('建表加数据不弹确认', async () => {
    const c: EvalCase = { id: 'create', category: '表格', turns: ['帮我建表'], expect: { actions_any: ['create_records'], confirm: false, state: [{ path: '/tables', contains: '临时测试表' }] } };
    const r = await runCase(c, { llm: scriptedLlm() });
    expect(r.failures).toEqual([]);
  }, 30_000);
});

describe('评测集', () => {
  const file = JSON.parse(readFileSync('evals/agent-cases.json', 'utf8')) as EvalFile;

  it('题目文件合格，共 50 题（M5 扩充）、id 不重复', () => {
    expect(validateCases(file)).toEqual([]);
    expect(file.cases).toHaveLength(50);
    expect(file.cases.filter((c) => c.context).length).toBeGreaterThanOrEqual(10);
  });

  it('context 里用到的变量必须由 setup.save 记下', () => {
    const bad = { version: 2, cases: [{ id: 'x', category: '侧栏', turns: ['a'], context: { kind: 'doc', id: '{{doc}}' }, expect: { confirm: false } }] } as EvalFile;
    expect(validateCases(bad).join()).toContain('{{doc}}');
  });

  it('打分：工具 / action / 确认 / 回复 / 平台状态', () => {
    const c: EvalCase = {
      id: 'x', category: 't', turns: ['a'],
      expect: { tools_any: ['cos_table'], actions_any: ['create_table'], confirm: false, output_none: ['密码'], state: [{ path: '/tables', contains: '器材' }] },
    };
    expect(scoreCase(c, { calls: [{ name: 'cos_table', action: 'create_table' }], confirmAsked: false, output: '好了', state: [{ status: 200, body: '器材借用' }] }).pass).toBe(true);
    const bad = scoreCase(c, { calls: [{ name: 'cos_doc', action: 'create' }], confirmAsked: true, output: '密码是 1', state: [{ status: 200, body: '' }] });
    expect(bad.pass).toBe(false);
    expect(bad.failures).toHaveLength(5);
  });

  it('占位符：整值换数字，嵌入换文本', () => {
    const v = placeholders(new Date(2026, 9, 20, 9));
    expect(fill({ a: '{{tomorrow_10}}', b: '/x?from={{from}}' }, v)).toEqual({ a: v.tomorrow_10, b: `/x?from=${v.from}` });
  });
});

describe('skills 按问题挑选', () => {
  const skills = loadSkills('skills');

  it('中文按双字切词', () => {
    expect([...searchTerms('约会议')]).toEqual(['约会', '会议']);
  });

  it('「约个组会」选中会议预约 skill；闲聊不展开', () => {
    const ids = selectSkills(skills, '帮我和李华约个组会', 3).map((s) => s.id);
    expect(ids[0]).toBe('intelligent-meeting-scheduling');
    expect(selectSkills(skills, '你好', 3)).toEqual([]);
  });

  it('大脑每轮生成提示：选中的展开，其余只列名字', () => {
    const b = createBrain({ llm: { chat: async () => ({ content: '', toolCalls: [] }) }, skillsDir: 'skills', logger: silent, telemetry: false, cos: false });
    const p = b.systemPromptFor('帮我查几篇 transformer 的论文')!;
    expect(p).toContain('## Skill:');
    expect(p).toContain('其他可用技能');
    expect(p.length).toBeLessThan(b.systemPromptFor('')!.length + 50_000);
  });
});

describe('上下文压缩', () => {
  it('超出轮数时把早期对话交给 summarize 合并成摘要', async () => {
    let snap = { history: [] as ChatMessage[], recent: [], summary: null as string | null };
    const seen: ChatMessage[][] = [];
    const summarize = async (prev: string | null | undefined, dropped: ChatMessage[]) => {
      seen.push(dropped);
      return `${prev ?? ''}|${dropped.map((m) => m.content).join(',')}`;
    };
    for (let i = 1; i <= 4; i++) {
      snap = await recordTurn(snap, { user: { role: 'user', content: `q${i}` }, assistant: { role: 'assistant', content: `a${i}` }, recent: [] }, { maxTurns: 2, summarize });
    }
    expect(snap.history.map((m) => m.content)).toEqual(['q3', 'a3', 'q4', 'a4']);
    expect(snap.summary).toBe('|q1,a1|q2,a2');
  });

  it('summarize 失败时退化成截短拼接，不丢信息', async () => {
    const snap = await recordTurn(
      { history: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }], recent: [], summary: null },
      { user: { role: 'user', content: '新问题' }, recent: [{ link: 'cos://a', at: 1 }, { link: 'cos://b', at: 2 }] },
      { maxTurns: 1, maxRecent: 1, summarize: async () => { throw new Error('x'); } },
    );
    expect(snap.summary).toContain('旧问题');
    expect(snap.recent.map((r) => r.link)).toEqual(['cos://b']);
  });
});
