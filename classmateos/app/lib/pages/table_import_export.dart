/// 多维表格导入导出（R-BT-07）与文档下载（R-DC-06）的界面。
///
/// 导入：选 xlsx / csv → 上传 → 后端解析预览（前 20 行）→ 列映射到字段 → 追加或按主字段更新 → 异步任务。
/// 导出：当前视图（带筛选排序和隐藏列）或选中记录 → 异步任务 → 下载。
/// 从文件建表：预览后按推荐类型生成字段 → 走一期建表接口 → 再导入数据。
library;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../api/phase2_jobs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/job_dialog.dart';
import 'bitable_field.dart' show fieldTypeName;

const _maxImportBytes = 20 * 1024 * 1024;

/// 选文件并上传，返回 (文件, 预览)。用户取消时返回 null，失败抛异常。
Future<(CosFileRef, CosImportPreview)?> _pickAndPreview(CosApiClient api) async {
  final f = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: ['xlsx', 'csv']);
  if (f == null) return null;
  final bytes = await f.readAsBytes();
  if (bytes.length > _maxImportBytes) throw const CosApiException(413, '文件不能超过 20 MB');
  final ref = await api.uploadBytes(f.name, bytes, ref: {'type': 'table_import'});
  final p = await api.previewTableImport(ref.fileKey);
  if (p.headers.isEmpty) throw const CosApiException(422, '没有读到表头，请确认第一行是列名');
  return (ref, p);
}

/// 表头按名称（或中文名）自动匹配字段；匹配不到为 null（不导入）。
Map<String, String?> autoMapping(List<String> headers, List<CosFieldMeta> fields) {
  String norm(String s) => s.trim().toLowerCase();
  return {
    for (final h in headers)
      h: fields
          .where((f) => f.type != 17 && (norm(f.label) == norm(h) || norm(f.fieldName) == norm(h)))
          .firstOrNull
          ?.fieldName,
  };
}

// ---------------- 导入到已有表 ----------------

/// 返回是否导入了数据（用于刷新表格）。
Future<bool> showTableImport(BuildContext context, CosTableMeta meta) async {
  final r = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (_) => AppScope(state: AppScope.read(context), child: _ImportDialog(meta: meta)),
  );
  return r == true;
}

class _ImportDialog extends StatefulWidget {
  final CosTableMeta meta;
  const _ImportDialog({required this.meta});
  @override
  State<_ImportDialog> createState() => _ImportDialogState();
}

class _ImportDialogState extends State<_ImportDialog> {
  CosFileRef? file;
  CosImportPreview? preview;
  Map<String, String?> mapping = {};
  String mode = 'append';
  bool busy = false;
  String? error;

  List<CosFieldMeta> get _targets => [for (final f in widget.meta.fields) if (f.type != 17 && f.type != 18) f];

  Future<void> _pick() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final r = await _pickAndPreview(AppScope.read(context).api);
      if (r != null && mounted) {
        setState(() {
          file = r.$1;
          preview = r.$2;
          mapping = autoMapping(r.$2.headers, _targets);
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  String? get _problem {
    final used = mapping.values.whereType<String>().toList();
    if (used.isEmpty) return '至少要把一列对应到字段';
    final dup = used.where((f) => used.where((x) => x == f).length > 1).toSet();
    if (dup.isNotEmpty) return '「${dup.map((f) => widget.meta.field(f)?.label ?? f).join('、')}」被多列对应了';
    final primary = widget.meta.primaryField;
    if (mode == 'upsert' && primary != null && !used.contains(primary)) {
      return '按主字段更新时，必须有一列对应主字段「${widget.meta.field(primary)?.label ?? primary}」';
    }
    final missing = [
      for (final f in widget.meta.fields)
        if (f.required && mode == 'append' && !used.contains(f.fieldName)) f.label,
    ];
    if (missing.isNotEmpty) return '必填字段没有对应的列：${missing.join('、')}';
    return null;
  }

  Future<void> _start() async {
    final api = AppScope.read(context).api;
    final m = {for (final e in mapping.entries) if (e.value != null) e.key: e.value!};
    final job = await runJobDialog(
      context,
      title: '导入到「${widget.meta.name}」',
      kind: 'import',
      start: () => api.startTableImport(widget.meta.key, fileKey: file!.fileKey, mode: mode, mapping: m),
    );
    if (!mounted || job == null) return;
    Navigator.pop(context, job.succeeded > 0);
  }

  @override
  Widget build(BuildContext context) {
    final p = preview;
    final problem = p == null ? null : _problem;
    return AlertDialog(
      title: const Text('导入数据'),
      content: SizedBox(
        width: 720,
        height: 480,
        child: p == null
            ? _PickArea(busy: busy, error: error, onPick: _pick, hint: '支持 .xlsx、.csv，最大 20 MB；第一行是列名')
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  const Icon(Icons.insert_drive_file_outlined, size: 18, color: Fs.text2),
                  const SizedBox(width: 6),
                  Expanded(child: Text('${file!.fileName} · 共 ${p.totalRows} 行', overflow: TextOverflow.ellipsis)),
                  TextButton(onPressed: busy ? null : _pick, child: const Text('重新选择')),
                ]),
                const SizedBox(height: 6),
                Row(children: [
                  const Text('导入方式', style: TextStyle(color: Fs.text2)),
                  const SizedBox(width: 12),
                  SegmentedButton<String>(
                    showSelectedIcon: false,
                    segments: const [
                      ButtonSegment(value: 'append', label: Text('追加为新记录')),
                      ButtonSegment(value: 'upsert', label: Text('按主字段更新')),
                    ],
                    selected: {mode},
                    onSelectionChanged: (v) => setState(() => mode = v.first),
                  ),
                ]),
                if (mode == 'upsert')
                  const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Text('主字段值相同的记录会被更新，没有的会新增', style: TextStyle(fontSize: 12, color: Fs.text3)),
                  ),
                const SizedBox(height: 10),
                const Text('列对应', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Expanded(
                  child: ListView(children: [
                    for (var i = 0; i < p.headers.length; i++)
                      _MappingRow(
                        key: ValueKey('map-${p.headers[i]}'),
                        header: p.headers[i],
                        samples: [for (final r in p.rows.take(3)) if (i < r.length) r[i]],
                        fields: _targets,
                        value: mapping[p.headers[i]],
                        onChanged: (v) => setState(() => mapping[p.headers[i]] = v),
                      ),
                  ]),
                ),
                const Text('人员列按姓名或邮箱匹配；对不上的行会进失败明细，可以下载修改后重新导入。',
                    style: TextStyle(fontSize: 12, color: Fs.text3)),
                if (problem != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(problem, key: const ValueKey('import-problem'), style: const TextStyle(color: Fs.red, fontSize: 13)),
                  ),
              ]),
      ),
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
        if (p != null)
          FilledButton(
            key: const ValueKey('import-start'),
            onPressed: problem == null && !busy ? _start : null,
            child: Text('导入 ${p.totalRows} 行'),
          ),
      ],
    );
  }
}

class _PickArea extends StatelessWidget {
  final bool busy;
  final String? error;
  final VoidCallback onPick;
  final String hint;
  const _PickArea({required this.busy, required this.error, required this.onPick, required this.hint});
  @override
  Widget build(BuildContext context) => Center(
        child: InkWell(
          key: const ValueKey('import-pick'),
          borderRadius: BorderRadius.circular(12),
          onTap: busy ? null : onPick,
          child: Container(
            width: 420,
            padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 24),
            decoration: BoxDecoration(
              color: Fs.bg,
              border: Border.all(color: Fs.line),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              busy
                  ? const SizedBox(width: 36, height: 36, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.upload_file_rounded, size: 40, color: Fs.primary),
              const SizedBox(height: 12),
              Text(busy ? '正在上传并解析…' : '点击选择文件', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500)),
              const SizedBox(height: 6),
              Text(hint, textAlign: TextAlign.center, style: const TextStyle(fontSize: 12, color: Fs.text3)),
              if (error != null) ...[
                const SizedBox(height: 10),
                Text(error!, textAlign: TextAlign.center, style: const TextStyle(color: Fs.red)),
              ],
            ]),
          ),
        ),
      );
}

class _MappingRow extends StatelessWidget {
  final String header;
  final List<String> samples;
  final List<CosFieldMeta> fields;
  final String? value;
  final ValueChanged<String?> onChanged;
  const _MappingRow({super.key, required this.header, required this.samples, required this.fields, required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(vertical: 6),
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
        child: Row(children: [
          Expanded(
            flex: 4,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(header, style: const TextStyle(fontWeight: FontWeight.w500)),
              Text(samples.where((x) => x.isNotEmpty).join(' / '),
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text3)),
            ]),
          ),
          const Icon(Icons.arrow_forward_rounded, size: 16, color: Fs.text3),
          const SizedBox(width: 12),
          Expanded(
            flex: 4,
            child: DropdownButtonFormField<String?>(
              initialValue: value,
              isDense: true,
              decoration: const InputDecoration(isDense: true),
              items: [
                const DropdownMenuItem<String?>(value: null, child: Text('不导入', style: TextStyle(color: Fs.text3))),
                for (final f in fields)
                  DropdownMenuItem<String?>(value: f.fieldName, child: Text('${f.label}（${fieldTypeName(f.type)}）${f.required ? ' *' : ''}')),
              ],
              onChanged: onChanged,
            ),
          ),
        ]),
      );
}

// ---------------- 从文件新建数据表 ----------------

/// 返回新建的表（数据已导入）；取消返回 null。
Future<CosTableMeta?> showCreateTableFromFile(BuildContext context) => showDialog<CosTableMeta>(
      context: context,
      barrierDismissible: false,
      builder: (_) => AppScope(state: AppScope.read(context), child: const _CreateFromFileDialog()),
    );

class _ColDraft {
  final String header;
  bool include = true;
  int type;
  _ColDraft(this.header, this.type);
}

class _CreateFromFileDialog extends StatefulWidget {
  const _CreateFromFileDialog();
  @override
  State<_CreateFromFileDialog> createState() => _CreateFromFileDialogState();
}

class _CreateFromFileDialogState extends State<_CreateFromFileDialog> {
  CosFileRef? file;
  CosImportPreview? preview;
  final name = TextEditingController();
  List<_ColDraft> cols = [];
  bool busy = false;
  String? error;
  final requestId = 'table_import_${DateTime.now().microsecondsSinceEpoch}';
  static const _types = [1, 2, 3, 4, 5, 7, 11, 15];

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final r = await _pickAndPreview(AppScope.read(context).api);
      if (r != null && mounted) {
        setState(() {
          file = r.$1;
          preview = r.$2;
          if (name.text.trim().isEmpty) name.text = r.$1.fileName.replaceFirst(RegExp(r'\.(xlsx|csv)$', caseSensitive: false), '');
          cols = [
            for (var i = 0; i < r.$2.headers.length; i++)
              _ColDraft(r.$2.headers[i], i == 0 ? 1 : (_types.contains(r.$2.suggestedTypes[r.$2.headers[i]]) ? r.$2.suggestedTypes[r.$2.headers[i]]! : 1)),
          ];
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  /// 单选 / 多选的选项从预览里收集（后端导入时遇到新选项会自动补上）。
  List<String> _optionsOf(int col, bool multi) {
    final out = <String>{};
    for (final r in preview!.rows) {
      if (col >= r.length) continue;
      for (final v in multi ? r[col].split(RegExp(r'[,，;；、]')) : [r[col]]) {
        if (v.trim().isNotEmpty) out.add(v.trim());
      }
    }
    return out.take(50).toList();
  }

  Future<void> _create() async {
    final s = AppScope.read(context);
    final tableName = name.text.trim();
    if (tableName.isEmpty) {
      setState(() => error = '请填写表名');
      return;
    }
    final picked = [for (var i = 0; i < cols.length; i++) if (cols[i].include) (i, cols[i])];
    final seen = <String>{};
    for (final (_, c) in picked) {
      if (!seen.add(c.header.trim().toLowerCase())) {
        setState(() => error = '列名「${c.header}」重复了，请只保留一列');
        return;
      }
    }
    setState(() {
      busy = true;
      error = null;
    });
    CosTableMeta? table;
    try {
      table = await s.api.createTable(
        name: tableName,
        clientRequestId: requestId,
        primaryField: 'f_0',
        fields: [
          for (var k = 0; k < picked.length; k++)
            {
              'field_name': 'f_$k',
              'title': picked[k].$2.header.trim(),
              'type': k == 0 ? 1 : picked[k].$2.type,
              'required': k == 0,
              if (picked[k].$2.type == 3 || picked[k].$2.type == 4)
                'options': () {
                  final o = _optionsOf(picked[k].$1, picked[k].$2.type == 4);
                  return o.isEmpty ? ['选项1'] : o;
                }(),
            },
        ],
      );
    } catch (e) {
      if (mounted) {
        setState(() {
          busy = false;
          error = describeError(e);
        });
      }
      return;
    }
    if (!mounted) return;
    final t = table;
    final job = await runJobDialog(
      context,
      title: '导入数据到「${t.name}」',
      kind: 'import',
      start: () => s.api.startTableImport(t.key,
          fileKey: file!.fileKey, mode: 'append', mapping: {for (var k = 0; k < picked.length; k++) picked[k].$2.header: 'f_$k'}),
    );
    if (!mounted) return;
    // 建表已成功；导入失败时表仍保留，用户可以重新导入
    if (job == null || !job.ok) showToast(context, '数据表已创建，但数据没有全部导入，可以在表菜单里重新「导入数据」', error: true);
    Navigator.pop(context, t);
  }

  @override
  Widget build(BuildContext context) {
    final p = preview;
    return AlertDialog(
      title: const Text('从 Excel / CSV 新建数据表'),
      content: SizedBox(
        width: 680,
        height: 480,
        child: p == null
            ? _PickArea(busy: busy, error: error, onPick: _pick, hint: '第一行作为字段名，第一列作为主字段；字段类型按内容推荐，可以修改')
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                TextField(
                  key: const ValueKey('import-table-name'),
                  controller: name,
                  maxLength: 50,
                  decoration: const InputDecoration(labelText: '表名', isDense: true),
                ),
                Text('${file!.fileName} · 共 ${p.totalRows} 行', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                const SizedBox(height: 8),
                Expanded(
                  child: ListView(children: [
                    for (var i = 0; i < cols.length; i++)
                      Container(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
                        child: Row(children: [
                          Checkbox(
                            value: cols[i].include,
                            onChanged: i == 0 ? null : (v) => setState(() => cols[i].include = v ?? false),
                          ),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Row(children: [
                                Flexible(child: Text(cols[i].header, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w500))),
                                if (i == 0) const Padding(padding: EdgeInsets.only(left: 6), child: FsTag('主字段', color: TagColor.blue, fontSize: 10)),
                              ]),
                              Text(
                                [for (final r in p.rows.take(3)) if (i < r.length && r[i].isNotEmpty) r[i]].join(' / '),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 12, color: Fs.text3),
                              ),
                            ]),
                          ),
                          SizedBox(
                            width: 140,
                            child: DropdownButtonFormField<int>(
                              initialValue: cols[i].type,
                              isDense: true,
                              decoration: const InputDecoration(isDense: true),
                              items: [for (final t in (i == 0 ? const [1] : _types)) DropdownMenuItem(value: t, child: Text(fieldTypeName(t)))],
                              onChanged: !cols[i].include || i == 0 ? null : (v) => setState(() => cols[i].type = v ?? 1),
                            ),
                          ),
                        ]),
                      ),
                  ]),
                ),
                if (error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(error!, style: const TextStyle(color: Fs.red))),
              ]),
      ),
      actions: [
        OutlinedButton(onPressed: busy ? null : () => Navigator.pop(context), child: const Text('取消')),
        if (p != null)
          FilledButton(key: const ValueKey('import-create'), onPressed: busy ? null : _create, child: const Text('创建并导入')),
      ],
    );
  }
}

// ---------------- 导出 ----------------

/// 导出当前视图或选中记录。format: xlsx | csv。
Future<void> exportTable(BuildContext context, CosTableMeta meta, {String? viewId, List<String>? recordIds, String format = 'xlsx'}) async {
  final api = AppScope.read(context).api;
  final what = recordIds != null ? '选中的 ${recordIds.length} 条记录' : '当前视图';
  await runJobDialog(
    context,
    title: '导出$what为 ${format.toUpperCase()}',
    start: () => api.startTableExport(meta.key, viewId: viewId, format: format, recordIds: recordIds),
  );
}

/// 选择导出格式的小菜单，返回 xlsx / csv。
Future<String?> pickExportFormat(BuildContext context, Offset pos) => showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(pos.dx, pos.dy, pos.dx, pos.dy),
      items: const [
        PopupMenuItem(value: 'xlsx', child: Text('导出为 Excel（.xlsx）')),
        PopupMenuItem(value: 'csv', child: Text('导出为 CSV')),
      ],
    );
