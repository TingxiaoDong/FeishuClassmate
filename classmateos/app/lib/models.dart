/// ClassmateOS 数据模型 —— 对齐《后端对接说明》与《前端接口需求文档》。
/// 纯 Dart，无 Flutter 依赖，四端共用。所有字段缺失时都有默认值（后端可分批上线）。
library;

DateTime? _iso(dynamic v) => v == null ? null : DateTime.tryParse(v.toString());
DateTime? _msToDate(dynamic v) => v is num ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : null;
List<String> _strList(dynamic v) => (v as List?)?.map((e) => e.toString()).toList() ?? const [];
Map<String, dynamic>? _map(dynamic v) => v is Map ? v.cast<String, dynamic>() : null;
String? _str(dynamic v) => v == null ? null : (v.toString().isEmpty ? null : v.toString());

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
  });

  bool get isAdmin => role == 'admin';
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
  });

  bool get isGroup => chatType == 'group';
  bool get isDrive => kind == 'drive';

  /// 列表排序用的最后活动时间。
  DateTime get activeAt => lastMessage?.createdAt ?? updatedAt ?? createdAt ?? DateTime(2000);

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
        lastMessage: _map(j['last_message']) != null ? CosMessage.fromJson(_map(j['last_message'])!) : null,
        lastReadMessageId: _str(j['last_read_message_id']),
        pinned: j['pinned'] == true,
        muted: j['muted'] == true,
      );

  /// 合并只带基础字段的事件载荷（chat.updated / member_added 不含未读、置顶等个人字段）。
  void mergeBase(Map<String, dynamic> j) {
    if (j.containsKey('name')) name = _str(j['name']);
    if (j['member_ids'] is List) memberIds = _strList(j['member_ids']);
    if (j.containsKey('owner_id')) ownerId = _str(j['owner_id']);
    if (j.containsKey('description')) description = _str(j['description']);
    final u = _iso(j['updated_at']);
    if (u != null) updatedAt = u;
  }
}

class CosMessage {
  final String messageId;
  final String chatId;
  final String senderId;
  final String msgType; // text | post | image | file | interactive_card | system
  final Map<String, dynamic> content;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final bool recalled;
  final String? replyToMessageId;

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
      );

  CosMessage copyWith({Map<String, dynamic>? content, DateTime? updatedAt, bool? recalled}) => CosMessage(
        messageId: messageId,
        chatId: chatId,
        senderId: senderId,
        msgType: msgType,
        content: content ?? this.content,
        createdAt: createdAt,
        updatedAt: updatedAt ?? this.updatedAt,
        recalled: recalled ?? this.recalled,
        replyToMessageId: replyToMessageId,
      );

  /// 文本消息的便捷访问器。
  String get text => content['text']?.toString() ?? '';

  /// 文本被编辑过（卡片被回答也会更新 updated_at，所以只看文本消息）。
  bool get edited => msgType == 'text' && !recalled && updatedAt != null;

  /// 卡片回答：`{user_id, action, answered_at}`；未回答为 null。
  Map<String, dynamic>? get cardAnswer => _map(content['answer']);
  bool get cardExpired => content['expired'] == true;

  /// @ 提及：`[{user_id, name}]`。
  List<Map<String, dynamic>> get mentions =>
      (content['mentions'] as List?)?.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() ?? const [];
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

  const CosTableMeta({
    required this.key,
    required this.name,
    this.description,
    this.icon,
    this.primaryField,
    this.fields = const [],
  });

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
        fields: (j['fields'] as List?)
                ?.map((e) => CosFieldMeta.fromJson((e as Map).cast<String, dynamic>()))
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

  const CosFieldMeta({
    required this.fieldName,
    required this.type,
    this.options,
    this.title,
    this.optionColors = const {},
    this.required = false,
    this.description,
  });

  String get label => (title == null || title!.isEmpty) ? fieldName : title!;

  factory CosFieldMeta.fromJson(Map<String, dynamic> j) => CosFieldMeta(
        fieldName: j['field_name'] as String? ?? '',
        type: (j['type'] as num?)?.toInt() ?? 0,
        options: (j['options'] as List?)?.map((e) => e.toString()).toList(),
        title: _str(j['title']),
        optionColors: (_map(j['option_colors']) ?? const {}).map((k, v) => MapEntry(k, v.toString())),
        required: j['required'] == true,
        description: _str(j['description']),
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
  });

  factory CosEvent.fromJson(Map<String, dynamic> j) => CosEvent(
        eventId: j['event_id'] as String? ?? '',
        eventType: j['event_type'] as String? ?? '',
        createdAt: _iso(j['created_at']),
        message: _map(j['message']) != null ? CosMessage.fromJson(_map(j['message'])!) : null,
        chat: _map(j['chat']),
        read: _map(j['read']),
        userId: _str(j['user_id']),
        task: _map(j['task']),
        event: _map(j['event']),
        userIds: _strList(j['user_ids']),
      );
}

// ---------------- 日历 ----------------

class CosAttendee {
  final String userId;
  final String rsvp; // pending | accepted | declined | tentative
  const CosAttendee(this.userId, this.rsvp);
}

class CosCalendarEvent {
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
    final att = (j['attendees'] as List?)
            ?.whereType<Map>()
            .map((e) => CosAttendee(e['user_id']?.toString() ?? '', e['rsvp']?.toString() ?? 'pending'))
            .toList() ??
        const <CosAttendee>[];
    final ids = _strList(j['attendee_ids']);
    return CosCalendarEvent(
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
      reminders: (j['reminders'] as List?)?.whereType<num>().map((e) => e.toInt()).toList(),
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
  });

  bool get isDone => status == 'done';

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
      );
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
  });

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

  CosFileRef get ref => CosFileRef(fileKey: fileKey, fileName: fileName, size: size, contentType: contentType);

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
      sourceType: src?['type']?.toString() ?? (j['in_drive'] == true ? 'drive' : 'chat'),
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

  factory CosMessageHit.fromJson(Map<String, dynamic> j) => CosMessageHit(CosMessage.fromJson(j), _str(j['highlight']));
}
