/// 测试数据模式：内存里的二期后端模拟（COS_MOCK=1 启动，或单元测试注入）。
/// 只用于后端接口上线前自测界面；正式模式不会加载。数据和事件格式按《二期功能需求文档》。
library;

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import '../api/phase2.dart';
import '../models.dart';
import '../pages/view_engine.dart';
import 'mock_docs.dart';
import 'mock_tasks.dart';

const kMockBaseUrl = 'http://mock.classmateos/api/v1';

class MockBackend {
  /// 每次变更后的实时事件（模拟 WS 推送，由 AppState.injectEvent 接收）。
  void Function(Map<String, dynamic> event)? onEvent;

  /// 关闭某些二期能力，用来测「入口隐藏」。
  final Map<String, bool> features = {
    'table.create': true,
    'table.fields': true,
    'table.views': true,
    'notifications': true,
    // 迭代 2
    'wiki': true,
    'doc.permissions': true,
    'doc.comments': true,
    'doc.versions': true,
    'doc.folders': true,
    'table.permissions': true,
    'table.manage': true,
    'record.comments': true,
    // 迭代 3：任务扩展（审批按用户要求不做）
    'task.subtasks': true,
    'task.followers': true,
    'task.comments': true,
    'task.lists': true,
  };

  /// 迭代 3：任务扩展和任务清单。
  late final MockTasks taskApi = MockTasks(
    me: () => currentUser,
    emit: _emit,
    isAdmin: (u) => users.any((x) => x['user_id'] == u && x['role'] == 'admin'),
  );

  /// 迭代 2：云文档、知识库、文件直传。
  late final MockDocs docs = MockDocs(
    me: () => currentUser,
    emit: _emit,
    isAdmin: (u) => users.any((x) => x['user_id'] == u && x['role'] == 'admin'),
  );

  /// 表权限、记录评论、修改历史（迭代 2）。
  final Map<String, Map<String, dynamic>> tablePerms = {};
  final Map<String, List<Map<String, dynamic>>> recordComments = {};
  final Map<String, List<Map<String, dynamic>>> recordHistory = {};

  /// 记录收到的请求（测试断言用）。
  final List<http.Request> requests = [];

  int _seq = 100;
  String _id(String p) => '${p}_${_seq++}';
  String currentUser = 'ou_admin';

  final users = <Map<String, dynamic>>[
    {'user_id': 'ou_admin', 'name': '王老师', 'role': 'admin', 'department': '具身智能实验室', 'title': '导师'},
    {'user_id': 'ou_demo', 'name': '李同学', 'role': 'member', 'department': '具身智能实验室', 'title': '博士生'},
    {'user_id': 'ou_zhang', 'name': '张晓明', 'role': 'member', 'department': '具身智能实验室', 'title': '硕士生'},
    {'user_id': 'ou_chen', 'name': '陈雨', 'role': 'member', 'department': '视觉组', 'title': '硕士生'},
  ];

  final Map<String, Map<String, dynamic>> tables = {};
  final Map<String, List<Map<String, dynamic>>> records = {};
  final Map<String, List<Map<String, dynamic>>> views = {};
  final List<Map<String, dynamic>> notifications = [];
  Map<String, dynamic> settings = CosNotificationSettings().toJson();
  final Map<String, String> devices = {};

  MockBackend() {
    _seed();
    // 字面量推断出的 Map<String, Object> 不能写入 null，统一转成普通 JSON 结构
    T plain<T>(Object v) => jsonDecode(jsonEncode(v)) as T;
    for (final k in tables.keys.toList()) {
      tables[k] = plain<Map>(tables[k]!).cast<String, dynamic>();
      records[k] = [for (final r in plain<List>(records[k]!)) (r as Map).cast<String, dynamic>()];
      views[k] = [for (final v in plain<List>(views[k]!)) (v as Map).cast<String, dynamic>()];
    }
  }

  Map<String, dynamic> _u(String id) {
    final u = users.firstWhere((e) => e['user_id'] == id);
    return {'id': id, 'name': u['name']};
  }

  void _seed() {
    final now = DateTime.now();
    int day(int d) => DateTime(now.year, now.month, now.day + d, 18).millisecondsSinceEpoch;
    tables['projects'] = {
      'key': 'projects',
      'name': '项目管理',
      'description': '实验室在研项目',
      'primary_field': 'name',
      'builtin': true,
      'version': 1,
      'fields': [
        {'field_name': 'name', 'title': '项目名称', 'type': 1, 'required': true, 'builtin': true},
        {
          'field_name': 'status', 'title': '状态', 'type': 3, 'builtin': true,
          'options': ['未开始', '进行中', '已完成'],
          'option_colors': {'未开始': 'gray', '进行中': 'blue', '已完成': 'green'},
        },
        {'field_name': 'owner', 'title': '负责人', 'type': 11, 'builtin': true},
        {
          'field_name': 'priority', 'title': '优先级', 'type': 3, 'builtin': true,
          'options': ['高', '中', '低'],
          'option_colors': {'高': 'red', '中': 'orange', '低': 'cyan'},
        },
        {'field_name': 'due', 'title': '截止日期', 'type': 5, 'builtin': true},
        {'field_name': 'progress', 'title': '进度', 'type': 2, 'builtin': true},
        {'field_name': 'notes', 'title': '备注', 'type': 1, 'builtin': true},
      ],
    };
    const names = [
      '机械臂抓取', '四足机器人步态', '视觉定位 SLAM', '灵巧手遥操作', '仿真到真机迁移',
      '多模态大模型导航', '实验室器材盘点', '论文：触觉感知', '双足平衡控制', '数据集标注平台',
      '移动操作平台', '机器人安全规范',
    ];
    const status = ['进行中', '进行中', '已完成', '未开始', '进行中', '未开始', '已完成', '进行中', '进行中', '未开始', '进行中', '已完成'];
    const owners = ['ou_demo', 'ou_zhang', 'ou_chen', 'ou_demo', 'ou_admin', 'ou_zhang', 'ou_chen', 'ou_demo', 'ou_zhang', 'ou_chen', 'ou_admin', 'ou_demo'];
    const pri = ['高', '中', '低', '高', '中', '高', '低', '中', '高', '低', '中', '低'];
    records['projects'] = [
      for (var i = 0; i < names.length; i++)
        {
          'record_id': 'rec_p$i',
          'fields': {
            'name': names[i],
            'status': status[i],
            'owner': [_u(owners[i])],
            'priority': pri[i],
            'due': day(i * 3 - 6),
            'progress': [40, 65, 100, 0, 30, 0, 100, 80, 55, 0, 20, 100][i],
            if (i % 3 == 0) 'notes': '每周组会同步进度',
          },
          'created_at': now.subtract(Duration(days: 30 - i)).toUtc().toIso8601String(),
        },
    ];
    views['projects'] = [
      {
        'view_id': 'vew_all', 'name': '全部项目', 'type': 'grid', 'personal': false, 'version': 1,
        'config': const CosViewConfig().toJson(),
      },
      {
        'view_id': 'vew_board', 'name': '项目看板', 'type': 'kanban', 'personal': false, 'version': 1,
        'config': const CosViewConfig(kanbanField: 'status').toJson(),
      },
      {
        'view_id': 'vew_doing', 'name': '进行中（按负责人）', 'type': 'grid', 'personal': false, 'version': 1,
        'config': const CosViewConfig(
          conditions: [CosFilterCondition('status', 'is', ['进行中'])],
          sort: [CosSortSpec('due')],
          group: [CosSortSpec('owner')],
        ).toJson(),
      },
    ];
    tables['equipment'] = {
      'key': 'equipment',
      'name': '器材借用',
      'primary_field': 'name',
      'builtin': false,
      'created_by': 'ou_admin',
      'version': 1,
      'fields': [
        {'field_name': 'name', 'title': '器材', 'type': 1, 'required': true},
        {'field_name': 'borrower', 'title': '借用人', 'type': 11},
        {'field_name': 'returned', 'title': '已归还', 'type': 7},
      ],
    };
    records['equipment'] = [
      {'record_id': 'rec_e1', 'fields': {'name': 'RealSense D435', 'borrower': [_u('ou_demo')], 'returned': false}},
      {'record_id': 'rec_e2', 'fields': {'name': 'UR5 示教器', 'borrower': [_u('ou_zhang')], 'returned': true}},
    ];
    views['equipment'] = [
      {'view_id': 'vew_e', 'name': '表格视图', 'type': 'grid', 'personal': false, 'version': 1, 'config': const CosViewConfig().toJson()},
    ];
    final n = now.toUtc();
    notifications.addAll([
      _notif('task.assigned', 'ou_demo', '李同学 给你指派了任务「整理组会纪要」', '截止 周五 18:00', {'type': 'task', 'id': 'task_1'}, n.subtract(const Duration(minutes: 8))),
      _notif('record.mention', 'ou_zhang', '张晓明 在「项目管理」的记录中 @了你', '机械臂抓取：请王老师确认采购清单', {'type': 'record', 'table_key': 'projects', 'id': 'rec_p0'}, n.subtract(const Duration(hours: 1))),
      _notif('calendar.invited', 'ou_chen', '陈雨 邀请你参加「项目周会」', '周三 14:00 – 15:00 · 会议室 A', {'type': 'calendar', 'id': 'evt_1'}, n.subtract(const Duration(hours: 5))),
      _notif('doc.comment', 'ou_demo', '李同学 在《组会纪要》中评论了你', '第三部分的实验数据需要更新', {'type': 'doc', 'id': 'doc_1', 'anchor': 'c1'}, n.subtract(const Duration(days: 1)), read: true),
      _notif('doc.mention', 'ou_zhang', '张晓明 在《开题报告》中 @了你', '@王老师 请看一下研究方法', {'type': 'doc', 'id': 'doc_2'}, n.subtract(const Duration(days: 2)), read: true),
    ]);
  }

  Map<String, dynamic> _notif(String type, String actor, String title, String summary, Map<String, dynamic> target,
          DateTime at, {bool read = false}) =>
      {
        'notification_id': _id('ntf'),
        'type': type,
        'actor_id': actor,
        'title': title,
        'summary': summary,
        'target': target,
        'read': read,
        'created_at': at.toIso8601String(),
      };

  // ---------------- HTTP ----------------

  http.Client get client => MockClient(_handle);

  http.Response _json(Object body, [int status = 200]) => http.Response.bytes(
        utf8.encode(jsonEncode(body)),
        status,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );

  http.Response _err(int status, String code, String message, [Map<String, dynamic> extra = const {}]) =>
      _json({'code': code, 'message': message, ...extra}, status);

  void _emit(Map<String, dynamic> e) => onEvent?.call({
        'event_id': _id('evt'),
        'created_at': DateTime.now().toUtc().toIso8601String(),
        ...e,
      });

  Future<http.Response> _handle(http.Request req) async {
    requests.add(req);
    final path = req.url.path.replaceFirst(RegExp(r'^/api/v1'), '');
    final seg = path.split('/').where((s) => s.isNotEmpty).toList();
    final q = req.url.queryParameters;
    final upload = seg.isNotEmpty && seg[0] == 'mock-upload';
    final body = upload || req.body.isEmpty ? <String, dynamic>{} : (jsonDecode(req.body) as Map).cast<String, dynamic>();
    final m = req.method;
    try {
      final d = docs.handle(m, seg, q, body, rawBody: upload ? req.bodyBytes : null);
      if (d != null) return d.$2 == null ? http.Response('', d.$1) : _json(d.$2!, d.$1);
      final tk = taskApi.handle(m, seg, q, body);
      if (tk != null) return tk.$2 == null ? http.Response('', tk.$1) : _json(tk.$2!, tk.$1);
      if (path == '/auth/login' || path == '/auth/refresh') {
        final name = body['username']?.toString();
        if (name != null) currentUser = name == 'demo' ? 'ou_demo' : 'ou_admin';
        return _json({
          'access_token': 'mock_access',
          'refresh_token': 'mock_refresh',
          'expires_in': 7200,
          'user': users.firstWhere((u) => u['user_id'] == currentUser),
        });
      }
      if (path == '/auth/logout') return http.Response('', 204);
      if (path == '/capabilities') return _json({'features': features});
      if (path == '/users/me') return _json(users.firstWhere((u) => u['user_id'] == currentUser));
      if (path == '/users') return _json({'items': users, 'has_more': false});
      if (path == '/users/me/notification-settings') {
        if (m == 'PUT') settings = body;
        return _json(settings);
      }
      if (seg.isNotEmpty && seg[0] == 'notifications') return _notifications(m, seg, q, body);
      if (seg.isNotEmpty && seg[0] == 'devices') {
        if (m == 'POST') {
          final id = devices.entries.where((e) => e.value == body['device_token']).firstOrNull?.key ?? _id('dev');
          devices[id] = body['device_token'].toString();
          return _json({'device_id': id, ...body}, 201);
        }
        if (m == 'DELETE') {
          devices.remove(seg[1]);
          return http.Response('', 204);
        }
      }
      if (seg.isNotEmpty && seg[0] == 'tables') return _tables(m, seg, q, body);
    } on _Fail catch (f) {
      return f.res;
    } on MockFail catch (f) {
      return _err(f.status, f.code, f.message);
    }
    // 其余一期接口：返回空列表，保证页面不报错
    return m == 'GET' ? _json({'items': [], 'has_more': false, 'total': 0}) : _json({});
  }

  http.Response _notifications(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    final mine = notifications;
    if (seg.length == 2 && seg[1] == 'unread-count') {
      return _json({'count': mine.where((n) => n['read'] != true).length});
    }
    if (seg.length == 2 && seg[1] == 'read' && m == 'POST') {
      final ids = {for (final e in (body['ids'] as List? ?? const [])) e.toString()};
      for (final n in mine) {
        if (body['all'] == true || ids.contains(n['notification_id'])) n['read'] = true;
      }
      _emit({'event_type': 'notification.read'});
      return _json({});
    }
    final list = [
      for (final n in mine)
        if (q['filter'] != 'mention' || n['type'].toString().endsWith('.mention')) n,
    ]..sort((a, b) => b['created_at'].toString().compareTo(a['created_at'].toString()));
    return _json({'items': list, 'has_more': false});
  }

  /// 新通知（测试用）：写入并推送 notification.new。
  void pushNotification(String type, String title, {String summary = '', Map<String, dynamic>? target}) {
    final n = _notif(type, 'ou_demo', title, summary, target ?? {'type': 'task'}, DateTime.now().toUtc());
    notifications.add(n);
    _emit({'event_type': 'notification.new', 'notification': n});
  }

  // ---------------- 多维表格 ----------------

  Map<String, dynamic> _table(String key) {
    final t = tables[key];
    if (t == null) throw _Fail(_err(404, 'NOT_FOUND', '数据表不存在'));
    return t;
  }

  Map<String, dynamic> _publicTable(Map<String, dynamic> t) => {
        ...t,
        'permissions': {
          'can_view': true,
          'can_edit': true,
          'can_comment': true,
          'can_manage': currentUser == 'ou_admin' || t['created_by'] == currentUser,
          'can_delete': currentUser == 'ou_admin' || t['created_by'] == currentUser,
        },
      };

  void _checkVersion(Map<String, dynamic> t, Map<String, dynamic> body, Map<String, String> q) {
    final base = body['base_version'] ?? (q['base_version'] == null ? null : int.tryParse(q['base_version']!));
    if (base != null && base != t['version']) {
      throw _Fail(_err(409, 'VERSION_CONFLICT', '内容已被别人修改，请刷新后重试'));
    }
  }

  http.Response _schemaChanged(Map<String, dynamic> t) {
    t['version'] = (t['version'] as int) + 1;
    _emit({'event_type': 'table.schema_changed', 'table_key': t['key'], 'version': t['version']});
    return _json(_publicTable(t));
  }

  List<Map<String, dynamic>> _fields(Map<String, dynamic> t) => (t['fields'] as List).cast<Map<String, dynamic>>();

  http.Response _tables(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    if (seg.length == 1) {
      if (m == 'GET') return _json({'items': [for (final t in tables.values) _publicTable(t)]});
      if (m == 'POST') {
        final key = _id('tbl');
        tables[key] = {
          'key': key,
          'name': body['name'],
          'description': body['description'],
          'primary_field': body['primary_field'],
          'builtin': false,
          'created_by': currentUser,
          'version': 1,
          'fields': body['fields'],
        };
        records[key] = [];
        views[key] = [
          {'view_id': _id('vew'), 'name': '表格视图', 'type': 'grid', 'personal': false, 'version': 1, 'config': const CosViewConfig().toJson()},
        ];
        _emit({'event_type': 'table.created', 'table_key': key});
        return _json(_publicTable(tables[key]!), 201);
      }
    }
    final key = seg[1];
    final t = _table(key);
    if (seg.length == 2) {
      if (m == 'PATCH') {
        final name = body['name']?.toString().trim();
        if (name != null) {
          if (name.isEmpty) throw _Fail(_err(422, 'VALIDATION_FAILED', '表名不能为空'));
          if (tables.values.any((x) => x != t && x['name'] == name)) throw _Fail(_err(409, 'TABLE_NAME_EXISTS', '已有同名数据表「$name」'));
          t['name'] = name;
        }
        for (final k in ['description', 'icon']) {
          if (body.containsKey(k)) t[k] = body[k];
        }
        return _schemaChanged(t);
      }
      if (m == 'DELETE') {
        if (t['builtin'] == true) throw _Fail(_err(403, 'FORBIDDEN', '内置数据表不能删除'));
        tables.remove(key);
        records.remove(key);
        views.remove(key);
        _emit({'event_type': 'table.deleted', 'table_key': key});
        return http.Response('', 204);
      }
      return _json(_publicTable(t));
    }
    switch (seg[2]) {
      case 'permissions':
        final p = tablePerms[key] ??= {
          'owner_id': t['created_by'],
          'visibility': 'all',
          'members': [
            {'member_type': 'user', 'member_id': 'ou_admin', 'role': 'manager'},
          ],
        };
        if (m == 'PUT') {
          if (currentUser != 'ou_admin' && t['created_by'] != currentUser) throw _Fail(_err(403, 'FORBIDDEN', '只有可管理的人能修改表权限'));
          p['visibility'] = body['visibility'] ?? p['visibility'];
          p['members'] = body['members'] ?? p['members'];
        }
        return _json(p);
      case 'copy':
        final nk = _id('tbl');
        final name = body['name']?.toString().trim() ?? '';
        if (tables.values.any((x) => x['name'] == name)) throw _Fail(_err(409, 'TABLE_NAME_EXISTS', '已有同名数据表「$name」'));
        tables[nk] = (jsonDecode(jsonEncode(t)) as Map).cast<String, dynamic>()
          ..['key'] = nk
          ..['name'] = name
          ..['builtin'] = false
          ..['created_by'] = currentUser
          ..['version'] = 1;
        records[nk] = body['with_records'] == true
            ? [for (final r in records[key]!) (jsonDecode(jsonEncode(r)) as Map).cast<String, dynamic>()..['record_id'] = _id('rec')]
            : [];
        views[nk] = [for (final v in views[key]!) if (v['personal'] != true) (jsonDecode(jsonEncode(v)) as Map).cast<String, dynamic>()..['view_id'] = _id('vew')];
        _emit({'event_type': 'table.created', 'table_key': nk});
        return _json(_publicTable(tables[nk]!), 201);
      case 'fields':
        return _fieldsApi(m, seg, q, body, t);
      case 'views':
        return _viewsApi(m, seg, body, key);
      case 'records':
        return _recordsApi(m, seg, q, body, key);
    }
    throw _Fail(_err(404, 'NOT_FOUND', '接口不存在'));
  }

  http.Response _fieldsApi(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body, Map<String, dynamic> t) {
    final fields = _fields(t);
    if (seg.length == 3 && m == 'POST') {
      _checkVersion(t, body, q);
      final title = body['title']?.toString().trim() ?? '';
      if (fields.any((f) => (f['title'] ?? f['field_name']).toString().toLowerCase() == title.toLowerCase())) {
        throw _Fail(_err(422, 'VALIDATION_FAILED', '字段名称不能重复', {
          'errors': [{'field': 'title', 'message': '已有同名字段「$title」'}],
        }));
      }
      final f = {
        'field_name': _id('fld'),
        'title': title,
        'type': body['type'],
        'required': body['required'] == true,
        if (body['options'] != null) 'options': body['options'],
        if (body['option_colors'] != null) 'option_colors': body['option_colors'],
        if (body['description'] != null) 'description': body['description'],
        'builtin': false,
      };
      final after = body['after_field'];
      final i = after == null ? fields.length : fields.indexWhere((x) => x['field_name'] == after) + 1;
      fields.insert(i <= 0 ? fields.length : i, f);
      return _schemaChanged(t);
    }
    if (seg.length == 4 && seg[3] == 'order' && m == 'PUT') {
      _checkVersion(t, body, q);
      final order = [for (final e in body['field_names'] as List) e.toString()];
      fields.sort((a, b) => order.indexOf(a['field_name']).compareTo(order.indexOf(b['field_name'])));
      return _schemaChanged(t);
    }
    final name = seg[3];
    final f = fields.firstWhere((x) => x['field_name'] == name, orElse: () => throw _Fail(_err(404, 'NOT_FOUND', '字段不存在')));
    if (seg.length == 5 && seg[4] == 'convert-preview') {
      final rs = records[t['key']]!;
      final affected = rs.where((r) => !isEmptyLike((r['fields'] as Map)[name])).length;
      final type = body['type'];
      final clear = type == 2
          ? rs.where((r) {
              final v = (r['fields'] as Map)[name];
              return !isEmptyLike(v) && num.tryParse(v.toString()) == null;
            }).length
          : (type == 7 || type == 5 || type == 11) ? affected : 0;
      return _json({'affected': affected, 'will_clear': clear});
    }
    if (m == 'DELETE') {
      _checkVersion(t, body, q);
      if (name == t['primary_field']) throw _Fail(_err(422, 'VALIDATION_FAILED', '主字段不能删除'));
      if (f['builtin'] == true) throw _Fail(_err(403, 'FORBIDDEN', '内置字段不能删除'));
      fields.remove(f);
      for (final r in records[t['key']]!) {
        (r['fields'] as Map).remove(name);
      }
      return _schemaChanged(t);
    }
    if (m == 'PATCH') {
      _checkVersion(t, body, q);
      if (f['builtin'] == true && body['type'] != null && body['type'] != f['type']) {
        throw _Fail(_err(403, 'FORBIDDEN', '内置字段不能修改类型'));
      }
      final renames = (body['option_renames'] as Map?)?.cast<String, dynamic>() ?? const {};
      for (final k in ['title', 'type', 'required', 'options', 'option_colors', 'description']) {
        if (body.containsKey(k)) f[k] = body[k];
      }
      final opts = (f['options'] as List?)?.map((e) => e.toString()).toSet();
      for (final r in records[t['key']]!) {
        final fs = r['fields'] as Map;
        var v = fs[name];
        if (v is String && renames.containsKey(v)) v = renames[v];
        if (v is List && f['type'] == 4) v = [for (final e in v) renames[e] ?? e];
        if (opts != null && (f['type'] == 3) && v is String && !opts.contains(v)) v = null;
        if (opts != null && (f['type'] == 4) && v is List) v = [for (final e in v) if (opts.contains(e)) e];
        if (f['type'] == 2 && v != null && v is! num) v = num.tryParse(v.toString());
        fs[name] = v;
      }
      return _schemaChanged(t);
    }
    throw _Fail(_err(405, 'METHOD_NOT_ALLOWED', '不支持'));
  }

  static bool isEmptyLike(dynamic v) => v == null || v == '' || (v is List && v.isEmpty);

  http.Response _viewsApi(String m, List<String> seg, Map<String, dynamic> body, String key) {
    final vs = views[key]!;
    List<Map<String, dynamic>> visible() =>
        [for (final v in vs) if (v['personal'] != true || v['owner_id'] == currentUser) v];
    if (seg.length == 3) {
      if (m == 'GET') return _json({'items': visible()});
      final v = {
        'view_id': _id('vew'),
        'name': body['name'],
        'type': body['type'] ?? 'grid',
        'personal': body['personal'] == true,
        'owner_id': body['personal'] == true ? currentUser : null,
        'config': body['config'] ?? const CosViewConfig().toJson(),
        'version': 1,
        'updated_at': DateTime.now().toUtc().toIso8601String(),
      };
      vs.add(v);
      _emit({'event_type': 'table.view_changed', 'table_key': key, 'view_id': v['view_id'], 'action': 'created'});
      return _json(v, 201);
    }
    if (seg[3] == 'order') {
      final order = [for (final e in body['view_ids'] as List) e.toString()];
      vs.sort((a, b) => order.indexOf(a['view_id']).compareTo(order.indexOf(b['view_id'])));
      return _json({'items': visible()});
    }
    final v = vs.firstWhere((x) => x['view_id'] == seg[3], orElse: () => throw _Fail(_err(404, 'NOT_FOUND', '视图不存在')));
    if (m == 'DELETE') {
      if (visible().length <= 1) throw _Fail(_err(422, 'VALIDATION_FAILED', '至少保留一个视图'));
      vs.remove(v);
      _emit({'event_type': 'table.view_changed', 'table_key': key, 'view_id': v['view_id'], 'action': 'deleted'});
      return http.Response('', 204);
    }
    if (body['version'] != v['version']) {
      throw _Fail(_err(409, 'VERSION_CONFLICT', '视图已被别人修改'));
    }
    for (final k in ['name', 'config']) {
      if (body.containsKey(k)) v[k] = body[k];
    }
    if (body.containsKey('personal')) {
      v['personal'] = body['personal'] == true;
      v['owner_id'] = v['personal'] == true ? currentUser : null;
    }
    v['version'] = (v['version'] as int) + 1;
    v['updated_at'] = DateTime.now().toUtc().toIso8601String();
    _emit({'event_type': 'table.view_changed', 'table_key': key, 'view_id': v['view_id'], 'action': 'updated'});
    return _json(v);
  }

  Map<String, dynamic>? _validate(String key, Map<String, dynamic> fields) {
    for (final f in _fields(tables[key]!)) {
      if (f['required'] == true && fields.containsKey(f['field_name']) && isEmptyLike(fields[f['field_name']])) {
        return {'field_name': f['field_name'], 'message': '「${f['title']}」是必填项'};
      }
    }
    return null;
  }

  void _recordEvent(String key, String action, Map<String, dynamic> r, [List<String>? changed]) => _emit({
        'event_type': 'record.changed',
        'table_key': key,
        'action': action,
        'record_id': r['record_id'],
        if (action != 'deleted') 'record': r,
        if (changed != null) 'changed_fields': changed,
        'operator_id': currentUser,
      });

  http.Response _recordsApi(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body, String key) {
    final rs = records[key]!;
    if (seg.length == 5 && seg[4] == 'comments') {
      final list = recordComments['$key/${seg[3]}'] ??= [];
      if (m == 'POST') {
        final text = ((body['content'] as Map?)?['text'] ?? '').toString().trim();
        if (text.isEmpty) throw _Fail(_err(422, 'VALIDATION_FAILED', '评论不能为空'));
        final c = {'comment_id': _id('rcm'), 'user_id': currentUser, 'content': body['content'], 'created_at': DateTime.now().toUtc().toIso8601String()};
        list.add(c);
        return _json(c, 201);
      }
      return _json({'items': list, 'has_more': false});
    }
    if (seg.length == 5 && seg[4] == 'history') {
      return _json({'items': (recordHistory['$key/${seg[3]}'] ?? []).reversed.toList(), 'has_more': false});
    }
    if (seg.length == 3 && m == 'GET') {
      var list = [for (final r in rs) CosRecord.fromJson(r)];
      final viewId = q['view_id'];
      var groups = <Map<String, dynamic>>[];
      if (viewId != null) {
        final v = views[key]!.firstWhere((x) => x['view_id'] == viewId, orElse: () => throw _Fail(_err(404, 'NOT_FOUND', '视图不存在')));
        final cfg = CosViewConfig.fromJson((v['config'] as Map).cast<String, dynamic>());
        list = applyView(cfg, list);
        if (cfg.group.isNotEmpty) {
          final counts = <String, int>{};
          for (final r in list) {
            final g = groupValue(r.fields[cfg.group.first.fieldName]);
            counts[g] = (counts[g] ?? 0) + 1;
          }
          groups = [for (final e in counts.entries) {'path': [e.key], 'count': e.value}];
        }
      }
      final ids = {for (final r in list) r.recordId};
      final byId = {for (final r in rs) r['record_id']: r};
      return _json({
        'items': [for (final r in list) if (ids.contains(r.recordId)) byId[r.recordId]],
        'has_more': false,
        'total': list.length,
        if (groups.isNotEmpty) 'groups': groups,
      });
    }
    if (seg.length == 3 && m == 'POST') {
      final r = {'record_id': _id('rec'), 'fields': body['fields'] ?? {}, 'created_at': DateTime.now().toUtc().toIso8601String()};
      rs.add(r);
      _recordEvent(key, 'created', r);
      return _json(r, 201);
    }
    if (seg.length == 4 && seg[3].startsWith('batch_')) {
      final ok = <dynamic>[], failed = <Map<String, dynamic>>[];
      switch (seg[3]) {
        case 'batch_create':
          for (final e in body['records'] as List) {
            final r = {'record_id': _id('rec'), 'fields': (e as Map)['fields'] ?? {}, 'created_at': DateTime.now().toUtc().toIso8601String()};
            rs.add(r);
            ok.add(r);
            _recordEvent(key, 'created', r);
          }
        case 'batch_update':
          final items = body['records'] != null
              ? [for (final e in body['records'] as List) (e['record_id'].toString(), (e['fields'] as Map).cast<String, dynamic>())]
              : [for (final id in body['record_ids'] as List) (id.toString(), (body['fields'] as Map).cast<String, dynamic>())];
          for (final (id, fields) in items) {
            final r = rs.where((x) => x['record_id'] == id).firstOrNull;
            final bad = _validate(key, fields);
            if (r == null || bad != null) {
              failed.add({'record_id': id, 'message': r == null ? '记录不存在' : bad!['message']});
              continue;
            }
            _history(key, r, fields);
            (r['fields'] as Map).addAll(fields);
            ok.add(r);
            _recordEvent(key, 'updated', r, fields.keys.toList());
          }
        case 'batch_delete':
          for (final id in body['record_ids'] as List) {
            final r = rs.where((x) => x['record_id'] == id).firstOrNull;
            if (r == null) {
              failed.add({'record_id': id, 'message': '记录不存在'});
              continue;
            }
            rs.remove(r);
            ok.add(id);
            _recordEvent(key, 'deleted', r);
          }
      }
      return _json({'succeeded': ok, 'failed': failed});
    }
    final r = rs.firstWhere((x) => x['record_id'] == seg[3], orElse: () => throw _Fail(_err(404, 'NOT_FOUND', '记录不存在')));
    if (m == 'DELETE') {
      rs.remove(r);
      _recordEvent(key, 'deleted', r);
      return http.Response('', 204);
    }
    if (m == 'PATCH') {
      final fields = (body['fields'] as Map).cast<String, dynamic>();
      final bad = _validate(key, fields);
      if (bad != null) {
        throw _Fail(_err(422, 'VALIDATION_FAILED', bad['message'], {
          'errors': [{'field': bad['field_name'], 'message': bad['message']}],
        }));
      }
      _history(key, r, fields);
      (r['fields'] as Map).addAll(fields);
      r['updated_at'] = DateTime.now().toUtc().toIso8601String();
      _recordEvent(key, 'updated', r, fields.keys.toList());
      return _json(r);
    }
    return _json(r);
  }

  void _history(String key, Map<String, dynamic> r, Map<String, dynamic> fields, {String? operator}) {
    final before = r['fields'] as Map;
    final changes = [
      for (final e in fields.entries)
        if (jsonEncode(before[e.key]) != jsonEncode(e.value)) {'field_name': e.key, 'before': before[e.key], 'after': e.value},
    ];
    if (changes.isEmpty) return;
    (recordHistory['$key/${r['record_id']}'] ??= []).add({
      'operator_id': operator ?? currentUser,
      'at': DateTime.now().toUtc().toIso8601String(),
      'changes': changes,
    });
  }

  /// 模拟「别人」改了一条记录（测试实时刷新）。
  void simulateRemoteUpdate(String key, String recordId, Map<String, dynamic> fields, {String operator = 'ou_zhang'}) {
    final r = records[key]!.firstWhere((x) => x['record_id'] == recordId);
    _history(key, r, fields, operator: operator);
    (r['fields'] as Map).addAll(fields);
    final saved = currentUser;
    currentUser = operator;
    _recordEvent(key, 'updated', r, fields.keys.toList());
    currentUser = saved;
  }
}

class _Fail implements Exception {
  final http.Response res;
  _Fail(this.res);
}
