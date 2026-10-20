---
name: conduct-lab-tour
description: |
  **路由入口** — 实验室参观全链路拆分为两段 skill,避免单文件过长:
  **准备讲解稿** → `lab-tour-prepare`; **现场 Temi 带览** → `lab-tour-run`。

  触发词:「带参观」「导览」「tour」「来人了」「有访客」「参观开始」。
  若用户明确「提前写稿/生成文档」→ **lab-tour-prepare**;
  若「人已到现场/机器人开始讲」→ **lab-tour-run**(可附带 doc 链接)。
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



# 导览入口

1. 判断意图属于 **准备期** 还是 **执行期**,调用对应 skill 名称引导 Agent。
2. 无定制 Doc 且需立即讲解时,直接按 **lab-tour-run**:它会退回通用剧本(数据来自 `data_layout` + `publicProjects` + `labInfo.specialAreas`)。
3. Temi 不可用 → **lab-tour-run** 中的纯文字降级(飞书输出)。

详细步骤见:

- [lab-tour-prepare/SKILL.md](../lab-tour-prepare/SKILL.md)
- [lab-tour-run/SKILL.md](../lab-tour-run/SKILL.md)
