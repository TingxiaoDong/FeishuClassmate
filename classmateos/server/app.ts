/**
 * ClassmateOS 平台后端：按《前端接口需求文档》实现的 Fastify 应用。
 *
 * 只负责装配：CORS、请求体解析、统一错误格式、种子账号、各模块路由。
 *   routes-auth.ts            认证与用户（第 4 节）
 *   routes-im.ts              会话 / 消息 / 卡片 / 机器人网关（第 5 节）
 *   routes-realtime.ts        用户 WS、bot WS、设备推送（第 6 节）
 *   routes-files.ts           文件与云盘（第 7 节）
 *   routes-tables.ts          多维表格（第 8 节）
 *   routes-docs.ts            云文档 + 协同（第 9 节）
 *   routes-calendar-tasks.ts  日历 / 任务（第 10、11 节）
 *
 * 数据：平台数据走 Repo（MemoryRepo / PgRepo），表格记录走 TableStore（内存 / PG）。
 * buildApp() 返回未 listen 的 Fastify 实例，测试用 app.inject。
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_TABLES, type TableDef } from '../../src/bitable/schema.js';
import { hashPassword } from './auth.js';
import { CollabHub, collabTextFromUpdate } from './collab.js';
import { BOT_ID, createCtx, fail, type Ctx } from './context.js';
import { buildDashboardSummary } from './dashboard.js';
import { BotEventBus } from './events.js';
import { LocalFileStore } from './files.js';
import { MemoryRepo } from './memory-repo.js';
import { MemoryPushProvider, type PushProvider } from './push.js';
import { nowIso, type Repo, type Role } from './repo.js';
import { registerAuthRoutes } from './routes-auth.js';
import { registerCalendarTaskRoutes } from './routes-calendar-tasks.js';
import { registerDocRoutes } from './routes-docs.js';
import { registerFileRoutes } from './routes-files.js';
import { registerImRoutes } from './routes-im.js';
import { registerRealtimeRoutes } from './routes-realtime.js';
import { registerTableRoutes } from './routes-tables.js';
import { MemoryTableStore, type TableStore } from './store.js';
import { registerConsole } from './console.js';

export interface PlatformUser {
  user_id: string;
  name: string;
  password: string;
  email?: string;
  role: Role;
  department?: string;
  title?: string;
  avatar_url?: string;
}

export interface AppOptions {
  /** 种子账号：库里没有才插入（已有账号不会被覆盖，改密码请用管理员接口）。 */
  users: PlatformUser[];
  /** HMAC secret。 */
  secret: string;
  /** Bot 网关令牌（X-Bot-Token）。 */
  botToken?: string;
  /** 平台数据层；缺省 MemoryRepo。PgRepo 在这里传入。 */
  repo?: Repo;
  /** 表格记录存储；缺省 MemoryTableStore。 */
  store?: TableStore;
  eventBus?: BotEventBus;
  /** 文件存储；缺省用临时目录的 LocalFileStore。 */
  fileStore?: LocalFileStore;
  /** 推送 provider；缺省 MemoryPushProvider（真实 APNs/FCM 属外部环境项）。 */
  pushProvider?: PushProvider;
  /** 单文件上限（字节），默认 200 MB。 */
  maxFileSize?: number;
  /** 每人云盘配额（字节），默认 10 GB。 */
  driveQuota?: number;
  /** WS 心跳间隔，默认 30 秒（测试可调小）。 */
  heartbeatMs?: number;
  /** 打印请求日志。 */
  logger?: boolean;
}

const MB = 1024 * 1024;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const maxFileSize = opts.maxFileSize ?? 200 * MB;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * MB });

  // CORS：Flutter Web / 浏览器跨源调试（内网开发放开，生产可收紧为白名单）。
  app.addHook('onSend', async (_req, reply) => {
    reply
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-headers', 'content-type, authorization, x-bot-token, range')
      .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      .header('access-control-expose-headers', 'content-disposition, content-length, content-range, accept-ranges')
      .header('access-control-max-age', '600');
  });
  app.options('/*', async (_req, reply) => reply.code(204).send());

  // websocket 插件必须先就绪，{websocket:true} 路由才能正确注册 upgrade 处理。
  await app.register(fastifyWebsocket);

  // JSON：空请求体（如带 content-type 的 DELETE）按无 body 处理，不报 400
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (!text.trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('请求体不是合法的 JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  // 其他类型（文件直传等）一律按原始字节
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // 统一错误格式 { message, code? }
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status === 413) {
      return fail(reply, 413, `文件不能超过 ${Math.round(maxFileSize / MB)} MB`, { code: 'FILE_TOO_LARGE' });
    }
    if (status >= 500) {
      req.log.error(err);
      if (!opts.logger) console.error('[classmateos]', req.method, req.url, err);
      return fail(reply, 500, '服务器内部错误，请稍后再试', { code: 'INTERNAL' });
    }
    return fail(reply, status, err.message || '请求无效', err.code ? { code: err.code } : {});
  });
  app.setNotFoundHandler((req, reply) => fail(reply, 404, `接口不存在：${req.method} ${req.url.split('?')[0]}`, { code: 'NOT_FOUND' }));

  const repo: Repo = opts.repo ?? new MemoryRepo();
  await repo.init?.();
  const store = opts.store ?? new MemoryTableStore();
  const eventBus = opts.eventBus ?? new BotEventBus();
  const tableDefs = new Map<string, TableDef>(ALL_TABLES.map((t) => [t.key, t]));
  const fileStore =
    opts.fileStore ??
    new LocalFileStore({
      dir: join(tmpdir(), `classmateos-files-${process.pid}`),
      urlPrefix: '/api/v1/files',
      secret: opts.secret,
    });

  // 协同编辑枢纽：房间首建播种 / 末连接断开持久化
  const collabHub = new CollabHub({
    loadSeed: async (docId) => {
      const d = await repo.getDoc(docId);
      return d ? { markdown: d.markdown, yjs_update: d.yjs_update } : undefined;
    },
    onPersist: async (docId, yjsUpdate) => {
      const d = await repo.getDoc(docId);
      if (!d) return;
      const markdown = collabTextFromUpdate(yjsUpdate);
      if (d.yjs_update === yjsUpdate) return;
      let updatedAt = nowIso();
      if (updatedAt <= d.updated_at) updatedAt = new Date(Date.parse(d.updated_at) + 1).toISOString();
      await repo.updateDoc({ ...d, yjs_update: yjsUpdate, markdown, updated_at: updatedAt });
    },
  });

  // 种子账号 + 机器人账号（让成员目录能翻译 bot 的名字；随机密码，不能登录）
  const now = nowIso();
  const seeds = [
    ...opts.users,
    ...(opts.users.some((u) => u.user_id === BOT_ID)
      ? []
      : [{ user_id: BOT_ID, name: '飞书同学', password: randomBytes(24).toString('hex'), role: 'bot' as Role }]),
  ];
  for (const u of seeds) {
    if (await repo.getUser(u.user_id)) continue;
    await repo.insertUserIfMissing({
      user_id: u.user_id,
      name: u.name,
      email: u.email ?? null,
      role: u.role,
      avatar_url: u.avatar_url ?? null,
      department: u.department ?? null,
      title: u.title ?? null,
      phone: null,
      status_text: null,
      password_hash: hashPassword(u.password),
      disabled: false,
      created_at: now,
      updated_at: now,
    });
  }

  const ctx: Ctx = createCtx({
    app,
    repo,
    store,
    eventBus,
    fileStore,
    collabHub,
    secret: opts.secret,
    botToken: opts.botToken,
    tableDefs,
    maxFileSize,
    driveQuota: opts.driveQuota ?? 10 * 1024 * MB,
  });

  app.get('/api/v1/health', async () => ({ ok: true, time: nowIso() }));

  registerAuthRoutes(ctx);
  registerImRoutes(ctx);
  registerRealtimeRoutes(ctx, { pushProvider: opts.pushProvider ?? new MemoryPushProvider(), heartbeatMs: opts.heartbeatMs });
  registerFileRoutes(ctx);
  registerTableRoutes(ctx);
  registerDocRoutes(ctx);
  registerCalendarTaskRoutes(ctx);

  // ---------------- 报表视图（吸收 dashboard/ 六卡） ----------------
  app.get('/api/v1/dashboard/summary', async (req, reply) => {
    if (!(await ctx.requireUser(req, reply))) return;
    return buildDashboardSummary(store);
  });

  registerConsole(app);

  return app;
}
