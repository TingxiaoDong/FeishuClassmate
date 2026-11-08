/// 多维表格（Bitable）：数据表列表 + 表格视图 / 看板视图（拖拽改分组）+ 记录表单。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'create_table_dialog.dart';
import 'shell.dart';
import 'table_view.dart';
import 'table_manage.dart';
import 'table_import_export.dart';

class BitablePage extends StatefulWidget {
  const BitablePage({super.key});
  @override
  State<BitablePage> createState() => _BitablePageState();
}

class _BitablePageState extends State<BitablePage> {
  List<CosTableMeta> tables = [];
  List<CosTableFolder> folders = [];
  final Set<String> collapsedFolders = {};
  bool loading = true;
  String? error;
  String? selected;
  String keyword = '';
  bool quickActionsExpanded = false;

  /// 折叠的侧边栏分组：true = 内置，false = 自定义。
  final Set<bool> collapsedGroups = {};

  /// 通知跳转要打开的记录。
  String? focusRecord;
  String? focusView;
  StreamSubscription<CosEvent>? _sub;
  late final AppState _s = AppScope.read(context);

  @override
  void initState() {
    super.initState();
    _sub = _s.eventStream.listen(_onEvent);
    _s.addListener(_checkTarget);
    _load();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _s.removeListener(_checkTarget);
    super.dispose();
  }

  /// 通知中心跳转：{type: record, table_key, id}。
  void _checkTarget() {
    final t = _s.pendingTarget;
    if (t == null || _s.module != AppModule.bitable) return;
    if (t['type'] != 'record' && t['type'] != 'table') return;
    _s.pendingTarget = null;
    final key =
        t['table_key']?.toString() ??
        (t['type'] == 'table' ? t['id']?.toString() : null);
    if (key == null) return;
    setState(() {
      selected = key;
      focusRecord = t['type'] == 'record' ? t['id']?.toString() : null;
      focusView = t['view_id']?.toString();
    });
  }

  void _onEvent(CosEvent e) {
    final key = e.str('table_key');
    switch (e.eventType) {
      case 'table.created':
        _load(quiet: true);
      case 'table.deleted':
        if (key == selected) {
          showToast(context, '当前数据表已被删除', error: true);
          selected = null;
        }
        _load(quiet: true);
      case 'resync.required':
        _load(quiet: true);
    }
  }

  void _onMetaChanged(CosTableMeta t) {
    if (!mounted) return;
    setState(() => tables = [for (final x in tables) x.key == t.key ? t : x]);
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet) {
      setState(() {
        loading = true;
        error = null;
      });
    }
    try {
      final api = AppScope.read(context).api;
      final results = await Future.wait([
        api.listTables(),
        api.listTableFolders(),
      ]);
      if (!mounted) return;
      setState(() {
        tables = results[0] as List<CosTableMeta>;
        folders = results[1] as List<CosTableFolder>;
        loading = false;
      });
      _checkTarget();
    } catch (e) {
      if (quiet) return;
      if (mounted) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  Future<void> _createFolder({String? parentId}) async {
    final ctl = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(parentId == null ? '新建文件夹' : '新建子文件夹'),
        content: TextField(
          controller: ctl,
          autofocus: true,
          maxLength: 50,
          decoration: const InputDecoration(labelText: '文件夹名称'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctl.text.trim()),
            child: const Text('创建'),
          ),
        ],
      ),
    );
    ctl.dispose();
    if (name == null || name.isEmpty || !mounted) return;
    try {
      await AppScope.read(
        context,
      ).api.createTableFolder(name, parentId: parentId);
      await _load(quiet: true);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  List<Widget> _folderNodes(
    BuildContext context,
    String? parentId,
    List<CosTableMeta> list,
    bool wide, {
    int depth = 0,
  }) {
    final out = <Widget>[];
    for (final f in folders.where((x) => x.parentId == parentId)) {
      final childTables = list
          .where((x) => !x.builtin && x.folderId == f.folderId)
          .toList();
      final collapsed = collapsedFolders.contains(f.folderId);
      out.add(
        HoverBox(
          padding: EdgeInsets.fromLTRB(8 + depth * 16, 8, 4, 6),
          onTap: () => setState(
            () => collapsed
                ? collapsedFolders.remove(f.folderId)
                : collapsedFolders.add(f.folderId),
          ),
          child: Row(
            children: [
              Icon(
                collapsed
                    ? Icons.chevron_right_rounded
                    : Icons.expand_more_rounded,
                size: 16,
                color: Fs.text3,
              ),
              const SizedBox(width: 2),
              const Icon(Icons.folder_outlined, size: 17, color: Fs.text2),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  f.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5),
                ),
              ),
              FsIconButton(
                icon: Icons.create_new_folder_outlined,
                tooltip: '新建子文件夹',
                onPressed: () => _createFolder(parentId: f.folderId),
              ),
            ],
          ),
        ),
      );
      if (!collapsed) {
        out.addAll(
          _folderNodes(context, f.folderId, list, wide, depth: depth + 1),
        );
        out.addAll([
          for (final table in childTables)
            _tableTile(context, table, wide, depth: depth + 1),
        ]);
      }
    }
    return out;
  }

  Widget _tableTile(
    BuildContext context,
    CosTableMeta t,
    bool wide, {
    int depth = 0,
  }) => HoverBox(
    selected: wide && t.key == selected,
    hoverColor: wide ? const Color(0xFFE8E9EB) : Fs.hover,
    padding: EdgeInsets.fromLTRB(10 + depth * 16, 9, 4, 9),
    onTap: () {
      if (wide) {
        setState(() {
          selected = t.key;
          focusRecord = null;
          focusView = null;
        });
      } else {
        pushScoped(
          context,
          Scaffold(
            appBar: AppBar(title: Text(t.name)),
            body: TableView(meta: t, onMetaChanged: _onMetaChanged),
          ),
        );
      }
    },
    child: Row(
      children: [
        Icon(
          tableIcon(t.icon),
          size: 17,
          color: wide && t.key == selected ? Fs.primary : Fs.text2,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            t.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 13.5,
              color: wide && t.key == selected ? Fs.primary : Fs.text1,
            ),
          ),
        ),
        Text(
          '${t.fields.length}',
          style: const TextStyle(fontSize: 11, color: Fs.text3),
        ),
        if (tableMenuItems(AppScope.of(context), t).isNotEmpty)
          SizedBox(
            width: 24,
            height: 22,
            child: PopupMenuButton<String>(
              tooltip: '更多',
              padding: EdgeInsets.zero,
              iconSize: 16,
              icon: const Icon(
                Icons.more_horiz_rounded,
                size: 16,
                color: Fs.text3,
              ),
              onSelected: (v) => _tableAction(t, v),
              itemBuilder: (_) => tableMenuItems(AppScope.read(context), t),
            ),
          ),
      ],
    ),
  );

  Future<void> _createTable({bool fromFile = false}) async {
    final s = AppScope.read(context);
    final created = fromFile
        ? await showCreateTableFromFile(context)
        : await showDialog<CosTableMeta>(
            context: context,
            barrierDismissible: false,
            builder: (_) => CreateTableDialog(api: s.api),
          );
    if (created == null || !mounted) return;
    setState(() {
      tables = [...tables.where((t) => t.key != created.key), created];
      selected = created.key;
      keyword = '';
      collapsedGroups.remove(false);
    });
    showToast(context, '已创建数据表「${created.name}」');
    if (MediaQuery.sizeOf(context).width < 760) {
      pushScoped(
        context,
        Scaffold(
          appBar: AppBar(title: Text(created.name)),
          body: TableView(meta: created, onMetaChanged: _onMetaChanged),
        ),
      );
    }
    _load();
  }

  Future<void> _tableAction(CosTableMeta t, String action) async {
    final r = await runTableAction(context, t, action);
    if (r == null || !mounted) return;
    final (res, meta) = r;
    switch (res) {
      case TableMenuResult.deleted:
        setState(() {
          tables = tables.where((x) => x.key != t.key).toList();
          if (selected == t.key) selected = null;
        });
      case TableMenuResult.copied:
        if (meta != null) {
          setState(() {
            tables = [...tables, meta];
            selected = meta.key;
            collapsedGroups.remove(false);
          });
          showToast(context, '已创建副本「${meta.name}」');
        }
      case TableMenuResult.changed:
        if (meta != null) _onMetaChanged(meta);
    }
    _load(quiet: true);
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        final wide = c.maxWidth >= 760;
        if (wide && selected == null && tables.isNotEmpty) {
          selected = tables.first.key;
        }
        final meta = tables.where((t) => t.key == selected).firstOrNull;
        final sidebar = _sidebar(context, wide);
        if (!wide) return sidebar;
        return Row(
          children: [
            SizedBox(width: 220, child: sidebar),
            const VerticalDivider(width: 1),
            Expanded(
              child: meta == null
                  ? const BrandPlaceholder(text: '选择一张数据表')
                  : TableView(
                      key: ValueKey('${meta.key}/$focusRecord/$focusView'),
                      meta: meta,
                      focusRecordId: focusRecord,
                      initialViewId: focusView,
                      onMetaChanged: _onMetaChanged,
                    ),
            ),
          ],
        );
      },
    );
  }

  Widget _quickAction({
    Key? key,
    required IconData icon,
    required String label,
    required VoidCallback? onTap,
  }) => SizedBox(
    key: key,
    height: 34,
    width: double.infinity,
    child: TextButton.icon(
      onPressed: onTap,
      style: TextButton.styleFrom(
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        foregroundColor: Fs.text1,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Fs.radius),
        ),
      ),
      icon: Icon(icon, size: 17, color: Fs.text2),
      label: Text(label, overflow: TextOverflow.ellipsis),
    ),
  );

  Widget _sidebar(BuildContext context, bool wide) {
    final list = tables
        .where(
          (t) =>
              keyword.isEmpty ||
              t.name.toLowerCase().contains(keyword.toLowerCase()) ||
              t.key.toLowerCase().contains(keyword.toLowerCase()),
        )
        .toList();
    return Container(
      color: wide ? Fs.bg : Colors.white,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(6, 4, 6, 14),
                  child: Row(
                    children: [
                      const Expanded(
                        child: Text(
                          '多维表格',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Text(
                        '${tables.length} 张',
                        style: const TextStyle(fontSize: 12, color: Fs.text3),
                      ),
                    ],
                  ),
                ),
                if (AppScope.of(context).feature('table.create')) ...[
                  SizedBox(
                    height: 38,
                    child: FilledButton.icon(
                      onPressed: loading
                          ? null
                          : () => setState(
                              () =>
                                  quickActionsExpanded = !quickActionsExpanded,
                            ),
                      icon: AnimatedRotation(
                        turns: quickActionsExpanded ? 0.125 : 0,
                        duration: const Duration(milliseconds: 150),
                        child: const Icon(Icons.add_rounded, size: 18),
                      ),
                      label: const Text('新建数据表'),
                    ),
                  ),
                  AnimatedSize(
                    duration: const Duration(milliseconds: 150),
                    curve: Curves.easeOut,
                    child: quickActionsExpanded
                        ? Padding(
                            padding: const EdgeInsets.only(top: 6),
                            child: Column(
                              children: [
                                _quickAction(
                                  icon: Icons.table_rows_outlined,
                                  label: '空白数据表',
                                  onTap: loading ? null : _createTable,
                                ),
                                _quickAction(
                                  icon: Icons.create_new_folder_outlined,
                                  label: '新建文件夹',
                                  onTap: loading ? null : () => _createFolder(),
                                ),
                                if (AppScope.of(
                                  context,
                                ).feature('table.import'))
                                  _quickAction(
                                    key: const ValueKey(
                                      'create-table-from-file',
                                    ),
                                    icon: Icons.upload_file_rounded,
                                    label: '从 Excel / CSV 新建',
                                    onTap: loading
                                        ? null
                                        : () => _createTable(fromFile: true),
                                  ),
                              ],
                            ),
                          )
                        : const SizedBox.shrink(),
                  ),
                ],
                const SizedBox(height: 8),
                Row(
                  children: [
                    const Spacer(),
                    FsIconButton(
                      icon: Icons.refresh_rounded,
                      tooltip: '刷新',
                      onPressed: _load,
                    ),
                  ],
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: FsSearchField(
              hint: '搜索数据表',
              onChanged: (v) => setState(() => keyword = v.trim()),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: loading
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : error != null
                ? EmptyState(
                    icon: Icons.cloud_off_outlined,
                    title: '加载失败',
                    subtitle: error,
                    action: OutlinedButton(
                      onPressed: _load,
                      child: const Text('重试'),
                    ),
                  )
                : ListView(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    children: [
                      if (list.isNotEmpty || folders.isNotEmpty) ...[
                        ..._folderNodes(context, null, list, wide),
                        for (final t in list.where(
                          (t) => !t.builtin && t.folderId == null,
                        ))
                          _tableTile(context, t, wide),
                      ],
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
