/// 任务：筛选（我负责的 / 我创建的 / 全部 / 已完成）+ 按状态分组列表 + 详情面板。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'task_extras.dart';
import 'task_lists.dart';
import '../api/phase2_tasks.dart';

const kTaskStatus = {
  'in_progress': ('进行中', TagColor.blue, Icons.timelapse_rounded),
  'pending': ('待开始', TagColor.orange, Icons.radio_button_unchecked_rounded),
  'done': ('已完成', TagColor.green, Icons.check_circle_rounded),
  'cancelled': ('已取消', TagColor.gray, Icons.cancel_outlined),
};

enum _TaskFilter {
  assigned('我负责的', Icons.person_pin_outlined),
  followed('我关注的', Icons.visibility_outlined),
  created('我创建的', Icons.edit_note_rounded),
  all('全部任务', Icons.list_alt_rounded),
  done('已完成', Icons.task_alt_rounded);

  final String label;
  final IconData icon;
  const _TaskFilter(this.label, this.icon);
}

String fmtDue(DateTime d) {
  final now = DateTime.now();
  final days = dayStart(d).difference(dayStart(now)).inDays;
  final time = d.hour == 0 && d.minute == 0 ? '' : ' ${fmtHm(d)}';
  if (days == 0) return '今天$time';
  if (days == 1) return '明天$time';
  if (days == -1) return '昨天$time';
  if (d.year == now.year) return '${fmtDateCn(d)}$time';
  return '${fmtDate(d)}$time';
}

class TasksPage extends StatefulWidget {
  const TasksPage({super.key});
  @override
  State<TasksPage> createState() => _TasksPageState();
}

class _TasksPageState extends State<TasksPage> {
  StreamSubscription<CosEvent>? _liveEvents;
  List<CosTask> tasks = [];
  bool loading = true;
  String? error;
  _TaskFilter filter = _TaskFilter.assigned;
  String? selectedId;
  final quick = TextEditingController();
  final Set<String> collapsed = {'cancelled'};
  bool inlineDetail = false;

  // 迭代 3：我关注的、任务清单
  List<CosTask> followed = [];
  List<CosTaskList> lists = [];
  CosTaskList? openList;
  CosTask? listSel;
  final _listKey = GlobalKey<TaskListViewState>();

  List<_TaskFilter> _filters(AppState s) =>
      [for (final f in _TaskFilter.values) if (f != _TaskFilter.followed || s.feature('task.followers')) f];

  @override
  void initState() {
    super.initState();
    _liveEvents = AppScope.read(context).eventStream.listen((e) {
      if (!mounted) return;
      if (e.eventType.startsWith('calendar.') || e.eventType.startsWith('task.') || e.eventType.startsWith('tasklist.') || e.eventType == 'resync.required') {
        _load();
        _listKey.currentState?.reload();
      }
    });
    _load();
  }

  @override
  void dispose() {
    _liveEvents?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final s = AppScope.read(context);
      final r = await Future.wait([
        s.api.listTasks(),
        s.feature('task.followers') ? s.api.listTasks(followerId: 'me') : Future.value(<CosTask>[]),
      ]);
      final ls = s.feature('task.lists') ? await s.api.taskLists() : <CosTaskList>[];
      if (!mounted) return;
      setState(() {
        tasks = r[0];
        followed = r[1];
        lists = ls;
        if (openList != null) openList = ls.where((x) => x.id == openList!.id).firstOrNull;
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

  List<CosTask> _apply(_TaskFilter f, String me) => switch (f) {
        _TaskFilter.assigned => tasks.where((t) => t.assigneeId == me).toList(),
        _TaskFilter.followed => followed,
        _TaskFilter.created => tasks.where((t) => t.createdBy == me).toList(),
        _TaskFilter.all => tasks,
        _TaskFilter.done => tasks.where((t) => t.isDone).toList(),
      };

  void _remove(String id) {
    setState(() {
      tasks.removeWhere((x) => x.taskId == id);
      followed.removeWhere((x) => x.taskId == id);
      if (selectedId == id) selectedId = null;
      if (listSel?.taskId == id) listSel = null;
    });
    _listKey.currentState?.reload();
  }

  void _replace(CosTask t) {
    final i = tasks.indexWhere((x) => x.taskId == t.taskId);
    final j = followed.indexWhere((x) => x.taskId == t.taskId);
    setState(() {
      if (t.parentId == null) i >= 0 ? tasks[i] = t : tasks.insert(0, t);
      if (j >= 0) followed[j] = t;
      if (listSel?.taskId == t.taskId) listSel = t;
    });
    _listKey.currentState?.reload();
  }

  Future<void> _toggle(CosTask t) async {
    try {
      _replace(await AppScope.read(context).api.updateTask(t.taskId, status: t.isDone ? 'pending' : 'done'));
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _quickAdd() async {
    final text = quick.text.trim();
    if (text.isEmpty) return;
    final s = AppScope.read(context);
    try {
      final t = await s.api.createTask(title: text, assigneeId: s.me.userId);
      quick.clear();
      _replace(t);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _newTask() async {
    final t = await showScopedDialog<CosTask>(context, (_) => const _TaskCreateDialog());
    if (t != null) {
      _replace(t);
      setState(() => selectedId = t.taskId);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 860;
      final detailW = c.maxWidth >= 1180;
      inlineDetail = detailW;
      final sel = openList != null
          ? listSel
          : [...tasks, ...followed].where((t) => t.taskId == selectedId).firstOrNull;
      return Row(children: [
        if (wide) SizedBox(width: 220, child: _sidebar(s)),
        if (wide) const VerticalDivider(width: 1),
        Expanded(
          child: openList != null
              ? TaskListView(
                  key: _listKey,
                  list: openList!,
                  onOpen: (t) => _openTask(t),
                  onListsChanged: _load,
                  onBack: wide ? null : () => setState(() => openList = null),
                )
              : _list(context, s, wide),
        ),
        if (sel != null && detailW) ...[
          const VerticalDivider(width: 1),
          SizedBox(
            width: 380,
            child: TaskDetail(
              key: ValueKey(sel.taskId),
              task: sel,
              onChanged: _replace,
              onDeleted: () => _remove(sel.taskId),
              onClose: () => setState(() {
                selectedId = null;
                listSel = null;
              }),
            ),
          ),
        ],
      ]);
    });
  }

  Widget _sidebar(AppState s) => Container(
        color: Fs.bg,
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(6, 4, 6, 14),
            child: Text('任务', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          ),
          SizedBox(
            height: 38,
            child: FilledButton.icon(
              onPressed: _newTask,
              icon: const Icon(Icons.add_rounded, size: 18),
              label: const Text('新建任务'),
            ),
          ),
          const SizedBox(height: 14),
          for (final f in _filters(s))
            HoverBox(
              selected: openList == null && filter == f,
              hoverColor: const Color(0xFFE8E9EB),
              onTap: () => setState(() {
                filter = f;
                openList = null;
                listSel = null;
              }),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
              margin: const EdgeInsets.only(bottom: 2),
              child: Row(children: [
                Icon(f.icon, size: 18, color: filter == f ? Fs.primary : Fs.text2),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(f.label,
                      style: TextStyle(fontSize: 14, color: filter == f ? Fs.primary : Fs.text1)),
                ),
                Text('${_apply(f, s.me.userId).where((t) => f == _TaskFilter.done || !t.isDone).length}',
                    style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ]),
            ),
          if (s.feature('task.lists')) ...[
            const SizedBox(height: 18),
            Row(children: [
              const Padding(
                padding: EdgeInsets.only(left: 6),
                child: Text('任务清单', style: TextStyle(fontSize: 12, color: Fs.text3)),
              ),
              const Spacer(),
              FsIconButton(icon: Icons.add_rounded, tooltip: '新建清单', size: 16, onPressed: _newList),
            ]),
            Expanded(
              child: lists.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.all(8),
                      child: Text('按项目建一个清单，把相关任务放在一起', style: TextStyle(fontSize: 12, color: Fs.text3)),
                    )
                  : ListView(children: [
                      for (final l in lists)
                        HoverBox(
                          selected: openList?.id == l.id,
                          hoverColor: const Color(0xFFE8E9EB),
                          onTap: () => setState(() {
                            openList = l;
                            listSel = null;
                          }),
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                          margin: const EdgeInsets.only(bottom: 2),
                          child: Row(children: [
                            Icon(Icons.checklist_rounded, size: 18, color: openList?.id == l.id ? Fs.primary : Fs.text2),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(l.name,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(fontSize: 14, color: openList?.id == l.id ? Fs.primary : Fs.text1)),
                            ),
                          ]),
                        ),
                    ]),
            ),
          ],
        ]),
      );

  Future<void> _newList() async {
    final l = await createTaskListDialog(context);
    if (l == null || !mounted) return;
    await _load();
    setState(() {
      openList = lists.where((x) => x.id == l.id).firstOrNull ?? l;
      listSel = null;
    });
  }

  /// 清单里点任务：宽屏右侧打开详情，窄屏进入详情页。
  void _openTask(CosTask t) {
    if (inlineDetail) {
      setState(() => listSel = t);
      return;
    }
    pushScoped(
      context,
      Scaffold(
        appBar: AppBar(title: const Text('任务详情')),
        body: Builder(
          builder: (ctx) => TaskDetail(
            task: t,
            onChanged: _replace,
            onDeleted: () {
              _remove(t.taskId);
              _listKey.currentState?.reload();
              Navigator.of(ctx).maybePop();
            },
          ),
        ),
      ),
    );
  }

  Widget _list(BuildContext context, AppState s, bool wide) {
    final list = _apply(filter, s.me.userId);
    final groups = filter == _TaskFilter.done
        ? ['done']
        : ['in_progress', 'pending', 'done', 'cancelled'];
    final now = DateTime.now();
    return Container(
      color: Colors.white,
      child: Column(children: [
        Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Row(children: [
            Text(filter.label, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text('${list.length}', style: const TextStyle(fontSize: 13, color: Fs.text3)),
            const Spacer(),
            FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', onPressed: _load),
            if (!wide)
              PopupMenuButton<_TaskFilter>(
                tooltip: '筛选',
                icon: const Icon(Icons.filter_list_rounded, size: 20),
                onSelected: (f) => setState(() => filter = f),
                itemBuilder: (_) => [
                  for (final f in _filters(s)) CheckedPopupMenuItem(value: f, checked: f == filter, child: Text(f.label)),
                ],
              ),
            if (!wide && s.feature('task.lists'))
              PopupMenuButton<String>(
                tooltip: '任务清单',
                icon: const Icon(Icons.checklist_rounded, size: 20),
                onSelected: (id) => id == '_new'
                    ? _newList()
                    : setState(() {
                        openList = lists.firstWhere((l) => l.id == id);
                        listSel = null;
                      }),
                itemBuilder: (_) => [
                  for (final l in lists) PopupMenuItem(value: l.id, child: Text(l.name)),
                  if (lists.isNotEmpty) const PopupMenuDivider(),
                  const PopupMenuItem(value: '_new', child: Text('新建清单')),
                ],
              ),
            if (!wide)
              IconButton(onPressed: _newTask, icon: const Icon(Icons.add_rounded), tooltip: '新建任务'),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Container(
            decoration: BoxDecoration(
              border: Border.all(color: Fs.line),
              borderRadius: BorderRadius.circular(8),
            ),
            child: TextField(
              controller: quick,
              onSubmitted: (_) => _quickAdd(),
              decoration: const InputDecoration(
                hintText: '添加任务，回车保存（默认由我负责）',
                prefixIcon: Icon(Icons.add_rounded, size: 20, color: Fs.primary),
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: EdgeInsets.symmetric(vertical: 12),
              ),
            ),
          ),
        ),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : error != null
                  ? EmptyState(
                      icon: Icons.cloud_off_outlined,
                      title: '任务加载失败',
                      subtitle: error,
                      action: OutlinedButton(onPressed: _load, child: const Text('重试')),
                    )
                  : list.isEmpty
                      ? EmptyState(
                          icon: Icons.task_alt_rounded,
                          title: filter == _TaskFilter.done ? '还没有完成的任务' : '暂无任务',
                          subtitle: '在上方输入框里快速添加一个任务',
                        )
                      : ListView(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                          children: [
                            for (final g in groups) ..._group(context, s, g, list.where((t) => t.status == g).toList(), now),
                          ],
                        ),
        ),
      ]),
    );
  }

  List<Widget> _group(BuildContext context, AppState s, String status, List<CosTask> items, DateTime now) {
    if (items.isEmpty) return const [];
    final (label, color, _) = kTaskStatus[status]!;
    final isCollapsed = collapsed.contains(status);
    items.sort((a, b) {
      if (a.due == null && b.due == null) return (b.createdAt ?? DateTime(0)).compareTo(a.createdAt ?? DateTime(0));
      if (a.due == null) return 1;
      if (b.due == null) return -1;
      return a.due!.compareTo(b.due!);
    });
    return [
      HoverBox(
        onTap: () => setState(() => isCollapsed ? collapsed.remove(status) : collapsed.add(status)),
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
        margin: const EdgeInsets.only(top: 8),
        child: Row(children: [
          AnimatedRotation(
            turns: isCollapsed ? -0.25 : 0,
            duration: const Duration(milliseconds: 150),
            child: const Icon(Icons.expand_more_rounded, size: 18, color: Fs.text2),
          ),
          const SizedBox(width: 4),
          FsTag(label, color: color),
          const SizedBox(width: 8),
          Text('${items.length}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
        ]),
      ),
      if (!isCollapsed)
        for (final t in items) _row(context, s, t, now),
    ];
  }

  Widget _row(BuildContext context, AppState s, CosTask t, DateTime now) {
    final overdue = t.due != null && t.due!.isBefore(now) && !t.isDone && t.status != 'cancelled';
    return HoverBox(
      selected: t.taskId == selectedId,
      onTap: () {
        if (inlineDetail) {
          setState(() => selectedId = t.taskId);
        } else {
          pushScoped(
            context,
            Scaffold(
              appBar: AppBar(title: const Text('任务详情')),
              body: Builder(
                builder: (ctx) => TaskDetail(
                  task: t,
                  onChanged: _replace,
                  onDeleted: () {
                    _remove(t.taskId);
                    Navigator.of(ctx).maybePop();
                  },
                ),
              ),
            ),
          );
        }
      },
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
      child: Row(children: [
        InkWell(
          customBorder: const CircleBorder(),
          onTap: () => _toggle(t),
          child: Padding(
            padding: const EdgeInsets.all(2),
            child: Icon(
              t.isDone ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded,
              size: 20,
              color: t.isDone ? const Color(0xFF2EA121) : Fs.textDisabled,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(
              t.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 14,
                color: t.isDone || t.status == 'cancelled' ? Fs.text3 : Fs.text1,
                decoration: t.isDone ? TextDecoration.lineThrough : null,
              ),
            ),
            if (t.description != null && t.description!.isNotEmpty)
              Text(t.description!.replaceAll('\n', ' '),
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text3)),
          ]),
        ),
        if (t.subtaskCount > 0) ...[
          const SizedBox(width: 10),
          Tooltip(
            message: '子任务完成进度',
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.account_tree_outlined, size: 14, color: Fs.text3),
              const SizedBox(width: 3),
              Text('${t.subtaskDoneCount}/${t.subtaskCount}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
            ]),
          ),
        ],
        if (t.due != null) ...[
          const SizedBox(width: 10),
          Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.event_outlined, size: 14, color: overdue ? Fs.red : Fs.text3),
            const SizedBox(width: 3),
            Text(fmtDue(t.due!), style: TextStyle(fontSize: 12, color: overdue ? Fs.red : Fs.text3)),
          ]),
        ],
        const SizedBox(width: 14),
        if (t.assigneeId != null)
          Tooltip(
            message: '负责人：${s.userName(t.assigneeId!)}',
            child: FsAvatar(name: s.userName(t.assigneeId!), seed: t.assigneeId, size: 24),
          )
        else
          const Tooltip(message: '未指派', child: Icon(Icons.person_outline_rounded, size: 20, color: Fs.textDisabled)),
      ]),
    );
  }
}

// ---------------- 任务详情 ----------------

class TaskDetail extends StatefulWidget {
  final CosTask task;
  final ValueChanged<CosTask> onChanged;
  final VoidCallback? onClose;
  final VoidCallback? onDeleted;
  const TaskDetail({super.key, required this.task, required this.onChanged, this.onClose, this.onDeleted});
  @override
  State<TaskDetail> createState() => _TaskDetailState();
}

class _TaskDetailState extends State<TaskDetail> {
  late CosTask t = widget.task;
  late final title = TextEditingController(text: t.title);
  late final desc = TextEditingController(text: t.description ?? '');
  bool descDirty = false;

  Future<void> _update({
    String? title,
    String? status,
    DateTime? due,
    bool clearDue = false,
    String? assigneeId,
    bool clearAssignee = false,
    String? description,
  }) async {
    try {
      final r = await AppScope.read(context).api.updateTask(t.taskId,
          title: title,
          status: status,
          due: due,
          clearDue: clearDue,
          assigneeId: assigneeId,
          clearAssignee: clearAssignee,
          description: description);
      setState(() => t = r);
      widget.onChanged(r);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    // 后端给了 permissions 就按后端（R-TK-05），否则沿用一期规则：创建人、负责人可改，创建人可删。
    final isCreator = t.can('can_delete', t.createdBy == s.me.userId);
    final canEdit = t.can('can_edit', t.createdBy == s.me.userId || t.assigneeId == s.me.userId);
    return Container(
      color: Colors.white,
      child: Column(children: [
        if (widget.onClose != null)
          Container(
            height: 56,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
            child: Row(children: [
              const Text('任务详情', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              const Spacer(),
              if (isCreator) FsIconButton(icon: Icons.delete_outline_rounded, tooltip: '删除任务', onPressed: _delete),
              FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: widget.onClose),
            ]),
          ),
        Expanded(
          child: ListView(padding: const EdgeInsets.all(20), children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: canEdit ? () => _update(status: t.isDone ? 'pending' : 'done') : null,
                  child: Icon(
                    t.isDone ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded,
                    size: 24,
                    color: t.isDone ? const Color(0xFF2EA121) : Fs.textDisabled,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Focus(
                  onFocusChange: (f) {
                    if (!f && title.text.trim().isNotEmpty && title.text.trim() != t.title) {
                      _update(title: title.text.trim());
                    }
                  },
                  child: TextField(
                    controller: title,
                    enabled: canEdit,
                    maxLines: null,
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
                    onSubmitted: (v) => v.trim().isNotEmpty ? _update(title: v.trim()) : null,
                    decoration: const InputDecoration(
                      filled: false,
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      disabledBorder: InputBorder.none,
                      focusedBorder: UnderlineInputBorder(borderSide: BorderSide(color: Fs.primary)),
                      contentPadding: EdgeInsets.symmetric(vertical: 4),
                    ),
                  ),
                ),
              ),
            ]),
            const SizedBox(height: 20),
            _field(
              Icons.flag_outlined,
              '状态',
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final e in kTaskStatus.entries)
                  ChoiceChip(
                    label: Text(e.value.$1),
                    selected: t.status == e.key,
                    showCheckmark: false,
                    visualDensity: VisualDensity.compact,
                    selectedColor: e.value.$2.bg,
                    labelStyle: TextStyle(
                      fontSize: 13,
                      color: t.status == e.key ? e.value.$2.fg : Fs.text2,
                      fontWeight: t.status == e.key ? FontWeight.w600 : FontWeight.normal,
                    ),
                    onSelected: canEdit && t.status != e.key ? (_) => _update(status: e.key) : null,
                  ),
              ]),
            ),
            _field(
              Icons.person_outline_rounded,
              '负责人',
              Row(children: [
                Flexible(
                  child: HoverBox(
                    onTap: canEdit ? () => _pickAssignee(s) : null,
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                    child: t.assigneeId == null
                        ? Text(canEdit ? '点击指派负责人' : '未指派', style: const TextStyle(color: Fs.text3))
                        : Row(mainAxisSize: MainAxisSize.min, children: [
                            FsAvatar(name: s.userName(t.assigneeId!), seed: t.assigneeId, size: 24),
                            const SizedBox(width: 8),
                            Flexible(child: Text(s.userName(t.assigneeId!), overflow: TextOverflow.ellipsis)),
                            if (canEdit) ...[
                              const SizedBox(width: 4),
                              const Icon(Icons.expand_more_rounded, size: 16, color: Fs.text3),
                            ],
                          ]),
                  ),
                ),
                if (canEdit && t.assigneeId != null)
                  FsIconButton(
                    icon: Icons.close_rounded,
                    tooltip: '取消指派',
                    size: 16,
                    onPressed: () => _update(clearAssignee: true),
                  ),
              ]),
            ),
            _field(
              Icons.event_outlined,
              '截止时间',
              Row(children: [
                Expanded(
                  child: DateField(
                    value: t.due,
                    enabled: canEdit,
                    hint: '设置截止时间',
                    onChanged: (d) {
                      if (d != null) _update(due: d);
                    },
                  ),
                ),
                if (canEdit && t.due != null)
                  FsIconButton(
                    icon: Icons.close_rounded,
                    tooltip: '清空截止时间',
                    size: 16,
                    onPressed: () => _update(clearDue: true),
                  ),
              ]),
            ),
            _field(
              Icons.notes_rounded,
              '描述',
              Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                TextField(
                  controller: desc,
                  enabled: canEdit,
                  minLines: 3,
                  maxLines: 10,
                  onChanged: (_) => setState(() => descDirty = desc.text != (t.description ?? '')),
                  decoration: const InputDecoration(hintText: '添加描述'),
                ),
                if (descDirty)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: FilledButton(
                      onPressed: () async {
                        await _update(description: desc.text);
                        if (mounted) setState(() => descDirty = false);
                      },
                      child: const Text('保存描述'),
                    ),
                  ),
              ]),
            ),
            const SizedBox(height: 12),
            const Divider(),
            TaskExtras(key: ValueKey('${t.taskId}_${t.updatedAt}'), task: t, onChanged: () async { final r = await AppScope.read(context).api.getTask(t.taskId); if (mounted) { setState(() => t = r); widget.onChanged(r); } }),
            const SizedBox(height: 12),
            Text('${s.userName(t.createdBy)} 创建于 ${t.createdAt != null ? fmtDateTime(t.createdAt!.toLocal()) : '-'}',
                style: const TextStyle(fontSize: 12, color: Fs.text3)),
            if (isCreator && widget.onClose == null)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  onPressed: _delete,
                  style: TextButton.styleFrom(foregroundColor: Fs.red),
                  icon: const Icon(Icons.delete_outline_rounded, size: 18),
                  label: const Text('删除任务'),
                ),
              ),
            if (t.completedAt != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('完成于 ${fmtDateTime(t.completedAt!.toLocal())}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ),
            if (!canEdit)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(t.followerIds.contains(s.me.userId) ? '你是关注人，可以查看和评论，不能修改' : '只有创建人和负责人可以修改', style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ),
          ]),
        ),
      ]),
    );
  }

  Future<void> _pickAssignee(AppState s) async {
    final ids = await pickUsers(context,
        users: s.users, title: '选择负责人', multiple: false, initial: [if (t.assigneeId != null) t.assigneeId!]);
    if (ids == null || ids.isEmpty || ids.first == t.assigneeId) return;
    await _update(assigneeId: ids.first);
  }

  Future<void> _delete() async {
    final ok = await confirmDialog(context, title: '删除任务', content: '确定删除「${t.title}」吗？', ok: '删除', danger: true);
    if (!ok || !mounted) return;
    try {
      await AppScope.read(context).api.deleteTask(t.taskId);
      if (!mounted) return;
      showToast(context, '任务已删除');
      widget.onDeleted?.call();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Widget _field(IconData icon, String label, Widget child) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(
            width: 92,
            child: Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(children: [
                Icon(icon, size: 16, color: Fs.text3),
                const SizedBox(width: 6),
                Text(label, style: const TextStyle(fontSize: 13, color: Fs.text2)),
              ]),
            ),
          ),
          Expanded(child: child),
        ]),
      );
}

// ---------------- 新建任务 ----------------

class _TaskCreateDialog extends StatefulWidget {
  const _TaskCreateDialog();
  @override
  State<_TaskCreateDialog> createState() => _TaskCreateDialogState();
}

class _TaskCreateDialogState extends State<_TaskCreateDialog> {
  final title = TextEditingController();
  final desc = TextEditingController();
  String? assignee;
  DateTime? due;
  bool saving = false;
  String? error;

  @override
  void initState() {
    super.initState();
    assignee = AppScope.read(context).me.userId;
  }

  Future<void> _save() async {
    if (title.text.trim().isEmpty) {
      setState(() => error = '请填写任务标题');
      return;
    }
    setState(() {
      saving = true;
      error = null;
    });
    try {
      final t = await AppScope.read(context).api.createTask(
            title: title.text.trim(),
            assigneeId: assignee,
            due: due,
            description: desc.text.trim(),
          );
      if (mounted) {
        showToast(context, '任务已创建');
        Navigator.pop(context, t);
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          saving = false;
          error = describeError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return Dialog(
      child: SizedBox(
        width: 500,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              const Text('新建任务', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              const Spacer(),
              FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: () => Navigator.pop(context)),
            ]),
            const SizedBox(height: 16),
            TextField(
              controller: title,
              autofocus: true,
              style: const TextStyle(fontSize: 16),
              decoration: const InputDecoration(hintText: '任务标题'),
              onSubmitted: (_) => _save(),
            ),
            const SizedBox(height: 14),
            Row(children: [
              const SizedBox(width: 70, child: Text('负责人', style: TextStyle(color: Fs.text2, fontSize: 13))),
              Expanded(
                child: InkWell(
                  borderRadius: BorderRadius.circular(Fs.radius),
                  onTap: () async {
                    final ids = await pickUsers(context,
                        users: s.users, title: '选择负责人', multiple: false, initial: [if (assignee != null) assignee!]);
                    if (ids != null && ids.isNotEmpty) setState(() => assignee = ids.first);
                  },
                  child: InputDecorator(
                    decoration: const InputDecoration(suffixIcon: Icon(Icons.expand_more_rounded, size: 18)),
                    child: assignee == null
                        ? const Text('选择负责人', style: TextStyle(color: Fs.text3, fontSize: 14))
                        : Row(children: [
                            FsAvatar(name: s.userName(assignee!), seed: assignee, size: 20),
                            const SizedBox(width: 8),
                            Text(s.userName(assignee!), style: const TextStyle(fontSize: 14)),
                          ]),
                  ),
                ),
              ),
            ]),
            const SizedBox(height: 12),
            Row(children: [
              const SizedBox(width: 70, child: Text('截止时间', style: TextStyle(color: Fs.text2, fontSize: 13))),
              Expanded(child: DateField(value: due, hint: '选填', onChanged: (d) => setState(() => due = d))),
            ]),
            const SizedBox(height: 12),
            TextField(
              controller: desc,
              minLines: 3,
              maxLines: 6,
              decoration: const InputDecoration(hintText: '描述（选填）'),
            ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(error!, style: const TextStyle(color: Fs.red, fontSize: 13)),
              ),
            const SizedBox(height: 20),
            Row(mainAxisAlignment: MainAxisAlignment.end, children: [
              OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
              const SizedBox(width: 10),
              FilledButton(onPressed: saving ? null : _save, child: Text(saving ? '创建中…' : '创建')),
            ]),
          ]),
        ),
      ),
    );
  }
}
