# Feishu Classmate · ClassmateOS

面向实验室协作场景的桌面协作平台与 Agent。平台提供即时通讯、云文档、云盘、知识库、任务、日历、通讯录、多维表格和工作台看板；Agent 通过统一的平台工具代表当前用户完成查询和操作。

## 当前架构

```text
Flutter macOS 客户端
        │ REST / WebSocket
        ▼
ClassmateOS 后端（Fastify）
        │
        ├── 账号、权限与会话
        ├── IM、文档、云盘、知识库
        ├── 任务、日历、通讯录、通知
        ├── 多维表格与文件夹
        └── 工作台自定义看板
        ▲
        │ Bot 事件与平台工具
Agent Runtime ── OpenAI 兼容 LLM
```

Agent 只通过 ClassmateOS 的 Bot 令牌和代办身份执行平台操作。权限由平台按当前用户校验，删除、批量修改和跨会话发送等高风险操作由平台发起确认流程。

## 功能

- **即时通讯**：单聊、群聊、文件发送、Bot 消息和操作确认。
- **云文档**：新建、编辑、搜索和管理文档；新建后会立即出现在当前列表。
- **云盘**：上传、查看和移出文件，区分“我的空间”和“来自会话”。
- **知识库**：知识空间、目录和页面管理，与云文档分开处理。
- **任务与日历**：创建、查询、修改、删除任务和日程。
- **多维表格**：自定义数据表、字段、记录、视图和可嵌套文件夹。
- **工作台看板**：从任意可访问的数据表创建数字统计、条形图、占比条和最近记录等看板，也可以由 Agent 按自然语言需求生成。
- **Agent 工具**：表格、文档、知识库、任务、日历、云盘、通讯录、通知、搜索和工作台看板均有对应工具；未覆盖的接口可通过接口目录和受控通用调用使用。
- **Temi 侧车**：可选的机器人控制与语音链路，默认支持模拟模式。

## 环境要求

| 依赖 | 要求 |
|---|---|
| Node.js | 22 或更高版本 |
| pnpm | 10 或更高版本 |
| Flutter | macOS 客户端构建所需版本 |
| Python | 仅启用 Temi 侧车时需要 |
| PostgreSQL | 可选；未配置时使用内存存储 |

## 配置

复制环境变量模板并按需修改：

```bash
cp .env.example .env
```

主要配置项：

```dotenv
# 大模型（OpenAI 兼容接口）
LLM_BASE_URL=
LLM_API_KEY=
CLASSMATE_MODEL=deepseek-chat

# ClassmateOS
CLASSMATE_OS_PORT=8080
CLASSMATE_OS_URL=http://127.0.0.1:8080/api/v1
CLASSMATE_OS_BOT_TOKEN=dev-bot-token

# 无真机时启用 Temi 模拟
TEMI_MOCK=1
CLASSMATE_ROBOT_M4=1
```

如果设置 `DATABASE_URL`，后端会使用 PostgreSQL；未设置时使用内存存储，后端重启后测试数据会清空。

## 启动开发环境

安装依赖：

```bash
pnpm install
```

分别启动平台后端和 Agent 网关：

```bash
pnpm classmateos
pnpm classmate gateway
```

也可以使用开发启动脚本，一次启动后端、Agent 网关和可选的 Temi 侧车：

```bash
./scripts/dev.sh
```

启动后：

- ClassmateOS API 默认监听 `8080`。
- Agent 网关连接 ClassmateOS 的 Bot 事件流。
- Flutter 客户端从 `classmateos/app` 构建和启动。

## 客户端

进入 Flutter 客户端目录后执行：

```bash
cd classmateos/app
flutter pub get
flutter run -d macos
```

构建 macOS 应用：

```bash
flutter build macos --no-pub
```

客户端包含以下主要页面：

- 消息
- 任务
- 日历
- 云文档
- 云盘
- 知识库
- 通讯录
- 多维表格
- 工作台

## Agent 命令

```bash
pnpm classmate status       # 查看配置和连通性
pnpm classmate gateway      # 启动 Bot 网关
pnpm classmate scheduler    # 前台运行自动任务
pnpm classmate schema       # 输出 PostgreSQL DDL
```

Agent 平台工具按功能分组：

| 功能 | 工具 |
|---|---|
| 多维表格 | `cos_table` |
| 云文档 | `cos_doc` |
| 知识库 | `cos_wiki` |
| 任务 | `cos_task` |
| 日历 | `cos_calendar` |
| 即时通讯 | `cos_im` |
| 云盘 | `cos_drive` |
| 通讯录 | `cos_contact` |
| 通知 | `cos_notify` |
| 工作台看板 | `cos_workbench` |
| 全局搜索 | `cos_search` |
| 接口目录与受控调用 | `cos_api_catalog`、`cos_api` |

知识库页面必须使用 `cos_wiki`，云文档使用 `cos_doc`，两者不会互相替代。

## 开发检查

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm format
```

测试覆盖 Agent Runtime、平台接口、权限、自动化、消息、文档、云盘、知识库、日历、任务、多维表格和工作台看板。

## 目录结构

```text
src/
├── cos-sdk/              ClassmateOS API 客户端与接口目录
├── runtime/              Agent Runtime、会话循环、网关、调度器
├── tools/cos/            平台工具注册
├── tools/robot/          Temi 工具
├── pal/                  ClassmateOS 平台适配层
└── robot/                机器人控制与语音链路

classmateos/
├── app/                  Flutter macOS 客户端
├── server/               Fastify 后端
├── openapi.yaml          平台接口定义
└── schema.sql            PostgreSQL 建表脚本

skills/                   Agent 技能说明
scripts/                  启动、评测和开发脚本
tests/                    当前新栈测试
```

## 数据与权限

开发环境默认使用内存存储，适合本地联调。需要保留数据时配置 PostgreSQL 并执行对应建表脚本。

平台会在服务端执行权限检查：管理员可以管理所有资源；普通用户只能删除自己创建且有权限管理的表、文件夹或文件。Agent 通过代办身份调用接口，不能绕过平台权限。

## License

MIT
