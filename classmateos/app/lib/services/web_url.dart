/// 浏览器地址栏同步（R-LG-01）：Web 端用 hash 路由（/#/docs/xxx），刷新后停在原页面。
/// 原生端是空实现。
library;

export 'web_url_stub.dart' if (dart.library.js_interop) 'web_url_web.dart';
