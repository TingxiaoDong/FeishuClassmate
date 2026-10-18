/**
 * A9/A10 acceptance: the existing tool registry runs unchanged on the new
 * runtime — mock LLM drives a full tool-call loop against a real registered
 * tool (feishu_classmate_data_layout), proving the compat shim works.
 */

import { describe, expect, it } from 'vitest';
import { createBrain } from '../../src/runtime/brain.js';
import { createFakeConfig } from '../helpers/fake-config.js';
import type { ChatCompletionRequest } from '../../src/runtime/llm-client.js';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeMockLlm(seen: ChatCompletionRequest[]) {
  return {
    async chat(req: ChatCompletionRequest) {
      seen.push(req);
      if (seen.length === 1) {
        return {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'feishu_classmate_data_layout', arguments: '{}' },
          ],
        };
      }
      return { content: '已获取数据布局', toolCalls: [] };
    },
  };
}

describe('createBrain (A9/A10)', () => {
  it('registers the full legacy tool set on the new runtime, unchanged', () => {
    const { runtime } = createBrain({
      config: createFakeConfig(),
      llm: makeMockLlm([]),
      logger: silentLogger,
      telemetry: false,
    });
    const names = runtime.listTools();
    // 现有注册表的关键 tool 一个不少（零改动迁移）
    expect(names).toContain('feishu_classmate_data_layout');
    expect(names.some((n) => n.startsWith('feishu_classmate_temi_'))).toBe(true);
    expect(names.some((n) => n.startsWith('feishu_classmate_supervision_'))).toBe(true);
    expect(names).toContain('feishu_classmate_research_search_works');
  });

  it('mock LLM drives a legacy tool end-to-end through runSession', async () => {
    const seen: ChatCompletionRequest[] = [];
    const { runtime } = createBrain({
      config: createFakeConfig(),
      llm: makeMockLlm(seen),
      logger: silentLogger,
      telemetry: false,
    });

    const res = await runtime.runSession({
      sessionId: 'brain_test',
      messages: [{ role: 'user', content: '数据布局是什么？' }],
    });

    expect(res.output).toBe('已获取数据布局');
    // tool 结果回灌：data_layout 的返回包含 fake 配置的 app_token
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('test_bitable_token');

    // 工具的 JSON Schema 暴露给 LLM（TypeBox 输出直接可用）
    const spec = seen[0].tools?.find((t) => t.name === 'feishu_classmate_data_layout');
    expect(spec?.parameters).toMatchObject({ type: 'object' });
  });
});
