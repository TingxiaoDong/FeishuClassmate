import 'package:web/web.dart' as web;

/// 当前的 hash 路径（不含 #），例如 /docs/abc；没有时返回 null。
String? currentHashPath() {
  final h = web.window.location.hash;
  if (h.length < 2) return null;
  return h.substring(1);
}

/// 改地址栏但不新增历史记录（模块内切换太频繁，全部 push 会让「后退」很难用）。
void replaceHashPath(String path) {
  if (currentHashPath() == path) return;
  web.window.history.replaceState(null, '', '#$path');
}

/// 用户手动改地址栏或点了浏览器后退。
void listenHashChange(void Function(String path) onChange) {
  web.EventStreamProviders.hashChangeEvent.forTarget(web.window).listen((_) {
    final p = currentHashPath();
    if (p != null) onChange(p);
  });
}
