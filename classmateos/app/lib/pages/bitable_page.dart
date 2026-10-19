/// 多维表格（Bitable）：数据表列表 + 表格视图 / 看板视图（拖拽改分组）+ 记录表单。
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'bitable_field.dart';
import 'shell.dart';

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

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final t = await AppScope.read(context).api.listTables();
      if (!mounted) return;
      setState(() {
        tables = t;
        loading = false;
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

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        final wide = c.maxWidth >= 760;
        if (wide && selected == null && tables.isNotEmpty) selected = tables.first.key;
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
                  : TableView(key: ValueKey(meta.key), meta: meta),
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
                    gradient: const LinearGradient(colors: [Color(0xFF9B6CFF), Fs.purple]),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.grid_view_rounded, color: Colors.white, size: 19),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('实验室数据中心', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                      Text('${tables.length} 张数据表', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                    ],
                  ),
                ),
                FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', onPressed: _load),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: FsSearchField(hint: '搜索数据表', onChanged: (v) => setState(() => keyword = v.trim())),
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
                    action: OutlinedButton(onPressed: _load, child: const Text('重试')),
                  )
                : ListView(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    children: [
                      for (final t in list)
                        HoverBox(
                          selected: wide && t.key == selected,
                          hoverColor: wide ? const Color(0xFFE8E9EB) : Fs.hover,
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                          onTap: () {
                            if (wide) {
                              setState(() => selected = t.key);
                            } else {
                              pushScoped(
                                context,
                                Scaffold(
                                  appBar: AppBar(title: Text(t.name)),
                                  body: TableView(meta: t),
                                ),
                              );
                            }
                          },
                          child: Row(
                            children: [
                              Icon(
                                Icons.table_chart_outlined,
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
                                    fontWeight: wide && t.key == selected ? FontWeight.w500 : FontWeight.normal,
                                  ),
                                ),
                              ),
                              Text('${t.fields.length}', style: const TextStyle(fontSize: 11, color: Fs.text3)),
                            ],
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

// ---------------- 单表视图 ----------------

enum _View { grid, kanban }

class TableView extends StatefulWidget {
  final CosTableMeta meta;
  const TableView({super.key, required this.meta});
  @override
  State<TableView> createState() => _TableViewState();
}

class _TableViewState extends State<TableView> {
  List<CosRecord> records = [];
  bool loading = true;
  String? error;
  _View view = _View.grid;
  String keyword = '';
  String? sortField;
  bool sortAsc = true;
  String? groupField;
  final hCtrl = ScrollController();
  final vCtrl = ScrollController();
  final kanbanCtrl = ScrollController();

  CosTableMeta get meta => widget.meta;
  List<CosFieldMeta> get selectFields => meta.fields.where((f) => f.type == 3).toList();

  @override
  void initState() {
    super.initState();
    groupField = selectFields.firstOrNull?.fieldName;
    _load();
  }

  @override
  void dispose() {
    hCtrl.dispose();
    vCtrl.dispose();
    kanbanCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final r = await AppScope.read(context).api.listAllRecords(meta.key);
      if (!mounted) return;
      setState(() {
        records = r.items;
        loading = false;
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

  List<CosRecord> get visible {
    var list = records;
    if (keyword.isNotEmpty) {
      final k = keyword.toLowerCase();
      list = list.where((r) => r.fields.values.any((v) => fieldText(v).toLowerCase().contains(k))).toList();
    }
    if (sortField != null) {
      list = [...list]
        ..sort((a, b) {
          final va = a.fields[sortField];
          final vb = b.fields[sortField];
          if (isEmptyValue(va) && isEmptyValue(vb)) return 0;
          if (isEmptyValue(va)) return 1;
          if (isEmptyValue(vb)) return -1;
          final c = (va is num && vb is num) ? va.compareTo(vb) : fieldText(va).compareTo(fieldText(vb));
          return sortAsc ? c : -c;
        });
    }
    return list;
  }

  Future<void> _open(CosRecord? r, {Map<String, dynamic> preset = const {}}) async {
    final changed = await showRecordDialog(context, table: meta, record: r, preset: preset);
    if (changed) _load();
  }

  /// 看板拖拽：先本地更新，失败回滚。
  Future<void> _moveTo(CosRecord r, String field, String? option) async {
    if (fieldText(r.fields[field]) == (option ?? '')) return;
    final idx = records.indexWhere((x) => x.recordId == r.recordId);
    if (idx < 0) return;
    final old = records[idx];
    final next = CosRecord(
      recordId: r.recordId,
      fields: {...r.fields, field: option},
      createdAt: r.createdAt,
      updatedAt: DateTime.now(),
    );
    setState(() => records[idx] = next);
    try {
      await AppScope.read(context).api.updateRecord(meta.key, r.recordId, {field: option});
    } catch (e) {
      if (!mounted) return;
      setState(() => records[idx] = old);
      showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      child: Column(
        children: [
          _header(context),
          _toolbar(context),
          const Divider(),
          Expanded(
            child: loading
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : error != null
                ? EmptyState(
                    icon: Icons.cloud_off_outlined,
                    title: '记录加载失败',
                    subtitle: error,
                    action: OutlinedButton(onPressed: _load, child: const Text('重试')),
                  )
                : view == _View.grid
                ? _grid(context)
                : _kanban(context),
          ),
        ],
      ),
    );
  }

  Widget _header(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 14, 16, 4),
    child: Row(
      children: [
        Expanded(
          child: Row(
            children: [
              Flexible(
                child: Text(
                  meta.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(color: Fs.hover, borderRadius: BorderRadius.circular(4)),
                child: Text(
                  meta.key,
                  style: const TextStyle(fontSize: 11, color: Fs.text3, fontFamily: 'Menlo'),
                ),
              ),
            ],
          ),
        ),
        FilledButton.icon(
          onPressed: () => _open(null),
          icon: const Icon(Icons.add_rounded, size: 18),
          label: const Text('添加记录'),
        ),
      ],
    ),
  );

  Widget _toolbar(BuildContext context) {
    final narrow = MediaQuery.sizeOf(context).width < 900;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 16, 8),
      child: Row(
        children: [
          _viewTab(_View.grid, Icons.grid_on_rounded, '表格视图'),
          _viewTab(_View.kanban, Icons.view_kanban_outlined, '看板视图'),
          const SizedBox(width: 8),
          Container(width: 1, height: 18, color: Fs.line),
          const SizedBox(width: 4),
          _sortButton(),
          if (view == _View.kanban) _groupButton(),
          const Spacer(),
          SizedBox(
            width: narrow ? 140 : 220,
            child: FsSearchField(hint: '搜索记录', onChanged: (v) => setState(() => keyword = v.trim())),
          ),
          const SizedBox(width: 4),
          FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', onPressed: _load),
        ],
      ),
    );
  }

  Widget _viewTab(_View v, IconData icon, String label) {
    final sel = view == v;
    return HoverBox(
      onTap: () => setState(() => view = v),
      selected: sel,
      selectedColor: Fs.primaryLight,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: sel ? Fs.primary : Fs.text2),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              fontSize: 13,
              color: sel ? Fs.primary : Fs.text2,
              fontWeight: sel ? FontWeight.w500 : FontWeight.normal,
            ),
          ),
        ],
      ),
    );
  }

  Widget _toolButton(IconData icon, String label, bool active) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
    decoration: BoxDecoration(color: active ? Fs.primaryBg : null, borderRadius: BorderRadius.circular(Fs.radius)),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: active ? Fs.primary : Fs.text2),
        const SizedBox(width: 4),
        Text(label, style: TextStyle(fontSize: 13, color: active ? Fs.primary : Fs.text2)),
      ],
    ),
  );

  Widget _sortButton() => PopupMenuButton<String>(
    tooltip: '排序',
    position: PopupMenuPosition.under,
    onSelected: (v) => setState(() {
      if (v == '__clear') {
        sortField = null;
      } else if (sortField == v) {
        sortAsc = !sortAsc;
      } else {
        sortField = v;
        sortAsc = true;
      }
    }),
    itemBuilder: (_) => [
      if (sortField != null)
        const PopupMenuItem(
          value: '__clear',
          child: Row(children: [Icon(Icons.clear_rounded, size: 16), SizedBox(width: 8), Text('取消排序')]),
        ),
      for (final f in meta.fields)
        PopupMenuItem(
          value: f.fieldName,
          height: 38,
          child: Row(
            children: [
              Icon(fieldIcon(f.type), size: 16, color: Fs.text3),
              const SizedBox(width: 8),
              Expanded(child: Text(f.label, style: const TextStyle(fontSize: 13))),
              if (sortField == f.fieldName)
                Icon(sortAsc ? Icons.arrow_upward_rounded : Icons.arrow_downward_rounded, size: 16, color: Fs.primary),
            ],
          ),
        ),
    ],
    child: _toolButton(
      Icons.swap_vert_rounded,
      sortField == null ? '排序' : '按 $sortField ${sortAsc ? '升序' : '降序'}',
      sortField != null,
    ),
  );

  Widget _groupButton() => PopupMenuButton<String>(
    tooltip: '看板分组字段',
    position: PopupMenuPosition.under,
    enabled: selectFields.isNotEmpty,
    onSelected: (v) => setState(() => groupField = v),
    itemBuilder: (_) => [
      for (final f in selectFields)
        CheckedPopupMenuItem(value: f.fieldName, checked: groupField == f.fieldName, child: Text(f.label)),
    ],
    child: _toolButton(Icons.view_week_outlined, groupField == null ? '无单选字段' : '分组：$groupField', false),
  );

  // ---------------- 表格视图 ----------------

  Widget _grid(BuildContext context) {
    final rows = visible;
    final fields = meta.fields;
    const idxW = 56.0;
    final widths = [for (final f in fields) fieldWidth(f.type)];
    final total = idxW + widths.fold<double>(0, (a, b) => a + b) + 1;
    return Column(
      children: [
        Expanded(
          child: LayoutBuilder(
            builder: (context, c) {
              final w = math.max(total, c.maxWidth);
              return Scrollbar(
                controller: hCtrl,
                thumbVisibility: true,
                child: SingleChildScrollView(
                  controller: hCtrl,
                  scrollDirection: Axis.horizontal,
                  child: SizedBox(
                    width: w,
                    child: Column(
                      children: [
                        // 表头
                        Container(
                          height: 38,
                          decoration: const BoxDecoration(
                            color: Fs.bg,
                            border: Border(bottom: BorderSide(color: Fs.line)),
                          ),
                          child: Row(
                            children: [
                              _cellBox(
                                idxW,
                                const Center(
                                  child: Icon(Icons.check_box_outline_blank_rounded, size: 15, color: Fs.textDisabled),
                                ),
                              ),
                              for (var i = 0; i < fields.length; i++)
                                _cellBox(
                                  widths[i],
                                  Tooltip(
                                    message: '${fields[i].fieldName}（${fieldTypeName(fields[i].type)}）',
                                    child: Row(
                                      children: [
                                        Icon(fieldIcon(fields[i].type), size: 15, color: Fs.text3),
                                        const SizedBox(width: 6),
                                        Expanded(
                                          child: Text(
                                            fields[i].label,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(
                                              fontSize: 13,
                                              color: Fs.text2,
                                              fontWeight: FontWeight.w500,
                                            ),
                                          ),
                                        ),
                                        if (sortField == fields[i].fieldName)
                                          Icon(
                                            sortAsc ? Icons.arrow_upward_rounded : Icons.arrow_downward_rounded,
                                            size: 13,
                                            color: Fs.primary,
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                        Expanded(
                          child: rows.isEmpty
                              ? _emptyRows()
                              : Scrollbar(
                                  controller: vCtrl,
                                  child: ListView.builder(
                                    controller: vCtrl,
                                    itemExtent: 40,
                                    itemCount: rows.length + 1,
                                    itemBuilder: (_, i) {
                                      if (i == rows.length) {
                                        return HoverBox(
                                          radius: 0,
                                          onTap: () => _open(null),
                                          child: Container(
                                            padding: const EdgeInsets.only(left: 18),
                                            alignment: Alignment.centerLeft,
                                            decoration: const BoxDecoration(
                                              border: Border(bottom: BorderSide(color: Fs.lineLight)),
                                            ),
                                            child: const Row(
                                              children: [
                                                Icon(Icons.add_rounded, size: 18, color: Fs.text3),
                                                SizedBox(width: 6),
                                                Text('新增记录', style: TextStyle(fontSize: 13, color: Fs.text3)),
                                              ],
                                            ),
                                          ),
                                        );
                                      }
                                      final r = rows[i];
                                      return HoverReveal(
                                        builder: (context, hover) => GestureDetector(
                                          behavior: HitTestBehavior.opaque,
                                          onTap: () => _open(r),
                                          child: MouseRegion(
                                            cursor: SystemMouseCursors.click,
                                            child: Container(
                                              color: hover ? const Color(0xFFF5F8FF) : Colors.white,
                                              child: Row(
                                                children: [
                                                  _cellBox(
                                                    idxW,
                                                    Center(
                                                      child: hover
                                                          ? const Icon(
                                                              Icons.open_in_full_rounded,
                                                              size: 14,
                                                              color: Fs.primary,
                                                            )
                                                          : Text(
                                                              '${i + 1}',
                                                              style: const TextStyle(fontSize: 12, color: Fs.text3),
                                                            ),
                                                    ),
                                                  ),
                                                  for (var j = 0; j < fields.length; j++)
                                                    _cellBox(
                                                      widths[j],
                                                      FieldValueView(
                                                        field: fields[j],
                                                        value: r.fields[fields[j].fieldName],
                                                      ),
                                                    ),
                                                ],
                                              ),
                                            ),
                                          ),
                                        ),
                                      );
                                    },
                                  ),
                                ),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        Container(
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: Fs.line)),
          ),
          child: Row(
            children: [
              Text(
                keyword.isEmpty ? '${records.length} 条记录' : '${rows.length} / ${records.length} 条记录',
                style: const TextStyle(fontSize: 12, color: Fs.text3),
              ),
              const Spacer(),
              Text('${fields.length} 个字段', style: const TextStyle(fontSize: 12, color: Fs.text3)),
            ],
          ),
        ),
      ],
    );
  }

  Widget _cellBox(double w, Widget child) => Container(
    width: w,
    height: double.infinity,
    padding: const EdgeInsets.symmetric(horizontal: 10),
    alignment: Alignment.centerLeft,
    decoration: const BoxDecoration(
      border: Border(
        right: BorderSide(color: Fs.lineLight),
        bottom: BorderSide(color: Fs.lineLight),
      ),
    ),
    child: child,
  );

  Widget _emptyRows() => EmptyState(
    icon: Icons.table_rows_outlined,
    title: keyword.isEmpty ? '这张表还没有记录' : '没有匹配「$keyword」的记录',
    subtitle: keyword.isEmpty ? '点「添加记录」录入第一条数据' : null,
    action: keyword.isEmpty
        ? FilledButton.icon(
            onPressed: () => _open(null),
            icon: const Icon(Icons.add_rounded, size: 18),
            label: const Text('添加记录'),
          )
        : null,
  );

  // ---------------- 看板视图 ----------------

  Widget _kanban(BuildContext context) {
    final gf = meta.fields.where((f) => f.fieldName == groupField).firstOrNull;
    if (gf == null) {
      return const EmptyState(icon: Icons.view_kanban_outlined, title: '这张表没有单选字段', subtitle: '看板视图需要按单选字段分组，请使用表格视图');
    }
    final rows = visible;
    final opts = [...?gf.options];
    for (final r in rows) {
      final v = fieldText(r.fields[gf.fieldName]);
      if (v.isNotEmpty && !opts.contains(v)) opts.add(v);
    }
    final columns = <String?>[...opts, null];
    final titleField = meta.fields.where((f) => f.type == 1).firstOrNull;
    return Container(
      color: Fs.bg,
      child: Scrollbar(
        controller: kanbanCtrl,
        thumbVisibility: true,
        child: ListView(
          controller: kanbanCtrl,
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.all(16),
          children: [
            for (final col in columns)
              _kanbanColumn(
                gf,
                col,
                rows.where((r) {
                  final v = fieldText(r.fields[gf.fieldName]);
                  return col == null ? v.isEmpty : v == col;
                }).toList(),
                titleField,
              ),
          ],
        ),
      ),
    );
  }

  Widget _kanbanColumn(CosFieldMeta gf, String? option, List<CosRecord> items, CosFieldMeta? titleField) {
    return DragTarget<CosRecord>(
      onWillAcceptWithDetails: (d) => fieldText(d.data.fields[gf.fieldName]) != (option ?? ''),
      onAcceptWithDetails: (d) => _moveTo(d.data, gf.fieldName, option),
      builder: (context, cand, _) => Container(
        width: 280,
        margin: const EdgeInsets.only(right: 12),
        decoration: BoxDecoration(
          color: cand.isNotEmpty ? Fs.primaryLight : const Color(0xFFEFF0F2),
          borderRadius: BorderRadius.circular(10),
          border: cand.isNotEmpty ? Border.all(color: Fs.primary, width: 1.2) : null,
        ),
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 8, 8),
              child: Row(
                children: [
                  option == null ? const FsTag('未分组', color: TagColor.gray) : FsTag(option),
                  const SizedBox(width: 8),
                  Text('${items.length}', style: const TextStyle(fontSize: 13, color: Fs.text3)),
                  const Spacer(),
                  FsIconButton(
                    icon: Icons.add_rounded,
                    tooltip: '在此分组新增',
                    size: 18,
                    onPressed: () => _open(null, preset: option == null ? const {} : {gf.fieldName: option}),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                children: [
                  for (final r in items)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Draggable<CosRecord>(
                        data: r,
                        feedback: AppScope(
                          state: AppScope.read(context),
                          child: Material(
                            color: Colors.transparent,
                            child: Transform.rotate(
                              angle: 0.03,
                              child: SizedBox(width: 264, child: _card(r, gf, titleField, dragging: true)),
                            ),
                          ),
                        ),
                        childWhenDragging: Opacity(opacity: 0.35, child: _card(r, gf, titleField)),
                        child: _card(r, gf, titleField),
                      ),
                    ),
                  if (items.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Center(
                        child: Text('拖动卡片到这里', style: TextStyle(fontSize: 12, color: Fs.text3)),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _card(CosRecord r, CosFieldMeta gf, CosFieldMeta? titleField, {bool dragging = false}) {
    final title = titleField != null ? fieldText(r.fields[titleField.fieldName]) : '';
    final others = meta.fields
        .where(
          (f) =>
              f.fieldName != gf.fieldName &&
              f.fieldName != titleField?.fieldName &&
              !isEmptyValue(r.fields[f.fieldName]),
        )
        .take(4)
        .toList();
    return HoverBox(
      onTap: () => _open(r),
      hoverColor: Colors.white,
      radius: 8,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(8),
          boxShadow: dragging ? Fs.shadowL : Fs.shadow,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title.isEmpty ? '未命名记录' : title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: title.isEmpty ? Fs.text3 : Fs.text1),
            ),
            for (final f in others) ...[
              const SizedBox(height: 8),
              Text(f.label, style: const TextStyle(fontSize: 11, color: Fs.text3)),
              const SizedBox(height: 2),
              FieldValueView(field: f, value: r.fields[f.fieldName]),
            ],
          ],
        ),
      ),
    );
  }
}
