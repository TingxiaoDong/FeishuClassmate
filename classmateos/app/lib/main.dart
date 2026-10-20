/// ClassmateOS 四端 App（PLAN §2.1 Flutter 单代码库）。
/// 飞书风格协作客户端：消息 / 日历 / 云文档 / 多维表格 / 任务 / 云盘 / 通讯录 / 工作台。
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'api_client.dart';
import 'app_state.dart';
import 'dev_env.dart';
import 'mock/mock_backend.dart';
import 'models.dart';
import 'pages/doc_window.dart';
import 'pages/login_page.dart';
import 'pages/me_page.dart' show qrScanner;
import 'pages/qr_scanner_page.dart';
import 'pages/required_password_page.dart';
import 'pages/shell.dart';
import 'services/multi_window.dart';
import 'services/token_store.dart';
import 'services/web_url.dart';
import 'theme.dart';

const kBaseUrl = String.fromEnvironment(
  'COS_BASE_URL',
  defaultValue: 'http://127.0.0.1:8080/api/v1',
);

/// 自动化实操 / 无障碍调试：`--dart-define=COS_A11Y=true` 时强制打开语义树，
/// Web 版会生成可被浏览器定位、点击的元素。默认关闭，不影响正常构建。
const kForceSemantics = bool.fromEnvironment('COS_A11Y');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (kForceSemantics) SemanticsBinding.instance.ensureSemantics();
  // 桌面端「在新窗口打开」的子窗口：只显示一篇文档
  final sub = await subWindowArgs();
  if (sub != null) {
    runApp(DocWindowApp(args: sub));
    return;
  }
  // 手机上「扫一扫」用摄像头；电脑和网页版仍粘贴登录码
  if (!kIsWeb && (defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.android)) {
    qrScanner = scanQrWithCamera;
  }
  runApp(const ClassmateApp());
}

class ClassmateApp extends StatefulWidget {
  const ClassmateApp({super.key});
  @override
  State<ClassmateApp> createState() => _ClassmateAppState();
}

class _ClassmateAppState extends State<ClassmateApp> {
  AppState? session;
  CosApiClient? passwordApi;
  CosUser? passwordUser;
  String lastBaseUrl = devEnv('COS_BASE_URL') ?? kBaseUrl;
  String? lastUser;
  bool restoring = true;

  /// Web 端：打开时地址栏里的路径（登录后跳过去，刷新后停在原页面）。
  final String? _initialPath = currentHashPath();

  @override
  void initState() {
    super.initState();
    listenHashChange((p) {
      final s = session;
      if (s != null && p != s.currentPath) s.openPath(p);
    });
    _restore();
  }

  /// 测试数据模式（COS_MOCK=1）：不连真实后端，数据在内存里，不保存登录状态。
  MockBackend? _mock;

  Future<void> _restore() async {
    if (devEnv('COS_MOCK') == '1' || const bool.fromEnvironment('COS_MOCK')) {
      final mock = _mock = MockBackend();
      final api = CosApiClient(kMockBaseUrl, client: mock.client);
      try {
        final me = await api.login(devEnv('COS_DEV_USER') ?? 'admin', 'mock');
        if (mounted) _onLoggedIn(api, me);
        final m = AppModule.values.where((e) => e.name == devEnv('COS_DEV_MODULE')).firstOrNull;
        if (m != null) session?.go(m);
      } finally {
        if (mounted) setState(() => restoring = false);
      }
      return;
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      lastBaseUrl = devEnv('COS_BASE_URL') ?? prefs.getString('cos_server') ?? kBaseUrl;
      final refresh = await TokenStore.instance.read();
      if (refresh != null && devEnv('COS_DEV_USER') == null) {
        final api = CosApiClient(lastBaseUrl);
        api.onSession = (s) => _persist(api, s);
        try {
          final me = await api.resume(refresh);
          if (mounted) _onLoggedIn(api, me);
        } on CosApiException catch (e) {
          if (e.statusCode == 401 || e.statusCode == 403) await TokenStore.instance.clear();
        }
      } else { await _devAutoLogin(); }
    } catch (_) { /* 网络或存储不可用时允许手动登录 */ }
    finally { if (mounted) setState(() => restoring = false); }
  }

  Future<void> _persist(CosApiClient api, CosSession s) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('cos_server', api.baseUrl);
    await TokenStore.instance.write(s.refreshToken);
  }

  /// 开发调试：设置了 COS_DEV_USER / COS_DEV_PASS 时自动登录，COS_DEV_MODULE 指定打开的模块。
  Future<void> _devAutoLogin() async {
    final user = devEnv('COS_DEV_USER');
    final pass = devEnv('COS_DEV_PASS');
    if (user == null || pass == null) return;
    final api = CosApiClient(lastBaseUrl);
    try {
      final me = await api.login(user, pass);
      if (!mounted) return;
      _onLoggedIn(api, me);
      final m = AppModule.values.where((e) => e.name == devEnv('COS_DEV_MODULE')).firstOrNull;
      if (m != null) session?.go(m);
    } catch (_) {/* 自动登录失败就停在登录页 */}
  }

  void _requirePassword(CosApiClient api, CosUser me) {
    final previous = session;
    setState(() { session = null; passwordApi = api; passwordUser = me; });
    WidgetsBinding.instance.addPostFrameCallback((_) => previous?.dispose());
  }

  Future<void> _leavePassword() async {
    final api = passwordApi;
    await api?.logout();
    await TokenStore.instance.clear();
    if (mounted) setState(() { passwordApi = null; passwordUser = null; });
  }

  void _onLoggedIn(CosApiClient api, CosUser me) {
    api.onPasswordChangeRequired = () {
      if (mounted && passwordApi == null) _requirePassword(api, session?.me ?? me);
    };
    if (me.mustChangePassword) {
      api.onSession = (s) => _persist(api, s);
      _persist(api, CosSession(api.accessToken ?? '', api.refreshToken ?? '', api.expiresAt ?? DateTime.now(), me));
      _requirePassword(api, me);
      return;
    }
    passwordApi = null;
    passwordUser = null;

    if (_mock == null) {
      api.onSession = (s) => _persist(api, s);
      _persist(api, CosSession(api.accessToken ?? '', api.refreshToken ?? '', api.expiresAt ?? DateTime.now(), me));
    }
    if (_mock == null) serveAuthToSubWindows(api, me.userId);
    final s = AppState(api: api, me: me, onLogout: () {
      stopServingAuth();
      TokenStore.instance.clear();
      if (mounted) setState(() => session = null);
    });
    final mock = _mock;
    if (mock != null) mock.onEvent = (e) => s.injectEvent(CosEvent.fromJson(e));
    // 功能开关拉到后再按地址栏打开（入口是否可见要看开关）
    s.init(realtime: mock == null).then((_) {
      final p = _initialPath;
      if (p != null && session == s) s.openPath(p);
      s.addListener(() => replaceHashPath(s.currentPath));
    });
    setState(() {
      session = s;
      lastBaseUrl = api.baseUrl;
      lastUser = me.name;
    });
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'ClassmateOS',
        debugShowCheckedModeBanner: false,
        theme: buildFsTheme(),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en', 'US')],
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: restoring ? const Scaffold(body: Center(child: CircularProgressIndicator())) : passwordApi != null
            ? RequiredPasswordPage(
                api: passwordApi!,
                onCompleted: () => _onLoggedIn(passwordApi!, passwordUser!.withoutPasswordChange()),
                onLogout: _leavePassword,
              )
            : session == null
            ? LoginPage(
                key: const ValueKey('login'),
                initialBaseUrl: lastBaseUrl,
                initialUser: lastUser,
                onLoggedIn: _onLoggedIn,
              )
            : AppScope(
                key: ValueKey(session),
                state: session!,
                child: const HomeShell(),
              ),
      );
}
