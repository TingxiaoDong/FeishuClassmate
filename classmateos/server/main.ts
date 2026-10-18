#!/usr/bin/env node
/**
 * ClassmateOS backend entry: `pnpm classmateos` (tsx).
 * 默认内存存储；设置 DATABASE_URL 即切 PostgreSQL（需 pnpm add pg，
 * 库表由 classmateos/schema.sql 初始化）。
 */
import { buildApp, type PlatformUser } from './app.js';
import type { TableStore } from './store.js';

const port = Number(process.env.CLASSMATE_OS_PORT ?? 8080);
const secret = process.env.CLASSMATE_OS_SECRET ?? 'dev-only-secret-change-me';
const botToken = process.env.CLASSMATE_OS_BOT_TOKEN ?? 'dev-bot-token';

// P1 开发默认账号；生产用 CLASSMATE_OS_USERS(JSON) 注入
const users: PlatformUser[] = process.env.CLASSMATE_OS_USERS
  ? (JSON.parse(process.env.CLASSMATE_OS_USERS) as PlatformUser[])
  : [
      { user_id: 'ou_admin', name: 'admin', password: 'admin', role: 'admin' },
      { user_id: 'ou_demo', name: 'demo', password: 'demo', role: 'member' },
  ];

let store: TableStore | undefined;
let storeDesc = 'memory store';
if (process.env.DATABASE_URL) {
  const { default: pg } = await import('pg');
  const { PgTableStore } = await import('./pg-store.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  store = new PgTableStore(pool);
  storeDesc = `postgres (${process.env.DATABASE_URL.replace(/\/\/.*@/, '//***@')})`;
}

const app = await buildApp({ users, secret, botToken, store });
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`ClassmateOS listening on :${port} (${storeDesc}, ${users.length} users)`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
