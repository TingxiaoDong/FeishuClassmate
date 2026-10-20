# Agent 下一阶段开发规划（ClassmateOS 原生大脑 + Temi 具身）

> 制定日期：2026-10-20　基线：`feat/classmateos-runtime`，`vitest` 231 通过 / 8 跳过
> 前置文档：[Temi/PLAN.md](../Temi/PLAN.md)（大脑替换 + 平台自研总计划）、[classmateos/STATUS.md](../classmateos/STATUS.md)

---

## 0. 现状体检：大脑已经换了，但"手脚"还没接上

PLAN.md 的 A1–A10 已全部落地，但逐个文件核对后，**新栈下的 agent 实际上还不能操作 ClassmateOS**。原因是旧栈里所有表格/文档/日历操作都交给 `@larksuite/openclaw-lark` 的官方工具，换掉 OpenClaw 后这一层整体消失了，而替代它的东西还没写。

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| G1 | 大脑只注册了旧的 30 个业务 tool（data_layout / temi / supervision / chat / research），**没有任何平台工具** | `src/runtime/brain.ts:75`、`src/tools/index.ts` | 做表格、写文档、建日程、派任务在新栈全部做不了 |
| G2 | PAL 只有约 15 个方法（表格 CRUD、文档建/读、云盘 2 个、日历 2 个），且**没有暴露成 tool** | `src/pal/types.ts` | 平台后端已有约 120 个接口，agent 能碰到的 ≈ 0 |
| G3 | skills 里有约 40 处引用 `feishu_bitable_*` / `feishu_create_doc` / `feishu_calendar` / `feishu_ask_user_question` 等**新栈不存在的工具名** | `skills/*/SKILL.md` | 模型会调不存在的工具或胡编 |
| G4 | Bot 令牌只被 `/bot/messages`、`/bot/cards/*` 接受；其余接口要用户 JWT（现在靠 `CLASSMATE_OS_TOKEN` 冒用某个人的登录） | `classmateos/server/context.ts:189` | 无法"代表提问的同学"操作，权限、审计都不对 |
| G5 | 网关每条消息只把**当前这一句**传给 `runSession`，不带历史 | `src/runtime/bot-gateway.ts:220` | 没有多轮上下文，"把刚才那张表加一列"做不到 |
| G6 | skills 在启动时用空查询选前 8 个、全文塞进系统提示，之后不再按问题挑选 | `src/runtime/brain.ts:56` | 提示词很长又不精准；和 MetaClaw 的注入重复 |
| G7 | 大脑只处理 `message.receive`；`record.changed`、`task.assigned`、`calendar.invited` 不推给大脑 | `classmateos/server/events.ts:18` | 无法做"表格一变就自动跟进"这类主动行为 |
| G8 | 没有危险操作确认、没有进度回显、没有长任务机制，`maxTurns=16` 写死 | `src/runtime/agent-runtime.ts` | 批量删表、让机器人走动都没有护栏；长任务用户干等 |
| G9 | Temi：`detect_person / rfid / monitor_focus / gesture / photo_scene` 真机模式是 `NotImplementedError`；地点表硬编码（厨房、沙发…）；指令走正则 NLP；机器人事件不回流大脑 | `temi-sidecar/adapters/temi.py`、`src/tools/temi/nlp.ts` | 真机只能说话/导航/停；无法"看见"和"听见" |
| G10 | 杂项：README 仍以 OpenClaw 为主；`openclaw` 仍是必选 peerDependency；根目录有 `test_*.py`、`*.ps1`、`src/temp_tour_check.*` 等零散文件；`Temi/repo/` 是整个仓库的副本；20 个 Flutter 文件改动未提交 | 根目录 | 维护成本、新同学上手困难 |

**结论**：下一阶段的主线不是再造大脑，而是给大脑接上 ClassmateOS 的"手"（平台工具 + 身份）和 Temi 的"身体"（结构化动作 + 感知事件），并补上记忆、护栏、主动触发三件套。

---

## 1. 总体架构（目标态）

```
                     ┌──────────── ClassmateOS App（四端）─────────────┐
                     │ 聊天 · 多维表 · 文档 · 日历 · 任务 · 工作台     │
                     │ + 「AI 助手」侧栏（带当前文档/表格上下文）      │
                     └───────────────┬─────────────────────────────────┘
          消息 / 卡片 / 事件(WS)     │      REST（代表用户 on-behalf-of）
                     ┌───────────────▼─────────────────────────────────┐
                     │ ClassmateOS Server                              │
                     │  Agent Principal（bot 身份 + 代理授权 + 审计） │
                     └───────────────┬─────────────────────────────────┘
                                     │
┌────────────────────────────────────▼──────────────────────────────────────┐
│ Agent Runtime（src/runtime）                                               │
│  Channel 层：IM 网关 · Temi 语音通道 · 定时器 · 平台事件触发器            │
│  Session 层：会话存储（历史+摘要）· 并发锁 · 长任务 Job                    │
│  Policy 层：风险分级 · 确认卡片 · 速率/配额 · 审计（ToolTrace）           │
│  Tool 层：Toolset 注册表 + tool_search 按需加载                            │
│    ├─ cos.*   平台工具（表格/文档/日历/任务/IM/云盘/知识库/通讯录）        │
│    ├─ temi.*  机器人工具（结构化动作 + 感知 + 状态）                       │
│    ├─ lab.*   实验室业务（器材/甘特/研究/ARC/监督）                        │
│    └─ cos_api 受控通用调用（白名单 + 只读默认）                            │
│  LLM：MetaClaw proxy（skills 注入 + 蒸馏）                                 │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │ HTTP + WS（双向）
                       temi-sidecar ─┴─ Temi（temi-woz-android, ws:8175）
```

---

## 2. 工作流一：让 agent 能"随意"使用 ClassmateOS（核心）

### 2.1 平台工具分三层，而不是一个接口一个工具

120 个接口全部做成工具会撑爆上下文、选错率高。建议：

| 层 | 内容 | 数量 | 说明 |
|---|---|---|---|
| L1 高阶工具 | 面向任务："按描述建一张多维表并填数据"、"用 Markdown 写/追加文档"、"查某人本周日程并约会"、"把会议结论拆成任务派给人" | ~10 | 一次调用完成多步，内部编排多个接口；**最常用、最稳** |
| L2 资源工具 | 每类资源一个工具，用 `action` 区分：`cos_table`（list/get/create/update/delete/batch/fields/views）、`cos_doc`、`cos_calendar`、`cos_task`、`cos_im`、`cos_drive`、`cos_wiki`、`cos_contact`、`cos_notify` | ~9 | 对齐飞书官方插件的"一类一工具"风格，迁移 skills 时改名即可 |
| L3 兜底 | `cos_api(method, path, body)` + `cos_api_catalog(query)` | 2 | 走 openapi.yaml 白名单，默认只允许 GET；写操作需在白名单内且走确认策略。保证"随意"——新接口上线 agent 立刻能用 |

实现要点：
- **从 `classmateos/openapi.yaml` 生成**：写 `scripts/gen-cos-tools.mjs`，从 OpenAPI 生成 L2 工具的 zod schema 与 HTTP 调用骨架；L1 手写。后端改接口 → 重新生成 → 契约测试兜底，避免手写漂移。
- **PAL 的定位调整**：PAL 继续作为"飞书/ClassmateOS 双跑"的最小公约数，服务于旧 tool 与迁移；新平台工具直接基于 ClassmateOS SDK（`src/cos-sdk/`，从 openapi 生成的类型化客户端），不再强行塞进 PAL 抽象，否则每加一个能力都要改两套 Adapter。
- **返回值给模型看得懂**：统一 `{ok, data, summary, links}`，`links` 带可点的应用内深链（`cos://doc/xxx`），回复里可以直接贴卡片。大结果自动截断 + 给 `page_token`。
- **Toolset + tool_search**：工具按组注册（`cos.table`、`temi.motion`…），默认只加载 L1 + 当前 skill 声明的组；模型可调 `tool_search("加列")` 动态挂载。skills 的 frontmatter 增加 `toolsets: [cos.table, cos.doc]`。

### 2.2 身份：Agent 作为平台一等公民（服务端改动）

| 项 | 做法 |
|---|---|
| Agent Principal | `users` 表里的 bot 用户正式化（`role=bot`），bot 令牌换成可轮换的服务密钥 |
| 代表用户操作 | 请求头 `X-Bot-Token` + `X-On-Behalf-Of: <user_id>`；`requireUser` 识别后，以"该用户的权限 ∩ bot 允许的作用域"执行 —— 同学看不到的保密记录，agent 也拿不到 |
| 会话绑定 | 网关在 `runSession` 时把发消息人的 `user_id` 放进 `ToolCallContext`，平台工具自动带上 on-behalf-of；定时任务用 bot 自身身份 |
| 审计 | 服务端对 bot 发起的写操作记 `actor=bot, on_behalf_of=xxx, session_id, tool_call_id`；文档版本、记录修改记录里显示"由飞书同学代 XX 修改" |
| 作用域 | 后台可配 bot 作用域（如禁止删表、禁止改权限），作为硬护栏 |

### 2.3 会话与记忆

- **会话存储**：新增 `agent_sessions / agent_messages` 表（PG，内存版用于测试）。网关每次加载该 chat 最近 N 轮 + 滚动摘要，修复 G5。
- **上下文压缩**：超过 token 预算时把早期轮次压成摘要；工具大结果只保留摘要 + 引用 id。
- **工作记忆**：会话里记住"当前操作对象"（刚建的表 `table_key`、刚写的 `doc_id`），注入系统提示，支持"把刚才那张表…"。
- **长期记忆**：按人偏好（论文偏好、常用格式）放平台表 `PersonMemory`，与 MetaClaw 记忆分工：MetaClaw 管"怎么做事"（skills 进化），平台表管"关于谁/什么的事实"。
- **skills 选择**：二选一，避免重复——接了 MetaClaw 就让 proxy 注入，runtime 只放极简目录；没接时 runtime 按每轮用户问题检索 top-3（修复 G6）。

### 2.4 护栏与体验

| 能力 | 做法 |
|---|---|
| 风险分级 | 每个工具声明 `risk: read / write / destructive / physical`；`destructive`（删表、批量删、改权限）和 `physical`（机器人移动）默认发确认卡片，复用现有 `askUser` + `card.action` 回流 |
| 预演 | 批量写操作先 `dry_run` 返回将要改动的条数/样例，再确认执行 |
| 撤销 | 利用已有的文档版本恢复、记录修改记录，提供 `cos_undo(tool_call_id)` |
| 进度回显 | 先发"正在处理…"消息，过程中用 `PATCH /messages/:id` 更新为步骤清单，完成后替换为结果卡片 |
| 长任务 | 超过 30 秒的任务转成 Job（App 端已有 `job_dialog.dart` / `phase2_jobs.dart`，后端补 `/jobs`），完成后推送通知 |
| 中断 | 同一 chat 新消息"停 / 算了"→ 通过 `AbortSignal` 取消当前会话 |

### 2.5 从"被动问答"到"主动协作"

- 事件推给大脑：`events.ts` 中 `record.changed / task.assigned / calendar.invited / doc.commented` 增加大脑订阅（按表/文档配置，避免风暴）。
- **触发器表** `AgentTriggers`：`当 Gantt 某行进度<50% 且到期前 2 天 → 运行 manage-project 帮扶`；同学可以在 App 里用自然语言让 agent 帮建触发器。
- scheduler 的 6 个定时任务改为跑在平台身份上，结果写回平台（周报写文档、提醒发消息）。

### 2.6 App 端配合

- **AI 助手侧栏**：在文档/多维表页面唤起，自动带上 `doc_id / table_key / 选区` 作为上下文——"帮我把这一列按项目汇总成图表"。
- **消息里渲染 agent 结果卡片**：表格预览、文档链接、确认按钮、进度步骤。
- `@飞书同学` 在群里唤起；文档评论里 @ 它直接改文档。

### 2.7 skills 迁移

| 旧工具名 | 新工具名 |
|---|---|
| `feishu_bitable_app_table_record / field / view` | `cos_table`（action=records / fields / views） |
| `feishu_create_doc / update_doc / fetch_doc / list_docs` | `cos_doc` |
| `feishu_search_doc_wiki` | `cos_wiki` / `cos_search` |
| `feishu_calendar` | `cos_calendar` |
| `feishu_send_message` / `feishu_ask_user_question` | `cos_im`（send / ask） |
| `feishu_drive_file` | `cos_drive` |
| `feishu_classmate_*` | 统一去前缀为 `lab_*` / `temi_*`（保留旧名别名一个版本） |

新增面向同学日常的 skills：`table-builder`（做表格）、`doc-writer`（写文档/改格式）、`meeting-notes`（纪要→任务）、`weekly-report`（从任务/甘特自动生成周报）、`lab-helpdesk`（平台使用答疑）。

---

## 3. 工作流二：操控 Temi 机器人

### 3.1 工具改造：从"一句话指令"到"结构化动作"

现在 `temi_control(instruction)` 先让模型写中文，再用正则解析回命令，多了一次出错机会。改为直接把动作给模型：

| 工具 | 参数 | 风险 |
|---|---|---|
| `temi_say` | text, wait | read |
| `temi_ask` | question, timeout → 返回识别到的回答 | read |
| `temi_goto` | location（从地点表枚举）, async | physical |
| `temi_move` | turn_deg / tilt_deg / step | physical |
| `temi_follow` / `temi_stop` | — | physical / 免确认 |
| `temi_look` | 拍照 + 交给视觉模型描述 / 找人 | read |
| `temi_status` | 电量、位置、是否在充电、当前动作 | read |
| `temi_locations` | 列出/保存/删除地点 | write |
| `temi_task` | 组合动作：`deliver_message(to_user, text)`、`find_person(user)`、`guide_visitor(route)` | physical |

`temi_control` 保留给人直接打字控制（App 里的遥控面板），不再作为 agent 主入口。

### 3.2 机器人状态与事件回流（双向）

- sidecar 新增 `GET /events/ws`：把 Temi 的 `goto 到达/失败`、`检测到人`、`ASR 识别结果`、`电量低`、`被按急停` 推给 runtime。
- runtime 新增 **Temi Channel**：访客对 Temi 说话 → ASR 文本 → 作为一个会话（`sessionId=temi_<date>`）进大脑 → 回复用 `temi_say` 播报。机器人从"被遥控的外设"变成和 IM 并列的一个对话入口。（替代旧的 `scripts/asr-openclaw-bridge.mjs`）
- 长动作异步化：`temi_goto(async=true)` 立即返回 `action_id`，到达事件回来后会话继续；会话里可以并发"边走边说"。

### 3.3 机器人进平台

- 平台表 `Robots`、`RobotLocations`（替代 `temi.py` 里硬编码的厨房/沙发映射）、`RobotLogs`。
- 工作台加机器人卡片：在线状态、电量、当前位置、正在执行的任务、急停按钮。
- 通讯录里每个同学绑定工位地点 → `find_person / deliver_message` 直接可用；结合日历判断人在不在（已有 `intelligent-meeting-scheduling` 的思路）。

### 3.4 真机能力补齐（G9）

| 能力 | 方案 |
|---|---|
| 拍照 / 看见 | 在 temi-woz-android 端加拍照指令，图片回传 sidecar → 存 ClassmateOS 云盘 → 视觉模型理解；替换 `photo_scene` 桩 |
| 找人 / 识人 | 先用 Temi SDK 自带人检测（OnDetectionStateChanged）；识别具体同学放到后期（需同意与隐私规范） |
| 手势 / 专注监测 / RFID | 优先级低，保持 mock，等实际需求确定再做 |

### 3.5 安全护栏（必须做）

- 移动前检查：电量阈值、是否有人在遥控（**单控制者锁**）、目标地点是否在白名单。
- 任何会话都能调用的 `temi_stop`，App 一键急停，最高优先级。
- 移动类动作默认确认；可按人/按 skill 放开（如导览流程内免确认）。
- 夜间/无人时段禁止移动（时间围栏）。

---

## 4. 工作流三：可观测、评测与工程化

| 项 | 内容 |
|---|---|
| ToolTrace 落平台 | 遥测写 ClassmateOS 的 `tool_trace` 表，工作台出"agent 今日调用 / 成功率 / 耗时 / 失败 Top" |
| 场景评测集 | `tests/agent-evals/`：30–50 个真实任务（"建一张器材借用表并加 5 条样例"、"把周会纪要拆成任务"、"让 Temi 去会议室提醒张三开会"），用 mock 平台 + 录制 LLM 回放跑回归；接真模型时打分 |
| 端到端冒烟 | `scripts/smoke-cos.sh`：起后端（内存）→ 起网关（mock LLM）→ 发消息 → 断言表格/文档被创建 |
| 清理 | README 改为以新栈为主、OpenClaw 降为"旧栈"；`openclaw` 改为可选依赖；清理根目录零散脚本、`Temi/repo/` 副本；提交当前 Flutter 改动 |

---

## 5. 路线图

| 阶段 | 周期（估） | 交付 | 验收 |
|---|---|---|---|
| **M1 接上手** | 2 周 | ClassmateOS SDK（openapi 生成）；L2 资源工具 9 个 + `cos_api`；on-behalf-of 身份；网关带历史；skills 工具名迁移 | 在 App 里对飞书同学说"建一张器材借用表，字段…，加 3 条样例" → 表格出现，修改记录显示"由飞书同学代 XX 修改" |
| **M2 护栏与体验** | 1.5 周 | 风险分级 + 确认卡片 + dry-run；进度消息；中断；会话存储与压缩；skills 每轮检索 | 删表必须确认；多轮"把刚才那张表加一列"成功；评测集首版 20 题 ≥ 80% |
| **M3 高阶工具与主动协作** | 2 周 | L1 高阶工具 ~10 个；新 skills（做表格/写文档/纪要/周报）；事件触发器；Job 长任务；scheduler 走平台 | 周报自动写成文档并发群；甘特逾期自动帮扶 |
| **M4 Temi 具身** | 2–3 周 | 结构化 temi 工具；sidecar 事件 WS + Temi 语音通道；地点表进平台；安全锁/急停；拍照回传 | 在群里说"让 Temi 去张三工位提醒他 3 点开会"，机器人到达播报并回报结果；访客对 Temi 提问能得到回答 |
| **M5 App 侧 AI 与评测** | 2 周 | 文档/表格 AI 侧栏；结果卡片；工作台机器人卡片 + agent 指标；评测集扩到 50 题 | 同学日常做表、写文档、约会议都能在 App 内一句话完成 |

合计约 **10 周**（1–2 人）。M1 是其余一切的前提，建议立刻开始；M4 中不依赖平台的部分（结构化 temi 工具、sidecar 事件 WS）可与 M2/M3 并行。

---

## 6. 本周可以立即开始的事

1. 服务端：`context.requireUser` 支持 `X-Bot-Token + X-On-Behalf-Of`（半天，附测试）。
2. `scripts/gen-cos-tools.mjs` 从 openapi.yaml 生成类型化 SDK，先手写 `cos_table`、`cos_doc` 两个工具验证链路（1–2 天）。
3. `bot-gateway.ts` 接入会话历史（先内存版，1 天）。
4. 批量替换 skills 中的 `feishu_*` 工具名（半天）。
5. 提交当前未提交的 Flutter 改动，清理根目录零散文件。

---

## 7. M1 落地记录（2026-10-20）

| 项 | 状态 | 位置 |
|---|---|---|
| 代人操作身份：`X-Bot-Token` + `X-On-Behalf-Of`，权限 = 本人 ∩ 机器人作用域 | ✅ | `classmateos/server/agent-principal.ts`、`context.ts` |
| 作用域黑名单：登录、改账号、设备、通知设置、文档权限/转让/权限申请、清单成员；**删除类默认禁止**（`CLASSMATE_OS_BOT_ALLOW_DELETE=1` 打开） | ✅ | `DEFAULT_BOT_DENY` |
| 代办审计：每个代办请求记 代谁 / 接口 / 状态码 / 会话 / 工具调用 id，`GET /api/v1/bot/audit`（bot 或管理员） | ✅ 内存版 | PG 落库、接进"修改记录"界面留到 M2 |
| 平台客户端 + 接口目录（从服务端真实路由生成，122 个接口，`--check` 做契约测试） | ✅ | `src/cos-sdk/`、`scripts/gen-cos-catalog.mjs` |
| 9 个资源工具：`cos_table / cos_doc / cos_calendar / cos_task / cos_im / cos_drive / cos_contact / cos_notify / cos_search` + `cos_api_catalog` / `cos_api` | ✅ | `src/tools/cos/` |
| 大脑注册平台工具（设了 `CLASSMATE_OS_URL` + `CLASSMATE_OS_BOT_TOKEN` 自动注册），系统提示带使用说明 | ✅ | `src/runtime/brain.ts` |
| 网关多轮：按「会话 + 发消息人」存历史，带最近操作过的对象；`/reset`、「重新开始」清空 | ✅ 内存版 | `src/runtime/session-store.ts`、`bot-gateway.ts` |
| skills 旧工具名迁移 + 新栈执行约定 | ✅ | `skills/**` |

与原计划的差异：
- `cos_wiki` 没做：服务端还没有知识库接口（只有前端），用 `cos_search` 代替；知识库上线后重新生成接口目录即可通过 `cos_api` 使用。
- 删除类操作做了两道闸：工具要求 `confirmed=true`（先问过同学），服务端默认仍拒绝。确认卡片在 M2 做。
- 群聊里每位同学的上下文互相隔离，避免 A 查到的保密内容进入 B 的对话。
- `cos://` 链接目前只是资源标识，App 端深链还没做。
- 定时任务没有发消息人：设 `CLASSMATE_OS_AGENT_USER` 指定一个服务账号，否则平台工具会拒绝执行。

测试：`tests/classmateos/agent-principal.test.ts`、`tests/runtime/cos-tools.test.ts`（真 HTTP 后端）、`tests/runtime/session-store.test.ts`。

---

## 8. M2 落地记录（2026-10-20）

| 项 | 状态 | 位置 |
|---|---|---|
| 风险分级：read / write / destructive / physical；删除类、超过 20 条的批量写入、让机器人移动的动作要先确认；`temi_stop` 永远不拦 | ✅ | `src/runtime/types.ts`、`agent-runtime.ts`、`policy.ts`、`src/tools/cos/define.ts` |
| 预演：确认前先查出要动的数据（如「将删除 3 条：示波器、离心机…」）写进卡片 | ✅ | 各工具 `preview` |
| 确认卡片：`kind=confirm`，只有发起的同学能点；也能直接回复「确认 / 取消」（服务端核验那条消息）；机器人移动可选「本次对话都允许」（30 分钟）；超时 5 分钟作废 | ✅ | `bot-gateway.ts`、`routes-agent.ts`、`routes-im.ts` |
| 删除放行改为凭卡片：服务端核验卡片是机器人发的、本人点了「确认」、10 分钟内有效，才放行删除；不再需要 `CLASSMATE_OS_BOT_ALLOW_DELETE`。工具本地也会拦下没经过确认的删除 | ✅ | `context.ts`、`agent-principal.ts#isValidConfirmCard` |
| 进度消息：超过 3 秒发「正在处理」，随工具步骤更新，结束改成完成清单（`CLASSMATE_PROGRESS_DELAY_MS`） | ✅ | `bot-gateway.ts`、`PATCH /bot/messages/:id` |
| 中断：处理中说「停 / 算了 / 取消」立即中止，回复已完成的步骤（不自动撤销） | ✅ | `bot-gateway.ts` |
| 会话记忆存平台（Memory / PG，网关重启不丢）；超 12 轮或 16000 字时早期对话用大模型压成摘要，失败退化为截短拼接 | ✅ | `session-store.ts`、`/bot/sessions/:id`（`CLASSMATE_SESSION_STORE=memory` 只放内存） |
| skills 每轮按问题挑选：中文双字切词 + 常用说法扩展，展开最相关 3 个（`CLASSMATE_SKILLS_PER_TURN`），其余只列名字 | ✅ | `skills-loader.ts`、`brain.ts#systemPromptFor` |
| 代办审计落库（实体 `agent_audit`），按时间倒序查询 | ✅ | `agent-principal.ts#AgentAuditLog` |
| 修改记录显示代办人：表格记录修改记录、文档历史版本、任务动态都带 `via_bot`，App 显示「飞书同学 代 张三」 | ✅ | `agent-context.ts`、`table-service.ts`、`doc-extras.ts`、`routes-tasks.ts`；App `operatorName` |
| 评测集首版 20 题 + 评测脚本（真实网关 + 内存平台 + 真实大模型，确认卡片由「同学」在平台上点） | ✅ 脚本已就绪，未接真实模型跑 | `evals/agent-cases.json`、`scripts/run-evals.ts`（`pnpm eval`） |

与原计划的差异：
- 评测还没有用真实模型跑：MetaClaw 没启动。`pnpm eval` 会输出各类通过率，报告写到 `evals/results/`。Temi 两题默认跳过，`EVAL_TEMI=1` 时才跑。
- 确认卡片的「本次对话都允许」只给机器人移动；删除每次都要确认，不能关。机器人移动确认可以用 `CLASSMATE_ROBOT_CONFIRM=off` 关（例如导览现场有老师看着）。
- skills 选择还是关键词打分，没有用向量检索；20 题评测跑出来如果选错较多，再换成向量检索。

测试：`tests/runtime/m2-agent.test.ts`（确认卡片端到端、评测打分、skills 选择、上下文压缩）、`tests/runtime/cos-tools.test.ts`（删除两道闸、修改记录 via_bot、审计）、`tests/runtime/session-store.test.ts`。

---

## 9. M3 落地记录（2026-10-20）

| 项 | 状态 | 位置 |
|---|---|---|
| L1 任务型工具 11 个：找人、找共同空闲、约会、按列标题建表 / 加行、表格统计、写文档并分享、批量派任务、今日简报、群发、自动化规则 | 完成 | `src/tools/cos/tasks.ts` |
| 新 skills 5 个：lab-table-builder / lab-doc-writer / meeting-minutes / weekly-report / lab-automation | 完成 | `skills/` |
| 后端：后台任务 `/jobs`、`/bot/jobs`；自动化 `/agent/triggers`、`/bot/triggers` | 完成 | `classmateos/server/routes-automation.ts` |
| 触发器引擎：定时（北京时间 cron）+ 表格记录 / 任务 / 日程邀请 / 文档评论事件；以规则主人身份重新读对象，读不到不触发；冷却、串行、并发上限、排队上限；机器人代办的变更不再触发；无确认通道 | 完成 | `src/runtime/trigger-engine.ts` |
| 大脑 WS 收 record.changed / task.updated / doc.comment_changed，但只带 id，不带记录内容 | 完成 | `classmateos/server/events.ts` `serializeEventForBot` |
| 网关长任务：超过 3 秒建 job，随步骤更新进度，结束标记完成 / 失败 | 完成 | `src/runtime/bot-gateway.ts` `job-tracker.ts` |
| scheduler 改走新大脑 + 平台工具，以 `CLASSMATE_OS_AGENT_USER` 身份运行；周报用 cos_write_doc 写文档并分享到广播群 | 完成 | `src/runtime/scheduler.ts` `cli.ts` |
| 「甘特逾期自动帮扶」 | 提示词已改为平台工具；依赖实验室把甘特图迁到 ClassmateOS 表格，未端到端验证 | — |

未做 / 留到后面：
- App 端「自动化」管理页和「后台任务」列表（接口已就绪）。
- 触发器的上次运行结果只回写到平台，暂无失败告警。
- 真实大模型下的 L1 工具选择准确率未测；建议把 M3 场景加进评测集（约会、周报、建自动化）。


## 10. M4 进展（2026-10-20，未完成）

### 已完成：模拟模式下可用
- `src/robot/`：sidecar 客户端（HTTP + 事件订阅 / 内存模拟）、地点表（白名单）、安全守卫、动作控制器。
- `src/tools/robot/`：10 个结构化工具 `temi_say / ask / goto / move / follow / stop / look / status / locations / task`；组合任务支持送话（人不在改发私信）、找人、带参观。
- 设 `CLASSMATE_ROBOT_M4=1` 后由大脑注册新工具，同时不再注册旧的 `feishu_classmate_temi_*`，避免绕过安全检查；提示词同步切换。未设置时保持旧行为。
- 目前只允许在 `TEMI_MOCK` 模拟模式下启用，真机模式会直接报错拒绝启动。
- 安全规则：未登记 / 已停用的地点不去；电量未知或低于阈值只能回充；同一时间只有一人控制，5 分钟无操作自动释放；夜间（默认 22:00–07:00）禁行；急停不需要确认、任何人可用，并会释放控制锁。移动类工具执行前还会再检查一次是否经过确认。
- 测试：`tests/runtime/m4-robot.test.ts`，共 5 项。

### sidecar 事件回传（已完成，模拟模式验证）
- `temi-sidecar/server.py` 新增 `GET /events/ws`，推送 nav.started / nav.arrived / nav.failed / person.detected / person.lost / battery / asr / estop / connection。WOZ 回调统一经 `_handle_robot_event` 转换。
- `/goto` 接收 `action_id`，返回 `arrived`：只有收到到达事件才算 true。适配器在导航超时时不再伪装成「已到达」，改为返回 `unconfirmed`。
- `/status` 增加 location、heading_to、charging、current_action；`/stop` 会结束当前导航并推送 estop。
- 新增 `/mock/event`（仅模拟模式），用来注入 WOZ 回调、调试事件链路。
- 大脑侧 `HttpSidecar` 只认 `arrived === true`；没有确认到达时动作保持「前往中」，等事件或超时。
- WOZ 的事件名（onGoToLocationStatusChanged、onBatteryStatusChanged 等）是按 temi SDK 回调写的，需要真机核对。
- 测试：`temi-sidecar/tests/test_events.py` 3 项。`test_mock_mode.py::test_english_location_resolved` 在改动前就会失败（`resolve_location` 原样返回地点名）。

### 平台机器人接口（已完成，模拟模式验证）
- `classmateos/server/routes-robots.ts`：地点表（管理员本人维护，机器人只读）、机器人状态（只能由机器人身份上报，超过 60 秒视为离线）、机器人日志（只能由机器人写入，只有管理员能查看）。
- 机器人接口拒绝代办身份（`X-On-Behalf-Of`），同学不能借机器人身份改地点或伪造状态。
- 启用 M4 并配置平台时，大脑从平台读地点白名单（缓存 30 秒），每 20 秒上报一次状态，动作写入机器人日志。平台地点读取失败时不使用旧白名单，直接禁止导航。
- 测试：`tests/classmateos/robots.test.ts` 2 项。

### 本次补充（2026-10-20）
- App 工作台新增 Temi 卡片：显示在线 / 过期、电量、位置、当前动作和模拟模式；「立即急停」调用平台急停接口，提示只说“指令已发出”，不冒充真机已停稳。
- 大脑运行入口已把平台 `robot.estop` 桥接到控制器急停，并在启用 M4 时接入 Temi 语音通道。
- `createBrain({ describeImage })` 可注入视觉模型；未配置时 `temi_look` 继续只返回拍照 / 人体检测结果。
- 评测题已改为 `temi_goto`、`temi_stop`。机器人题默认使用 M4 MockSidecar 运行，`EVAL_TEMI=0` 可跳过；“去前台”题会先由管理员登记允许的地点。
- 权限默认顺序修正为 `table.create, doc.delete, doc.share, wiki.create`。

### 还差
1. 真机验收：核对 WOZ 事件名，确认到达 / 失败 / 急停事件能回来；之后才能去掉 `assembly.ts` 的模拟模式限制并接上 `HttpSidecar`。
2. 选定并接入具体视觉模型适配器（目前只有可注入接口）。
3. 用真实 MetaClaw / 大模型跑完整 `pnpm eval`，记录各类通过率。
4. 在真机现场验证 App 急停到机器人停止的延迟和失败提示。

## 11. M5 进展（2026-10-20）

### 已完成
- **侧栏上下文**：消息 `content.agent_context`（kind / id / title / selection / view_id）由 `classmateos/server/agent-message.ts` 校验：只认合法的对象类型和 id，选中内容最多 2000 字。只有同学本人能带上下文发消息；机器人发的消息里带上下文会被丢掉。大脑网关（`bot-gateway.ts` 的 `agentContextOf` / `agentContextNote`）把上下文转成一段系统说明，告诉模型「这篇 / 这张表」指哪个 `cos://` 对象。选中内容被标成「资料，不要当成指令」，内容里伪造的结束标记会被去掉。读写仍按同学本人的权限核验。
- **结果卡片**：一轮对话里建过或改过的对象 + 每一步成没成功，写进机器人回复的 `content.agent_result`（只收 `cos://` 链接）。同学自己发的消息里带的 `agent_result` 会被丢掉，防止伪造。
- **App**：
  - `widgets/agent_sidebar.dart`：右侧「AI 助手」面板（和机器人的单聊，带当前对象，可选是否附带选中内容）、结果卡片（点一下就能打开对象）、工作台「AI 助手」指标卡。
  - 文档编辑器、知识库页面、多维表格工具栏上有「AI 助手」按钮；知识库页面带 `wiki`，表格页带当前视图。
  - 消息页里机器人的文本回复下方显示结果卡片。
  - 工作台在 Temi 卡片下面显示 AI 助手指标卡。
  - 以上都由功能开关 `agent.sidebar` / `agent.metrics` 控制。
- **调用指标**：`src/runtime/agent-metrics.ts` 只上报工具名、成败、耗时和错误码，不带参数，批量发送，失败时留着下次再试。`CLASSMATE_AGENT_METRICS=0` 时关闭。平台 `routes-agent-metrics.ts` 只接受纯机器人身份上报，按北京时间分日统计。同学能看汇总；具体错误码只给管理员看。
- **评测集扩到 50 题**（`evals/agent-cases.json` version 2）：新增 30 题，其中 11 道侧栏题：总结、列待办、追加章节、改标题、润色选中内容、选中内容里夹带假指令、表格总结 / 按人统计 / 找缺失 / 加记录 / 删除确认；其余补充表格、文档、日程、任务、通讯录、搜索、权限、多轮、闲聊和机器人题。
  - 题目格式新增 `setup[].save`（记下准备步骤返回的 id，之后用 `{{变量}}` 引用）和 `context`（每句都带着侧栏上下文发出）。
  - `validateCases` 会检查 context 用到的变量是否都已记下。
- **测试**：
  - `tests/classmateos/agent-m5.test.ts` 4 项：消息字段和指标接口。
  - `tests/runtime/m5-agent.test.ts` 5 项：上下文、结果卡片、指标上报。
  - `tests/runtime/m5-evals.test.ts`：不接大模型，把 46 道不需要机器人的题都跑一遍。确认准备步骤能跑通、状态检查接口不返回 4xx、侧栏上下文真的送到了模型。这一步发现并修好了「建表时主字段必须设为必填」的题目写法问题。
  - 4 道机器人题不在这项检查里。

### 本次补充（2026-10-20 下午）：接 DeepSeek、App 实操
- **大模型接 DeepSeek**：新增 `src/runtime/llm-env.ts` 统一决定连哪个模型。`.env` 里填了 `DEEPSEEK_API_KEY`（或 `LLM_PROVIDER=deepseek`）就直连 DeepSeek（默认 `deepseek-chat`、`https://api.deepseek.com/v1`），否则仍走 MetaClaw。DeepSeek 没有 `/memory/flush_session`，直连时不调用。
  - `.env`（不提交）和 `.env.example` 里都留了 `DEEPSEEK_API_KEY=` 空位。平台后端、`pnpm classmate`、`pnpm eval` 启动时都会读 `.env`（`loadDotEnv`，命令行临时设的变量优先）。
- **评测脚本**：先发一条很短的请求检查 Key 和网络，Key 空着 / 无效 / 余额不足时直接说明原因并退出（退出码 2），不会白跑 50 题；`pnpm eval --check` 只做这一步。报告除了 JSON 还生成同名 `.md`（按类别的通过率 + 没通过的题），JSON 里记下 provider、model 和分类统计。
- **App 实操发现并修好的问题**：
  1. **侧栏一打开就报错**：侧栏挂在 Navigator 覆盖层上，不在 `AppScope` 子树里，`AppScope.read` 拿不到状态。`showAgentSidebar` 现在重新包一层 `AppScope`（同 `showScopedDialog`）。
  2. **大模型很快失败时同学什么都收不到**：进度消息 3 秒后才发，模型在这之前出错（如 Key 无效）时，侧栏会一直显示「助手正在处理…」。网关现在出错必回一句原因（`describeAgentError`：密钥无效、余额不足、限流、超时、连不上，不带内部细节）；模型没给内容时也会说明。用户说「停」中止的不重复报错。
  3. **结果卡片在调试版报断言**：「查看步骤」的 ExpansionTile 放在带底色的 Container 里，水波纹会被挡住。改成用 `Material` 当底色。点对象时先拿 AppState 再关侧栏。
- **App 实操测试**：
  - `classmateos/app/test/live_agent_ui_test.dart`：连真实后端 + 真实网关，按同学的操作走一遍：文档页按钮 → 侧栏（当前文档、选中字数）→ 点快捷问题 → 侧栏收到回复 → 平台上消息确实带着 `agent_context` → 结果卡片出现、点对象切到文档模块并关侧栏 → 工作台指标卡加载。只在设了 `COS_LIVE_URL` 时运行；设 `COS_LIVE_EXPECT_ANSWER=1` 时要求是真正的回答（不是「连不上大模型」）。
  - `classmateos/app/test/agent_sidebar_test.dart`：离线界面测试 3 项，每次 `flutter test` 都跑，防止上面第 1、3 个问题回来。
  - App 加了 `--dart-define=COS_A11Y=true`（默认关），强制打开语义树，方便以后用浏览器自动化点 Web 版。
- 测试：`tests/runtime/llm-env.test.ts` 4 项；`tests/runtime/m5-agent.test.ts` 新增出错回复 2 项。

### 怎么跑（填好 Key 之后）
1. 在 `.env` 里填 `DEEPSEEK_API_KEY=`。
2. `pnpm eval --check`：确认连得上。
3. `pnpm eval`：跑 50 题，报告在 `evals/results/<时间>.md`。机器人题用模拟机器人，不需要真机。
4. App 实操：`pnpm classmateos` + `pnpm classmate gateway`，然后在 `classmateos/app` 里执行
   `COS_LIVE_URL=http://127.0.0.1:8080 COS_LIVE_EXPECT_ANSWER=1 flutter test test/live_agent_ui_test.dart`。

### 本次补充（2026-10-20 傍晚）：代码审查 A1～A3、DeepSeek 真实评测
- **代码审查修复**（见 `classmateos/代码审查_agent_2026-10-20.md`，验收测试 `tests/runtime/review-fixes.test.ts`）：
  - A1 网关只回复机器人所在的单聊和群里 @ 机器人的消息，@ 部分去掉再交给模型；「确认 / 停」等控制词也先过筛选。
  - A2 确认卡片带 `bound_action`（方法、路由模板、路径、对象），每次高风险调用单独发卡；后端已按它核对，一张卡只能用一次。
  - A3 没配策略按 write、策略出错按 destructive 并上报；物理工具不带策略不能注册；启动自检补齐了 10 个旧工具的策略。
- **DeepSeek 评测**（模型 `deepseek-flash`，报告在 `evals/results/`）：
  - 第一轮 44/50；修正 5 道题本身的问题（组合工具按底层工具计、侧栏润色题的原文不在文档里），没有放宽平台数据核对。
  - 第二轮 49/50，没过的是 `privacy-other-doc`：模型拒绝朗读但说出了「银行卡号、体检结果」。系统提示加了「别人的私人内容不复述任何细节」后连跑 3 轮通过。
  - 最终一轮 **50/50**。
  - 有一次「说日程建好了、平台上查不到」没能复现（之后 9 次都正常），继续观察。
- **交给后端的问题**：见 `classmateos/后端待改问题_2026-10-20.md`。C1 新建文档默认全组织可见（私人笔记能被别人读到、搜到）；C2 B1 之后 Agent 不能代同学往机器人不在的群里发消息，需要后端 / 产品定方案。

### 还差
1. App 实操最后一项：「追加本周总结」后平台文档已改动，但测试没等到侧栏出现带结果卡片的最终回复，要查清是侧栏没收到消息还是测试判断有问题。
2. 后端定下 C2 方案后，调整「发消息」工具；在那之前，`BOT_NOT_IN_CHAT` 的提示要改成「请先把飞书同学拉进这个群」。
3. 侧栏目前只显示这次打开后的对话；需要时再加「查看完整记录」跳到和机器人的单聊。
4. Temi 真机验收（暂缓）。
