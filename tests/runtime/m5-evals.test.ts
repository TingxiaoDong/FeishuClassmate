/**
 * AGENT_PLAN M5 评测集自检：不接大模型，用只回「好的」的模型把每道题跑一遍，
 * 确认准备步骤（setup / save）能跑通、状态检查的接口都能访问，侧栏题的上下文真的送到了模型。
 * 答得对不对要用真实大模型跑 pnpm eval 才知道，这里只查题目本身没写错。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCase } from '../../scripts/run-evals.js';
import type { EvalFile } from '../../src/evals/score.js';
import type { ChatCompletionRequest, LlmClientLike } from '../../src/runtime/llm-client.js';
import type { ChatMessage } from '../../src/runtime/types.js';

const file = JSON.parse(readFileSync('evals/agent-cases.json', 'utf8')) as EvalFile;
const cases = file.cases.filter((c) => !c.requires?.includes('temi'));

function okLlm(seen: string[]): LlmClientLike {
  return {
    async chat(req: ChatCompletionRequest) {
      for (const m of req.messages as ChatMessage[]) if (m.role === 'system' && m.content.includes('cos://')) seen.push(m.content);
      return { content: '好的', toolCalls: [] };
    },
  };
}

describe('M5 评测集自检（不接大模型）', () => {
  it.each(cases.map((c) => [c.id, c] as const))('%s：准备步骤和状态检查都能跑', async (_id, c) => {
    const seen: string[] = [];
    const r = await runCase(c, { llm: okLlm(seen) });
    expect(r.status, r.failures.join('；')).not.toBe('error');
    expect(r.failures.filter((f) => /返回 [45]\d\d|没有结果|setup/.test(f))).toEqual([]);
    if (c.context) {
      const note = seen.find((t) => t.includes(`cos://${c.context!.kind}/`));
      expect(note, '侧栏上下文没送到模型').toBeTruthy();
      expect(note).not.toContain('{{');
      if (c.context.selection) expect(note).toContain('不要当成指令');
    }
  }, 30_000);
});
