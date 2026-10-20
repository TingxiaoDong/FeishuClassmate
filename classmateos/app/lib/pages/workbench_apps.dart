/// 工作台应用网格（R-WB-01）：内置模块 + 自己添加的快捷方式（某张表的某个视图、知识空间、文档）。
/// 右键 / 长按快捷方式可以重命名、移动、删除；「管理」里可以拖动排序。
library;

import 'package:flutter/material.dart';

import '../api/phase2.dart';
import '../api/phase2_docs.dart';
import '../api/phase2_jobs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'shell.dart' show ModuleMeta;

const _moduleDesc = {
  AppModule.messages: '单聊群聊',
  AppModule.calendar: '会议排期',
  AppModule.docs: '文档协作',
  AppModule.wiki: '知识沉淀',
  AppModule.bitable: '数据管理',
  AppModule.tasks: '待办跟进',
  AppModule.drive: '文件存储',
  AppModule.contacts: '组织成员',
  AppModule.admin: '成员与权限',
};

const _shortcutMeta = <String, (IconData, Color, String)>{
  'table_view': (Icons.grid_view_rounded, Fs.purple, '多维表格视图'),
  'wiki_space': (Icons.menu_book_rounded, Color(0xFF00B6C1), '知识空间'),
  'doc': (Icons.description_rounded, Color(0xFF3370FF), '文档'),
};

class WorkbenchApps extends StatefulWidget {
  const WorkbenchApps({super.key});
  @override
  State<WorkbenchApps> createState() => _WorkbenchAppsState();
}

class _WorkbenchAppsState extends State<WorkbenchApps> {
  List<String>? builtin;
  List<CosShortcut> shortcuts = [];
  String? error;
  bool saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final a = await AppScope.read(context).api.workbenchApps();
      if (!mounted) return;
      setState(() {
        builtin = a.builtin;
        shortcuts = a.shortcuts;
        error = null;
      });
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  Future<void> _save(List<CosShortcut> next, {String? ok}) async {
    final before = shortcuts;
    setState(() {
      shortcuts = next;
      saving = true;
    });
    try {
      final saved = await AppScope.read(context).api.saveShortcuts(next);
      if (!mounted) return;
      setState(() => shortcuts = saved);
      if (ok != null) showToast(context, ok);
    } catch (e) {
      if (!mounted) return;
      setState(() => shortcuts = before);
      showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  void _open(CosShortcut x) {
    final s = AppScope.read(context);
    switch (x.type) {
      case 'table_view':
        s.openTarget({'type': 'table', 'table_key': x.tableKey ?? x.targetId, 'view_id': x.tableKey == null ? null : x.targetId});
      case 'wiki_space':
        s.openTarget({'type': 'wiki_space', 'id': x.targetId});
      case 'doc':
        s.openTarget({'type': 'doc', 'id': x.targetId});
      default:
        showToast(context, '这个快捷方式类型暂不支持', error: true);
    }
  }

  Future<void> _menu(CosShortcut x, Offset pos) async {
    final i = shortcuts.indexOf(x);
    final a = await showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(pos.dx, pos.dy, pos.dx, pos.dy),
      items: [
        const PopupMenuItem(value: 'rename', child: Text('重命名')),
        if (i > 0) const PopupMenuItem(value: 'left', child: Text('前移')),
        if (i < shortcuts.length - 1) const PopupMenuItem(value: 'right', child: Text('后移')),
        const PopupMenuItem(value: 'manage', child: Text('管理快捷方式')),
        const PopupMenuItem(value: 'delete', child: Text('移除', style: TextStyle(color: Fs.red))),
      ],
    );
    if (a == null || !mounted) return;
    final l = [...shortcuts];
    switch (a) {
      case 'rename':
        final c = TextEditingController(text: x.name);
        final v = await showDialog<String>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('重命名快捷方式'),
            content: SizedBox(width: 320, child: TextField(controller: c, autofocus: true, maxLength: 20, onSubmitted: (v) => Navigator.pop(ctx, v))),
            actions: [
              OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
              FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('保存')),
            ],
          ),
        );
        c.dispose();
        if (v == null || v.trim().isEmpty) return;
        l[i] = CosShortcut(x.id, x.type, x.targetId, v.trim(), icon: x.icon, tableKey: x.tableKey);
        await _save(l);
      case 'left' || 'right':
        l.insert(a == 'left' ? i - 1 : i + 1, l.removeAt(i));
        await _save(l);
      case 'manage':
        await _manage();
      case 'delete':
        l.removeAt(i);
        await _save(l, ok: '已移除');
    }
  }

  Future<void> _manage() async {
    final r = await showScopedDialog<List<CosShortcut>>(context, (_) => _ManageDialog(initial: shortcuts));
    if (r != null) await _save(r, ok: '已保存');
  }

  Future<void> _add() async {
    if (shortcuts.length >= 30) {
      showToast(context, '最多添加 30 个快捷方式', error: true);
      return;
    }
    final x = await showScopedDialog<CosShortcut>(context, (_) => const _AddShortcutDialog());
    if (x == null) return;
    if (shortcuts.any((e) => e.type == x.type && e.targetId == x.targetId && e.tableKey == x.tableKey)) {
      if (mounted) showToast(context, '已经添加过了');
      return;
    }
    await _save([...shortcuts, x], ok: '已添加到工作台');
  }

  Widget _tile({required Key key, required Widget icon, required String title, required String sub, VoidCallback? onTap, void Function(Offset)? onMenu}) =>
      GestureDetector(
        key: key,
        onSecondaryTapUp: onMenu == null ? null : (d) => onMenu(d.globalPosition),
        onLongPressStart: onMenu == null ? null : (d) => onMenu(d.globalPosition),
        child: HoverBox(
          onTap: onTap,
          hoverColor: Colors.white,
          radius: 12,
          child: Container(
            width: 148,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), border: Border.all(color: Fs.lineLight)),
            child: Row(children: [
              icon,
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                  Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: Fs.text3)),
                ]),
              ),
            ]),
          ),
        ),
      );

  Widget _icon(IconData i, Color c) => Container(
        width: 38,
        height: 38,
        decoration: BoxDecoration(
          gradient: LinearGradient(colors: [c.withValues(alpha: 0.75), c], begin: Alignment.topLeft, end: Alignment.bottomRight),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(i, color: Colors.white, size: 20),
      );

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    if (error != null && builtin == null) {
      return Row(children: [
        Text('应用加载失败：$error', style: const TextStyle(color: Fs.text3, fontSize: 13)),
        TextButton(onPressed: _load, child: const Text('重试')),
      ]);
    }
    if (builtin == null) return const SizedBox(height: 70, child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
    // 后端给顺序；前端只显示认识且有权限看到的模块
    final mods = [
      for (final k in builtin!)
        ?AppModule.values.where((m) => m.name == k && m != AppModule.workbench && m != AppModule.me && s.moduleVisible(m)).firstOrNull,
    ];
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 12, runSpacing: 12, children: [
        for (final m in mods)
          _tile(
            key: ValueKey('app-${m.name}'),
            icon: _icon(ModuleMeta.of(m).activeIcon, ModuleMeta.of(m).color),
            title: m.label,
            sub: _moduleDesc[m] ?? '',
            onTap: () => s.go(m),
          ),
      ]),
      const SizedBox(height: 18),
      Row(children: [
        const Text('我的快捷方式', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        const SizedBox(width: 8),
        const Text('右键或长按可编辑', style: TextStyle(fontSize: 12, color: Fs.text3)),
        const Spacer(),
        if (shortcuts.length > 1) TextButton(onPressed: saving ? null : _manage, child: const Text('管理')),
      ]),
      const SizedBox(height: 8),
      Wrap(spacing: 12, runSpacing: 12, children: [
        for (final x in shortcuts)
          _tile(
            key: ValueKey('shortcut-${x.id}'),
            icon: _icon(_shortcutMeta[x.type]?.$1 ?? Icons.link_rounded, _shortcutMeta[x.type]?.$2 ?? Fs.text3),
            title: x.name,
            sub: _shortcutMeta[x.type]?.$3 ?? '快捷方式',
            onTap: () => _open(x),
            onMenu: (p) => _menu(x, p),
          ),
        HoverBox(
          key: const ValueKey('shortcut-add'),
          onTap: saving ? null : _add,
          radius: 12,
          child: Container(
            width: 148,
            height: 68,
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: Fs.line)),
            child: const Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              Icon(Icons.add_rounded, size: 18, color: Fs.text2),
              SizedBox(width: 6),
              Text('添加快捷方式', style: TextStyle(fontSize: 13, color: Fs.text2)),
            ]),
          ),
        ),
      ]),
    ]);
  }
}

// ---------------- 添加快捷方式 ----------------

class _AddShortcutDialog extends StatefulWidget {
  const _AddShortcutDialog();
  @override
  State<_AddShortcutDialog> createState() => _AddShortcutDialogState();
}

class _AddShortcutDialogState extends State<_AddShortcutDialog> {
  String type = 'table_view';
  String keyword = '';
  List<CosTableMeta>? tables;
  CosTableMeta? table;
  List<CosView>? views;
  List<CosWikiSpace>? spaces;
  List<CosDoc>? docs;
  String? error;

  @override
  void initState() {
    super.initState();
    _loadType();
  }

  Future<void> _loadType() async {
    final s = AppScope.read(context);
    setState(() => error = null);
    try {
      switch (type) {
        case 'table_view':
          tables ??= await s.api.listTables();
        case 'wiki_space':
          spaces ??= await s.api.listSpaces();
        case 'doc':
          docs ??= await s.api.listDocs();
      }
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  Future<void> _pickTable(CosTableMeta t) async {
    final s = AppScope.read(context);
    setState(() {
      table = t;
      views = null;
    });
    if (!s.feature('table.views')) {
      // 没有保存视图时直接把整张表加进来
      Navigator.pop(context, CosShortcut('', 'table_view', t.key, t.name));
      return;
    }
    try {
      final v = await s.api.listViews(t.key);
      if (mounted) setState(() => views = v);
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final k = keyword.toLowerCase();
    bool hit(String t) => k.isEmpty || t.toLowerCase().contains(k);
    Widget row(IconData icon, String title, String? sub, VoidCallback onTap, {Key? key}) => ListTile(
          key: key,
          dense: true,
          leading: Icon(icon, size: 20, color: Fs.text2),
          title: Text(title, overflow: TextOverflow.ellipsis),
          subtitle: sub == null || sub.isEmpty ? null : Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis),
          onTap: onTap,
        );
    List<Widget> list;
    if (error != null) {
      list = [Padding(padding: const EdgeInsets.all(16), child: Text(error!, style: const TextStyle(color: Fs.red)))];
    } else if (type == 'table_view' && table != null) {
      list = [
        ListTile(
          dense: true,
          leading: const Icon(Icons.arrow_back_rounded, size: 18),
          title: Text('${table!.name} · 选择视图'),
          onTap: () => setState(() => table = null),
        ),
        if (views == null) const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator(strokeWidth: 2))),
        for (final v in views ?? const <CosView>[])
          if (!v.local)
            row(v.type == 'kanban' ? Icons.view_kanban_outlined : Icons.table_rows_outlined, v.name, null,
                () => Navigator.pop(context, CosShortcut('', 'table_view', v.viewId, '${table!.name} · ${v.name}', tableKey: table!.key)),
                key: ValueKey('pick-view-${v.viewId}')),
        row(Icons.grid_view_rounded, '整张表（默认视图）', null, () => Navigator.pop(context, CosShortcut('', 'table_view', table!.key, table!.name))),
      ];
    } else {
      list = switch (type) {
        'table_view' => [
            for (final t in tables ?? const <CosTableMeta>[])
              if (hit(t.name)) row(Icons.grid_view_rounded, t.name, t.description, () => _pickTable(t), key: ValueKey('pick-table-${t.key}')),
          ],
        'wiki_space' => [
            for (final x in spaces ?? const <CosWikiSpace>[])
              if (hit(x.name)) row(Icons.menu_book_rounded, x.name, x.description, () => Navigator.pop(context, CosShortcut('', 'wiki_space', x.spaceId, x.name))),
          ],
        _ => [
            for (final d in docs ?? const <CosDoc>[])
              if (hit(d.title)) row(Icons.description_outlined, d.title.isEmpty ? '未命名文档' : d.title, null, () => Navigator.pop(context, CosShortcut('', 'doc', d.docId, d.title.isEmpty ? '未命名文档' : d.title))),
          ],
      };
      final loaded = switch (type) { 'table_view' => tables, 'wiki_space' => spaces, _ => docs };
      if (loaded == null) list = [const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator(strokeWidth: 2)))];
      if (loaded != null && list.isEmpty) list = [const Padding(padding: EdgeInsets.all(20), child: Center(child: Text('没有找到', style: TextStyle(color: Fs.text3))))];
    }
    return AlertDialog(
      title: const Text('添加快捷方式'),
      content: SizedBox(
        width: 440,
        height: 420,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SegmentedButton<String>(
            showSelectedIcon: false,
            segments: [
              const ButtonSegment(value: 'table_view', label: Text('表格视图')),
              if (s.feature('wiki')) const ButtonSegment(value: 'wiki_space', label: Text('知识空间')),
              const ButtonSegment(value: 'doc', label: Text('文档')),
            ],
            selected: {type},
            onSelectionChanged: (v) {
              setState(() {
                type = v.first;
                table = null;
              });
              _loadType();
            },
          ),
          const SizedBox(height: 10),
          FsSearchField(hint: '搜索', onChanged: (v) => setState(() => keyword = v.trim())),
          const SizedBox(height: 6),
          Expanded(child: ListView(children: list)),
        ]),
      ),
      actions: [OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('取消'))],
    );
  }
}

class _ManageDialog extends StatefulWidget {
  final List<CosShortcut> initial;
  const _ManageDialog({required this.initial});
  @override
  State<_ManageDialog> createState() => _ManageDialogState();
}

class _ManageDialogState extends State<_ManageDialog> {
  late final List<CosShortcut> l = [...widget.initial];

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('管理快捷方式'),
        content: SizedBox(
          width: 400,
          height: 380,
          child: ReorderableListView(
            buildDefaultDragHandles: false,
            onReorderItem: (a, b) => setState(() => l.insert(b, l.removeAt(a))),
            children: [
              for (var i = 0; i < l.length; i++)
                ListTile(
                  key: ValueKey('m-${l[i].id}-$i'),
                  dense: true,
                  leading: ReorderableDragStartListener(index: i, child: const Icon(Icons.drag_indicator_rounded, color: Fs.text3)),
                  title: Text(l[i].name),
                  subtitle: Text(_shortcutMeta[l[i].type]?.$3 ?? ''),
                  trailing: IconButton(icon: const Icon(Icons.close_rounded, size: 18), tooltip: '移除', onPressed: () => setState(() => l.removeAt(i))),
                ),
            ],
          ),
        ),
        actions: [
          OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, l), child: const Text('保存')),
        ],
      );
}
