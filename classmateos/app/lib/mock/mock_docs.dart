/// 测试数据模式（迭代 2）：云文档权限 / 评论 / 版本 / 文件夹、知识库、文件直传的内存模拟。
/// 由 MockBackend 分发调用；数据和事件格式按《二期功能需求文档》第 5、6 节。
library;

import 'dart:convert';
import 'dart:typed_data';

class MockFail implements Exception {
  final int status;
  final String code;
  final String message;
  MockFail(this.status, this.code, this.message);
}

typedef MockEmit = void Function(Map<String, dynamic> e);

class MockDocs {
  final String Function() me;
  final MockEmit emit;
  final bool Function(String uid) isAdmin;
  MockDocs({required this.me, required this.emit, required this.isAdmin}) {
    _seed();
  }

  int _seq = 500;
  String _id(String p) => '${p}_${_seq++}';
  String _now() => DateTime.now().toUtc().toIso8601String();

  final Map<String, Map<String, dynamic>> docs = {};
  final Map<String, Map<String, dynamic>> perms = {};
  final Map<String, List<Map<String, dynamic>>> comments = {};
  final Map<String, List<Map<String, dynamic>>> versions = {};
  final Map<String, Map<String, dynamic>> folders = {};
  final Map<String, Set<String>> starred = {}; // uid → doc ids
  final Map<String, Map<String, String>> viewed = {}; // uid → doc id → time
  final List<Map<String, dynamic>> accessRequests = [];
  final Map<String, Map<String, dynamic>> spaces = {};
  final Map<String, Map<String, dynamic>> spaceMembers = {};
  final Map<String, Map<String, dynamic>> nodes = {};
  final Map<String, Set<String>> nodeStars = {};
  final Map<String, Map<String, String>> nodeViewed = {};
  final Map<String, Uint8List> files = {};
  final Map<String, String> fileNames = {};

  // ---------------- 种子数据 ----------------

  void _seed() {
    final n = DateTime.now().toUtc();
    String ago(Duration d) => n.subtract(d).toIso8601String();
    folders['fld_meet'] = {'folder_id': 'fld_meet', 'name': '组会', 'parent_id': null, 'owner_id': 'ou_admin', 'updated_at': ago(const Duration(days: 1))};
    folders['fld_2026'] = {'folder_id': 'fld_2026', 'name': '2026 秋季', 'parent_id': 'fld_meet', 'owner_id': 'ou_admin', 'updated_at': ago(const Duration(days: 1))};
    _doc('doc_1', '组会纪要 10-17', 'ou_admin', '# 组会纪要 10-17\n\n**参会人**：王老师、李同学、张晓明\n\n## 进展\n\n- 机械臂抓取成功率提升到 87%\n- 四足机器人完成楼梯步态仿真\n\n## 待办\n\n- [ ] 更新实验数据\n- [x] 预约会议室\n',
        folder: 'fld_2026', updated: ago(const Duration(hours: 3)));
    _doc('doc_2', '开题报告（张晓明）', 'ou_zhang', '# 开题报告\n\n## 研究背景\n\n触觉感知是灵巧操作的关键。\n\n## 研究方法\n\n使用视触觉传感器采集数据，训练多模态策略。\n',
        updated: ago(const Duration(days: 2)));
    perms['doc_2']!['members'] = [
      {'member_type': 'user', 'member_id': 'ou_admin', 'role': 'commenter'},
    ];
    _doc('doc_3', '实验室安全须知', 'ou_demo', '# 实验室安全须知\n\n1. 机械臂运行时不要进入工作区\n2. 离开前关闭电源\n',
        updated: ago(const Duration(days: 6)), link: 'org_view');
    _doc('doc_4', '旧版器材清单', 'ou_admin', '# 旧版器材清单\n', updated: ago(const Duration(days: 9)));
    docs['doc_4']!['deleted_at'] = ago(const Duration(days: 2));
    _doc('doc_5', '论文阅读笔记：Diffusion Policy', 'ou_admin', '# Diffusion Policy\n\n> 用扩散模型生成动作序列。\n\n## 要点\n\n- 动作分块\n- 视觉条件\n',
        updated: ago(const Duration(days: 4)));
    starred['ou_admin'] = {'doc_5'};
    viewed['ou_admin'] = {'doc_1': ago(const Duration(hours: 2)), 'doc_3': ago(const Duration(days: 1)), 'doc_2': ago(const Duration(days: 2))};
    versions['doc_1'] = [
      _ver('ou_demo', ago(const Duration(days: 3)), '# 组会纪要 10-17\n\n## 进展\n\n- 机械臂抓取成功率 80%\n', 60, 0),
      _ver('ou_admin', ago(const Duration(days: 1)), '# 组会纪要 10-17\n\n**参会人**：王老师、李同学\n\n## 进展\n\n- 机械臂抓取成功率提升到 87%\n\n## 待办\n\n- [ ] 更新实验数据\n', 40, 6,
          name: '组会前定稿'),
    ];
    comments['doc_1'] = [
      {
        'comment_id': 'cmt_1', 'doc_id': 'doc_1', 'quote': '机械臂抓取成功率提升到 87%',
        'anchor': {'offset': docs['doc_1']!['markdown'].toString().indexOf('机械臂抓取成功率提升到 87%'), 'length': 15},
        'is_whole': false, 'solved': false, 'created_by': 'ou_demo', 'created_at': ago(const Duration(hours: 5)),
        'replies': [
          {'reply_id': 'rpl_1', 'user_id': 'ou_demo', 'content': {'text': '这个数据是在哪个物体集上测的？@王老师', 'mentions': [{'user_id': 'ou_admin', 'name': '王老师', 'offset': 16, 'length': 4}]}, 'created_at': ago(const Duration(hours: 5))},
          {'reply_id': 'rpl_2', 'user_id': 'ou_zhang', 'content': {'text': 'YCB 子集，20 个物体', 'mentions': []}, 'created_at': ago(const Duration(hours: 4))},
        ],
      },
      {
        'comment_id': 'cmt_2', 'doc_id': 'doc_1', 'quote': null, 'anchor': {}, 'is_whole': true, 'solved': true,
        'created_by': 'ou_zhang', 'created_at': ago(const Duration(days: 1)),
        'replies': [
          {'reply_id': 'rpl_3', 'user_id': 'ou_zhang', 'content': {'text': '会议时间改到周三了', 'mentions': []}, 'created_at': ago(const Duration(days: 1))},
        ],
      },
    ];

    // 知识空间
    _space('wks_lab', 'Lab 知识库', '实验室技术沉淀：设备、流程、论文', 'book', 'blue', 'org', {'ou_admin': 'admin', 'ou_demo': 'editor'});
    _space('wks_new', '新人指南', '入组第一周看这里', 'school', 'green', 'org', {'ou_admin': 'admin'});
    _space('wks_proj', '项目档案', '结题项目的文档归档', 'inventory', 'orange', 'members', {'ou_admin': 'admin', 'ou_zhang': 'viewer'});
    final dev = _node('wks_lab', null, '设备手册', '# 设备手册\n\n实验室常用设备的使用说明。\n');
    _node('wks_lab', dev, '机械臂标定流程', '# 机械臂标定流程\n\n1. 安装标定板\n2. 采集 20 组位姿\n3. 运行手眼标定脚本\n');
    final rs = _node('wks_lab', dev, 'RealSense 相机', '# RealSense 相机\n\n型号 D435，USB 3.0 连接。\n');
    _node('wks_lab', rs, '常见问题', '# 常见问题\n\n- 帧率低：检查 USB 口\n');
    final flow = _node('wks_lab', null, '实验流程', '# 实验流程\n');
    _node('wks_lab', flow, '数据采集规范', '# 数据采集规范\n\n命名：日期_任务_编号\n');
    _node('wks_lab', null, '论文写作模板', '# 论文写作模板\n');
    _node('wks_new', null, '第一周清单', '# 第一周清单\n\n- [ ] 领取门禁卡\n- [ ] 加入实验室群\n');
    _node('wks_new', null, '账号与服务器', '# 账号与服务器\n\nGPU 服务器申请找王老师。\n');
    _node('wks_proj', null, '2025 灵巧手项目结题', '# 结题报告\n');
    nodeStars['ou_admin'] = {nodes.values.firstWhere((x) => x['title'] == '机械臂标定流程')['node_id'] as String};
    nodeViewed['ou_admin'] = {
      for (final x in nodes.values.where((x) => x['title'] == '数据采集规范' || x['title'] == '第一周清单')) x['node_id'] as String: ago(const Duration(hours: 6)),
    };
  }

  Map<String, dynamic> _ver(String by, String at, String md, int add, int rm, {String? name}) =>
      {'version_id': _id('ver'), 'name': name, 'created_by': by, 'created_at': at, 'added': add, 'removed': rm, 'markdown': md};

  void _doc(String id, String title, String owner, String md, {String? folder, String? updated, String link = 'off', String? space, String? node}) {
    docs[id] = {
      'doc_id': id, 'title': title, 'created_by': owner, 'owner_id': owner, 'markdown': md,
      'created_at': updated ?? _now(), 'updated_at': updated ?? _now(), 'updated_by': owner,
      'folder_id': folder, 'deleted_at': null, 'wiki_space_id': space, 'wiki_node_id': node,
    };
    perms[id] = {'owner_id': owner, 'link_share': link, 'members': <Map<String, dynamic>>[]};
  }

  void _space(String id, String name, String desc, String icon, String color, String vis, Map<String, String> members) {
    spaces[id] = {'space_id': id, 'name': name, 'description': desc, 'icon': icon, 'color': color, 'visibility': vis, 'updated_at': _now()};
    spaceMembers[id] = {
      'visibility': vis,
      'members': [for (final e in members.entries) {'member_type': 'user', 'member_id': e.key, 'role': e.value}],
    };
  }

  String _node(String space, String? parent, String title, String md) {
    final id = _id('wkn');
    final docId = _id('doc');
    final siblings = nodes.values.where((x) => x['space_id'] == space && x['parent_id'] == parent).length;
    nodes[id] = {
      'node_id': id, 'space_id': space, 'parent_id': parent, 'title': title, 'obj_type': 'doc', 'obj_id': docId,
      'order': (siblings + 1) * 1024, 'updated_at': _now(), 'updated_by': me(), 'deleted': false,
    };
    _doc(docId, title, 'ou_admin', md, space: space, node: id);
    return id;
  }

  // ---------------- 权限计算 ----------------

  static const _rank = {'viewer': 1, 'commenter': 2, 'editor': 3, 'manager': 4};

  String? spaceRole(String spaceId, String uid) {
    final m = spaceMembers[spaceId];
    if (m == null) return null;
    for (final x in (m['members'] as List)) {
      if (x['member_type'] == 'user' && x['member_id'] == uid) return x['role'] as String;
    }
    if (isAdmin(uid)) return 'admin';
    return m['visibility'] == 'org' ? 'viewer' : null;
  }

  String? docRole(String docId, String uid) {
    final d = docs[docId]!;
    final space = d['wiki_space_id'] as String?;
    if (space != null) {
      return switch (spaceRole(space, uid)) { 'admin' => 'manager', 'editor' => 'editor', 'viewer' => 'viewer', _ => null };
    }
    final p = perms[docId]!;
    if (p['owner_id'] == uid) return 'manager';
    String? best;
    void take(String r) {
      if (best == null || _rank[r]! > _rank[best]!) best = r;
    }

    for (final x in (p['members'] as List)) {
      if (x['member_type'] == 'user' && x['member_id'] == uid) take(x['role'] as String);
    }
    if (p['link_share'] == 'org_view') take('viewer');
    if (p['link_share'] == 'org_edit') take('editor');
    return best;
  }

  Map<String, dynamic> _publicDoc(Map<String, dynamic> d, {bool body = true}) {
    final uid = me();
    final role = docRole(d['doc_id'] as String, uid);
    final r = _rank[role] ?? 0;
    final owner = d['owner_id'] == uid;
    return {
      for (final e in d.entries)
        if (body || e.key != 'markdown') e.key: e.value,
      'my_role': role,
      'can_edit': r >= 3,
      'starred': starred[uid]?.contains(d['doc_id']) ?? false,
      'last_viewed_at': viewed[uid]?[d['doc_id']],
      'summary': d['markdown'].toString().replaceAll(RegExp(r'[#>*\-\[\]`]'), '').trim().split('\n').where((l) => l.trim().isNotEmpty).skip(1).take(1).join(),
      'permissions': {
        'can_view': r >= 1,
        'can_comment': r >= 2,
        'can_edit': r >= 3,
        'can_manage': r >= 4,
        'can_delete': owner || (isAdmin(uid) && d['wiki_space_id'] == null) || (d['wiki_space_id'] != null && r >= 3),
      },
    };
  }

  Map<String, dynamic> _docOr404(String id) {
    final d = docs[id];
    if (d == null) throw MockFail(404, 'NOT_FOUND', '文档不存在');
    return d;
  }

  void _need(String docId, int rank, [String msg = '没有权限']) {
    final r = _rank[docRole(docId, me())] ?? 0;
    if (r < rank) throw MockFail(403, 'FORBIDDEN', msg);
  }

  // ---------------- 分发 ----------------

  /// 返回 (状态码, JSON)；null 表示不归这里处理。
  (int, Object?)? handle(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body, {List<int>? rawBody}) {
    if (seg.isEmpty) return null;
    switch (seg[0]) {
      case 'docs':
        return _docs(m, seg, q, body);
      case 'folders':
        return _folders(m, seg, q, body);
      case 'wiki':
        return _wiki(m, seg, q, body);
      case 'search':
        return _search(q);
      case 'files':
        return _files(m, seg, body);
      case 'mock-upload':
        files[seg[1]] = Uint8List.fromList(rawBody ?? const []);
        return (200, {});
    }
    return null;
  }

  (int, Object?) _files(String m, List<String> seg, Map<String, dynamic> body) {
    if (seg.length == 2 && seg[1] == 'upload-url') {
      final key = _id('file');
      fileNames[key] = body['file_name']?.toString() ?? 'file';
      return (200, {'file_key': key, 'upload_url': '/api/v1/mock-upload/$key', 'expires_in': 600});
    }
    if (seg.length == 3 && seg[2] == 'download-url') {
      final b = files[seg[1]];
      final name = fileNames[seg[1]] ?? '';
      final mime = name.toLowerCase().endsWith('.png') ? 'image/png' : (name.toLowerCase().endsWith('.jpg') || name.toLowerCase().endsWith('.jpeg')) ? 'image/jpeg' : 'application/octet-stream';
      return (200, {'download_url': 'data:$mime;base64,${base64Encode(b ?? const [])}', 'file_name': name});
    }
    return (200, {'items': [], 'has_more': false});
  }

  // ---- 文档 ----

  (int, Object?) _docs(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    final uid = me();
    if (seg.length == 1 && m == 'GET') {
      final scope = q['scope'] ?? 'all';
      final kw = (q['keyword'] ?? '').toLowerCase();
      final list = <Map<String, dynamic>>[];
      for (final d in docs.values) {
        if (d['wiki_space_id'] != null) continue;
        final id = d['doc_id'] as String;
        final role = docRole(id, uid);
        if (role == null) continue;
        final trashed = d['deleted_at'] != null;
        if (scope == 'trash') {
          if (!trashed || d['owner_id'] != uid) continue;
        } else if (trashed) {
          continue;
        }
        final ok = switch (scope) {
          'mine' => d['owner_id'] == uid && (q.containsKey('folder_id') ? d['folder_id'] == q['folder_id'] : (q['all'] == 'true' || d['folder_id'] == null)),
          'shared' => d['owner_id'] != uid,
          'starred' => starred[uid]?.contains(id) ?? false,
          'recent' => viewed[uid]?.containsKey(id) ?? false,
          _ => true,
        };
        if (!ok) continue;
        if (kw.isNotEmpty && !d['title'].toString().toLowerCase().contains(kw)) continue;
        list.add(_publicDoc(d, body: false));
      }
      String k(Map<String, dynamic> d) => (scope == 'recent' ? d['last_viewed_at'] : scope == 'trash' ? d['deleted_at'] : d['updated_at'])?.toString() ?? '';
      list.sort((a, b) => k(b).compareTo(k(a)));
      return (200, {'items': list, 'has_more': false});
    }
    if (seg.length == 1 && m == 'POST') {
      final id = _id('doc');
      _doc(id, body['title']?.toString() ?? '未命名文档', uid, body['markdown']?.toString() ?? '', folder: body['folder_id']?.toString());
      return (201, _publicDoc(docs[id]!));
    }
    final id = seg[1];
    final d = _docOr404(id);
    if (seg.length == 2) {
      switch (m) {
        case 'GET':
          if (docRole(id, uid) == null) throw MockFail(403, 'FORBIDDEN', '没有权限访问这篇文档');
          (viewed[uid] ??= {})[id] = _now();
          return (200, _publicDoc(d));
        case 'PATCH':
          if (body.containsKey('folder_id')) {
            if (d['owner_id'] != uid) throw MockFail(403, 'FORBIDDEN', '只有所有者可以移动文档');
            d['folder_id'] = body['folder_id'];
          }
          if (body.containsKey('title') || body.containsKey('markdown')) {
            _need(id, 3, '你只能阅读这篇文档');
            final base = body['base_updated_at'];
            if (base != null && base != d['updated_at']) {
              throw MockFail(409, 'DOC_CONFLICT', '文档已被别人修改');
            }
            final old = d['markdown'].toString();
            if (body['title'] != null) d['title'] = body['title'];
            if (body['markdown'] != null) d['markdown'] = body['markdown'];
            d['updated_at'] = _now();
            d['updated_by'] = uid;
            final node = d['wiki_node_id'];
            if (node != null && nodes[node] != null) {
              nodes[node]!['title'] = d['title'];
              nodes[node]!['updated_at'] = d['updated_at'];
              emit({'event_type': 'wiki.node_changed', 'space_id': d['wiki_space_id'], 'node_id': node, 'parent_id': nodes[node]!['parent_id'], 'action': 'updated'});
            }
            if (old != d['markdown']) _autoVersion(id, old, d['markdown'].toString());
          }
          return (200, _publicDoc(d));
        case 'DELETE':
          if (q['permanent'] == 'true') {
            if (d['owner_id'] != uid) throw MockFail(403, 'FORBIDDEN', '只有所有者可以彻底删除');
            docs.remove(id);
            return (204, null);
          }
          final pd = _publicDoc(d)['permissions'] as Map;
          if (pd['can_delete'] != true) throw MockFail(403, 'FORBIDDEN', '只有所有者可以删除文档');
          d['deleted_at'] = _now();
          return (204, null);
      }
    }
    switch (seg[2]) {
      case 'star':
        (starred[uid] ??= {});
        m == 'POST' ? starred[uid]!.add(id) : starred[uid]!.remove(id);
        return (204, null);
      case 'restore':
        d['deleted_at'] = null;
        return (204, null);
      case 'permissions':
        if (m == 'GET') {
          _need(id, 1);
          final sp = d['wiki_space_id'] as String?;
          return (200, {
            ...perms[id]!,
            if (sp != null) 'inherited_from': {'space_id': sp, 'name': spaces[sp]?['name']},
          });
        }
        _need(id, 4, '只有可管理的人能修改分享设置');
        final before = {for (final x in (perms[id]!['members'] as List)) x['member_id']: x['role']};
        perms[id]!['link_share'] = body['link_share'] ?? perms[id]!['link_share'];
        perms[id]!['members'] = [
          for (final x in (body['members'] as List? ?? const []))
            if ((x as Map)['member_id'] != perms[id]!['owner_id']) x.cast<String, dynamic>(),
        ];
        final after = {for (final x in (perms[id]!['members'] as List)) x['member_id']: x['role']};
        final affected = {...before.keys, ...after.keys}.where((k) => before[k] != after[k]).toList();
        if (affected.isNotEmpty) emit({'event_type': 'doc.permission_changed', 'doc_id': id, 'user_ids': affected});
        return (200, perms[id]);
      case 'transfer':
        if (d['owner_id'] != uid) throw MockFail(403, 'FORBIDDEN', '只有所有者可以转移');
        final to = body['owner_id'].toString();
        final p = perms[id]!;
        p['members'] = [
          for (final x in (p['members'] as List)) if (x['member_id'] != to) x,
          {'member_type': 'user', 'member_id': uid, 'role': 'manager'},
        ];
        p['owner_id'] = to;
        d['owner_id'] = to;
        return (204, null);
      case 'access-requests':
        if (seg.length == 3) {
          final r = {'request_id': _id('req'), 'doc_id': id, 'user_id': uid, 'role': body['role'] ?? 'editor', 'note': body['note'] ?? '', 'status': 'pending'};
          accessRequests.add(r);
          return (201, r);
        }
        final r = accessRequests.firstWhere((x) => x['request_id'] == seg[3], orElse: () => throw MockFail(404, 'NOT_FOUND', '申请不存在'));
        _need(id, 4);
        if (r['status'] != 'pending') throw MockFail(409, 'REQUEST_HANDLED', '这个申请已经处理过了');
        r['status'] = seg[4] == 'approve' ? 'approved' : 'rejected';
        if (r['status'] == 'approved') {
          (perms[id]!['members'] as List).add({'member_type': 'user', 'member_id': r['user_id'], 'role': r['role']});
          emit({'event_type': 'doc.permission_changed', 'doc_id': id, 'user_ids': [r['user_id']]});
        }
        return (200, r);
      case 'comments':
        return _comments(m, seg, q, body, id);
      case 'versions':
        _need(id, 1);
        final vs = versions[id] ?? [];
        if (seg.length == 3) {
          return (200, {
            'items': [for (final v in vs.reversed) {for (final e in v.entries) if (e.key != 'markdown') e.key: e.value}],
            'has_more': false,
          });
        }
        final v = vs.firstWhere((x) => x['version_id'] == seg[3], orElse: () => throw MockFail(404, 'NOT_FOUND', '版本不存在'));
        if (seg.length == 5 && seg[4] == 'restore') {
          _need(id, 3);
          final old = d['markdown'].toString();
          d['markdown'] = v['markdown'];
          d['updated_at'] = _now();
          d['updated_by'] = uid;
          vs.add(_ver(uid, _now(), v['markdown'].toString(), _lines(v['markdown'].toString(), old), _lines(old, v['markdown'].toString()),
              name: '还原自 ${v['name'] ?? (v['created_at'] as String).substring(0, 16).replaceFirst('T', ' ')}'));
          return (200, _publicDoc(d));
        }
        if (m == 'PATCH') {
          v['name'] = body['name'];
          return (200, v);
        }
        return (200, v);
    }
    throw MockFail(404, 'NOT_FOUND', '接口不存在');
  }

  int _lines(String a, String b) {
    final bl = b.split('\n').toSet();
    return a.split('\n').where((l) => !bl.contains(l)).fold(0, (s, l) => s + l.length);
  }

  void _autoVersion(String id, String old, String now) {
    final vs = versions[id] ??= [];
    final last = vs.isEmpty ? null : DateTime.tryParse(vs.last['created_at'].toString());
    final add = _lines(now, old), rm = _lines(old, now);
    if (last != null && DateTime.now().toUtc().difference(last).inSeconds < 120 && vs.last['created_by'] == me() && vs.last['name'] == null) {
      vs.last['markdown'] = now;
      vs.last['created_at'] = _now();
      vs.last['added'] = (vs.last['added'] as int) + add;
      vs.last['removed'] = (vs.last['removed'] as int) + rm;
    } else {
      vs.add(_ver(me(), _now(), now, add, rm));
    }
  }

  (int, Object?) _comments(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body, String docId) {
    final list = comments[docId] ??= [];
    final uid = me();
    void changed(String cid, String action) =>
        emit({'event_type': 'doc.comment_changed', 'doc_id': docId, 'comment_id': cid, 'action': action});
    if (seg.length == 3) {
      if (m == 'GET') {
        _need(docId, 1);
        final solved = q['solved'];
        return (200, {
          'items': [for (final c in list) if (solved == null || '${c['solved']}' == solved) c],
          'has_more': false,
        });
      }
      _need(docId, 2, '你没有评论权限');
      final c = {
        'comment_id': _id('cmt'), 'doc_id': docId, 'quote': body['quote'], 'anchor': body['anchor'] ?? {},
        'is_whole': body['is_whole'] == true, 'solved': false, 'created_by': uid, 'created_at': _now(),
        'replies': [
          {'reply_id': _id('rpl'), 'user_id': uid, 'content': body['content'], 'created_at': _now()},
        ],
      };
      list.add(c);
      changed(c['comment_id'] as String, 'created');
      return (201, c);
    }
    final c = list.firstWhere((x) => x['comment_id'] == seg[3], orElse: () => throw MockFail(404, 'NOT_FOUND', '评论不存在'));
    final replies = c['replies'] as List;
    if (seg.length == 4 && m == 'PATCH') {
      _need(docId, 2);
      c['solved'] = body['solved'] == true;
      changed(c['comment_id'] as String, c['solved'] == true ? 'solved' : 'reopened');
      return (200, c);
    }
    if (seg.length == 5 && m == 'POST') {
      _need(docId, 2, '你没有评论权限');
      final r = {'reply_id': _id('rpl'), 'user_id': uid, 'content': body['content'], 'created_at': _now()};
      replies.add(r);
      changed(c['comment_id'] as String, 'replied');
      return (201, r);
    }
    final r = replies.firstWhere((x) => x['reply_id'] == seg[5], orElse: () => throw MockFail(404, 'NOT_FOUND', '回复不存在'));
    if (r['user_id'] != uid) throw MockFail(403, 'FORBIDDEN', '只能修改或删除自己的回复');
    if (m == 'DELETE') {
      replies.remove(r);
      if (replies.isEmpty) list.remove(c);
      changed(c['comment_id'] as String, 'deleted');
      return (204, null);
    }
    r['content'] = body['content'];
    r['updated_at'] = _now();
    changed(c['comment_id'] as String, 'updated');
    return (200, r);
  }

  // ---- 文件夹 ----

  (int, Object?) _folders(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    final uid = me();
    if (seg.length == 1 && m == 'GET') {
      final parent = q['parent_id'];
      return (200, {
        'items': [for (final f in folders.values) if (f['owner_id'] == uid && f['parent_id'] == parent) f]
          ..sort((a, b) => a['name'].toString().compareTo(b['name'].toString())),
        'has_more': false,
      });
    }
    if (seg.length == 1 && m == 'POST') {
      final name = body['name']?.toString().trim() ?? '';
      if (name.isEmpty) throw MockFail(422, 'VALIDATION_FAILED', '文件夹名称不能为空');
      final f = {'folder_id': _id('fld'), 'name': name, 'parent_id': body['parent_id'], 'owner_id': uid, 'updated_at': _now()};
      folders[f['folder_id'] as String] = f;
      return (201, f);
    }
    final f = folders[seg[1]] ?? (throw MockFail(404, 'NOT_FOUND', '文件夹不存在'));
    if (m == 'DELETE') {
      void drop(String id) {
        for (final c in folders.values.where((x) => x['parent_id'] == id).toList()) {
          drop(c['folder_id'] as String);
        }
        for (final d in docs.values.where((x) => x['folder_id'] == id)) {
          d['deleted_at'] = _now();
          d['folder_id'] = null;
        }
        folders.remove(id);
      }

      drop(seg[1]);
      return (204, null);
    }
    if (body.containsKey('name')) f['name'] = body['name'];
    if (body.containsKey('parent_id')) {
      // 不能移到自己的子孙里
      String? p = body['parent_id']?.toString();
      while (p != null) {
        if (p == f['folder_id']) throw MockFail(422, 'VALIDATION_FAILED', '不能移动到自己的子文件夹里');
        p = folders[p]?['parent_id']?.toString();
      }
      f['parent_id'] = body['parent_id'];
    }
    f['updated_at'] = _now();
    return (200, f);
  }

  // ---- 知识库 ----

  Map<String, dynamic> _publicSpace(Map<String, dynamic> s) => {
        ...s,
        'my_role': spaceRole(s['space_id'] as String, me()),
        'page_count': nodes.values.where((n) => n['space_id'] == s['space_id'] && n['deleted'] != true).length,
      };

  Map<String, dynamic> _publicNode(Map<String, dynamic> n) => {
        for (final e in n.entries) if (e.key != 'deleted') e.key: e.value,
        'has_children': nodes.values.any((c) => c['parent_id'] == n['node_id'] && c['deleted'] != true),
        'starred': nodeStars[me()]?.contains(n['node_id']) ?? false,
        'space_name': spaces[n['space_id']]?['name'],
      };

  void _needSpace(String spaceId, String need) {
    final r = spaceRole(spaceId, me());
    const rank = {'viewer': 1, 'editor': 2, 'admin': 3};
    if ((rank[r] ?? 0) < rank[need]!) {
      throw MockFail(403, 'FORBIDDEN', need == 'viewer' ? '你没有权限访问这个知识空间' : '你没有这个知识空间的${need == 'admin' ? '管理' : '编辑'}权限');
    }
  }

  void _nodeEvent(Map<String, dynamic> n, String action) => emit({
        'event_type': 'wiki.node_changed',
        'space_id': n['space_id'],
        'node_id': n['node_id'],
        'parent_id': n['parent_id'],
        'action': action,
      });

  List<Map<String, dynamic>> _children(String space, String? parent) => nodes.values
      .where((n) => n['space_id'] == space && n['parent_id'] == parent && n['deleted'] != true)
      .toList()
    ..sort((a, b) => (a['order'] as num).compareTo(b['order'] as num));

  void _place(Map<String, dynamic> n, String space, String? parent, String? after) {
    final sib = _children(space, parent).where((x) => x['node_id'] != n['node_id']).toList();
    final idx = after == null ? 0 : sib.indexWhere((x) => x['node_id'] == after) + 1;
    sib.insert(idx.clamp(0, sib.length), n);
    for (var i = 0; i < sib.length; i++) {
      sib[i]['order'] = (i + 1) * 1024;
    }
    n['space_id'] = space;
    n['parent_id'] = parent;
  }

  (int, Object?) _wiki(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    final uid = me();
    if (seg.length == 2 && (seg[1] == 'recent' || seg[1] == 'starred')) {
      final ids = seg[1] == 'recent' ? (nodeViewed[uid]?.keys.toList() ?? []) : (nodeStars[uid]?.toList() ?? []);
      if (seg[1] == 'recent') ids.sort((a, b) => nodeViewed[uid]![b]!.compareTo(nodeViewed[uid]![a]!));
      return (200, {
        'items': [
          for (final id in ids)
            if (nodes[id] != null && nodes[id]!['deleted'] != true && spaceRole(nodes[id]!['space_id'] as String, uid) != null) _publicNode(nodes[id]!),
        ],
        'has_more': false,
      });
    }
    if (seg[1] == 'spaces') {
      if (seg.length == 2) {
        if (m == 'GET') {
          return (200, {
            'items': [for (final s in spaces.values) if (spaceRole(s['space_id'] as String, uid) != null) _publicSpace(s)],
            'has_more': false,
          });
        }
        final name = body['name']?.toString().trim() ?? '';
        if (name.isEmpty) throw MockFail(422, 'VALIDATION_FAILED', '空间名称不能为空');
        final id = _id('wks');
        _space(id, name, body['description']?.toString() ?? '', body['icon']?.toString() ?? 'book', body['color']?.toString() ?? 'blue',
            body['visibility']?.toString() ?? 'org', {uid: 'admin'});
        return (201, _publicSpace(spaces[id]!));
      }
      final sid = seg[2];
      final s = spaces[sid] ?? (throw MockFail(404, 'NOT_FOUND', '知识空间不存在'));
      if (seg.length == 3) {
        if (m == 'GET') {
          _needSpace(sid, 'viewer');
          return (200, _publicSpace(s));
        }
        _needSpace(sid, 'admin');
        if (m == 'DELETE') {
          spaces.remove(sid);
          for (final n in nodes.values.where((n) => n['space_id'] == sid)) {
            n['deleted'] = true;
          }
          return (204, null);
        }
        for (final k in ['name', 'description', 'icon', 'color', 'visibility']) {
          if (body.containsKey(k)) s[k] = body[k];
        }
        if (body.containsKey('visibility')) spaceMembers[sid]!['visibility'] = body['visibility'];
        s['updated_at'] = _now();
        return (200, _publicSpace(s));
      }
      switch (seg[3]) {
        case 'members':
          if (m == 'GET') {
            _needSpace(sid, 'viewer');
            return (200, spaceMembers[sid]);
          }
          _needSpace(sid, 'admin');
          final members = [for (final x in (body['members'] as List? ?? const [])) (x as Map).cast<String, dynamic>()];
          if (!members.any((x) => x['role'] == 'admin')) throw MockFail(422, 'VALIDATION_FAILED', '至少保留一位管理员');
          spaceMembers[sid] = {'visibility': body['visibility'] ?? s['visibility'], 'members': members};
          s['visibility'] = spaceMembers[sid]!['visibility'];
          return (200, spaceMembers[sid]);
        case 'nodes':
          if (m == 'GET') {
            _needSpace(sid, 'viewer');
            return (200, {'items': [for (final n in _children(sid, q['parent_id'])) _publicNode(n)], 'has_more': false});
          }
          _needSpace(sid, 'editor');
          final title = body['title']?.toString().trim();
          final parent = body['parent_id']?.toString();
          final id = _node(sid, parent, title == null || title.isEmpty ? '未命名页面' : title, '');
          final n = nodes[id]!;
          if (body['after_node_id'] != null) _place(n, sid, parent, body['after_node_id']?.toString());
          _nodeEvent(n, 'created');
          return (201, _publicNode(n));
        case 'import':
          _needSpace(sid, 'editor');
          final d = _docOr404(body['doc_id'].toString());
          final id = _id('wkn');
          final sib = _children(sid, body['parent_id']?.toString());
          nodes[id] = {
            'node_id': id, 'space_id': sid, 'parent_id': body['parent_id'], 'title': d['title'], 'obj_type': 'doc',
            'obj_id': d['doc_id'], 'order': (sib.length + 1) * 1024, 'updated_at': _now(), 'updated_by': uid, 'deleted': false,
          };
          d['wiki_space_id'] = sid;
          d['wiki_node_id'] = id;
          _nodeEvent(nodes[id]!, 'created');
          return (201, _publicNode(nodes[id]!));
      }
    }
    if (seg[1] == 'nodes') {
      final n = nodes[seg[2]];
      if (n == null || n['deleted'] == true) throw MockFail(404, 'NOT_FOUND', '页面不存在');
      final sid = n['space_id'] as String;
      if (seg.length == 3) {
        if (m == 'GET') {
          _needSpace(sid, 'viewer');
          (nodeViewed[uid] ??= {})[n['node_id'] as String] = _now();
          return (200, _publicNode(n));
        }
        _needSpace(sid, 'editor');
        if (m == 'DELETE') {
          void drop(Map<String, dynamic> x) {
            x['deleted'] = true;
            docs[x['obj_id']]?['deleted_at'] = _now();
            for (final c in _children(sid, x['node_id'] as String)) {
              drop(c);
            }
          }

          drop(n);
          _nodeEvent(n, 'deleted');
          return (204, null);
        }
        n['title'] = body['title'] ?? n['title'];
        n['updated_at'] = _now();
        docs[n['obj_id']]?['title'] = n['title'];
        _nodeEvent(n, 'updated');
        return (200, _publicNode(n));
      }
      switch (seg[3]) {
        case 'ancestors':
          final out = <Map<String, dynamic>>[];
          var p = n['parent_id'] as String?;
          while (p != null && nodes[p] != null) {
            out.insert(0, _publicNode(nodes[p]!));
            p = nodes[p]!['parent_id'] as String?;
          }
          return (200, {'items': out, 'has_more': false});
        case 'star':
          (nodeStars[uid] ??= {});
          m == 'POST' ? nodeStars[uid]!.add(n['node_id'] as String) : nodeStars[uid]!.remove(n['node_id']);
          return (204, null);
        case 'move':
          _needSpace(sid, 'editor');
          final toSpace = body['space_id']?.toString() ?? sid;
          _needSpace(toSpace, 'editor');
          final parent = body['parent_id']?.toString();
          var p = parent;
          while (p != null) {
            if (p == n['node_id']) throw MockFail(422, 'VALIDATION_FAILED', '不能移动到自己的子页面下');
            p = nodes[p]?['parent_id']?.toString();
          }
          final oldParent = n['parent_id'];
          _place(n, toSpace, parent, body['after_node_id']?.toString());
          void reSpace(Map<String, dynamic> x) {
            x['space_id'] = toSpace;
            docs[x['obj_id']]?['wiki_space_id'] = toSpace;
            for (final c in nodes.values.where((c) => c['parent_id'] == x['node_id'])) {
              reSpace(c);
            }
          }

          reSpace(n);
          emit({'event_type': 'wiki.node_changed', 'space_id': sid, 'node_id': n['node_id'], 'parent_id': oldParent, 'action': 'moved'});
          if (toSpace != sid) _nodeEvent(n, 'moved');
          return (200, _publicNode(n));
        case 'copy':
          _needSpace(sid, 'editor');
          String copy(Map<String, dynamic> x, String? parent, {String? title}) {
            final src = docs[x['obj_id']];
            final id = _node(sid, parent, title ?? x['title'].toString(), src?['markdown']?.toString() ?? '');
            if (body['with_children'] == true) {
              for (final c in _children(sid, x['node_id'] as String)) {
                copy(c, id);
              }
            }
            return id;
          }

          final id = copy(n, n['parent_id'] as String?, title: body['title']?.toString() ?? '${n['title']} 副本');
          _place(nodes[id]!, sid, n['parent_id'] as String?, n['node_id'] as String);
          _nodeEvent(nodes[id]!, 'created');
          return (201, _publicNode(nodes[id]!));
      }
    }
    throw MockFail(404, 'NOT_FOUND', '接口不存在');
  }

  (int, Object?) _search(Map<String, String> q) {
    final kw = (q['q'] ?? '').trim().toLowerCase();
    final sid = q['space_id'];
    if (kw.isEmpty) return (200, {'items': []});
    final items = <Map<String, dynamic>>[];
    for (final n in nodes.values) {
      if (n['deleted'] == true || (sid != null && n['space_id'] != sid)) continue;
      if (spaceRole(n['space_id'] as String, me()) == null) continue;
      final md = docs[n['obj_id']]?['markdown']?.toString() ?? '';
      final t = n['title'].toString();
      final i = md.toLowerCase().indexOf(kw);
      if (!t.toLowerCase().contains(kw) && i < 0) continue;
      final snippet = i < 0 ? '' : md.substring((i - 20).clamp(0, md.length), (i + kw.length + 30).clamp(0, md.length)).replaceAll('\n', ' ');
      items.add({'type': 'wiki', 'id': n['node_id'], 'node_id': n['node_id'], 'space_id': n['space_id'], 'title': t, 'snippet': snippet});
    }
    return (200, {'items': items});
  }
}
