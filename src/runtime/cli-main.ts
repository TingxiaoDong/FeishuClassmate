#!/usr/bin/env node
/** Executable entry for the standalone CLI: `node src/runtime/cli-main.ts <cmd>` (PLAN A7). */
import { runCli } from './cli.js';
import { loadDotEnv } from './llm-env.js';

loadDotEnv();

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  });
