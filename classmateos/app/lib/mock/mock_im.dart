/// 测试数据模式：消息（一期会话 / 消息 + 迭代 4 消息增强）的内存模拟。
/// 返回格式按《二期迭代4_前端接口需求与进度》；只用于自测界面，正式模式不会加载。
library;

import 'mock_docs.dart' show MockFail;

class MockIm {
  final String Function() me;
  final void Function(Map<String, dynamic>) emit;
  MockIm({required this.me, required this.emit}) {
    _seed();
  }

  int _seq = 1000;
  String _id(String p) => '${p}_${_seq++}';
  String _now([Duration ago = Duration.zero]) => DateTime.now().subtract(ago).toUtc().toIso8601String();

  final Map<String, Map<String, dynamic>> chats = {};

  /// 每个会话的消息（按时间正序，含话题回复）。
  final Map<String, List<Map<String, dynamic>>> messages = {};

  /// chat_id → user_id → 已读到的主会话消息下标（-1 表示一条没读）。
  final Map<String, Map<String, int>> lastRead = {};

  /// 话题关注：root_id → user_ids；话题未读：user_id → root_ids。
  final Map<String, Set<String>> threadFollowers = {};
  final Map<String, Set<String>> threadUnread = {};

  /// 加急：message_id → {user_ids, ack_user_ids, from}
  final Map<String, Map<String, dynamic>> urgents = {};

  /// 收藏：user_id → [(message_id, created_at)]；Pin：chat_id → [{message_id, pinned_by, pinned_at}]
  final Map<String, List<(String, String)>> favorites = {};
  final Map<String, List<Map<String, dynamic>>> pins = {};

  /// 个人设置：chat_id → user_id → {pinned, muted}
  final Map<String, Map<String, Map<String, bool>>> personal = {};

  void _seed() {
    void chat(String id, String type, List<String> members, {String? name, String? owner, bool threadMode = false}) {
      chats[id] = {
        'chat_id': id, 'chat_type': type, 'name': name, 'member_ids': members, 'owner_id': owner,
        'kind': 'normal', 'thread_mode': threadMode, 'created_at': _now(const Duration(days: 30)), 'updated_at': _now(const Duration(days: 1)),
      };
      messages[id] = [];
      lastRead[id] = {for (final m in members) m: -1};
    }

    Map<String, dynamic> msg(String chatId, String sender, String text, Duration ago,
        {String? root, bool also = false, Map<String, List<String>> reactions = const {}}) {
      final m = <String, dynamic>{
        'message_id': _id('om'), 'chat_id': chatId, 'sender_id': sender, 'msg_type': 'text',
        'content': <String, dynamic>{'text': text}, 'created_at': _now(ago), 'recalled': false,
        'thread_root_id': root, 'also_send_to_chat': also,
        'reactions_raw': {for (final e in reactions.entries) e.key: [...e.value]},
      };
      messages[chatId]!.add(m);
      if (root != null) (threadFollowers[root] ??= {}).add(sender);
      return m;
    }

    chat('oc_lab', 'group', ['ou_admin', 'ou_demo', 'ou_zhang', 'ou_chen'], name: '具身智能实验室', owner: 'ou_admin');
    chat('oc_demo', 'p2p', ['ou_admin', 'ou_demo']);
    chat('oc_paper', 'group', ['ou_admin', 'ou_demo', 'ou_chen'], name: '论文讨论', owner: 'ou_admin', threadMode: true);

    msg('oc_lab', 'ou_admin', '这周组会改到周四下午两点，大家注意一下', const Duration(hours: 5), reactions: {'THUMBSUP': ['ou_demo', 'ou_zhang'], 'DONE': ['ou_chen']});
    final root = msg('oc_lab', 'ou_demo', '机械臂抓取实验的数据整理好了，成功率 87%，失败主要是滑落', const Duration(hours: 3));
    msg('oc_lab', 'ou_zhang', '滑落那部分可以试试加触觉反馈', const Duration(hours: 2, minutes: 40), root: root['message_id'] as String);
    msg('oc_lab', 'ou_admin', '同意，下周把触觉手套接上再测一轮', const Duration(hours: 2, minutes: 20), root: root['message_id'] as String);
    msg('oc_lab', 'ou_chen', '视觉定位那边我今晚更新一下标定参数', const Duration(hours: 1));
    msg('oc_lab', 'ou_admin', '好的，标定流程文档也顺便更新一下', const Duration(minutes: 50));
    msg('oc_demo', 'ou_demo', '王老师，论文初稿我放到云文档了', const Duration(hours: 4));
    msg('oc_demo', 'ou_admin', '收到，今晚看', const Duration(hours: 3, minutes: 50));
    final t1 = msg('oc_paper', 'ou_chen', 'ICRA 投稿：消融实验还缺哪几组？', const Duration(days: 1));
    msg('oc_paper', 'ou_admin', '缺去掉触觉和去掉预训练两组', const Duration(hours: 20), root: t1['message_id'] as String);
    msg('oc_paper', 'ou_demo', '相关工作部分谁来写？', const Duration(hours: 6));

    final pinned = messages['oc_lab']!.first;
    pins['oc_lab'] = [{'message_id': pinned['message_id'], 'pinned_by': 'ou_admin', 'pinned_at': _now(const Duration(hours: 4))}];
    final link = msg('oc_demo', 'ou_demo', '标定流程我写在这里了 http://mock.classmateos/app/docs/doc_1 ，参考 https://arxiv.org/abs/2410.00001', const Duration(hours: 3, minutes: 40));
    (link['content'] as Map)['link_previews'] = [
      {'url': 'https://arxiv.org/abs/2410.00001', 'title': 'Tactile-Aware Grasping with Diffusion Policies', 'description': 'arXiv 预印本'},
    ];
    // 让「收到，今晚看」仍是单聊最后一条
    messages['oc_demo']!..remove(link)..insert(1, link);

    // 已读状态：别人都读到了倒数第二条，王老师读到最新
    for (final c in chats.keys) {
      final main = _main(c);
      for (final u in lastRead[c]!.keys) {
        lastRead[c]![u] = u == 'ou_admin' ? main.length - 1 : main.length - 2;
      }
    }
    lastRead['oc_lab']!['ou_admin'] = _main('oc_lab').length - 3; // 王老师有 2 条未读
  }

  // ---------------- 计算 ----------------

  List<Map<String, dynamic>> _main(String chatId) =>
      [for (final m in messages[chatId]!) if (m['thread_root_id'] == null || m['also_send_to_chat'] == true) m];

  Map<String, dynamic> _chat(String id) {
    final c = chats[id];
    if (c == null) throw MockFail(404, 'NOT_FOUND', '会话不存在');
    if (!(c['member_ids'] as List).contains(me())) throw MockFail(403, 'CHAT_NOT_MEMBER', '你不在这个会话里');
    return c;
  }

  (Map<String, dynamic>, String) _msg(String id) {
    for (final e in messages.entries) {
      for (final m in e.value) {
        if (m['message_id'] == id) {
          _chat(e.key);
          return (m, e.key);
        }
      }
    }
    throw MockFail(404, 'NOT_FOUND', '消息不存在');
  }

  int _mainIndex(String chatId, String messageId) => _main(chatId).indexWhere((m) => m['message_id'] == messageId);

  Map<String, dynamic> publicMessage(Map<String, dynamic> m, {String? viewer}) {
    final u = viewer ?? me();
    final chatId = m['chat_id'] as String;
    final members = (chats[chatId]!['member_ids'] as List).cast<String>();
    final out = <String, dynamic>{...m}..remove('reactions_raw');
    final raw = (m['reactions_raw'] as Map).cast<String, List>();
    out['reactions'] = [
      for (final e in raw.entries)
        if (e.value.isNotEmpty) {'emoji': e.key, 'count': e.value.length, 'user_ids': e.value, 'reacted_by_me': e.value.contains(u)},
    ];
    if (m['sender_id'] == u) {
      final idx = _mainIndex(chatId, m['message_id'] as String);
      final others = members.where((x) => x != u).toList();
      out['member_count'] = others.length;
      out['read_count'] = idx < 0 ? 0 : others.where((x) => (lastRead[chatId]![x] ?? -1) >= idx).length;
      final ug = urgents[m['message_id']];
      if (ug != null) out['urgent'] = {'user_ids': ug['user_ids'], 'ack_user_ids': ug['ack_user_ids']};
    }
    if (m['thread_root_id'] == null) {
      final replies = messages[chatId]!.where((x) => x['thread_root_id'] == m['message_id']).toList();
      if (replies.isNotEmpty) {
        out['thread'] = {
          'reply_count': replies.length,
          'last_reply_at': replies.last['created_at'],
          'participants': {for (final r in replies) r['sender_id']}.toList(),
          'followed': threadFollowers[m['message_id']]?.contains(u) ?? false,
        };
      }
    }
    return out;
  }

  Map<String, dynamic> publicChat(Map<String, dynamic> c) {
    final u = me();
    final main = _main(c['chat_id'] as String);
    final read = lastRead[c['chat_id']]![u] ?? -1;
    final p = personal[c['chat_id']]?[u] ?? const {};
    return {
      ...c,
      'unread_count': [for (var i = read + 1; i < main.length; i++) if (main[i]['sender_id'] != u) i].length,
      'last_message': main.isEmpty ? null : publicMessage(main.last),
      'last_read_message_id': read >= 0 && read < main.length ? main[read]['message_id'] : null,
      'pinned': p['pinned'] ?? false,
      'muted': p['muted'] ?? false,
      'pinned_message_ids': [for (final x in pins[c['chat_id']] ?? const []) x['message_id']],
      'thread_unread_count': (threadUnread[u] ?? const {}).where((r) => messages[c['chat_id']]!.any((m) => m['message_id'] == r)).length,
    };
  }

  // ---------------- 写操作（测试也直接调用来模拟别人） ----------------

  Map<String, dynamic> send(String chatId, String sender, String type, Map<String, dynamic> content,
      {String? root, bool also = false, String? replyTo, Map<String, dynamic>? forwardedFrom}) {
    final c = chats[chatId]!;
    if (root != null) {
      final r = messages[chatId]!.where((m) => m['message_id'] == root).firstOrNull;
      if (r == null) throw MockFail(404, 'NOT_FOUND', '话题不存在');
      if (r['thread_root_id'] != null) throw MockFail(422, 'VALIDATION_ERROR', '不能在话题回复里再开话题');
    }
    if (c['thread_mode'] == true && root != null && also) also = false;
    final m = <String, dynamic>{
      'message_id': _id('om'), 'chat_id': chatId, 'sender_id': sender, 'msg_type': type, 'content': content,
      'created_at': _now(), 'recalled': false, 'thread_root_id': root, 'also_send_to_chat': also,
      'reply_to_message_id': replyTo, 'reactions_raw': <String, List<String>>{},
      'forwarded_from': ?forwardedFrom,
    };
    messages[chatId]!.add(m);
    c['updated_at'] = _now();
    if (root != null) {
      final f = threadFollowers[root] ??= {};
      f.add(sender);
      final rootMsg = messages[chatId]!.firstWhere((x) => x['message_id'] == root);
      f.add(rootMsg['sender_id'] as String);
      for (final u in f) {
        if (u != sender) (threadUnread[u] ??= {}).add(root);
      }
      emit({'event_type': 'message.updated', 'message': publicMessage(rootMsg)});
    }
    if (_mainIndex(chatId, m['message_id'] as String) >= 0) lastRead[chatId]![sender] = _main(chatId).length - 1;
    emit({'event_type': 'message.receive', 'message': publicMessage(m)});
    return m;
  }

  /// 某人读到最新（模拟别人已读，推 message.read 给会话全员）。
  void readBy(String userId, String chatId) {
    final main = _main(chatId);
    lastRead[chatId]![userId] = main.length - 1;
    threadUnread[userId]?.removeWhere((r) => messages[chatId]!.any((m) => m['message_id'] == r));
    emit({
      'event_type': 'message.read', 'chat_id': chatId, 'user_id': userId,
      'last_read_message_id': main.isEmpty ? null : main.last['message_id'],
    });
  }

  /// 别人加急我（测试用）。
  void urgentFrom(String fromUser, String messageId, List<String> userIds) {
    final (m, chatId) = _msgAny(messageId);
    final u = urgents[messageId] ??= {'user_ids': <String>[], 'ack_user_ids': <String>[], 'from': fromUser};
    for (final x in userIds) {
      if (!(u['user_ids'] as List).contains(x)) (u['user_ids'] as List).add(x);
    }
    emit({
      'event_type': 'message.urgent', 'message_id': messageId, 'chat_id': chatId, 'from_user_id': fromUser,
      'preview': (m['content'] as Map)['text'],
    });
  }

  (Map<String, dynamic>, String) _msgAny(String id) {
    for (final e in messages.entries) {
      for (final m in e.value) {
        if (m['message_id'] == id) return (m, e.key);
      }
    }
    throw MockFail(404, 'NOT_FOUND', '消息不存在');
  }

  // ---------------- 路由 ----------------

  (int, Object?)? handle(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    if (seg.isEmpty) return null;
    if (seg.length == 1 && seg[0] == 'favorites' && m == 'GET') {
      final l = favorites[me()] ?? const [];
      return (200, {
        'items': [
          for (final (id, at) in l)
            () {
              final (x, cid) = _msgAny(id);
              return {'favorite_id': 'fav_$id', 'message': publicMessage(x), 'chat_name': chats[cid]!['name'] ?? '单聊', 'created_at': at};
            }(),
        ],
        'has_more': false,
      });
    }
    if (seg[0] == 'chats') return _chats(m, seg, q, body);
    if (seg[0] == 'messages') return _messages(m, seg, q, body);
    return null;
  }

  (int, Object?)? _chats(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    final u = me();
    if (seg.length == 1 && m == 'GET') {
      final list = [for (final c in chats.values) if ((c['member_ids'] as List).contains(u)) publicChat(c)];
      return (200, {'items': list, 'has_more': false});
    }
    if (seg.length == 1 && m == 'POST') {
      final members = <String>{u, ...(body['member_ids'] as List).map((e) => e.toString())}.toList();
      if (body['chat_type'] == 'p2p') {
        final exist = chats.values.where((c) => c['chat_type'] == 'p2p' && (c['member_ids'] as List).toSet().containsAll(members) && (c['member_ids'] as List).length == members.length).firstOrNull;
        if (exist != null) return (200, publicChat(exist));
      }
      final id = _id('oc');
      chats[id] = {
        'chat_id': id, 'chat_type': body['chat_type'] ?? 'group', 'name': body['name'], 'member_ids': members,
        'owner_id': u, 'kind': 'normal', 'thread_mode': false, 'created_at': _now(), 'updated_at': _now(),
      };
      messages[id] = [];
      lastRead[id] = {for (final x in members) x: -1};
      emit({'event_type': 'chat.created', 'chat': chats[id]});
      return (201, publicChat(chats[id]!));
    }
    final c = _chat(seg[1]);
    final id = seg[1];
    if (seg.length == 2 && m == 'GET') return (200, publicChat(c));
    if (seg.length == 2 && m == 'PATCH') {
      if (body.containsKey('thread_mode')) {
        if (c['owner_id'] != u && u != 'ou_admin') throw MockFail(403, 'FORBIDDEN', '只有群主可以修改话题模式');
        c['thread_mode'] = body['thread_mode'] == true;
      }
      for (final k in ['name', 'description']) {
        if (body.containsKey(k)) c[k] = body[k];
      }
      c['updated_at'] = _now();
      emit({'event_type': 'chat.updated', 'chat': c});
      return (200, publicChat(c));
    }
    if (seg.length == 3 && seg[2] == 'settings' && m == 'PATCH') {
      final p = (personal[id] ??= {})[u] ??= {};
      for (final k in ['pinned', 'muted']) {
        if (body[k] is bool) p[k] = body[k] as bool;
      }
      return (200, publicChat(c));
    }
    if (seg.length == 3 && seg[2] == 'pins' && m == 'GET') {
      final l = pins[id] ?? const [];
      return (200, {
        'items': [
          for (final x in l.reversed)
            {'message': publicMessage(_msg(x['message_id'] as String).$1), 'pinned_by': x['pinned_by'], 'pinned_at': x['pinned_at']},
        ],
      });
    }
    if (seg.length == 4 && seg[2] == 'pins') {
      final l = pins[id] ??= [];
      _msg(seg[3]);
      if (m == 'POST') {
        if (l.any((x) => x['message_id'] == seg[3])) return (204, null);
        if (l.length >= 10) throw MockFail(409, 'PIN_LIMIT', '每个群最多固定 10 条消息，请先取消一条');
        l.add({'message_id': seg[3], 'pinned_by': u, 'pinned_at': _now()});
      } else if (m == 'DELETE') {
        l.removeWhere((x) => x['message_id'] == seg[3]);
      }
      emit({'event_type': 'chat.updated', 'chat': {...c, 'pinned_message_ids': [for (final x in l) x['message_id']]}});
      return (204, null);
    }
    if (seg.length == 3 && seg[2] == 'read' && m == 'POST') {
      readBy(u, id);
      return (200, {});
    }
    if (seg.length == 3 && seg[2] == 'messages' && m == 'GET') {
      final main = _main(id).reversed.toList(); // 最新在前
      var start = 0;
      final before = q['before_message_id'];
      if (before != null) start = main.indexWhere((x) => x['message_id'] == before) + 1;
      final size = int.tryParse(q['page_size'] ?? '') ?? 50;
      final page = main.skip(start).take(size).toList();
      return (200, {'items': [for (final x in page) publicMessage(x)], 'has_more': start + size < main.length});
    }
    if (seg.length == 3 && seg[2] == 'messages' && m == 'POST') {
      final msg = send(id, u, body['msg_type']?.toString() ?? 'text', (body['content'] as Map).cast<String, dynamic>(),
          root: body['thread_root_id'] as String?, also: body['also_send_to_chat'] == true, replyTo: body['reply_to_message_id'] as String?);
      return (201, publicMessage(msg));
    }
    return null;
  }

  (int, Object?)? _messages(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    final u = me();
    if (seg.length == 2 && seg[1] == 'search' && m == 'GET') {
      final k = (q['keyword'] ?? '').toLowerCase();
      final hits = [
        for (final e in messages.entries)
          if ((chats[e.key]!['member_ids'] as List).contains(u) && (q['chat_id'] == null || q['chat_id'] == e.key))
            for (final x in e.value)
              if (x['recalled'] != true && ((x['content'] as Map)['text'] ?? '').toString().toLowerCase().contains(k)) publicMessage(x),
      ];
      return (200, {'items': hits, 'has_more': false});
    }
    if (seg.length == 2 && seg[1] == 'forward' && m == 'POST') {
      final ids = (body['message_ids'] as List).map((e) => e.toString()).toList();
      final targets = (body['chat_ids'] as List).map((e) => e.toString()).toList();
      if (targets.isEmpty || targets.length > 10) throw MockFail(422, 'VALIDATION_ERROR', '一次最多转发到 10 个会话');
      final src = [for (final i in ids) _msg(i)];
      final out = <Map<String, dynamic>>[];
      for (final t in targets) {
        _chat(t);
        if (body['mode'] == 'merge') {
          final names = <String>{for (final (x, _) in src) x['sender_id'] as String}.take(2).toList();
          out.add(publicMessage(send(t, u, 'merge_forward', {
            'title': '${names.map(_name).join(' 和 ')} 的聊天记录',
            'messages': [for (final (x, _) in src) publicMessage(x)..remove('read_count')..remove('member_count')],
          })));
        } else {
          for (final (x, cid) in src) {
            out.add(publicMessage(send(t, u, x['msg_type'] as String, (x['content'] as Map).cast<String, dynamic>(),
                forwardedFrom: {'chat_name': chats[cid]!['name'] ?? '单聊', 'sender_id': x['sender_id']})));
          }
        }
        final note = body['note']?.toString() ?? '';
        if (note.isNotEmpty) out.add(publicMessage(send(t, u, 'text', {'text': note})));
      }
      return (200, {'items': out});
    }
    if (seg.length == 3 && seg[1] == 'urgent' && seg[2] == 'pending' && m == 'GET') {
      final items = [
        for (final e in urgents.entries)
          if ((e.value['user_ids'] as List).contains(u) && !(e.value['ack_user_ids'] as List).contains(u))
            {'message_id': e.key, 'chat_id': _msgAny(e.key).$2, 'from_user_id': e.value['from']},
      ];
      return (200, {'items': items});
    }
    final (msg, chatId) = _msg(seg[1]);
    final id = seg[1];
    if (seg.length == 3 && seg[2] == 'favorite') {
      final l = favorites[u] ??= [];
      l.removeWhere((x) => x.$1 == id);
      if (m == 'POST') l.insert(0, (id, _now()));
      return (204, null);
    }
    if (seg.length == 3 && seg[2] == 'recall' && m == 'POST') {
      msg['recalled'] = true;
      emit({'event_type': 'message.updated', 'message': publicMessage(msg)});
      return (200, publicMessage(msg));
    }
    if (seg.length == 2 && m == 'PATCH') {
      msg['content'] = {...(msg['content'] as Map), ...(body['content'] as Map)};
      msg['updated_at'] = _now();
      emit({'event_type': 'message.updated', 'message': publicMessage(msg)});
      return (200, publicMessage(msg));
    }
    if (seg.length == 3 && seg[2] == 'read-users' && m == 'GET') {
      if (msg['sender_id'] != u) throw MockFail(403, 'FORBIDDEN', '只能查看自己发的消息的已读情况');
      final idx = _mainIndex(chatId, id);
      final others = (chats[chatId]!['member_ids'] as List).cast<String>().where((x) => x != u);
      return (200, {
        'read': [for (final x in others) if ((lastRead[chatId]![x] ?? -1) >= idx) x],
        'unread': [for (final x in others) if ((lastRead[chatId]![x] ?? -1) < idx) x],
      });
    }
    if (seg.length == 3 && seg[2] == 'thread' && m == 'GET') {
      final replies = [for (final x in messages[chatId]!) if (x['thread_root_id'] == id) publicMessage(x)];
      (threadUnread[u])?.remove(id);
      return (200, {'items': replies, 'has_more': false});
    }
    if (seg.length == 4 && seg[2] == 'thread' && seg[3] == 'follow') {
      final f = threadFollowers[id] ??= {};
      m == 'POST' ? f.add(u) : f.remove(u);
      return (204, null);
    }
    if (seg.length >= 3 && seg[2] == 'reactions') {
      final raw = (msg['reactions_raw'] as Map).cast<String, List>();
      if (m == 'POST') {
        final e = body['emoji']?.toString() ?? '';
        if (e.isEmpty) throw MockFail(422, 'VALIDATION_ERROR', '缺少表情');
        final l = raw[e] ??= <String>[];
        if (!l.contains(u)) l.add(u);
      } else if (m == 'DELETE' && seg.length == 4) {
        raw[seg[3]]?.remove(u);
      }
      emit({'event_type': 'message.updated', 'message': publicMessage(msg)});
      return (200, publicMessage(msg));
    }
    if (seg.length == 3 && seg[2] == 'urgent' && m == 'POST') {
      if (msg['sender_id'] != u) throw MockFail(403, 'FORBIDDEN', '只能加急自己发的消息');
      final users = (body['user_ids'] as List).map((e) => e.toString()).toList();
      final ug = urgents[id] ??= {'user_ids': <String>[], 'ack_user_ids': <String>[], 'from': u};
      if (users.every((x) => (ug['user_ids'] as List).contains(x))) throw MockFail(429, 'RATE_LIMITED', '已经加急过了，请稍后再试');
      for (final x in users) {
        if (!(ug['user_ids'] as List).contains(x)) (ug['user_ids'] as List).add(x);
      }
      emit({'event_type': 'message.urgent', 'message_id': id, 'chat_id': chatId, 'from_user_id': u, 'preview': (msg['content'] as Map)['text']});
      return (200, publicMessage(msg));
    }
    if (seg.length == 4 && seg[2] == 'urgent' && seg[3] == 'ack' && m == 'POST') {
      final ug = urgents[id];
      if (ug != null && !(ug['ack_user_ids'] as List).contains(u)) (ug['ack_user_ids'] as List).add(u);
      return (204, null);
    }
    return null;
  }

  static const _names = {'ou_admin': '王老师', 'ou_demo': '李同学', 'ou_zhang': '张晓明', 'ou_chen': '陈雨'};
  String _name(String id) => _names[id] ?? id;
}
