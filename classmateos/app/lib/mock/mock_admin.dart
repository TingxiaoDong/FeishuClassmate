/// 测试数据模式：迭代 5 的内存模拟——「我的」、管理后台、组织架构、角色、操作日志、安全设置、
/// 扫码登录、异步任务（导入 / 导出）、工作台应用、报表时间范围。
/// 只用于自测界面；正式数据一律以后端为准。
library;

import 'dart:convert';
import 'dart:typed_data';

import 'mock_docs.dart' show MockFail, MockDocs;

class MockAdmin {
  final String Function() me;
  final void Function(Map<String, dynamic>) emit;
  final List<Map<String, dynamic>> users;
  final MockDocs docs;

  /// 导入记录：返回（成功条数，失败原因列表）。
  final (int, List<String>) Function(String tableKey, String mode, List<Map<String, dynamic>> rows) importRecords;

  /// 导出：返回 CSV 文本。
  final String Function(String tableKey, List<String>? recordIds) exportCsv;
  final String Function(String docId) docMarkdown;

  MockAdmin({
    required this.me,
    required this.emit,
    required this.users,
    required this.docs,
    required this.importRecords,
    required this.exportCsv,
    required this.docMarkdown,
  }) {
    _seed();
  }

  int _seq = 500;
  String _id(String p) => '${p}_${_seq++}';
  String _now() => DateTime.now().toUtc().toIso8601String();

  final Map<String, Map<String, dynamic>> departments = {};
  final Map<String, Map<String, dynamic>> roles = {};
  final List<Map<String, dynamic>> audit = [];
  final Map<String, Map<String, dynamic>> sessions = {};
  final Map<String, Map<String, dynamic>> jobs = {};
  final Map<String, Map<String, dynamic>> qrs = {};
  final Map<String, String> passwords = {};
  Map<String, dynamic> security = {
    'password_min_length': 8,
    'password_require_letter_digit': true,
    'force_change_on_first_login': true,
    'access_token_ttl_minutes': 120,
    'idle_timeout_minutes': 0,
    'lock_after_failures': 5,
    'lock_minutes': 15,
  };
  List<Map<String, dynamic>> shortcuts = [];

  /// 每次 GET /jobs/:id 推进一步，模拟进度。
  final Map<String, List<Map<String, dynamic>>> _jobSteps = {};

  void _seed() {
    void dept(String id, String name, String? parent, String? leader, int order) =>
        departments[id] = {'department_id': id, 'name': name, 'parent_id': parent, 'leader_id': leader, 'order': order};
    dept('d_lab', '具身智能实验室', null, 'ou_admin', 0);
    dept('d_robot', '机器人组', 'd_lab', 'ou_demo', 0);
    dept('d_vision', '视觉组', 'd_lab', 'ou_chen', 1);
    dept('d_admin', '行政与设备', null, 'ou_admin', 1);
    final membership = {
      'ou_admin': ['d_lab', 'd_admin'],
      'ou_demo': ['d_robot'],
      'ou_zhang': ['d_robot'],
      'ou_chen': ['d_vision'],
    };
    final leaders = {'ou_demo': 'ou_admin', 'ou_zhang': 'ou_demo', 'ou_chen': 'ou_admin'};
    final now = DateTime.now();
    var i = 0;
    for (final u in users) {
      final id = u['user_id'] as String;
      u['username'] ??= id == 'ou_admin' ? 'admin' : id.replaceFirst('ou_', '');
      u['status'] ??= 'active';
      u['department_ids'] = membership[id] ?? <String>[];
      u['primary_department_id'] = (membership[id] ?? const []).firstOrNull;
      u['leader_id'] = leaders[id];
      u['last_login_at'] = now.subtract(Duration(hours: 3 * i++)).toUtc().toIso8601String();
    }
    roles['r_super'] = {'role_id': 'r_super', 'name': '超级管理员', 'builtin': 'super_admin', 'permissions': ['admin.members', 'admin.departments', 'admin.roles', 'admin.audit', 'admin.security', 'table.create', 'wiki.create', 'doc.template'], 'member_ids': ['ou_admin']};
    roles['r_admin'] = {'role_id': 'r_admin', 'name': '管理员', 'builtin': 'admin', 'permissions': ['admin.members', 'admin.departments', 'admin.audit', 'table.create', 'wiki.create'], 'member_ids': <String>[]};
    roles['r_member'] = {'role_id': 'r_member', 'name': '成员', 'builtin': 'member', 'permissions': ['table.create', 'wiki.create'], 'member_ids': ['ou_demo', 'ou_zhang', 'ou_chen']};
    roles['r_device'] = {'role_id': 'r_device', 'name': '设备管理员', 'description': '负责器材台账和借用', 'builtin': null, 'permissions': ['table.create'], 'member_ids': ['ou_zhang']};
    for (final u in users) {
      u['role_ids'] = [for (final r in roles.values) if ((r['member_ids'] as List).contains(u['user_id'])) r['role_id']];
    }
    _log('auth.login', 'ou_admin', ip: '10.0.0.12', device: 'macOS 客户端', at: now.subtract(const Duration(minutes: 20)));
    _log('auth.login_failed', 'ou_demo', ip: '10.0.0.31', device: 'iPhone', detail: '密码错误', at: now.subtract(const Duration(hours: 2)));
    _log('doc.delete', 'ou_demo', targetType: 'doc', targetName: '旧版组会记录', at: now.subtract(const Duration(hours: 5)));
    _log('user.update', 'ou_admin', targetType: 'user', targetName: '陈雨', detail: '部门：视觉组', at: now.subtract(const Duration(days: 1)));
    _log('file.download', 'ou_zhang', targetType: 'file', targetName: '采购清单.xlsx', at: now.subtract(const Duration(days: 2)));
    sessions['s_cur'] = {'session_id': 's_cur', 'device_name': '当前设备', 'platform': 'macos', 'ip': '10.0.0.12', 'last_active_at': _now(), 'current': true};
    sessions['s_phone'] = {'session_id': 's_phone', 'device_name': 'iPhone 15', 'platform': 'ios', 'ip': '10.0.0.40', 'last_active_at': now.subtract(const Duration(hours: 6)).toUtc().toIso8601String()};
    sessions['s_web'] = {'session_id': 's_web', 'device_name': 'Chrome 浏览器', 'platform': 'web', 'ip': '172.16.3.8', 'last_active_at': now.subtract(const Duration(days: 3)).toUtc().toIso8601String()};
    shortcuts = [
      {'id': 'sc_1', 'type': 'table_view', 'target_id': 'v_default', 'table_key': 'projects', 'name': '项目管理'},
    ];
  }

  void _log(String action, String op, {String? targetType, String? targetName, String? detail, String? ip, String? device, DateTime? at}) {
    audit.insert(0, {
      'log_id': _id('log'),
      'created_at': (at ?? DateTime.now()).toUtc().toIso8601String(),
      'operator_id': op,
      'operator_name': users.where((u) => u['user_id'] == op).firstOrNull?['name'],
      'action': action,
      'target_type': targetType,
      'target_name': targetName,
      'detail': detail,
      'ip': ip ?? '10.0.0.12',
      'device': device ?? 'macOS 客户端',
    });
  }

  Map<String, dynamic> _user(String id) => users.firstWhere((u) => u['user_id'] == id, orElse: () => throw MockFail(404, 'NOT_FOUND', '成员不存在'));

  bool _can(String perm) {
    final uid = me();
    final rs = roles.values.where((r) => (r['member_ids'] as List).contains(uid));
    return rs.any((r) => (r['permissions'] as List).contains(perm));
  }

  void _need(String perm) {
    if (!_can(perm)) throw MockFail(403, 'FORBIDDEN', '你没有这个操作的权限');
  }

  /// /users/me 附加的权限点。
  List<String> permissionsOf(String uid) => {
        for (final r in roles.values)
          if ((r['member_ids'] as List).contains(uid)) ...(r['permissions'] as List).cast<String>(),
      }.toList();

  Map<String, dynamic> _dept(Map<String, dynamic> d) => {
        ...d,
        'member_count': users.where((u) => (u['department_ids'] as List).contains(d['department_id'])).length,
        'has_children': departments.values.any((x) => x['parent_id'] == d['department_id']),
      };

  String _deptName(String? id) => id == null ? '' : (departments[id]?['name'] ?? '').toString();

  void _syncDeptText(Map<String, dynamic> u) {
    final ids = (u['department_ids'] as List).cast<String>();
    if (!ids.contains(u['primary_department_id'])) u['primary_department_id'] = ids.firstOrNull;
    u['department'] = _deptName(u['primary_department_id'] as String?);
  }

  // ---------------- 任务 ----------------

  String _startJob(List<Map<String, dynamic>> steps) {
    final id = _id('job');
    jobs[id] = {'job_id': id, 'status': 'pending', 'progress': 0};
    _jobSteps[id] = steps;
    return id;
  }

  Map<String, dynamic> _advance(String id) {
    final j = jobs[id] ?? (throw MockFail(404, 'NOT_FOUND', '任务不存在'));
    final steps = _jobSteps[id]!;
    if (steps.isNotEmpty) {
      j
        ..clear()
        ..addAll({'job_id': id, ...steps.removeAt(0)});
      emit({'event_type': 'job.updated', ...j});
    }
    return j;
  }

  String _storeFile(String name, String text) {
    final key = _id('file');
    docs.files[key] = Uint8List.fromList(utf8.encode('\uFEFF$text'));
    docs.fileNames[key] = name;
    return key;
  }

  List<Map<String, dynamic>> _exportSteps(String name, String text) => [
        {'status': 'running', 'progress': 0.4},
        {'status': 'running', 'progress': 0.8},
        {'status': 'done', 'progress': 1, 'result': {'file_key': _storeFile(name, text), 'file_name': name}},
      ];

  /// 简单 CSV 解析（测试数据模式用；正式解析在后端，支持 xlsx）。
  List<List<String>> _csv(String text) {
    final rows = <List<String>>[];
    var row = <String>[], cell = StringBuffer();
    var quoted = false;
    for (var i = 0; i < text.length; i++) {
      final c = text[i];
      if (quoted) {
        if (c == '"' && i + 1 < text.length && text[i + 1] == '"') {
          cell.write('"');
          i++;
        } else if (c == '"') {
          quoted = false;
        } else {
          cell.write(c);
        }
      } else if (c == '"') {
        quoted = true;
      } else if (c == ',') {
        row.add(cell.toString());
        cell = StringBuffer();
      } else if (c == '\n' || c == '\r') {
        if (c == '\r' && i + 1 < text.length && text[i + 1] == '\n') i++;
        row.add(cell.toString());
        cell = StringBuffer();
        if (row.any((x) => x.isNotEmpty)) rows.add(row);
        row = [];
      } else {
        cell.write(c);
      }
    }
    row.add(cell.toString());
    if (row.any((x) => x.isNotEmpty)) rows.add(row);
    return rows;
  }

  List<List<String>> _fileRows(String fileKey) {
    final b = docs.files[fileKey];
    final name = (docs.fileNames[fileKey] ?? '').toLowerCase();
    if (b != null && (name.endsWith('.csv') || name.endsWith('.txt'))) {
      return _csv(utf8.decode(b, allowMalformed: true).replaceFirst('\uFEFF', ''));
    }
    // xlsx 等在测试数据模式里用固定样例代替
    return [
      ['项目名称', '状态', '负责人', '截止日期'],
      ['机械臂抓取实验', '进行中', '李同学', '2026-11-30'],
      ['点云标注工具', '未开始', '张晓明', '2026-12-15'],
      ['四足机器人步态', '进行中', '不存在的人', ''],
    ];
  }

  int _guessType(List<String> values) {
    final vs = values.where((v) => v.isNotEmpty).toList();
    if (vs.isEmpty) return 1;
    if (vs.every((v) => num.tryParse(v) != null)) return 2;
    if (vs.every((v) => RegExp(r'^\d{4}[-/]\d{1,2}[-/]\d{1,2}').hasMatch(v))) return 5;
    if (vs.every((v) => users.any((u) => u['name'] == v))) return 11;
    final distinct = vs.toSet();
    if (distinct.length <= 5 && vs.length >= distinct.length * 1.5) return 3;
    return 1;
  }

  // ---------------- 分发 ----------------

  (int, Object?)? handle(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    if (seg.isEmpty) return null;
    final path = '/${seg.join('/')}';
    final uid = me();

    // ---- 我的 ----
    if (path == '/users/me' && m == 'PATCH') {
      final u = _user(uid);
      for (final k in ['status_text', 'phone']) {
        if (body.containsKey(k)) u[k] = body[k];
      }
      if (body['avatar_file_key'] != null) {
        final b = docs.files[body['avatar_file_key']];
        u['avatar_url'] = b == null ? null : 'data:image/png;base64,${base64Encode(b)}';
      }
      return (200, {...u, 'permissions': permissionsOf(uid)});
    }
    if (path == '/users/me' && m == 'GET') return (200, {..._user(uid), 'permissions': permissionsOf(uid)});
    if (path == '/users/me/password' && m == 'POST') {
      final old = body['old_password']?.toString() ?? '';
      final nw = body['new_password']?.toString() ?? '';
      if (old != (passwords[uid] ?? 'mock')) throw MockFail(422, 'INVALID_PASSWORD', '原密码不正确');
      final min = security['password_min_length'] as int;
      if (nw.length < min) throw MockFail(422, 'WEAK_PASSWORD', '新密码至少 $min 位');
      if (security['password_require_letter_digit'] == true && !(RegExp('[A-Za-z]').hasMatch(nw) && RegExp(r'\d').hasMatch(nw))) {
        throw MockFail(422, 'WEAK_PASSWORD', '新密码需要同时包含字母和数字');
      }
      passwords[uid] = nw;
      return (204, null);
    }
    if (path == '/users/me/sessions' && m == 'GET') {
      return (200, {'items': sessions.values.toList()..sort((a, b) => b['last_active_at'].toString().compareTo(a['last_active_at'].toString()))});
    }
    if (seg.length == 4 && path.startsWith('/users/me/sessions/') && m == 'DELETE') {
      if (sessions[seg[3]]?['current'] == true) throw MockFail(422, 'VALIDATION_ERROR', '当前设备请用「退出登录」');
      sessions.remove(seg[3]);
      return (204, null);
    }
    if (path == '/users/me/logout-all' && m == 'POST') {
      sessions.removeWhere((k, v) => v['current'] != true);
      return (204, null);
    }

    // ---- 成员管理 ----
    if (path == '/users' && m == 'GET' && q['include'] == 'admin') {
      _need('admin.members');
      final kw = (q['q'] ?? '').toLowerCase();
      final list = [
        for (final u in users)
          if ((kw.isEmpty || '${u['name']}${u['username']}${u['email'] ?? ''}'.toLowerCase().contains(kw)) &&
              (q['status'] == null || u['status'] == q['status']) &&
              (q['department_id'] == null || (u['department_ids'] as List).contains(q['department_id'])))
            u,
      ];
      return (200, {'items': list, 'has_more': false, 'total': list.length});
    }
    if (path == '/users' && m == 'GET' && q['department_id'] != null) {
      return (200, {'items': [for (final u in users) if ((u['department_ids'] as List).contains(q['department_id'])) u], 'has_more': false});
    }
    if (path == '/users' && m == 'POST') {
      _need('admin.members');
      final name = body['name']?.toString().trim() ?? '';
      final username = body['username']?.toString().trim() ?? '';
      if (name.isEmpty || username.isEmpty) throw MockFail(422, 'VALIDATION_ERROR', '请填写姓名和账号');
      if (users.any((u) => u['username'] == username)) throw MockFail(409, 'USERNAME_EXISTS', '账号「$username」已存在');
      final u = <String, dynamic>{
        'user_id': 'ou_${username.replaceAll(RegExp(r'\W'), '_')}',
        'name': name,
        'username': username,
        'role': 'member',
        'status': 'active',
        'department_ids': <String>[],
        'role_ids': <String>[],
      };
      _patchUser(u, body);
      users.add(u);
      final pw = 'Cos${DateTime.now().millisecondsSinceEpoch % 1000000}';
      passwords[u['user_id'] as String] = pw;
      _log('user.create', uid, targetType: 'user', targetName: name);
      return (201, {...u, 'initial_password': pw});
    }
    if (seg.length == 2 && seg[0] == 'users' && m == 'PATCH' && seg[1] != 'me') {
      _need('admin.members');
      final u = _user(seg[1]);
      if (body['status'] != null && seg[1] == uid) throw MockFail(422, 'VALIDATION_ERROR', '不能禁用自己');
      _patchUser(u, body);
      _log(body['status'] == 'disabled' ? 'user.disable' : body['status'] == 'active' ? 'user.enable' : 'user.update', uid,
          targetType: 'user', targetName: u['name'] as String);
      return (200, u);
    }
    if (seg.length == 3 && seg[0] == 'users' && seg[2] == 'reset-password' && m == 'POST') {
      _need('admin.members');
      final u = _user(seg[1]);
      final pw = 'Cos${DateTime.now().millisecondsSinceEpoch % 1000000}';
      passwords[seg[1]] = pw;
      _log('user.reset_password', uid, targetType: 'user', targetName: u['name'] as String);
      return (200, {'password': pw});
    }
    if (seg.length == 3 && seg[0] == 'users' && seg[2] == 'logout-all' && m == 'POST') {
      _need('admin.members');
      _log('user.logout_all', uid, targetType: 'user', targetName: _user(seg[1])['name'] as String);
      return (204, null);
    }
    if (path == '/users/import/template' && m == 'GET') {
      return (200, {'file_key': _storeFile('成员导入模板.csv', '姓名,账号,邮箱,电话,部门,职位\n示例同学,example,example@lab.edu,13800000000,机器人组,硕士生\n')});
    }
    if (path == '/users/import/preview' && m == 'POST') {
      final rows = _fileRows(body['file_key'].toString());
      final headers = rows.isEmpty ? <String>[] : rows.first;
      final data = rows.skip(1).take(20).toList();
      final iu = headers.indexOf('账号');
      return (200, {
        'headers': headers,
        'rows': data,
        'total_rows': rows.length - 1,
        'errors': [
          for (var i = 0; i < data.length; i++)
            if (iu < 0 || iu >= data[i].length || data[i][iu].isEmpty)
              {'row': i, 'message': '缺少账号'}
            else if (users.any((u) => u['username'] == data[i][iu]))
              {'row': i, 'message': '账号「${data[i][iu]}」已存在'},
        ],
      });
    }
    if (path == '/users/import' && m == 'POST') {
      _need('admin.members');
      final rows = _fileRows(body['file_key'].toString());
      final h = rows.isEmpty ? <String>[] : rows.first;
      var ok = 0;
      final errs = <String>[];
      for (final r in rows.skip(1)) {
        String col(String n) => h.contains(n) && h.indexOf(n) < r.length ? r[h.indexOf(n)].trim() : '';
        final un = col('账号');
        if (un.isEmpty || users.any((u) => u['username'] == un)) {
          errs.add('${col('姓名')}：${un.isEmpty ? '缺少账号' : '账号已存在'}');
          continue;
        }
        final dept = departments.values.where((d) => d['name'] == col('部门')).firstOrNull;
        users.add({
          'user_id': 'ou_$un', 'name': col('姓名'), 'username': un, 'email': col('邮箱'), 'phone': col('电话'),
          'title': col('职位'), 'role': 'member', 'status': 'active',
          'department_ids': [?dept?['department_id']], 'primary_department_id': dept?['department_id'],
          'department': dept?['name'], 'role_ids': <String>[],
        });
        ok++;
      }
      _log('user.import', uid, detail: '成功 $ok 人，失败 ${errs.length} 人');
      return (200, {
        'job_id': _startJob([
          {'status': 'running', 'progress': 0.5},
          {'status': 'done', 'progress': 1, 'result': {'succeeded': ok, 'failed': errs.length, if (errs.isNotEmpty) 'error_file_key': _storeFile('导入失败明细.csv', '原因\n${errs.join('\n')}')}},
        ]),
      });
    }

    // ---- 组织架构 ----
    if (seg[0] == 'departments') {
      if (seg.length == 1 && m == 'GET') {
        final parent = q['parent_id'] == null || q['parent_id'] == 'root' ? null : q['parent_id'];
        // 和后端一致：按 order 升序，相同时按部门 ID
        final l = [for (final d in departments.values) if (d['parent_id'] == parent) d]
          ..sort((a, b) {
            final c = ((a['order'] as num?) ?? 0).compareTo((b['order'] as num?) ?? 0);
            return c != 0 ? c : a['department_id'].toString().compareTo(b['department_id'].toString());
          });
        return (200, {'items': [for (final d in l) _dept(d)], 'has_more': false});
      }
      if (seg.length == 1 && m == 'POST') {
        _need('admin.departments');
        final name = body['name']?.toString().trim() ?? '';
        if (name.isEmpty) throw MockFail(422, 'VALIDATION_ERROR', '请填写部门名称');
        final id = _id('d');
        final parent = body['parent_id'] as String?;
        departments[id] = {'department_id': id, 'name': name, 'parent_id': parent, 'leader_id': body['leader_id'],
          'order': departments.values.where((d) => d['parent_id'] == parent).length};
        _log('department.change', uid, targetType: 'department', targetName: name, detail: '新建部门');
        emit({'event_type': 'department.changed', 'department_id': id});
        return (201, _dept(departments[id]!));
      }
      final d = departments[seg[1]] ?? (throw MockFail(404, 'NOT_FOUND', '部门不存在'));
      if (seg.length == 2 && m == 'GET') return (200, _dept(d));
      if (seg.length == 3 && seg[2] == 'path') {
        final out = <Map<String, dynamic>>[];
        Map<String, dynamic>? cur = d;
        while (cur != null && out.length < 20) {
          out.insert(0, _dept(cur));
          cur = departments[cur['parent_id']];
        }
        return (200, {'items': out});
      }
      _need('admin.departments');
      if (seg.length == 2 && m == 'PATCH') {
        if (body.containsKey('parent_id')) {
          // 不能移到自己或自己的下级
          String? p = body['parent_id'] as String?;
          while (p != null) {
            if (p == d['department_id']) throw MockFail(422, 'VALIDATION_ERROR', '不能移动到自己的下级部门');
            p = departments[p]?['parent_id'] as String?;
          }
          d['parent_id'] = body['parent_id'];
        }
        for (final k in ['name', 'leader_id', 'order']) {
          if (body.containsKey(k)) d[k] = body[k];
        }
        // 和后端一致：order 只是排序值，不会自动给同级重新编号（前端负责重排）
        for (final u in users) {
          _syncDeptText(u);
        }
        _log('department.change', uid, targetType: 'department', targetName: d['name'] as String);
        emit({'event_type': 'department.changed', 'department_id': d['department_id']});
        return (200, _dept(d));
      }
      if (seg.length == 2 && m == 'DELETE') {
        if (departments.values.any((x) => x['parent_id'] == d['department_id'])) {
          throw MockFail(409, 'DEPARTMENT_NOT_EMPTY', '请先删除或移走下级部门');
        }
        if (users.any((u) => (u['department_ids'] as List).contains(d['department_id']))) {
          throw MockFail(409, 'DEPARTMENT_NOT_EMPTY', '部门里还有成员，请先移出');
        }
        departments.remove(d['department_id']);
        emit({'event_type': 'department.changed', 'department_id': d['department_id']});
        return (204, null);
      }
      if (seg.length == 3 && seg[2] == 'members' && m == 'POST') {
        for (final id in (body['user_ids'] as List? ?? const [])) {
          final u = _user(id.toString());
          final l = (u['department_ids'] as List).cast<String>().toList();
          if (!l.contains(d['department_id'])) l.add(d['department_id'] as String);
          u['department_ids'] = l;
          _syncDeptText(u);
        }
        emit({'event_type': 'department.changed', 'department_id': d['department_id']});
        return (204, null);
      }
      if (seg.length == 4 && seg[2] == 'members' && m == 'DELETE') {
        final u = _user(seg[3]);
        u['department_ids'] = (u['department_ids'] as List).where((x) => x != d['department_id']).toList();
        _syncDeptText(u);
        emit({'event_type': 'department.changed', 'department_id': d['department_id']});
        return (204, null);
      }
    }

    // ---- 角色 ----
    if (seg[0] == 'roles') {
      if (seg.length == 1 && m == 'GET') return (200, {'items': roles.values.toList()});
      _need('admin.roles');
      if (seg.length == 1 && m == 'POST') {
        final name = body['name']?.toString().trim() ?? '';
        if (name.isEmpty) throw MockFail(422, 'VALIDATION_ERROR', '请填写角色名称');
        if (roles.values.any((r) => r['name'] == name)) throw MockFail(409, 'ROLE_NAME_EXISTS', '角色「$name」已存在');
        final id = _id('r');
        roles[id] = {'role_id': id, 'name': name, 'description': body['description'], 'builtin': null,
          'permissions': body['permissions'] ?? <String>[], 'member_ids': <String>[]};
        _log('role.change', uid, targetType: 'role', targetName: name, detail: '新建角色');
        return (201, roles[id]);
      }
      final r = roles[seg[1]] ?? (throw MockFail(404, 'NOT_FOUND', '角色不存在'));
      if (seg.length == 2 && m == 'PATCH') {
        if (r['builtin'] == 'super_admin' && body.containsKey('permissions')) throw MockFail(422, 'VALIDATION_ERROR', '超级管理员的权限不能修改');
        for (final k in ['name', 'description', 'permissions']) {
          if (body.containsKey(k)) r[k] = body[k];
        }
        _log('role.change', uid, targetType: 'role', targetName: r['name'] as String);
        emit({'event_type': 'permissions.changed'});
        return (200, r);
      }
      if (seg.length == 2 && m == 'DELETE') {
        if (r['builtin'] != null) throw MockFail(422, 'VALIDATION_ERROR', '内置角色不能删除');
        roles.remove(seg[1]);
        emit({'event_type': 'permissions.changed'});
        return (204, null);
      }
      if (seg.length == 3 && seg[2] == 'members' && m == 'PUT') {
        final ids = [for (final x in (body['user_ids'] as List? ?? const [])) x.toString()];
        if (r['builtin'] == 'super_admin' && ids.isEmpty) throw MockFail(422, 'VALIDATION_ERROR', '至少保留一名超级管理员');
        r['member_ids'] = ids;
        for (final u in users) {
          u['role_ids'] = [for (final x in roles.values) if ((x['member_ids'] as List).contains(u['user_id'])) x['role_id']];
        }
        _log('role.change', uid, targetType: 'role', targetName: r['name'] as String, detail: '成员 ${ids.length} 人');
        emit({'event_type': 'permissions.changed'});
        return (200, r);
      }
    }

    // ---- 操作日志 ----
    if (path == '/audit-logs' && m == 'GET') {
      _need('admin.audit');
      final from = DateTime.tryParse(q['start_at'] ?? ''), to = DateTime.tryParse(q['end_at'] ?? '');
      final list = [
        for (final l in audit)
          if ((q['operator_id'] == null || l['operator_id'] == q['operator_id']) &&
              (q['action'] == null || l['action'] == q['action']) &&
              (from == null || !DateTime.parse(l['created_at'] as String).isBefore(from)) &&
              (to == null || DateTime.parse(l['created_at'] as String).isBefore(to)))
            l,
      ];
      return (200, {'items': list, 'has_more': false, 'total': list.length});
    }
    if (path == '/audit-logs/exports' && m == 'POST') {
      _need('admin.audit');
      final csv = StringBuffer('时间,操作人,操作,对象,详情,IP,设备\n');
      for (final l in audit) {
        csv.writeln([l['created_at'], l['operator_name'], l['action'], l['target_name'] ?? '', l['detail'] ?? '', l['ip'], l['device']].join(','));
      }
      return (200, {'job_id': _startJob(_exportSteps('操作日志.csv', csv.toString()))});
    }

    // ---- 安全设置 ----
    if (path == '/admin/security-settings') {
      _need('admin.security');
      if (m == 'PUT') {
        final n = body['password_min_length'];
        if (n is! int || n < 6 || n > 32) throw MockFail(422, 'VALIDATION_ERROR', '密码最短长度需在 6～32 之间');
        security = {...security, ...body};
        _log('security.update', uid);
      }
      return (200, security);
    }

    // ---- 扫码登录 ----
    if (seg[0] == 'auth' && seg.length >= 2 && seg[1] == 'qr') {
      if (seg.length == 2 && m == 'POST') {
        final id = _id('qr');
        qrs[id] = {'status': 'waiting', 'device_name': body['device_name'] ?? '桌面客户端', 'expires': DateTime.now().add(const Duration(minutes: 2))};
        return (200, {
          'qr_id': id,
          'qr_content': 'classmateos://qr-login?qr_id=$id&server=${Uri.encodeComponent('http://mock.classmateos/api/v1')}',
          'expires_at': (qrs[id]!['expires'] as DateTime).toUtc().toIso8601String(),
        });
      }
      final t = qrs[seg[2]] ?? (throw MockFail(404, 'NOT_FOUND', '二维码不存在'));
      if (DateTime.now().isAfter(t['expires'] as DateTime) && t['status'] != 'confirmed') t['status'] = 'expired';
      if (seg.length == 3 && m == 'GET') {
        return (200, {
          'status': t['status'],
          'device_name': t['device_name'],
          if (t['status'] == 'scanned') 'scanned_by_name': t['scanned_by_name'],
          if (t['status'] == 'confirmed')
            'session': {'access_token': 'mock_access', 'refresh_token': 'mock_refresh', 'expires_in': 7200, 'user': _user(t['user_id'] as String)},
        });
      }
      if (t['status'] == 'expired') throw MockFail(409, 'QR_EXPIRED', '二维码已过期，请在电脑上刷新');
      switch (seg.length == 4 ? seg[3] : '') {
        case 'scan':
          t['status'] = 'scanned';
          t['user_id'] = uid;
          t['scanned_by_name'] = _user(uid)['name'];
          return (200, {'status': 'scanned', 'device_name': t['device_name']});
        case 'confirm':
          if (t['user_id'] != uid) throw MockFail(409, 'QR_STATE_INVALID', '请重新扫码');
          t['status'] = 'confirmed';
          _log('auth.qr_login', uid, device: t['device_name'] as String);
          return (204, null);
        case 'cancel':
          t['status'] = 'canceled';
          return (204, null);
      }
    }

    // ---- 异步任务 ----
    if (seg[0] == 'jobs' && seg.length == 2 && m == 'GET') return (200, _advance(seg[1]));
    if (path == '/tables/imports/preview' && m == 'POST') {
      final rows = _fileRows(body['file_key'].toString());
      final headers = rows.isEmpty ? <String>[] : rows.first;
      final data = rows.skip(1).toList();
      return (200, {
        'headers': headers,
        'rows': data.take(20).toList(),
        'total_rows': data.length,
        'suggested_types': {
          for (var i = 0; i < headers.length; i++) headers[i]: _guessType([for (final r in data) i < r.length ? r[i] : '']),
        },
      });
    }
    if (seg[0] == 'tables' && seg.length == 3 && seg[2] == 'imports' && m == 'POST') {
      final rows = _fileRows(body['file_key'].toString());
      final h = rows.isEmpty ? <String>[] : rows.first;
      final mapping = (body['mapping'] as Map? ?? const {}).cast<String, dynamic>();
      final mode = body['mode']?.toString() ?? 'append';
      final out = [
        for (final r in rows.skip(1))
          {
            for (final e in mapping.entries)
              if (h.contains(e.key)) e.value.toString(): h.indexOf(e.key) < r.length ? r[h.indexOf(e.key)] : '',
          },
      ];
      final (ok, errs) = importRecords(seg[1], mode, out);
      return (200, {
        'job_id': _startJob([
          {'status': 'running', 'progress': 0.3},
          {'status': 'running', 'progress': 0.7},
          {'status': 'done', 'progress': 1, 'result': {'succeeded': ok, 'failed': errs.length, if (errs.isNotEmpty) 'error_file_key': _storeFile('导入失败明细.csv', '行,原因\n${errs.join('\n')}')}},
        ]),
      });
    }
    if (seg[0] == 'tables' && seg.length == 3 && seg[2] == 'exports' && m == 'POST') {
      final fmt = body['format'] == 'csv' ? 'csv' : 'xlsx';
      final ids = body['record_ids'] is List ? [for (final x in body['record_ids'] as List) x.toString()] : null;
      // 测试数据模式统一生成 CSV；xlsx 由后端生成
      return (200, {'job_id': _startJob(_exportSteps('${seg[1]}.${fmt == 'csv' ? 'csv' : 'csv'}', exportCsv(seg[1], ids)))});
    }
    if (seg[0] == 'docs' && seg.length == 3 && seg[2] == 'exports' && m == 'POST') {
      final fmt = body['format'];
      if (fmt != 'pdf' && fmt != 'docx') throw MockFail(422, 'VALIDATION_ERROR', 'format 只能是 pdf / docx');
      return (200, {'job_id': _startJob(_exportSteps('文档导出（测试数据，实际为 $fmt）.md', docMarkdown(seg[1])))});
    }

    // ---- 工作台 ----
    if (path == '/workbench/apps' && m == 'GET') {
      return (200, {'builtin': ['wiki', 'bitable', 'tasks', 'docs', 'drive', 'contacts'], 'shortcuts': shortcuts});
    }
    if (path == '/workbench/shortcuts' && m == 'PUT') {
      final l = [for (final x in (body['shortcuts'] as List? ?? const [])) (x as Map).cast<String, dynamic>()];
      if (l.length > 30) throw MockFail(422, 'VALIDATION_ERROR', '最多添加 30 个快捷方式');
      shortcuts = [for (final s in l) {...s, 'id': s['id'] ?? _id('sc')}];
      return (200, {'shortcuts': shortcuts});
    }
    if (path == '/dashboard/summary') {
      final r = q['range'] ?? 'week';
      final k = switch (r) { 'month' => 4, 'semester' => 16, 'custom' => 2, _ => 1 };
      // 与真实后端 server/dashboard.ts 的 DashboardSummary 结构一致
      return (200, {
        'range': r,
        'generated_at': DateTime.now().toUtc().toIso8601String(),
        'tool_usage': {'total': 120 * k, 'by_tool': {'table.list': 50 * k, 'doc.read': 40 * k, 'calendar.create': 30 * k}},
        'tool_success': {
          'by_tool': {
            'table.list': {'ok': 48 * k, 'total': 50 * k, 'rate': 96.0},
            'doc.read': {'ok': 32 * k, 'total': 40 * k, 'rate': 80.0},
            'calendar.create': {'ok': 18 * k, 'total': 30 * k, 'rate': 60.0},
          },
        },
        'projects_kpi': {
          'projects_total': 6,
          'projects_by_status': {'进行中': 3, '未开始': 2, '已完成': 1},
          'gantt_total': 14,
          'gantt_overdue': k ~/ 2 + 1,
        },
        'equipment': {'total': 18, 'by_state': {'在库': 12, '借出': 5, '维修': 1}},
        'submissions': {'total': 2 * k, 'by_status': {'准备中': k, '已投稿': k ~/ 2 + 1, '已录用': k ~/ 2}},
        'failures': [
          for (var i = 0; i < (k > 5 ? 5 : k + 1); i++)
            {'record_id': 'fail_$i', 'fields': {'title': '工具调用失败 #${i + 1}', 'tool_name': 'table.list', 'error': '超时'}},
        ],
      });
    }
    return null;
  }

  void _patchUser(Map<String, dynamic> u, Map<String, dynamic> body) {
    for (final k in ['name', 'email', 'phone', 'title', 'status', 'leader_id']) {
      if (body.containsKey(k)) u[k] = body[k];
    }
    if (body['department_ids'] is List) u['department_ids'] = [for (final x in body['department_ids'] as List) x.toString()];
    if (body.containsKey('primary_department_id')) u['primary_department_id'] = body['primary_department_id'];
    _syncDeptText(u);
  }
}
