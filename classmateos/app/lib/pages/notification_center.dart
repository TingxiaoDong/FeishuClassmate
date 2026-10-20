/// 通知中心（R-NT-01）与通知设置（R-NT-02）。
/// 桌面端：导航栏头像下的铃铛；手机端：工作台右上角铃铛，打开整页。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../api/phase2.dart';
import '../api/phase2_docs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// 铃铛 + 未读数；功能开关 notifications 关闭时不显示。
class NotificationBell extends StatelessWidget {
  final double size;
  final Color? color;
  const NotificationBell({super.key, this.size = 22, this.color});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    if (!s.feature('notifications')) return const SizedBox.shrink();
    final n = s.notifUnread;
    return Tooltip(
      message: n > 0 ? '通知（$n 条未读）' : '通知',
      child: HoverBox(
        onTap: () => openNotificationCenter(context),
        padding: const EdgeInsets.all(8),
        radius: 8,
        child: Badge(
          isLabelVisible: n > 0,
          label: Text(n > 99 ? '99+' : '$n', style: const TextStyle(fontSize: 10)),
          backgroundColor: Fs.red,
          child: Icon(n > 0 ? Icons.notifications_rounded : Icons.notifications_none_rounded,
              size: size, color: color ?? Fs.text2),
        ),
      ),
    );
  }
}

Future<void> openNotificationCenter(BuildContext context) {
  final s = AppScope.read(context);
  if (MediaQuery.sizeOf(context).width < 720) {
    return pushScoped(context, const Scaffold(body: SafeArea(child: NotificationPanel(fullPage: true))));
  }
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black12,
    builder: (_) => AppScope(
      state: s,
      child: const Dialog(
        alignment: Alignment.topLeft,
        insetPadding: EdgeInsets.only(left: 80, top: 56, bottom: 40),
        child: SizedBox(width: 400, height: 600, child: NotificationPanel()),
      ),
    ),
  );
}

IconData _typeIcon(String type) => switch (type.split('.').first) {
      'doc' => Icons.description_outlined,
      'record' => Icons.grid_view_rounded,
      'task' => Icons.task_alt_rounded,
      'approval' => Icons.approval_outlined,
      'calendar' => Icons.event_outlined,
      'wiki' => Icons.menu_book_outlined,
      _ => Icons.notifications_none_rounded,
    };

Color _typeColor(String type) => switch (type.split('.').first) {
      'doc' || 'wiki' => Fs.primary,
      'record' => Fs.purple,
      'task' => Fs.green,
      'approval' => Fs.orange,
      'calendar' => Fs.orange,
      _ => Fs.text2,
    };

class NotificationPanel extends StatefulWidget {
  final bool fullPage;
  const NotificationPanel({super.key, this.fullPage = false});
  @override
  State<NotificationPanel> createState() => _NotificationPanelState();
}

class _NotificationPanelState extends State<NotificationPanel> {
  String filter = 'all';
  List<CosNotification> items = [];
  String? pageToken;
  bool hasMore = false;
  bool loading = true;
  bool loadingMore = false;
  String? error;
  StreamSubscription<CosEvent>? _sub;
  late final AppState _s = AppScope.read(context);

  @override
  void initState() {
    super.initState();
    _sub = _s.eventStream.listen((e) {
      if (e.eventType != 'notification.new') return;
      final n = e.map('notification');
      if (n == null || !mounted) return;
      final item = CosNotification.fromJson(n);
      if (filter == 'mention' && !item.isMention) return;
      if (items.any((x) => x.id == item.id)) return;
      setState(() => items.insert(0, item));
    });
    _load();
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    setState(() {
      if (more) {
        loadingMore = true;
      } else {
        loading = true;
        error = null;
      }
    });
    try {
      final p = await _s.api.listNotifications(filter: filter, pageToken: more ? pageToken : null);
      if (!mounted) return;
      setState(() {
        items = more ? [...items, ...p.items] : p.items;
        pageToken = p.pageToken;
        hasMore = p.hasMore;
      });
    } catch (e) {
      if (mounted && !more) setState(() => error = describeError(e));
    } finally {
      if (mounted) {
        setState(() {
          loading = false;
          loadingMore = false;
        });
      }
    }
  }

  Future<void> _open(CosNotification n) async {
    if (!n.read) {
      setState(() => n.read = true);
      _s.setNotifUnread(_s.notifUnread - 1);
      unawaited(_s.api.markNotificationsRead(ids: [n.id]).catchError((_) {}));
    }
    final target = n.target;
    if (target.isEmpty) return;
    Navigator.of(context).pop();
    _s.openTarget(target);
  }

  /// 文档权限申请：通知里直接同意 / 拒绝（后端只允许文档所有者处理，已处理过返回 409）。
  final Map<String, String> _handled = {};

  bool _isAccessRequest(CosNotification n) =>
      n.type == 'doc.access_request' && n.target['doc_id'] != null && n.target['request_id'] != null;

  Future<void> _handleRequest(CosNotification n, bool approve) async {
    setState(() => _handled[n.id] = '处理中…');
    try {
      await _s.api.handleAccessRequest(n.target['doc_id'].toString(), n.target['request_id'].toString(), approve);
      if (!mounted) return;
      setState(() => _handled[n.id] = approve ? '已同意' : '已拒绝');
      if (!n.read) {
        setState(() => n.read = true);
        _s.setNotifUnread(_s.notifUnread - 1);
        unawaited(_s.api.markNotificationsRead(ids: [n.id]).catchError((_) {}));
      }
    } on CosApiException catch (e) {
      if (!mounted) return;
      if (e.statusCode == 409) {
        setState(() => _handled[n.id] = '已处理');
        showToast(context, '这个申请已经处理过了');
      } else {
        setState(() => _handled.remove(n.id));
        showToast(context, describeError(e), error: true);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _handled.remove(n.id));
      showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _readAll() async {
    try {
      await _s.api.markNotificationsRead(all: true);
      if (!mounted) return;
      setState(() {
        for (final n in items) {
          n.read = true;
        }
      });
      _s.setNotifUnread(0);
      await _s.refreshNotifUnread();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final unread = items.where((n) => !n.read).length;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
        child: Row(children: [
          if (widget.fullPage)
            FsIconButton(icon: Icons.arrow_back_ios_new_rounded, tooltip: '返回', size: 18, onPressed: () => Navigator.pop(context)),
          const Text('通知', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          const Spacer(),
          TextButton(onPressed: unread == 0 && _s.notifUnread == 0 ? null : _readAll, child: const Text('全部标为已读')),
          FsIconButton(
            icon: Icons.settings_outlined,
            tooltip: '通知设置',
            size: 19,
            onPressed: () => showNotificationSettings(context),
          ),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(children: [
          for (final e in const {'all': '全部', 'mention': '@我的'}.entries)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: HoverBox(
                onTap: () {
                  if (filter == e.key) return;
                  setState(() => filter = e.key);
                  _load();
                },
                selected: filter == e.key,
                selectedColor: Fs.primaryLight,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: Text(e.value,
                    style: TextStyle(
                      fontSize: 13,
                      color: filter == e.key ? Fs.primary : Fs.text2,
                      fontWeight: filter == e.key ? FontWeight.w500 : FontWeight.normal,
                    )),
              ),
            ),
        ]),
      ),
      const SizedBox(height: 6),
      const Divider(),
      Expanded(
        child: loading
            ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
            : error != null
                ? EmptyState(
                    icon: Icons.cloud_off_outlined,
                    title: '通知加载失败',
                    subtitle: error,
                    action: OutlinedButton(onPressed: _load, child: const Text('重试')),
                  )
                : items.isEmpty
                    ? EmptyState(
                        icon: Icons.notifications_none_rounded,
                        title: filter == 'mention' ? '没有 @你 的通知' : '暂无通知',
                        subtitle: '评论、@、任务指派、日程邀请等会显示在这里',
                      )
                    : NotificationListener<ScrollNotification>(
                        onNotification: (n) {
                          if (hasMore && !loadingMore && n.metrics.extentAfter < 200) _load(more: true);
                          return false;
                        },
                        child: ListView.builder(
                          itemCount: items.length + (hasMore ? 1 : 0),
                          itemBuilder: (_, i) => i == items.length
                              ? const Padding(
                                  padding: EdgeInsets.all(12),
                                  child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
                                )
                              : _item(items[i]),
                        ),
                      ),
      ),
    ]);
  }

  Widget _item(CosNotification n) {
    final actor = n.actorId;
    return HoverBox(
      radius: 0,
      onTap: () => _open(n),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Stack(clipBehavior: Clip.none, children: [
          actor != null
              ? FsAvatar(name: _s.userName(actor), seed: actor, size: 36)
              : CircleAvatar(radius: 18, backgroundColor: Fs.bg, child: Icon(_typeIcon(n.type), size: 18, color: _typeColor(n.type))),
          if (actor != null)
            Positioned(
              right: -4,
              bottom: -4,
              child: Container(
                padding: const EdgeInsets.all(2),
                decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
                child: Icon(_typeIcon(n.type), size: 13, color: _typeColor(n.type)),
              ),
            ),
        ]),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(n.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 14,
                  color: n.read ? Fs.text2 : Fs.text1,
                  fontWeight: n.read ? FontWeight.normal : FontWeight.w500,
                )),
            if (n.summary.isNotEmpty) ...[
              const SizedBox(height: 4),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(4)),
                child: Text(n.summary,
                    maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5, color: Fs.text2)),
              ),
            ],
            if (_isAccessRequest(n)) ...[
              const SizedBox(height: 8),
              if (_handled[n.id] != null)
                Text(_handled[n.id]!, key: ValueKey('notif-handled-${n.id}'), style: const TextStyle(fontSize: 12.5, color: Fs.text3))
              else
                Row(children: [
                  FilledButton(
                    key: ValueKey('notif-approve-${n.id}'),
                    style: FilledButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 14)),
                    onPressed: () => _handleRequest(n, true),
                    child: const Text('同意', style: TextStyle(fontSize: 12.5)),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    key: ValueKey('notif-reject-${n.id}'),
                    style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 14)),
                    onPressed: () => _handleRequest(n, false),
                    child: const Text('拒绝', style: TextStyle(fontSize: 12.5)),
                  ),
                ]),
            ],
            const SizedBox(height: 4),
            Text(fmtRelative(n.createdAt?.toLocal()), style: const TextStyle(fontSize: 12, color: Fs.text3)),
          ]),
        ),
        if (!n.read)
          Container(
            margin: const EdgeInsets.only(left: 8, top: 6),
            width: 8,
            height: 8,
            decoration: const BoxDecoration(color: Fs.red, shape: BoxShape.circle),
          ),
      ]),
    );
  }
}

// ---------------- 通知设置 ----------------

Future<void> showNotificationSettings(BuildContext context) {
  final s = AppScope.read(context);
  return showDialog<void>(
    context: context,
    builder: (_) => AppScope(state: s, child: const NotificationSettingsDialog()),
  );
}

class NotificationSettingsDialog extends StatefulWidget {
  const NotificationSettingsDialog({super.key});
  @override
  State<NotificationSettingsDialog> createState() => _NotificationSettingsDialogState();
}

class _NotificationSettingsDialogState extends State<NotificationSettingsDialog> {
  CosNotificationSettings? st;
  String? error;
  bool saving = false;
  late final AppState _s = AppScope.read(context);

  @override
  void initState() {
    super.initState();
    _s.api.notificationSettings().then((v) {
      if (mounted) setState(() => st = v);
    }).catchError((Object e) {
      if (mounted) setState(() => error = describeError(e));
    });
  }

  Future<void> _save() async {
    setState(() => saving = true);
    try {
      await _s.api.saveNotificationSettings(st!);
      if (!mounted) return;
      showToast(context, '通知设置已保存');
      Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          saving = false;
          error = describeError(e);
        });
      }
    }
  }

  Future<void> _pickTime(bool start) async {
    final cur = (start ? st!.dndStart : st!.dndEnd).split(':');
    final t = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: int.tryParse(cur.first) ?? 23, minute: int.tryParse(cur.last) ?? 0),
    );
    if (t == null) return;
    final v = '${two(t.hour)}:${two(t.minute)}';
    setState(() => start ? st!.dndStart = v : st!.dndEnd = v);
  }

  @override
  Widget build(BuildContext context) {
    final v = st;
    return AlertDialog(
      title: const Text('通知设置'),
      content: SizedBox(
        width: 460,
        child: v == null
            ? SizedBox(
                height: 160,
                child: Center(
                  child: error != null
                      ? Text(error!, style: const TextStyle(color: Fs.red))
                      : const CircularProgressIndicator(strokeWidth: 2),
                ),
              )
            : SingleChildScrollView(
                child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  if (pushTokenProvider == null)
                    Container(
                      padding: const EdgeInsets.all(10),
                      margin: const EdgeInsets.only(bottom: 8),
                      decoration: BoxDecoration(color: const Color(0xFFFFF7E8), borderRadius: BorderRadius.circular(8)),
                      child: const Text('这台设备还没有开启系统推送，下面的设置对手机推送生效；App 打开时通知仍会显示在通知中心。',
                          style: TextStyle(fontSize: 12, color: Fs.text2)),
                    ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('接收通知'),
                    subtitle: const Text('关闭后不再推送任何通知', style: TextStyle(fontSize: 12)),
                    value: v.enabled,
                    onChanged: (x) => setState(() => v.enabled = x),
                  ),
                  const Divider(),
                  const Padding(
                    padding: EdgeInsets.only(top: 8, bottom: 4),
                    child: Text('通知类型', style: TextStyle(fontSize: 13, color: Fs.text3)),
                  ),
                  Wrap(spacing: 8, runSpacing: 8, children: [
                    for (final e in kNotifyCategories.entries)
                      FilterChip(
                        label: Text(e.value),
                        selected: v.categories[e.key] == true,
                        onSelected: v.enabled ? (x) => setState(() => v.categories[e.key] = x) : null,
                      ),
                  ]),
                  const SizedBox(height: 8),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('免打扰时段'),
                    value: v.dndEnabled,
                    onChanged: v.enabled ? (x) => setState(() => v.dndEnabled = x) : null,
                  ),
                  if (v.dndEnabled)
                    Row(children: [
                      OutlinedButton(onPressed: () => _pickTime(true), child: Text(v.dndStart)),
                      const Padding(padding: EdgeInsets.symmetric(horizontal: 8), child: Text('至')),
                      OutlinedButton(onPressed: () => _pickTime(false), child: Text(v.dndEnd)),
                      const SizedBox(width: 8),
                      if (v.dndEnd.compareTo(v.dndStart) < 0)
                        const Text('（次日）', style: TextStyle(fontSize: 12, color: Fs.text3)),
                    ]),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('电脑在线时手机不推送'),
                    value: v.muteMobileWhenDesktopOnline,
                    onChanged: v.enabled ? (x) => setState(() => v.muteMobileWhenDesktopOnline = x) : null,
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('通知显示消息内容'),
                    subtitle: const Text('关闭后只显示「你收到一条新消息」', style: TextStyle(fontSize: 12)),
                    value: v.showPreview,
                    onChanged: v.enabled ? (x) => setState(() => v.showPreview = x) : null,
                  ),
                  if (error != null) Text(error!, style: const TextStyle(color: Fs.red)),
                ]),
              ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: v == null || saving ? null : _save, child: Text(saving ? '保存中…' : '保存')),
      ],
    );
  }
}
