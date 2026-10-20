/// 单张数据表：视图标签（R-BT-03）、表格 / 看板、字段管理（R-BT-02）、分组（R-BT-04）、
/// 实时刷新（R-BT-05）、批量操作（R-BT-06）。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/phase2.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/agent_sidebar.dart';
import '../widgets/common.dart';
import 'bitable_field.dart';
import 'field_editor.dart';
import 'view_engine.dart';
import 'table_import_export.dart';
import 'view_panels.dart';

class TableView extends StatefulWidget {
  final CosTableMeta meta;

  /// 表结构变化（字段管理、别人改了字段）时通知侧边栏更新缓存。
  final ValueChanged<CosTableMeta>? onMetaChanged;

  /// 打开后定位并打开这条记录（通知跳转）。
  final String? focusRecordId;

  /// 迭代 5：打开时切到这个视图（工作台快捷方式、可分享网址的 ?view=）。
  final String? initialViewId;
  const TableView({super.key, required this.meta, this.onMetaChanged, this.focusRecordId, this.initialViewId});
  @override
  State<TableView> createState() => TableViewState();
}

class TableUndo {
  final String label;
  final List<({String recordId, Map<String, dynamic> fields})> restore;
  const TableUndo(this.label, this.restore);
}

class TableViewState extends State<TableView> {
  late CosTableMeta meta = widget.meta;
  List<CosRecord> records = [];
  bool loading = true;
  String? error;

  List<CosView> views = [];
  String? viewId;

  /// 没有保存权限时的临时配置（只自己可见，不保存）。
  CosViewConfig? tempConfig;
  String keyword = '';

  /// 当前记录是按哪份筛选从后端取的（view_id 模式下筛选变了要重取）。
  String? _fetchedWith;

  final Set<String> selected = {};
  String? _anchor; // Shift 连选的起点
  final Set<String> collapsed = {};
  final Map<String, DateTime> flash = {};
  final Set<String> fading = {};
  String? editingRecordId;
  String? _remoteEditor;
  bool _deletedWhileEditing = false;
  TableUndo? lastUndo;

  final Map<String, double> _liveWidths = {};
  Timer? _saveTimer;
  bool _saving = false;
  StreamSubscription<CosEvent>? _sub;
  late final AppState _s = AppScope.read(context);
  late final String _topic = 'table:${widget.meta.key}';

  final hCtrl = ScrollController();
  final vCtrl = ScrollController();
  final kanbanCtrl = ScrollController();
  final focus = FocusNode();

  CosApiClient get api => _s.api;
  bool get useViews => _s.feature('table.views');
  CosPermissions get perms => meta.permsFor(_s.me);
  bool get canManageFields => _s.feature('table.fields') && perms.canManage;

  CosView get view =>
      views.where((v) => v.viewId == viewId).firstOrNull ??
      (views.isNotEmpty ? views.first : const CosView(viewId: 'local_grid', name: '表格视图', local: true));
  CosViewConfig get cfg => tempConfig ?? view.config;
  bool get isKanban => view.type == 'kanban';

  bool canSave(CosView v) =>
      useViews && !v.local && (v.personal ? (v.ownerId == null || v.ownerId == _s.me.userId) : perms.canEdit);

  @override
  void initState() {
    super.initState();
    _s.subscribe(_topic);
    _sub = _s.eventStream.listen(_onEvent);
    _init();
  }

  @override
  void didUpdateWidget(TableView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.meta != widget.meta && (widget.meta.version ?? 0) >= (meta.version ?? 0)) meta = widget.meta;
  }

  @override
  void dispose() {
    _s.unsubscribe(_topic);
    _sub?.cancel();
    _saveTimer?.cancel();
    hCtrl.dispose();
    vCtrl.dispose();
    kanbanCtrl.dispose();
    focus.dispose();
    super.dispose();
  }

  // ---------------- 加载 ----------------

  List<CosView> _localViews() {
    final sel = meta.fields.where((f) => f.type == 3).firstOrNull?.fieldName;
    final old = {for (final v in views.where((v) => v.local)) v.viewId: v};
    return [
      old['local_grid'] ?? const CosView(viewId: 'local_grid', name: '表格视图', local: true),
      old['local_kanban'] ?? CosView(viewId: 'local_kanban', name: '看板视图', type: 'kanban', local: true, config: CosViewConfig(kanbanField: sel)),
    ];
  }

  Future<void> _init() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      await _loadViews();
      await _loadRecords();
      if (!mounted) return;
      setState(() => loading = false);
      final focusId = widget.focusRecordId;
      if (focusId != null) {
        final r = records.where((r) => r.recordId == focusId).firstOrNull;
        if (r != null) {
          _open(r);
        } else {
          showToast(context, '这条记录已被删除或你没有权限查看', error: true);
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  /// 重新拉视图；返回当前视图是否被别人改过。
  Future<bool> _loadViews() async {
    List<CosView> list;
    if (useViews) {
      try {
        list = await api.listViews(meta.key);
      } on CosApiException catch (e) {
        if (e.statusCode != 404 && e.statusCode != 405) rethrow;
        list = const [];
      }
      if (list.isEmpty) list = _localViews();
    } else {
      list = _localViews();
    }
    if (!mounted) return false;
    final before = view;
    final changed = views.isNotEmpty &&
        list.any((v) => v.viewId == before.viewId && v.version > before.version && jsonEncode(v.config.toJson()) != jsonEncode(before.config.toJson()));
    final wanted = before.viewId.isEmpty || views.isEmpty ? widget.initialViewId : null;
    setState(() {
      views = list;
      if (wanted != null && list.any((v) => v.viewId == wanted)) {
        viewId = wanted;
        tempConfig = null;
      } else if (!list.any((v) => v.viewId == viewId)) {
        viewId = list.first.viewId;
        tempConfig = null;
      }
    });
    return changed;
  }

  String _filterKey(CosViewConfig c) => jsonEncode({'c': c.conjunction, 'f': [for (final x in c.conditions) x.toJson()]});

  /// 后端按视图取：只有在用已保存的公共 / 个人视图时；临时筛选或本地视图就取全部、本地计算。
  Future<void> _loadRecords() async {
    final v = view;
    final byView = useViews && !v.local && tempConfig == null;
    List<CosRecord> list;
    if (byView) {
      try {
        list = (await api.listViewRecords(meta.key, v.viewId)).items;
      } on CosApiException catch (e) {
        if (e.statusCode != 400 && e.statusCode != 404 && e.statusCode != 422) rethrow;
        list = (await api.listAllRecords(meta.key)).items; // 后端还不支持 view_id
      }
    } else {
      list = (await api.listAllRecords(meta.key)).items;
    }
    if (!mounted) return;
    setState(() {
      records = list;
      _fetchedWith = byView ? _filterKey(v.config) : '*';
      selected.removeWhere((id) => !list.any((r) => r.recordId == id));
    });
  }

  Future<void> _reload({bool views = false}) async {
    try {
      if (views) await _loadViews();
      await _loadRecords();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  /// 筛选比后端取数时更宽松，需要重新取数。
  void _ensureRecordsFor(CosViewConfig c) {
    if (_fetchedWith == '*' || _fetchedWith == null) return;
    if (_fetchedWith != _filterKey(c)) _reload();
  }

  Future<void> _refreshMeta() async {
    try {
      final t = await api.getTable(meta.key);
      if (!mounted) return;
      setState(() => meta = t);
      widget.onMetaChanged?.call(t);
    } catch (_) {}
  }

  void _applyMeta(CosTableMeta? t) {
    if (t == null || !mounted) return;
    setState(() => meta = t);
    widget.onMetaChanged?.call(t);
  }

  // ---------------- 视图配置：实时生效 + 自动保存 ----------------

  void updateConfig(CosViewConfig n) {
    final v = view;
    if (canSave(v)) {
      setState(() {
        tempConfig = null;
        views = [for (final x in views) x.viewId == v.viewId ? x.copyWith(config: n) : x];
      });
      _saveTimer?.cancel();
      _saveTimer = Timer(const Duration(milliseconds: 600), () => _saveView(v.viewId));
    } else {
      setState(() => tempConfig = n);
      if (!v.local && useViews) _reload(); // 临时筛选：改为本地计算全部记录
    }
    _ensureRecordsFor(n);
  }

  Future<void> _saveView(String id) async {
    final v = views.where((x) => x.viewId == id).firstOrNull;
    if (v == null) return;
    if (_saving) {
      _saveTimer = Timer(const Duration(milliseconds: 300), () => _saveView(id));
      return;
    }
    _saving = true;
    try {
      final saved = await api.updateView(meta.key, id, config: v.config, version: v.version);
      if (!mounted) return;
      setState(() => views = [
            for (final x in views)
              x.viewId == id ? saved.copyWith(config: x.config == v.config ? saved.config : x.config) : x,
          ]);
      if (_fetchedWith != '*' && _fetchedWith != _filterKey(saved.config)) _reload();
    } on CosApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'VERSION_CONFLICT') {
        await _loadViews();
        await _loadRecords();
        if (mounted) showToast(context, '内容已被别人修改，已为你刷新', error: true);
      } else {
        showToast(context, '视图保存失败：${describeError(e)}', error: true);
      }
    } catch (e) {
      if (mounted) showToast(context, '视图保存失败：${describeError(e)}', error: true);
    } finally {
      _saving = false;
    }
  }

  void _selectView(String id) {
    if (id == viewId) return;
    _saveTimer?.cancel();
    final pending = viewId;
    if (pending != null && _saveTimer != null) _saveView(pending);
    setState(() {
      viewId = id;
      tempConfig = null;
      selected.clear();
    });
    if (useViews && !view.local) _reload();
  }

  Future<void> saveTempAsPersonal() async {
    final c = tempConfig;
    if (c == null) return;
    try {
      final v = await api.createView(meta.key, name: '${view.name}（个人）', type: view.type, personal: true, config: c);
      if (!mounted) return;
      setState(() {
        views = [...views, v];
        viewId = v.viewId;
        tempConfig = null;
      });
      showToast(context, '已保存为个人视图，只有你能看到');
      _reload();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  // ---------------- 实时事件 ----------------

  void _onEvent(CosEvent e) {
    if (!mounted) return;
    final key = e.str('table_key');
    if (e.eventType == 'resync.required') {
      _reload(views: true);
      return;
    }
    if (key != meta.key) return;
    switch (e.eventType) {
      case 'record.changed':
        _onRecordChanged(e);
      case 'table.schema_changed':
        final ver = (e.raw['version'] as num?)?.toInt();
        if (ver == null || meta.version == null || ver > meta.version!) _refreshMeta();
      case 'table.view_changed':
        _loadViews().then((changed) {
          if (!mounted) return;
          if (changed) {
            showToast(context, '视图已被其他成员修改，已刷新');
            _reload();
          }
        });
    }
  }

  void _onRecordChanged(CosEvent e) {
    final id = e.str('record_id') ?? '';
    final action = e.str('action');
    final data = e.map('record');
    final opId = e.str('operator_id');
    final remote = opId != null && opId != _s.me.userId;
    final idx = records.indexWhere((r) => r.recordId == id);
    if (action == 'deleted') {
      if (idx < 0) return;
      if (editingRecordId == id && remote) _deletedWhileEditing = true;
      setState(() {
        fading.add(id);
        selected.remove(id);
      });
      Timer(const Duration(milliseconds: 320), () {
        if (!mounted) return;
        setState(() {
          fading.remove(id);
          records.removeWhere((r) => r.recordId == id);
        });
      });
      return;
    }
    if (data == null) {
      _reload(); // 事件里没有完整记录（保密记录等），整页重取
      return;
    }
    final r = CosRecord.fromJson(data);
    if (action == 'created') {
      if (idx >= 0) return; // 自己刚建的已在列表里
      setState(() {
        records = [...records, r];
        flash[id] = DateTime.now();
      });
      Timer(const Duration(milliseconds: 1100), () {
        if (mounted) setState(() => flash.remove(id));
      });
    } else {
      if (editingRecordId == id && remote) _remoteEditor = _s.userName(opId);
      if (idx < 0) {
        setState(() => records = [...records, r]);
      } else {
        setState(() => records[idx] = r);
      }
    }
  }

  // ---------------- 记录 ----------------

  Future<void> _open(CosRecord? r, {Map<String, dynamic> preset = const {}}) async {
    editingRecordId = r?.recordId;
    _remoteEditor = null;
    _deletedWhileEditing = false;
    final changed = await showRecordDialog(context, table: meta, record: r, preset: preset);
    if (!mounted) return;
    if (_deletedWhileEditing) {
      showToast(context, '记录已被其他成员删除', error: true);
    } else if (_remoteEditor != null) {
      showToast(context, '这条记录刚被 $_remoteEditor 修改过');
    }
    editingRecordId = null;
    if (changed) _reload();
  }

  /// 分组里新增：自动带上分组字段的值。
  Map<String, dynamic> _presetFor(List<String> path) {
    final out = <String, dynamic>{};
    for (var i = 0; i < path.length && i < cfg.group.length; i++) {
      final f = meta.field(cfg.group[i].fieldName);
      final v = path[i];
      if (f == null || v.isEmpty) continue;
      if (f.type == 1 || f.type == 3 || f.type == 15) out[f.fieldName] = v;
      if (f.type == 2 && num.tryParse(v) != null) out[f.fieldName] = num.parse(v);
      if (f.type == 4) out[f.fieldName] = v.split(RegExp(r'[、,，]\s*'));
    }
    return out;
  }

  /// 看板拖拽：先本地更新，失败回滚。
  Future<void> moveTo(CosRecord r, String field, String? option) async {
    if (fieldText(r.fields[field]) == (option ?? '')) return;
    final idx = records.indexWhere((x) => x.recordId == r.recordId);
    if (idx < 0) return;
    final old = records[idx];
    setState(() => records[idx] = CosRecord(
          recordId: r.recordId,
          fields: {...r.fields, field: option},
          createdAt: r.createdAt,
          updatedAt: DateTime.now(),
        ));
    try {
      await api.updateRecord(meta.key, r.recordId, {field: option});
    } catch (e) {
      if (!mounted) return;
      setState(() => records[idx] = old);
      showToast(context, describeError(e), error: true);
    }
  }

  CosRecord? _rec(String id) => records.where((r) => r.recordId == id).firstOrNull;

  String _title(String id) {
    final r = _rec(id);
    final pf = meta.primaryField ?? meta.fields.firstOrNull?.fieldName;
    final t = r == null || pf == null ? '' : fieldText(r.fields[pf]);
    return t.isEmpty ? id : t;
  }

  /// 批量接口不可用（404）时逐条调用，结果格式一致。
  Future<CosBatchResult> _batch(
    Future<CosBatchResult> Function() batch,
    List<String> ids,
    Future<void> Function(String id) single,
  ) async {
    try {
      return await batch();
    } on CosApiException catch (e) {
      if (e.statusCode != 404 && e.statusCode != 405) rethrow;
    }
    final ok = <dynamic>[];
    final failed = <({String recordId, String message})>[];
    for (final id in ids) {
      try {
        await single(id);
        ok.add(id);
      } catch (e) {
        failed.add((recordId: id, message: describeError(e)));
      }
    }
    return CosBatchResult(ok, failed);
  }

  Future<void> _showFailures(String action, CosBatchResult r) async {
    if (r.failed.isEmpty || !mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('$action：${r.succeeded.length} 条成功，${r.failed.length} 条失败'),
        content: SizedBox(
          width: 460,
          height: math.min(360, 56.0 * r.failed.length + 8),
          child: ListView(children: [
            for (final f in r.failed)
              ListTile(
                dense: true,
                leading: const Icon(Icons.error_outline_rounded, color: Fs.red, size: 18),
                title: Text(_title(f.recordId), overflow: TextOverflow.ellipsis),
                subtitle: Text(f.message),
              ),
          ]),
        ),
        actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('知道了'))],
      ),
    );
  }

  Future<void> batchUpdate(String fieldName, dynamic value) async {
    final ids = selected.toList();
    final restore = [
      for (final id in ids) (recordId: id, fields: <String, dynamic>{fieldName: _rec(id)?.fields[fieldName]}),
    ];
    try {
      final r = await _batch(
        () => api.batchUpdate(meta.key, recordIds: ids, fields: {fieldName: value}),
        ids,
        (id) => api.updateRecord(meta.key, id, {fieldName: value}),
      );
      final failedIds = {for (final f in r.failed) f.recordId};
      lastUndo = TableUndo('批量修改「${meta.field(fieldName)?.label ?? fieldName}」',
          restore.where((x) => !failedIds.contains(x.recordId)).toList());
      if (!mounted) return;
      _toastUndo('已修改 ${ids.length - failedIds.length} 条记录');
      await _showFailures('批量修改', r);
      await _reload();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  void _toastUndo(String msg) {
    final m = ScaffoldMessenger.maybeOf(context);
    if (m == null) return;
    m.hideCurrentSnackBar();
    m.showSnackBar(SnackBar(
      duration: const Duration(seconds: 5),
      content: Text(msg),
      action: SnackBarAction(label: '撤销（⌘Z）', onPressed: undo),
    ));
  }

  /// 撤销最近一次批量修改：用旧值做反向 batch_update。
  Future<void> undo() async {
    final u = lastUndo;
    if (u == null || u.restore.isEmpty) return;
    lastUndo = null;
    try {
      final r = await _batch(
        () => api.batchUpdate(meta.key, records: u.restore),
        [for (final x in u.restore) x.recordId],
        (id) => api.updateRecord(meta.key, id, u.restore.firstWhere((x) => x.recordId == id).fields),
      );
      if (!mounted) return;
      showToast(context, '已撤销${u.label}');
      await _showFailures('撤销', r);
      await _reload();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> batchDelete() async {
    final ids = selected.toList();
    final ok = await confirmDialog(context,
        title: '删除 ${ids.length} 条记录', content: '删除后无法恢复，确定要删除选中的记录吗？', ok: '删除', danger: true);
    if (!ok || !mounted) return;
    try {
      final r = await _batch(() => api.batchDelete(meta.key, ids), ids, (id) => api.deleteRecord(meta.key, id));
      if (!mounted) return;
      setState(() => selected.clear());
      showToast(context, '已删除 ${r.succeeded.length} 条记录');
      await _showFailures('批量删除', r);
      await _reload();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> batchDuplicate() async {
    final ids = selected.toList();
    final rows = [
      for (final id in ids)
        if (_rec(id) != null)
          {
            for (final e in _rec(id)!.fields.entries)
              if (meta.field(e.key)?.type != 17) e.key: e.value, // 附件不复制
          },
    ];
    try {
      final r = await _batch(
        () => api.batchCreate(meta.key, rows),
        ids,
        (id) async => api.createRecord(meta.key, rows[ids.indexOf(id)]),
      );
      if (!mounted) return;
      showToast(context, '已复制 ${r.succeeded.length} 条记录');
      await _showFailures('复制记录', r);
      await _reload();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  void toggleSelect(String id, List<CosRecord> ordered, {bool shift = false}) {
    setState(() {
      if (shift && _anchor != null) {
        final a = ordered.indexWhere((r) => r.recordId == _anchor);
        final b = ordered.indexWhere((r) => r.recordId == id);
        if (a >= 0 && b >= 0) {
          for (var i = math.min(a, b); i <= math.max(a, b); i++) {
            selected.add(ordered[i].recordId);
          }
          return;
        }
      }
      if (!selected.remove(id)) selected.add(id);
      _anchor = id;
    });
  }

  // ---------------- 视图管理 ----------------

  Future<String?> _askName(String title, String initial) async {
    final c = TextEditingController(text: initial);
    final r = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: c,
          autofocus: true,
          maxLength: 40,
          decoration: const InputDecoration(labelText: '视图名称'),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('确定')),
        ],
      ),
    );
    c.dispose();
    return r == null || r.isEmpty ? null : r;
  }

  Future<void> createView(String type) async {
    final name = await _askName(type == 'kanban' ? '新建看板视图' : '新建表格视图', type == 'kanban' ? '看板视图' : '表格视图');
    if (name == null) return;
    final sel = meta.fields.where((f) => f.type == 3).firstOrNull?.fieldName;
    try {
      final v = await api.createView(meta.key,
          name: name, type: type, personal: !perms.canEdit, config: CosViewConfig(kanbanField: type == 'kanban' ? sel : null));
      if (!mounted) return;
      setState(() {
        views = [...views, v];
        viewId = v.viewId;
        tempConfig = null;
      });
      _reload();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> viewAction(CosView v, String action) async {
    try {
      switch (action) {
        case 'rename':
          final name = await _askName('重命名视图', v.name);
          if (name == null) return;
          final n = await api.updateView(meta.key, v.viewId, name: name, version: v.version);
          _replaceView(n);
        case 'duplicate':
          final n = await api.createView(meta.key,
              name: '${v.name} 副本', type: v.type, personal: v.personal || !perms.canEdit, config: v.config);
          if (!mounted) return;
          setState(() {
            views = [...views, n];
            viewId = n.viewId;
          });
          _reload();
        case 'personal':
        case 'public':
          final n = await api.updateView(meta.key, v.viewId, personal: action == 'personal', version: v.version);
          _replaceView(n);
          if (mounted) showToast(context, action == 'personal' ? '已设为个人视图，只有你能看到' : '已设为公共视图，所有成员都能看到');
        case 'delete':
          final ok = await confirmDialog(context,
              title: '删除视图「${v.name}」', content: '只删除视图的筛选、排序等设置，不会删除记录。', ok: '删除', danger: true);
          if (!ok) return;
          await api.deleteView(meta.key, v.viewId);
          if (!mounted) return;
          setState(() {
            views = views.where((x) => x.viewId != v.viewId).toList();
            if (viewId == v.viewId) {
              viewId = views.firstOrNull?.viewId;
              tempConfig = null;
            }
          });
          _reload();
      }
    } on CosApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'VERSION_CONFLICT') {
        await _loadViews();
        if (mounted) showToast(context, '内容已被别人修改，已为你刷新', error: true);
      } else {
        showToast(context, describeError(e), error: true);
      }
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  void _replaceView(CosView n) {
    if (!mounted) return;
    setState(() => views = [for (final x in views) x.viewId == n.viewId ? n : x]);
  }

  Future<void> reorderViews(int a, int b) async {
    final list = [...views];
    list.insert(b, list.removeAt(a));
    setState(() => views = list);
    if (!useViews || views.any((v) => v.local)) return;
    try {
      await api.reorderViews(meta.key, [for (final v in list) v.viewId]);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  // ---------------- 列头菜单（字段） ----------------

  Future<void> fieldAction(CosFieldMeta f, String action, List<CosFieldMeta> visibleFields) async {
    final i = visibleFields.indexWhere((x) => x.fieldName == f.fieldName);
    switch (action) {
      case 'edit':
        _applyMeta(await showFieldEditor(context, api: api, table: meta, field: f));
      case 'insert_left':
      case 'insert_right':
        final after = action == 'insert_right' ? f.fieldName : (i > 0 ? visibleFields[i - 1].fieldName : null);
        final before = {for (final x in meta.fields) x.fieldName};
        final t = await showFieldEditor(context, api: api, table: meta, afterField: after);
        if (t == null) return;
        _applyMeta(t);
        // 视图有自己的列顺序时，把新字段放到点的位置
        final added = t.fields.where((x) => !before.contains(x.fieldName)).firstOrNull;
        if (added != null && cfg.fieldOrder.isNotEmpty) {
          final order = [for (final x in cfg.orderedFields(t.fields)) x.fieldName]..remove(added.fieldName);
          final pos = after == null ? 0 : order.indexOf(after) + 1;
          order.insert(pos.clamp(0, order.length), added.fieldName);
          updateConfig(cfg.copyWith(fieldOrder: order));
        }
      case 'asc':
      case 'desc':
        updateConfig(cfg.copyWith(sort: [CosSortSpec(f.fieldName, desc: action == 'desc')]));
      case 'group':
        if (cfg.group.any((g) => g.fieldName == f.fieldName) || cfg.group.length >= 3) {
          showToast(context, cfg.group.length >= 3 ? '最多按 3 个字段分组' : '已按这个字段分组');
          return;
        }
        updateConfig(cfg.copyWith(group: [...cfg.group, CosSortSpec(f.fieldName)]));
      case 'hide':
        updateConfig(cfg.copyWith(hiddenFields: [...cfg.hiddenFields, f.fieldName]));
      case 'delete':
        final ok = await confirmDialog(context,
            title: '删除字段「${f.label}」', content: '删除后，所有记录中这一列的数据都会被清除，且无法恢复。', ok: '删除', danger: true);
        if (!ok) return;
        try {
          _applyMeta(await api.deleteField(meta.key, f.fieldName, baseVersion: meta.version));
        } on CosApiException catch (e) {
          if (!mounted) return;
          if (e.code == 'VERSION_CONFLICT') {
            await _refreshMeta();
            if (mounted) showToast(context, '内容已被别人修改，已为你刷新', error: true);
          } else {
            showToast(context, describeError(e), error: true);
          }
        }
    }
  }

  Future<void> openFieldManager() async {
    final t = await showDialog<CosTableMeta>(
      context: context,
      builder: (_) => FieldManagerDialog(api: api, table: meta),
    );
    if (t != null) {
      _applyMeta(t);
    } else {
      _refreshMeta();
    }
  }

  // ---------------- 界面 ----------------

  @override
  Widget build(BuildContext context) {
    final ordered = applyView(cfg, records, keyword: keyword);
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyZ, meta: true): undo,
        const SingleActivator(LogicalKeyboardKey.keyZ, control: true): undo,
        const SingleActivator(LogicalKeyboardKey.escape): () => setState(selected.clear),
      },
      child: Focus(
        focusNode: focus,
        autofocus: true,
        child: Container(
          color: Colors.white,
          child: Column(children: [
            _header(),
            _viewTabs(),
            const Divider(),
            selected.isNotEmpty ? _selectionBar(ordered) : _toolbar(),
            if (tempConfig != null && !view.local) _tempBanner(),
            const Divider(),
            Expanded(
              child: loading
                  ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                  : error != null
                      ? EmptyState(
                          icon: Icons.cloud_off_outlined,
                          title: '记录加载失败',
                          subtitle: error,
                          action: OutlinedButton(onPressed: _init, child: const Text('重试')),
                        )
                      : isKanban
                          ? _kanban(ordered)
                          : _grid(ordered),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _header() => Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 16, 2),
        child: Row(children: [
          Expanded(
            child: Row(children: [
              Flexible(
                child: Text(meta.name,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              ),
              if (meta.description != null) ...[
                const SizedBox(width: 6),
                Tooltip(message: meta.description!, child: const Icon(Icons.info_outline_rounded, size: 16, color: Fs.text3)),
              ],
              if (!perms.canEdit) ...[
                const SizedBox(width: 8),
                const FsTag('只读', color: TagColor.gray, fontSize: 11),
              ],
            ]),
          ),
          if (perms.canEdit)
            FilledButton.icon(
              onPressed: () => _open(null),
              icon: const Icon(Icons.add_rounded, size: 18),
              label: const Text('添加记录'),
            ),
        ]),
      );

  Widget _viewTabs() {
    return SizedBox(
      height: 40,
      child: Row(children: [
        Expanded(
          child: ReorderableListView.builder(
            scrollDirection: Axis.horizontal,
            buildDefaultDragHandles: false,
            padding: const EdgeInsets.only(left: 12),
            itemCount: views.length,
            onReorderItem: reorderViews,
            proxyDecorator: (child, _, _) => Material(color: Colors.transparent, child: child),
            itemBuilder: (_, i) => ReorderableDelayedDragStartListener(
              key: ValueKey(views[i].viewId),
              index: i,
              child: _viewTab(views[i]),
            ),
          ),
        ),
        if (useViews && !views.any((v) => v.local))
          PopupMenuButton<String>(
            tooltip: '新建视图',
            position: PopupMenuPosition.under,
            onSelected: createView,
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'grid', child: Row(children: [Icon(Icons.grid_on_rounded, size: 16), SizedBox(width: 8), Text('表格视图')])),
              PopupMenuItem(value: 'kanban', child: Row(children: [Icon(Icons.view_kanban_outlined, size: 16), SizedBox(width: 8), Text('看板视图')])),
            ],
            child: const Padding(
              padding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.add_rounded, size: 17, color: Fs.text2),
                SizedBox(width: 2),
                Text('新建视图', style: TextStyle(fontSize: 13, color: Fs.text2)),
              ]),
            ),
          ),
        const SizedBox(width: 8),
      ]),
    );
  }

  Widget _viewTab(CosView v) {
    final sel = v.viewId == view.viewId;
    final manageable = useViews && !v.local;
    final mine = v.personal && (v.ownerId == null || v.ownerId == _s.me.userId);
    final canEditView = v.personal ? mine : perms.canEdit;
    Future<void> menu(Offset pos) async {
      if (!manageable) return;
      final a = await showMenu<String>(
        context: context,
        position: RelativeRect.fromLTRB(pos.dx, pos.dy, pos.dx, pos.dy),
        items: [
          PopupMenuItem(value: 'rename', enabled: canEditView, child: const Text('重命名')),
          const PopupMenuItem(value: 'duplicate', child: Text('复制视图')),
          if (!v.personal) PopupMenuItem(value: 'personal', enabled: perms.canEdit, child: const Text('设为个人视图')),
          if (v.personal) PopupMenuItem(value: 'public', enabled: mine && perms.canEdit, child: const Text('设为公共视图')),
          const PopupMenuDivider(),
          PopupMenuItem(
            value: 'delete',
            enabled: canEditView && views.length > 1,
            child: const Text('删除视图', style: TextStyle(color: Fs.red)),
          ),
        ],
      );
      if (a != null) viewAction(v, a);
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
      child: GestureDetector(
        onSecondaryTapDown: (d) => menu(d.globalPosition),
        onLongPressStart: (d) => menu(d.globalPosition),
        child: HoverBox(
          onTap: () => _selectView(v.viewId),
          selected: sel,
          selectedColor: Fs.primaryLight,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(v.type == 'kanban' ? Icons.view_kanban_outlined : Icons.grid_on_rounded,
                size: 16, color: sel ? Fs.primary : Fs.text2),
            if (v.personal)
              Tooltip(
                message: '个人视图，仅自己可见',
                child: Icon(Icons.person_rounded, size: 11, color: sel ? Fs.primary : Fs.text3),
              ),
            const SizedBox(width: 5),
            Text(v.name,
                style: TextStyle(
                    fontSize: 13, color: sel ? Fs.primary : Fs.text2, fontWeight: sel ? FontWeight.w500 : FontWeight.normal)),
            if (sel && manageable)
              Builder(
                builder: (b) => InkWell(
                  borderRadius: BorderRadius.circular(4),
                  onTap: () {
                    final box = b.findRenderObject() as RenderBox;
                    menu(box.localToGlobal(Offset(0, box.size.height)));
                  },
                  child: const Padding(
                    padding: EdgeInsets.only(left: 2),
                    child: Icon(Icons.keyboard_arrow_down_rounded, size: 16, color: Fs.primary),
                  ),
                ),
              ),
          ]),
        ),
      ),
    );
  }

  Widget _toolButton(IconData icon, String label, int count, VoidCallback onTap, {String? tooltip}) {
    final active = count > 0;
    return Tooltip(
      message: tooltip ?? label,
      child: HoverBox(
        onTap: onTap,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        selected: active,
        selectedColor: Fs.primaryBg,
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 16, color: active ? Fs.primary : Fs.text2),
          const SizedBox(width: 4),
          Text(active ? '$label $count' : label, style: TextStyle(fontSize: 13, color: active ? Fs.primary : Fs.text2)),
        ]),
      ),
    );
  }

  Widget _toolbar() {
    final narrow = MediaQuery.sizeOf(context).width < 900;
    final c = cfg;
    final selectFields = meta.fields.where((f) => f.type == 3).toList();
    final kf = meta.field(c.kanbanField ?? '') ?? selectFields.firstOrNull;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 16, 6),
      child: Row(children: [
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: [
              _toolButton(Icons.filter_alt_outlined, '筛选', c.conditions.length,
                  () => showFilterPanel(context, meta, cfg, updateConfig)),
              if (!isKanban)
                _toolButton(Icons.segment_rounded, '分组', c.group.length,
                    () => showSortPanel(context, meta, cfg, updateConfig, group: true)),
              _toolButton(Icons.swap_vert_rounded, '排序', c.sort.length, () => showSortPanel(context, meta, cfg, updateConfig)),
              if (_s.feature('table.export'))
                Builder(builder: (bctx) => _toolButton(Icons.download_rounded, '导出', 0, () async {
                  final box = bctx.findRenderObject() as RenderBox;
                  final f = await pickExportFormat(context, box.localToGlobal(box.size.bottomLeft(Offset.zero)));
                  if (f != null && mounted) await exportTable(context, meta, viewId: view.local ? null : view.viewId, format: f);
                })),
              _toolButton(Icons.visibility_off_outlined, '隐藏字段',
                  c.hiddenFields.where((h) => meta.field(h) != null).length,
                  () => showFieldsPanel(context, meta, cfg, updateConfig)),
              if (!isKanban)
                PopupMenuButton<String>(
                  tooltip: '行高',
                  position: PopupMenuPosition.under,
                  onSelected: (v) => updateConfig(cfg.copyWith(rowHeight: v)),
                  itemBuilder: (_) => [
                    for (final e in const {'compact': '紧凑', 'standard': '标准', 'loose': '宽松'}.entries)
                      CheckedPopupMenuItem(value: e.key, checked: c.rowHeight == e.key, child: Text(e.value)),
                  ],
                  child: _toolButtonStatic(Icons.format_line_spacing_rounded, '行高'),
                ),
              if (isKanban)
                PopupMenuButton<String>(
                  tooltip: '看板按哪个单选字段分列',
                  position: PopupMenuPosition.under,
                  enabled: selectFields.isNotEmpty,
                  onSelected: (v) => updateConfig(cfg.copyWith(kanbanField: v)),
                  itemBuilder: (_) => [
                    for (final f in selectFields)
                      CheckedPopupMenuItem(value: f.fieldName, checked: kf?.fieldName == f.fieldName, child: Text(f.label)),
                  ],
                  child: _toolButtonStatic(Icons.view_week_outlined, kf == null ? '无单选字段' : '分列：${kf.label}'),
                ),
              if (canManageFields)
                _toolButton(Icons.tune_rounded, '字段管理', 0, openFieldManager, tooltip: '新增、编辑、删除字段，调整默认顺序'),
            ]),
          ),
        ),
        SizedBox(
          width: narrow ? 140 : 220,
          child: FsSearchField(hint: '搜索记录', onChanged: (v) => setState(() => keyword = v.trim())),
        ),
        const SizedBox(width: 4),
        FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', onPressed: () => _reload(views: true)),
        AgentSidebarButton(contextOf: () => AgentContext(kind: 'table', id: widget.meta.key, title: widget.meta.name, viewId: viewId)),
      ]),
    );
  }

  Widget _toolButtonStatic(IconData icon, String label) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 16, color: Fs.text2),
          const SizedBox(width: 4),
          Text(label, style: const TextStyle(fontSize: 13, color: Fs.text2)),
        ]),
      );

  Widget _selectionBar(List<CosRecord> ordered) {
    final all = ordered.length;
    return Container(
      color: Fs.primaryBg,
      padding: const EdgeInsets.fromLTRB(16, 6, 12, 6),
      child: Row(children: [
        Text('已选 ${selected.length} 条', style: const TextStyle(fontSize: 13, color: Fs.primary, fontWeight: FontWeight.w500)),
        if (selected.length < all)
          TextButton(
            onPressed: () => setState(() => selected.addAll(ordered.map((r) => r.recordId))),
            child: Text('选中全部 $all 条'),
          ),
        const SizedBox(width: 8),
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: [
              if (perms.canEdit) ...[
                TextButton.icon(
                  onPressed: () async {
                    final r = await showBatchEditDialog(context, meta);
                    if (r != null) batchUpdate(r.$1, r.$2);
                  },
                  icon: const Icon(Icons.edit_note_rounded, size: 18),
                  label: const Text('批量修改'),
                ),
                TextButton.icon(
                  onPressed: batchDuplicate,
                  icon: const Icon(Icons.copy_all_rounded, size: 17),
                  label: const Text('复制为新记录'),
                ),
                TextButton.icon(
                  style: TextButton.styleFrom(foregroundColor: Fs.red),
                  onPressed: batchDelete,
                  icon: const Icon(Icons.delete_outline_rounded, size: 18),
                  label: const Text('删除'),
                ),
              ],
              if (_s.feature('table.export'))
                TextButton.icon(
                  onPressed: () => exportTable(context, meta, viewId: view.local ? null : view.viewId, recordIds: selected.toList()),
                  icon: const Icon(Icons.download_rounded, size: 17),
                  label: const Text('导出选中'),
                ),
              if (lastUndo != null)
                TextButton.icon(onPressed: undo, icon: const Icon(Icons.undo_rounded, size: 17), label: const Text('撤销上次修改')),
            ]),
          ),
        ),
        TextButton(onPressed: () => setState(selected.clear), child: const Text('取消选择')),
      ]),
    );
  }

  Widget _tempBanner() => Container(
        width: double.infinity,
        color: const Color(0xFFFFF7E8),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        child: Row(children: [
          const Icon(Icons.visibility_outlined, size: 16, color: Fs.orange),
          const SizedBox(width: 6),
          const Expanded(
            child: Text('仅自己可见的临时筛选，你没有修改这个视图的权限', style: TextStyle(fontSize: 12, color: Fs.text2)),
          ),
          if (useViews) TextButton(onPressed: saveTempAsPersonal, child: const Text('保存为个人视图')),
          TextButton(
            onPressed: () {
              setState(() => tempConfig = null);
              _reload();
            },
            child: const Text('还原'),
          ),
        ]),
      );

  // ---------------- 表格视图 ----------------

  double _w(CosFieldMeta f) => _liveWidths[f.fieldName] ?? cfg.fieldWidths[f.fieldName] ?? fieldWidth(f.type);

  Widget _cellBox(double w, Widget child, {Color? color}) => Container(
        width: w,
        height: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        alignment: Alignment.centerLeft,
        decoration: BoxDecoration(
          color: color,
          border: const Border(right: BorderSide(color: Fs.lineLight), bottom: BorderSide(color: Fs.lineLight)),
        ),
        child: child,
      );

  Widget _headerCell(CosFieldMeta f, List<CosFieldMeta> fields) {
    final sort = cfg.sort.where((s) => s.fieldName == f.fieldName).firstOrNull;
    final primary = f.fieldName == (meta.primaryField ?? meta.fields.firstOrNull?.fieldName);
    final builtin = meta.isBuiltinField(f);
    final w = _w(f);
    return SizedBox(
      width: w,
      child: Stack(children: [
        Positioned.fill(
          child: PopupMenuButton<String>(
            tooltip: '${f.label}（${fieldTypeName(f.type)}）',
            position: PopupMenuPosition.under,
            onSelected: (a) => fieldAction(f, a, fields),
            itemBuilder: (_) => [
              if (canManageFields) ...[
                const PopupMenuItem(value: 'edit', height: 38, child: _MenuRow(Icons.edit_outlined, '编辑字段')),
                if (!primary)
                  const PopupMenuItem(value: 'insert_left', height: 38, child: _MenuRow(Icons.west_rounded, '在左侧插入字段')),
                const PopupMenuItem(value: 'insert_right', height: 38, child: _MenuRow(Icons.east_rounded, '在右侧插入字段')),
                const PopupMenuDivider(),
              ],
              const PopupMenuItem(value: 'asc', height: 38, child: _MenuRow(Icons.arrow_upward_rounded, '按此字段升序')),
              const PopupMenuItem(value: 'desc', height: 38, child: _MenuRow(Icons.arrow_downward_rounded, '按此字段降序')),
              const PopupMenuItem(value: 'group', height: 38, child: _MenuRow(Icons.segment_rounded, '按此字段分组')),
              if (!primary) const PopupMenuItem(value: 'hide', height: 38, child: _MenuRow(Icons.visibility_off_outlined, '隐藏字段')),
              if (canManageFields && !builtin && !primary) ...[
                const PopupMenuDivider(),
                const PopupMenuItem(value: 'delete', height: 38, child: _MenuRow(Icons.delete_outline_rounded, '删除字段', danger: true)),
              ],
            ],
            child: _cellBox(
              w,
              Row(children: [
                Icon(fieldIcon(f.type), size: 15, color: Fs.text3),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(f.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13, color: Fs.text2, fontWeight: FontWeight.w500)),
                ),
                if (f.required) const Text('*', style: TextStyle(color: Fs.red, fontSize: 12)),
                if (sort != null)
                  Icon(sort.desc ? Icons.arrow_downward_rounded : Icons.arrow_upward_rounded, size: 13, color: Fs.primary),
                const Icon(Icons.expand_more_rounded, size: 15, color: Fs.text3),
              ]),
            ),
          ),
        ),
        // 拖动右边缘调整列宽，松手后保存到视图
        Positioned(
          right: 0,
          top: 0,
          bottom: 0,
          width: 6,
          child: MouseRegion(
            cursor: SystemMouseCursors.resizeColumn,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onHorizontalDragUpdate: (d) =>
                  setState(() => _liveWidths[f.fieldName] = (_w(f) + d.delta.dx).clamp(60.0, 600.0)),
              onHorizontalDragEnd: (_) {
                final nw = _liveWidths.remove(f.fieldName);
                if (nw != null) updateConfig(cfg.copyWith(fieldWidths: {...cfg.fieldWidths, f.fieldName: nw.roundToDouble()}));
              },
            ),
          ),
        ),
      ]),
    );
  }

  Widget _grid(List<CosRecord> ordered) {
    final fields = [for (final f in cfg.orderedFields(meta.fields)) if (!cfg.hiddenFields.contains(f.fieldName)) f];
    final groupSpecs = [for (final g in cfg.group) if (meta.field(g.fieldName) != null) g];
    final rows = buildGridRows(ordered, groupSpecs, collapsed);
    const idxW = 56.0;
    final addW = canManageFields ? 44.0 : 0.0;
    final total = idxW + fields.fold<double>(0, (a, f) => a + _w(f)) + addW + 1;
    final extent = cfg.rowExtent;
    final ids = ordered.map((r) => r.recordId).toSet();
    final allSel = ids.isNotEmpty && selected.containsAll(ids);
    return Column(children: [
      Expanded(
        child: LayoutBuilder(builder: (context, c) {
          final w = math.max(total, c.maxWidth);
          return Scrollbar(
            controller: hCtrl,
            thumbVisibility: true,
            child: SingleChildScrollView(
              controller: hCtrl,
              scrollDirection: Axis.horizontal,
              child: SizedBox(
                width: w,
                child: Column(children: [
                  Container(
                    height: 38,
                    decoration: const BoxDecoration(color: Fs.bg, border: Border(bottom: BorderSide(color: Fs.line))),
                    child: Row(children: [
                      _cellBox(
                        idxW,
                        Center(
                          child: Checkbox(
                            value: allSel ? true : (selected.isEmpty ? false : null),
                            tristate: true,
                            visualDensity: VisualDensity.compact,
                            onChanged: ids.isEmpty
                                ? null
                                : (_) => setState(() => allSel ? selected.clear() : selected.addAll(ids)),
                          ),
                        ),
                      ),
                      for (final f in fields) _headerCell(f, fields),
                      if (canManageFields)
                        SizedBox(
                          width: addW,
                          child: FsIconButton(
                            icon: Icons.add_rounded,
                            tooltip: '新增字段',
                            onPressed: () async =>
                                _applyMeta(await showFieldEditor(context, api: api, table: meta, afterField: meta.fields.lastOrNull?.fieldName)),
                          ),
                        ),
                    ]),
                  ),
                  Expanded(
                    child: ordered.isEmpty && groupSpecs.isEmpty
                        ? _emptyRows()
                        : Scrollbar(
                            controller: vCtrl,
                            child: ListView.builder(
                              controller: vCtrl,
                              itemExtent: extent,
                              itemCount: rows.length,
                              itemBuilder: (_, i) => switch (rows[i]) {
                                GroupHeaderRow h => _groupRow(h),
                                AddRow a => _addRow(a),
                                RecordRow r => _recordRow(r, fields, ordered, idxW),
                              },
                            ),
                          ),
                  ),
                ]),
              ),
            ),
          );
        }),
      ),
      Container(
        height: 34,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: const BoxDecoration(border: Border(top: BorderSide(color: Fs.line))),
        child: Row(children: [
          Text(
            ordered.length == records.length ? '${records.length} 条记录' : '${ordered.length} / ${records.length} 条记录',
            style: const TextStyle(fontSize: 12, color: Fs.text3),
          ),
          if (groupSpecs.isNotEmpty) ...[
            const SizedBox(width: 12),
            TextButton(
              onPressed: () => setState(() {
                if (collapsed.isEmpty) {
                  collapsed.addAll(rows.whereType<GroupHeaderRow>().where((h) => h.depth == 0).map((h) => h.key));
                } else {
                  collapsed.clear();
                }
              }),
              child: Text(collapsed.isEmpty ? '全部折叠' : '全部展开', style: const TextStyle(fontSize: 12)),
            ),
          ],
          const Spacer(),
          Text(
            '${fields.length} 个字段${fields.length < meta.fields.length ? '（隐藏 ${meta.fields.length - fields.length} 个）' : ''}',
            style: const TextStyle(fontSize: 12, color: Fs.text3),
          ),
        ]),
      ),
    ]);
  }

  Widget _groupRow(GroupHeaderRow h) {
    final f = meta.field(h.fieldName);
    final v = h.path.last;
    return HoverBox(
      radius: 0,
      onTap: () => setState(() => h.collapsed ? collapsed.remove(h.key) : collapsed.add(h.key)),
      child: Container(
        padding: EdgeInsets.only(left: 12.0 + h.depth * 20, right: 12),
        decoration: BoxDecoration(
          color: h.depth == 0 ? const Color(0xFFF5F6F7) : const Color(0xFFFAFAFB),
          border: const Border(bottom: BorderSide(color: Fs.lineLight)),
        ),
        child: Row(children: [
          Icon(h.collapsed ? Icons.chevron_right_rounded : Icons.expand_more_rounded, size: 18, color: Fs.text2),
          const SizedBox(width: 4),
          Text('${f?.label ?? h.fieldName}：', style: const TextStyle(fontSize: 12, color: Fs.text3)),
          if (v.isEmpty)
            const Text('（空）', style: TextStyle(fontSize: 13, color: Fs.text3))
          else if (f != null && (f.type == 3 || f.type == 4))
            FsTag(v, color: optionColor(f, v))
          else
            Flexible(child: Text(v, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500))),
          const SizedBox(width: 8),
          Text('${h.count}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
        ]),
      ),
    );
  }

  Widget _addRow(AddRow a) => perms.canEdit
      ? HoverBox(
          radius: 0,
          onTap: () => _open(null, preset: _presetFor(a.path)),
          child: Container(
            padding: EdgeInsets.only(left: 18.0 + (a.path.isEmpty ? 0 : (a.path.length - 1) * 20 + 14)),
            alignment: Alignment.centerLeft,
            decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
            child: const Row(children: [
              Icon(Icons.add_rounded, size: 18, color: Fs.text3),
              SizedBox(width: 6),
              Text('新增记录', style: TextStyle(fontSize: 13, color: Fs.text3)),
            ]),
          ),
        )
      : const SizedBox.shrink();

  Widget _recordRow(RecordRow row, List<CosFieldMeta> fields, List<CosRecord> ordered, double idxW) {
    final r = row.record;
    final sel = selected.contains(r.recordId);
    final flashing = flash.containsKey(r.recordId);
    return AnimatedOpacity(
      key: ValueKey(r.recordId),
      opacity: fading.contains(r.recordId) ? 0 : 1,
      duration: const Duration(milliseconds: 300),
      child: HoverReveal(
        builder: (context, hover) => GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => _open(r),
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 600),
              color: flashing
                  ? const Color(0xFFFFF4D6)
                  : sel
                      ? Fs.primaryBg
                      : hover
                          ? const Color(0xFFF5F8FF)
                          : Colors.white,
              child: Row(children: [
                _cellBox(
                  idxW,
                  Center(
                    child: hover || sel
                        ? Checkbox(
                            value: sel,
                            visualDensity: VisualDensity.compact,
                            onChanged: (_) =>
                                toggleSelect(r.recordId, ordered, shift: HardwareKeyboard.instance.isShiftPressed),
                          )
                        : Text('${row.index + 1}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                  ),
                ),
                for (final f in fields) _cellBox(_w(f), FieldValueView(field: f, value: r.fields[f.fieldName])),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  Widget _emptyRows() {
    final filtered = keyword.isNotEmpty || cfg.conditions.isNotEmpty;
    return EmptyState(
      icon: Icons.table_rows_outlined,
      title: filtered ? '没有符合条件的记录' : '这张表还没有记录',
      subtitle: filtered ? '试试调整筛选条件或搜索词' : (perms.canEdit ? '点「添加记录」录入第一条数据' : null),
      action: !filtered && perms.canEdit
          ? FilledButton.icon(onPressed: () => _open(null), icon: const Icon(Icons.add_rounded, size: 18), label: const Text('添加记录'))
          : null,
    );
  }

  // ---------------- 看板视图 ----------------

  Widget _kanban(List<CosRecord> rows) {
    final gf = meta.field(cfg.kanbanField ?? '') ?? meta.fields.where((f) => f.type == 3).firstOrNull;
    if (gf == null) {
      return const EmptyState(
        icon: Icons.view_kanban_outlined,
        title: '这张表没有单选字段',
        subtitle: '看板需要按单选字段分列，可以先在「字段管理」里新增一个单选字段',
      );
    }
    final opts = [...?gf.options];
    for (final r in rows) {
      final v = fieldText(r.fields[gf.fieldName]);
      if (v.isNotEmpty && !opts.contains(v)) opts.add(v);
    }
    final titleField = meta.field(meta.primaryField ?? '') ?? meta.fields.where((f) => f.type == 1).firstOrNull;
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
            for (final col in <String?>[...opts, null])
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
      onWillAcceptWithDetails: (d) => perms.canEdit && fieldText(d.data.fields[gf.fieldName]) != (option ?? ''),
      onAcceptWithDetails: (d) => moveTo(d.data, gf.fieldName, option),
      builder: (context, cand, _) => Container(
        width: 280,
        margin: const EdgeInsets.only(right: 12),
        decoration: BoxDecoration(
          color: cand.isNotEmpty ? Fs.primaryLight : const Color(0xFFEFF0F2),
          borderRadius: BorderRadius.circular(10),
          border: cand.isNotEmpty ? Border.all(color: Fs.primary, width: 1.2) : null,
        ),
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 8, 8),
            child: Row(children: [
              option == null ? const FsTag('未分组', color: TagColor.gray) : FsTag(option, color: optionColor(gf, option)),
              const SizedBox(width: 8),
              Text('${items.length}', style: const TextStyle(fontSize: 13, color: Fs.text3)),
              const Spacer(),
              if (perms.canEdit)
                FsIconButton(
                  icon: Icons.add_rounded,
                  tooltip: '在此分组新增',
                  size: 18,
                  onPressed: () => _open(null, preset: option == null ? const {} : {gf.fieldName: option}),
                ),
            ]),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
              children: [
                for (final r in items)
                  Padding(
                    key: ValueKey(r.recordId),
                    padding: const EdgeInsets.only(bottom: 8),
                    child: AnimatedOpacity(
                      opacity: fading.contains(r.recordId) ? 0 : 1,
                      duration: const Duration(milliseconds: 300),
                      child: Draggable<CosRecord>(
                        data: r,
                        maxSimultaneousDrags: perms.canEdit ? 1 : 0,
                        feedback: AppScope(
                          state: _s,
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
                  ),
                if (items.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 24),
                    child: Center(child: Text('拖动卡片到这里', style: TextStyle(fontSize: 12, color: Fs.text3))),
                  ),
              ],
            ),
          ),
        ]),
      ),
    );
  }

  Widget _card(CosRecord r, CosFieldMeta gf, CosFieldMeta? titleField, {bool dragging = false}) {
    final title = titleField != null ? fieldText(r.fields[titleField.fieldName]) : '';
    final others = cfg
        .orderedFields(meta.fields)
        .where((f) =>
            f.fieldName != gf.fieldName &&
            f.fieldName != titleField?.fieldName &&
            !cfg.hiddenFields.contains(f.fieldName) &&
            !isEmptyValue(r.fields[f.fieldName]))
        .take(4)
        .toList();
    return HoverBox(
      onTap: () => _open(r),
      hoverColor: Colors.white,
      radius: 8,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 600),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: flash.containsKey(r.recordId) ? const Color(0xFFFFF4D6) : Colors.white,
          borderRadius: BorderRadius.circular(8),
          boxShadow: dragging ? Fs.shadowL : Fs.shadow,
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
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
        ]),
      ),
    );
  }
}

class _MenuRow extends StatelessWidget {
  final IconData icon;
  final String text;
  final bool danger;
  const _MenuRow(this.icon, this.text, {this.danger = false});
  @override
  Widget build(BuildContext context) => Row(children: [
        Icon(icon, size: 16, color: danger ? Fs.red : Fs.text2),
        const SizedBox(width: 10),
        Text(text, style: TextStyle(fontSize: 13, color: danger ? Fs.red : Fs.text1)),
      ]);
}

// ---------------- 批量修改 ----------------

/// 选字段和新值；返回 (field_name, value)。附件、链接不支持批量修改。
Future<(String, dynamic)?> showBatchEditDialog(BuildContext context, CosTableMeta meta) {
  final s = AppScope.read(context);
  final editable = meta.fields.where((f) => const {1, 2, 3, 4, 5, 7, 11, 15}.contains(f.type)).toList();
  CosFieldMeta? field = editable.firstOrNull;
  dynamic value;
  final text = TextEditingController();
  return showDialog<(String, dynamic)>(
    context: context,
    builder: (ctx) => AppScope(
      state: s,
      child: StatefulBuilder(builder: (ctx, setS) {
        final f = field;
        Widget editor() {
          if (f == null) return const SizedBox.shrink();
          switch (f.type) {
            case 3:
            case 4:
              final list = value is List ? [for (final e in value as List) e.toString()] : (value == null ? <String>[] : [value.toString()]);
              return Wrap(spacing: 6, runSpacing: 6, children: [
                for (final o in f.options ?? const <String>[])
                  ChoiceChip(
                    label: Text(o),
                    selected: list.contains(o),
                    selectedColor: optionColor(f, o).bg,
                    showCheckmark: false,
                    onSelected: (sel) => setS(() {
                      if (f.type == 3) {
                        value = sel ? o : null;
                      } else {
                        value = sel ? [...list, o] : (list..remove(o));
                      }
                    }),
                  ),
              ]);
            case 7:
              return SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('勾选'),
                value: value == true,
                onChanged: (v) => setS(() => value = v),
              );
            case 5:
              return OutlinedButton.icon(
                onPressed: () async {
                  final d = await pickDateTime(ctx,
                      initial: value is num ? DateTime.fromMillisecondsSinceEpoch((value as num).toInt()) : null);
                  if (d != null) setS(() => value = d.millisecondsSinceEpoch);
                },
                icon: const Icon(Icons.event_outlined, size: 16),
                label: Text(value is num ? fmtDateTime(DateTime.fromMillisecondsSinceEpoch((value as num).toInt())) : '选择日期'),
              );
            case 11:
              final ids = value is List ? [for (final e in value as List) userIdOf(e as Map)] : <String>[];
              return Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                for (final id in ids) Chip(label: Text(s.userName(id))),
                TextButton(
                  onPressed: () async {
                    final r = await pickUsers(ctx, users: s.users, title: '选择${f.label}', initial: ids);
                    if (r != null) setS(() => value = [for (final id in r) {'id': id, 'name': s.userName(id)}]);
                  },
                  child: const Text('选择人员'),
                ),
              ]);
            default:
              return TextField(
                controller: text,
                keyboardType: f.type == 2 ? const TextInputType.numberWithOptions(decimal: true, signed: true) : null,
                decoration: const InputDecoration(hintText: '新的值（留空表示清空）'),
                onChanged: (t) => value = f.type == 2 ? num.tryParse(t.trim()) : t,
              );
          }
        }

        return AlertDialog(
          title: const Text('批量修改'),
          content: SizedBox(
            width: 440,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              DropdownButtonFormField<String>(
                initialValue: f?.fieldName,
                decoration: const InputDecoration(labelText: '要修改的字段'),
                items: [
                  for (final x in editable)
                    DropdownMenuItem(
                      value: x.fieldName,
                      child: Row(children: [
                        Icon(fieldIcon(x.type), size: 15, color: Fs.text3),
                        const SizedBox(width: 6),
                        Text(x.label),
                      ]),
                    ),
                ],
                onChanged: (v) => setS(() {
                  field = meta.field(v!);
                  value = null;
                  text.clear();
                }),
              ),
              const SizedBox(height: 16),
              const Text('统一改为', style: TextStyle(fontSize: 13, color: Fs.text2)),
              const SizedBox(height: 8),
              editor(),
              const SizedBox(height: 8),
              const Text('改完可以按 ⌘Z / Ctrl+Z 撤销', style: TextStyle(fontSize: 12, color: Fs.text3)),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(
              onPressed: f == null ? null : () => Navigator.pop(ctx, (f.fieldName, f.type == 1 && value == '' ? null : value)),
              child: const Text('应用'),
            ),
          ],
        );
      }),
    ),
  ).whenComplete(text.dispose);
}
