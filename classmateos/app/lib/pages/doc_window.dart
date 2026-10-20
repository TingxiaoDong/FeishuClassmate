/// 桌面端子窗口：只显示一篇文档（知识库目录「在新窗口打开」）。
/// 令牌来自主窗口（见 services/multi_window.dart），不连消息推送、不注册推送设备。
library;

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../services/multi_window.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/doc_editor.dart';

class DocWindowApp extends StatelessWidget {
  final Map<String, dynamic> args;
  const DocWindowApp({super.key, required this.args});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: args['title']?.toString() ?? 'ClassmateOS',
        debugShowCheckedModeBanner: false,
        theme: buildFsTheme(),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en', 'US')],
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: DocWindowHome(args: args),
      );
}

class DocWindowHome extends StatefulWidget {
  final Map<String, dynamic> args;

  /// 测试可注入客户端；为 null 时按启动参数新建，并向主窗口借令牌。
  final CosApiClient? api;
  const DocWindowHome({super.key, required this.args, this.api});
  @override
  State<DocWindowHome> createState() => _DocWindowHomeState();
}

class _DocWindowHomeState extends State<DocWindowHome> {
  AppState? state;
  String? error;
  bool signedOut = false;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    state?.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    final a = widget.args;
    final api = widget.api ??
        (CosApiClient(a['base_url'].toString(), accessToken: a['access_token']?.toString())
          ..borrowAccessToken = () => borrowTokenFromMainWindow(a['user_id']?.toString() ?? ''));
    try {
      final me = await api.me();
      final s = AppState(api: api, me: me, onLogout: () {
        if (mounted) setState(() => signedOut = true);
      });
      await s.init(realtime: false);
      if (!mounted) return s.dispose();
      setState(() => state = s);
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = state;
    if (signedOut) {
      return const Scaffold(body: EmptyState(icon: Icons.logout_rounded, title: '主窗口已退出登录', subtitle: '关闭这个窗口，回到主窗口重新登录'));
    }
    if (error != null) {
      return Scaffold(body: EmptyState(icon: Icons.error_outline_rounded, title: '打不开这篇文档', subtitle: error));
    }
    if (s == null) return const Scaffold(body: Center(child: CircularProgressIndicator(strokeWidth: 2)));
    return AppScope(
      state: s,
      child: Scaffold(
        body: SafeArea(
          child: DocEditor(
            docId: widget.args['doc_id'].toString(),
            onDeleted: () => setState(() => error = '这篇文档已被删除'),
          ),
        ),
      ),
    );
  }
}
