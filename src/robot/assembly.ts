import type { CosClient } from '../cos-sdk/client.js';
/** M4 模拟验收入口。真机接入尚未验收，明确拒绝启用，避免旧协议误报到达。 */
import type { AgentRuntime } from '../runtime/types.js';
import type { ClassmateConfig } from '../config.js';
import { MockSidecar } from './sidecar.js';
import { CosLocationRegistry, StaticLocationRegistry, locationsFromEnv } from './locations.js';
import { RobotController, createCosRobotReporter } from './controller.js';
import { RobotGuard, guardOptionsFromEnv } from './safety.js';
import { registerRobotTools, type RobotToolsOptions } from '../tools/robot/index.js';
export function registerM4Simulation(runtime: AgentRuntime, config: ClassmateConfig, client?: CosClient, describeImage?: RobotToolsOptions['describeImage']): RobotController {
  if (!config.temi.mockMode) throw new Error('M4 真机协议尚未验收；当前仅允许 TEMI_MOCK 模拟模式');
  const controller = new RobotController({
    sidecar: new MockSidecar(),
    locations: client ? new CosLocationRegistry(client, 'temi', { ttlMs: 30_000 }) : new StaticLocationRegistry(locationsFromEnv()),
    reporter: client ? createCosRobotReporter(client) : undefined,
    guard: new RobotGuard(guardOptionsFromEnv()),
  });
  controller.start();
  registerRobotTools(runtime, { controller, cos: client, describeImage });
  return controller;
}
