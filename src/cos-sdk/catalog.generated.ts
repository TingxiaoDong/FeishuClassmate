/* 自动生成，请勿手改：node scripts/gen-cos-catalog.mjs */
import type { CosApiEntry } from './types.js';

export const COS_API_CATALOG: CosApiEntry[] = [
  {
    "method": "GET",
    "path": "/admin/security-settings",
    "group": "other",
    "summary": "读取安全设置"
  },
  {
    "method": "PUT",
    "path": "/admin/security-settings",
    "group": "other",
    "summary": "修改安全设置（可部分更新）"
  },
  {
    "method": "GET",
    "path": "/agent/metrics",
    "group": "other",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/agent/triggers",
    "group": "other",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/agent/triggers",
    "group": "other",
    "summary": ""
  },
  {
    "method": "DELETE",
    "path": "/agent/triggers/:trigger_id",
    "group": "other",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/agent/triggers/:trigger_id",
    "group": "other",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/audit-logs",
    "group": "other",
    "summary": "操作日志（admin.audit）"
  },
  {
    "method": "POST",
    "path": "/audit-logs/exports",
    "group": "other",
    "summary": "导出操作日志 CSV（异步）"
  },
  {
    "method": "GET",
    "path": "/calendar/events",
    "group": "calendar",
    "summary": "查询时间窗内的日程"
  },
  {
    "method": "POST",
    "path": "/calendar/events",
    "group": "calendar",
    "summary": "创建日程"
  },
  {
    "method": "DELETE",
    "path": "/calendar/events/:event_id",
    "group": "calendar",
    "summary": "删除日程或指定重复范围"
  },
  {
    "method": "GET",
    "path": "/calendar/events/:event_id",
    "group": "calendar",
    "summary": "读取日程或重复实例"
  },
  {
    "method": "PATCH",
    "path": "/calendar/events/:event_id",
    "group": "calendar",
    "summary": "试验：修改日程及指定重复范围"
  },
  {
    "method": "POST",
    "path": "/calendar/events/:event_id/rsvp",
    "group": "calendar",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/cards/:card_id/actions",
    "group": "other",
    "summary": "卡片交互回调（ask_user_question 等价物）"
  },
  {
    "method": "GET",
    "path": "/chats",
    "group": "im",
    "summary": "我的会话列表（单聊+群聊）"
  },
  {
    "method": "POST",
    "path": "/chats",
    "group": "im",
    "summary": "创建会话（单聊或群聊）"
  },
  {
    "method": "GET",
    "path": "/chats/:chat_id",
    "group": "im",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/chats/:chat_id",
    "group": "im",
    "summary": "修改会话（迭代4：thread_mode 切换话题模式）"
  },
  {
    "method": "POST",
    "path": "/chats/:chat_id/members",
    "group": "im",
    "summary": ""
  },
  {
    "method": "DELETE",
    "path": "/chats/:chat_id/members/:user_id",
    "group": "im",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/chats/:chat_id/messages",
    "group": "im",
    "summary": "拉取消息历史（倒序分页）"
  },
  {
    "method": "POST",
    "path": "/chats/:chat_id/messages",
    "group": "im",
    "summary": "发送消息（文本/富文本/卡片）"
  },
  {
    "method": "GET",
    "path": "/chats/:chat_id/pins",
    "group": "im",
    "summary": "会话的 Pin 消息"
  },
  {
    "method": "DELETE",
    "path": "/chats/:chat_id/pins/:message_id",
    "group": "im",
    "summary": "取消 Pin"
  },
  {
    "method": "POST",
    "path": "/chats/:chat_id/pins/:message_id",
    "group": "im",
    "summary": "Pin 消息（每个会话最多 10 条）"
  },
  {
    "method": "POST",
    "path": "/chats/:chat_id/read",
    "group": "im",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/chats/:chat_id/settings",
    "group": "im",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/dashboard/summary",
    "group": "workbench",
    "summary": "报表聚合（六张卡片：Tool 用量/成功率、项目甘特 KPI、器材、投稿、失败归档）"
  },
  {
    "method": "GET",
    "path": "/docs",
    "group": "doc",
    "summary": "文档列表"
  },
  {
    "method": "POST",
    "path": "/docs",
    "group": "doc",
    "summary": "创建文档（markdown 正文；块编辑器协同为 P3 深化项）"
  },
  {
    "method": "DELETE",
    "path": "/docs/:doc_id",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/docs/:doc_id",
    "group": "doc",
    "summary": "读取文档 markdown"
  },
  {
    "method": "PATCH",
    "path": "/docs/:doc_id",
    "group": "doc",
    "summary": "更新文档（整体替换正文）"
  },
  {
    "method": "POST",
    "path": "/docs/:doc_id/access-requests",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/docs/:doc_id/comments",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/docs/:doc_id/comments",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/docs/:doc_id/comments/:comment_id",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/docs/:doc_id/comments/:comment_id/replies",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "DELETE",
    "path": "/docs/:doc_id/comments/:comment_id/replies/:reply_id",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/docs/:doc_id/comments/:comment_id/replies/:reply_id",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/docs/:doc_id/exports",
    "group": "doc",
    "summary": "导出 PDF / Word（异步，含图片）"
  },
  {
    "method": "GET",
    "path": "/docs/:doc_id/permissions",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "PUT",
    "path": "/docs/:doc_id/permissions",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/docs/:doc_id/restore",
    "group": "doc",
    "summary": "从回收站恢复"
  },
  {
    "method": "POST",
    "path": "/docs/:doc_id/transfer",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/docs/:doc_id/versions",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/docs/:doc_id/versions/:version_id",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/docs/:doc_id/versions/:version_id",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/docs/:doc_id/versions/:version_id/restore",
    "group": "doc",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/favorites",
    "group": "im",
    "summary": "我的收藏"
  },
  {
    "method": "GET",
    "path": "/files",
    "group": "drive",
    "summary": ""
  },
  {
    "method": "DELETE",
    "path": "/files/:file_key",
    "group": "drive",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/files/:file_key/download-url",
    "group": "drive",
    "summary": "获取下载预签名 URL"
  },
  {
    "method": "POST",
    "path": "/files/:file_key/drive",
    "group": "drive",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/files/upload-url",
    "group": "drive",
    "summary": "申请上传预签名 URL"
  },
  {
    "method": "GET",
    "path": "/files/usage",
    "group": "drive",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/folders",
    "group": "other",
    "summary": "我的文件夹"
  },
  {
    "method": "POST",
    "path": "/folders",
    "group": "other",
    "summary": "新建文件夹"
  },
  {
    "method": "DELETE",
    "path": "/folders/:folder_id",
    "group": "other",
    "summary": "删除文件夹（含下级），里面能删的文档进回收站"
  },
  {
    "method": "PATCH",
    "path": "/folders/:folder_id",
    "group": "other",
    "summary": "改名 / 移动"
  },
  {
    "method": "GET",
    "path": "/jobs",
    "group": "other",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/jobs/:job_id",
    "group": "other",
    "summary": "异步任务进度（只能查自己的）；也推 WS job.updated"
  },
  {
    "method": "PATCH",
    "path": "/messages/:message_id",
    "group": "im",
    "summary": ""
  },
  {
    "method": "DELETE",
    "path": "/messages/:message_id/favorite",
    "group": "im",
    "summary": "取消收藏"
  },
  {
    "method": "POST",
    "path": "/messages/:message_id/favorite",
    "group": "im",
    "summary": "收藏（幂等）"
  },
  {
    "method": "POST",
    "path": "/messages/:message_id/reactions",
    "group": "im",
    "summary": "添加表情回应（幂等；每条最多 50 种，每人每分钟 60 次）"
  },
  {
    "method": "DELETE",
    "path": "/messages/:message_id/reactions/:emoji",
    "group": "im",
    "summary": "取消表情回应"
  },
  {
    "method": "GET",
    "path": "/messages/:message_id/read-users",
    "group": "im",
    "summary": "已读 / 未读名单（只有发送人可看，其他人 403）"
  },
  {
    "method": "POST",
    "path": "/messages/:message_id/recall",
    "group": "im",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/messages/:message_id/thread",
    "group": "im",
    "summary": "话题回复（正序分页，打开即记为已读）"
  },
  {
    "method": "DELETE",
    "path": "/messages/:message_id/thread/follow",
    "group": "im",
    "summary": "取消关注话题"
  },
  {
    "method": "POST",
    "path": "/messages/:message_id/thread/follow",
    "group": "im",
    "summary": "关注话题"
  },
  {
    "method": "POST",
    "path": "/messages/:message_id/urgent",
    "group": "im",
    "summary": "加急自己发的消息"
  },
  {
    "method": "POST",
    "path": "/messages/:message_id/urgent/ack",
    "group": "im",
    "summary": "确认加急（推 message.urgent_acked）"
  },
  {
    "method": "POST",
    "path": "/messages/forward",
    "group": "im",
    "summary": "逐条 / 合并转发（最多 100 条消息、10 个会话）"
  },
  {
    "method": "GET",
    "path": "/messages/search",
    "group": "im",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/messages/urgent/pending",
    "group": "im",
    "summary": "我还没确认的加急"
  },
  {
    "method": "GET",
    "path": "/notifications",
    "group": "notify",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/notifications/read",
    "group": "notify",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/notifications/unread-count",
    "group": "notify",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/recent",
    "group": "other",
    "summary": "最近访问（打开文档、表格、单条记录时自动记录）"
  },
  {
    "method": "POST",
    "path": "/robots/:robot_id/estop",
    "group": "other",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/robots/:robot_id/locations",
    "group": "other",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/robots/:robot_id/locations/:name",
    "group": "other",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/robots/:robot_id/logs",
    "group": "other",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/robots/:robot_id/status",
    "group": "other",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/roles",
    "group": "other",
    "summary": "角色列表（admin.roles 或 admin.members）"
  },
  {
    "method": "POST",
    "path": "/roles",
    "group": "other",
    "summary": "新建角色（admin.roles）"
  },
  {
    "method": "DELETE",
    "path": "/roles/:role_id",
    "group": "other",
    "summary": "删除角色；内置角色 400"
  },
  {
    "method": "PATCH",
    "path": "/roles/:role_id",
    "group": "other",
    "summary": "修改角色；super_admin 改权限 400"
  },
  {
    "method": "PUT",
    "path": "/roles/:role_id/members",
    "group": "other",
    "summary": "整体覆盖角色成员"
  },
  {
    "method": "GET",
    "path": "/search",
    "group": "other",
    "summary": "全局搜索（按权限过滤，total 准确，<em> 高亮）"
  },
  {
    "method": "GET",
    "path": "/tables",
    "group": "table",
    "summary": "表清单（内置表在前，自定义表按创建时间正序；每项带 builtin）"
  },
  {
    "method": "POST",
    "path": "/tables",
    "group": "table",
    "summary": "新建数据表（所有已登录、未禁用用户）"
  },
  {
    "method": "DELETE",
    "path": "/tables/:table_key",
    "group": "table",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/tables/:table_key",
    "group": "table",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/tables/:table_key",
    "group": "table",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/copy",
    "group": "table",
    "summary": "复制表（可带记录，最多 10000 条）"
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/exports",
    "group": "table",
    "summary": "导出（异步；按视图筛选排序隐藏列）"
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/fields",
    "group": "table",
    "summary": ""
  },
  {
    "method": "DELETE",
    "path": "/tables/:table_key/fields/:field_name",
    "group": "table",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/tables/:table_key/fields/:field_name",
    "group": "table",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/fields/:field_name/convert-preview",
    "group": "table",
    "summary": ""
  },
  {
    "method": "PUT",
    "path": "/tables/:table_key/fields/order",
    "group": "table",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/imports",
    "group": "table",
    "summary": "导入记录（异步；upsert 按主字段匹配）"
  },
  {
    "method": "GET",
    "path": "/tables/:table_key/permissions",
    "group": "table",
    "summary": "表权限"
  },
  {
    "method": "PUT",
    "path": "/tables/:table_key/permissions",
    "group": "table",
    "summary": "修改表权限（can_manage；机器人不能代办）"
  },
  {
    "method": "GET",
    "path": "/tables/:table_key/records",
    "group": "table",
    "summary": "查询记录（过滤/排序/分页）"
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/records",
    "group": "table",
    "summary": "新建记录"
  },
  {
    "method": "DELETE",
    "path": "/tables/:table_key/records/:record_id",
    "group": "table",
    "summary": "删除记录"
  },
  {
    "method": "GET",
    "path": "/tables/:table_key/records/:record_id",
    "group": "table",
    "summary": "读取单条记录"
  },
  {
    "method": "PATCH",
    "path": "/tables/:table_key/records/:record_id",
    "group": "table",
    "summary": "更新记录（部分字段）"
  },
  {
    "method": "GET",
    "path": "/tables/:table_key/records/:record_id/comments",
    "group": "table",
    "summary": "记录评论"
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/records/:record_id/comments",
    "group": "table",
    "summary": "发表评论（@ 通知 record.mention）"
  },
  {
    "method": "DELETE",
    "path": "/tables/:table_key/records/:record_id/comments/:comment_id",
    "group": "table",
    "summary": "删除自己的评论"
  },
  {
    "method": "GET",
    "path": "/tables/:table_key/records/:record_id/history",
    "group": "table",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/records/batch_create",
    "group": "table",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/records/batch_delete",
    "group": "table",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/records/batch_update",
    "group": "table",
    "summary": ""
  },
  {
    "method": "GET",
    "path": "/tables/:table_key/views",
    "group": "table",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/tables/:table_key/views",
    "group": "table",
    "summary": ""
  },
  {
    "method": "DELETE",
    "path": "/tables/:table_key/views/:view_id",
    "group": "table",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/tables/:table_key/views/:view_id",
    "group": "table",
    "summary": ""
  },
  {
    "method": "PUT",
    "path": "/tables/:table_key/views/order",
    "group": "table",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/tables/imports/preview",
    "group": "table",
    "summary": "导入预览（xlsx / csv，UTF-8 / GBK）"
  },
  {
    "method": "GET",
    "path": "/tasklists",
    "group": "task",
    "summary": "可见任务清单"
  },
  {
    "method": "POST",
    "path": "/tasklists",
    "group": "task",
    "summary": "创建清单及默认分组"
  },
  {
    "method": "DELETE",
    "path": "/tasklists/:list_id",
    "group": "task",
    "summary": "删除清单但保留任务"
  },
  {
    "method": "PATCH",
    "path": "/tasklists/:list_id",
    "group": "task",
    "summary": "修改清单"
  },
  {
    "method": "GET",
    "path": "/tasklists/:list_id/members",
    "group": "task",
    "summary": "清单成员与版本"
  },
  {
    "method": "PUT",
    "path": "/tasklists/:list_id/members",
    "group": "task",
    "summary": "保存清单授权"
  },
  {
    "method": "GET",
    "path": "/tasklists/:list_id/sections",
    "group": "task",
    "summary": "有序分组"
  },
  {
    "method": "POST",
    "path": "/tasklists/:list_id/sections",
    "group": "task",
    "summary": "创建分组"
  },
  {
    "method": "DELETE",
    "path": "/tasklists/:list_id/sections/:section_id",
    "group": "task",
    "summary": "删除分组，任务移至未分组"
  },
  {
    "method": "PATCH",
    "path": "/tasklists/:list_id/sections/:section_id",
    "group": "task",
    "summary": "分组改名"
  },
  {
    "method": "GET",
    "path": "/tasklists/:list_id/tasks",
    "group": "task",
    "summary": "清单任务"
  },
  {
    "method": "GET",
    "path": "/tasks",
    "group": "task",
    "summary": "任务列表（可按指派人/状态过滤）"
  },
  {
    "method": "POST",
    "path": "/tasks",
    "group": "task",
    "summary": "创建任务（帮扶提醒等场景）"
  },
  {
    "method": "DELETE",
    "path": "/tasks/:task_id",
    "group": "task",
    "summary": "删除任务及其子任务"
  },
  {
    "method": "GET",
    "path": "/tasks/:task_id",
    "group": "task",
    "summary": "获取有权查看的任务"
  },
  {
    "method": "PATCH",
    "path": "/tasks/:task_id",
    "group": "task",
    "summary": "更新任务（状态/标题/截止时间）"
  },
  {
    "method": "GET",
    "path": "/tasks/:task_id/activities",
    "group": "task",
    "summary": "读取activities"
  },
  {
    "method": "GET",
    "path": "/tasks/:task_id/comments",
    "group": "task",
    "summary": "读取comments"
  },
  {
    "method": "POST",
    "path": "/tasks/:task_id/comments",
    "group": "task",
    "summary": "发表任务评论"
  },
  {
    "method": "DELETE",
    "path": "/tasks/:task_id/comments/:comment_id",
    "group": "task",
    "summary": "删除有权删除的评论"
  },
  {
    "method": "DELETE",
    "path": "/tasks/:task_id/followers/:user_id",
    "group": "task",
    "summary": "移除关注人"
  },
  {
    "method": "POST",
    "path": "/tasks/:task_id/followers/:user_id",
    "group": "task",
    "summary": "添加关注人"
  },
  {
    "method": "GET",
    "path": "/tasks/:task_id/subtasks",
    "group": "task",
    "summary": "读取subtasks"
  },
  {
    "method": "POST",
    "path": "/tasks/:task_id/subtasks/order",
    "group": "task",
    "summary": "保存全部直接子任务顺序"
  },
  {
    "method": "POST",
    "path": "/tasks/:task_id/tasklists",
    "group": "task",
    "summary": "加入清单或移动分组"
  },
  {
    "method": "DELETE",
    "path": "/tasks/:task_id/tasklists/:list_id",
    "group": "task",
    "summary": "解除清单关联"
  },
  {
    "method": "GET",
    "path": "/users",
    "group": "contact",
    "summary": "组织成员列表（通讯录）"
  },
  {
    "method": "POST",
    "path": "/users",
    "group": "contact",
    "summary": "新建成员（admin.members）；返回一次性 initial_password"
  },
  {
    "method": "GET",
    "path": "/users/:user_id",
    "group": "contact",
    "summary": ""
  },
  {
    "method": "PATCH",
    "path": "/users/:user_id",
    "group": "contact",
    "summary": "修改成员 / 停用启用（admin.members；改 role_ids 还要 admin.roles）"
  },
  {
    "method": "GET",
    "path": "/users/:user_id/avatar",
    "group": "contact",
    "summary": "用户头像（公开，无需令牌）"
  },
  {
    "method": "POST",
    "path": "/users/:user_id/logout-all",
    "group": "contact",
    "summary": "管理员强制成员所有设备下线"
  },
  {
    "method": "POST",
    "path": "/users/:user_id/reset-password",
    "group": "contact",
    "summary": "管理员重置成员密码（返回一次性密码，成员下次登录须改密）"
  },
  {
    "method": "POST",
    "path": "/users/import",
    "group": "contact",
    "summary": "成员批量导入（异步）"
  },
  {
    "method": "POST",
    "path": "/users/import/preview",
    "group": "contact",
    "summary": "成员导入预览"
  },
  {
    "method": "GET",
    "path": "/users/import/template",
    "group": "contact",
    "summary": "成员导入模板（xlsx）"
  },
  {
    "method": "GET",
    "path": "/users/me",
    "group": "contact",
    "summary": "当前用户信息"
  },
  {
    "method": "PATCH",
    "path": "/users/me",
    "group": "contact",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/users/me/logout-all",
    "group": "contact",
    "summary": "退出除当前设备外的所有设备"
  },
  {
    "method": "GET",
    "path": "/users/me/notification-settings",
    "group": "contact",
    "summary": ""
  },
  {
    "method": "PUT",
    "path": "/users/me/notification-settings",
    "group": "contact",
    "summary": ""
  },
  {
    "method": "POST",
    "path": "/users/me/password",
    "group": "contact",
    "summary": "修改本人密码（其他设备下线，当前设备保留）"
  },
  {
    "method": "GET",
    "path": "/users/me/sessions",
    "group": "contact",
    "summary": "本人登录设备列表"
  },
  {
    "method": "DELETE",
    "path": "/users/me/sessions/:session_id",
    "group": "contact",
    "summary": "退出某个登录设备"
  },
  {
    "method": "DELETE",
    "path": "/wiki/nodes/:node_id",
    "group": "other",
    "summary": "删除页面（子页面一起，文档进回收站）"
  },
  {
    "method": "GET",
    "path": "/wiki/nodes/:node_id",
    "group": "other",
    "summary": "单个页面"
  },
  {
    "method": "PATCH",
    "path": "/wiki/nodes/:node_id",
    "group": "other",
    "summary": "重命名（同步文档标题）"
  },
  {
    "method": "GET",
    "path": "/wiki/nodes/:node_id/ancestors",
    "group": "other",
    "summary": "面包屑（从根到父节点，不含自己）"
  },
  {
    "method": "POST",
    "path": "/wiki/nodes/:node_id/copy",
    "group": "other",
    "summary": "复制（可含子页面，最多 500 个）"
  },
  {
    "method": "POST",
    "path": "/wiki/nodes/:node_id/move",
    "group": "other",
    "summary": "移动，可跨空间（整棵子树）；after_node_id 为 null 放第一个"
  },
  {
    "method": "GET",
    "path": "/wiki/recent",
    "group": "other",
    "summary": "最近访问的页面（带 space_name、starred）"
  },
  {
    "method": "GET",
    "path": "/wiki/spaces",
    "group": "other",
    "summary": "我能看到的知识空间"
  },
  {
    "method": "POST",
    "path": "/wiki/spaces",
    "group": "other",
    "summary": "新建知识空间（wiki.create）"
  },
  {
    "method": "DELETE",
    "path": "/wiki/spaces/:space_id",
    "group": "other",
    "summary": "删除空间（空间管理员）；页面文档进回收站"
  },
  {
    "method": "GET",
    "path": "/wiki/spaces/:space_id",
    "group": "other",
    "summary": "单个空间"
  },
  {
    "method": "PATCH",
    "path": "/wiki/spaces/:space_id",
    "group": "other",
    "summary": "修改空间（空间管理员）"
  },
  {
    "method": "POST",
    "path": "/wiki/spaces/:space_id/import",
    "group": "other",
    "summary": "把已有云文档移入（需要文档管理权限）"
  },
  {
    "method": "GET",
    "path": "/wiki/spaces/:space_id/members",
    "group": "other",
    "summary": "空间成员"
  },
  {
    "method": "PUT",
    "path": "/wiki/spaces/:space_id/members",
    "group": "other",
    "summary": "整体覆盖成员和可见范围（空间管理员；机器人不能代办）"
  },
  {
    "method": "GET",
    "path": "/wiki/spaces/:space_id/nodes",
    "group": "other",
    "summary": "子节点（不传 parent_id 为第一层），按 order"
  },
  {
    "method": "POST",
    "path": "/wiki/spaces/:space_id/nodes",
    "group": "other",
    "summary": "新建页面（同时建一篇云文档）；after_node_id 为 null 放第一个，不传放最后"
  },
  {
    "method": "GET",
    "path": "/wiki/starred",
    "group": "other",
    "summary": "我收藏的页面"
  },
  {
    "method": "GET",
    "path": "/workbench/apps",
    "group": "other",
    "summary": "内置应用（按功能开关过滤）+ 我的快捷方式"
  },
  {
    "method": "PUT",
    "path": "/workbench/shortcuts",
    "group": "other",
    "summary": "整体覆盖我的快捷方式（最多 50 个），新项分配 id"
  }
];
