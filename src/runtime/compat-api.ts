/**
 * Compat shim (PLAN §1.2-A9/A10): lets the existing 30+ tool files register
 * against the self-hosted ClassmateRuntime **without any code changes**.
 *
 * Existing tools call the old adapter (src/util/register-tool.ts), which:
 *   1. converts zod → TypeBox (still fine — TypeBox output IS JSON Schema,
 *      exactly what the runtime's `parameters` field expects);
 *   2. calls `api.registerTool({name, description, parameters, execute})`.
 *
 * And read config via `getConfigFromApi(api)` → `api.pluginConfig`.
 *
 * So the whole migration surface is: provide an object shaped like
 * OpenClawPluginApi with { registerTool, pluginConfig, logger, setConfig }.
 */

import type { AgentRuntime, ToolCallContext } from './types.js';
import type { ClassmateConfig } from '../config.js';

export interface LoggerLike {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export const consoleLogger: LoggerLike = {
  debug: (m) => console.debug(m),
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/** The OpenClaw-style tool def produced by the legacy zod adapter. */
interface LegacyToolDef {
  name: string;
  label?: string;
  description?: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: unknown) => Promise<{ content: unknown; details: unknown }>;
}

/**
 * The minimal api surface used by src/tools/** and src/bitable/setup.ts.
 * Structurally compatible with OpenClawPluginApi for those call sites.
 */
export interface CompatApi {
  registerTool: (def: LegacyToolDef) => void;
  pluginConfig: ClassmateConfig;
  logger: LoggerLike;
  /** persistSetup writes table IDs back; here it mutates the in-memory config. */
  setConfig: (patch: Record<string, unknown>) => void;
}

export function createCompatApi(opts: {
  runtime: AgentRuntime;
  config: ClassmateConfig;
  logger?: LoggerLike;
}): CompatApi {
  const { runtime, config } = opts;
  const logger = opts.logger ?? consoleLogger;

  return {
    pluginConfig: config,
    logger,

    registerTool(def: LegacyToolDef): void {
      runtime.registerTool(
        def.name,
        def.parameters,
        async (input: unknown, ctx: ToolCallContext) => {
          // Legacy execute returns {content, details}; the runtime feeds the
          // LLM the textual content and records details as the hook result.
          const out = await def.execute(ctx.toolCallId, input);
          return out.details;
        },
        { description: def.description ?? def.label ?? def.name },
      );
    },

    setConfig(patch: Record<string, unknown>): void {
      Object.assign(config, patch);
      logger.info(`[compat-api] config patched in-memory: ${Object.keys(patch).join(', ')}`);
    },
  };
}
