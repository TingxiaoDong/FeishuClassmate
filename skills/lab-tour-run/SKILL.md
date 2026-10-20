---
name: lab-tour-run
description: |
  访客到达现场后的「执行期」实验室导览:Temi 走位 + 播报 + 工位项目补充 + 问答。
  **前置**:已有当次讲解 Doc(由 skill `lab-tour-prepare` 生成),或使用通用内置剧本。
  **触发**: 「开始导览」「参观开始」「飞书同学 XX 到了」、用户提供 doc 链接/token。

  **不要用于**: 仅在飞书里写稿不发机器人 —— 用 `lab-tour-prepare`。
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



# 导览 · 执行期

## 最短路径

1. `feishu_classmate_data_layout()` → `plugin_docs`、`labInfo`。
2. `feishu_classmate_temi_status` → 若未连接且非 mock,改为**纯文字**在飞书输出各段文案。
3. 若有当次 Doc:`cos_doc（action=get）` 拉全文,按 [doc-format](../lab-tour-prepare/references/doc-format.md) 的 `##` 分段生成执行步骤队列;无 Doc 则退回 [fallback-generic-tour](../conduct-lab-tour/references/fallback-generic-tour.md)。
4. **步骤化执行引擎**：按文档顺序依次执行每个章节（文档顺序可由准备期按访客画像个性化重排，即个性化路线）：
   - 解析章节内容中的所有`【动作：XXX】`指令，按顺序执行所有动作
   - 所有动作执行完成后，提取讲解内容调用`feishu_classmate_temi_speak`朗读
   - 若章节内容为「本节跳过」，直接跳过执行下一章
5. **工位区**段额外：动作执行完成后，读取`plugin_docs.publicProjects`，必要时 bitable 查公开项目，动态补充讲解内容。
6. **收尾与问答**：所有章节执行完成后，`feishu_classmate_temi_speak`邀请提问；随后在用户回复或语音通道内作答，**只听公开资料与当次 Doc**，拒答保密内容。
7. 全程支持中断控制：听到「停/stop」/「暂停」指令 → 立即执行 `feishu_classmate_temi_stop({ immediate: true })`，暂停当前流程，等待用户下一步指令（继续/结束）。

## 详细阶段与安全

见 [references/run-detail.md](./references/run-detail.md)。
