/// ClassmateOS 四端 App（PLAN §2.1 Flutter 单代码库）。
/// 飞书风格协作客户端：消息 / 日历 / 云文档 / 多维表格 / 任务 / 云盘 / 通讯录 / 工作台。
library;

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'api_client.dart';
import 'app_state.dart';
import 'dev_env.dart';
import 'mock/mock_backend.dart';
import 'models.dart';
import 'pages/login_page.dart';
import 'pages/shell.dart';
import 'theme.dart';

const kBaseUrl = String.fromEnvironment(
  'COS_BASE_URL',
  defaultValue: 'http://127.0.0.1:8080/api/v1',
);

void main() => runApp(const ClassmateApp());

class ClassmateApp extends StatefulWidget {
  const ClassmateApp({super.key});
  @override
  State<ClassmateApp> createState() => _ClassmateAppState();
}

class _ClassmateAppState extends State<ClassmateApp> {
  AppState? session;
  String lastBaseUrl = devEnv('COS_BASE_URL') ?? kBaseUrl;
  String? lastUser;
  bool restoring = true;

  @override
  void initState() {
    super.initState();
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
      final refresh = prefs.getString('cos_refresh');
      if (refresh != null && devEnv('COS_DEV_USER') == null) {
        final api = CosApiClient(lastBaseUrl);
        api.onSession = (s) => _persist(api, s);
        try {
          final me = await api.resume(refresh);
          if (mounted) _onLoggedIn(api, me);
        } on CosApiException catch (e) {
          if (e.statusCode == 401 || e.statusCode == 403) await prefs.remove('cos_refresh');
        }
      } else { await _devAutoLogin(); }
    } catch (_) { /* 网络或存储不可用时允许手动登录 */ }
    finally { if (mounted) setState(() => restoring = false); }
  }

  Future<void> _persist(CosApiClient api, CosSession s) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('cos_server', api.baseUrl);
    await prefs.setString('cos_refresh', s.refreshToken);
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

  void _onLoggedIn(CosApiClient api, CosUser me) {
    if (_mock == null) {
      api.onSession = (s) => _persist(api, s);
      _persist(api, CosSession(api.accessToken ?? '', api.refreshToken ?? '', api.expiresAt ?? DateTime.now(), me));
    }
    final s = AppState(api: api, me: me, onLogout: () {
      SharedPreferences.getInstance().then((p) => p.remove('cos_refresh'));
      if (mounted) setState(() => session = null);
    });
    final mock = _mock;
    if (mock != null) mock.onEvent = (e) => s.injectEvent(CosEvent.fromJson(e));
    s.init(realtime: mock == null);
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
        home: restoring ? const Scaffold(body: Center(child: CircularProgressIndicator())) : session == null
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
