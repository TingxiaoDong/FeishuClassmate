/// 迭代 4：消息增强（R-IM-01～05）与全局搜索（R-SR-01）的接口封装。
/// 契约见《二期迭代4_前端接口需求与进度》；需求文档没写清的地方按那份文档的补充约定。
library;

import '../api_client.dart';
import '../models.dart';

/// 全局搜索的一组结果。
class CosSearchGroup {
  final String type;
  final int total;
  final List<CosSearchItem> items;
  final String? pageToken;
  const CosSearchGroup(this.type, this.total, this.items, this.pageToken);
  bool get hasMore => pageToken != null && pageToken!.isNotEmpty;
  factory CosSearchGroup.fromJson(Map<String, dynamic> j) {
    final items = [
      for (final x in (j['items'] as List? ?? const []))
        if (x is Map) CosSearchItem.fromJson(j['type']?.toString() ?? '', x.cast<String, dynamic>()),
    ];
    return CosSearchGroup(
      j['type']?.toString() ?? '',
      (j['total'] as num?)?.toInt() ?? items.length,
      items,
      j['page_token']?.toString(),
    );
  }
}

class CosSearchItem {
  final String type;
  final String id;

  /// 可能带 `<em>` 高亮。
  final String title;
  final String snippet;
  final DateTime? updatedAt;
  final Map<String, dynamic> extra;
  const CosSearchItem(this.type, this.id, this.title, this.snippet, this.updatedAt, this.extra);
  factory CosSearchItem.fromJson(String type, Map<String, dynamic> j) => CosSearchItem(
        j['type']?.toString() ?? type,
        j['id']?.toString() ?? '',
        j['title']?.toString() ?? '',
        j['snippet']?.toString() ?? '',
        DateTime.tryParse(j['updated_at']?.toString() ?? ''),
        (j['extra'] as Map?)?.cast<String, dynamic>() ?? const {},
      );

  /// 跳转目标（与通知中心 openTarget 的格式一致）。
  Map<String, dynamic> get target => switch (type) {
        'message' => {'type': 'message', 'id': extra['chat_id'], 'message_id': id, if (extra['thread_root_id'] != null) 'thread_root_id': extra['thread_root_id']},
        'chat' => {'type': 'chat', 'id': id},
        'record' => {'type': 'record', 'id': id, 'table_key': extra['table_key']},
        'wiki' => {'type': 'wiki_node', 'id': id, 'space_id': extra['space_id'], 'doc_id': extra['doc_id']},
        'event' => {'type': 'calendar', 'id': id, 'start_ms': extra['start_ms']},
        _ => {'type': type, 'id': id},
      };
}

/// 最近访问（GET /recent）。
class CosRecentItem {
  final String type;
  final String id;
  final String title;
  final DateTime? visitedAt;
  final Map<String, dynamic> extra;
  const CosRecentItem(this.type, this.id, this.title, this.visitedAt, this.extra);
  factory CosRecentItem.fromJson(Map<String, dynamic> j) => CosRecentItem(
        j['type']?.toString() ?? '',
        j['id']?.toString() ?? '',
        j['title']?.toString() ?? '',
        DateTime.tryParse(j['visited_at']?.toString() ?? ''),
        (j['extra'] as Map?)?.cast<String, dynamic>() ?? const {},
      );
  CosSearchItem get asSearchItem => CosSearchItem(type, id, title, '', visitedAt, extra);
}

extension Phase2ImApi on CosApiClient {
  String _m(String id) => Uri.encodeComponent(id);

  // ---------- R-IM-01 已读回执 ----------

  Future<({List<String> read, List<String> unread})> readUsers(String messageId) async {
    final j = await request('GET', '/messages/${_m(messageId)}/read-users');
    List<String> l(Object? v) => [for (final x in (v as List? ?? const [])) x.toString()];
    return (read: l(j['read']), unread: l(j['unread']));
  }

  // ---------- R-IM-02 话题 ----------

  /// 话题回复，按时间正序。
  Future<CosPage<CosMessage>> threadReplies(String rootId, {String? pageToken, int pageSize = 50}) async {
    final j = await request('GET', '/messages/${_m(rootId)}/thread', query: {
      'page_size': '$pageSize',
      if (pageToken != null) 'page_token': pageToken,
    });
    return CosPage(
      [for (final x in (j['items'] as List? ?? const [])) CosMessage.fromJson((x as Map).cast<String, dynamic>())],
      hasMore: j['has_more'] == true,
      pageToken: j['page_token']?.toString(),
    );
  }

  /// 拉完全部话题回复（游标缺失或重复时报错，不死循环）。
  Future<List<CosMessage>> allThreadReplies(String rootId) async {
    final out = <CosMessage>[];
    final seen = <String>{};
    String? token;
    while (true) {
      final p = await threadReplies(rootId, pageToken: token);
      out.addAll(p.items);
      if (!p.hasMore) return out;
      token = p.pageToken;
      if (token == null || !seen.add(token)) throw StateError('分页游标缺失或重复，请刷新后重试');
    }
  }

  Future<void> followThread(String rootId, bool follow) =>
      request(follow ? 'POST' : 'DELETE', '/messages/${_m(rootId)}/thread/follow');

  Future<CosChat> setThreadMode(String chatId, bool on) async =>
      CosChat.fromJson(await request('PATCH', '/chats/${_m(chatId)}', body: {'thread_mode': on}));

  // ---------- R-IM-03 表情回应 ----------

  /// 返回更新后的消息（后端也会推 message.updated）。
  Future<CosMessage?> addReaction(String messageId, String emoji) async {
    final j = await request('POST', '/messages/${_m(messageId)}/reactions', body: {'emoji': emoji});
    return j['message_id'] == null ? null : CosMessage.fromJson(j);
  }

  Future<CosMessage?> removeReaction(String messageId, String emoji) async {
    final j = await request('DELETE', '/messages/${_m(messageId)}/reactions/${Uri.encodeComponent(emoji)}');
    return j['message_id'] == null ? null : CosMessage.fromJson(j);
  }

  // ---------- R-IM-04 转发 ----------

  /// mode: single（逐条）| merge（合并）。返回各会话里新发出的消息。
  Future<List<CosMessage>> forwardMessages({
    required List<String> messageIds,
    required List<String> chatIds,
    String mode = 'single',
    String note = '',
  }) async {
    final j = await request('POST', '/messages/forward', body: {
      'message_ids': messageIds,
      'chat_ids': chatIds,
      'mode': mode,
      if (note.trim().isNotEmpty) 'note': note.trim(),
      'client_request_id': CosApiClient.newClientMsgId(),
    });
    return [for (final x in (j['items'] as List? ?? const [])) CosMessage.fromJson((x as Map).cast<String, dynamic>())];
  }

  // ---------- R-IM-05 加急 ----------

  /// type: app | push。每人每条只能加急一次，过于频繁时后端返回 429。
  Future<CosMessage?> urgentMessage(String messageId, List<String> userIds, {String type = 'app'}) async {
    final j = await request('POST', '/messages/${_m(messageId)}/urgent', body: {'user_ids': userIds, 'type': type});
    return j['message_id'] == null ? null : CosMessage.fromJson(j);
  }

  Future<void> ackUrgent(String messageId) => request('POST', '/messages/${_m(messageId)}/urgent/ack');

  /// 我还没确认的加急（App 启动 / 重连后补拉，前端补充约定）。
  Future<List<CosUrgent>> pendingUrgents() async {
    final j = await request('GET', '/messages/urgent/pending');
    return [for (final x in (j['items'] as List? ?? const [])) CosUrgent.fromJson((x as Map).cast<String, dynamic>())];
  }

  // ---------- R-SR-01 全局搜索 ----------

  /// [types] 为空表示综合；[filters] 是各类型专属筛选（chat_id、sender_id、owner_id、table_key、start_ms、end_ms）。
  Future<List<CosSearchGroup>> search(
    String q, {
    List<String> types = const [],
    int pageSize = 3,
    String? pageToken,
    Map<String, String> filters = const {},
  }) async {
    final j = await request('GET', '/search', query: {
      'q': q,
      if (types.isNotEmpty) 'types': types.join(','),
      'page_size': '$pageSize',
      if (pageToken != null) 'page_token': pageToken,
      ...filters,
    });
    return [for (final g in (j['groups'] as List? ?? const [])) CosSearchGroup.fromJson((g as Map).cast<String, dynamic>())];
  }

  Future<List<CosRecentItem>> recentVisits({int pageSize = 10}) async {
    final j = await request('GET', '/recent', query: {'page_size': '$pageSize'});
    return [for (final x in (j['items'] as List? ?? const [])) CosRecentItem.fromJson((x as Map).cast<String, dynamic>())];
  }
}
