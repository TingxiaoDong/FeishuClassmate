/// ClassmateOS 数据模型 —— 对齐 classmateos/openapi.yaml components.schemas。
/// 纯 Dart，无 Flutter 依赖，四端共用。

class CosUser {
  final String userId;
  final String name;
  final String? email;
  final String? role; // admin | member | bot

  const CosUser({required this.userId, required this.name, this.email, this.role});

  factory CosUser.fromJson(Map<String, dynamic> j) => CosUser(
        userId: j['user_id'] as String? ?? '',
        name: j['name'] as String? ?? '',
        email: j['email'] as String?,
        role: j['role'] as String?,
      );
}

class CosChat {
  final String chatId;
  final String chatType; // p2p | group
  final String? name;
  final List<String> memberIds;
  final int unreadCount;

  const CosChat({
    required this.chatId,
    required this.chatType,
    this.name,
    this.memberIds = const [],
    this.unreadCount = 0,
  });

  factory CosChat.fromJson(Map<String, dynamic> j) => CosChat(
        chatId: j['chat_id'] as String? ?? '',
        chatType: j['chat_type'] as String? ?? 'p2p',
        name: j['name'] as String?,
        memberIds:
            (j['member_ids'] as List?)?.map((e) => e.toString()).toList() ?? const [],
        unreadCount: j['unread_count'] as int? ?? 0,
      );
}

class CosMessage {
  final String messageId;
  final String chatId;
  final String senderId;
  final String msgType; // text | post | image | file | interactive_card | system
  final Map<String, dynamic> content;
  final DateTime? createdAt;

  const CosMessage({
    required this.messageId,
    required this.chatId,
    required this.senderId,
    required this.msgType,
    this.content = const {},
    this.createdAt,
  });

  factory CosMessage.fromJson(Map<String, dynamic> j) => CosMessage(
        messageId: j['message_id'] as String? ?? '',
        chatId: j['chat_id'] as String? ?? '',
        senderId: j['sender_id'] as String? ?? '',
        msgType: j['msg_type'] as String? ?? 'text',
        content: (j['content'] as Map?)?.cast<String, dynamic>() ?? const {},
        createdAt: j['created_at'] != null ? DateTime.tryParse(j['created_at'].toString()) : null,
      );

  /// 文本消息的便捷访问器。
  String get text => content['text']?.toString() ?? '';
}

class CosRecord {
  final String recordId;
  final Map<String, dynamic> fields;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const CosRecord({required this.recordId, this.fields = const {}, this.createdAt, this.updatedAt});

  factory CosRecord.fromJson(Map<String, dynamic> j) => CosRecord(
        recordId: j['record_id'] as String? ?? '',
        fields: (j['fields'] as Map?)?.cast<String, dynamic>() ?? const {},
        createdAt: j['created_at'] != null ? DateTime.tryParse(j['created_at'].toString()) : null,
        updatedAt: j['updated_at'] != null ? DateTime.tryParse(j['updated_at'].toString()) : null,
      );
}

class CosTableMeta {
  final String key;
  final String name;
  final List<CosFieldMeta> fields;

  const CosTableMeta({required this.key, required this.name, this.fields = const []});

  factory CosTableMeta.fromJson(Map<String, dynamic> j) => CosTableMeta(
        key: j['key'] as String? ?? '',
        name: j['name'] as String? ?? '',
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

  const CosFieldMeta({required this.fieldName, required this.type, this.options});

  factory CosFieldMeta.fromJson(Map<String, dynamic> j) => CosFieldMeta(
        fieldName: j['field_name'] as String? ?? '',
        type: j['type'] as int? ?? 0,
        options: (j['options'] as List?)?.map((e) => e.toString()).toList(),
      );
}

/// Bot/实时事件（WS 帧，对齐 BotEvent schema）。
class CosEvent {
  final String eventId;
  final String eventType; // message.receive | card.action | message.read | chat.member_added
  final DateTime? createdAt;
  final CosMessage? message;
  final Map<String, dynamic>? cardAction;

  const CosEvent({
    required this.eventId,
    required this.eventType,
    this.createdAt,
    this.message,
    this.cardAction,
  });

  factory CosEvent.fromJson(Map<String, dynamic> j) => CosEvent(
        eventId: j['event_id'] as String? ?? '',
        eventType: j['event_type'] as String? ?? '',
        createdAt: j['created_at'] != null ? DateTime.tryParse(j['created_at'].toString()) : null,
        message: j['message'] != null
            ? CosMessage.fromJson((j['message'] as Map).cast<String, dynamic>())
            : null,
        cardAction: (j['card_action'] as Map?)?.cast<String, dynamic>(),
      );
}
