/// 全局状态：当前用户、成员目录、会话与未读、WS 实时消息、跨模块导航。
library;

import 'dart:async';
import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api/phase2.dart';
import 'api_client.dart';
import 'models.dart';

/// 导航模块（顺序即左侧导航栏顺序）。
enum AppModule {
  messages('消息'),
  calendar('日历'),
  docs('云文档'),
  wiki('知识库'),
  bitable('多维表格'),
  tasks('任务'),
  drive('云盘'),
  contacts('通讯录'),
  workbench('工作台');

  final String label;
  const AppModule(this.label);
}

const kBotId = 'bot';
const kBotName = '飞书同学';
const kDriveChatName = '我的云盘';

/// 系统推送 token 的来源（APNs / FCM）。接入推送 SDK 后在 main() 里赋值；
/// 为 null 或返回 null 时不注册设备（桌面端、未授权通知时）。
Future<({String platform, String token})?> Function()? pushTokenProvider;

class AppState extends ChangeNotifier {
  final CosApiClient api;
  final CosUser me;
  final VoidCallback onLogout;

  AppState({required this.api, required this.me, required this.onLogout});

  AppModule module = AppModule.messages;

  List<CosUser> users = [];
  final Map<String, CosUser> _userById = {};

  List<CosChat> chats = [];
  final Map<String, CosMessage> lastMessage = {};
  final Map<String, int> unread = {};
  String? currentChatId;

  final _messages = StreamController<CosMessage>.broadcast();
  Stream<CosMessage> get messageStream => _messages.stream;
  final _events = StreamController<CosEvent>.broadcast();
  Stream<CosEvent> get eventStream => _events.stream;
  WebSocketChannel? _ws;
  StreamSubscription? _wsSub;
  Timer? _reconnectTimer;
  Timer? _heartbeat;
  String? _since;
  DateTime _lastFrame = DateTime.now();
  final Set<String> _seen = {};
  bool wsConnected = false;
  bool _disposed = false;
  bool _stopped = false;

  /// 二期功能开关（需求文档 2.1）；拉取失败时只开放一期功能 + 新建表。
  CosCapabilities caps = CosCapabilities.legacyDefaults;
  bool feature(String key) => caps.has(key);

  /// 导航里显示的模块（二期模块按功能开关显示）。
  bool moduleVisible(AppModule m) => switch (m) {
        AppModule.wiki => feature('wiki'),
        _ => true,
      };

  /// 通知中心未读数。
  int notifUnread = 0;

  /// 已订阅的 WS 主题（table:xxx）→ 引用计数；重连后自动重新订阅。
  final Map<String, int> _topics = {};

  /// 通知点击后要打开的位置（各模块读取后清空）。
  Map<String, dynamic>? pendingTarget;

  Future<void> init({bool realtime = true}) async {
    api.onAuthLost = logout;
    try {
      users = await api.listUsers();
      _userById..clear()..addEntries(users.map((u) => MapEntry(u.userId, u)));
    } catch (_) {}
    await Future.wait([refreshChats(), loadCapabilities()]);
    unawaited(refreshNotifUnread());
    unawaited(registerPush());
    if (realtime) _connectWs();
  }

  Future<void> loadCapabilities() async {
    try {
      caps = await api.capabilities();
      _notify();
    } catch (_) {/* 保留上次的开关 */}
  }

  /// 本地调整通知未读数（点开一条 / 全部已读），随后以后端为准。
  void setNotifUnread(int n) {
    notifUnread = n < 0 ? 0 : n;
    _notify();
  }

  Future<void> refreshNotifUnread() async {
    if (!feature('notifications')) return;
    try {
      notifUnread = await api.notificationUnreadCount();
      _notify();
    } catch (_) {}
  }

  // ---------------- 订阅 ----------------

  void subscribe(String topic) {
    final n = (_topics[topic] ?? 0) + 1;
    _topics[topic] = n;
    if (n == 1) _sendWs({'type': 'subscribe', 'topic': topic});
  }

  void unsubscribe(String topic) {
    final n = (_topics[topic] ?? 0) - 1;
    if (n > 0) {
      _topics[topic] = n;
      return;
    }
    _topics.remove(topic);
    _sendWs({'type': 'unsubscribe', 'topic': topic});
  }

  Set<String> get subscribedTopics => _topics.keys.toSet();

  void _sendWs(Map<String, dynamic> frame) {
    if (!wsConnected) return; // 连上后统一补发
    try {
      _ws?.sink.add(jsonEncode(frame));
    } catch (_) {}
  }

  /// 测试数据模式 / 单测：直接注入一条实时事件。
  void injectEvent(CosEvent e) => _handleEvent(e);

  // ---------------- 推送设备 ----------------

  static const _deviceKey = 'cos_push_device_id';

  Future<void> registerPush() async {
    final provider = pushTokenProvider;
    if (provider == null) return;
    try {
      final t = await provider();
      if (t == null) return;
      final d = await api.registerDevice(t.platform, t.token);
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_deviceKey, d.deviceId);
    } catch (_) {/* 下次启动再试 */}
  }

  /// 系统推送 token 变化时调用（重新注册，后端按 token 幂等）。
  Future<void> onPushTokenChanged() => registerPush();

  Future<void> _unregisterPush() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final id = prefs.getString(_deviceKey);
      if (id == null) return;
      await api.unregisterDevice(id).timeout(const Duration(seconds: 5));
      await prefs.remove(_deviceKey);
    } catch (_) {/* 注销失败不阻止退出 */}
  }

  Future<void> _connectWs() async {
    if (_disposed || _stopped) return;
    _reconnectTimer?.cancel();
    try {
      await api.ensureFreshToken();
      if (_disposed || _stopped) return;
      final ch = WebSocketChannel.connect(api.wsUri('/events/ws', query: {if (_since != null) 'since': _since!}));
      _ws = ch;
      _lastFrame = DateTime.now();
      ch.ready.then((_) {
        if (_disposed || _stopped || _ws != ch) return;
        wsConnected = true;
        for (final t in _topics.keys) {
          ch.sink.add(jsonEncode({'type': 'subscribe', 'topic': t}));
        }
        unawaited(loadCapabilities());
        unawaited(refreshNotifUnread());
        _notify();
        _heartbeat?.cancel();
        _heartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
          if (DateTime.now().difference(_lastFrame).inSeconds >= 60) {
            _scheduleReconnect();
          } else {
            ch.sink.add(jsonEncode({'type': 'ping'}));
          }
        });
      }).catchError((_) { if (_ws == ch) _scheduleReconnect(); });
      _wsSub = ch.stream.listen((raw) {
        _lastFrame = DateTime.now();
        try {
          final e = CosEvent.fromJson((jsonDecode(raw as String) as Map).cast<String, dynamic>());
          if (e.eventType == 'ping' || e.eventType == 'pong') return;
          if (e.eventId.isNotEmpty) {
            if (!_seen.add(e.eventId)) return;
            _since = e.eventId;
            if (_seen.length > 2000) _seen.remove(_seen.first);
          }
          _handleEvent(e);
        } catch (_) {}
      }, onDone: () {
        if (_ws != ch) return;
        if (ch.closeCode == 4403) { logout(); return; }
        if (ch.closeCode == 4401) api.expiresAt = DateTime(0);
        _scheduleReconnect();
      }, onError: (_) { if (_ws == ch) _scheduleReconnect(); }, cancelOnError: true);
    } catch (_) { _scheduleReconnect(); }
  }

  void _handleEvent(CosEvent e) {
    if (e.eventType == 'resync.required') {
      _since = null;
      refreshChats();
    } else if (e.eventType == 'message.receive' && e.message != null) {
      _onMessage(e.message!);
    } else if (e.eventType == 'message.updated' && e.message != null) {
      final m = e.message!;
      if (lastMessage[m.chatId]?.messageId == m.messageId) lastMessage[m.chatId] = m;
      _messages.add(m);
      _notify();
    } else if (e.eventType == 'notification.new') {
      notifUnread++;
      _notify();
    } else if (e.eventType == 'notification.read') {
      unawaited(refreshNotifUnread());
    } else if (e.eventType == 'capabilities.changed') {
      unawaited(loadCapabilities());
    } else if (e.eventType == 'message.read' || e.eventType.startsWith('chat.')) {
      if (e.eventType == 'chat.member_removed' && e.userId == me.userId && e.chat?['chat_id'] == currentChatId) currentChatId = null;
      refreshChats();
    }
    _events.add(e);
  }

  void _scheduleReconnect() {
    if (_disposed || _stopped) return;
    wsConnected = false;
    _heartbeat?.cancel();
    _wsSub?.cancel();
    final old = _ws;
    _ws = null;
    old?.sink.close();
    _notify();
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(const Duration(seconds: 3), () async {
      if (_disposed || _stopped) return;
      await refreshChats();
      _connectWs();
    });
  }

  void _onMessage(CosMessage m) {
    lastMessage[m.chatId] = m;
    _messages.add(m);
    if (module == AppModule.messages && currentChatId == m.chatId) markRead(m.chatId);
    refreshChats();
  }

  void addLocalMessage(CosMessage m) {
    lastMessage[m.chatId] = m;
    _messages.add(m);
    refreshChats();
  }

  Future<void> refreshChats() async {
    try {
      final list = await api.listChats();
      if (_disposed || _stopped) return;
      chats = list;
      if (currentChatId != null && !list.any((c) => c.chatId == currentChatId)) currentChatId = null;
      lastMessage..clear()..addEntries(list.where((c) => c.lastMessage != null).map((c) => MapEntry(c.chatId, c.lastMessage!)));
      unread..clear()..addEntries(list.map((c) => MapEntry(c.chatId, c.unreadCount)));
      _sortChats();
      _notify();
    } catch (_) {}
  }

  void _sortChats() {
    chats.sort((a, b) => a.pinned != b.pinned ? (a.pinned ? -1 : 1) : b.activeAt.compareTo(a.activeAt));
  }

  // ---------------- 查询 ----------------

  CosUser? user(String id) => _userById[id];

  String userName(String id) {
    if (id == 'system') return '系统';
    if (id == kBotId) return kBotName;
    if (id == me.userId) return me.name;
    return _userById[id]?.name ?? id;
  }

  bool isDriveChat(CosChat c) =>
      c.isDrive;

  /// 消息列表里显示的会话（隐藏「我的云盘」存储会话）。
  List<CosChat> get visibleChats => chats.where((c) => !isDriveChat(c)).toList();

  bool isBotChat(CosChat c) => c.chatType == 'p2p' && c.memberIds.contains(kBotId);

  String chatTitle(CosChat c) {
    if (c.name != null && c.name!.isNotEmpty) return c.name!;
    final others = c.memberIds.where((id) => id != me.userId).toList();
    if (others.isEmpty) return '仅自己';
    if (c.chatType == 'p2p') return userName(others.first);
    return others.take(3).map(userName).join('、') + (others.length > 3 ? '等' : '');
  }

  CosChat? chat(String id) {
    for (final c in chats) {
      if (c.chatId == id) return c;
    }
    return null;
  }

  int get totalUnread => unread.entries
      .where((e) => chats.any((c) => c.chatId == e.key && !isDriveChat(c) && !c.muted))
      .fold(0, (a, e) => a + e.value);

  // ---------------- 导航 ----------------

  /// 打开通知指向的位置：doc / record / task / calendar / approval …
  void openTarget(Map<String, dynamic> target) {
    final type = target['type']?.toString() ?? '';
    final m = switch (type) {
      'doc' => AppModule.docs,
      'wiki' || 'wiki_node' => feature('wiki') ? AppModule.wiki : AppModule.docs,
      'record' || 'table' => AppModule.bitable,
      'task' => AppModule.tasks,
      'calendar' || 'event' => AppModule.calendar,
      'chat' || 'message' => AppModule.messages,
      _ => null,
    };
    if (m == null) return;
    pendingTarget = target;
    if (m == AppModule.messages && target['id'] != null) {
      openChat(target['id'].toString());
      return;
    }
    go(m);
  }

  void go(AppModule m) {
    module = m;
    if (m == AppModule.messages && currentChatId != null) markRead(currentChatId!);
    _notify();
  }

  void openChat(String chatId) {
    currentChatId = chatId;
    markRead(chatId);
    module = AppModule.messages;
    _notify();
  }

  /// 手机端从会话页返回：不再视为「正在看」，新消息计未读。
  void leaveChat() {
    currentChatId = null;
  }

  Future<void> markRead(String chatId) async {
    try {
      await api.markRead(chatId);
      unread[chatId] = 0;
      chat(chatId)?.unreadCount = 0;
      _notify();
    } catch (_) { /* 保留未读，重连后再同步 */ }
  }

  Future<String> openP2p(String userId) async {
    final c = await api.createChat(chatType: 'p2p', memberIds: [userId]);
    await refreshChats();
    openChat(c.chatId);
    return c.chatId;
  }

  Future<String> createGroup(String? name, List<String> memberIds) async {
    final c = await api.createChat(name: name, memberIds: memberIds);
    chats.insert(0, c);
    openChat(c.chatId);
    return c.chatId;
  }

  /// 「我的云盘」存储会话：只有本人一个成员。
  Future<CosChat> ensureDriveChat() async {
    for (final c in chats) {
      if (isDriveChat(c)) return c;
    }
    final c = await api.createChat(name: kDriveChatName, memberIds: const []);
    chats.add(c);
    _notify();
    return c;
  }

  // ---------------- 文件 ----------------

  /// 弹出系统选文件框并上传；取消返回 null。
  Future<CosFileRef?> pickAndUpload({bool imageOnly = false}) async {
    final f = await FilePicker.pickFile(type: imageOnly ? FileType.image : FileType.any);
    if (f == null) return null;
    final bytes = await f.readAsBytes();
    return api.uploadBytes(f.name, bytes);
  }

  final Map<String, String> _urlCache = {};
  final Map<String, DateTime> _urlTime = {};

  /// 下载地址缓存 4 分钟（签名有效期内复用，避免图片反复换签）。
  Future<String> fileUrl(String fileKey) async {
    final t = _urlTime[fileKey];
    if (t != null && DateTime.now().difference(t).inMinutes < 4) return _urlCache[fileKey]!;
    final url = await api.downloadUrl(fileKey);
    _urlCache[fileKey] = url;
    _urlTime[fileKey] = DateTime.now();
    return url;
  }

  // ---------------- 生命周期 ----------------

  void logout() {
    if (_stopped || _disposed) return;
    _stopped = true;
    api.onAuthLost = null;
    // 先注销推送设备（需要有效令牌），再让服务器上的令牌失效
    unawaited(() async {
      await _unregisterPush();
      await api.logout();
    }());
    _heartbeat?.cancel();
    _reconnectTimer?.cancel();
    _wsSub?.cancel();
    _ws?.sink.close();
    onLogout();
    // 等界面卸载（InheritedNotifier 解除监听）后再释放
    WidgetsBinding.instance.addPostFrameCallback((_) => dispose());
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _heartbeat?.cancel();
    _events.close();
    _reconnectTimer?.cancel();
    _wsSub?.cancel();
    _ws?.sink.close();
    _messages.close();
    super.dispose();
  }
}

/// 通过 InheritedNotifier 下发 AppState（不引入额外状态管理依赖）。
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);

  /// 订阅变化。
  static AppState of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;

  /// 只读取不订阅（回调里用）。
  static AppState read(BuildContext context) =>
      context.getInheritedWidgetOfExactType<AppScope>()!.notifier!;

  /// 可能不在 AppScope 里（如单独渲染 Markdown）时用。
  static AppState? maybeOf(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()?.notifier;
}

/// 推入新页面并把 AppState 带过去（路由不在 AppScope 子树里）。
Future<T?> pushScoped<T>(BuildContext context, Widget page) {
  final s = AppScope.read(context);
  return Navigator.of(context).push<T>(
    MaterialPageRoute(builder: (_) => AppScope(state: s, child: page)),
  );
}

/// 弹窗同理：对话框挂在 Navigator 覆盖层上，需要重新包一层 AppScope。
Future<T?> showScopedDialog<T>(BuildContext context, WidgetBuilder builder) {
  final s = AppScope.read(context);
  return showDialog<T>(
    context: context,
    builder: (ctx) => AppScope(state: s, child: Builder(builder: builder)),
  );
}
