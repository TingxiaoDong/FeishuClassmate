/**
 * registerZodTool — zod-based tool registration against the self-hosted
 * AgentRuntime (PLAN §1.2-A2).
 *
 * Replaces the old OpenClaw adapter (src/util/register-tool.ts):
 *   - No more TypeBox conversion — zod v4 emits JSON Schema natively via
 *     `z.toJSONSchema`, which is exactly what OpenAI-style `function.parameters`
 *     expects.
 *   - `ZodToolDef` keeps the same shape as before, so existing tool files need
 *     only their import + `api` type updated — zero logic changes.
 */

import { z } from 'zod';
import type { AgentRuntime } from './types.js';

export interface ZodToolDef<TInput extends z.ZodTypeAny, TOutput> {
  name: string;
  description: string;
  inputSchema: TInput;
  outputSchema?: z.ZodTypeAny;
  execute: (input: z.infer<TInput>) => Promise<TOutput>;
}

export function registerZodTool<TInput extends z.ZodTypeAny, TOutput>(
  runtime: AgentRuntime,
  def: ZodToolDef<TInput, TOutput>,
): void {
  const parameters = z.toJSONSchema(def.inputSchema) as Record<string, unknown>;
  // Draft-2020-12 $schema marker confuses some OpenAI-compatible servers; drop it.
  delete parameters.$schema;

  runtime.registerTool(
    def.name,
    parameters,
    async (input) => {
      const parsed = def.inputSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: `input validation failed: ${parsed.error.message}` };
      }
      try {
        return await def.execute(parsed.data);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    { description: def.description },
  );
}

/**
 * Convenience: convert a zod schema to OpenAI-tools-compatible JSON Schema
 * without registering (used by the schema inspection test and future PAL).
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const out = z.toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  return out;
}
