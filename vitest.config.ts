import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Temi/ 是本地的 Temi 机器人仓库副本（没有纳入版本管理），里面的测试不属于本项目，不跑。
    exclude: [
      ...configDefaults.exclude,
      'Temi/**',
      'classmateos/app/**',
      // 旧服务层测试依赖已移除的 src/bitable、src/util 等源码。
      'tests/classmateos/**',
      // 临时验收副本不属于默认测试套件。
      '_tmp/**',
      // 这些运行时测试仍验证旧 PAL / Temi 兼容层，保留文件但不纳入新栈全量测试。
      'tests/runtime/brain.test.ts',
      'tests/runtime/llm-env.test.ts',
      'tests/runtime/runtime.test.ts',
      'tests/runtime/agent-a4-outbound.test.ts',
      'tests/runtime/automation-scheduler-client.test.ts',
      'tests/runtime/bot-gateway.test.ts',
      'tests/runtime/cos-task-tools.test.ts',
      'tests/runtime/cos-tools.test.ts',
      'tests/runtime/m2-agent.test.ts',
      'tests/runtime/m4-robot.test.ts',
      'tests/runtime/m4-voice.test.ts',
      'tests/runtime/m5-evals.test.ts',
      'tests/runtime/review-fixes.test.ts',
      'tests/runtime/session-store.test.ts',
      'tests/runtime/temi-regression.test.ts',
    ],
  },
});
