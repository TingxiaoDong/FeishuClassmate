/// 迭代 4 消息增强的界面组件：
/// 表情回应（R-IM-03）、已读回执（R-IM-01）、话题摘要（R-IM-02）、转发 / 合并转发（R-IM-04）、加急（R-IM-05）。
/// 每一块都受功能开关控制；后端没开放时不显示。
library;

import 'package:flutter/material.dart';

import '../api/phase2_im.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'chat_extras.dart';
import 'messages_page.dart';

// ---------------- 表情回应 ----------------

/// 表情 key（后端固定英文名）→ 显示的表情。不认识的 key 原样显示。
const kReactionEmojis = <String, String>{
  'THUMBSUP': '👍',
  'DONE': '✅',
  'OK': '👌',
  'HEART': '❤️',
  'LAUGH': '😄',
  'CLAP': '👏',
  'FIRE': '🔥',
  'EYES': '👀',
  'SURPRISED': '😮',
  'CRY': '😢',
  'PRAY': '🙏',
  'MUSCLE': '💪',
  'PARTY': '🎉',
  'THINKING': '🤔',
  'ROCKET': '🚀',
  'SMILE': '🙂',
};

/// 悬停表情条上的常用 6 个。
const kQuickReactions = ['THUMBSUP', 'DONE', 'OK', 'HEART', 'LAUGH', 'CLAP'];

String reactionGlyph(String key) => kReactionEmojis[key] ?? key;

/// 气泡下方的「👍 3  ✅ 1」；点一下自己加 / 取消。
class ReactionChips extends StatelessWidget {
  final CosMessage message;
  final void Function(String emoji, bool add) onToggle;
  const ReactionChips({super.key, required this.message, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final rs = message.reactions;
    if (rs.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Wrap(spacing: 6, runSpacing: 4, children: [
        for (final r in rs)
          Tooltip(
            message: '${r.userIds.map(s.userName).join('、')} 回应了 ${reactionGlyph(r.emoji)}',
            child: InkWell(
              key: ValueKey('reaction-${r.emoji}'),
              borderRadius: BorderRadius.circular(12),
              onTap: () => onToggle(r.emoji, !r.reactedByMe),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: r.reactedByMe ? Fs.primaryLight : Fs.hover,
                  border: Border.all(color: r.reactedByMe ? Fs.primary.withValues(alpha: 0.5) : Colors.transparent),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text('${reactionGlyph(r.emoji)} ${r.count}',
                    style: TextStyle(fontSize: 12, color: r.reactedByMe ? Fs.primaryPressed : Fs.text2)),
              ),
            ),
          ),
      ]),
    );
  }
}

/// 全部表情面板（「更多」）。
Future<String?> pickReaction(BuildContext context) => showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('添加表情回应'),
        content: SizedBox(
          width: 320,
          child: Wrap(children: [
            for (final e in kReactionEmojis.entries)
              InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: () => Navigator.pop(ctx, e.key),
                child: SizedBox(width: 48, height: 44, child: Center(child: Text(e.value, style: const TextStyle(fontSize: 22)))),
              ),
          ]),
        ),
      ),
    );

/// 悬停时浮在消息旁边的工具条：常用表情、回复话题、转发、更多。
class MessageHoverBar extends StatelessWidget {
  final CosMessage message;
  final void Function(String emoji)? onReact;
  final VoidCallback? onThread;
  final VoidCallback? onForward;
  final void Function(Offset globalPos) onMore;
  const MessageHoverBar({super.key, required this.message, this.onReact, this.onThread, this.onForward, required this.onMore});

  @override
  Widget build(BuildContext context) {
    Widget btn(Widget child, String tip, VoidCallback? f, {Key? key}) => Tooltip(
          message: tip,
          child: InkWell(
            key: key,
            borderRadius: BorderRadius.circular(4),
            onTap: f,
            child: SizedBox(width: 28, height: 28, child: Center(child: child)),
          ),
        );
    return Material(
      elevation: 2,
      color: Colors.white,
      shadowColor: Colors.black26,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 1),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (onReact != null) ...[
            for (final k in kQuickReactions)
              btn(Text(reactionGlyph(k), style: const TextStyle(fontSize: 15)), '回应', () => onReact!(k), key: ValueKey('quick-$k')),
            btn(const Icon(Icons.add_reaction_outlined, size: 16, color: Fs.text2), '更多表情', () async {
              final e = await pickReaction(context);
              if (e != null) onReact!(e);
            }),
            Container(width: 1, height: 16, color: Fs.line, margin: const EdgeInsets.symmetric(horizontal: 2)),
          ],
          if (onThread != null) btn(const Icon(Icons.forum_outlined, size: 16, color: Fs.text2), '回复话题', onThread),
          if (onForward != null) btn(const Icon(Icons.shortcut_rounded, size: 16, color: Fs.text2), '转发', onForward),
          Builder(
            builder: (c) => btn(const Icon(Icons.more_horiz_rounded, size: 16, color: Fs.text2), '更多', () {
              final box = c.findRenderObject() as RenderBox;
              onMore(box.localToGlobal(box.size.bottomLeft(Offset.zero)));
            }),
          ),
        ]),
      ),
    );
  }
}

// ---------------- 已读回执 ----------------

/// 自己发的消息右下角：单聊「未读 / 已读」，群聊圆环（已读 / 应读），全读后对勾。超过 100 人不显示。
class ReadReceipt extends StatelessWidget {
  final CosMessage message;
  final bool isGroup;
  final ValueChanged<CosMessage>? onUpdated;
  const ReadReceipt({super.key, required this.message, required this.isGroup, this.onUpdated});

  @override
  Widget build(BuildContext context) {
    final read = message.readCount, total = message.memberCount;
    if (read == null || total == null || total <= 0 || total > 100) return const SizedBox.shrink();
    final all = read >= total;
    if (!isGroup) {
      return Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Text(all ? '已读' : '未读', style: TextStyle(fontSize: 11, color: all ? Fs.text3 : Fs.primary)),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(top: 3),
      child: Tooltip(
        message: all ? '全部已读' : '$read 人已读，${total - read} 人未读',
        child: InkWell(
          key: ValueKey('receipt-${message.messageId}'),
          customBorder: const CircleBorder(),
          onTap: () => showReadUsers(context, message, onUpdated: onUpdated),
          child: SizedBox(
            width: 16,
            height: 16,
            child: all
                ? const Icon(Icons.check_circle_rounded, size: 15, color: Fs.green)
                : CircularProgressIndicator(
                    value: total == 0 ? 0 : read / total,
                    strokeWidth: 2.2,
                    backgroundColor: Fs.line,
                    color: Fs.primary,
                  ),
          ),
        ),
      ),
    );
  }
}

Future<void> showReadUsers(BuildContext context, CosMessage m, {ValueChanged<CosMessage>? onUpdated}) => showDialog<void>(
      context: context,
      builder: (_) => AppScope(state: AppScope.read(context), child: _ReadUsersDialog(message: m, onUpdated: onUpdated)),
    );

class _ReadUsersDialog extends StatefulWidget {
  final CosMessage message;
  final ValueChanged<CosMessage>? onUpdated;
  const _ReadUsersDialog({required this.message, this.onUpdated});
  @override
  State<_ReadUsersDialog> createState() => _ReadUsersDialogState();
}

class _ReadUsersDialogState extends State<_ReadUsersDialog> {
  List<String>? read, unread;
  String? error;
  bool showUnread = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await AppScope.read(context).api.readUsers(widget.message.messageId);
      if (mounted) {
        setState(() {
          read = r.read;
          unread = r.unread;
          showUnread = r.unread.isNotEmpty;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final list = showUnread ? unread : read;
    return AlertDialog(
      titlePadding: const EdgeInsets.fromLTRB(20, 16, 12, 0),
      title: Row(children: [
        const Text('消息接收情况', style: TextStyle(fontSize: 16)),
        const Spacer(),
        FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: () => Navigator.pop(context)),
      ]),
      content: SizedBox(
        width: 360,
        height: 360,
        child: error != null
            ? Center(child: Text(error!, style: const TextStyle(color: Fs.red)))
            : read == null
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    SegmentedButton<bool>(
                      showSelectedIcon: false,
                      segments: [
                        ButtonSegment(value: false, label: Text('已读 ${read!.length}')),
                        ButtonSegment(value: true, label: Text('未读 ${unread!.length}')),
                      ],
                      selected: {showUnread},
                      onSelectionChanged: (v) => setState(() => showUnread = v.first),
                    ),
                    const SizedBox(height: 8),
                    Expanded(
                      child: list!.isEmpty
                          ? Center(child: Text(showUnread ? '所有人都已读' : '还没有人读', style: const TextStyle(color: Fs.text3)))
                          : ListView(children: [
                              for (final id in list)
                                ListTile(
                                  dense: true,
                                  leading: FsAvatar(name: s.userName(id), seed: id, size: 28),
                                  title: Text(s.userName(id)),
                                  subtitle: s.user(id)?.department == null ? null : Text(s.user(id)!.department!),
                                ),
                            ]),
                    ),
                    if (showUnread && unread!.isNotEmpty && s.feature('message.urgent') && widget.message.senderId == s.me.userId)
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton.icon(
                          style: TextButton.styleFrom(foregroundColor: Fs.red),
                          icon: const Icon(Icons.priority_high_rounded, size: 16),
                          label: const Text('一键加急未读成员'),
                          onPressed: () async {
                            final m = await showUrgentDialog(context, widget.message, preset: unread);
                            if (m != null) widget.onUpdated?.call(m);
                            if (m != null && context.mounted) Navigator.pop(context);
                          },
                        ),
                      ),
                  ]),
      ),
    );
  }
}

// ---------------- 话题 ----------------

/// 根消息下方：「N 条回复 · 最后回复 10:32」+ 最近回复人头像；话题模式群里没有回复时显示「回复话题」。
class ThreadSummary extends StatelessWidget {
  final CosMessage message;
  final bool alwaysShow;
  final VoidCallback onOpen;
  const ThreadSummary({super.key, required this.message, required this.onOpen, this.alwaysShow = false});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = message.thread;
    if (t == null && !alwaysShow) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: InkWell(
        key: ValueKey('thread-${message.messageId}'),
        borderRadius: BorderRadius.circular(6),
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 3),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (t != null)
              for (final id in t.participants.reversed.take(3)) ...[
                FsAvatar(name: s.userName(id), seed: id, size: 18),
                const SizedBox(width: 2),
              ],
            const SizedBox(width: 4),
            Text(
              t == null ? '回复话题' : '${t.replyCount} 条回复',
              style: const TextStyle(fontSize: 12, color: Fs.primary, fontWeight: FontWeight.w500),
            ),
            if (t?.lastReplyAt != null)
              Text(' · 最后回复 ${fmtMessageTime(t!.lastReplyAt!.toLocal())}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
            const Icon(Icons.chevron_right_rounded, size: 16, color: Fs.text3),
          ]),
        ),
      ),
    );
  }
}

// ---------------- 转发 ----------------

/// 选择会话（最近会话 + 搜索，最多 10 个）+ 留言；mode: single | merge。返回是否发送成功。
Future<bool> showForwardDialog(BuildContext context, List<CosMessage> messages, {required String mode}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => AppScope(state: AppScope.read(context), child: _ForwardDialog(messages: messages, mode: mode)),
  );
  return ok == true;
}

class _ForwardDialog extends StatefulWidget {
  final List<CosMessage> messages;
  final String mode;
  const _ForwardDialog({required this.messages, required this.mode});
  @override
  State<_ForwardDialog> createState() => _ForwardDialogState();
}

class _ForwardDialogState extends State<_ForwardDialog> {
  static const maxTargets = 10;
  final note = TextEditingController();
  final Set<String> picked = {};
  String keyword = '';
  bool sending = false;
  String? error;

  @override
  void dispose() {
    note.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    setState(() {
      sending = true;
      error = null;
    });
    try {
      await AppScope.read(context).api.forwardMessages(
            messageIds: [for (final m in widget.messages) m.messageId],
            chatIds: picked.toList(),
            mode: widget.mode,
            note: note.text,
          );
      if (!mounted) return;
      showToast(context, '已转发到 ${picked.length} 个会话');
      Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() {
          sending = false;
          error = describeError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final k = keyword.trim().toLowerCase();
    final chats = [
      for (final c in s.visibleChats)
        if (k.isEmpty || s.chatTitle(c).toLowerCase().contains(k)) c,
    ];
    final title = widget.mode == 'merge' ? '合并转发 ${widget.messages.length} 条消息' : (widget.messages.length > 1 ? '逐条转发 ${widget.messages.length} 条消息' : '转发');
    return AlertDialog(
      title: Text(title),
      content: SizedBox(
        width: 420,
        height: 460,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          FsSearchField(hint: '搜索会话', onChanged: (v) => setState(() => keyword = v)),
          const SizedBox(height: 6),
          Text('最近会话 · 已选 ${picked.length} / $maxTargets', style: const TextStyle(fontSize: 12, color: Fs.text3)),
          Expanded(
            child: ListView(children: [
              for (final c in chats)
                CheckboxListTile(
                  key: ValueKey('fwd-${c.chatId}'),
                  dense: true,
                  value: picked.contains(c.chatId),
                  controlAffinity: ListTileControlAffinity.leading,
                  secondary: FsAvatar(
                    name: s.chatTitle(c),
                    seed: c.isGroup ? c.chatId : c.memberIds.firstWhere((id) => id != s.me.userId, orElse: () => c.chatId),
                    size: 28,
                    isGroup: c.isGroup,
                    isBot: s.isBotChat(c),
                  ),
                  title: Text(s.chatTitle(c), maxLines: 1, overflow: TextOverflow.ellipsis),
                  onChanged: (v) => setState(() {
                    if (v == true) {
                      if (picked.length >= maxTargets) {
                        error = '最多同时转发到 $maxTargets 个会话';
                        return;
                      }
                      picked.add(c.chatId);
                    } else {
                      picked.remove(c.chatId);
                    }
                    error = null;
                  }),
                ),
            ]),
          ),
          if (widget.mode == 'merge' || widget.messages.length == 1)
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(6)),
              child: Text(
                widget.mode == 'merge'
                    ? '[聊天记录] ${mergeTitle(s, widget.messages)}'
                    : messagePreview(s, widget.messages.first),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: Fs.text2),
              ),
            ),
          const SizedBox(height: 8),
          TextField(controller: note, decoration: const InputDecoration(hintText: '给对方留言（可选）', isDense: true)),
          if (error != null)
            Padding(padding: const EdgeInsets.only(top: 6), child: Text(error!, style: const TextStyle(fontSize: 12, color: Fs.red))),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: picked.isEmpty || sending ? null : _send, child: Text(sending ? '发送中…' : '发送')),
      ],
    );
  }
}

/// 合并转发的标题：「张三 和 李四 的聊天记录」（后端会再生成一次，以后端为准）。
String mergeTitle(AppState s, List<CosMessage> ms) {
  final names = <String>[];
  for (final m in ms) {
    final n = s.userName(m.senderId);
    if (!names.contains(n)) names.add(n);
  }
  if (names.isEmpty) return '聊天记录';
  if (names.length == 1) return '${names.first} 的聊天记录';
  return '${names.take(2).join(' 和 ')}${names.length > 2 ? ' 等' : ''} 的聊天记录';
}

/// 合并转发卡片：标题 + 前 3 条预览，点开是只读消息列表。
class MergeForwardCard extends StatelessWidget {
  final Map<String, dynamic> content;
  const MergeForwardCard({super.key, required this.content});

  List<CosMessage> get messages => [
        for (final x in (content['messages'] as List? ?? const []))
          if (x is Map) CosMessage.fromJson(x.cast<String, dynamic>()),
      ];

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final ms = messages;
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => showDialog<void>(
        context: context,
        builder: (_) => AppScope(state: s, child: _MergeForwardDialog(title: content['title']?.toString() ?? '聊天记录', messages: ms)),
      ),
      child: Container(
        width: 280,
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
        decoration: BoxDecoration(color: Colors.white, border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(8)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(content['title']?.toString() ?? '聊天记录', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          for (final m in ms.take(3))
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: Text('${s.userName(m.senderId)}：${messagePreview(s, m)}',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text2)),
            ),
          const Divider(height: 14),
          Text('聊天记录 · ${ms.length} 条', style: const TextStyle(fontSize: 11, color: Fs.text3)),
        ]),
      ),
    );
  }
}

class _MergeForwardDialog extends StatelessWidget {
  final String title;
  final List<CosMessage> messages;
  const _MergeForwardDialog({required this.title, required this.messages});

  @override
  Widget build(BuildContext context) => Dialog(
        child: SizedBox(
          width: 560,
          height: 600,
          child: Column(children: [
            PaneHeader(
              title: title,
              actions: [FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: () => Navigator.pop(context))],
            ),
            Expanded(
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 16), children: [
                for (final m in messages)
                  MessageItem(message: m, compact: false, showName: true, maxWidth: 400, forceLeft: true),
              ]),
            ),
          ]),
        ),
      );
}

// ---------------- 加急 ----------------

/// 选择加急对象（单聊默认对方，群聊选成员）和方式（应用内 / 推送）。返回更新后的消息。
Future<CosMessage?> showUrgentDialog(BuildContext context, CosMessage m, {List<String>? preset}) async {
  final s = AppScope.read(context);
  final chat = s.chat(m.chatId);
  if (chat == null) return null;
  final others = chat.memberIds.where((id) => id != s.me.userId && id != kBotId).toList();
  List<String>? users = preset;
  if (users == null) {
    if (!chat.isGroup) {
      users = others;
    } else {
      users = await pickUsers(context,
          users: s.users.where((u) => others.contains(u.userId)).toList(), title: '选择加急对象');
    }
  }
  if (users == null || users.isEmpty || !context.mounted) return null;
  final type = await showDialog<String>(
    context: context,
    builder: (ctx) {
      var t = 'app';
      return StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          title: const Text('加急'),
          content: SizedBox(
            width: 360,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('加急给：${users!.map(s.userName).join('、')}', style: const TextStyle(fontSize: 13, color: Fs.text2)),
              const SizedBox(height: 8),
              RadioGroup<String>(
                groupValue: t,
                onChanged: (v) => setSt(() => t = v ?? t),
                child: const Column(children: [
                  RadioListTile(value: 'app', dense: true, contentPadding: EdgeInsets.zero, title: Text('应用内加急'), subtitle: Text('对方屏幕顶部出现红色提醒')),
                  RadioListTile(value: 'push', dense: true, contentPadding: EdgeInsets.zero, title: Text('应用内 + 手机推送')),
                ]),
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: Fs.red),
              onPressed: () => Navigator.pop(ctx, t),
              child: const Text('加急'),
            ),
          ],
        ),
      );
    },
  );
  if (type == null || !context.mounted) return null;
  try {
    final r = await s.api.urgentMessage(m.messageId, users, type: type);
    if (context.mounted) showToast(context, '已加急 ${users.length} 人');
    return r;
  } catch (e) {
    if (context.mounted) {
      showToast(context, e is CosApiException && e.statusCode == 429 ? '操作太频繁，请稍后再试' : describeError(e), error: true);
    }
    return null;
  }
}

/// 被加急时屏幕顶部的红色横幅：「张三 加急了一条消息」，查看 / 知道了。
class UrgentBanner extends StatelessWidget {
  const UrgentBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    if (s.urgents.isEmpty) return const SizedBox.shrink();
    final u = s.urgents.first;
    final more = s.urgents.length - 1;
    return Material(
      color: Fs.red,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
          child: Row(children: [
            const Icon(Icons.notifications_active_rounded, color: Colors.white, size: 18),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                '${s.userName(u.fromUserId)} 加急了一条消息${u.preview == null ? '' : '：${u.preview}'}${more > 0 ? '（还有 $more 条）' : ''}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w500),
              ),
            ),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: Colors.white),
              onPressed: () {
                s.pendingTarget = {'type': 'message', 'id': u.chatId, 'message_id': u.messageId};
                s.openChat(u.chatId);
              },
              child: const Text('查看'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: Fs.red, minimumSize: const Size(64, 30)),
              onPressed: () async {
                try {
                  await s.ackUrgent(u.messageId);
                } catch (e) {
                  if (context.mounted) showToast(context, describeError(e), error: true);
                }
              },
              child: const Text('知道了'),
            ),
          ]),
        ),
      ),
    );
  }
}
