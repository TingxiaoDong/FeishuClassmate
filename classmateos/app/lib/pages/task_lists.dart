/// 任务清单（R-TK-04）：自定义分组，列表 / 看板两种视图，拖动在分组间移动。
library;

import 'package:flutter/material.dart';

import '../api/phase2_tasks.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/share_panel.dart';
import 'tasks_page.dart';

Future<String?> promptName(BuildContext context, String title, {String initial = '', String hint = ''}) {
  final c = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: SizedBox(
        width: 360,
        child: TextField(controller: c, autofocus: true, decoration: InputDecoration(hintText: hint), onSubmitted: (v) => Navigator.pop(ctx, v.trim())),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('确定')),
      ],
    ),
  );
}

class TaskListView extends StatefulWidget {
  final CosTaskList list;
  final void Function(CosTask t) onOpen;
  final VoidCallback onListsChanged;

  /// 窄屏没有左栏时显示返回按钮。
  final VoidCallback? onBack;
  const TaskListView({super.key, required this.list, required this.onOpen, required this.onListsChanged, this.onBack});
  @override
  State<TaskListView> createState() => TaskListViewState();
}

class TaskListViewState extends State<TaskListView> {
  List<Map<String, dynamic>> sections = [];
  List<CosTask> tasks = [];
  bool loading = true, board = false;
  String? error;
  final Map<String, TextEditingController> _quick = {};

  CosTaskList get l => widget.list;
  bool get canEdit => l.can('can_edit') || l.can('can_manage');

  @override
  void initState() {
    super.initState();
    reload();
  }

  @override
  void dispose() {
    for (final c in _quick.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> reload() async {
    final api = AppScope.read(context).api;
    try {
      final r = await Future.wait([api.taskSections(l.id), api.tasksInList(l.id)]);
      if (!mounted) return;
      setState(() {
        sections = r[0] as List<Map<String, dynamic>>;
        tasks = r[1] as List<CosTask>;
        loading = false;
        error = null;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  Future<void> _run(Future<void> Function() f, {bool lists = false}) async {
    try {
      await f();
      await reload();
      if (lists) widget.onListsChanged();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  /// 分组：后端返回的分组 + 「未分组」（任务没有 section_id 或分组已删除）。
  List<(String?, String)> get _columns {
    final ids = {for (final s in sections) s['section_id'].toString()};
    return [
      if (tasks.any((t) => t.sectionIn(l.id) == null || !ids.contains(t.sectionIn(l.id)))) (null, '未分组'),
      for (final s in sections) (s['section_id'].toString(), s['name']?.toString() ?? ''),
    ];
  }

  List<CosTask> _in(String? sid) {
    final ids = {for (final s in sections) s['section_id'].toString()};
    return tasks.where((t) {
      final x = t.sectionIn(l.id);
      return sid == null ? (x == null || !ids.contains(x)) : x == sid;
    }).toList();
  }

  Future<void> _move(CosTask t, String? sid) async {
    if (t.sectionIn(l.id) == sid) return;
    await _run(() => AppScope.read(context).api.putTaskInList(t.taskId, l.id, sid));
  }

  Future<void> _quickAdd(String? sid, String text) async {
    if (text.trim().isEmpty) return;
    final s = AppScope.read(context);
    await _run(() async {
      final t = await s.api.createTask(title: text.trim(), assigneeId: s.me.userId);
      await s.api.putTaskInList(t.taskId, l.id, sid);
    });
  }

  Future<void> _menu(String v) async {
    final api = AppScope.read(context).api;
    switch (v) {
      case 'section':
        final n = await promptName(context, '新建分组', hint: '如：待开始、实验中、写论文');
        if (n != null && n.isNotEmpty) await _run(() => api.saveTaskSection(l.id, n));
      case 'rename':
        final n = await promptName(context, '重命名清单', initial: l.name);
        if (n != null && n.isNotEmpty && n != l.name) await _run(() => api.saveTaskList({'name': n}, id: l.id), lists: true);
      case 'members':
        await showSharePanel(
          context,
          ShareConfig(
            title: '清单成员「${l.name}」',
            load: () => api.taskListMembers(l.id),
            save: (s) => api.saveTaskListMembers(l.id, s),
            roles: const ['viewer', 'editor'],
            defaultRole: 'editor',
            canManage: l.can('can_manage'),
          ),
        );
      case 'delete':
        if (!mounted) return;
        final ok = await confirmDialog(context,
            title: '删除清单', content: '删除「${l.name}」后，清单里的任务不会被删除，只是不再属于这个清单。', ok: '删除', danger: true);
        if (ok) await _run(() => api.deleteTaskList(l.id), lists: true);
    }
  }

  Future<void> _sectionMenu(String sid, String name, String v) async {
    final api = AppScope.read(context).api;
    if (v == 'rename') {
      final n = await promptName(context, '重命名分组', initial: name);
      if (n != null && n.isNotEmpty && n != name) await _run(() => api.saveTaskSection(l.id, n, sectionId: sid));
    } else {
      if (!mounted) return;
      final ok = await confirmDialog(context, title: '删除分组', content: '分组「$name」里的任务会移到「未分组」。', ok: '删除', danger: true);
      if (ok) await _run(() => api.deleteTaskSection(l.id, sid));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      child: Column(children: [
        Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Row(children: [
            if (widget.onBack != null) FsIconButton(icon: Icons.arrow_back_rounded, tooltip: '返回', onPressed: widget.onBack),
            const Icon(Icons.checklist_rounded, size: 20, color: Fs.primary),
            const SizedBox(width: 8),
            Flexible(child: Text(l.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600))),
            const SizedBox(width: 8),
            Text('${tasks.length}', style: const TextStyle(fontSize: 13, color: Fs.text3)),
            if (!canEdit) ...[const SizedBox(width: 8), const FsTag('只读', color: TagColor.gray)],
            const Spacer(),
            SegmentedButton<bool>(
              showSelectedIcon: false,
              style: const ButtonStyle(visualDensity: VisualDensity.compact),
              segments: [
                ButtonSegment(value: false, icon: const Icon(Icons.view_list_rounded, size: 18), label: widget.onBack == null ? const Text('列表') : null, tooltip: '列表'),
                ButtonSegment(value: true, icon: const Icon(Icons.view_kanban_outlined, size: 18), label: widget.onBack == null ? const Text('看板') : null, tooltip: '看板'),
              ],
              selected: {board},
              onSelectionChanged: (v) => setState(() => board = v.first),
            ),
            const SizedBox(width: 4),
            FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', onPressed: reload),
            PopupMenuButton<String>(
              tooltip: '更多',
              icon: const Icon(Icons.more_horiz_rounded, size: 20),
              onSelected: _menu,
              itemBuilder: (_) => [
                if (canEdit) const PopupMenuItem(value: 'section', child: Text('新建分组')),
                const PopupMenuItem(value: 'members', child: Text('成员与权限')),
                if (l.can('can_manage')) const PopupMenuItem(value: 'rename', child: Text('重命名清单')),
                if (l.can('can_manage') || l.can('can_delete'))
                  const PopupMenuItem(value: 'delete', child: Text('删除清单', style: TextStyle(color: Fs.red))),
              ],
            ),
          ]),
        ),
        if (l.description.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Align(alignment: Alignment.centerLeft, child: Text(l.description, style: const TextStyle(fontSize: 13, color: Fs.text3))),
          ),
        const Divider(height: 1),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : error != null
                  ? EmptyState(icon: Icons.cloud_off_outlined, title: '清单加载失败', subtitle: error, action: OutlinedButton(onPressed: reload, child: const Text('重试')))
                  : sections.isEmpty && tasks.isEmpty
                      ? EmptyState(
                          icon: Icons.checklist_rounded,
                          title: '清单还是空的',
                          subtitle: canEdit ? '先新建一个分组，再往里添加任务' : '还没有任务',
                          action: canEdit ? FilledButton(onPressed: () => _menu('section'), child: const Text('新建分组')) : null,
                        )
                      : board
                          ? _board()
                          : _listView(),
        ),
      ]),
    );
  }

  Widget _taskTile(CosTask t, {bool card = false}) {
    final s = AppScope.of(context);
    final overdue = t.due != null && t.due!.isBefore(DateTime.now()) && !t.isDone;
    final body = Row(children: [
      Icon(t.isDone ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded,
          size: 18, color: t.isDone ? const Color(0xFF2EA121) : Fs.textDisabled),
      const SizedBox(width: 8),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(t.title,
              maxLines: card ? 3 : 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 14, color: t.isDone ? Fs.text3 : Fs.text1, decoration: t.isDone ? TextDecoration.lineThrough : null)),
          if (t.due != null || t.subtaskCount > 0)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Wrap(spacing: 10, children: [
                if (t.due != null)
                  Text(fmtDue(t.due!), style: TextStyle(fontSize: 12, color: overdue ? Fs.red : Fs.text3)),
                if (t.subtaskCount > 0)
                  Text('子任务 ${t.subtaskDoneCount}/${t.subtaskCount}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ]),
            ),
        ]),
      ),
      if (t.assigneeId != null) ...[
        const SizedBox(width: 8),
        Tooltip(message: s.userName(t.assigneeId!), child: FsAvatar(name: s.userName(t.assigneeId!), seed: t.assigneeId, size: 22)),
      ],
    ]);
    final tile = card
        ? Card(
            elevation: 0,
            margin: const EdgeInsets.only(bottom: 8),
            shape: RoundedRectangleBorder(side: const BorderSide(color: Fs.line), borderRadius: BorderRadius.circular(8)),
            child: InkWell(borderRadius: BorderRadius.circular(8), onTap: () => widget.onOpen(t), child: Padding(padding: const EdgeInsets.all(10), child: body)),
          )
        : HoverBox(onTap: () => widget.onOpen(t), padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9), child: body);
    if (!canEdit) return tile;
    return Draggable<CosTask>(
      data: t,
      feedback: Material(
        elevation: 6,
        borderRadius: BorderRadius.circular(8),
        child: Container(width: 260, padding: const EdgeInsets.all(10), child: Text(t.title, maxLines: 2, overflow: TextOverflow.ellipsis)),
      ),
      childWhenDragging: Opacity(opacity: 0.35, child: tile),
      child: tile,
    );
  }

  Widget _dropZone(String? sid, Widget child) => DragTarget<CosTask>(
        onWillAcceptWithDetails: (d) => canEdit && d.data.sectionIn(l.id) != sid,
        onAcceptWithDetails: (d) => _move(d.data, sid),
        builder: (ctx, cand, _) => AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          decoration: BoxDecoration(
            color: cand.isNotEmpty ? Fs.primary.withValues(alpha: 0.06) : null,
            borderRadius: BorderRadius.circular(8),
          ),
          child: child,
        ),
      );

  Widget _sectionHeader(String? sid, String name, int n) => Row(children: [
        Text(name, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        const SizedBox(width: 8),
        Text('$n', style: const TextStyle(fontSize: 12, color: Fs.text3)),
        const Spacer(),
        if (sid != null && canEdit)
          PopupMenuButton<String>(
            tooltip: '分组操作',
            icon: const Icon(Icons.more_horiz_rounded, size: 18, color: Fs.text3),
            onSelected: (v) => _sectionMenu(sid, name, v),
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'rename', child: Text('重命名分组')),
              PopupMenuItem(value: 'delete', child: Text('删除分组', style: TextStyle(color: Fs.red))),
            ],
          ),
      ]);

  Widget _quickField(String? sid) {
    final c = _quick.putIfAbsent(sid ?? '_', TextEditingController.new);
    return TextField(
      controller: c,
      onSubmitted: (v) {
        c.clear();
        _quickAdd(sid, v);
      },
      decoration: const InputDecoration(
        isDense: true,
        hintText: '添加任务，回车保存',
        prefixIcon: Icon(Icons.add_rounded, size: 18, color: Fs.primary),
        filled: false,
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
      ),
    );
  }

  Widget _listView() => ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          for (final (sid, name) in _columns)
            _dropZone(
              sid,
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  SizedBox(height: 36, child: _sectionHeader(sid, name, _in(sid).length)),
                  for (final t in _in(sid)) _taskTile(t),
                  if (canEdit) _quickField(sid),
                ]),
              ),
            ),
        ],
      );

  Widget _board() => ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.all(16),
        children: [
          for (final (sid, name) in _columns)
            Container(
              width: 280,
              margin: const EdgeInsets.only(right: 12),
              decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(10)),
              child: _dropZone(
                sid,
                Padding(
                  padding: const EdgeInsets.all(10),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    SizedBox(height: 36, child: _sectionHeader(sid, name, _in(sid).length)),
                    Expanded(child: ListView(children: [for (final t in _in(sid)) _taskTile(t, card: true)])),
                    if (canEdit) _quickField(sid),
                  ]),
                ),
              ),
            ),
        ],
      );
}

/// 新建清单（可选关联 Projects 表的一条项目记录，由后端校验）。
Future<CosTaskList?> createTaskListDialog(BuildContext context) async {
  final name = TextEditingController(), desc = TextEditingController();
  return showDialog<CosTaskList>(
    context: context,
    builder: (ctx) {
      String? err;
      var saving = false;
      return StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: const Text('新建任务清单'),
          content: SizedBox(
            width: 420,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: name, autofocus: true, decoration: InputDecoration(labelText: '清单名称', hintText: '如：RLHF 项目', errorText: err)),
              const SizedBox(height: 12),
              TextField(controller: desc, maxLines: 2, decoration: const InputDecoration(labelText: '说明（可选）')),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(
              onPressed: saving
                  ? null
                  : () async {
                      if (name.text.trim().isEmpty) return set(() => err = '请填写清单名称');
                      set(() => saving = true);
                      try {
                        final l = await AppScope.read(context).api.saveTaskList({
                          'name': name.text.trim(),
                          if (desc.text.trim().isNotEmpty) 'description': desc.text.trim(),
                        });
                        if (ctx.mounted) Navigator.pop(ctx, l);
                      } catch (e) {
                        set(() {
                          saving = false;
                          err = describeError(e);
                        });
                      }
                    },
              child: const Text('创建'),
            ),
          ],
        ),
      );
    },
  );
}

/// 任务详情里「所属清单」：加入 / 移出清单。
class TaskListMembership extends StatelessWidget {
  final CosTask task;
  final List<CosTaskList> lists;
  final VoidCallback onChanged;
  const TaskListMembership({super.key, required this.task, required this.lists, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final api = AppScope.of(context).api;
    String nameOf(String id) => lists.where((x) => x.id == id).firstOrNull?.name ?? '';
    Future<void> run(Future<void> Function() f) async {
      try {
        await f();
        onChanged();
      } catch (e) {
        if (context.mounted) showToast(context, describeError(e), error: true);
      }
    }

    final joined = {for (final r in task.tasklists) r.listId};
    return Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
      for (final r in task.tasklists)
        InputChip(
          label: Text(r.name ?? nameOf(r.listId)),
          onDeleted: () => run(() => api.removeTaskFromList(task.taskId, r.listId)),
          deleteButtonTooltipMessage: '移出清单',
        ),
      PopupMenuButton<String>(
        tooltip: '加入清单',
        onSelected: (id) => run(() => api.putTaskInList(task.taskId, id, null)),
        itemBuilder: (_) => [
          for (final l in lists.where((x) => !joined.contains(x.id) && (x.can('can_edit') || x.can('can_manage'))))
            PopupMenuItem(value: l.id, child: Text(l.name)),
        ],
        child: const Padding(
          padding: EdgeInsets.all(4),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.add_rounded, size: 16, color: Fs.primary),
            Text('加入清单', style: TextStyle(fontSize: 13, color: Fs.primary)),
          ]),
        ),
      ),
    ]);
  }
}

