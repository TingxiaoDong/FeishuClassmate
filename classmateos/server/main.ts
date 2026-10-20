#!/usr/bin/env node
/**
 * ClassmateOS backend entry: `pnpm classmateos`（tsx）。
 *
 * 环境变量：
 *   DATABASE_URL              设置后数据存 PostgreSQL（启动时自动建表，可重复执行）；不设则存内存（重启丢失）
 *   CLASSMATE_OS_PORT         端口，默认 8080
 *   CLASSMATE_OS_HOST         监听地址，开发默认 127.0.0.1（手机联调设 0.0.0.0），生产默认 0.0.0.0
 *   CLASSMATE_OS_SECRET       令牌签名密钥（生产必须设置，≥16 位，不能是默认值）
 *   CLASSMATE_OS_BOT_TOKEN    机器人网关令牌（同上）
 *   NODE_ENV=production       生产模式：缺密钥或用默认值直接拒绝启动，不创建 admin/admin；CLASSMATE_OS_DEV=1 可强制开发模式
 *   CLASSMATE_OS_USERS        种子账号 JSON：[{user_id,name,password,role,department?,title?,email?}]
 *   CLASSMATE_OS_FILE_DIR     文件存储目录，默认 ./data/files（PG 模式）或系统临时目录（内存模式）
 *   CLASSMATE_OS_MAX_FILE_MB  单文件上限，默认 200
 *   CLASSMATE_OS_QUOTA_GB     每人云盘配额，默认 10
 */
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type PlatformUser } from './app.js';
import { LocalFileStore } from './files.js';
import type { Repo } from './repo.js';
import type { TableStore } from './store.js';
import { checkStartupConfig } from './startup-guard.js';
import { loadDotEnv } from '../../src/runtime/llm-env.js';

loadDotEnv();

const port = Number(process.env.CLASSMATE_OS_PORT ?? 8080);
// 代码审查 B2：生产环境缺密钥 / 用默认值直接退出
const startup = checkStartupConfig(process.env);
for (const w of startup.warnings) console.warn(`[classmateos] 警告：${w}`);
if (startup.errors.length) {
  for (const e of startup.errors) console.error(`[classmateos] 启动失败：${e}`);
  process.exit(1);
}
const { secret, botToken, host } = startup;
// 开发默认账号 admin/admin、demo/demo；生产只用 CLASSMATE_OS_USERS(JSON)，首次登录强制改密
const users: PlatformUser[] = startup.users.map((u) => (startup.forcePasswordChange ? { ...u, must_change_password: true } : u));

let store: TableStore | undefined;
let repo: Repo | undefined;
let storeDesc = 'memory（重启后数据丢失）';
const pgMode = !!process.env.DATABASE_URL;

if (pgMode) {
  const { default: pg } = await import('pg');
  const { PgTableStore } = await import('./pg-store.js');
  const { PgRepo } = await import('./pg-repo.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 10) });
  pool.on('error', (err) => console.error('[pg] idle client error', err));
  // 23 张业务表（schema.sql，IF NOT EXISTS）→ 平台表（PgRepo.init 执行 schema-platform.sql）
  const coreSql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(coreSql);
  const tableStore = new PgTableStore(pool);
  await tableStore.ensureMetaColumns();
  store = tableStore;
  repo = new PgRepo(pool);
  storeDesc = `postgres (${process.env.DATABASE_URL!.replace(/\/\/.*@/, '//***@')})`;
}

const fileDir = process.env.CLASSMATE_OS_FILE_DIR
  ? resolve(process.env.CLASSMATE_OS_FILE_DIR)
  : pgMode
    ? resolve('data/files')
    : join(tmpdir(), 'classmateos-files');
const fileStore = new LocalFileStore({ dir: fileDir, urlPrefix: '/api/v1/files', secret });

const app = await buildApp({
  users,
  secret,
  botToken,
  // 机器人代办删除类操作默认关闭；管理员确认后设 CLASSMATE_OS_BOT_ALLOW_DELETE=1 打开
  botScopes: { allowDestructive: process.env.CLASSMATE_OS_BOT_ALLOW_DELETE === '1' },
  store,
  repo,
  fileStore,
  maxFileSize: Number(process.env.CLASSMATE_OS_MAX_FILE_MB ?? 200) * 1024 * 1024,
  driveQuota: Number(process.env.CLASSMATE_OS_QUOTA_GB ?? 10) * 1024 * 1024 * 1024,
});
app
  .listen({ port, host })
  .then(() =>
    console.log(`ClassmateOS listening on ${host}:${port} (${startup.production ? 'production' : 'dev'}, ${storeDesc}, files: ${fileDir}, seed users: ${users.length})`),
  )
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
