/// 桌面端多窗口（知识库「在新窗口打开」）：每个子窗口是独立的 Flutter 引擎。
/// 子窗口只拿主窗口当前的 access_token，过期时通过 [_authChannel] 向主窗口要新的，不保存、不轮换 refresh_token。
/// 只在 macOS / Windows 启用（Linux 没有工程，Web 和手机不支持）。
library;

import 'dart:convert';

import 'package:desktop_multi_window/desktop_multi_window.dart';
import 'package:flutter/foundation.dart';

import '../api_client.dart';

bool get multiWindowSupported =>
    !kIsWeb && (defaultTargetPlatform == TargetPlatform.macOS || defaultTargetPlatform == TargetPlatform.windows);

/// 主窗口注册、所有子窗口调用（单向通道）。
const _authChannel = WindowMethodChannel('cos_auth', mode: ChannelMode.unidirectional);

CosApiClient? _mainApi;
String? _mainUserId;
bool _serving = false;

/// 主窗口登录后调用：给子窗口提供当前的 access_token（快过期时先刷新）。换账号后再调用一次即可。
/// 只把令牌给同一个用户的子窗口：主窗口换了账号后，旧子窗口拿不到新账号的令牌。
Future<void> serveAuthToSubWindows(CosApiClient api, String userId) async {
  _mainApi = api;
  _mainUserId = userId;
  if (!multiWindowSupported || _serving) return;
  try {
    await _authChannel.setMethodCallHandler((call) async {
      final a = _mainApi;
      final uid = call.arguments is Map ? (call.arguments as Map)['user_id'] : null;
      if (call.method != 'access_token' || a == null || uid == null || uid != _mainUserId) return null;
      await a.ensureFreshToken();
      return a.accessToken;
    });
    _serving = true;
  } catch (e) {
    debugPrint('multi_window: 注册令牌通道失败：$e');
  }
}

/// 主窗口退出登录时调用：子窗口之后拿不到令牌，接口 401 后显示「已退出登录」。
void stopServingAuth() {
  _mainApi = null;
  _mainUserId = null;
}

/// 打开一个只显示这篇文档的新窗口；失败返回 false（调用方提示用户）。
Future<bool> openDocWindow(CosApiClient api, {required String userId, required String docId, required String title}) async {
  if (!multiWindowSupported || api.accessToken == null) return false;
  try {
    final c = await WindowController.create(WindowConfiguration(
      hiddenAtLaunch: false,
      arguments: jsonEncode({'type': 'doc', 'base_url': api.baseUrl, 'access_token': api.accessToken, 'user_id': userId, 'doc_id': docId, 'title': title}),
    ));
    await c.show();
    return true;
  } catch (e) {
    debugPrint('multi_window: 打开新窗口失败：$e');
    return false;
  }
}

/// 当前引擎是不是子窗口：是就返回启动参数，主窗口或不支持多窗口时返回 null。
Future<Map<String, dynamic>?> subWindowArgs() async {
  if (!multiWindowSupported) return null;
  try {
    final c = await WindowController.fromCurrentEngine();
    if (c.arguments.isEmpty) return null;
    final j = jsonDecode(c.arguments);
    return j is Map && j['type'] == 'doc' ? j.cast<String, dynamic>() : null;
  } catch (_) {
    return null;
  }
}

/// 子窗口：向主窗口借当前的 access_token（带上自己的用户 ID）。
Future<String?> borrowTokenFromMainWindow(String userId) => _authChannel.invokeMethod<String>('access_token', {'user_id': userId});
