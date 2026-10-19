/// 字段编辑（R-BT-02）：新增 / 编辑字段、单选多选的选项（增删、改名、拖动排序、配色）、
/// 改类型前预估影响条数。所有接口返回整张表的最新定义。
library;

import 'package:flutter/material.dart';

import '../api/phase2.dart';
import '../api_client.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'bitable_field.dart';

/// 可选颜色（需求文档 R-BT-02 的 8 种）。
const kOptionColors = <String, String>{
  'blue': '蓝',
  'green': '绿',
  'orange': '橙',
  'red': '红',
  'purple': '紫',
  'cyan': '青',
  'yellow': '黄',
  'gray': '灰',
};

/// 新建字段可选的类型。
const kFieldTypes = [1, 2, 3, 4, 5, 7, 11, 15, 17];

class _Opt {
  final String? original; // 已有选项的原名（用于改名同步记录）
  final TextEditingController name;
  String color;
  final Key key = UniqueKey();
  _Opt(this.original, String text, this.color) : name = TextEditingController(text: text);
}

/// 冲突（VERSION_CONFLICT）时也返回最新表定义，由调用方替换并提示。
Future<CosTableMeta?> showFieldEditor(
  BuildContext context, {
  required CosApiClient api,
  required CosTableMeta table,
  CosFieldMeta? field,
  String? afterField,
}) =>
    showDialog<CosTableMeta>(
      context: context,
      barrierDismissible: false,
      builder: (_) => FieldEditorDialog(api: api, table: table, field: field, afterField: afterField),
    );

class FieldEditorDialog extends StatefulWidget {
  final CosApiClient api;
  final CosTableMeta table;
  final CosFieldMeta? field;
  final String? afterField;
  const FieldEditorDialog({super.key, required this.api, required this.table, this.field, this.afterField});
  @override
  State<FieldEditorDialog> createState() => _FieldEditorDialogState();
}

class _FieldEditorDialogState extends State<FieldEditorDialog> {
  final form = GlobalKey<FormState>();
  late final title = TextEditingController(text: widget.field?.label ?? '');
  late final desc = TextEditingController(text: widget.field?.description ?? '');
  late int type = widget.field?.type ?? 1;
  late bool required = widget.field?.required ?? false;
  late final List<_Opt> opts = [
    for (final o in widget.field?.options ?? const <String>[])
      _Opt(o, o, widget.field!.optionColors[o] ?? _autoColor(o)),
  ];
  bool busy = false;
  String? error;
  String? titleError;

  bool get editing => widget.field != null;
  bool get isPrimary => editing && widget.field!.fieldName == (widget.table.primaryField ?? widget.table.fields.first.fieldName);
  bool get typeLocked => editing && (isPrimary || widget.table.isBuiltinField(widget.field!));

  static String _autoColor(String o) {
    final t = TagColor.of(o);
    for (final e in kOptionColors.keys) {
      if (TagColor.named(e) == t) return e;
    }
    return 'blue';
  }

  @override
  void dispose() {
    title.dispose();
    desc.dispose();
    for (final o in opts) {
      o.name.dispose();
    }
    super.dispose();
  }

  bool get isSelect => type == 3 || type == 4;

  Future<void> _submit() async {
    if (busy || !form.currentState!.validate()) return;
    final names = [for (final o in opts) o.name.text.trim()];
    if (isSelect && names.isEmpty) {
      setState(() => error = '单选 / 多选至少要有一个选项');
      return;
    }
    // 改类型：先预估影响
    if (editing && type != widget.field!.type) {
      final ok = await _confirmConvert();
      if (!ok) return;
    }
    setState(() {
      busy = true;
      error = null;
      titleError = null;
    });
    final body = <String, dynamic>{
      'title': title.text.trim(),
      'type': type,
      'required': required,
      'description': desc.text.trim(),
      if (isSelect) 'options': names,
      if (isSelect) 'option_colors': {for (final o in opts) o.name.text.trim(): o.color},
      if (isSelect && editing)
        'option_renames': {
          for (final o in opts)
            if (o.original != null && o.original != o.name.text.trim()) o.original!: o.name.text.trim(),
        },
    };
    final t = widget.table;
    try {
      final CosTableMeta next;
      if (editing) {
        next = await widget.api.updateField(t.key, widget.field!.fieldName, body, baseVersion: t.version);
      } else {
        next = await widget.api.createField(t.key, body, afterField: widget.afterField, baseVersion: t.version);
      }
      if (mounted) Navigator.pop(context, next);
    } on CosApiException catch (e) {
      if (e.code == 'VERSION_CONFLICT') {
        try {
          final latest = await widget.api.getTable(t.key);
          if (!mounted) return;
          showToast(context, '内容已被别人修改，已为你刷新', error: true);
          Navigator.pop(context, latest);
          return;
        } catch (_) {}
      }
      if (!mounted) return;
      setState(() {
        busy = false;
        for (final item in e.errors) {
          if (item['field'] == 'title') titleError = item['message']?.toString();
        }
        error = e.code == 'FEATURE_DISABLED' ? '这个功能还没开放' : describeError(e);
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          busy = false;
          error = describeError(e);
        });
      }
    }
  }

  Future<bool> _confirmConvert() async {
    final t = widget.table;
    String msg;
    try {
      final p = await widget.api.convertPreview(t.key, widget.field!.fieldName, type);
      if (p.affected == 0) return true;
      msg = '已有 ${p.affected} 条记录的数据会按「${fieldTypeName(type)}」转换'
          '${p.willClear > 0 ? '，其中 ${p.willClear} 条无法转换的会被清空' : ''}。此操作无法撤销。';
    } catch (_) {
      msg = '已有记录的数据会按「${fieldTypeName(type)}」转换，无法转换的会被清空。此操作无法撤销。';
    }
    if (!mounted) return false;
    return confirmDialog(context, title: '修改字段类型', content: msg, ok: '确认修改', danger: true);
  }

  Widget _optionRow(int i) {
    final o = opts[i];
    return Padding(
      key: o.key,
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(children: [
        ReorderableDragStartListener(
          index: i,
          child: const MouseRegion(
            cursor: SystemMouseCursors.grab,
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 4),
              child: Icon(Icons.drag_indicator_rounded, size: 18, color: Fs.text3),
            ),
          ),
        ),
        PopupMenuButton<String>(
          tooltip: '选项颜色',
          onSelected: (c) => setState(() => o.color = c),
          itemBuilder: (_) => [
            for (final e in kOptionColors.entries)
              PopupMenuItem(
                value: e.key,
                height: 36,
                child: Row(children: [
                  _swatch(e.key, selected: e.key == o.color),
                  const SizedBox(width: 10),
                  Text(e.value),
                ]),
              ),
          ],
          child: Padding(padding: const EdgeInsets.all(6), child: _swatch(o.color)),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: TextFormField(
            controller: o.name,
            decoration: const InputDecoration(isDense: true, hintText: '选项名称'),
            onChanged: (_) => setState(() {}),
            validator: (v) {
              final t = (v ?? '').trim();
              if (t.isEmpty) return '请输入选项';
              if (t.runes.length > 40) return '最多 40 字';
              if (opts.where((x) => x.name.text.trim() == t).length > 1) return '选项不能重复';
              return null;
            },
          ),
        ),
        const SizedBox(width: 6),
        FsTag(o.name.text.trim().isEmpty ? '预览' : o.name.text.trim(), color: TagColor.named(o.color)),
        FsIconButton(
          icon: Icons.close_rounded,
          tooltip: o.original != null ? '删除选项（记录里的该值会被清空）' : '删除选项',
          size: 16,
          onPressed: () => setState(() => opts.removeAt(i).name.dispose()),
        ),
      ]),
    );
  }

  Widget _swatch(String c, {bool selected = false}) {
    final t = TagColor.named(c) ?? TagColor.gray;
    return Container(
      width: 18,
      height: 18,
      decoration: BoxDecoration(
        color: t.bg,
        shape: BoxShape.circle,
        border: Border.all(color: selected ? Fs.primary : t.fg, width: selected ? 2 : 1),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final f = widget.field;
    return PopScope(
      canPop: !busy,
      child: AlertDialog(
        title: Text(editing ? '编辑字段' : '新增字段'),
        content: SizedBox(
          width: 520,
          child: Form(
            key: form,
            child: AbsorbPointer(
              absorbing: busy,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextFormField(
                      controller: title,
                      autofocus: true,
                      maxLength: 40,
                      decoration: InputDecoration(labelText: '字段名称', errorText: titleError, counterText: ''),
                      validator: (v) {
                        final t = (v ?? '').trim();
                        if (t.isEmpty) return '请输入字段名称';
                        final dup = widget.table.fields.any((x) =>
                            x.fieldName != f?.fieldName && x.label.toLowerCase() == t.toLowerCase());
                        return dup ? '已有同名字段' : null;
                      },
                    ),
                    const SizedBox(height: 14),
                    DropdownButtonFormField<int>(
                      initialValue: kFieldTypes.contains(type) ? type : null,
                      decoration: InputDecoration(
                        labelText: '字段类型',
                        helperText: typeLocked ? (isPrimary ? '主字段不能修改类型' : '内置字段不能修改类型，只能改显示名和选项') : null,
                      ),
                      items: [
                        for (final t in {...kFieldTypes, if (f != null) f.type})
                          DropdownMenuItem(
                            value: t,
                            child: Row(children: [
                              Icon(fieldIcon(t), size: 16, color: Fs.text2),
                              const SizedBox(width: 8),
                              Text(fieldTypeName(t)),
                            ]),
                          ),
                      ],
                      onChanged: typeLocked
                          ? null
                          : (v) => setState(() {
                                type = v!;
                                if (isSelect && opts.isEmpty) opts.add(_Opt(null, '', 'blue'));
                              }),
                    ),
                    if (editing && type != f!.type)
                      const Padding(
                        padding: EdgeInsets.only(top: 6),
                        child: Text('保存前会提示有多少条记录受影响', style: TextStyle(fontSize: 12, color: Fs.orange)),
                      ),
                    if (isSelect) ...[
                      const SizedBox(height: 16),
                      Row(children: [
                        const Text('选项', style: TextStyle(fontWeight: FontWeight.w600)),
                        const SizedBox(width: 8),
                        const Expanded(
                          child: Text('拖动调整顺序；改名会同步到已有记录',
                              style: TextStyle(fontSize: 12, color: Fs.text3)),
                        ),
                        TextButton.icon(
                          onPressed: opts.length >= 50
                              ? null
                              : () => setState(() => opts.add(_Opt(null, '', kOptionColors.keys.elementAt(opts.length % 8)))),
                          icon: const Icon(Icons.add_rounded, size: 16),
                          label: const Text('添加选项'),
                        ),
                      ]),
                      const SizedBox(height: 6),
                      ReorderableListView.builder(
                        shrinkWrap: true,
                        buildDefaultDragHandles: false,
                        physics: const NeverScrollableScrollPhysics(),
                        itemCount: opts.length,
                        onReorderItem: (a, b) => setState(() => opts.insert(b, opts.removeAt(a))),
                        itemBuilder: (_, i) => _optionRow(i),
                      ),
                    ],
                    const SizedBox(height: 8),
                    if (!isPrimary)
                      CheckboxListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        title: const Text('必填'),
                        value: required,
                        onChanged: (v) => setState(() => required = v!),
                      ),
                    TextFormField(
                      controller: desc,
                      maxLength: 200,
                      minLines: 1,
                      maxLines: 3,
                      decoration: const InputDecoration(labelText: '字段说明（选填）'),
                    ),
                    if (error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(error!, style: const TextStyle(color: Fs.red)),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: busy ? null : () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(
            onPressed: busy ? null : _submit,
            child: Text(busy ? '保存中…' : (editing ? '保存' : '添加字段')),
          ),
        ],
      ),
    );
  }
}

/// 字段管理面板：拖动调整表的默认字段顺序、编辑、删除（需要 can_manage）。
class FieldManagerDialog extends StatefulWidget {
  final CosApiClient api;
  final CosTableMeta table;
  const FieldManagerDialog({super.key, required this.api, required this.table});
  @override
  State<FieldManagerDialog> createState() => _FieldManagerDialogState();
}

class _FieldManagerDialogState extends State<FieldManagerDialog> {
  late CosTableMeta table = widget.table;
  bool busy = false;

  Future<void> _run(Future<CosTableMeta> Function() op) async {
    setState(() => busy = true);
    try {
      final t = await op();
      if (mounted) setState(() => table = t);
    } on CosApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'VERSION_CONFLICT') {
        try {
          final t = await widget.api.getTable(table.key);
          if (mounted) setState(() => table = t);
        } catch (_) {}
        if (mounted) showToast(context, '内容已被别人修改，已为你刷新', error: true);
      } else {
        showToast(context, e.code == 'FIELD_IN_USE' ? '${e.message}（请先在视图里移除对它的引用）' : describeError(e), error: true);
      }
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _delete(CosFieldMeta f) async {
    final ok = await confirmDialog(context,
        title: '删除字段「${f.label}」', content: '删除后，所有记录中这一列的数据都会被清除，且无法恢复。', ok: '删除', danger: true);
    if (ok) await _run(() => widget.api.deleteField(table.key, f.fieldName, baseVersion: table.version));
  }

  Future<void> _edit(CosFieldMeta? f) async {
    final t = await showFieldEditor(context, api: widget.api, table: table, field: f);
    if (t != null && mounted) setState(() => table = t);
  }

  @override
  Widget build(BuildContext context) {
    final primary = table.primaryField ?? table.fields.firstOrNull?.fieldName;
    return AlertDialog(
      title: Row(children: [
        const Expanded(child: Text('字段管理')),
        if (busy) const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
      ]),
      content: SizedBox(
        width: 480,
        height: 460,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('拖动调整这张表的默认字段顺序（各视图可以另外调整自己的顺序）。',
              style: TextStyle(fontSize: 12, color: Fs.text3)),
          const SizedBox(height: 10),
          Expanded(
            child: AbsorbPointer(
              absorbing: busy,
              child: ReorderableListView.builder(
                buildDefaultDragHandles: false,
                itemCount: table.fields.length,
                onReorderItem: (a, b) {
                  final names = [for (final f in table.fields) f.fieldName];
                  names.insert(b, names.removeAt(a));
                  // 先本地调整，失败再由 _run 的刷新兜底
                  setState(() => table = table.copyWith(
                      fields: [for (final n in names) table.fields.firstWhere((f) => f.fieldName == n)]));
                  _run(() => widget.api.reorderFields(table.key, names, baseVersion: table.version));
                },
                itemBuilder: (_, i) {
                  final f = table.fields[i];
                  final builtin = table.isBuiltinField(f);
                  return Container(
                    key: ValueKey(f.fieldName),
                    margin: const EdgeInsets.only(bottom: 4),
                    decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(8)),
                    child: ListTile(
                      dense: true,
                      leading: ReorderableDragStartListener(
                        index: i,
                        child: const MouseRegion(
                          cursor: SystemMouseCursors.grab,
                          child: Icon(Icons.drag_indicator_rounded, size: 18, color: Fs.text3),
                        ),
                      ),
                      title: Row(children: [
                        Icon(fieldIcon(f.type), size: 15, color: Fs.text2),
                        const SizedBox(width: 6),
                        Flexible(child: Text(f.label, overflow: TextOverflow.ellipsis)),
                        if (f.fieldName == primary) ...[
                          const SizedBox(width: 6),
                          const FsTag('主字段', color: TagColor.blue, fontSize: 11),
                        ] else if (builtin) ...[
                          const SizedBox(width: 6),
                          const FsTag('内置', color: TagColor.gray, fontSize: 11),
                        ],
                      ]),
                      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                        FsIconButton(icon: Icons.edit_outlined, tooltip: '编辑字段', size: 17, onPressed: () => _edit(f)),
                        if (!builtin && f.fieldName != primary)
                          FsIconButton(
                            icon: Icons.delete_outline_rounded,
                            tooltip: '删除字段',
                            size: 17,
                            color: Fs.red,
                            onPressed: () => _delete(f),
                          ),
                      ]),
                    ),
                  );
                },
              ),
            ),
          ),
        ]),
      ),
      actions: [
        TextButton.icon(
          onPressed: busy || table.fields.length >= 100 ? null : () => _edit(null),
          icon: const Icon(Icons.add_rounded, size: 18),
          label: Text('新增字段（${table.fields.length}/100）'),
        ),
        FilledButton(onPressed: () => Navigator.pop(context, table), child: const Text('完成')),
      ],
    );
  }
}
