<div align="center">

# ClassmateOS · 实验室协作平台

<img src="assets/hero.png" alt="ClassmateOS · 让协作更智能、更轻松" width="100%" />

<br/>

<img src="https://img.shields.io/badge/ClassmateOS-新栈-2563eb?style=flat-square" />
<img src="https://img.shields.io/badge/Agent_Runtime-平台原生-7c3aed?style=flat-square" />
<img src="https://img.shields.io/badge/Node-22%2B-339933?style=flat-square&logo=node.js&logoColor=white" />
<img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" />
<img src="https://img.shields.io/badge/Flutter-macOS-02569B?style=flat-square&logo=flutter&logoColor=white" />
<img src="https://img.shields.io/badge/Tools-平台集成-blueviolet?style=flat-square" />
<img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" />

### 实验室办公场景下的**智能伙伴** · Lab Assistant for the Robotics Lab

**ClassmateOS**(平台) + **Agent Runtime**(智能中枢) + **Temi**(可选机器人侧车)

[✨ Features](#-features) · [🚀 Quick Start](#-quick-start) · [🛠️ Skills](#️-skills-catalog) · [🏗️ Architecture](#️-architecture) · [📊 Data](#-data-model)

</div>

---

## 🔭 Overview

**ClassmateOS** 是面向实验室协作场景的桌面平台与 Agent，提供统一的消息、文档、数据和自动化能力，帮助实验室：

- 💬 **进行协作沟通**：单聊、群聊、文件发送、机器人消息和操作确认
- 📋 **管理项目进度**：任务、日历、多维表格和工作台看板协同使用
- 📚 **沉淀实验室知识**：云文档、知识库、目录和页面统一管理
- 🔬 **管理实验数据**：自定义数据表、字段、记录、视图和嵌套文件夹
- 🤖 **使用 Agent 助手**：通过自然语言查询和操作平台数据，权限按当前用户执行
- 🦾 **连接实验室机器人**：通过可选 Temi 侧车完成控制和语音链路

![Demo](assets/飞书同学预览.gif.gif)

> 面向实验室协作与智能办公场景。

---

## ✨ Features

| 类别 | 功能 | 平台能力 |
|---|---|---|
| 💬 **即时通讯** | 单聊、群聊、文件发送、Bot 消息、Markdown 消息和操作确认 | `cos_im` |
| 📄 **云文档** | 新建、编辑、搜索和管理文档，新建后立即更新列表 | `cos_doc` |
| 📚 **知识库** | 知识空间、目录和页面管理，与云文档分开处理 | `cos_wiki` |
| 📊 **多维表格** | 自定义数据表、字段、记录、视图和可嵌套文件夹 | `cos_table` |
| 📈 **工作台看板** | 数字统计、条形图、占比条、最近记录，也支持 Agent 按需求生成 | `cos_workbench` |
| ✅ **任务与日历** | 创建、查询、修改、删除任务和日程 | `cos_task` · `cos_calendar` |
| ☁️ **云盘与通讯录** | 文件上传、管理、搜索，以及成员和联系人查询 | `cos_drive` · `cos_contact` |
| 🤖 **Temi 控制** | 自然语言控制机器人，支持模拟模式和可选侧车 | `tools/robot` |

---

## 🏗️ Architecture

![ClassmateOS 系统架构](assets/architecture.png)

完整链路：**Flutter macOS 客户端** → **ClassmateOS Fastify 后端** → **Agent Runtime** → **OpenAI 兼容大模型**。

ClassmateOS 后端统一负责账号、权限、会话、消息、文档、云盘、知识库、任务、日历、通讯录、多维表格和工作台看板。Agent 通过 Bot 令牌和代办身份调用平台接口，服务端按当前用户权限执行并记录审计。

Agent 平台工具分为三层：常用功能使用 `cos_table`、`cos_doc`、`cos_wiki`、`cos_task` 等专用工具；资源查询由资源工具处理；未覆盖的功能先通过 `cos_api_catalog` 查询，再由受控的 `cos_api` 调用。

删除、批量修改和跨会话发送等高风险操作由平台发起确认流程。普通用户不能通过 Agent 绕过资源权限。

---

## 🚀 Quick Start

### 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 22+ | Agent Runtime 和服务端 |
| pnpm | 10+ | 包管理 |
| Flutter | macOS 客户端所需版本 | 构建桌面客户端 |
| Python | 3.10+ | 仅启用 Temi 侧车时需要 |
| PostgreSQL | 可选 | 未配置时使用内存存储 |

### 2. 安装 + 配置

```bash
# 克隆 + 装依赖
git clone https://github.com/TingxiaoDong/FeishuClassmate.git
cd FeishuClassmate
pnpm install

# 配置 ClassmateOS 和 Agent
cp .env.example .env
# 按需编辑 .env，填写 LLM_BASE_URL / LLM_API_KEY / CLASSMATE_OS_BOT_TOKEN
```

主要配置项：

```dotenv
# 大模型（OpenAI 兼容接口）
LLM_BASE_URL=
LLM_API_KEY=
CLASSMATE_MODEL=deepseek-chat

# ClassmateOS 平台
CLASSMATE_OS_PORT=8080
CLASSMATE_OS_URL=http://127.0.0.1:8080/api/v1
CLASSMATE_OS_BOT_TOKEN=dev-bot-token

# 无真机时启用 Temi 模拟
TEMI_MOCK=1
CLASSMATE_ROBOT_M4=1
```

### 3. 启动平台和 Agent

分别启动平台后端和 Agent 网关：

```bash
pnpm classmateos
pnpm classmate gateway
```

也可以一次启动后端、Agent 网关和可选的 Temi 侧车：

```bash
./scripts/dev.sh
```

启动后：

- ClassmateOS API 默认监听 `8080`
- Agent 网关连接 ClassmateOS 的 Bot 事件流
- Flutter 客户端从 `classmateos/app` 构建和启动

### 4. 启动客户端

```bash
cd classmateos/app
flutter pub get
flutter run -d macos
```

构建 macOS 应用：

```bash
flutter build macos --no-pub
```

---

## 🛠️ Skills Catalog

Agent 技能位于仓库的 `skills/` 目录，按需加载并通过 ClassmateOS 平台工具完成操作。

| 类型 | 作用 |
|---|---|
| 项目管理 | 项目、任务、甘特进度、逾期检查和周报 |
| 自主研究 | 从实验室知识和研究池中选题、检索并生成研究产物 |
| 学术检索 | 学术文献检索、质量评估和引用扩展 |
| 科研协作 | 预研课题、研究计划、任务拆解和时间线推进 |
| 访客导览 | 根据知识库和访客背景生成讲解内容 |
| 机器人控制 | 通过 Temi 工具完成移动、播报和感知 |

新增技能时，在 `skills/<name>/SKILL.md` 中描述触发条件、操作步骤和可用工具；系统会在 Agent 运行时按当前请求选择相关技能。

---

## 🔧 Tool Catalog

### ClassmateOS 平台工具

| 组 | Tool | 用途 |
|---|---|---|
| `table` | `cos_table` | 数据表、字段、记录、视图和文件夹 |
| `doc` | `cos_doc` | 云文档创建、编辑、查询和管理 |
| `wiki` | `cos_wiki` | 知识空间、目录和页面 |
| `task` | `cos_task` | 任务创建、查询、修改和删除 |
| `calendar` | `cos_calendar` | 日历和日程管理 |
| `im` | `cos_im` | 消息、会话和文件发送 |
| `drive` | `cos_drive` | 云盘文件上传和管理 |
| `contact` | `cos_contact` | 联系人和成员查询 |
| `notify` | `cos_notify` | 通知和提醒 |
| `workbench` | `cos_workbench` | 工作台看板管理和数据展示 |
| `search` | `cos_search` | 全局搜索 |
| `api` | `cos_api_catalog` · `cos_api` | 查询接口目录和受控调用未覆盖接口 |

知识库页面必须使用 `cos_wiki`，云文档使用 `cos_doc`，两者不会互相替代。Agent 代用户操作时，平台会执行用户权限校验。

---

## 📊 Data Model

ClassmateOS 以平台资源为中心组织数据：

| 域 | 内容 |
|---|---|
| 协作 | 用户、会话、消息、文件附件 |
| 文档 | 云文档、知识空间、目录和页面 |
| 工作管理 | 任务、日历、通知和自动化 |
| 数据表 | 自定义数据表、字段、记录、视图和嵌套文件夹 |
| 工作台 | 用户自定义看板及其统计配置 |
| 云盘 | 我的空间、会话文件和文件引用 |
| 机器人 | Temi 控制、语音链路和模拟状态 |

开发环境默认使用内存存储，适合本地联调。设置 `DATABASE_URL` 后使用 PostgreSQL，后端重启时数据不会因内存清空。

---

## 🔌 Platform Stack

| 层 | 组件 | 作用 |
|---|---|---|
| 1 | **Flutter macOS 客户端** | 消息、文档、任务、数据表和工作台界面 |
| 2 | **ClassmateOS Fastify 后端** | API、WebSocket、账号、权限和资源服务 |
| 3 | **Agent Runtime** | 会话循环、工具调用、技能选择和网关 |
| 4 | **ClassmateOS 平台适配层** | Bot 事件、用户态请求和平台资源访问 |
| 5 | **OpenAI 兼容 LLM** | Agent 的自然语言理解与任务规划 |
| 6 | **Temi sidecar（可选）** | 机器人控制、语音和模拟运行 |

---

## 🛠️ Development

```bash
pnpm typecheck   # 类型检查
pnpm build       # 编译 Agent Runtime
pnpm test        # Vitest
pnpm format      # Prettier
```

### 加新平台工具

1. 在 `src/tools/cos/` 中添加或扩展工具实现
2. 在 `src/tools/cos/index.ts` 注册工具
3. 同步更新接口目录、权限策略和系统提示
4. 执行 `pnpm typecheck && pnpm build && pnpm test`

### 目录结构

```
FeishuClassmate/
├── src/
│   ├── cos-sdk/              # ClassmateOS API 客户端与接口目录
│   ├── runtime/              # Agent Runtime、会话循环、网关和调度器
│   ├── tools/cos/            # ClassmateOS 平台工具
│   ├── tools/robot/          # Temi 工具
│   ├── pal/                  # ClassmateOS 平台适配层
│   └── robot/                # 机器人控制与语音链路
├── classmateos/
│   ├── app/                  # Flutter macOS 客户端
│   ├── server/               # Fastify 后端
│   ├── openapi.yaml          # 平台接口定义
│   └── schema.sql            # PostgreSQL 建表脚本
├── skills/                   # Agent 技能说明
├── scripts/                  # 启动、评测和开发脚本
└── tests/                    # 当前新栈测试
```

---

## 📋 Agent Commands

```bash
pnpm classmate status       # 查看配置和连通性
pnpm classmate gateway      # 启动 Bot 网关
pnpm classmate scheduler    # 前台运行自动任务
pnpm classmate schema       # 输出 PostgreSQL DDL
```

---

## 🔐 Data and Permissions

平台会在服务端执行权限检查：管理员可以管理所有资源；普通用户只能操作自己有权限访问的资源，只能删除自己创建且有管理权限的数据表、文件夹或文件。

Agent 通过代办身份调用接口，不能绕过平台权限。删除、批量修改、跨会话发送和其他高风险操作会进入平台确认流程。

---

## License

MIT
