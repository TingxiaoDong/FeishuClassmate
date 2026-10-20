/// ClassmateOS 数据模型 —— 对齐《后端对接说明》与《前端接口需求文档》。
/// 纯 Dart，无 Flutter 依赖，四端共用。所有字段缺失时都有默认值（后端可分批上线）。
library;

DateTime? _iso(dynamic v) => v == null ? null : DateTime.tryParse(v.toString());
DateTime? _msToDate(dynamic v) =>
    v is num ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : null;
List<String> _strList(dynamic v) =>
    (v as List?)?.map((e) => e.toString()).toList() ?? const [];
Map<String, dynamic>? _map(dynamic v) =>
    v is Map ? v.cast<String, dynamic>() : null;
String? _str(dynamic v) =>
    v == null ? null : (v.toString().isEmpty ? null : v.toString());

/// 分页结果：`{items, has_more, page_token, total}`。
class CosPage<T> {
  final List<T> items;
  final bool hasMore;
  final String? pageToken;
  final int? total;
  const CosPage(this.items, {this.hasMore = false, this.pageToken, this.total});
}

class CosUser {
  final String userId;
  final String name;
  final String? email;
  final String? role; // admin | member | bot
  final String? avatarUrl;
  final String? department;
  final String? title;
  final String? phone;
  final String? statusText;

  /// 迭代 5（R-AD-03）：权限点，如 admin.members。后端没返回时为 null，按 role 兜底。
  final List<String>? permissions;

  /// 迭代 5（R-AD-02）：主部门、直属上级。旧后端没有时为 null。
  final String? primaryDepartmentId;
  final String? leaderId;

  /// 迭代 5 批次 1：首次登录 / 被重置密码后须先改密（只有登录、刷新的返回里有）。
  final bool mustChangePassword;

  const CosUser({
    required this.userId,
    required this.name,
    this.email,
    this.role,
    this.avatarUrl,
    this.department,
    this.title,
    this.phone,
    this.statusText,
    this.permissions,
    this.primaryDepartmentId,
    this.leaderId,
    this.mustChangePassword = false,
  });

  /// 改密成功后清掉强制改密标记。
  CosUser withoutPasswordChange() => CosUser(
        userId: userId, name: name, email: email, role: role, avatarUrl: avatarUrl, department: department,
        title: title, phone: phone, statusText: statusText, permissions: permissions,
        primaryDepartmentId: primaryDepartmentId, leaderId: leaderId);

  bool get isAdmin => role == 'admin';

  /// 是否有某个权限点；后端没返回 permissions 时，管理员视为全部都有。
  bool can(String perm) => permissions == null ? isAdmin : permissions!.contains(perm);
  bool get isBot => role == 'bot' || userId == 'bot';

  factory CosUser.fromJson(Map<String, dynamic> j) => CosUser(
    userId: j['user_id'] as String? ?? '',
    name: j['name'] as String? ?? '',
    email: _str(j['email']),
    role: j['role'] as String?,
    avatarUrl: _str(j['avatar_url']),
    department: _str(j['department']),
    title: _str(j['title']),
    phone: _str(j['phone']),
    statusText: _str(j['status_text']),
    permissions: j['permissions'] is List ? [for (final p in j['permissions'] as List) p.toString()] : null,
    primaryDepartmentId: _str(j['primary_department_id']),
    leaderId: _str(j['leader_id']),
    mustChangePassword: j['must_change_password'] == true,
  );

  Map<String, dynamic> toJson() => {
    'user_id': userId,
    'name': name,
    'email': email,
    'role': role,
    'avatar_url': avatarUrl,
    'department': department,
    'title': title,
    'phone': phone,
    'status_text': statusText,
    if (permissions != null) 'permissions': permissions,
  };
}

/// 会话。服务端维护的字段（未读、最后消息、置顶等）可变，便于实时事件就地更新。
class CosChat {
  final String chatId;
  final String chatType; // p2p | group
  String? name;
  List<String> memberIds;
  String? ownerId;
  String? description;
  final String kind; // normal | drive
  final DateTime? createdAt;
  DateTime? updatedAt;
  int unreadCount;
  CosMessage? lastMessage;
  String? lastReadMessageId;
  bool pinned;
  bool muted;

  /// 迭代 4：话题模式群（整个群只能以话题形式发言）。
  bool threadMode;

  /// 迭代 4：参与过的话题里有新回复的数量（会话列表显示「话题」小标）。
  int threadUnreadCount;

  /// 迭代 4（R-IM-06）：群里固定的消息 ID（会话顶部「已固定 N 条」）。
  List<String> pinnedMessageIds;

  CosChat({
    required this.chatId,
    required this.chatType,
    this.name,
    this.memberIds = const [],
    this.ownerId,
    this.description,
    this.kind = 'normal',
    this.createdAt,
    this.updatedAt,
    this.unreadCount = 0,
    this.lastMessage,
    this.lastReadMessageId,
    this.pinned = false,
    this.muted = false,
    this.threadMode = false,
    this.threadUnreadCount = 0,
    List<String>? pinnedMessageIds,
  }) : pinnedMessageIds = pinnedMessageIds ?? [];

  bool get isGroup => chatType == 'group';
  bool get isDrive => kind == 'drive';

  /// 列表排序用的最后活动时间。
  DateTime get activeAt =>
      lastMessage?.createdAt ?? updatedAt ?? createdAt ?? DateTime(2000);

  factory CosChat.fromJson(Map<String, dynamic> j) => CosChat(
    chatId: j['chat_id'] as String? ?? '',
    chatType: j['chat_type'] as String? ?? 'p2p',
    name: _str(j['name']),
    memberIds: _strList(j['member_ids']),
    ownerId: _str(j['owner_id']),
    description: _str(j['description']),
    kind: j['kind'] as String? ?? 'normal',
    createdAt: _iso(j['created_at']),
    updatedAt: _iso(j['updated_at']),
    unreadCount: (j['unread_count'] as num?)?.toInt() ?? 0,
    lastMessage: _map(j['last_message']) != null
        ? CosMessage.fromJson(_map(j['last_message'])!)
        : null,
    lastReadMessageId: _str(j['last_read_message_id']),
    pinned: j['pinned'] == true,
    muted: j['muted'] == true,
    threadMode: j['thread_mode'] == true,
    threadUnreadCount: (j['thread_unread_count'] as num?)?.toInt() ?? 0,
    pinnedMessageIds: _strList(j['pinned_message_ids']),
  );

  /// 合并只带基础字段的事件载荷（chat.updated / member_added 不含未读、置顶等个人字段）。
  void mergeBase(Map<String, dynamic> j) {
    if (j.containsKey('name')) name = _str(j['name']);
    if (j['member_ids'] is List) memberIds = _strList(j['member_ids']);
    if (j.containsKey('owner_id')) ownerId = _str(j['owner_id']);
    if (j.containsKey('description')) description = _str(j['description']);
    if (j.containsKey('thread_mode')) threadMode = j['thread_mode'] == true;
    if (j['pinned_message_ids'] is List) pinnedMessageIds = _strList(j['pinned_message_ids']);
    final u = _iso(j['updated_at']);
    if (u != null) updatedAt = u;
  }
}

class CosMessage {
  final String messageId;
  final String chatId;
  final String senderId;
  final String
  msgType; // text | post | image | file | interactive_card | system
  final Map<String, dynamic> content;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final bool recalled;
  final String? replyToMessageId;

  /// 原始 JSON（迭代 4 的新字段从这里取，旧后端缺字段时取默认值）。
  final Map<String, dynamic> raw;

  const CosMessage({
    required this.messageId,
    required this.chatId,
    required this.senderId,
    required this.msgType,
    this.content = const {},
    this.createdAt,
    this.updatedAt,
    this.recalled = false,
    this.replyToMessageId,
    this.raw = const {},
  });

  factory CosMessage.fromJson(Map<String, dynamic> j) => CosMessage(
    messageId: j['message_id'] as String? ?? '',
    chatId: j['chat_id'] as String? ?? '',
    senderId: j['sender_id'] as String? ?? '',
    msgType: j['msg_type'] as String? ?? 'text',
    content: _map(j['content']) ?? const {},
    createdAt: _iso(j['created_at']),
    updatedAt: _iso(j['updated_at']),
    recalled: j['recalled'] == true,
    replyToMessageId: _str(j['reply_to_message_id']),
    raw: j,
  );

  CosMessage copyWith({
    Map<String, dynamic>? content,
    DateTime? updatedAt,
    bool? recalled,
    Map<String, dynamic>? raw,
  }) => CosMessage(
    messageId: messageId,
    chatId: chatId,
    senderId: senderId,
    msgType: msgType,
    content: content ?? this.content,
    createdAt: createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    recalled: recalled ?? this.recalled,
    replyToMessageId: replyToMessageId,
    raw: raw ?? this.raw,
  );

  // ---------- 迭代 4：消息增强 ----------

  /// 已读回执（仅自己发的消息）：已读人数 / 应读人数（不含自己）。
  int? get readCount => (raw['read_count'] as num?)?.toInt();
  int? get memberCount => (raw['member_count'] as num?)?.toInt();

  /// 话题回复所属的根消息；根消息自己为 null。
  String? get threadRootId => _str(raw['thread_root_id']);

  /// 话题回复同时发到了群里（主会话也显示）。
  bool get alsoSendToChat => raw['also_send_to_chat'] == true;

  /// 根消息的话题摘要；没有回复时为 null。
  CosThreadInfo? get thread {
    final t = _map(raw['thread']);
    if (t == null || ((t['reply_count'] as num?)?.toInt() ?? 0) <= 0) return null;
    return CosThreadInfo.fromJson(t);
  }

  List<CosReaction> get reactions => [
        for (final r in (raw['reactions'] as List? ?? const []))
          if (r is Map) CosReaction.fromJson(r.cast<String, dynamic>()),
      ]..removeWhere((r) => r.count <= 0);

  /// AI 助手代某位同学发的消息（后端待改问题 C2）：`content.sent_on_behalf_of = {user_id, name}`。
  /// 由服务端写入，客户端不能伪造；回同学本人的单聊里没有这个字段。
  CosOnBehalf? get onBehalfOf {
    final o = _map(content['sent_on_behalf_of']);
    final id = o == null ? null : _str(o['user_id']);
    if (id == null || id.isEmpty) return null;
    return CosOnBehalf(userId: id, name: _str(o!['name']) ?? '');
  }

  /// 单条转发来的消息：`{chat_name, sender_id}`。
  Map<String, dynamic>? get forwardedFrom => _map(raw['forwarded_from']);

  /// 加急状态（仅发送人能看到）：`{user_ids, ack_user_ids}`。
  Map<String, dynamic>? get urgent => _map(raw['urgent']);
  int get urgentUnacked {
    final u = urgent;
    if (u == null) return 0;
    final ack = _strList(u['ack_user_ids']).toSet();
    return _strList(u['user_ids']).where((id) => !ack.contains(id)).length;
  }

  /// 文本消息的便捷访问器。
  String get text => content['text']?.toString() ?? '';

  /// 文本被编辑过（卡片被回答也会更新 updated_at，所以只看文本消息）。
  bool get edited => msgType == 'text' && !recalled && updatedAt != null;

  /// 卡片回答：`{user_id, action, answered_at}`；未回答为 null。
  Map<String, dynamic>? get cardAnswer => _map(content['answer']);
  bool get cardExpired => content['expired'] == true;

  /// @ 提及：`[{user_id, name}]`。
  List<Map<String, dynamic>> get mentions =>
      (content['mentions'] as List?)
          ?.whereType<Map>()
          .map((e) => e.cast<String, dynamic>())
          .toList() ??
      const [];
}

class CosRecord {
  final String recordId;
  final Map<String, dynamic> fields;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final String? createdBy;
  final String? updatedBy;

  const CosRecord({
    required this.recordId,
    this.fields = const {},
    this.createdAt,
    this.updatedAt,
    this.createdBy,
    this.updatedBy,
  });

  factory CosRecord.fromJson(Map<String, dynamic> j) => CosRecord(
    recordId: j['record_id'] as String? ?? '',
    fields: _map(j['fields']) ?? const {},
    createdAt: _iso(j['created_at']),
    updatedAt: _iso(j['updated_at']),
    createdBy: _str(j['created_by']),
    updatedBy: _str(j['updated_by']),
  );
}

class CosTableMeta {
  final String key;
  final String name;
  final String? description;
  final String? icon;
  final String? primaryField;
  final List<CosFieldMeta> fields;

  /// 内置表为 true；用户新建的自定义表为 false（旧后端不返回时按内置处理）。
  final bool builtin;
  final String? createdBy;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  /// 二期：表结构版本（字段接口并发保护 base_version）。
  final int? version;

  /// 二期：权限；旧后端不返回时为 null，由 [permsFor] 兜底。
  final CosPermissions? permissions;

  const CosTableMeta({
    required this.key,
    required this.name,
    this.description,
    this.icon,
    this.primaryField,
    this.fields = const [],
    this.builtin = true,
    this.createdBy,
    this.createdAt,
    this.updatedAt,
    this.version,
    this.permissions,
  });

  /// 前端只看 permissions；旧后端没有该字段时：都能编辑，管理员和创建者能管理。
  CosPermissions permsFor(CosUser me) =>
      permissions ??
      CosPermissions(
        canView: true,
        canEdit: true,
        canComment: true,
        canManage: me.role == 'admin' || createdBy == me.userId,
        canDelete: me.role == 'admin' || createdBy == me.userId,
      );

  /// 内置表的内置字段：不可删、不可改类型。
  bool isBuiltinField(CosFieldMeta f) => f.builtin ?? builtin;

  CosTableMeta copyWith({List<CosFieldMeta>? fields, int? version, String? name}) => CosTableMeta(
    key: key,
    name: name ?? this.name,
    description: description,
    icon: icon,
    primaryField: primaryField,
    fields: fields ?? this.fields,
    builtin: builtin,
    createdBy: createdBy,
    createdAt: createdAt,
    updatedAt: updatedAt,
    version: version ?? this.version,
    permissions: permissions,
  );

  CosFieldMeta? field(String name) {
    for (final f in fields) {
      if (f.fieldName == name) return f;
    }
    return null;
  }

  factory CosTableMeta.fromJson(Map<String, dynamic> j) => CosTableMeta(
    key: j['key'] as String? ?? '',
    name: j['name'] as String? ?? '',
    description: _str(j['description']),
    icon: _str(j['icon']),
    primaryField: _str(j['primary_field']),
    builtin: j['builtin'] != false,
    createdBy: _str(j['created_by']),
    createdAt: _iso(j['created_at']),
    updatedAt: _iso(j['updated_at']),
    version: (j['version'] as num?)?.toInt(),
    permissions: _map(j['permissions']) == null ? null : CosPermissions.fromJson(_map(j['permissions'])!),
    fields:
        (j['fields'] as List?)
            ?.map(
              (e) => CosFieldMeta.fromJson((e as Map).cast<String, dynamic>()),
            )
            .toList() ??
        const [],
  );
}

class CosFieldMeta {
  final String fieldName;
  final int type; // 沿用 Bitable 字段类型编号
  final List<String>? options;

  /// 中文显示名；没有时显示 field_name。
  final String? title;

  /// 选项颜色：选项 → 颜色名（blue / green / orange …）。
  final Map<String, String> optionColors;
  final bool required;
  final String? description;

  /// 二期：是否内置字段；旧后端不返回时为 null（按所在表是否内置判断）。
  final bool? builtin;

  const CosFieldMeta({
    required this.fieldName,
    required this.type,
    this.options,
    this.title,
    this.optionColors = const {},
    this.required = false,
    this.description,
    this.builtin,
  });

  bool get isSelect => type == 3 || type == 4;

  Map<String, dynamic> toJson() => {
    'field_name': fieldName,
    'title': label,
    'type': type,
    'required': required,
    if (options != null) 'options': options,
    if (optionColors.isNotEmpty) 'option_colors': optionColors,
    if (description != null) 'description': description,
    if (builtin != null) 'builtin': builtin,
  };

  String get label => (title == null || title!.isEmpty) ? fieldName : title!;

  factory CosFieldMeta.fromJson(Map<String, dynamic> j) => CosFieldMeta(
    fieldName: j['field_name'] as String? ?? '',
    type: (j['type'] as num?)?.toInt() ?? 0,
    options: (j['options'] as List?)?.map((e) => e.toString()).toList(),
    title: _str(j['title']),
    optionColors: (_map(j['option_colors']) ?? const {}).map(
      (k, v) => MapEntry(k, v.toString()),
    ),
    required: j['required'] == true,
    description: _str(j['description']),
    builtin: j['builtin'] is bool ? j['builtin'] as bool : null,
  );
}

/// 二期统一权限字段（需求文档 2.2）。
class CosPermissions {
  final bool canView;
  final bool canEdit;
  final bool canComment;
  final bool canManage;
  final bool canDelete;
  const CosPermissions({
    this.canView = true,
    this.canEdit = false,
    this.canComment = false,
    this.canManage = false,
    this.canDelete = false,
  });
  factory CosPermissions.fromJson(Map<String, dynamic> j) => CosPermissions(
    canView: j['can_view'] != false,
    canEdit: j['can_edit'] == true,
    canComment: j['can_comment'] == true,
    canManage: j['can_manage'] == true,
    canDelete: j['can_delete'] == true,
  );
}

/// 实时事件（用户 WS 帧）。
class CosEvent {
  final String eventId;
  final String eventType;
  final DateTime? createdAt;
  final CosMessage? message;
  final Map<String, dynamic>? chat;
  final Map<String, dynamic>? read;
  final String? userId;
  final Map<String, dynamic>? task;
  final Map<String, dynamic>? event;
  final List<String> userIds;

  /// 原始帧（二期事件的 table_key / record / notification 等从这里读）。
  final Map<String, dynamic> raw;

  const CosEvent({
    required this.eventId,
    required this.eventType,
    this.createdAt,
    this.message,
    this.chat,
    this.read,
    this.userId,
    this.task,
    this.event,
    this.userIds = const [],
    this.raw = const {},
  });

  String? str(String key) => _str(raw[key]);
  Map<String, dynamic>? map(String key) => _map(raw[key]);

  factory CosEvent.fromJson(Map<String, dynamic> j) => CosEvent(
    eventId: j['event_id'] as String? ?? '',
    eventType: j['event_type'] as String? ?? '',
    createdAt: _iso(j['created_at']),
    message: _map(j['message']) != null
        ? CosMessage.fromJson(_map(j['message'])!)
        : null,
    chat: _map(j['chat']),
    read: _map(j['read']),
    userId: _str(j['user_id']),
    task: _map(j['task']),
    event: _map(j['event']),
    userIds: _strList(j['user_ids']),
    raw: j,
  );
}

// ---------------- 日历 ----------------

class CosAttendee {
  final String userId;
  final String rsvp; // pending | accepted | declined | tentative
  const CosAttendee(this.userId, this.rsvp);
}

class CosCalendarEvent {
  final String? recurrence;
  final String? recurringEventId;
  final int? originalStartMs;
  final bool isException;
  bool get isRecurring => recurrence != null || recurringEventId != null;
  final String eventId;
  final String title;
  final DateTime start;
  final DateTime end;
  final List<String> attendeeIds;
  final List<CosAttendee> attendees;
  final String? description;
  final String? location;
  final bool allDay;
  final String? color;
  final List<int>? reminders;
  final String createdBy;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  /// 同事忙闲查询返回的匿名时间段。
  final bool busyOnly;

  const CosCalendarEvent({
    this.recurrence, this.recurringEventId, this.originalStartMs, this.isException = false,
    required this.eventId,
    required this.title,
    required this.start,
    required this.end,
    this.attendeeIds = const [],
    this.attendees = const [],
    this.description,
    this.location,
    this.allDay = false,
    this.color,
    this.reminders,
    required this.createdBy,
    this.createdAt,
    this.updatedAt,
    this.busyOnly = false,
  });

  String rsvpOf(String userId) {
    for (final a in attendees) {
      if (a.userId == userId) return a.rsvp;
    }
    return userId == createdBy ? 'accepted' : 'pending';
  }

  factory CosCalendarEvent.fromJson(Map<String, dynamic> j) {
    final att =
        (j['attendees'] as List?)
            ?.whereType<Map>()
            .map(
              (e) => CosAttendee(
                e['user_id']?.toString() ?? '',
                e['rsvp']?.toString() ?? 'pending',
              ),
            )
            .toList() ??
        const <CosAttendee>[];
    final ids = _strList(j['attendee_ids']);
    return CosCalendarEvent(
      recurrence: _str(j['recurrence']),
      recurringEventId: _str(j['recurring_event_id']),
      originalStartMs: (j['original_start_ms'] as num?)?.toInt(),
      isException: j['is_exception'] == true,
      eventId: j['event_id'] as String? ?? '',
      title: j['title'] as String? ?? '',
      start: _msToDate(j['start_ms']) ?? DateTime.now(),
      end: _msToDate(j['end_ms']) ?? DateTime.now(),
      attendeeIds: ids.isNotEmpty ? ids : att.map((a) => a.userId).toList(),
      attendees: att,
      description: _str(j['description']),
      location: _str(j['location']),
      allDay: j['all_day'] == true,
      color: _str(j['color']),
      reminders: (j['reminders'] as List?)
          ?.whereType<num>()
          .map((e) => e.toInt())
          .toList(),
      createdBy: j['created_by'] as String? ?? '',
      createdAt: _iso(j['created_at']),
      updatedAt: _iso(j['updated_at']),
      busyOnly: j['busy'] == true && j['event_id'] == null,
    );
  }
}

// ---------------- 任务 ----------------

/// 任务状态：pending | in_progress | done | cancelled；优先级：low | normal | high | urgent
class CosTask {
  final String taskId;
  final String title;
  final String status;
  final String? assigneeId;
  final DateTime? due;
  final String? description;
  final String priority;
  final Map<String, dynamic>? source;
  final String createdBy;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final DateTime? completedAt;

  // ---- 二期迭代 3（R-TK-01 ~ 04），旧后端没有这些字段时取默认值 ----
  final String? parentId;
  final int subtaskCount;
  final int subtaskDoneCount;

  /// 层级：顶层为 1，最多 3。后端没给时按 parentId 推断（有父任务记 2）。
  final int depth;
  final List<String> followerIds;

  /// 后端给出的操作权限；null 表示旧后端，前端退回「创建人 / 负责人可改」。
  final Map<String, bool>? permissions;

  /// 所属任务清单及在各清单里的分组。
  final List<CosTaskListRef> tasklists;

  const CosTask({
    required this.taskId,
    required this.title,
    required this.status,
    this.assigneeId,
    this.due,
    this.description,
    this.priority = 'normal',
    this.source,
    required this.createdBy,
    this.createdAt,
    this.updatedAt,
    this.completedAt,
    this.parentId,
    this.subtaskCount = 0,
    this.subtaskDoneCount = 0,
    this.depth = 1,
    this.followerIds = const [],
    this.permissions,
    this.tasklists = const [],
  });

  bool get isDone => status == 'done';

  /// 某个权限：后端给了就按后端；没给时用 [fallback]。
  bool can(String key, bool fallback) => permissions == null ? fallback : permissions![key] == true;

  /// 在某个清单里的分组。
  String? sectionIn(String listId) => tasklists.where((e) => e.listId == listId).firstOrNull?.sectionId;

  factory CosTask.fromJson(Map<String, dynamic> j) => CosTask(
    taskId: j['task_id'] as String? ?? '',
    title: j['title'] as String? ?? '',
    status: j['status'] as String? ?? 'pending',
    assigneeId: _str(j['assignee_id']),
    due: _msToDate(j['due_ms']),
    description: _str(j['description']),
    priority: j['priority'] as String? ?? 'normal',
    source: _map(j['source']),
    createdBy: j['created_by'] as String? ?? '',
    createdAt: _iso(j['created_at']),
    updatedAt: _iso(j['updated_at']),
    completedAt: _iso(j['completed_at']),
    parentId: _str(j['parent_id']),
    subtaskCount: (j['subtask_count'] as num?)?.toInt() ?? 0,
    subtaskDoneCount: (j['subtask_done_count'] as num?)?.toInt() ?? 0,
    depth: (j['depth'] as num?)?.toInt() ?? (_str(j['parent_id']) == null ? 1 : 2),
    followerIds: [for (final e in (j['follower_ids'] as List? ?? const [])) e.toString()],
    permissions: j['permissions'] is Map
        ? {for (final e in (j['permissions'] as Map).entries) e.key.toString(): e.value == true}
        : null,
    tasklists: [
      for (final e in (j['tasklists'] as List? ?? const []))
        if (e is Map) CosTaskListRef.fromJson(e.cast<String, dynamic>()),
    ],
  );
}

/// 任务所属的清单（R-TK-04）：同一个任务在不同清单里有各自的分组。
class CosTaskListRef {
  final String listId;
  final String? sectionId;
  final String? name;
  const CosTaskListRef(this.listId, this.sectionId, [this.name]);
  factory CosTaskListRef.fromJson(Map<String, dynamic> j) =>
      CosTaskListRef(j['list_id']?.toString() ?? '', _str(j['section_id']), _str(j['name']));
}

// ---------------- 文档 ----------------

class CosDoc {
  final String docId;
  final String title;
  final String createdBy;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final String? updatedBy;

  /// 后端按权限给出；旧后端没有该字段时为 null（前端退回按创建者判断）。
  final bool? canEdit;
  final String? summary;

  /// 列表接口不返回正文，为 null。
  final String? markdown;

  /// 原始 updated_at 字符串，用作并发保护的 base_updated_at。
  final String? updatedAtRaw;

  // ---- 二期（R-DC-01 / R-DC-05 / R-WK-03） ----
  final CosPermissions? permissions;
  final String? myRole; // viewer | commenter | editor | manager
  final String? ownerId;
  final String? folderId;
  final bool starred;
  final DateTime? lastViewedAt;
  final DateTime? deletedAt;

  /// 知识库页面：所属空间与节点（普通云文档为 null）。
  final String? wikiSpaceId;
  final String? wikiNodeId;

  const CosDoc({
    required this.docId,
    required this.title,
    required this.createdBy,
    this.createdAt,
    this.updatedAt,
    this.updatedBy,
    this.canEdit,
    this.summary,
    this.markdown,
    this.updatedAtRaw,
    this.permissions,
    this.myRole,
    this.ownerId,
    this.folderId,
    this.starred = false,
    this.lastViewedAt,
    this.deletedAt,
    this.wikiSpaceId,
    this.wikiNodeId,
  });

  /// 所有者：二期 owner_id，旧后端用创建者。
  String get owner => ownerId ?? createdBy;

  /// 统一权限：优先 permissions；旧后端按 can_edit / 创建者 / 管理员兜底。
  CosPermissions permsFor(CosUser me) {
    if (permissions != null) return permissions!;
    final mine = createdBy == me.userId;
    final edit = canEdit ?? mine;
    return CosPermissions(
      canView: true,
      canEdit: edit,
      canComment: edit,
      canManage: mine || me.isAdmin,
      canDelete: mine || me.isAdmin,
    );
  }

  factory CosDoc.fromJson(Map<String, dynamic> j) => CosDoc(
    docId: j['doc_id'] as String? ?? '',
    title: j['title'] as String? ?? '',
    createdBy: j['created_by'] as String? ?? '',
    createdAt: _iso(j['created_at']),
    updatedAt: _iso(j['updated_at']),
    updatedBy: _str(j['updated_by']),
    canEdit: j['can_edit'] is bool ? j['can_edit'] as bool : null,
    summary: _str(j['summary']),
    markdown: j['markdown'] as String?,
    updatedAtRaw: j['updated_at']?.toString(),
    permissions: _map(j['permissions']) != null ? CosPermissions.fromJson(_map(j['permissions'])!) : null,
    myRole: _str(j['my_role']),
    ownerId: _str(j['owner_id']),
    folderId: _str(j['folder_id']),
    starred: j['starred'] == true,
    lastViewedAt: _iso(j['last_viewed_at']),
    deletedAt: _iso(j['deleted_at']),
    wikiSpaceId: _str(j['wiki_space_id']),
    wikiNodeId: _str(j['wiki_node_id']),
  );
}

// ---------------- 文件 ----------------

/// 文件 / 图片消息里的文件引用（content: {file_key, file_name, size, content_type}）。
class CosFileRef {
  final String fileKey;
  final String fileName;
  final int size;
  final String? contentType;

  const CosFileRef({
    required this.fileKey,
    required this.fileName,
    this.size = 0,
    this.contentType,
  });

  factory CosFileRef.fromJson(Map<String, dynamic> j) => CosFileRef(
    fileKey: (j['file_key'] ?? j['file_token'] ?? '').toString(),
    fileName: (j['file_name'] ?? j['name'] ?? '未命名文件').toString(),
    size: (j['size'] as num?)?.toInt() ?? 0,
    contentType: j['content_type'] as String?,
  );

  Map<String, dynamic> toJson() => {
    'file_key': fileKey,
    'file_name': fileName,
    'size': size,
    if (contentType != null) 'content_type': contentType,
  };
}

/// 云盘文件（GET /files）。
class CosDriveFile {
  final String fileKey;
  final String fileName;
  final int size;
  final String? contentType;
  final String kind; // image | doc | pdf | sheet | slide | other
  final String uploaderId;
  final DateTime? createdAt;
  final bool inDrive;
  final String sourceType; // drive | chat | table
  final String? sourceChatId;
  final String? sourceMessageId;

  const CosDriveFile({
    required this.fileKey,
    required this.fileName,
    this.size = 0,
    this.contentType,
    this.kind = 'other',
    required this.uploaderId,
    this.createdAt,
    this.inDrive = false,
    this.sourceType = 'drive',
    this.sourceChatId,
    this.sourceMessageId,
  });

  CosFileRef get ref => CosFileRef(
    fileKey: fileKey,
    fileName: fileName,
    size: size,
    contentType: contentType,
  );

  factory CosDriveFile.fromJson(Map<String, dynamic> j) {
    final src = _map(j['source']);
    return CosDriveFile(
      fileKey: j['file_key']?.toString() ?? '',
      fileName: j['file_name']?.toString() ?? '未命名文件',
      size: (j['size'] as num?)?.toInt() ?? 0,
      contentType: _str(j['content_type']),
      kind: j['kind']?.toString() ?? 'other',
      uploaderId: j['uploader_id']?.toString() ?? '',
      createdAt: _iso(j['created_at']),
      inDrive: j['in_drive'] == true,
      sourceType:
          src?['type']?.toString() ??
          (j['in_drive'] == true ? 'drive' : 'chat'),
      sourceChatId: _str(src?['chat_id']),
      sourceMessageId: _str(src?['message_id']),
    );
  }
}

/// 消息搜索结果（带高亮片段）。
class CosMessageHit {
  final CosMessage message;
  final String? highlight;
  const CosMessageHit(this.message, this.highlight);

  factory CosMessageHit.fromJson(Map<String, dynamic> j) =>
      CosMessageHit(CosMessage.fromJson(j), _str(j['highlight']));
}


// ---------------- 迭代 4：消息增强 ----------------

/// 代发人：AI 助手代哪位同学发的消息。
class CosOnBehalf {
  final String userId;
  final String name;
  const CosOnBehalf({required this.userId, required this.name});
}

class CosThreadInfo {
  final int replyCount;
  final DateTime? lastReplyAt;
  final List<String> participants;
  final bool followed;
  const CosThreadInfo({this.replyCount = 0, this.lastReplyAt, this.participants = const [], this.followed = false});
  factory CosThreadInfo.fromJson(Map<String, dynamic> j) => CosThreadInfo(
        replyCount: (j['reply_count'] as num?)?.toInt() ?? 0,
        lastReplyAt: _iso(j['last_reply_at']),
        participants: _strList(j['participants']),
        followed: j['followed'] == true,
      );
}

class CosReaction {
  /// 固定英文 key，如 THUMBSUP；前端映射成表情。
  final String emoji;
  final int count;
  final List<String> userIds;
  final bool reactedByMe;
  const CosReaction(this.emoji, this.count, this.userIds, this.reactedByMe);
  factory CosReaction.fromJson(Map<String, dynamic> j) => CosReaction(
        j['emoji']?.toString() ?? '',
        (j['count'] as num?)?.toInt() ?? _strList(j['user_ids']).length,
        _strList(j['user_ids']),
        j['reacted_by_me'] == true,
      );
}

/// 加急提醒（WS `message.urgent` 或 `GET /messages/urgent/pending`）。
class CosUrgent {
  final String messageId;
  final String chatId;
  final String fromUserId;
  final String? preview;
  const CosUrgent(this.messageId, this.chatId, this.fromUserId, [this.preview]);
  factory CosUrgent.fromJson(Map<String, dynamic> j) => CosUrgent(
        j['message_id']?.toString() ?? '',
        j['chat_id']?.toString() ?? '',
        j['from_user_id']?.toString() ?? '',
        _str(j['preview']),
      );
}
