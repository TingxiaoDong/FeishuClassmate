# ClassmateOS 迁移状态（对照 PLAN.md）

> 分支 `feat/classmateos-runtime`，截至第 20 个提交。质量基线：
> `pnpm test` 170 通过 / 4 skipped；`pnpm typecheck` 零错误。

## 已落地（纯代码项全部完成）

### 需求一：大脑迁移（PLAN §1.2，方案 A）

| 工作项 | 位置 |
|---|---|
| A1 zod → JSON Schema 适配（zod v4 原生 `z.toJSONSchema`） | `src/runtime/zod-tool.ts` |
| A2 AgentRuntime 核心循环（runSession、上下文、tool call 环） | `src/runtime/agent-runtime.ts` |
| A3 OpenAI 兼容 LLM 客户端（base_url/header 可配 → MetaClaw proxy 可接） | `src/runtime/llm-client.ts` |
| A4 配置加载（classmate.config.yaml） | `src/runtime/config-loader.ts` |
| A5 skills 加载（SKILL.md 注入系统提示） | `src/runtime/skills-loader.ts` |
| A6 调度器（cron 式定时 skill 触发） | `src/runtime/scheduler.ts` |
| A7 CLI（status / scheduler / gateway） | `src/runtime/cli.ts` |
| A9 工具零改动接入（compat-api，30+ 飞书 tool 原样跑在新 runtime） | `src/runtime/compat-api.ts` |
| A10 ToolTrace + createBrain 组装 | `src/runtime/tool-trace.ts`、`src/runtime/brain.ts` |

### 需求二：自研平台（PLAN §2）

| 模块 | 位置 | 说明 |
|---|---|---|
| PAL 抽象层（§2.3） | `src/pal/` | FeishuAdapter + ClassmateOSAdapter 双实现，灰度可回切 |
| OpenAPI 草案 + SQL DDL | `classmateos/openapi.yaml`、`classmateos/schema.sql`、`scripts/schema-to-sql.mjs` | 23 表 |
| 账号/IM（P0） | `classmateos/server/app.ts` | 登录令牌、单聊/群聊、bot 收发、卡片 askUser 回流 |
| 表格引擎（P0） | `server/store.ts` / `pg-store.ts` / `validation.ts` | Memory/PG 双实现，字段校验，filter/sort/分页 |
| 行级权限 | `server/row-access.ts` | 保密记录仅 owner/admin 可见可改，无权一律 404 |
| 文档（P1） | docs 路由 + `server/collab.ts` | REST CRUD + **Yjs 协同编辑**（自实现 y-protocols 服务端） |
| 云盘（P1） | `server/files.ts` | HMAC 预签名 URL、路径穿越防护 |
| 日历/任务（P1） | app.ts calendar/tasks 路由 | 时间窗相交查询、创建者权限、任务可见性 |
| 报表 | `server/dashboard.ts` | 六卡聚合，缺表置空容错 |
| Bot 网关（§2.4） | `server/events.ts`、`src/pal/bot-events.ts`、`src/runtime/bot-gateway.ts` | WS 事件订阅（断点续传）、每 chat 串行、防回环 |
| 用户态 WS | `/api/v1/events/ws?token=` | 四端实时收消息，按会话成员过滤 |
| 推送通知 | `server/push.ts` | 设备注册 + 消息事件触发；APNs/FCM 占位（见下） |
| 数据迁移（P4） | `classmateos/server/migrate.ts` | 飞书导出 → 新库，`feishu_record_id` 溯源 |
| Flutter 端 | `classmateos/app/lib/` | Dart models + api_client（未编译验证，见下） |

### 未做：电子表格 Sheet（§0.3 标注 P2，使用量"少量"，按计划优先级未排期）

## 外部环境项（本机无法完成，需对应环境接入）

| 项 | 状态 | 接入方式 |
|---|---|---|
| Flutter SDK | Dart 代码已写未编译 | 装 Flutter 后 `cd classmateos/app && flutter pub get && flutter test` |
| MetaClaw proxy 真机 | `scripts/check-metaclaw.mts` 探活脚本就绪；LLM 客户端接口级兼容 | 起 proxy 后跑该脚本 |
| PostgreSQL 真库 | PgTableStore 用 fake pool 测试通过 | 设 `DATABASE_URL` 即切换（main.ts 已接） |
| Temi 硬件 | 回归测试 mock 通过 | 真机联调 |
| APNs/FCM 证书 | PushProvider 占位（未配置显式抛错） | 配证书后实现 `send`，业务链路零改动 |
| P4 真实数据迁移 | 迁移脚本就绪 | 需飞书导出数据 + PG 实例 |

## 复验命令

```bash
pnpm test        # 170 passed / 4 skipped（NO_PG 与 MetaClaw 探活跳过）
pnpm typecheck   # 零错误
```
