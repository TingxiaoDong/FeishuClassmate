#!/usr/bin/env node
/**
 * ClassmateOS backend entry: `pnpm classmateos` (tsx).
 * P1 内存存储 + 环境变量注入用户；P2 切 PostgreSQL。
 */
import { buildApp, type PlatformUser } from './app.js';

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

const app = await buildApp({ users, secret, botToken });
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`ClassmateOS listening on :${port} (memory store, ${users.length} users)`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
