---
name: academic-paper-search
description: Academic paper search with per-student (open_id) preference memory, Feishu identity resolution, and iterative query/refinement; see references/.
---
## ClassmateOS 新栈执行约定（M1）

本节覆盖下文遗留的飞书平台调用说明；旧业务工具和 Temi 工具名称暂时保留。
- 平台数据仅用 cos_table、cos_doc、cos_calendar、cos_task、cos_im、cos_drive、cos_contact、cos_notify、cos_search；不调用旧平台插件。
- 先 cos_table(action=list_tables)，再 get_table 获取 table_key 和真实字段；旧 data_layout 中的飞书 app_token/table_id 不能当 ClassmateOS 标识使用。
- 记录动作映射：list→list_records，create→create_records，update→update_records；参数用 table_key；新增 records=[{字段名:值}]，更新 records=[{record_id,fields:{字段名:值}}]。字段用 get_table/add_field/update_field；视图用 list_views/create_view。
- 文档用 cos_doc(action=list/get/create/update/append)，搜索用 cos_search(query=关键词)。用户上传的普通文件不等于云文档，不能直接把文件 ID 传给 cos_doc。
- 知识库目录移动、Wiki 和未实现视图功能暂不可用；可以创建独立云文档，但必须如实告知未归档到目标目录。
- 收集信息和确认先用普通对话等待用户回复；M1 尚无可信确认卡片，删除默认被服务端禁用，不得绕过。
- 调用以当前消息发送人权限执行；遇到无权访问应停止，不借用其他同学身份。



## 何时读取子文档

按需展开（避免一次塞满上下文）：

| 主题 | 文件 |
|------|------|
| 角色、核心目标 | [references/role-and-goals.md](references/role-and-goals.md) |
| **按人识别、偏好落盘、迭代闭环** | [references/person-preferences-and-memory.md](references/person-preferences-and-memory.md) |
| 可信来源与应避开的站点 | [references/scholarly-sources.md](references/scholarly-sources.md) |
| 意图分析 + 构造多组学术 Query | [references/intent-and-queries.md](references/intent-and-queries.md) |
| 检索策略 + 迭代改进 | [references/search-and-iteration.md](references/search-and-iteration.md) |
| 论文评估、排序、引用扩展、输出模板、行为约束、高阶行为与检索哲学 | [references/evaluation-output-rules.md](references/evaluation-output-rules.md) |

## 执行流程（总览）

执行任何检索任务时，按顺序落实下列步骤；细节与原文约束见上表链接。

0. **锚定服务对象 + 加载个人偏好** — 解析本次论文是**给哪位同学**（具体到 `open_id`）；`read_file` 其 `memory/paper-preferences/<open_id>.md`（若存在）。详见 `person-preferences-and-memory.md`。
1. **理解意图** — 抽取主题、领域、问题、技术词、约束、期望论文类型；请求模糊则推断方向；**与个人偏好摘要合并**（不矛盾时兼顾，矛盾时以本轮用户明确指令为准）。
2. **生成多组 Query** — 基础词、学术表述、高被引/综述向、最新研究向、同义词扩展；**融入偏好与排斥信号**（见 `intent-and-queries.md`）。
3. **分阶段检索** — 先宽后窄；依据高相关文献、重复关键词、重要作者、**引用关系**、常见方法迭代收紧（见 `search-and-iteration.md`）。
4. **评估** — 相关性、质量（引用、venue、时效、方法严谨性）、论文类型归类。
5. **排序** — 优先高相关、有学术影响、严谨、在合适场景下兼顾新近；**在同等条件下按该同学历史偏好加权**；避免仅关键词表面匹配。
6. **引用扩展** — 对核心论文：参考文献、cited-by、奠基工作、后续跟进，形成研究谱系。
7. **结构化输出** — 每篇：title / authors / year / venue / paper type / 相关性说明；再归纳主题、方法、趋势与可能空白（见 `evaluation-output-rules.md`）。
8. **迭代** — 结果弱则改 Query、扩/缩范围、换平台、换邻近领域，直到相关性改善。
9. **私聊征询 + 偏好回写** — 交付列表后，在权限允许时**向该同学发飞书私聊**，请其用编号说明**哪几篇更符合需求**（及可选的不贴之处）；再结合其回复或同轮对话中的反应、`manage-papers` 保存行为，更新 `memory/paper-preferences/<open_id>.md`；无法私聊则在当前渠道同样征询。详见 `person-preferences-and-memory.md` 第六节。

## 硬性约束（摘要）

- **必须**：分步思考；检索前推理；优先一手学术源；**以摘要为主**评估，不单看标题；不捏造文献信息；**有具体服务对象时必须先 open_id 再检索**；交付论文后在条件允许时**私聊征询**其更符合需求的篇目；有反馈时**持久化个人偏好**。
- **禁止**：伪造引用或推荐虚假论文；轻信低质站；仅凭关键词重叠堆砌无关论文；**用「通用画像」替代已知的个人偏好文件**。

完整「必须 / 禁止」、输出字段模板与高级行为见 [references/evaluation-output-rules.md](references/evaluation-output-rules.md)。
