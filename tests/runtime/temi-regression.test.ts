/**
 * Temi 链路 mock 回归（PLAN §3-P2 验收前置）：
 * 新栈下 大脑 → temi 工具 → temi-sidecar（mockMode）全链路。
 *
 * mock LLM 模拟用户"让 Temi 说欢迎光临"的意图：第一轮请求
 * feishu_classmate_temi_speak，第二轮总结。temi mockMode 下工具走
 * sidecar 的 mockReturn 路径，无需真机器人。
 */

import { describe, expect, it } from 'vitest';
import { createBrain } from '../../src/runtime/brain.js';
import { createFakeConfig } from '../helpers/fake-config.js';
import type { ChatCompletionRequest } from '../../src/runtime/llm-client.js';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('Temi 链路 mock 回归（新栈）', () => {
  it('大脑经 runSession 驱动 temi_speak（mockMode）', async () => {
    const seen: ChatCompletionRequest[] = [];
    const llm = {
      async chat(req: ChatCompletionRequest) {
        seen.push(req);
        if (seen.length === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'c1', name: 'feishu_classmate_temi_speak', arguments: '{"text":"欢迎光临"}' },
            ],
          };
        }
        const toolMsg = req.messages[req.messages.length - 1];
        return { content: `已让 Temi 播报（tool 返回: ${toolMsg.content?.slice(0, 80)}）`, toolCalls: [] };
      },
    };

    const cfg = createFakeConfig();
    cfg.temi.mockMode = true;
    const { runtime } = createBrain({ config: cfg, llm, logger: silent, telemetry: false });

    // temi 工具全部在新 runtime 注册（当前 10 个）
    const temiTools = runtime.listTools().filter((n) => n.startsWith('feishu_classmate_temi_'));
    expect(temiTools.length).toBeGreaterThanOrEqual(9);
    expect(temiTools).toContain('feishu_classmate_temi_speak');

    const res = await runtime.runSession({
      sessionId: 'temi_regression',
      messages: [{ role: 'user', content: '让 Temi 说欢迎光临' }],
    });

    expect(res.turns).toBe(2);
    expect(res.output).toContain('已让 Temi 播报');
    // 工具结果回灌且非错误载荷
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain('input validation failed');
    expect(toolMsg!.content).not.toContain('"ok":false');
  });
});
