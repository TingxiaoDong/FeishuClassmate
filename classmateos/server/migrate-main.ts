#!/usr/bin/env node
/**
 * 迁移 CLI（PLAN §3-P4）：
 *   pnpm tsx classmateos/server/migrate-main.ts [--dry-run] [--tables projects,gantt,...]
 *
 * 源：飞书（loadConfig + FEISHU_APP_ID/SECRET）
 * 目标：ClassmateOS（CLASSMATE_OS_URL / CLASSMATE_OS_TOKEN）
 */
import { loadConfig } from '../../src/runtime/config-loader.js';
import { getFeishuClient } from '../../src/util/feishu-api.js';
import { createClassmateOSAdapter } from '../../src/pal/classmateos-adapter.js';
import { migrateTables, formatReport, CORE_TABLES } from './migrate.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tablesIdx = args.indexOf('--tables');
const tableKeys = tablesIdx >= 0 ? args[tablesIdx + 1]?.split(',').filter(Boolean) : undefined;

const config = loadConfig();
const reader = getFeishuClient(config);
const writer = createClassmateOSAdapter({
  baseUrl: process.env.CLASSMATE_OS_URL ?? 'http://localhost:8080/api/v1',
  accessToken: process.env.CLASSMATE_OS_TOKEN,
}).table;

console.log(`migrating tables: ${(tableKeys ?? CORE_TABLES).join(', ')}${dryRun ? ' [DRY-RUN]' : ''}`);
const reports = await migrateTables({
  config,
  reader,
  writer,
  tableKeys,
  dryRun,
  onLog: (m) => console.log(m),
});
console.log('\n' + formatReport(reports));
process.exitCode = reports.some((r) => r.failed > 0) ? 1 : 0;
