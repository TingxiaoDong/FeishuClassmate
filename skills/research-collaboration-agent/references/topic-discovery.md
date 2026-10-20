# 一、预研课题发现与生成（核心）

Agent **不**应只做「用户说什么做什么」，而要能主动提出**可落地的小型预研**，并与实验室现状对齐。

## 0. 头脑风暴前置：云文档知识库中的「各同学项目」

在输出预研方向或组织脑暴**之前**，必须先基于 **`feishu_classmate_data_layout()`** 返回的 `docs`（如 `publicProjects`、`lab_knowledge_base`、导览/知识库目录等，以你环境实际字段为准），用 **`cos_search`**、**`cos_doc（action=get）`**、**`cos_drive`** 等 Lark 工具：

1. **定位知识库**中按命名约定存放的各同学项目云文档（例如「`xxx-项目`」、个人项目文件夹下的说明 Doc）。  
2. **分批读取**摘要：研究目标、当前模块、已列问题、下一步计划。  
3. 将上述内容整理成「**实验室当前项目画布**」再进入下面的四源汇聚；**禁止**在未读知识库项目文档的情况下空泛脑暴。

若知识库路径未在 layout 中配置：明确告知用户缺哪项 Doc/folder token，并仅基于已可读到的 Projects 表做**有限**推断且标注不确定性。

## 1.1 课题生成四源（须同时考虑）

### （1）已有项目延伸

在 **§0 知识库项目文档** 与 `data_layout` 中的 **Projects / Gantt / 关联表** 基础上，分析：

- 系统瓶颈、未解决问题、可增强模块  
- 可视化/交互/数据/推理链路短板  

每条候选课题输出下列块（可复制到研究计划 Doc 或 Research 表）：

```text
Potential Research Direction:
Research Motivation:
Expected Contribution:
Technical Difficulty:
Possible Implementation Path:
```

### （2）论文启发

- 用 `feishu_classmate_research_search_works` 按关键词拉 arXiv 摘要（本仓库当前实现为 arXiv Atom）。  
- 更宽学术检索（Scholar / Semantic Scholar 等）时：**加载** [academic-paper-search](../academic-paper-search/SKILL.md) 及其 `references/`（含 **person-preferences-and-memory**），遵守其来源与反幻觉规则；若论文列表面向某位具体同学，先解析其 `open_id` 再检索与排序。

对每篇高相关论文自问：

```text
How can this be adapted into our lab projects?
What limitations still exist?
Can multiple papers be combined?
Can this solve current lab bottlenecks?
```

### （3）跨课题融合（鼓励 cross-domain）

主动组合实验室已有线，例如：多智能体 × 医疗协同、机器人 × 具身、Agent × HCI、可视化 × 编排等。输出应点明**结合点**与**最小验证实验（MVP）**，避免空泛「大杂烩」。

### （4）团队能力匹配

从 Projects 成员字段、历史分工、公开文档中归纳（**只写有据可查的推断**，无数据则标注「待确认」）：

- 前端 / 后端 / 论文 / 系统 / 可视化 / 模型 等标签  

生成课题时显式写：

```text
feasible topics based on current team composition:
- ...
```

原则：**不仅有趣，还要团队「够得着」**；缺人手的方向要标风险并建议最小团队配置。
