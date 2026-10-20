/// 可分享网址（R-LG-01）：网址路径 ⇄ 应用内打开目标。
///
/// 约定（Web 端用 hash 路由，例如 https://cos.lab/#/docs/abc，静态托管不用配置重写规则）：
///   /messages[/:chat_id]       /calendar        /tasks[/:task_id]
///   /docs[/:doc_id]            /wiki[/:node_id] /wiki/spaces/:space_id
///   /base[/:table_key][?view=:view_id&record=:record_id]
///   /drive  /contacts  /workbench  /admin  /me
///
/// 与迭代 4 的应用内链接（/app/docs/:id 等，见 message_more.dart）并存：那一套用于消息里的链接卡片，
/// 这里是浏览器地址栏和「复制链接」。两者都能被 [parseAppPath] 识别。
library;

import '../app_state.dart' show AppModule;

class AppLink {
  final AppModule module;

  /// 交给 AppState.openTarget 的目标；只切模块时为 null。
  final Map<String, dynamic>? target;
  const AppLink(this.module, [this.target]);

  @override
  String toString() => 'AppLink($module, $target)';
}

const _moduleBySeg = {
  'messages': AppModule.messages,
  'calendar': AppModule.calendar,
  'docs': AppModule.docs,
  'wiki': AppModule.wiki,
  'base': AppModule.bitable,
  'tasks': AppModule.tasks,
  'drive': AppModule.drive,
  'contacts': AppModule.contacts,
  'workbench': AppModule.workbench,
  'admin': AppModule.admin,
  'me': AppModule.me,
};

String _segOf(AppModule m) => _moduleBySeg.entries.firstWhere((e) => e.value == m).key;

/// 解析路径（可以带查询串，也可以是完整网址的 path 或 hash 部分）。认不出时返回 null。
AppLink? parseAppPath(String raw) {
  var text = raw.trim();
  if (text.isEmpty) return null;
  final hash = text.indexOf('#/');
  if (hash >= 0) text = text.substring(hash + 1);
  final uri = Uri.tryParse(text.startsWith('/') ? text : '/$text');
  if (uri == null) return null;
  var seg = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (seg.isNotEmpty && seg.first == 'app') seg = seg.sublist(1); // 迭代 4 的 /app/... 链接
  if (seg.isEmpty) return null;
  // 迭代 4 的别名
  if (seg.first == 'tables') seg = ['base', ...seg.skip(1)];
  final m = _moduleBySeg[seg.first];
  if (m == null) return null;
  final q = uri.queryParameters;
  final id = seg.length > 1 ? seg[1] : null;
  switch (m) {
    case AppModule.messages:
      return AppLink(m, id == null ? null : {'type': 'chat', 'id': id});
    case AppModule.docs:
      return AppLink(m, id == null ? null : {'type': 'doc', 'id': id});
    case AppModule.tasks:
      return AppLink(m, id == null ? null : {'type': 'task', 'id': id});
    case AppModule.wiki:
      if (id == 'spaces' && seg.length > 2) return AppLink(m, {'type': 'wiki_space', 'id': seg[2]});
      return AppLink(m, id == null ? null : {'type': 'wiki_node', 'id': id});
    case AppModule.bitable:
      if (id == null) return AppLink(m);
      // /base/:key/records/:id（迭代 4 写法）或 ?record=
      final record = seg.length > 3 && seg[2] == 'records' ? seg[3] : q['record'];
      return AppLink(m, {
        'type': record == null ? 'table' : 'record',
        'table_key': id,
        if (record != null) 'id': record,
        if (q['view'] != null && q['view']!.isNotEmpty) 'view_id': q['view'],
      });
    default:
      return AppLink(m);
  }
}

String _e(String s) => Uri.encodeComponent(s);

/// 生成路径（不含域名和 #）。
String appPathFor(AppModule m, [Map<String, dynamic>? target]) {
  final t = target ?? const {};
  final id = t['id']?.toString();
  switch (m) {
    case AppModule.messages:
      return id == null ? '/messages' : '/messages/${_e(id)}';
    case AppModule.docs:
      return id == null ? '/docs' : '/docs/${_e(id)}';
    case AppModule.tasks:
      return id == null ? '/tasks' : '/tasks/${_e(id)}';
    case AppModule.wiki:
      if (t['type'] == 'wiki_space' && id != null) return '/wiki/spaces/${_e(id)}';
      return id == null ? '/wiki' : '/wiki/${_e(id)}';
    case AppModule.bitable:
      final key = (t['table_key'] ?? (t['type'] == 'table' ? id : null))?.toString();
      if (key == null) return '/base';
      final q = <String, String>{
        if (t['view_id'] != null) 'view': t['view_id'].toString(),
        if (t['type'] == 'record' && id != null) 'record': id,
      };
      return '/base/${_e(key)}${q.isEmpty ? '' : '?${Uri(queryParameters: q).query}'}';
    default:
      return '/${_segOf(m)}';
  }
}

/// 完整的分享网址：[webOrigin] 是 Web 端的地址（如 https://cos.lab），由后端 capabilities 的 web_url 或编译参数给出。
String shareUrl(String webOrigin, AppModule m, [Map<String, dynamic>? target]) {
  var o = webOrigin.trim();
  while (o.endsWith('/')) {
    o = o.substring(0, o.length - 1);
  }
  return '$o/#${appPathFor(m, target)}';
}
