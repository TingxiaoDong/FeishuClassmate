/// 消息（IM）：会话列表 + 会话窗口。WebSocket 实时收消息，支持文本 / 图片 /
/// 文件 / 机器人卡片（ask_user_question）/ 表情 / @成员。
library;

import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/agent_sidebar.dart';
import '../widgets/common.dart';
import 'chat_extras.dart';
import 'message_extras.dart';
import 'global_search.dart';
import 'message_more.dart';
import '../api/phase2_im.dart';
import '../widgets/markdown_view.dart';
import 'shell.dart';

class MessagesPage extends StatefulWidget {
  const MessagesPage({super.key});

  @override
  State<MessagesPage> createState() => _MessagesPageState();
}

class _MessagesPageState extends State<MessagesPage> {
  /// 窄屏下已经推入的会话页。
  String? _pushed;

  /// 窄屏：会话页是推入的新页面。点列表、点加急横幅「查看」、点通知、搜索跳转都只调 openChat，
  /// 这里看到 currentChatId 有值、又还没推入，就推入会话页；返回时清掉「正在看」。
  void _open(String id) {
    if (_pushed != null) return;
    _pushed = id;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final s = AppScope.read(context);
      await pushScoped(context, Scaffold(body: SafeArea(child: ChatView(chatId: id, showBack: true))));
      if (s.currentChatId == id) s.leaveChat();
      if (mounted) setState(() => _pushed = null);
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return LayoutBuilder(
      builder: (context, c) {
        final wide = c.maxWidth >= 760;
        if (!wide) {
          final want = s.currentChatId;
          if (want != null && _pushed == null && s.module == AppModule.messages) _open(want);
          return ChatListPane(onOpen: s.openChat);
        }
        final cur = s.currentChatId != null ? s.chat(s.currentChatId!) : null;
        return Row(
          children: [
            SizedBox(width: 300, child: ChatListPane(onOpen: s.openChat)),
            const VerticalDivider(width: 1),
            Expanded(
              child: cur == null
                  ? const BrandPlaceholder(text: '选择一个会话，开始聊天')
                  : ChatView(key: ValueKey(cur.chatId), chatId: cur.chatId),
            ),
          ],
        );
      },
    );
  }
}

// ---------------- 会话列表 ----------------

enum _ChatFilter { all, unread, p2p, group }

class ChatListPane extends StatefulWidget {
  final ValueChanged<String> onOpen;
  const ChatListPane({super.key, required this.onOpen});
  @override
  State<ChatListPane> createState() => _ChatListPaneState();
}

class _ChatListPaneState extends State<ChatListPane> {
  String keyword = '';
  _ChatFilter filter = _ChatFilter.all;

  Future<void> _newGroup() async {
    final s = AppScope.read(context);
    String name = '';
    final ids = await pickUsers(
      context,
      users: s.users,
      title: '发起群聊',
      exclude: {s.me.userId},
      askGroupName: true,
      onGroupName: (v) => name = v,
    );
    if (ids == null || ids.isEmpty) return;
    try {
      await s.createGroup(name.isEmpty ? null : name, ids);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _newP2p() async {
    final s = AppScope.read(context);
    final ids = await pickUsers(context, users: s.users, title: '发起单聊', multiple: false, exclude: {s.me.userId});
    if (ids == null || ids.isEmpty) return;
    try {
      final id = await s.openP2p(ids.first);
      widget.onOpen(id);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    var list = s.visibleChats;
    if (keyword.isNotEmpty) {
      list = list.where((c) => s.chatTitle(c).toLowerCase().contains(keyword.toLowerCase())).toList();
    }
    list = switch (filter) {
      _ChatFilter.all => list,
      _ChatFilter.unread => list.where((c) => (s.unread[c.chatId] ?? 0) > 0).toList(),
      _ChatFilter.p2p => list.where((c) => c.chatType == 'p2p').toList(),
      _ChatFilter.group => list.where((c) => c.chatType == 'group').toList(),
    };
    return Container(
      color: Colors.white,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 10, 8),
            child: Row(
              children: [
                const Text('消息', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                const Spacer(),
                // 全局搜索开放后改用全局搜索（手机端的搜索入口就在这里）
                FsIconButton(
                  icon: Icons.manage_search_rounded,
                  tooltip: s.feature('search') ? '搜索' : '搜索聊天记录',
                  onPressed: () => s.feature('search') ? showGlobalSearch(context) : showMessageSearch(context),
                ),
                FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', onPressed: s.refreshChats),
                PopupMenuButton<String>(
                  tooltip: '新建',
                  position: PopupMenuPosition.under,
                  onSelected: (v) => v == 'group' ? _newGroup() : _newP2p(),
                  itemBuilder: (_) => const [
                    PopupMenuItem(
                      value: 'group',
                      child: Row(
                        children: [Icon(Icons.group_add_outlined, size: 18), SizedBox(width: 10), Text('发起群聊')],
                      ),
                    ),
                    PopupMenuItem(
                      value: 'p2p',
                      child: Row(
                        children: [Icon(Icons.person_add_alt_outlined, size: 18), SizedBox(width: 10), Text('发起单聊')],
                      ),
                    ),
                  ],
                  child: Container(
                    margin: const EdgeInsets.only(left: 4),
                    padding: const EdgeInsets.all(5),
                    decoration: BoxDecoration(color: Fs.hover, borderRadius: BorderRadius.circular(Fs.radius)),
                    child: const Icon(Icons.add_rounded, size: 20, color: Fs.text1),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: FsSearchField(hint: '搜索会话', onChanged: (v) => setState(() => keyword = v.trim())),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
            child: Row(
              children: [
                for (final f in _ChatFilter.values)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: HoverBox(
                      selected: filter == f,
                      selectedColor: Fs.primaryLight,
                      radius: 14,
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      onTap: () => setState(() => filter = f),
                      child: Text(
                        switch (f) {
                          _ChatFilter.all => '全部',
                          _ChatFilter.unread => '未读',
                          _ChatFilter.p2p => '单聊',
                          _ChatFilter.group => '群组',
                        },
                        style: TextStyle(
                          fontSize: 12,
                          color: filter == f ? Fs.primary : Fs.text2,
                          fontWeight: filter == f ? FontWeight.w600 : FontWeight.normal,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            child: list.isEmpty
                ? EmptyState(
                    icon: Icons.forum_outlined,
                    title: keyword.isNotEmpty || filter != _ChatFilter.all ? '没有符合条件的会话' : '还没有会话',
                    subtitle: keyword.isEmpty && filter == _ChatFilter.all ? '点右上角「+」发起单聊或群聊' : null,
                    action: keyword.isEmpty && filter == _ChatFilter.all
                        ? FilledButton.icon(
                            onPressed: _newGroup,
                            icon: const Icon(Icons.group_add_outlined, size: 18),
                            label: const Text('发起群聊'),
                          )
                        : null,
                  )
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    itemCount: list.length,
                    itemBuilder: (_, i) => _ChatTile(
                      chat: list[i],
                      selected: list[i].chatId == s.currentChatId,
                      onTap: () => widget.onOpen(list[i].chatId),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _ChatTile extends StatelessWidget {
  final CosChat chat;
  final bool selected;
  final VoidCallback onTap;
  const _ChatTile({required this.chat, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final last = s.lastMessage[chat.chatId];
    final n = s.unread[chat.chatId] ?? 0;
    final title = s.chatTitle(chat);
    final isBot = s.isBotChat(chat);
    final isGroup = chat.chatType == 'group';
    var preview = last == null ? '' : messagePreview(s, last);
    if (last != null && isGroup && last.senderId != s.me.userId) {
      final obo = last.onBehalfOf;
      preview = obo == null ? '${s.userName(last.senderId)}：$preview' : '${s.userName(last.senderId)}（代${obo.userId == s.me.userId ? '你' : (obo.name.isEmpty ? s.userName(obo.userId) : obo.name)}）：$preview';
    }
    final otherId = chat.memberIds.firstWhere((id) => id != s.me.userId, orElse: () => s.me.userId);
    final urgent = s.chatUrgent(chat.chatId);
    return GestureDetector(
      onSecondaryTapDown: (d) => showChatTileMenu(context, chat, d.globalPosition),
      onLongPressStart: (d) => showChatTileMenu(context, chat, d.globalPosition),
      child: HoverBox(
        selected: selected,
        onTap: onTap,
        radius: 8,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        child: Row(
          children: [
            Badge(
              isLabelVisible: n > 0 || urgent,
              smallSize: 9,
              label: chat.muted && !urgent ? null : Text(urgent ? '急' : (n > 99 ? '99+' : '$n')),
              backgroundColor: chat.muted && !urgent ? Fs.text3 : Fs.red,
              child: FsAvatar(
                name: title,
                seed: isGroup ? chat.chatId : otherId,
                size: 40,
                isBot: isBot,
                isGroup: isGroup,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                        ),
                      ),
                      if (isBot) ...[const SizedBox(width: 6), const FsTag('机器人', color: TagColor.blue, fontSize: 10)],
                      if (isGroup) ...[
                        const SizedBox(width: 4),
                        Text('(${chat.memberIds.length})', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                      ],
                      const Spacer(),
                      Text(fmtRelative(last?.createdAt), style: const TextStyle(fontSize: 11, color: Fs.text3)),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Row(
                    children: [
                      if (urgent) ...[
                        const FsTag('加急', color: TagColor.red, fontSize: 10),
                        const SizedBox(width: 4),
                      ],
                      if (chat.threadUnreadCount > 0 && s.feature('message.thread')) ...[
                        FsTag('话题 ${chat.threadUnreadCount}', color: TagColor.blue, fontSize: 10),
                        const SizedBox(width: 4),
                      ],
                      Expanded(
                        child: Text(
                          preview.isEmpty ? '暂无消息' : preview,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12.5, color: n > 0 ? Fs.text2 : Fs.text3),
                        ),
                      ),
                      if (chat.muted) const Icon(Icons.notifications_off_outlined, size: 13, color: Fs.text3),
                      if (chat.pinned) ...[
                        const SizedBox(width: 3),
                        Transform.rotate(
                          angle: 0.6,
                          child: const Icon(Icons.push_pin_outlined, size: 13, color: Fs.text3),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------- 会话窗口 ----------------

class ChatView extends StatefulWidget {
  final String chatId;
  final bool showBack;
  const ChatView({super.key, required this.chatId, this.showBack = false});
  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final List<CosMessage> messages = [];
  final Set<String> ids = {};
  bool loading = true;
  bool hasMore = false;
  bool loadingOlder = false;
  String? error;
  StreamSubscription<CosEvent>? events;
  StreamSubscription<CosMessage>? sub;
  late final AppState _s = AppScope.read(context);

  // 迭代 4
  CosMessage? threadRoot;
  bool selecting = false;
  final Set<String> selected = {};
  String? highlightId;
  final GlobalKey _highlightKey = GlobalKey();
  Timer? _receiptDebounce, _highlightTimer;

  @override
  void initState() {
    super.initState();
    _load();
    _s.addListener(_checkTarget);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      events = _s.eventStream.listen((e) {
        if (e.eventType == 'resync.required') _load();
        if (e.eventType == 'message.read' && (e.raw['chat_id'] ?? e.read?['chat_id']) == widget.chatId && e.userId != _s.me.userId) {
          _receiptDebounce?.cancel();
          _receiptDebounce = Timer(const Duration(milliseconds: 500), _refreshReceipts);
        }
      });
      sub = _s.messageStream.where((m) => m.chatId == widget.chatId).listen(_add);
    });
  }

  @override
  void dispose() {
    sub?.cancel();
    events?.cancel();
    _receiptDebounce?.cancel();
    _highlightTimer?.cancel();
    _s.removeListener(_checkTarget);
    super.dispose();
  }

  /// 话题回复不出现在主会话流里（同时发到群的除外）。
  bool _inMain(CosMessage m) => m.threadRootId == null || m.alsoSendToChat;

  void _add(CosMessage m) {
    if (!mounted) return;
    if (threadRoot?.messageId == m.messageId) setState(() => threadRoot = m);
    final index = messages.indexWhere((v) => v.messageId == m.messageId);
    if (index >= 0) {
      setState(() => messages[index] = m);
      return;
    }
    if (!_inMain(m)) return;
    setState(() {
      ids.add(m.messageId);
      messages.add(m);
    });
  }

  Future<void> _load() async {
    final s = AppScope.read(context);
    try {
      final list = await s.api.listMessages(widget.chatId, pageSize: 50);
      if (!mounted) return;
      setState(() {
        messages.clear();
        ids.clear();
        for (final m in list.items.reversed) {
          if (_inMain(m) && ids.add(m.messageId)) messages.add(m);
        }
        messages.sort((a, b) => (a.createdAt ?? DateTime(0)).compareTo(b.createdAt ?? DateTime(0)));
        hasMore = list.hasMore;
        loading = false;
        error = null;
      });
      _checkTarget();
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  /// 有人读了消息（message.read 推给会话全员）：重新取最近一页的 read_count，避免前端自己累加时重复计数。
  Future<void> _refreshReceipts() async {
    try {
      final p = await _s.api.listMessages(widget.chatId, pageSize: 50);
      if (!mounted) return;
      final byId = {for (final m in p.items) m.messageId: m};
      setState(() {
        for (var i = 0; i < messages.length; i++) {
          final n = byId[messages[i].messageId];
          if (n != null && messages[i].senderId == _s.me.userId) messages[i] = n;
        }
      });
    } catch (_) {}
  }

  Future<bool> _older() async {
    if (loadingOlder || messages.isEmpty) return false;
    setState(() => loadingOlder = true);
    try {
      final p = await AppScope.read(context).api.listMessages(widget.chatId, beforeMessageId: messages.first.messageId);
      if (!mounted) return false;
      setState(() {
        messages.insertAll(0, p.items.reversed.where((m) => _inMain(m) && ids.add(m.messageId)));
        hasMore = p.hasMore;
      });
      return true;
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
      return false;
    } finally {
      if (mounted) setState(() => loadingOlder = false);
    }
  }

  /// 从全局搜索 / 加急横幅跳过来：{type: message, id: chat_id, message_id}。没加载到就往前翻页（最多 10 页）。
  Future<void> _checkTarget() async {
    final t = _s.pendingTarget;
    if (!mounted || loading || t == null || t['type'] != 'message' || t['id'] != widget.chatId) return;
    final mid = t['message_id']?.toString();
    _s.pendingTarget = null;
    if (mid == null) return;
    // 话题回复（不在主会话里）：定位到话题根消息，并打开话题
    final rootId = t['thread_root_id']?.toString();
    final lookFor = rootId ?? mid;
    var target = _find(lookFor);
    for (var i = 0; target == null && hasMore && i < 10; i++) {
      if (!await _older()) break;
      target = _find(lookFor);
    }
    if (!mounted) return;
    if (target == null) {
      showToast(context, '这条消息太早或已被删除，无法定位');
      return;
    }
    if (rootId != null) _openThread(target);
    final hid = lookFor;
    setState(() => highlightId = hid);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final c = _highlightKey.currentContext;
      if (c != null) Scrollable.ensureVisible(c, alignment: 0.5, duration: const Duration(milliseconds: 300));
    });
    _highlightTimer?.cancel();
    _highlightTimer = Timer(const Duration(seconds: 3), () {
      if (mounted && highlightId == hid) setState(() => highlightId = null);
    });
  }

  CosMessage? replyTo;

  CosMessage? _find(String? id) {
    if (id == null) return null;
    for (final m in messages) {
      if (m.messageId == id) return m;
    }
    return null;
  }

  Future<void> _onAction(MsgAction a, CosMessage m) async {
    switch (a) {
      case MsgAction.reply:
        setState(() => replyTo = m);
        return;
      case MsgAction.thread:
        _openThread(m);
        return;
      case MsgAction.select:
        setState(() {
          selecting = true;
          selected
            ..clear()
            ..add(m.messageId);
        });
        return;
      default:
        final updated = await runMessageAction(context, a, m);
        if (updated != null) _add(updated);
    }
  }

  Future<void> _react(CosMessage m, String emoji, bool add) async {
    try {
      final r = add ? await _s.api.addReaction(m.messageId, emoji) : await _s.api.removeReaction(m.messageId, emoji);
      if (r != null) _add(r);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  void _openThread(CosMessage root) {
    if (MediaQuery.sizeOf(context).width >= 1100) {
      setState(() => threadRoot = root);
      return;
    }
    pushScoped(context, Scaffold(body: SafeArea(child: ThreadView(root: root, showBack: true))));
  }

  Future<void> _forwardSelected(String mode) async {
    final list = messages.where((m) => selected.contains(m.messageId)).toList();
    if (list.isEmpty) return;
    final ok = await showForwardDialog(context, list, mode: mode);
    if (ok && mounted) {
      setState(() {
        selecting = false;
        selected.clear();
      });
    }
  }

  /// 多选收藏：后端没有批量接口，逐条调用（重复收藏不报错）；已撤回和系统消息跳过。
  Future<void> _favoriteSelected() async {
    final list = messages.where((m) => selected.contains(m.messageId)).toList();
    final ok = [for (final m in list) if (!m.recalled && m.msgType != 'system') m];
    final skipped = list.length - ok.length;
    var failed = 0;
    String? err;
    for (final m in ok) {
      try {
        await _s.api.favoriteMessage(m.messageId, true);
      } catch (e) {
        failed++;
        err ??= describeError(e);
      }
    }
    if (!mounted) return;
    final done = ok.length - failed;
    if (failed == 0) {
      setState(() {
        selecting = false;
        selected.clear();
      });
    }
    final extra = [if (skipped > 0) '$skipped 条已撤回或是系统消息，不能收藏', if (failed > 0) '$failed 条失败：$err'].join('；');
    showToast(context, done > 0 ? '已收藏 $done 条${extra.isEmpty ? '' : '（$extra）'}' : (extra.isEmpty ? '没有可收藏的消息' : extra),
        error: done == 0 || failed > 0);
  }

  Widget _selectBar() => Container(
        margin: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: Colors.white, border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(10)),
        child: Row(children: [
          Text('已选 ${selected.length} 条', style: const TextStyle(fontSize: 14)),
          const SizedBox(width: 12),
          // 手机上按钮放不下时可以横向滑动
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              reverse: true,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (_s.feature('message.favorite')) ...[
                  OutlinedButton.icon(
                    key: const ValueKey('select-favorite'),
                    onPressed: selected.isEmpty ? null : _favoriteSelected,
                    icon: const Icon(Icons.star_outline_rounded, size: 16),
                    label: const Text('收藏'),
                  ),
                  const SizedBox(width: 8),
                ],
                OutlinedButton.icon(
                  onPressed: selected.isEmpty ? null : () => _forwardSelected('single'),
                  icon: const Icon(Icons.shortcut_rounded, size: 16),
                  label: const Text('逐条转发'),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: selected.isEmpty ? null : () => _forwardSelected('merge'),
                  icon: const Icon(Icons.library_books_outlined, size: 16),
                  label: const Text('合并转发'),
                ),
                const SizedBox(width: 8),
                TextButton(
                  onPressed: () => setState(() {
                    selecting = false;
                    selected.clear();
                  }),
                  child: const Text('取消'),
                ),
              ]),
            ),
          ),
        ]),
      );

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final chat = s.chat(widget.chatId);
    if (chat == null) return const BrandPlaceholder(text: '会话不存在');
    final title = s.chatTitle(chat);
    final isGroup = chat.chatType == 'group';
    final isBot = s.isBotChat(chat);
    final otherId = chat.memberIds.firstWhere((id) => id != s.me.userId, orElse: () => s.me.userId);
    final main = Container(
      color: Colors.white,
      child: Column(
        children: [
          PaneHeader(
            title: title,
            leading: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (widget.showBack)
                  IconButton(
                    tooltip: '返回',
                    icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18),
                    onPressed: () => Navigator.of(context).maybePop(),
                  ),
                FsAvatar(name: title, seed: isGroup ? chat.chatId : otherId, size: 32, isBot: isBot, isGroup: isGroup),
              ],
            ),
            subtitle: Text(
              isBot
                  ? '机器人 · 实验室智能助理'
                  : isGroup
                  ? '${chat.memberIds.length} 位成员'
                  : [s.user(otherId)?.department, s.user(otherId)?.title]
                        .whereType<String>()
                        .where((e) => e.isNotEmpty)
                        .join(' · ')
                        .ifEmpty(s.user(otherId)?.email ?? otherId),
            ),
            actions: [
              if (chat.muted)
                const Padding(
                  padding: EdgeInsets.only(right: 4),
                  child: Tooltip(
                    message: '已开启免打扰',
                    child: Icon(Icons.notifications_off_outlined, size: 18, color: Fs.text3),
                  ),
                ),
              FsIconButton(
                icon: Icons.search_rounded,
                tooltip: '搜索聊天记录',
                onPressed: () => showMessageSearch(context, chatId: chat.chatId),
              ),
              FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新消息', onPressed: _load),
              FsIconButton(
                icon: isGroup ? Icons.settings_outlined : Icons.more_horiz_rounded,
                tooltip: isGroup ? '群设置' : '会话设置',
                onPressed: () => showChatSettings(context, chat.chatId),
              ),
            ],
          ),
          // R-IM-06：已固定的消息（Pin 列表变化时整条重建）
          if (isGroup && s.feature('message.pin'))
            PinBar(
              key: ValueKey('pins-${chat.chatId}-${chat.pinnedMessageIds.join(',')}'),
              chat: chat,
              onJump: (m) => _s.openTarget({'type': 'message', 'id': chat.chatId, 'message_id': m.messageId}),
            ),
          Expanded(
            child: Container(
              color: Colors.white,
              child: loading
                  ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                  : error != null
                  ? EmptyState(
                      icon: Icons.cloud_off_outlined,
                      title: '消息加载失败',
                      subtitle: error,
                      action: OutlinedButton(onPressed: _load, child: const Text('重试')),
                    )
                  : messages.isEmpty
                  ? EmptyState(
                      icon: Icons.waving_hand_outlined,
                      title: isBot ? '和$kBotName打个招呼吧' : '还没有消息',
                      subtitle: '发送第一条消息开始聊天',
                    )
                  : _list(s, isGroup),
            ),
          ),
          if (isGroup && (chat.description ?? '').isNotEmpty)
            InkWell(
              onTap: () => showChatSettings(context, chat.chatId),
              child: Container(
                margin: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(color: const Color(0xFFFFF7E8), borderRadius: BorderRadius.circular(6)),
                child: Row(
                  children: [
                    const Icon(Icons.campaign_outlined, size: 16, color: Fs.orange),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        '群公告：${chat.description}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: Fs.text2),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (selecting)
            _selectBar()
          else
            _Composer(
              chat: chat,
              onSent: _add,
              replyTo: replyTo,
              onClearReply: () => setState(() => replyTo = null),
              hint: chat.threadMode && s.feature('message.thread') ? '发布新话题' : null,
            ),
        ],
      ),
    );
    final root = threadRoot;
    if (root == null) return main;
    return Row(children: [
      Expanded(child: main),
      const VerticalDivider(width: 1),
      SizedBox(
        width: 400,
        child: ThreadView(key: ValueKey(root.messageId), root: root, onClose: () => setState(() => threadRoot = null)),
      ),
    ]);
  }

  Widget _list(AppState s, bool isGroup) {
    return LayoutBuilder(
      builder: (context, c) {
        final maxBubble = (c.maxWidth * 0.66).clamp(200.0, 560.0);
        return SelectionArea(
          child: ListView.builder(
            reverse: true,
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            itemCount: messages.length + (hasMore ? 1 : 0),
            itemBuilder: (_, ri) {
              if (ri == messages.length) {
                return Center(
                  child: TextButton(
                    onPressed: loadingOlder ? null : () => _older(),
                    child: Text(loadingOlder ? '加载中…' : '加载更早消息'),
                  ),
                );
              }
              final i = messages.length - 1 - ri;
              final m = messages[i];
              final prev = i > 0 ? messages[i - 1] : null;
              final t = m.createdAt?.toLocal();
              final pt = prev?.createdAt?.toLocal();
              final showTime = t != null && (pt == null || t.difference(pt).inMinutes >= 5);
              final compact =
                  !showTime &&
                  prev != null &&
                  prev.senderId == m.senderId &&
                  // AI 代不同的同学发的消息不合并，否则后一条看不到「谁让发的」
                  prev.onBehalfOf?.userId == m.onBehalfOf?.userId &&
                  prev.msgType != 'system' &&
                  t != null &&
                  pt != null &&
                  t.difference(pt).inMinutes < 2;
              return Column(
                children: [
                  if (showTime)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text(fmtMessageTime(t), style: const TextStyle(fontSize: 12, color: Fs.text3)),
                    ),
                  MessageItem(
                    key: m.messageId == highlightId ? _highlightKey : ValueKey(m.messageId),
                    message: m,
                    compact: compact && m.replyToMessageId == null && m.reactions.isEmpty && prev.reactions.isEmpty && prev.thread == null,
                    showName: isGroup || m.senderId == kBotId,
                    maxWidth: maxBubble,
                    quoted: _find(m.replyToMessageId),
                    onAction: _onAction,
                    isGroup: isGroup,
                    onReact: _react,
                    onOpenThread: _openThread,
                    onUpdated: _add,
                    threadMode: s.chat(widget.chatId)?.threadMode == true,
                    selecting: selecting,
                    selected: selected.contains(m.messageId),
                    onSelect: (x) => setState(() => selected.contains(x.messageId) ? selected.remove(x.messageId) : selected.add(x.messageId)),
                    highlighted: m.messageId == highlightId,
                  ),
                ],
              );
            },
          ),
        );
      },
    );
  }
}

// ---------------- 单条消息 ----------------

class MessageItem extends StatelessWidget {
  final CosMessage message;
  final bool compact;
  final bool showName;
  final double maxWidth;
  final CosMessage? quoted;
  final void Function(MsgAction action, CosMessage m)? onAction;

  /// 只读展示（合并转发详情）：所有消息靠左，不显示回执和工具条。
  final bool forceLeft;
  final bool isGroup;

  /// 迭代 4：表情回应、打开话题、消息更新（回执里加急后）。
  final void Function(CosMessage m, String emoji, bool add)? onReact;
  final ValueChanged<CosMessage>? onOpenThread;
  final ValueChanged<CosMessage>? onUpdated;

  /// 话题模式群：根消息下面总显示「回复话题」。
  final bool threadMode;

  /// 多选模式。
  final bool selecting;
  final bool selected;
  final ValueChanged<CosMessage>? onSelect;

  /// 从搜索 / 加急定位过来时高亮。
  final bool highlighted;

  const MessageItem({
    super.key,
    required this.message,
    required this.compact,
    required this.showName,
    required this.maxWidth,
    this.quoted,
    this.onAction,
    this.forceLeft = false,
    this.isGroup = false,
    this.onReact,
    this.onOpenThread,
    this.onUpdated,
    this.threadMode = false,
    this.selecting = false,
    this.selected = false,
    this.onSelect,
    this.highlighted = false,
  });

  Future<void> _menu(BuildContext context, AppState s, Offset pos) async {
    if (onAction == null || selecting) return;
    final a = await showMessageMenu(context, pos, messageActions(s, message));
    if (a != null) onAction!(a, message);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final m = message;
    if (m.recalled) {
      final who = m.senderId == s.me.userId ? '你' : s.userName(m.senderId);
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: Text('$who撤回了一条消息', style: const TextStyle(fontSize: 12, color: Fs.text3)),
        ),
      );
    }
    if (m.msgType == 'system') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(color: Fs.hover, borderRadius: BorderRadius.circular(4)),
            child: Text(m.text, style: const TextStyle(fontSize: 12, color: Fs.text2)),
          ),
        ),
      );
    }
    final mine = !forceLeft && m.senderId == s.me.userId;
    final isBot = m.senderId == kBotId;
    final name = s.userName(m.senderId);
    final avatar = compact ? const SizedBox(width: 36) : FsAvatar(name: name, seed: m.senderId, size: 36, isBot: isBot);
    final interactive = onAction != null && !selecting;
    final canReact = interactive && onReact != null && s.feature('message.reaction') && m.msgType != 'interactive_card';
    final canThread = interactive && onOpenThread != null && s.feature('message.thread') && m.threadRootId == null;
    final canForward = interactive && s.feature('message.forward') && m.msgType != 'interactive_card';
    final from = m.forwardedFrom;
    final body = GestureDetector(
      onSecondaryTapDown: (d) => _menu(context, s, d.globalPosition),
      onLongPressStart: (d) => _menu(context, s, d.globalPosition),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: Column(
          crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (from != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text(
                  '转发自 ${from['chat_name'] ?? ''}${from['sender_id'] == null ? '' : ' · ${s.userName(from['sender_id'].toString())}'}',
                  style: const TextStyle(fontSize: 11, color: Fs.text3),
                ),
              ),
            if (m.replyToMessageId != null) QuoteBox(quoted: quoted),
            _content(context, s, m, mine),
            // R-IM-07：内部链接卡片、外部链接预览
            if (s.feature('message.link_preview') && !m.recalled && (m.msgType == 'text' || m.msgType == 'post'))
              MessageLinkCards(message: m),
            if (m.edited)
              const Padding(
                padding: EdgeInsets.only(top: 2),
                child: Text('已编辑', style: TextStyle(fontSize: 11, color: Fs.text3)),
              ),
            if (onReact != null && s.feature('message.reaction'))
              ReactionChips(message: m, onToggle: (e, add) => onReact!(m, e, add)),
            if (onOpenThread != null && s.feature('message.thread') && m.threadRootId == null)
              ThreadSummary(message: m, alwaysShow: threadMode, onOpen: () => onOpenThread!(m)),
            if (mine && m.urgentUnacked > 0)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text('加急 · ${m.urgentUnacked} 人未确认', style: const TextStyle(fontSize: 11, color: Fs.red)),
              ),
            if (mine && !forceLeft) ReadReceipt(message: m, isGroup: isGroup, onUpdated: onUpdated),
          ],
        ),
      ),
    );
    Widget bar(bool hover) => SizedBox(
          height: 30,
          child: hover && (canReact || canThread || canForward || interactive)
              ? MessageHoverBar(
                  message: m,
                  onReact: canReact ? (e) => onReact!(m, e, !m.reactions.any((r) => r.emoji == e && r.reactedByMe)) : null,
                  onThread: canThread ? () => onOpenThread!(m) : null,
                  onForward: canForward ? () => onAction!(MsgAction.forward, m) : null,
                  onMore: (pos) => _menu(context, s, pos),
                )
              : null,
        );
    Widget row(bool hover) => Row(
          mainAxisAlignment: mine ? MainAxisAlignment.end : MainAxisAlignment.start,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (selecting)
              Padding(
                padding: const EdgeInsets.only(right: 8, top: 6),
                child: Checkbox(
                  key: ValueKey('select-${m.messageId}'),
                  value: selected,
                  onChanged: onSelect == null ? null : (_) => onSelect!(m),
                ),
              ),
            if (selecting && mine) const Spacer(),
            if (!mine) ...[avatar, const SizedBox(width: 10)],
            Flexible(
              child: Column(
                crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                children: [
                  if (!compact && !mine && showName)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(name, style: const TextStyle(fontSize: 12, color: Fs.text2)),
                          if (isBot) ...[
                            const SizedBox(width: 4),
                            const FsTag('机器人', color: TagColor.blue, fontSize: 10),
                          ],
                          if (m.onBehalfOf != null) ...[
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                onBehalfLabel(s, m.onBehalfOf!),
                                key: ValueKey('obo-${m.messageId}'),
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 11, color: Fs.text3),
                              ),
                            ),
                          ],
                          if (m.createdAt != null) ...[
                            const SizedBox(width: 6),
                            Text(fmtHm(m.createdAt!.toLocal()), style: const TextStyle(fontSize: 11, color: Fs.text3)),
                          ],
                        ],
                      ),
                    ),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (mine && interactive) bar(hover),
                      if (mine && interactive) const SizedBox(width: 6),
                      Flexible(
                        child: Tooltip(
                          message: m.createdAt != null ? fmtDateTime(m.createdAt!.toLocal()) : '',
                          waitDuration: const Duration(milliseconds: 800),
                          child: body,
                        ),
                      ),
                      if (!mine && interactive) const SizedBox(width: 6),
                      if (!mine && interactive) bar(hover),
                    ],
                  ),
                ],
              ),
            ),
            if (mine) ...[const SizedBox(width: 10), avatar],
          ],
        );
    final content = interactive ? HoverReveal(builder: (_, hover) => row(hover)) : row(false);
    return AnimatedContainer(
      duration: const Duration(milliseconds: 400),
      decoration: BoxDecoration(
        color: highlighted ? const Color(0xFFFFF4D6) : (selected ? Fs.primaryBg : Colors.transparent),
        borderRadius: BorderRadius.circular(6),
      ),
      padding: EdgeInsets.only(top: compact ? 4 : 12),
      child: selecting && onSelect != null
          ? GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => onSelect!(m), child: content)
          : content,
    );
  }

  Widget _content(BuildContext context, AppState s, CosMessage m, bool mine) {
    switch (m.msgType) {
      case 'text' when !mine && m.content['agent_result'] is Map:
        // M5：机器人回复带结果卡片，建好 / 改过的对象可以直接点开
        return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          _bubble(mine, _LinkText(m.text)),
          AgentResultCard.maybe(m),
        ]);
      case 'text':
        return _bubble(mine, _LinkText(m.text));
      case 'post' when m.content['markdown'] is String:
        // R-IM-07：富文本消息 {markdown}，渲染复用文档的 Markdown 组件
        return _bubble(mine, MarkdownView(m.content['markdown'] as String, fontSize: 14));
      case 'post':
        final title = m.content['title']?.toString();
        final text =
            m.content['text']?.toString() ?? (m.content['content'] is String ? m.content['content'] as String : '');
        return _bubble(
          mine,
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (title != null && title.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                ),
              if (text.isNotEmpty) _LinkText(text),
            ],
          ),
        );
      case 'merge_forward':
        return MergeForwardCard(content: m.content);
      case 'image':
        return ImageMessage(file: CosFileRef.fromJson(m.content));
      case 'file':
        return FileMessage(file: CosFileRef.fromJson(m.content));
      case 'interactive_card':
        return CardMessage(content: m.content);
      default:
        return _bubble(mine, Text('[暂不支持的消息类型：${m.msgType}]', style: const TextStyle(color: Fs.text3)));
    }
  }

  Widget _bubble(bool mine, Widget child) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
    decoration: BoxDecoration(
      color: mine ? Fs.bubbleMine : Fs.bubbleOther,
      borderRadius: BorderRadius.only(
        topLeft: Radius.circular(mine ? 10 : 2),
        topRight: Radius.circular(mine ? 2 : 10),
        bottomLeft: const Radius.circular(10),
        bottomRight: const Radius.circular(10),
      ),
    ),
    child: DefaultTextStyle.merge(
      style: const TextStyle(fontSize: 14, height: 1.55, color: Fs.text1),
      child: child,
    ),
  );
}

/// 文本中的网址可点击。
class _LinkText extends StatelessWidget {
  final String text;
  const _LinkText(this.text);
  static final _url = RegExp(r'https?://[^\s，。）)]+');

  @override
  Widget build(BuildContext context) {
    final spans = <InlineSpan>[];
    var last = 0;
    for (final m in _url.allMatches(text)) {
      if (m.start > last) spans.add(TextSpan(text: text.substring(last, m.start)));
      final url = m.group(0)!;
      spans.add(
        TextSpan(
          text: url,
          style: const TextStyle(color: Fs.primary),
          recognizer: TapGestureRecognizer()..onTap = () => openExternal(context, url),
        ),
      );
      last = m.end;
    }
    if (last < text.length) spans.add(TextSpan(text: text.substring(last)));
    return Text.rich(TextSpan(children: spans));
  }
}

class ImageMessage extends StatelessWidget {
  final CosFileRef file;
  const ImageMessage({super.key, required this.file});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return FutureBuilder<String>(
      future: s.fileUrl(file.fileKey),
      builder: (context, snap) {
        if (snap.hasError) return FileMessage(file: file);
        if (!snap.hasData) {
          return Container(
            width: 200,
            height: 140,
            decoration: BoxDecoration(color: Fs.hover, borderRadius: BorderRadius.circular(8)),
            child: const Center(child: CircularProgressIndicator(strokeWidth: 2)),
          );
        }
        final url = snap.data!;
        return MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: () => showDialog(
              context: context,
              barrierColor: Colors.black87,
              builder: (ctx) => GestureDetector(
                onTap: () => Navigator.pop(ctx),
                child: Stack(
                  children: [
                    Center(child: InteractiveViewer(child: Image.network(url))),
                    Positioned(
                      right: 20,
                      top: 20,
                      child: Row(
                        children: [
                          IconButton(
                            tooltip: '下载',
                            icon: const Icon(Icons.download_rounded, color: Colors.white),
                            onPressed: () => openExternal(context, url),
                          ),
                          IconButton(
                            tooltip: '关闭',
                            icon: const Icon(Icons.close_rounded, color: Colors.white),
                            onPressed: () => Navigator.pop(ctx),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 280, maxHeight: 280, minWidth: 60, minHeight: 60),
                child: Image.network(
                  url,
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => FileMessage(file: file),
                  loadingBuilder: (_, child, p) => p == null
                      ? child
                      : Container(
                          width: 200,
                          height: 140,
                          color: Fs.hover,
                          child: const Center(child: CircularProgressIndicator(strokeWidth: 2)),
                        ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

Future<void> downloadFile(BuildContext context, String fileKey) async {
  final s = AppScope.read(context);
  try {
    final url = await s.api.downloadUrl(fileKey);
    if (context.mounted) await openExternal(context, url);
  } catch (e) {
    if (context.mounted) showToast(context, describeError(e), error: true);
  }
}

class FileMessage extends StatelessWidget {
  final CosFileRef file;
  const FileMessage({super.key, required this.file});

  @override
  Widget build(BuildContext context) => HoverBox(
    onTap: () => downloadFile(context, file.fileKey),
    hoverColor: Fs.bg,
    radius: 8,
    child: Container(
      width: 280,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: Fs.line),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          FileTypeIcon(file.fileName, size: 40),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(file.fileName, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14)),
                const SizedBox(height: 3),
                Text(fmtSize(file.size), style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ],
            ),
          ),
          const Tooltip(
            message: '下载',
            child: Icon(Icons.download_rounded, size: 20, color: Fs.text3),
          ),
        ],
      ),
    ),
  );
}

/// 机器人提问卡片（ask_user_question）：点选项即回答。
class CardMessage extends StatefulWidget {
  final Map<String, dynamic> content;
  const CardMessage({super.key, required this.content});
  @override
  State<CardMessage> createState() => _CardMessageState();
}

class _CardMessageState extends State<CardMessage> {
  String? submitting;
  String? confirmedAnswer;

  Future<void> _answer(AppState s, String cardId, String option) async {
    setState(() => submitting = option);
    try {
      await s.api.answerCard(cardId, option);
      if (mounted) setState(() => confirmedAnswer = option);
    } catch (e) {
      final prev = cardConflictAnswer(e);
      if (prev != null) {
        if (mounted) {
          if (prev.isNotEmpty) setState(() => confirmedAnswer = prev);
          showToast(context, '这张卡片已经回答过了');
        }
        return;
      }
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => submitting = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final cardId = widget.content['card_id']?.toString() ?? '';
    final question = widget.content['question']?.toString() ?? widget.content['title']?.toString() ?? '';
    final options =
        (widget.content['options'] as List?)
            ?.map((e) => e is Map ? (e['label'] ?? e['value'] ?? '').toString() : e.toString())
            .toList() ??
        const <String>[];
    final answer = widget.content['answer'];
    final answered = (answer is Map ? answer['action']?.toString() : null) ?? confirmedAnswer;
    return Container(
      width: 360,
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: Fs.line),
        borderRadius: BorderRadius.circular(10),
        boxShadow: Fs.shadow,
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: const BoxDecoration(gradient: LinearGradient(colors: [Color(0xFFDDE8FF), Color(0xFFF0F4FF)])),
            child: Row(
              children: [
                const Icon(Icons.help_center_rounded, size: 18, color: Fs.primary),
                const SizedBox(width: 6),
                Text(
                  answered != null
                      ? '已回复'
                      : widget.content['expired'] == true
                      ? '已过期'
                      : '需要你的确认',
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Fs.primaryPressed),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
            child: Text(question, style: const TextStyle(fontSize: 14, height: 1.6)),
          ),
          if (options.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(14, 4, 14, 14),
              child: Text('（这张卡片没有可选项）', style: TextStyle(fontSize: 12, color: Fs.text3)),
            )
          else
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [for (final o in options) _optionButton(s, cardId, o, answered)],
              ),
            ),
          if (answered != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              color: Fs.bg,
              child: Row(
                children: [
                  const Icon(Icons.check_circle_rounded, size: 14, color: Fs.green),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text('已选择「$answered」', style: const TextStyle(fontSize: 12, color: Fs.text2)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _optionButton(AppState s, String cardId, String o, String? answered) {
    final chosen = answered == o;
    final disabled = answered != null || submitting != null || widget.content['expired'] == true;
    return SizedBox(
      height: 32,
      child: chosen
          ? FilledButton.icon(
              onPressed: null,
              style: FilledButton.styleFrom(disabledBackgroundColor: Fs.primary, disabledForegroundColor: Colors.white),
              icon: const Icon(Icons.check_rounded, size: 16),
              label: Text(o),
            )
          : OutlinedButton(
              onPressed: disabled ? null : () => _answer(s, cardId, o),
              style: OutlinedButton.styleFrom(
                foregroundColor: Fs.primary,
                side: const BorderSide(color: Fs.primary),
              ),
              child: submitting == o
                  ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(o),
            ),
    );
  }
}

// ---------------- 输入框 ----------------

const _emojis = [
  '😀',
  '😁',
  '😂',
  '🤣',
  '😊',
  '😍',
  '🤔',
  '😎',
  '😭',
  '😅',
  '🙃',
  '😴',
  '👍',
  '👎',
  '👏',
  '🙏',
  '💪',
  '👌',
  '✌️',
  '🤝',
  '🎉',
  '🔥',
  '💯',
  '✅',
  '❌',
  '❓',
  '⭐',
  '❤️',
  '💡',
  '📌',
  '📎',
  '📅',
  '⏰',
  '🚀',
  '☕',
  '🍰',
];

class _Composer extends StatefulWidget {
  final CosChat chat;
  final ValueChanged<CosMessage> onSent;
  final CosMessage? replyTo;
  final VoidCallback? onClearReply;

  /// 迭代 4：输入框提示语（话题模式「发布新话题」）、话题回复的根消息。
  final String? hint;
  final String? threadRootId;
  const _Composer({required this.chat, required this.onSent, this.replyTo, this.onClearReply, this.hint, this.threadRootId});
  @override
  State<_Composer> createState() => _ComposerState();
}

class _ComposerState extends State<_Composer> {
  final ctrl = TextEditingController();
  late final FocusNode focus = FocusNode(onKeyEvent: _onKey);
  final emojiMenu = MenuController();
  bool focused = false;
  bool sending = false;
  String? uploading;
  final Map<String, String> mentions = {};

  /// 话题回复「同时发送到群」。
  bool alsoSend = false;

  @override
  void initState() {
    super.initState();
    focus.addListener(() => setState(() => focused = focus.hasFocus));
    ctrl.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    ctrl.dispose();
    focus.dispose();
    super.dispose();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent) return KeyEventResult.ignored;
    if (e.logicalKey != LogicalKeyboardKey.enter && e.logicalKey != LogicalKeyboardKey.numpadEnter) {
      return KeyEventResult.ignored;
    }
    // 输入法组字中（拼音未上屏）不发送
    if (ctrl.value.composing.isValid && !ctrl.value.composing.isCollapsed) return KeyEventResult.ignored;
    if (HardwareKeyboard.instance.isShiftPressed) return KeyEventResult.ignored;
    _send();
    return KeyEventResult.handled;
  }

  Future<void> _send() async {
    final text = ctrl.text.trim();
    if (text.isEmpty || sending) return;
    final s = AppScope.read(context);
    setState(() => sending = true);
    try {
      // R-IM-07：写了 Markdown 快捷语法（且没有 @ 人）时发成富文本 post {markdown}
      final asPost = s.feature('message.rich_text') && mentions.isEmpty && looksLikeMarkdown(text);
      final m = asPost
          ? await s.api.sendMessage(widget.chat.chatId, 'post', {'markdown': text},
              replyToMessageId: widget.replyTo?.messageId, threadRootId: widget.threadRootId, alsoSendToChat: alsoSend)
          : await s.api.sendText(
        widget.chat.chatId,
        text,
        mentions: mentions.entries
            .where((e) => text.contains('@${e.value}'))
            .map((e) => {'user_id': e.key, 'name': e.value})
            .toList(),
        replyToMessageId: widget.replyTo?.messageId,
        threadRootId: widget.threadRootId,
        alsoSendToChat: alsoSend,
      );
      ctrl.clear();
      mentions.clear();
      widget.onClearReply?.call();
      widget.onSent(m);
      s.addLocalMessage(m);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => sending = false);
      focus.requestFocus();
    }
  }

  Future<void> _sendFile({required bool image}) async {
    final s = AppScope.read(context);
    try {
      setState(() => uploading = image ? '图片' : '文件');
      final f = await s.pickAndUpload(imageOnly: image);
      if (f == null) return;
      final isImg = image || FileTypeIcon.isImage(f.fileName);
      final m = await s.api.sendMessage(widget.chat.chatId, isImg ? 'image' : 'file', f.toJson(),
          threadRootId: widget.threadRootId, alsoSendToChat: alsoSend);
      widget.onSent(m);
      s.addLocalMessage(m);
    } catch (e) {
      if (mounted) showToast(context, '发送失败：${describeError(e)}', error: true);
    } finally {
      if (mounted) setState(() => uploading = null);
    }
  }

  Future<void> _mention() async {
    final s = AppScope.read(context);
    final members = s.users.where((u) => widget.chat.memberIds.contains(u.userId) && u.userId != s.me.userId).toList();
    final ids = await pickUsers(context, users: members, title: '选择要 @ 的人', multiple: false);
    if (ids == null || ids.isEmpty) return;
    mentions[ids.first] = s.userName(ids.first);
    _insert('@${s.userName(ids.first)} ');
  }

  void _insert(String t) {
    final sel = ctrl.selection;
    final text = ctrl.text;
    final start = sel.isValid ? sel.start : text.length;
    final end = sel.isValid ? sel.end : text.length;
    ctrl.value = TextEditingValue(
      text: text.replaceRange(start, end, t),
      selection: TextSelection.collapsed(offset: start + t.length),
    );
    focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final title = s.chatTitle(widget.chat);
    final canSend = ctrl.text.trim().isNotEmpty && !sending;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 16),
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: focused ? Fs.primary : Fs.line),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (uploading != null)
            const ClipRRect(
              borderRadius: BorderRadius.vertical(top: Radius.circular(10)),
              child: LinearProgressIndicator(minHeight: 2),
            ),
          if (widget.replyTo != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
              child: Row(
                children: [
                  const Text('回复 ', style: TextStyle(fontSize: 12, color: Fs.text3)),
                  Expanded(
                    child: QuoteBox(quoted: widget.replyTo, onClose: widget.onClearReply),
                  ),
                ],
              ),
            ),
          TextField(
            controller: ctrl,
            focusNode: focus,
            minLines: 1,
            maxLines: 6,
            keyboardType: TextInputType.multiline,
            style: const TextStyle(fontSize: 14, height: 1.5),
            decoration: InputDecoration(
              hintText: widget.hint ?? (widget.threadRootId != null ? '回复话题' : '发送给 $title'),
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              contentPadding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Row(
              children: [
                MenuAnchor(
                  controller: emojiMenu,
                  style: MenuStyle(
                    backgroundColor: const WidgetStatePropertyAll(Colors.white),
                    shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
                  ),
                  menuChildren: [
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: SizedBox(
                        width: 312,
                        child: Wrap(
                          children: [
                            for (final e in _emojis)
                              InkWell(
                                borderRadius: BorderRadius.circular(6),
                                onTap: () {
                                  emojiMenu.close();
                                  _insert(e);
                                },
                                child: SizedBox(
                                  width: 39,
                                  height: 36,
                                  child: Center(child: Text(e, style: const TextStyle(fontSize: 20))),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ],
                  builder: (_, c, _) => FsIconButton(
                    icon: Icons.sentiment_satisfied_alt_outlined,
                    tooltip: '表情',
                    onPressed: () => c.isOpen ? c.close() : c.open(),
                  ),
                ),
                if (widget.chat.chatType == 'group')
                  FsIconButton(icon: Icons.alternate_email_rounded, tooltip: '@ 成员', onPressed: _mention),
                FsIconButton(
                  icon: Icons.image_outlined,
                  tooltip: '发送图片',
                  onPressed: uploading != null ? null : () => _sendFile(image: true),
                ),
                FsIconButton(
                  icon: Icons.attach_file_rounded,
                  tooltip: '发送文件',
                  onPressed: uploading != null ? null : () => _sendFile(image: false),
                ),
                if (widget.threadRootId != null && widget.chat.isGroup && !widget.chat.threadMode)
                  Padding(
                    padding: const EdgeInsets.only(left: 4),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      SizedBox(
                        width: 28,
                        child: Checkbox(
                          key: const ValueKey('also-send'),
                          value: alsoSend,
                          visualDensity: VisualDensity.compact,
                          onChanged: (v) => setState(() => alsoSend = v ?? false),
                        ),
                      ),
                      const Text('同时发送到群', style: TextStyle(fontSize: 12, color: Fs.text2)),
                    ]),
                  ),
                const Spacer(),
                if (MediaQuery.sizeOf(context).width > 900 && widget.threadRootId == null)
                  Text(
                    uploading != null ? '正在上传$uploading…' : 'Enter 发送，Shift + Enter 换行',
                    style: const TextStyle(fontSize: 12, color: Fs.text3),
                  ),
                const SizedBox(width: 10),
                SizedBox(
                  height: 30,
                  child: FilledButton(
                    onPressed: canSend ? _send : null,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(56, 30),
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      disabledBackgroundColor: Fs.primary.withValues(alpha: 0.35),
                      disabledForegroundColor: Colors.white,
                    ),
                    child: const Icon(Icons.send_rounded, size: 16, semanticLabel: '发送'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}


// ---------------- 话题面板（R-IM-02） ----------------

/// 原消息 + 全部回复 + 底部输入框；宽屏在会话右侧，窄屏全屏。
class ThreadView extends StatefulWidget {
  final CosMessage root;
  final bool showBack;
  final VoidCallback? onClose;
  const ThreadView({super.key, required this.root, this.showBack = false, this.onClose});
  @override
  State<ThreadView> createState() => _ThreadViewState();
}

class _ThreadViewState extends State<ThreadView> {
  late CosMessage root = widget.root;
  List<CosMessage> replies = [];
  bool loading = true;
  String? error;
  bool? followed;
  StreamSubscription<CosMessage>? sub;
  late final AppState _s = AppScope.read(context);

  @override
  void initState() {
    super.initState();
    followed = root.thread?.followed;
    sub = _s.messageStream.where((m) => m.chatId == root.chatId).listen((m) {
      if (!mounted) return;
      if (m.messageId == root.messageId) {
        setState(() => root = m);
      } else if (m.threadRootId == root.messageId) {
        setState(() {
          final i = replies.indexWhere((x) => x.messageId == m.messageId);
          i >= 0 ? replies[i] = m : replies.add(m);
        });
      }
    });
    _load();
  }

  @override
  void dispose() {
    sub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final l = await _s.api.allThreadReplies(root.messageId);
      if (mounted) {
        setState(() {
          replies = l..sort((a, b) => (a.createdAt ?? DateTime(0)).compareTo(b.createdAt ?? DateTime(0)));
          loading = false;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  Future<void> _toggleFollow() async {
    final next = !(followed ?? false);
    try {
      await _s.api.followThread(root.messageId, next);
      if (mounted) {
        setState(() => followed = next);
        showToast(context, next ? '已关注话题，有新回复会提醒你' : '已取消关注');
      }
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _react(CosMessage m, String emoji, bool add) async {
    try {
      final r = add ? await _s.api.addReaction(m.messageId, emoji) : await _s.api.removeReaction(m.messageId, emoji);
      if (r != null && mounted) {
        setState(() {
          if (r.messageId == root.messageId) root = r;
          final i = replies.indexWhere((x) => x.messageId == r.messageId);
          if (i >= 0) replies[i] = r;
        });
      }
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final chat = s.chat(root.chatId);
    return Container(
      color: Colors.white,
      child: Column(children: [
        PaneHeader(
          title: '话题',
          subtitle: Text(chat == null ? '' : s.chatTitle(chat)),
          leading: widget.showBack
              ? IconButton(tooltip: '返回', icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18), onPressed: () => Navigator.of(context).maybePop())
              : null,
          actions: [
            TextButton.icon(
              onPressed: _toggleFollow,
              icon: Icon((followed ?? false) ? Icons.notifications_active_outlined : Icons.notifications_none_rounded, size: 16),
              label: Text((followed ?? false) ? '已关注' : '关注话题'),
            ),
            if (widget.onClose != null) FsIconButton(icon: Icons.close_rounded, tooltip: '关闭话题', onPressed: widget.onClose),
          ],
        ),
        Expanded(
          child: LayoutBuilder(builder: (context, c) {
            final w = (c.maxWidth - 80).clamp(160.0, 520.0);
            return ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 16), children: [
              MessageItem(message: root, compact: false, showName: true, maxWidth: w, forceLeft: true,
                  onReact: _react, onAction: (_, _) {}),
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Row(children: [
                  Text(loading ? '加载回复…' : '${replies.length} 条回复', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                  const SizedBox(width: 8),
                  const Expanded(child: Divider()),
                ]),
              ),
              if (error != null)
                Center(child: TextButton(onPressed: _load, child: Text('加载失败：$error，点击重试')))
              else
                for (final m in replies)
                  MessageItem(
                    key: ValueKey(m.messageId),
                    message: m,
                    compact: false,
                    showName: true,
                    maxWidth: w,
                    forceLeft: true,
                    onReact: _react,
                    onAction: (_, _) {},
                  ),
            ]);
          }),
        ),
        if (chat != null)
          _Composer(
            chat: chat,
            threadRootId: root.messageId,
            onSent: (m) {
              if (!mounted) return;
              setState(() {
                if (!replies.any((x) => x.messageId == m.messageId)) replies.add(m);
              });
            },
          ),
      ]),
    );
  }
}
