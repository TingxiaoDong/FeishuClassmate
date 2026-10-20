---
name: "autonomous-research"
description: "自动读取飞书LAB知识库项目文档，自主确定研究课题，联网检索前沿案例和方向，生成研究报告辅助团队。Invoke when: 每周自动触发/用户说「启动自主研究」/项目有重大进展或卡点时"
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



# 自主研究技能

## 执行流程（按顺序执行）
1. 项目信息采集 → 读取 [project-collection.md](references/project-collection.md)
2. 研究课题确定 → 读取 [topic-selection.md](references/topic-selection.md)
3. 多维度信息检索 → 读取 [information-retrieval.md](references/information-retrieval.md)
4. 研究报告生成 → 读取 [report-generation.md](references/report-generation.md)
5. 结果推送应用 → 读取 [result-push.md](references/result-push.md)

## 通用规则
### 触发条件
- 自动触发：每周一09:00全量扫描 / 项目标记为高优先级 / 项目新增卡点
- 手动触发：用户要求启动研究、调研方向、查找参考案例

### 错误处理
- 【LAB知识库】访问失败 → 终止研究，记录日志下次重试
- 无匹配研究课题 → 终止执行，不发送通知
- 联网搜索失败 → 仅基于现有知识库内容生成报告
- 报告生成失败 → 跳过当前课题，尝试下一个候选课题

### 数据布局
调用 `feishu_classmate_data_layout()` 获取配置：
- 项目文档读取自【LAB知识库】公共协作区
- 研究报告存储到`research_reports`多维表和【研究报告】目录

