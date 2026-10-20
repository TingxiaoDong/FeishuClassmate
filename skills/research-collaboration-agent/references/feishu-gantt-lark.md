# 三、甘特与飞书协同（Lark 工具执行面）

## 3.1 Agent 必须掌握的飞书能力（通过 openclaw-lark）

**多维表格（Bitable）**

- 项目任务、时间规划、负责人、依赖关系：用 `cos_table`（list/create/update）、`cos_table`（字段定义）、`cos_table`（视图，含时间线）。

**云文档（Doc）**

- 研究计划、会议纪要、周报：`cos_doc（action=create）` / `cos_doc（action=update）` / `cos_doc（action=get）`。

**日历（Calendar）**

- **仅用于**预约讨论会、milestone 提醒、deadline 事件等**时间排期**；**不用于**判断「同学当前是否空闲、可否被打扰」（后者见 `availability-and-academic-chat.md` 的 **`POST /photo`**）。

**说明**：Open Platform REST 路径（如 `POST /open-apis/bitable/v1/apps`）仅表示**能力语义**；运行时一律用 Lark 插件封装工具，由插件处理鉴权与路径。

## 3.2 甘特逻辑（时间线视图 = 甘特呈现）

### Step 1 — 拆任务

典型行：Literature Review → Prototype → Backend → Frontend → Experiment → Visualization → Paper Writing（按课题裁剪）。

### Step 2 — 估计工期

结合：历史同类节点、负责人负荷、依赖深度。为每行给出：

```text
estimated_duration
estimated_risk
parallelizable_tasks
```

### Step 3 — 依赖

显式写出依赖链，例如：Frontend 依赖 API design；Experiment 依赖 prototype；Paper writing 依赖主要结果。

### Step 4 — 写入多维表

在 `data_layout` 返回的 **gantt**（或项目约定的任务表）中创建/更新记录。字段示例（名以实际表结构为准，可先用 field 工具查 schema）：

| 逻辑字段 | 用途 |
|----------|------|
| Task / 任务名 | 节点标题 |
| Owner / 负责人 | User 或文本 open_id |
| Start / End | 日期或时间戳 |
| Status | 未开始/进行中/已完成 等枚举须与表定义一致 |
| Dependency | 依赖任务 id 或标题引用（按表设计） |

### Step 5 — Timeline（甘特）视图

在 Bitable 上创建或调整 **Timeline / 时间线视图**（Feishu Bitable Timeline View）：

- 将 **开始字段**、**结束字段** 映射到表中的日期列。  
- 按需设置分组/颜色（以 `cos_table` 能力为准）。

若当前表不支持某视图选项：**不得臆造成功**；应告知用户需在飞书客户端中补充的配置，并保留表格数据正确性。

## 3.3 错误与降级

- `app_token` / `table_id` 缺失：提示先 `openclaw classmate setup-bitable` 或联系管理员配置插件 `docs` / `tables`。  
- 权限不足：记录失败原因，建议走 Doc 草稿 + 人工建表。  
- 日期：使用**真实当前日期**；禁止硬编码过期年份。
