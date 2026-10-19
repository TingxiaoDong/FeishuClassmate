/// 测试数据模式：任务扩展（子任务、关注人、评论动态、任务清单）的内存模拟。
/// 只按《二期迭代3_前端接口需求与进度》的建议契约返回，用来自测界面；正式模式不会加载。
library;

import 'mock_docs.dart' show MockFail;

class MockTasks {
  final String Function() me;
  final void Function(Map<String, dynamic>) emit;
  final bool Function(String userId) isAdmin;
  MockTasks({required this.me, required this.emit, required this.isAdmin}) {
    _seed();
  }

  int _seq = 500;
  String _id(String p) => '${p}_${_seq++}';
  String _now() => DateTime.now().toUtc().toIso8601String();

  final Map<String, Map<String, dynamic>> tasks = {};
  final Map<String, List<Map<String, dynamic>>> comments = {};
  final Map<String, List<Map<String, dynamic>>> activities = {};
  final Map<String, Map<String, dynamic>> lists = {};
  final Map<String, List<Map<String, dynamic>>> sections = {};
  final Map<String, List<Map<String, dynamic>>> members = {};

  /// 任务在清单里的位置：task_id → {list_id: section_id}
  final Map<String, Map<String, String?>> placement = {};

  void _seed() {
    final now = DateTime.now();
    int day(int d, [int h = 18]) => DateTime(now.year, now.month, now.day + d, h).millisecondsSinceEpoch;
    String ago(Duration d) => now.subtract(d).toUtc().toIso8601String();
    void task(String id, String title, String by, String? assignee,
        {String status = 'pending', int? due, String? parent, String? desc, List<String> followers = const [], int order = 0}) {
      tasks[id] = {
        'task_id': id, 'title': title, 'status': status, 'assignee_id': assignee, 'due_ms': due, 'description': desc,
        'priority': 'normal', 'created_by': by, 'parent_id': parent, 'follower_ids': [...followers], 'order': order,
        'created_at': ago(const Duration(days: 3)), 'updated_at': ago(const Duration(hours: 5)),
        if (status == 'done') 'completed_at': ago(const Duration(hours: 6)),
      };
    }

    task('task_1', '整理机械臂抓取实验数据', 'ou_admin', 'ou_demo', status: 'in_progress', due: day(1), desc: 'YCB 子集 20 个物体，每个 10 次', followers: ['ou_admin']);
    task('task_1a', '导出原始日志', 'ou_demo', 'ou_demo', status: 'done', parent: 'task_1', order: 1);
    task('task_1b', '计算成功率和失败类型', 'ou_demo', 'ou_demo', parent: 'task_1', due: day(1, 12), order: 2);
    task('task_1c', '画对比图', 'ou_demo', 'ou_zhang', parent: 'task_1', order: 3);
    task('task_1b1', '统计滑落类失败', 'ou_demo', 'ou_demo', parent: 'task_1b', order: 1);
    task('task_2', '准备周四组会 PPT', 'ou_admin', 'ou_admin', due: day(3, 10), followers: ['ou_demo']);
    task('task_3', '四足机器人楼梯步态仿真', 'ou_zhang', 'ou_zhang', status: 'in_progress', due: day(-1), followers: ['ou_admin']);
    task('task_4', '投稿 ICRA：补充消融实验', 'ou_admin', 'ou_chen', due: day(7));
    task('task_5', '预约下周会议室', 'ou_admin', 'ou_admin', status: 'done');

    lists['tl_rlhf'] = {'list_id': 'tl_rlhf', 'name': '机械臂抓取项目', 'description': '抓取成功率提升到 90% 以上', 'created_by': 'ou_admin', 'created_at': ago(const Duration(days: 10))};
    lists['tl_daily'] = {'list_id': 'tl_daily', 'name': '实验室日常', 'description': '', 'created_by': 'ou_demo', 'created_at': ago(const Duration(days: 20))};
    sections['tl_rlhf'] = [
      {'section_id': 'sec_1', 'list_id': 'tl_rlhf', 'name': '待开始', 'order': 1},
      {'section_id': 'sec_2', 'list_id': 'tl_rlhf', 'name': '实验中', 'order': 2},
      {'section_id': 'sec_3', 'list_id': 'tl_rlhf', 'name': '写论文', 'order': 3},
    ];
    sections['tl_daily'] = [
      {'section_id': 'sec_4', 'list_id': 'tl_daily', 'name': '本周', 'order': 1},
    ];
    members['tl_rlhf'] = [
      {'member_type': 'user', 'member_id': 'ou_demo', 'role': 'editor'},
      {'member_type': 'user', 'member_id': 'ou_zhang', 'role': 'viewer'},
    ];
    members['tl_daily'] = [
      {'member_type': 'user', 'member_id': 'ou_admin', 'role': 'viewer'},
    ];
    placement['task_1'] = {'tl_rlhf': 'sec_2'};
    placement['task_4'] = {'tl_rlhf': 'sec_3'};
    placement['task_2'] = {'tl_rlhf': 'sec_1', 'tl_daily': 'sec_4'};
    placement['task_5'] = {'tl_daily': 'sec_4'};

    comments['task_1'] = [
      {
        'comment_id': 'tc_1', 'user_id': 'ou_admin', 'created_at': ago(const Duration(hours: 4)), 'attachments': [],
        'content': {'text': '@李同学 失败案例也一起统计一下', 'mentions': [{'user_id': 'ou_demo', 'name': '李同学', 'offset': 0, 'length': 4}]},
      },
      {'comment_id': 'tc_2', 'user_id': 'ou_demo', 'created_at': ago(const Duration(hours: 2)), 'attachments': [], 'content': {'text': '好的，今晚整理完', 'mentions': []}},
    ];
    activities['task_1'] = [
      {'activity_id': 'ta_1', 'operator_id': 'ou_admin', 'at': ago(const Duration(days: 3)), 'action': 'created', 'changes': []},
      {'activity_id': 'ta_2', 'operator_id': 'ou_demo', 'at': ago(const Duration(hours: 20)), 'action': 'updated', 'changes': [{'field_name': 'status', 'before': 'pending', 'after': 'in_progress'}]},
      {'activity_id': 'ta_3', 'operator_id': 'ou_admin', 'at': ago(const Duration(hours: 5)), 'action': 'updated', 'changes': [{'field_name': 'due_ms', 'before': null, 'after': day(1)}]},
    ];
  }

  // ---------------- 权限 ----------------

  String? listRole(String listId, String u) {
    final l = lists[listId];
    if (l == null) return null;
    if (l['created_by'] == u || isAdmin(u)) return 'manager';
    return members[listId]?.where((m) => m['member_id'] == u).firstOrNull?['role']?.toString();
  }

  bool _canEditTask(Map<String, dynamic> t, String u) {
    if (t['created_by'] == u || t['assignee_id'] == u || isAdmin(u)) return true;
    for (final l in (placement[t['task_id']] ?? const {}).keys) {
      final r = listRole(l, u);
      if (r == 'editor' || r == 'manager') return true;
    }
    final p = tasks[t['parent_id']];
    return p != null && _canEditTask(p, u);
  }

  bool _canView(Map<String, dynamic> t, String u) {
    if (_canEditTask(t, u) || (t['follower_ids'] as List).contains(u)) return true;
    if ((placement[t['task_id']] ?? const {}).keys.any((l) => listRole(l, u) != null)) return true;
    final p = tasks[t['parent_id']];
    return p != null && _canView(p, u);
  }

  int _depth(Map<String, dynamic> t) {
    var d = 1;
    var p = tasks[t['parent_id']];
    while (p != null) {
      d++;
      p = tasks[p['parent_id']];
    }
    return d;
  }

  Map<String, dynamic> pub(Map<String, dynamic> t) {
    final u = me();
    final subs = tasks.values.where((x) => x['parent_id'] == t['task_id']);
    final canEdit = _canEditTask(t, u);
    return {
      ...t,
      'depth': _depth(t),
      'subtask_count': subs.length,
      'subtask_done_count': subs.where((x) => x['status'] == 'done').length,
      'tasklists': [
        for (final e in (placement[t['task_id']] ?? const <String, String?>{}).entries)
          if (lists.containsKey(e.key)) {'list_id': e.key, 'section_id': e.value, 'name': lists[e.key]!['name']},
      ],
      'permissions': {
        'can_view': true,
        'can_edit': canEdit,
        'can_delete': t['created_by'] == u || isAdmin(u),
        'can_comment': true,
        'can_follow': true,
        'can_manage_followers': canEdit,
      },
    };
  }

  Map<String, dynamic> _pubList(Map<String, dynamic> l) {
    final r = listRole(l['list_id'], me());
    return {
      ...l,
      'permissions': {'can_view': r != null, 'can_edit': r == 'editor' || r == 'manager', 'can_manage': r == 'manager', 'can_delete': r == 'manager'},
    };
  }

  Map<String, dynamic> _task(String id) {
    final t = tasks[id];
    if (t == null || !_canView(t, me())) throw MockFail(404, 'NOT_FOUND', '任务不存在或你没有权限查看');
    return t;
  }

  Map<String, dynamic> _list(String id, {bool edit = false, bool manage = false}) {
    final l = lists[id];
    final r = l == null ? null : listRole(id, me());
    if (l == null || r == null) throw MockFail(404, 'NOT_FOUND', '清单不存在或你没有权限查看');
    if (manage && r != 'manager') throw MockFail(403, 'FORBIDDEN', '只有清单管理者可以操作');
    if (edit && r == 'viewer') throw MockFail(403, 'FORBIDDEN', '你只有阅读权限');
    return l;
  }

  void _log(String taskId, String action, [List<Map<String, dynamic>> changes = const []]) {
    activities.putIfAbsent(taskId, () => []).add({
      'activity_id': _id('ta'), 'operator_id': me(), 'at': _now(), 'action': action, 'changes': changes,
    });
  }

  void _changed(String taskId) => emit({'event_type': 'task.updated', 'task_id': taskId});

  // ---------------- 分发 ----------------

  (int, Object?)? handle(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    if (seg.isEmpty) return null;
    if (seg[0] == 'tasks') return _tasks(m, seg, q, body);
    if (seg[0] == 'tasklists') return _tasklists(m, seg, q, body);
    return null;
  }

  (int, Object?) _page(Iterable<Map<String, dynamic>> items) => (200, {'items': items.toList(), 'has_more': false});

  (int, Object?) _tasks(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    final u = me();
    if (seg.length == 1) {
      if (m == 'GET') {
        String? who(String? v) => v == 'me' ? u : v;
        final list = tasks.values.where((t) =>
            _canView(t, u) &&
            (q['include_subtasks'] == 'true' || t['parent_id'] == null) &&
            (q['assignee_id'] == null || t['assignee_id'] == who(q['assignee_id'])) &&
            (q['created_by'] == null || t['created_by'] == who(q['created_by'])) &&
            (q['follower_id'] == null || (t['follower_ids'] as List).contains(who(q['follower_id']))) &&
            (q['status'] == null || t['status'] == q['status']));
        return _page(list.map(pub));
      }
      if (m == 'POST') {
        final title = body['title']?.toString().trim() ?? '';
        if (title.isEmpty) throw MockFail(422, 'VALIDATION_FAILED', '请填写任务标题');
        final parent = body['parent_id']?.toString();
        var order = 0;
        if (parent != null) {
          final p = _task(parent);
          if (!_canEditTask(p, u)) throw MockFail(403, 'FORBIDDEN', '没有权限给这个任务添加子任务');
          if (_depth(p) >= 3) throw MockFail(422, 'TASK_DEPTH_EXCEEDED', '子任务最多 3 层');
          order = tasks.values.where((x) => x['parent_id'] == parent).length + 1;
        }
        final id = _id('task');
        tasks[id] = {
          'task_id': id, 'title': title, 'status': 'pending', 'assignee_id': body['assignee_id'], 'due_ms': body['due_ms'],
          'description': body['description'], 'priority': body['priority'] ?? 'normal', 'created_by': u, 'parent_id': parent,
          'follower_ids': <String>[], 'order': order, 'created_at': _now(), 'updated_at': _now(),
        };
        _log(id, 'created');
        if (parent != null) {
          _log(parent, 'subtask_added', [{'field_name': 'subtasks', 'before': null, 'after': title}]);
          _changed(parent);
        }
        _changed(id);
        return (201, pub(tasks[id]!));
      }
    }
    final t = _task(seg[1]);
    final id = t['task_id'] as String;
    if (seg.length == 2) {
      if (m == 'GET') return (200, pub(t));
      if (m == 'PATCH') {
        if (!_canEditTask(t, u)) throw MockFail(403, 'FORBIDDEN', '只有创建人、负责人和清单编辑者可以修改');
        final changes = <Map<String, dynamic>>[];
        for (final k in ['title', 'status', 'assignee_id', 'due_ms', 'description', 'priority']) {
          if (body.containsKey(k) && body[k] != t[k]) {
            changes.add({'field_name': k, 'before': t[k], 'after': body[k]});
            t[k] = body[k];
          }
        }
        if (body.containsKey('status')) t['completed_at'] = t['status'] == 'done' ? _now() : null;
        if (changes.isNotEmpty) {
          t['updated_at'] = _now();
          _log(id, 'updated', changes);
          _changed(id);
          if (t['parent_id'] != null) _changed(t['parent_id']);
        }
        return (200, pub(t));
      }
      if (m == 'DELETE') {
        if (t['created_by'] != u && !isAdmin(u)) throw MockFail(403, 'FORBIDDEN', '只有创建人可以删除任务');
        // 建议契约：删除父任务时子任务一起删除（待后端确认）
        void drop(String x) {
          for (final c in tasks.values.where((e) => e['parent_id'] == x).map((e) => e['task_id'] as String).toList()) {
            drop(c);
          }
          tasks.remove(x);
          placement.remove(x);
        }

        drop(id);
        _changed(id);
        return (204, null);
      }
    }
    switch (seg[2]) {
      case 'subtasks':
        if (seg.length == 4 && seg[3] == 'order' && m == 'POST') {
          if (!_canEditTask(t, u)) throw MockFail(403, 'FORBIDDEN', '没有权限调整顺序');
          final ids = [for (final x in (body['task_ids'] as List? ?? const [])) x.toString()];
          for (var i = 0; i < ids.length; i++) {
            final s = tasks[ids[i]];
            if (s == null || s['parent_id'] != id) throw MockFail(422, 'VALIDATION_FAILED', '只能对同一父任务下的子任务排序');
            s['order'] = i + 1;
          }
          _changed(id);
          return (200, {});
        }
        final subs = tasks.values.where((x) => x['parent_id'] == id).toList()
          ..sort((a, b) => (a['order'] as int).compareTo(b['order'] as int));
        return _page(subs.map(pub));
      case 'followers':
        final target = seg[3];
        if (target != u && !_canEditTask(t, u)) throw MockFail(403, 'FORBIDDEN', '没有权限修改关注人');
        final f = (t['follower_ids'] as List);
        if (m == 'POST' && !f.contains(target)) {
          f.add(target);
          _log(id, 'follower_added', [{'field_name': 'follower_ids', 'before': null, 'after': [target]}]);
        }
        if (m == 'DELETE' && f.remove(target)) {
          _log(id, 'follower_removed', [{'field_name': 'follower_ids', 'before': [target], 'after': null}]);
        }
        _changed(id);
        return (200, pub(t));
      case 'comments':
        final list = comments.putIfAbsent(id, () => []);
        if (m == 'GET') {
          return _page(list.map((c) => {...c, 'permissions': {'can_delete': c['user_id'] == u || isAdmin(u)}}));
        }
        if (m == 'POST') {
          final content = body['content'];
          final atts = body['attachments'] as List? ?? const [];
          if ((content is! Map || (content['text']?.toString().trim() ?? '').isEmpty) && atts.isEmpty) {
            throw MockFail(422, 'VALIDATION_FAILED', '评论不能为空');
          }
          final c = {'comment_id': _id('tc'), 'user_id': u, 'content': content, 'attachments': atts, 'created_at': _now()};
          list.add(c);
          emit({'event_type': 'task.comment_changed', 'task_id': id});
          return (201, {...c, 'permissions': {'can_delete': true}});
        }
        if (m == 'DELETE') {
          final c = list.where((x) => x['comment_id'] == seg[3]).firstOrNull;
          if (c == null) throw MockFail(404, 'NOT_FOUND', '评论不存在');
          if (c['user_id'] != u && !isAdmin(u)) throw MockFail(403, 'FORBIDDEN', '只能删除自己的评论');
          list.remove(c);
          emit({'event_type': 'task.comment_changed', 'task_id': id});
          return (204, null);
        }
      case 'activities':
        return _page((activities[id] ?? const []).reversed);
      case 'tasklists':
        final p = placement.putIfAbsent(id, () => {});
        if (m == 'POST') {
          final listId = body['list_id']?.toString() ?? '';
          _list(listId, edit: true);
          final sid = body['section_id']?.toString();
          if (sid != null && !(sections[listId] ?? const []).any((s) => s['section_id'] == sid)) {
            throw MockFail(422, 'VALIDATION_FAILED', '分组不存在');
          }
          final joined = !p.containsKey(listId);
          p[listId] = sid;
          if (joined) _log(id, 'tasklist_added', [{'field_name': 'tasklists', 'before': null, 'after': lists[listId]!['name']}]);
          emit({'event_type': 'tasklist.updated', 'list_id': listId});
          return (200, pub(t));
        }
        if (m == 'DELETE') {
          final listId = seg[3];
          _list(listId, edit: true);
          if (p.containsKey(listId)) {
            p.remove(listId);
            _log(id, 'tasklist_removed', [{'field_name': 'tasklists', 'before': lists[listId]!['name'], 'after': null}]);
          }
          emit({'event_type': 'tasklist.updated', 'list_id': listId});
          return (204, null);
        }
    }
    throw MockFail(404, 'NOT_FOUND', '接口不存在');
  }

  (int, Object?) _tasklists(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    final u = me();
    if (seg.length == 1) {
      if (m == 'GET') {
        return _page(lists.values
            .where((l) => listRole(l['list_id'], u) != null && (q['project_record_id'] == null || l['project_record_id'] == q['project_record_id']))
            .map(_pubList));
      }
      final name = body['name']?.toString().trim() ?? '';
      if (name.isEmpty) throw MockFail(422, 'VALIDATION_FAILED', '请填写清单名称');
      final id = _id('tl');
      lists[id] = {
        'list_id': id, 'name': name, 'description': body['description'] ?? '', 'project_record_id': body['project_record_id'],
        'created_by': u, 'created_at': _now(), 'updated_at': _now(),
      };
      sections[id] = [
        for (final (i, n) in ['待开始', '进行中', '已完成'].indexed) {'section_id': _id('sec'), 'list_id': id, 'name': n, 'order': i + 1},
      ];
      members[id] = [];
      return (201, _pubList(lists[id]!));
    }
    final id = seg[1];
    if (seg.length == 2) {
      final l = _list(id, manage: m != 'GET');
      if (m == 'PATCH') {
        for (final k in ['name', 'description', 'project_record_id']) {
          if (body.containsKey(k)) l[k] = body[k];
        }
        l['updated_at'] = _now();
        emit({'event_type': 'tasklist.updated', 'list_id': id});
        return (200, _pubList(l));
      }
      if (m == 'DELETE') {
        lists.remove(id);
        sections.remove(id);
        members.remove(id);
        for (final p in placement.values) {
          p.remove(id); // 只移除关联，不删任务
        }
        emit({'event_type': 'tasklist.deleted', 'list_id': id});
        return (204, null);
      }
      return (200, _pubList(l));
    }
    switch (seg[2]) {
      case 'members':
        final l = _list(id, manage: m == 'PUT');
        if (m == 'PUT') {
          members[id] = [for (final e in (body['members'] as List? ?? const [])) (e as Map).cast<String, dynamic>()];
          emit({'event_type': 'tasklist.updated', 'list_id': id});
        }
        return (200, {'owner_id': l['created_by'], 'members': members[id] ?? []});
      case 'sections':
        final ss = sections.putIfAbsent(id, () => []);
        if (seg.length == 3) {
          if (m == 'GET') {
            _list(id);
            return _page([...ss]..sort((a, b) => (a['order'] as int).compareTo(b['order'] as int)));
          }
          _list(id, edit: true);
          final name = body['name']?.toString().trim() ?? '';
          if (name.isEmpty) throw MockFail(422, 'VALIDATION_FAILED', '请填写分组名称');
          if (ss.any((s) => s['name'] == name)) throw MockFail(409, 'SECTION_NAME_EXISTS', '已有同名分组「$name」');
          final s = {'section_id': _id('sec'), 'list_id': id, 'name': name, 'order': ss.length + 1};
          ss.add(s);
          emit({'event_type': 'tasklist.updated', 'list_id': id});
          return (201, s);
        }
        _list(id, edit: true);
        final s = ss.where((x) => x['section_id'] == seg[3]).firstOrNull;
        if (s == null) throw MockFail(404, 'NOT_FOUND', '分组不存在');
        if (m == 'PATCH') {
          if (body['name'] != null) s['name'] = body['name'];
          if (body['order'] != null) s['order'] = body['order'];
        } else if (m == 'DELETE') {
          ss.remove(s);
          for (final p in placement.values) {
            if (p[id] == s['section_id']) p[id] = null; // 移到未分组
          }
        }
        emit({'event_type': 'tasklist.updated', 'list_id': id});
        return m == 'DELETE' ? (204, null) : (200, s);
      case 'tasks':
        _list(id);
        final sid = q['section_id'];
        return _page(tasks.values
            .where((t) => placement[t['task_id']]?.containsKey(id) == true && (sid == null || placement[t['task_id']]![id] == sid))
            .map(pub));
    }
    throw MockFail(404, 'NOT_FOUND', '接口不存在');
  }
}
