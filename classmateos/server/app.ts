import { registerAdminRoutes } from './routes-admin.js';
import { RoleService } from './roles.js';
import { AuditLogService } from './audit-log.js';
import { OrganizationService } from './organization.js';
import { registerDepartmentRoutes } from './routes-departments.js';
/**
 * ClassmateOS 平台后端：按《前端接口需求文档》实现的 Fastify 应用。
 *
 * 只负责装配：CORS、请求体解析、统一错误格式、种子账号、各模块路由。
 *   routes-auth.ts            认证与用户（第 4 节）
 *   routes-im.ts              会话 / 消息 / 卡片 / 机器人网关（第 5 节）
 *   routes-realtime.ts        用户 WS、bot WS、设备推送（第 6 节）
 *   routes-files.ts           文件与云盘（第 7 节）
 *   routes-tables.ts          多维表格（第 8 节 + 二期 R-BT-01~06：字段、视图、批量、实时）
 *   notifications.ts          通知中心、通知设置、推送规则（二期 R-NT-01 / 02）
 *   routes-docs.ts            云文档 + 协同（第 9 节）
 *   routes-calendar-tasks.ts  日历 / 任务（第 10、11 节）
 *
 * 数据：平台数据走 Repo（MemoryRepo / PgRepo），表格记录走 TableStore（内存 / PG）。
 * buildApp() 返回未 listen 的 Fastify 实例，测试用 app.inject。
 */

import { isValidTimeZone, type Zone } from './rrule.js';
import { registerImPlusRoutes } from './routes-im-plus.js';
import { registerSearchRoutes } from './routes-search.js';
import { LinkPreviewService, defaultLinkFetcher, type LinkFetcher } from './link-preview.js';
import { DocVersions } from './doc-extras.js';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_TABLES, type TableDef } from '../../src/bitable/schema.js';
import { hashPassword } from './auth.js';
import { AuthService } from './auth-service.js';
import { CollabHub, collabTextFromUpdate } from './collab.js';
import { BOT_ID, bearer, createCtx, fail, type Ctx } from './context.js';
import { buildDashboardSummary, DashboardRangeError, parseDashboardRange } from './dashboard.js';
import { BotEventBus } from './events.js';
import { LocalFileStore } from './files.js';
import { MemoryRepo } from './memory-repo.js';
import { MemoryPushProvider, type PushProvider } from './push.js';
import { customTableDef } from './custom-tables.js';
import { NotificationService, Presence, PushDispatcher, registerNotificationRoutes } from './notifications.js';
import { Clock } from './view-engine.js';
import { nowIso, type CustomTableRecord, type Repo, type Role } from './repo.js';
import { registerAuthRoutes } from './routes-auth.js';
import { registerCalendarTaskRoutes } from './routes-calendar-tasks.js';
import { registerDocRoutes } from './routes-docs.js';
import { registerFileRoutes } from './routes-files.js';
import { registerImRoutes } from './routes-im.js';
import { registerRealtimeRoutes } from './routes-realtime.js';
import { registerTableRoutes } from './routes-tables.js';
import { MemoryTableStore, type TableStore } from './store.js';
import { registerConsole } from './console.js';
import { AgentAuditLog, BotScopePolicy, registerAgentAudit, type AgentScopeOptions } from './agent-principal.js';
import { registerAgentContext } from './agent-context.js';
import { registerAgentRoutes } from './routes-agent.js';
import { registerAutomationRoutes } from './routes-automation.js';
import { registerRobotRoutes } from './routes-robots.js';
import { registerWorkbenchRoutes } from './routes-workbench.js';
import { registerQrLoginRoutes } from './routes-qr.js';
import { registerImportExportRoutes } from './routes-import-export.js';
import { registerWikiRoutes } from './routes-wiki.js';

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
  /** Web 版地址（分享链接域名），也可用环境变量 CLASSMATE_OS_WEB_URL。 */
  webUrl?: string;
  /** Bot 网关令牌（X-Bot-Token）。 */
  botToken?: string;
  /** 机器人代办作用域（X-On-Behalf-Of），缺省用 DEFAULT_BOT_DENY 黑名单。 */
  botScopes?: AgentScopeOptions;
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
  /** 「今天 / 本周」、免打扰时段按哪个时区算（相对 UTC 的分钟数），默认 480（北京时间）。 */
  timezoneOffsetMinutes?: number;
  /** 迭代 4：外部链接预览抓取器；false 关闭，默认用带防 SSRF 的抓取器。 */
  linkPreviewFetcher?: LinkFetcher | false;
  /** 本服务对外地址（内部分享链接 /app/... 的前缀，不抓预览）。 */
  publicBaseUrl?: string;
  /** 日历默认时区（IANA），日程没带 timezone 时按它展开重复规则。 */
  calendarTimezone?: string;
  /** 测试用：固定「现在」。 */
  now?: () => number;
  /** 是否定时扫描「任务即将到期」，默认 true。 */
  notificationScanner?: boolean;
  /** 停止编辑多久后自动存历史版本，默认 2 分钟（测试可调小）。 */
  docVersionIdleMs?: number;
}

/**
 * 二期功能开关（《二期功能需求文档》2.1）：只打开后端已经实现的功能。
 * 缺失的 key 前端当作 false。
 */
export const CAPABILITIES: Record<string, boolean> = {
  'table.create': true,
  'table.fields': true,
  'table.views': true,
  'table.realtime': true,
  'table.batch': true,
  'record.history': true,
  // 二期迭代 2：云文档（含文件夹、收藏、回收站）
  'doc.permissions': true,
  'doc.folders': true,
  'doc.comments': true,
  'doc.versions': true,
  'doc.presence': true,
  // 二期迭代 2：知识库（空间、目录树、页面即文档、搜索 / 最近 / 收藏）
  wiki: true,
  approval: false,
  search: true,
  // 二期迭代 4：消息增强
  'message.thread': true,
  'message.reaction': true,
  'message.forward': true,
  'message.urgent': true,
  'message.favorite': true,
  'message.pin': true,
  'message.link_preview': true,
  'message.rich_text': true,
  // 二期迭代 3（审批已取消，approval 保持 false）
  'calendar.recurrence': true,
  'task.subtasks': true,
  'task.followers': true,
  'task.comments': true,
  'task.lists': true,
  notifications: true,
  // 迭代 5 批次 2：管理后台（成员、角色、操作日志、安全设置）与组织架构
  admin: true,
  'org.departments': true,
  // 报表时间范围（week / month / semester / custom）
  'dashboard.range': true,
  // 工作台内置应用顺序与个人快捷方式
  'workbench.apps': true,
  // 多维表格：表权限、表管理（改名 / 复制 / 删除）、记录评论
  'table.permissions': true,
  'table.manage': true,
  'record.comments': true,
  // 导入导出：表格 xlsx / csv 导入导出、文档 PDF / Word 导出、成员批量导入
  'table.import': true,
  'table.export': true,
  'doc.export': true,
  'user.import': true,
  // 迭代 5 批次 1：「我的」页改密码、登录设备
  'auth.password': true,
  'auth.sessions': true,
  sheet: false,
  'auth.qr_login': true,
};

const MB = 1024 * 1024;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const maxFileSize = opts.maxFileSize ?? 200 * MB;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * MB });
  // 请求级代办上下文（记录历史、文档版本等写入点据此打「代办」标记）
  registerAgentContext(app);

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
  // eslint-disable-next-line prefer-const
  let docVersions: DocVersions | undefined;
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
      docVersions?.touch(docId, null);
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

  // 自定义数据表（POST /tables 建的）：启动时注册到表格存储（PG 模式会补建缺失的物理表）
  const customTables = new Map<string, CustomTableRecord>();
  for (const t of await repo.listCustomTables()) {
    const def = customTableDef(t);
    await store.registerTable?.(def);
    tableDefs.set(t.key, def);
    customTables.set(t.key, t);
  }

  const ctx: Ctx = createCtx({
    app,
    repo,
    auth: new AuthService(repo),
    roles: new RoleService(repo),
    org: new OrganizationService(repo),
    auditLog: new AuditLogService(repo),
    store,
    eventBus,
    fileStore,
    collabHub,
    secret: opts.secret,
    botToken: opts.botToken,
    botPolicy: new BotScopePolicy(opts.botScopes),
    agentAudit: new AgentAuditLog(5000, repo),
    tableDefs,
    customTables,
    maxFileSize,
    driveQuota: opts.driveQuota ?? 10 * 1024 * MB,
  });

  docVersions = new DocVersions(ctx, opts.docVersionIdleMs);
  app.addHook('onClose', async () => docVersions?.stop());

  registerAgentRoutes(ctx);
  registerAutomationRoutes(ctx);
  registerRobotRoutes(ctx);
  registerAgentAudit(app, {
    audit: ctx.agentAudit,
    isBot: (req) => ctx.isBot(req),
    isAdmin: async (req) => {
      const t = bearer(req);
      const r = await ctx.verifyWsToken(t);
      return 'user' in r && r.user.role === 'admin';
    },
  });

  app.get('/api/v1/health', async () => ({ ok: true, time: nowIso() }));

  // 功能开关：不需要登录（登录页也可能要按它显示扫码登录等入口）
  // web_url：分享链接域名（迭代 5 第 2 节），没配置时不返回该字段
  const webUrl = (opts.webUrl ?? process.env.CLASSMATE_OS_WEB_URL ?? '').trim().replace(/\/+$/, '');
  app.get('/api/v1/capabilities', async () => ({ features: { ...CAPABILITIES }, ...(webUrl ? { web_url: webUrl } : {}) }));

  const envTz = Number(process.env.CLASSMATE_OS_TZ_OFFSET_MINUTES);
  const clock = new Clock(opts.timezoneOffsetMinutes ?? (Number.isFinite(envTz) ? envTz : 480), opts.now ?? Date.now);
  const pushProvider = opts.pushProvider ?? new MemoryPushProvider();
  const presence = new Presence();
  const pushDispatcher = new PushDispatcher(repo, pushProvider, presence, clock);
  const notifications = new NotificationService(ctx, pushDispatcher, clock);
  notifications.attachEventSources();
  if (opts.notificationScanner !== false) notifications.startScanner();
  app.addHook('onClose', async () => notifications.stop());

  await ctx.org.migrate();
  registerDepartmentRoutes(ctx);
  registerAuthRoutes(ctx);
  registerQrLoginRoutes(ctx);
  registerAdminRoutes(ctx);
  const imPlus = registerImPlusRoutes(ctx, { notifications });
  const linkFetcher = opts.linkPreviewFetcher === undefined ? defaultLinkFetcher : opts.linkPreviewFetcher;
  registerImRoutes(ctx, {
    chatExtras: imPlus.chatExtras,
    linkPreview: linkFetcher ? new LinkPreviewService(linkFetcher) : undefined,
    publicBaseUrl: opts.publicBaseUrl ?? process.env.COS_PUBLIC_BASE_URL,
  });
  registerRealtimeRoutes(ctx, { pushProvider, heartbeatMs: opts.heartbeatMs, presence, push: pushDispatcher });
  registerFileRoutes(ctx);
  const tables = registerTableRoutes(ctx, { clock, notifications });
  registerImportExportRoutes(ctx, tables, clock.tzOffsetMinutes);
  registerNotificationRoutes(ctx, notifications, pushDispatcher);
  // 测试 / 运维用的内部句柄
  app.decorate('cos', { ctx, tables, notifications, push: pushDispatcher, presence, clock });
  registerDocRoutes(ctx, notifications, docVersions!);
  registerWorkbenchRoutes(ctx, CAPABILITIES);
  registerWikiRoutes(ctx);
  // 日历默认时区：参数 > 环境变量 COS_CALENDAR_TZ > 指定了固定偏移时用偏移 > Asia/Shanghai
  const envCalTz = process.env.COS_CALENDAR_TZ;
  const calendarZone: Zone = opts.calendarTimezone
    ?? (isValidTimeZone(envCalTz) ? envCalTz : opts.timezoneOffsetMinutes !== undefined ? opts.timezoneOffsetMinutes : 'Asia/Shanghai');
  registerCalendarTaskRoutes(ctx, { notifications, calendarZone: () => calendarZone });
  registerSearchRoutes(ctx, { defaultZone: () => calendarZone, now: opts.now });

  // ---------------- 报表视图（吸收 dashboard/ 六卡） ----------------
  app.get('/api/v1/dashboard/summary', async (req, reply) => {
    if (!(await ctx.requireUser(req, reply))) return;
    const now = clock.now();
    let range;
    try {
      range = parseDashboardRange(req.query as { range?: string; start_at?: string; end_at?: string }, now, clock.tzOffsetMinutes);
    } catch (e) {
      if (e instanceof DashboardRangeError) return fail(reply, 422, e.message, { code: 'VALIDATION_FAILED', errors: [{ field: 'range', message: e.message }] });
      throw e;
    }
    return buildDashboardSummary(store, now, range);
  });

  registerConsole(app);

  return app;
}
