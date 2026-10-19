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

class BitablePage extends StatefulWidget {
  const BitablePage({super.key});
  @override
  State<BitablePage> createState() => _BitablePageState();
}

class _BitablePageState extends State<BitablePage> {
  List<CosTableMeta> tables = [];
  bool loading = true;
  String? error;
  String? selected;
  String keyword = '';

  /// 折叠的侧边栏分组：true = 内置，false = 自定义。
  final Set<bool> collapsedGroups = {};

  /// 通知跳转要打开的记录。
  String? focusRecord;
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
      final t = await AppScope.read(context).api.listTables();
      if (!mounted) return;
      setState(() {
        tables = t;
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

  Future<void> _createTable() async {
    final s = AppScope.read(context);
    final created = await showDialog<CosTableMeta>(
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
            SizedBox(width: 248, child: sidebar),
            const VerticalDivider(width: 1),
            Expanded(
              child: meta == null
                  ? const BrandPlaceholder(text: '选择一张数据表')
                  : TableView(
                      key: ValueKey('${meta.key}/$focusRecord'),
                      meta: meta,
                      focusRecordId: focusRecord,
                      onMetaChanged: _onMetaChanged,
                    ),
            ),
          ],
        );
      },
    );
  }

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
            padding: const EdgeInsets.fromLTRB(16, 16, 12, 12),
            child: Row(
              children: [
                Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      colors: [Color(0xFF9B6CFF), Fs.purple],
                    ),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(
                    Icons.grid_view_rounded,
                    color: Colors.white,
                    size: 19,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '实验室数据中心',
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        '${tables.length} 张数据表',
                        style: const TextStyle(fontSize: 12, color: Fs.text3),
                      ),
                    ],
                  ),
                ),
                if (AppScope.of(context).feature('table.create'))
                  FsIconButton(
                    icon: Icons.add_rounded,
                    tooltip: '新建数据表',
                    onPressed: loading ? null : _createTable,
                  ),
                FsIconButton(
                  icon: Icons.refresh_rounded,
                  tooltip: '刷新',
                  onPressed: _load,
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
                      for (final builtin in [true, false]) ...[
                        if (list.any((t) => t.builtin == builtin))
                          HoverBox(
                            onTap: () => setState(
                              () => collapsedGroups.contains(builtin)
                                  ? collapsedGroups.remove(builtin)
                                  : collapsedGroups.add(builtin),
                            ),
                            padding: const EdgeInsets.fromLTRB(4, 10, 10, 6),
                            child: Row(
                              children: [
                                Icon(
                                  collapsedGroups.contains(builtin)
                                      ? Icons.chevron_right_rounded
                                      : Icons.expand_more_rounded,
                                  size: 16,
                                  color: Fs.text3,
                                ),
                                const SizedBox(width: 2),
                                Text(
                                  '${builtin ? '内置数据表' : '自定义数据表'}（${list.where((t) => t.builtin == builtin).length}）',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: Fs.text3,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        if (!collapsedGroups.contains(builtin))
                          for (final t in list.where(
                            (t) => t.builtin == builtin,
                          ))
                            HoverBox(
                              selected: wide && t.key == selected,
                              hoverColor: wide
                                  ? const Color(0xFFE8E9EB)
                                  : Fs.hover,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 9,
                              ),
                              onTap: () {
                                if (wide) {
                                  setState(() {
                                    selected = t.key;
                                    focusRecord = null;
                                  });
                                } else {
                                  pushScoped(
                                    context,
                                    Scaffold(
                                      appBar: AppBar(title: Text(t.name)),
                                      body: TableView(
                                        meta: t,
                                        onMetaChanged: _onMetaChanged,
                                      ),
                                    ),
                                  );
                                }
                              },
                              child: Row(
                                children: [
                                  Icon(
                                    Icons.table_chart_outlined,
                                    size: 17,
                                    color: wide && t.key == selected
                                        ? Fs.primary
                                        : Fs.text2,
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      t.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 13.5,
                                        color: wide && t.key == selected
                                            ? Fs.primary
                                            : Fs.text1,
                                        fontWeight: wide && t.key == selected
                                            ? FontWeight.w500
                                            : FontWeight.normal,
                                      ),
                                    ),
                                  ),
                                  Text(
                                    '${t.fields.length}',
                                    style: const TextStyle(
                                      fontSize: 11,
                                      color: Fs.text3,
                                    ),
                                  ),
                                  if (tableMenuItems(
                                    AppScope.of(context),
                                    t,
                                  ).isNotEmpty)
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
                                        itemBuilder: (_) => tableMenuItems(
                                          AppScope.read(context),
                                          t,
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                      ],
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
