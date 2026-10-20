---
name: intelligent-meeting-scheduling
description: 智能会议预约与会前提醒。使用场景：导师通过飞书发送会议需求后，自动读取参会人日程并安排共同空闲时间，创建会议并在临近会议时优先通过Temi线下寻人提醒，未找到则飞书私信提醒。
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



# 智能会议预约

## 使用流程（需求原文）
导师通过飞书向Agent发送会议基本信息，agent自动访问相关人员的日程，查看其共同空闲时间，进行会议日程的安排。临近会议时，Agent在实验室内寻找参会人员进行提醒，若没找到则通过飞书线上发消息提醒。

## 场景导航
- **会议排期** → 读取 [references/scheduling-and-reminder.md](references/scheduling-and-reminder.md)
- **Temi动作编排** → 优先使用 `feishu_classmate_temi_status` / `feishu_classmate_temi_navigate_to` / `feishu_classmate_temi_detect_person` / `feishu_classmate_temi_speak`

## 快速执行规则
1. 先补齐会议最小信息：主题、时长、发起人、参会人列表、期望日期范围、会议地点。
2. 参会人必须落到可调用日程接口的身份标识（优先 `open_id`）。
3. 使用飞书日程工具族（`cos_calendar`）查询各参会人可用时段，计算共同空闲窗口后给出候选时间。
4. 确认最终时间后，通过飞书日程工具创建会议并向参会人同步会议信息。
5. 会前提醒默认在会议开始前30分钟触发：先线下寻人，再飞书兜底。
6. 线下提醒按参会人逐个执行；同一参会人同一场会议仅提醒一次。

## 通用约束
- 语气保持正向、热心、帮扶导向，禁止催促式表达。
- 工具失败时要降级：`Temi失败/未识别` → 飞书私信；`日程接口受限` → 给出候选时间草案并请求人工确认。
- 任何写入前先校验时区（默认 Asia/Shanghai）与会议时长单位（分钟）。
