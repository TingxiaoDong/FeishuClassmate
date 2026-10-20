import { describe, expect, it } from 'vitest';
import { llmEnvProblem, resolveLlmEnv } from '../../src/runtime/llm-env.js';

describe('大模型连接配置', () => {
  it('什么都没设时走 MetaClaw（保持原来的行为）', () => {
    expect(resolveLlmEnv({})).toEqual({ provider: 'metaclaw', baseUrl: 'http://127.0.0.1:30000/v1', model: 'kimi-k2', apiKey: undefined, flush: true });
  });

  it('填了 DeepSeek Key 就直连 DeepSeek，不调 flush', () => {
    expect(resolveLlmEnv({ DEEPSEEK_API_KEY: ' sk-1 ' })).toEqual({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-1',
      flush: false,
    });
  });

  it('LLM_PROVIDER 优先；设了 METACLAW_URL 时不自动切到 DeepSeek', () => {
    expect(resolveLlmEnv({ DEEPSEEK_API_KEY: 'sk', METACLAW_URL: 'http://m/v1' }).provider).toBe('metaclaw');
    expect(resolveLlmEnv({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk', METACLAW_URL: 'http://m/v1' }).provider).toBe('deepseek');
    expect(resolveLlmEnv({ LLM_PROVIDER: 'metaclaw', DEEPSEEK_API_KEY: 'sk' }).provider).toBe('metaclaw');
    expect(resolveLlmEnv({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk', CLASSMATE_MODEL: 'deepseek-reasoner' }).model).toBe('deepseek-reasoner');
  });

  it('选了 DeepSeek 但 Key 空着时给出提示', () => {
    expect(llmEnvProblem(resolveLlmEnv({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: '' }))).toContain('DEEPSEEK_API_KEY');
    expect(llmEnvProblem(resolveLlmEnv({ DEEPSEEK_API_KEY: 'sk' }))).toBeUndefined();
  });
});
