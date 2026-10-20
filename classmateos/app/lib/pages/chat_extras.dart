/// 消息模块的附加功能：群设置（改名 / 公告 / 加人 / 移人 / 退群 / 置顶 / 免打扰）、
/// 消息搜索、消息右键菜单（回复 / 复制 / 编辑 / 撤回）。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'message_extras.dart';
import '../api/phase2_im.dart';
import 'message_more.dart';

/// 单行 / 多行文本输入弹窗；取消返回 null。
Future<String?> promptText(
  BuildContext context, {
  required String title,
  String initial = '',
  String hint = '',
  int maxLines = 1,
  String ok = '保存',
  bool allowEmpty = false,
}) {
  final ctrl = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setSt) {
        final valid = allowEmpty || ctrl.text.trim().isNotEmpty;
        void submit() {
          if (valid) Navigator.pop(ctx, ctrl.text.trim());
        }

        return AlertDialog(
          title: Text(title),
          content: SizedBox(
            width: 400,
            child: TextField(
              controller: ctrl,
              autofocus: true,
              minLines: 1,
              maxLines: maxLines,
              decoration: InputDecoration(hintText: hint),
              onChanged: (_) => setSt(() {}),
              onSubmitted: maxLines == 1 ? (_) => submit() : null,
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(onPressed: valid ? submit : null, child: Text(ok)),
          ],
        );
      },
    ),
  );
}

// ---------------- 消息右键菜单 ----------------

/// 消息可执行的操作。
/// 迭代 4 新增：thread（回复话题）、forward（转发）、select（多选）、urgent（加急）。
enum MsgAction { reply, thread, copy, forward, select, favorite, pin, unpin, edit, urgent, recall }

/// 当前用户能对这条消息做哪些操作。
List<MsgAction> messageActions(AppState s, CosMessage m) {
  if (m.recalled || m.msgType == 'system') return const [];
  final mine = m.senderId == s.me.userId;
  final admin = s.me.role == 'admin';
  final age = m.createdAt == null ? Duration.zero : DateTime.now().difference(m.createdAt!.toLocal());
  final canForward = s.feature('message.forward') && m.msgType != 'interactive_card';
  return [
    MsgAction.reply,
    if (s.feature('message.thread') && m.threadRootId == null) MsgAction.thread,
    if (m.msgType == 'text' || m.msgType == 'post') MsgAction.copy,
    if (canForward) MsgAction.forward,
    if (canForward) MsgAction.select,
    if (s.feature('message.favorite')) MsgAction.favorite,
    // Pin 只在群里；当前是否已固定由会话的 pinned_message_ids 判断（后端没给时只显示「固定」）
    if (s.feature('message.pin') && s.chat(m.chatId)?.isGroup == true && m.threadRootId == null)
      (s.chat(m.chatId)!.pinnedMessageIds.contains(m.messageId) ? MsgAction.unpin : MsgAction.pin),
    if (mine && m.msgType == 'text') MsgAction.edit,
    if (mine && s.feature('message.urgent')) MsgAction.urgent,
    if ((mine && age.inSeconds < 120) || admin) MsgAction.recall,
  ];
}

Future<MsgAction?> showMessageMenu(BuildContext context, Offset globalPos, List<MsgAction> actions) {
  if (actions.isEmpty) return Future.value(null);
  final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
  final local = overlay.globalToLocal(globalPos);
  PopupMenuItem<MsgAction> item(MsgAction a, IconData icon, String label, {Color? color}) => PopupMenuItem(
    value: a,
    height: 38,
    child: Row(
      children: [
        Icon(icon, size: 17, color: color ?? Fs.text2),
        const SizedBox(width: 10),
        Text(label, style: TextStyle(fontSize: 14, color: color ?? Fs.text1)),
      ],
    ),
  );
  return showMenu<MsgAction>(
    context: context,
    position: RelativeRect.fromLTRB(local.dx, local.dy, overlay.size.width - local.dx, overlay.size.height - local.dy),
    items: [
      for (final a in actions)
        switch (a) {
          MsgAction.reply => item(a, Icons.format_quote_rounded, '回复'),
          MsgAction.thread => item(a, Icons.forum_outlined, '回复话题'),
          MsgAction.copy => item(a, Icons.copy_rounded, '复制'),
          MsgAction.forward => item(a, Icons.shortcut_rounded, '转发'),
          MsgAction.select => item(a, Icons.checklist_rounded, '多选'),
          MsgAction.favorite => item(a, Icons.star_outline_rounded, '收藏'),
          MsgAction.pin => item(a, Icons.push_pin_outlined, '固定到会话'),
          MsgAction.unpin => item(a, Icons.push_pin_rounded, '取消固定'),
          MsgAction.urgent => item(a, Icons.priority_high_rounded, '加急', color: Fs.red),
          MsgAction.edit => item(a, Icons.edit_outlined, '编辑'),
          MsgAction.recall => item(a, Icons.undo_rounded, '撤回', color: Fs.red),
        },
    ],
  );
}

/// 执行消息操作（回复由调用方处理）。成功时返回更新后的消息。
Future<CosMessage?> runMessageAction(BuildContext context, MsgAction a, CosMessage m) async {
  final s = AppScope.read(context);
  try {
    switch (a) {
      case MsgAction.copy:
        await Clipboard.setData(ClipboardData(text: m.text));
        if (context.mounted) showToast(context, '已复制');
        return null;
      case MsgAction.edit:
        final t = await promptText(context, title: '编辑消息', initial: m.text, maxLines: 6);
        if (t == null || t == m.text) return null;
        return await s.api.editMessage(m.messageId, t);
      case MsgAction.recall:
        final ok = await confirmDialog(context, title: '撤回消息', content: '撤回后所有人都看不到这条消息。', ok: '撤回', danger: true);
        if (!ok) return null;
        return await s.api.recallMessage(m.messageId);
      case MsgAction.forward:
        await showForwardDialog(context, [m], mode: 'single');
        return null;
      case MsgAction.urgent:
        return await showUrgentDialog(context, m);
      case MsgAction.favorite:
        await s.api.favoriteMessage(m.messageId, true);
        if (context.mounted) showToast(context, '已收藏，可以在头像菜单「我的收藏」里查看');
        return null;
      case MsgAction.pin:
      case MsgAction.unpin:
        await s.api.pinMessage(m.chatId, m.messageId, a == MsgAction.pin);
        s.notePinChanged(m.chatId, m.messageId, a == MsgAction.pin);
        if (context.mounted) showToast(context, a == MsgAction.pin ? '已固定到会话顶部' : '已取消固定');
        return null;
      case MsgAction.reply:
      case MsgAction.thread:
      case MsgAction.select:
        return null;
    }
  } catch (e) {
    if (context.mounted) showToast(context, describeError(e), error: true);
    return null;
  }
}

/// 消息的一行摘要（引用、搜索结果、会话列表共用）。
String messagePreview(AppState s, CosMessage m) {
  final c = m.content;
  if (m.recalled) return '${m.senderId == s.me.userId ? '你' : s.userName(m.senderId)}撤回了一条消息';
  return switch (m.msgType) {
    'text' => m.text.replaceAll('\n', ' '),
    'post' => '[富文本] ${c['title'] ?? c['text'] ?? (c['markdown'] ?? '').toString().split('\n').first}',
    'image' => '[图片]',
    'file' => '[文件] ${c['file_name'] ?? ''}',
    'interactive_card' => '[卡片] ${c['question'] ?? c['title'] ?? ''}',
    'merge_forward' => '[聊天记录] ${c['title'] ?? ''}',
    'system' => c['text']?.toString() ?? '[系统消息]',
    _ => '[${m.msgType}]',
  };
}

/// 会话行右键菜单：置顶、免打扰、设置。
Future<void> showChatTileMenu(BuildContext context, CosChat chat, Offset globalPos) async {
  final s = AppScope.read(context);
  final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
  final p = overlay.globalToLocal(globalPos);
  final v = await showMenu<String>(
    context: context,
    position: RelativeRect.fromLTRB(p.dx, p.dy, overlay.size.width - p.dx, overlay.size.height - p.dy),
    items: [
      PopupMenuItem(value: 'pin', height: 38, child: Text(chat.pinned ? '取消置顶' : '置顶')),
      PopupMenuItem(value: 'mute', height: 38, child: Text(chat.muted ? '取消免打扰' : '消息免打扰')),
      if ((s.unread[chat.chatId] ?? 0) > 0) const PopupMenuItem(value: 'read', height: 38, child: Text('标为已读')),
      PopupMenuItem(value: 'settings', height: 38, child: Text(chat.isGroup ? '群设置' : '会话设置')),
    ],
  );
  if (v == null || !context.mounted) return;
  try {
    switch (v) {
      case 'pin':
        await s.api.updateChatSettings(chat.chatId, pinned: !chat.pinned);
        await s.refreshChats();
      case 'mute':
        await s.api.updateChatSettings(chat.chatId, muted: !chat.muted);
        await s.refreshChats();
      case 'read':
        await s.markRead(chat.chatId);
      case 'settings':
        await showChatSettings(context, chat.chatId);
    }
  } catch (e) {
    if (context.mounted) showToast(context, describeError(e), error: true);
  }
}

/// 气泡上方的引用块。
class QuoteBox extends StatelessWidget {
  final CosMessage? quoted;
  final VoidCallback? onClose;
  const QuoteBox({super.key, required this.quoted, this.onClose});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final q = quoted;
    final text = q == null ? '引用的消息不在当前页面' : '${s.userName(q.senderId)}：${messagePreview(s, q)}';
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.fromLTRB(8, 4, 6, 4),
      decoration: const BoxDecoration(
        color: Fs.hover,
        border: Border(left: BorderSide(color: Fs.text3, width: 2)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: Text(
              text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, color: Fs.text2, height: 1.4),
            ),
          ),
          if (onClose != null)
            InkWell(
              onTap: onClose,
              child: const Padding(
                padding: EdgeInsets.all(2),
                child: Icon(Icons.close_rounded, size: 14, color: Fs.text3),
              ),
            ),
        ],
      ),
    );
  }
}

// ---------------- 会话设置 ----------------

/// 群设置 / 单聊设置面板。返回 true 表示已退出群聊。
Future<void> showChatSettings(BuildContext context, String chatId) =>
    showScopedDialog(context, (_) => _ChatSettingsDialog(chatId: chatId));

class _ChatSettingsDialog extends StatefulWidget {
  final String chatId;
  const _ChatSettingsDialog({required this.chatId});
  @override
  State<_ChatSettingsDialog> createState() => _ChatSettingsDialogState();
}

class _ChatSettingsDialogState extends State<_ChatSettingsDialog> {
  bool busy = false;

  Future<void> _run(Future<void> Function() f, {String? ok}) async {
    if (busy) return;
    final s = AppScope.read(context);
    setState(() => busy = true);
    try {
      await f();
      await s.refreshChats();
      if (mounted && ok != null) showToast(context, ok);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final chat = s.chat(widget.chatId);
    if (chat == null) {
      return AlertDialog(
        content: const Text('你已不在这个会话中'),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
      );
    }
    final isGroup = chat.isGroup;
    final isOwner = chat.ownerId == s.me.userId || s.me.role == 'admin';
    final api = s.api;
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440, maxHeight: 640),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 8, 8),
              child: Row(
                children: [
                  Text(isGroup ? '群设置' : '会话设置', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  if (busy) const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close_rounded, size: 20)),
                ],
              ),
            ),
            const Divider(height: 1),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.symmetric(vertical: 8),
                children: [
                  if (isGroup) ...[
                    _row(
                      '群名称',
                      s.chatTitle(chat),
                      onTap: () async {
                        final t = await promptText(context, title: '修改群名称', initial: chat.name ?? '');
                        if (t != null) await _run(() => api.updateChat(chat.chatId, name: t), ok: '群名称已修改');
                      },
                    ),
                    _row(
                      '群公告',
                      (chat.description ?? '').isEmpty ? '未设置' : chat.description!,
                      onTap: () async {
                        final t = await promptText(
                          context,
                          title: '群公告',
                          initial: chat.description ?? '',
                          maxLines: 5,
                          allowEmpty: true,
                          hint: '写点什么让大家知道',
                        );
                        if (t != null) await _run(() => api.updateChat(chat.chatId, description: t), ok: '群公告已更新');
                      },
                    ),
                    _row('群主', chat.ownerId == null ? '—' : s.userName(chat.ownerId!)),
                    const Divider(indent: 20, endIndent: 20),
                  ],
                  SwitchListTile(
                    dense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                    title: const Text('置顶会话', style: TextStyle(fontSize: 14)),
                    value: chat.pinned,
                    onChanged: busy ? null : (v) => _run(() => api.updateChatSettings(chat.chatId, pinned: v)),
                  ),
                  SwitchListTile(
                    dense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                    title: const Text('消息免打扰', style: TextStyle(fontSize: 14)),
                    subtitle: const Text('不计入未读总数', style: TextStyle(fontSize: 12)),
                    value: chat.muted,
                    onChanged: busy ? null : (v) => _run(() => api.updateChatSettings(chat.chatId, muted: v)),
                  ),
                  if (isGroup && s.feature('message.thread'))
                    SwitchListTile(
                      key: const ValueKey('thread-mode'),
                      dense: true,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                      title: const Text('话题模式', style: TextStyle(fontSize: 14)),
                      subtitle: const Text('开启后群里只能以话题形式发言，每条消息都可以展开讨论', style: TextStyle(fontSize: 12)),
                      value: chat.threadMode,
                      // 只有群主和管理员能改，后端仍会校验
                      onChanged: busy || (chat.ownerId != s.me.userId && s.me.role != 'admin')
                          ? null
                          : (v) => _run(() => api.setThreadMode(chat.chatId, v), ok: v ? '已开启话题模式' : '已关闭话题模式'),
                    ),
                  if (isGroup) ...[
                    const Divider(indent: 20, endIndent: 20),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 4, 12, 4),
                      child: Row(
                        children: [
                          Text('群成员 · ${chat.memberIds.length}', style: const TextStyle(fontSize: 13, color: Fs.text2)),
                          const Spacer(),
                          TextButton.icon(
                            onPressed: busy
                                ? null
                                : () async {
                                    final ids = await pickUsers(
                                      context,
                                      users: s.users,
                                      title: '添加群成员',
                                      exclude: chat.memberIds.toSet(),
                                    );
                                    if (ids != null && ids.isNotEmpty) {
                                      await _run(() => api.addMembers(chat.chatId, ids), ok: '已添加 ${ids.length} 人');
                                    }
                                  },
                            icon: const Icon(Icons.person_add_alt_rounded, size: 16),
                            label: const Text('添加'),
                          ),
                        ],
                      ),
                    ),
                    for (final id in chat.memberIds)
                      ListTile(
                        dense: true,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                        leading: FsAvatar(name: s.userName(id), seed: id, size: 32, isBot: id == kBotId),
                        title: Text(
                          s.userName(id) + (id == s.me.userId ? '（我）' : ''),
                          style: const TextStyle(fontSize: 14),
                        ),
                        subtitle: Text(s.user(id)?.department ?? id, style: const TextStyle(fontSize: 12)),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (id == chat.ownerId) const FsTag('群主', color: TagColor.orange),
                            if (id == kBotId) const FsTag('机器人', color: TagColor.blue),
                            if (isOwner && id != s.me.userId && id != chat.ownerId)
                              IconButton(
                                tooltip: '移出群聊',
                                icon: const Icon(Icons.remove_circle_outline_rounded, size: 18, color: Fs.text3),
                                onPressed: busy
                                    ? null
                                    : () async {
                                        final ok = await confirmDialog(
                                          context,
                                          title: '移出群聊',
                                          content: '确定把 ${s.userName(id)} 移出群聊吗？',
                                          ok: '移出',
                                          danger: true,
                                        );
                                        if (ok) await _run(() => api.removeMember(chat.chatId, id), ok: '已移出');
                                      },
                              ),
                          ],
                        ),
                      ),
                    const Divider(indent: 20, endIndent: 20),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                      child: OutlinedButton(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Fs.red,
                          side: const BorderSide(color: Fs.line),
                        ),
                        onPressed: busy
                            ? null
                            : () async {
                                final ok = await confirmDialog(
                                  context,
                                  title: '退出群聊',
                                  content: chat.ownerId == s.me.userId ? '你是群主，退出后群主会转给最早加入的成员。' : '退出后将不再接收这个群的消息。',
                                  ok: '退出',
                                  danger: true,
                                );
                                if (!ok || !context.mounted) return;
                                final nav = Navigator.of(context);
                                await _run(() async {
                                  await api.removeMember(chat.chatId, s.me.userId);
                                  if (s.currentChatId == chat.chatId) s.leaveChat();
                                });
                                nav.pop();
                              },
                        child: const Text('退出群聊'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(String label, String value, {VoidCallback? onTap}) => InkWell(
    onTap: busy ? null : onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 11),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(label, style: const TextStyle(fontSize: 14, color: Fs.text2)),
          ),
          Expanded(
            child: Text(
              value,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 14, color: Fs.text1),
            ),
          ),
          if (onTap != null) const Icon(Icons.chevron_right_rounded, size: 18, color: Fs.text3),
        ],
      ),
    ),
  );
}

// ---------------- 消息搜索 ----------------

/// 搜索消息；[chatId] 为空时搜全部会话。点结果打开对应会话。
Future<void> showMessageSearch(BuildContext context, {String? chatId}) =>
    showScopedDialog(context, (_) => _SearchDialog(chatId: chatId));

class _SearchDialog extends StatefulWidget {
  final String? chatId;
  const _SearchDialog({this.chatId});
  @override
  State<_SearchDialog> createState() => _SearchDialogState();
}

class _SearchDialogState extends State<_SearchDialog> {
  final ctrl = TextEditingController();
  Timer? debounce;
  List<CosMessageHit> hits = [];
  bool loading = false;
  String? error;
  String? token;
  bool more = false;
  int seq = 0;

  @override
  void dispose() {
    debounce?.cancel();
    ctrl.dispose();
    super.dispose();
  }

  void _changed(String _) {
    debounce?.cancel();
    debounce = Timer(const Duration(milliseconds: 350), () => _search());
  }

  Future<void> _search({bool next = false}) async {
    final kw = ctrl.text.trim();
    final my = ++seq;
    if (kw.isEmpty) {
      setState(() {
        hits = [];
        error = null;
        more = false;
      });
      return;
    }
    setState(() => loading = true);
    try {
      final p = await AppScope.read(
        context,
      ).api.searchMessages(kw, chatId: widget.chatId, pageToken: next ? token : null);
      if (!mounted || my != seq) return;
      setState(() {
        hits = next ? [...hits, ...p.items] : p.items;
        token = p.pageToken;
        more = p.hasMore;
        error = null;
      });
    } catch (e) {
      if (mounted && my == seq) setState(() => error = describeError(e));
    } finally {
      if (mounted && my == seq) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final kw = ctrl.text.trim();
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560, maxHeight: 600),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 8, 10),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: ctrl,
                      autofocus: true,
                      onChanged: _changed,
                      onSubmitted: (_) => _search(),
                      decoration: InputDecoration(
                        hintText: widget.chatId == null ? '搜索全部聊天记录' : '搜索本会话的聊天记录',
                        prefixIcon: const Icon(Icons.search_rounded, size: 20),
                        isDense: true,
                      ),
                    ),
                  ),
                  IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close_rounded, size: 20)),
                ],
              ),
            ),
            if (loading) const LinearProgressIndicator(minHeight: 2) else const Divider(height: 2),
            Flexible(
              child: error != null
                  ? Padding(
                      padding: const EdgeInsets.all(32),
                      child: Text(error!, style: const TextStyle(color: Fs.red)),
                    )
                  : hits.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.all(40),
                      child: Text(
                        kw.isEmpty ? '输入关键词开始搜索' : (loading ? '搜索中…' : '没有找到相关消息'),
                        style: const TextStyle(color: Fs.text3),
                      ),
                    )
                  : ListView.separated(
                      shrinkWrap: true,
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      itemCount: hits.length + (more ? 1 : 0),
                      separatorBuilder: (_, _) => const Divider(height: 1, indent: 64),
                      itemBuilder: (_, i) {
                        if (i == hits.length) {
                          return TextButton(
                            onPressed: loading ? null : () => _search(next: true),
                            child: const Text('加载更多'),
                          );
                        }
                        final h = hits[i];
                        final m = h.message;
                        final c = s.chat(m.chatId);
                        return ListTile(
                          leading: FsAvatar(
                            name: s.userName(m.senderId),
                            seed: m.senderId,
                            size: 36,
                            isBot: m.senderId == kBotId,
                          ),
                          title: Row(
                            children: [
                              Flexible(child: Text(s.userName(m.senderId), style: const TextStyle(fontSize: 14))),
                              if (widget.chatId == null && c != null) ...[
                                const SizedBox(width: 6),
                                Flexible(
                                  child: Text(
                                    '· ${s.chatTitle(c)}',
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 12, color: Fs.text3),
                                  ),
                                ),
                              ],
                              const Spacer(),
                              if (m.createdAt != null)
                                Text(
                                  fmtRelative(m.createdAt!.toLocal()),
                                  style: const TextStyle(fontSize: 12, color: Fs.text3),
                                ),
                            ],
                          ),
                          subtitle: _highlight(h.highlight ?? messagePreview(s, m), kw),
                          onTap: c == null
                              ? null
                              : () {
                                  Navigator.pop(context);
                                  s.openChat(m.chatId);
                                },
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  /// 关键词标蓝（后端 highlight 若带 <em> 标签先去掉）。
  Widget _highlight(String raw, String kw) {
    final text = raw.replaceAll(RegExp(r'</?(em|mark|b)>'), '');
    final spans = <TextSpan>[];
    final lower = text.toLowerCase();
    final k = kw.toLowerCase();
    var i = 0;
    while (k.isNotEmpty) {
      final j = lower.indexOf(k, i);
      if (j < 0) break;
      if (j > i) spans.add(TextSpan(text: text.substring(i, j)));
      spans.add(
        TextSpan(
          text: text.substring(j, j + k.length),
          style: const TextStyle(color: Fs.primary, fontWeight: FontWeight.w600),
        ),
      );
      i = j + k.length;
    }
    if (i < text.length) spans.add(TextSpan(text: text.substring(i)));
    return Text.rich(
      TextSpan(
        style: const TextStyle(fontSize: 13, color: Fs.text2),
        children: spans,
      ),
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
    );
  }
}

/// 卡片回答返回 409 时，取后端带回的已有答案。
String? cardConflictAnswer(Object e) {
  if (e is CosApiException && e.statusCode == 409) {
    final a = e.data['answer'] ?? (e.data['data'] is Map ? (e.data['data'] as Map)['answer'] : null);
    if (a is Map) return a['action']?.toString();
    return '';
  }
  return null;
}

extension StringIfEmpty on String {
  /// 为空时用 [other] 代替。
  String ifEmpty(String other) => isEmpty ? other : this;
}
