/// 任务详情的迭代 3 扩展：所属清单、子任务（R-TK-01）、关注人（R-TK-02）、评论和动态（R-TK-03）。
/// 每一块都受功能开关控制；后端没开放时整块不显示。
library;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../api/phase2_docs.dart';
import '../api/phase2_tasks.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/cos_file_view.dart';
import 'task_lists.dart';
import 'tasks_page.dart';

const _fieldLabels = {
  'title': '标题',
  'status': '状态',
  'assignee_id': '负责人',
  'due_ms': '截止时间',
  'description': '描述',
  'priority': '优先级',
  'parent_id': '父任务',
  'follower_ids': '关注人',
  'tasklists': '所属清单',
};

const _actionLabels = {
  'created': '创建了任务',
  'completed': '完成了任务',
  'reopened': '重新打开了任务',
  'subtask_added': '添加了子任务',
  'follower_added': '添加了关注人',
  'follower_removed': '移除了关注人',
  'commented': '发表了评论',
  'tasklist_added': '加入了清单',
  'tasklist_removed': '移出了清单',
};

class TaskExtras extends StatefulWidget {
  final CosTask task;
  final VoidCallback onChanged;
  const TaskExtras({super.key, required this.task, required this.onChanged});
  @override
  State<TaskExtras> createState() => _TaskExtrasState();
}

class _TaskExtrasState extends State<TaskExtras> {
  List<CosTask> subs = [];
  List<Map<String, dynamic>> comments = [], activities = [];
  List<CosTaskList> lists = [];
  final input = TextEditingController(), comment = TextEditingController();
  final List<CosFileRef> pending = [];
  bool showActivities = false, uploading = false, sending = false;
  String? error;
  CosTask get t => widget.task;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    input.dispose();
    comment.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final s = AppScope.read(context);
    try {
      final r = await Future.wait([
        s.feature('task.subtasks') ? s.api.subtasks(t.taskId) : Future.value(<CosTask>[]),
        s.feature('task.comments') ? s.api.taskComments(t.taskId) : Future.value(<Map<String, dynamic>>[]),
        s.feature('task.comments') ? s.api.taskActivities(t.taskId) : Future.value(<Map<String, dynamic>>[]),
        s.feature('task.lists') && t.parentId == null ? s.api.taskLists() : Future.value(<CosTaskList>[]),
      ]);
      if (!mounted) return;
      setState(() {
        subs = r[0] as List<CosTask>;
        comments = r[1] as List<Map<String, dynamic>>;
        activities = r[2] as List<Map<String, dynamic>>;
        lists = r[3] as List<CosTaskList>;
        error = null;
      });
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  /// 执行写操作；成功后重新拉数据并通知上层刷新任务本身（进度、关注人等）。失败时保留输入。
  Future<bool> _run(Future<void> Function() f, {bool notify = true}) async {
    try {
      await f();
      await _load();
      if (notify) widget.onChanged();
      return true;
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final legacyEdit = t.createdBy == s.me.userId || t.assigneeId == s.me.userId;
    final canEdit = t.can('can_edit', legacyEdit);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (error != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(children: [
            Expanded(child: Text(error!, style: const TextStyle(fontSize: 12, color: Fs.red))),
            TextButton(onPressed: _load, child: const Text('重试')),
          ]),
        ),
      if (s.feature('task.lists') && t.parentId == null) ...[
        _title(Icons.checklist_rounded, '所属清单'),
        TaskListMembership(task: t, lists: lists, onChanged: () async {
          await _load();
          widget.onChanged();
        }),
        const Divider(height: 28),
      ],
      if (s.feature('task.subtasks')) ...[
        _subtasks(s, canEdit),
        const Divider(height: 28),
      ],
      if (s.feature('task.followers')) ...[
        _followers(s, canEdit),
        const Divider(height: 28),
      ],
      if (s.feature('task.comments')) _discussion(s),
    ]);
  }

  Widget _title(IconData icon, String text, [String? extra]) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(children: [
          Icon(icon, size: 16, color: Fs.text3),
          const SizedBox(width: 6),
          Text(text, style: const TextStyle(fontSize: 13, color: Fs.text2, fontWeight: FontWeight.w600)),
          if (extra != null) ...[const SizedBox(width: 6), Text(extra, style: const TextStyle(fontSize: 12, color: Fs.text3))],
        ]),
      );

  // ---------------- 子任务 ----------------

  Widget _subtasks(AppState s, bool canEdit) {
    final done = subs.where((x) => x.isDone).length;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _title(Icons.account_tree_outlined, '子任务', subs.isEmpty ? null : '$done/${subs.length}'),
      if (subs.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(value: done / subs.length, minHeight: 4, backgroundColor: Fs.lineLight, color: const Color(0xFF2EA121)),
          ),
        ),
      ReorderableListView(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        buildDefaultDragHandles: false,
        onReorderItem: (a, b) {
          final x = [...subs];
          final v = x.removeAt(a);
          x.insert(b, v);
          setState(() => subs = x); // 先在界面上排好，失败时重新拉回服务器顺序
          _run(() => s.api.orderSubtasks(t.taskId, [for (final e in x) e.taskId]), notify: false);
        },
        children: [for (var i = 0; i < subs.length; i++) _subRow(s, subs[i], i, canEdit)],
      ),
      if (canEdit && t.depth < 3)
        TextField(
          controller: input,
          decoration: const InputDecoration(
            isDense: true,
            hintText: '添加子任务，回车保存',
            prefixIcon: Icon(Icons.add_rounded, size: 18, color: Fs.primary),
            filled: false,
            border: InputBorder.none,
            enabledBorder: InputBorder.none,
          ),
          onSubmitted: (v) async {
            if (v.trim().isEmpty) return;
            final ok = await _run(() => s.api.createTask(title: v.trim(), parentId: t.taskId, assigneeId: s.me.userId));
            if (ok) input.clear();
          },
        )
      else if (canEdit)
        const Text('子任务最多 3 层', style: TextStyle(fontSize: 12, color: Fs.text3)),
    ]);
  }

  Widget _subRow(AppState s, CosTask x, int i, bool parentEdit) {
    final canEdit = x.can('can_edit', parentEdit);
    final overdue = x.due != null && x.due!.isBefore(DateTime.now()) && !x.isDone;
    return HoverBox(
      key: ValueKey(x.taskId),
      onTap: () => pushScoped(
        context,
        Scaffold(
          appBar: AppBar(title: const Text('子任务详情')),
          body: Builder(
            builder: (ctx) => TaskDetail(
              task: x,
              onChanged: (_) => _run(() async {}),
              onDeleted: () {
                _run(() async {});
                Navigator.of(ctx).maybePop();
              },
            ),
          ),
        ),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
      child: Row(children: [
        if (canEdit)
          ReorderableDragStartListener(
            index: i,
            child: const MouseRegion(
              cursor: SystemMouseCursors.grab,
              child: Icon(Icons.drag_indicator_rounded, size: 16, color: Fs.textDisabled),
            ),
          ),
        InkWell(
          customBorder: const CircleBorder(),
          onTap: canEdit ? () => _run(() => s.api.updateTask(x.taskId, status: x.isDone ? 'pending' : 'done')) : null,
          child: Padding(
            padding: const EdgeInsets.all(2),
            child: Icon(x.isDone ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded,
                size: 18, color: x.isDone ? const Color(0xFF2EA121) : Fs.textDisabled),
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Text(x.title,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 14, color: x.isDone ? Fs.text3 : Fs.text1, decoration: x.isDone ? TextDecoration.lineThrough : null)),
        ),
        if (x.subtaskCount > 0)
          Padding(
            padding: const EdgeInsets.only(left: 6),
            child: Text('${x.subtaskDoneCount}/${x.subtaskCount}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
          ),
        TextButton(
          style: TextButton.styleFrom(minimumSize: const Size(0, 28), padding: const EdgeInsets.symmetric(horizontal: 6)),
          onPressed: canEdit
              ? () async {
                  final d = await pickDateTime(context, initial: x.due);
                  if (d != null) _run(() => s.api.updateTask(x.taskId, due: d));
                }
              : null,
          child: Text(x.due == null ? '截止时间' : fmtDue(x.due!),
              style: TextStyle(fontSize: 12, color: overdue ? Fs.red : (x.due == null ? Fs.textDisabled : Fs.text3))),
        ),
        InkWell(
          customBorder: const CircleBorder(),
          onTap: canEdit
              ? () async {
                  final ids = await pickUsers(context,
                      users: s.users, title: '指派子任务', multiple: false, initial: [if (x.assigneeId != null) x.assigneeId!]);
                  if (ids != null && ids.isNotEmpty && ids.first != x.assigneeId) {
                    _run(() => s.api.updateTask(x.taskId, assigneeId: ids.first));
                  }
                }
              : null,
          child: x.assigneeId != null
              ? Tooltip(message: s.userName(x.assigneeId!), child: FsAvatar(name: s.userName(x.assigneeId!), seed: x.assigneeId, size: 22))
              : const Tooltip(message: '指派', child: Icon(Icons.person_add_alt_outlined, size: 20, color: Fs.textDisabled)),
        ),
      ]),
    );
  }

  // ---------------- 关注人 ----------------

  Widget _followers(AppState s, bool canEdit) {
    final me = s.me.userId;
    final following = t.followerIds.contains(me);
    final canManage = t.can('can_manage_followers', canEdit);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _title(Icons.visibility_outlined, '关注人', t.followerIds.isEmpty ? null : '${t.followerIds.length}'),
      Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
        for (final id in t.followerIds)
          canManage || id == me
              ? InputChip(
                  avatar: FsAvatar(name: s.userName(id), seed: id, size: 20),
                  label: Text(s.userName(id), style: const TextStyle(fontSize: 13)),
                  visualDensity: VisualDensity.compact,
                  deleteButtonTooltipMessage: id == me ? '取消关注' : '移除关注人',
                  onDeleted: () => _run(() => s.api.followTask(t.taskId, id, false)),
                )
              : Chip(
                  avatar: FsAvatar(name: s.userName(id), seed: id, size: 20),
                  label: Text(s.userName(id), style: const TextStyle(fontSize: 13)),
                  visualDensity: VisualDensity.compact,
                ),
        if (canManage)
          ActionChip(
            avatar: const Icon(Icons.add_rounded, size: 16),
            label: const Text('添加', style: TextStyle(fontSize: 13)),
            visualDensity: VisualDensity.compact,
            onPressed: () async {
              final ids = await pickUsers(context, users: s.users, title: '添加关注人', exclude: t.followerIds.toSet());
              if (ids == null || ids.isEmpty) return;
              _run(() async {
                for (final id in ids) {
                  await s.api.followTask(t.taskId, id, true);
                }
              });
            },
          ),
        if (!following && t.can('can_follow', true))
          TextButton.icon(
            onPressed: () => _run(() => s.api.followTask(t.taskId, me, true)),
            icon: const Icon(Icons.visibility_outlined, size: 16),
            label: const Text('关注'),
          ),
      ]),
      const Padding(
        padding: EdgeInsets.only(top: 4),
        child: Text('关注人会收到任务变更通知，但不能修改任务', style: TextStyle(fontSize: 12, color: Fs.text3)),
      ),
    ]);
  }

  // ---------------- 评论和动态 ----------------

  Widget _discussion(AppState s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          SegmentedButton<bool>(
            showSelectedIcon: false,
            style: const ButtonStyle(visualDensity: VisualDensity.compact),
            segments: [
              ButtonSegment(value: false, label: Text('评论 ${comments.length}')),
              const ButtonSegment(value: true, label: Text('动态')),
            ],
            selected: {showActivities},
            onSelectionChanged: (v) => setState(() => showActivities = v.first),
          ),
        ]),
        const SizedBox(height: 10),
        if (showActivities) ..._activities(s) else ..._comments(s),
      ]);

  List<Widget> _comments(AppState s) => [
        if (comments.isEmpty)
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('还没有评论', style: TextStyle(fontSize: 13, color: Fs.text3))),
        for (final c in comments) _comment(s, c),
        if (t.can('can_comment', true)) _composer(s),
      ];

  Widget _comment(AppState s, Map<String, dynamic> c) {
    final uid = (c['user_id'] ?? c['created_by'] ?? '').toString();
    final text = CosRichText.fromJson(c['content']);
    final at = DateTime.tryParse(c['created_at']?.toString() ?? '');
    final canDelete = c['permissions'] is Map ? (c['permissions'] as Map)['can_delete'] == true : uid == s.me.userId;
    final files = [for (final a in (c['attachments'] as List? ?? const [])) if (a is Map) a];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        FsAvatar(name: s.userName(uid), seed: uid, size: 28),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Text(s.userName(uid), style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              const SizedBox(width: 8),
              Text(fmtRelative(at?.toLocal()), style: const TextStyle(fontSize: 12, color: Fs.text3)),
              const Spacer(),
              if (canDelete)
                FsIconButton(
                  icon: Icons.delete_outline_rounded,
                  tooltip: '删除评论',
                  size: 16,
                  onPressed: () async {
                    final ok = await confirmDialog(context, title: '删除评论', content: '确定删除这条评论吗？', ok: '删除', danger: true);
                    if (ok) _run(() => s.api.deleteTaskComment(t.taskId, c['comment_id'].toString()), notify: false);
                  },
                ),
            ]),
            const SizedBox(height: 2),
            if (text.text.isNotEmpty) _richText(text),
            for (final a in files)
              _isImage(a['name']?.toString() ?? '', a['mime_type']?.toString())
                  ? ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 240, maxHeight: 180),
                      child: DocImage(url: 'cos-file://${a['file_key']}', alt: a['name']?.toString() ?? ''),
                    )
                  : AttachmentCard(
                      url: 'cos-file://${a['file_key']}?name=${Uri.encodeQueryComponent(a['name']?.toString() ?? '')}&size=${a['size'] ?? 0}',
                      label: a['name']?.toString() ?? '附件',
                    ),
          ]),
        ),
      ]),
    );
  }

  Widget _richText(CosRichText rt) {
    if (rt.mentions.isEmpty) return SelectableText(rt.text, style: const TextStyle(fontSize: 14, height: 1.5));
    final spans = <TextSpan>[];
    var i = 0;
    for (final m in [...rt.mentions]..sort((a, b) => a.offset.compareTo(b.offset))) {
      if (m.offset < i || m.offset + m.length > rt.text.length) continue;
      spans.add(TextSpan(text: rt.text.substring(i, m.offset)));
      spans.add(TextSpan(text: rt.text.substring(m.offset, m.offset + m.length), style: const TextStyle(color: Fs.primary)));
      i = m.offset + m.length;
    }
    spans.add(TextSpan(text: rt.text.substring(i)));
    return SelectableText.rich(TextSpan(style: const TextStyle(fontSize: 14, height: 1.5, color: Fs.text1), children: spans));
  }

  static bool _isImage(String name, String? mime) =>
      (mime ?? '').startsWith('image/') || RegExp(r'\.(png|jpe?g|gif|webp|bmp)$', caseSensitive: false).hasMatch(name);

  Widget _composer(AppState s) => Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.fromLTRB(10, 4, 4, 4),
        decoration: BoxDecoration(border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(8)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (pending.isNotEmpty || uploading)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Wrap(spacing: 6, runSpacing: 6, children: [
                for (final f in pending)
                  InputChip(
                    avatar: const Icon(Icons.attach_file_rounded, size: 16),
                    label: Text(f.fileName, style: const TextStyle(fontSize: 12)),
                    visualDensity: VisualDensity.compact,
                    onDeleted: () => setState(() => pending.remove(f)),
                  ),
                if (uploading) const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
              ]),
            ),
          Row(children: [
            Expanded(
              child: TextField(
                controller: comment,
                minLines: 1,
                maxLines: 5,
                decoration: const InputDecoration(
                  hintText: '发表评论，输入 @姓名 提及成员',
                  filled: false,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                ),
                onSubmitted: (_) => _send(s),
              ),
            ),
            FsIconButton(icon: Icons.alternate_email_rounded, tooltip: '提及成员', onPressed: () => _mention(s)),
            FsIconButton(icon: Icons.attach_file_rounded, tooltip: '添加图片或附件', onPressed: uploading ? null : () => _attach(s)),
            IconButton(
              tooltip: '发送',
              onPressed: sending ? null : () => _send(s),
              icon: const Icon(Icons.send_rounded, size: 18, color: Fs.primary),
            ),
          ]),
        ]),
      );

  Future<void> _mention(AppState s) async {
    final ids = await pickUsers(context, users: s.users, title: '提及成员');
    if (ids == null || ids.isEmpty) return;
    final add = ids.map((id) => '@${s.userName(id)} ').join();
    comment.text = '${comment.text}${comment.text.isEmpty || comment.text.endsWith(' ') ? '' : ' '}$add';
    comment.selection = TextSelection.collapsed(offset: comment.text.length);
  }

  Future<void> _attach(AppState s) async {
    final f = await FilePicker.pickFile();
    if (f == null || !mounted) return;
    setState(() => uploading = true);
    try {
      final bytes = await f.readAsBytes();
      if (bytes.length > 20 * 1024 * 1024) throw const CosApiException(0, '单个附件不能超过 20 MB');
      final ref = await s.api.uploadBytes(f.name, bytes, ref: {'type': 'task', 'id': t.taskId});
      if (mounted) setState(() => pending.add(ref));
    } catch (e) {
      if (mounted) showToast(context, '上传失败：${describeError(e)}', error: true);
    } finally {
      if (mounted) setState(() => uploading = false);
    }
  }

  Future<void> _send(AppState s) async {
    final text = comment.text.trim();
    if (text.isEmpty && pending.isEmpty) return;
    setState(() => sending = true);
    final ok = await _run(
      () => s.api.addTaskComment(t.taskId, CosRichText.parse(text, s.users), [
        for (final f in pending)
          {'file_key': f.fileKey, 'name': f.fileName, 'size': f.size, if (f.contentType != null) 'mime_type': f.contentType},
      ]),
      notify: false,
    );
    if (!mounted) return;
    setState(() {
      sending = false;
      if (ok) {
        comment.clear();
        pending.clear();
      }
    });
  }

  List<Widget> _activities(AppState s) {
    if (activities.isEmpty) {
      return const [Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('暂无动态', style: TextStyle(fontSize: 13, color: Fs.text3)))];
    }
    return [
      for (final a in activities)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Padding(padding: EdgeInsets.only(top: 6), child: Icon(Icons.circle, size: 6, color: Fs.textDisabled)),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(activityText(s, a), style: const TextStyle(fontSize: 13, color: Fs.text1, height: 1.5)),
                Text(fmtRelative(DateTime.tryParse(a['at']?.toString() ?? '')?.toLocal()),
                    style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ]),
            ),
          ]),
        ),
    ];
  }
}

/// 动态由前端按结构拼文案，不依赖后端的中文句子。
String activityText(AppState s, Map<String, dynamic> a) {
  final who = s.userName((a['operator_id'] ?? '').toString());
  final changes = [for (final c in (a['changes'] as List? ?? const [])) if (c is Map) c];
  if (changes.isEmpty) return '$who ${_actionLabels[a['action']] ?? '修改了任务'}';
  final parts = [
    for (final c in changes)
      () {
        final f = c['field_name']?.toString() ?? '';
        final label = _fieldLabels[f] ?? f;
        final before = _value(s, f, c['before']), after = _value(s, f, c['after']);
        if (before.isEmpty) return '把$label设为「$after」';
        if (after.isEmpty) return '清空了$label（原为「$before」）';
        return '把$label从「$before」改为「$after」';
      }(),
  ];
  return '$who ${parts.join('，')}';
}

String _value(AppState s, String field, dynamic v) {
  if (v == null || v == '') return '';
  if (field == 'status') return kTaskStatus[v.toString()]?.$1 ?? v.toString();
  if (field == 'assignee_id') return s.userName(v.toString());
  if (field == 'due_ms' && v is num) return fmtDateTime(DateTime.fromMillisecondsSinceEpoch(v.toInt()));
  if (field == 'priority') return const {'high': '高', 'normal': '普通', 'low': '低', 'urgent': '紧急'}[v.toString()] ?? v.toString();
  if (v is List) return v.map((e) => field == 'follower_ids' ? s.userName(e.toString()) : e.toString()).join('、');
  return v.toString();
}
