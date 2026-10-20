---
name: manage-project
description: 项目及进度管理全流程支持，包括项目信息录入、甘特图自动更新、当日DDL主动提醒（temi线下优先，飞书兜底）、与项目进度有关的帮扶提醒。所有文档、甘特图、项目表格均存储在飞书【Lab知识库】公共协作区。使用场景：创建新项目、更新项目进度、查询项目甘特图、查看项目进度、设置项目提醒、与项目卡点帮扶相关的聊天。
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



# 项目管理技能

## 场景导航
根据用户需求读取对应参考文档：
- **更新/查询进度** → 读取 [progress-check.md](references/progress-check.md)
- **生成周报** → 读取 [weekly-report.md](references/weekly-report.md)
- **项目卡点帮扶** → 读取 [intelligent-help.md](references/intelligent-help.md)
- **飞书API集成** → 读取 [FEISHU_INTEGRATION_GUIDE.md](references/FEISHU_INTEGRATION_GUIDE.md)

## 通用规则
### 字段规范
- 节点状态：`未开始`、`进行中`、`已完成`、`逾期`

### 错误处理
- 公共协作区ID不存在：提示用户先配置
- 甘特表查询失败：跳过对应项目记录错误日志
- 消息发送失败：记录到项目日志下次检查重试
- temi未找到负责人：自动降级为飞书私信提醒


### 日期处理规则
- 生成甘特图节点时必须使用当前真实年份，禁止硬编码固定年份（如2025）
- 任何日期处理默认使用系统当前日期（当前年份为2026年及以后）
- 解析用户输入的不完整日期时，默认补全为当前年份

### 每日DDL提醒规则
- 定时检查默认在北京时间（Asia/Shanghai）每日14:00执行
- 仅处理DDL=今天且状态非已完成的任务节点
- 同一负责人同一天仅提醒一次；若该负责人存在多项任务，必须合并为一条提醒
- 负责人字段支持多人；多人场景必须逐个执行“实验室寻人→当面提醒/飞书兜底”
