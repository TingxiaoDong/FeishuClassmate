/**
 * Local config loader (PLAN §1.2-A5).
 *
 * Replaces `~/.openclaw/openclaw.json` as the config source. Resolution order:
 *   1. `$CLASSMATE_CONFIG` explicit file path (yaml or json);
 *   2. `classmate.config.yaml` / `.yml` / `.json` in the working directory;
 *   3. env vars only (handled inside readConfig fallbacks).
 *
 * The parsed object is fed into the existing `readConfig(raw)` — its merge
 * logic and signature stay untouched, so every consumer of ClassmateConfig
 * keeps working.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readConfig, type ClassmateConfig } from '../config.js';

const CANDIDATES = ['classmate.config.yaml', 'classmate.config.yml', 'classmate.config.json'];

/** Locate the config file, or return undefined when only env vars are in play. */
export function findConfigFile(cwd: string = process.cwd()): string | undefined {
  const explicit = process.env.CLASSMATE_CONFIG;
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) throw new Error(`CLASSMATE_CONFIG points at a missing file: ${p}`);
    return p;
  }
  for (const name of CANDIDATES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Parse one config file (yaml or json, by extension). */
export function parseConfigFile(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) return JSON.parse(text);
  return parseYaml(text);
}

/** Load the effective ClassmateConfig: file first, env fallback inside readConfig. */
export function loadConfig(cwd?: string): ClassmateConfig {
  const file = findConfigFile(cwd);
  const raw = file ? parseConfigFile(file) : undefined;
  return readConfig(raw);
}
