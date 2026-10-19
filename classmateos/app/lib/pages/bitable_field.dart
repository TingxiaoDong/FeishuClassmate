/// 多维表格字段：类型图标、单元格渲染、记录详情 / 新增表单。
/// 字段类型编号沿用 Bitable：1 文本 2 数字 3 单选 4 多选 5 日期 7 复选框
/// 11 人员 15 超链接 17 附件 18 关联。
library;

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'messages_page.dart' show downloadFile;
import 'table_manage.dart';

IconData fieldIcon(int type) => switch (type) {
  1 => Icons.text_fields_rounded,
  2 => Icons.tag_rounded,
  3 => Icons.arrow_drop_down_circle_outlined,
  4 => Icons.checklist_rounded,
  5 => Icons.calendar_today_outlined,
  7 => Icons.check_box_outlined,
  11 => Icons.person_outline_rounded,
  15 => Icons.link_rounded,
  17 => Icons.attach_file_rounded,
  18 => Icons.account_tree_outlined,
  _ => Icons.short_text_rounded,
};

String fieldTypeName(int type) => switch (type) {
  1 => '文本',
  2 => '数字',
  3 => '单选',
  4 => '多选',
  5 => '日期',
  7 => '复选框',
  11 => '人员',
  15 => '超链接',
  17 => '附件',
  18 => '关联',
  _ => '其他',
};

double fieldWidth(int type) => switch (type) {
  1 => 220,
  2 => 110,
  3 => 130,
  4 => 200,
  5 => 160,
  7 => 84,
  11 => 150,
  15 => 200,
  17 => 170,
  _ => 160,
};

/// 任意字段值转纯文本（搜索、排序、卡片标题用）。
String fieldText(dynamic v) {
  if (v == null) return '';
  if (v is String) return v;
  if (v is num) return fmtNumber(v);
  if (v is bool) return v ? '是' : '否';
  if (v is List) return v.map(fieldText).where((e) => e.isNotEmpty).join('、');
  if (v is Map) {
    return (v['text'] ??
            v['name'] ??
            v['link'] ??
            v['file_name'] ??
            v['id'] ??
            v.toString())
        .toString();
  }
  return v.toString();
}

String fmtFieldDate(num ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
  return d.hour == 0 && d.minute == 0 ? fmtDate(d) : fmtDateTime(d);
}

bool isEmptyValue(dynamic v) =>
    v == null ||
    (v is String && v.isEmpty) ||
    (v is List && v.isEmpty) ||
    (v is Map && v.isEmpty);

String userIdOf(Map m) =>
    (m['id'] ?? m['user_id'] ?? m['open_id'] ?? '').toString();

/// 单元格 / 卡片里的只读字段值。
/// 选项标签色：优先用后端 option_colors，没有时按文字推算。
TagColor optionColor(CosFieldMeta? f, String option) =>
    TagColor.named(f?.optionColors[option]) ?? TagColor.of(option);

class FieldValueView extends StatelessWidget {
  final CosFieldMeta field;
  final dynamic value;
  final bool compact;
  const FieldValueView({
    super.key,
    required this.field,
    required this.value,
    this.compact = true,
  });

  @override
  Widget build(BuildContext context) {
    final v = value;
    if (isEmptyValue(v)) return const SizedBox.shrink();
    final s = AppScope.of(context);
    const ts = TextStyle(fontSize: 13, color: Fs.text1);
    switch (field.type) {
      case 2:
        return Text(
          v is num ? fmtNumber(v) : fieldText(v),
          style: ts,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        );
      case 3:
        return Align(
          alignment: Alignment.centerLeft,
          child: FsTag(fieldText(v), color: optionColor(field, fieldText(v))),
        );
      case 4:
        final list = v is List ? v.map(fieldText).toList() : [fieldText(v)];
        return _wrap([
          for (final t in list) FsTag(t, color: optionColor(field, t)),
        ]);
      case 5:
        return Text(
          v is num ? fmtFieldDate(v) : fieldText(v),
          style: ts,
          maxLines: 1,
        );
      case 7:
        final on = v == true || v == 'true';
        return Icon(
          on ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded,
          size: 18,
          color: on ? Fs.primary : Fs.textDisabled,
        );
      case 11:
        final list = v is List ? v.whereType<Map>().toList() : const <Map>[];
        return _wrap([
          for (final u in list)
            _UserChip(
              name: (u['name'] ?? s.userName(userIdOf(u))).toString(),
              id: userIdOf(u),
            ),
        ]);
      case 15:
        final link = v is Map ? (v['link'] ?? '').toString() : fieldText(v);
        final text = v is Map ? (v['text'] ?? link).toString() : link;
        return InkWell(
          onTap: link.startsWith('http')
              ? () => openExternal(context, link)
              : null,
          child: Text(
            text,
            maxLines: compact ? 1 : 3,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13, color: Fs.primary),
          ),
        );
      case 17:
        final list = v is List ? v.whereType<Map>().toList() : const <Map>[];
        return _wrap([
          for (final a in list)
            _AttachmentChip(
              file: CosFileRef.fromJson(a.cast<String, dynamic>()),
            ),
        ]);
      default:
        return Text(
          fieldText(v),
          style: ts,
          maxLines: compact ? 1 : 6,
          overflow: TextOverflow.ellipsis,
        );
    }
  }

  Widget _wrap(List<Widget> children) => compact
      ? ClipRect(
          child: SizedBox(
            height: 24,
            child: Wrap(
              spacing: 4,
              runSpacing: 6,
              clipBehavior: Clip.hardEdge,
              children: children,
            ),
          ),
        )
      : Wrap(spacing: 6, runSpacing: 6, children: children);
}

class _UserChip extends StatelessWidget {
  final String name;
  final String id;
  final VoidCallback? onRemove;
  const _UserChip({required this.name, required this.id, this.onRemove});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(2, 2, 8, 2),
    decoration: BoxDecoration(
      color: Fs.hover,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        FsAvatar(name: name, seed: id.isEmpty ? name : id, size: 18),
        const SizedBox(width: 4),
        Text(name, style: const TextStyle(fontSize: 12)),
        if (onRemove != null) ...[
          const SizedBox(width: 2),
          InkWell(
            onTap: onRemove,
            child: const Icon(Icons.close_rounded, size: 13, color: Fs.text3),
          ),
        ],
      ],
    ),
  );
}

class _AttachmentChip extends StatelessWidget {
  final CosFileRef file;
  final VoidCallback? onRemove;
  const _AttachmentChip({required this.file, this.onRemove});
  @override
  Widget build(BuildContext context) => InkWell(
    onTap: file.fileKey.isEmpty
        ? null
        : () => downloadFile(context, file.fileKey),
    borderRadius: BorderRadius.circular(4),
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        border: Border.all(color: Fs.line),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          FileTypeIcon(file.fileName, size: 16),
          const SizedBox(width: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 160),
            child: Text(
              file.fileName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12),
            ),
          ),
          if (onRemove != null) ...[
            const SizedBox(width: 4),
            InkWell(
              onTap: onRemove,
              child: const Icon(Icons.close_rounded, size: 13, color: Fs.text3),
            ),
          ],
        ],
      ),
    ),
  );
}

// ---------------- 记录详情 / 新增 ----------------

/// 返回 true 表示数据有变化（保存或删除），调用方刷新。
Future<bool> showRecordDialog(
  BuildContext context, {
  required CosTableMeta table,
  CosRecord? record,
  Map<String, dynamic> preset = const {},
}) async {
  final r = await showScopedDialog<bool>(
    context,
    (_) => RecordDialog(table: table, record: record, preset: preset),
  );
  return r ?? false;
}

class RecordDialog extends StatefulWidget {
  final CosTableMeta table;
  final CosRecord? record;
  final Map<String, dynamic> preset;
  const RecordDialog({
    super.key,
    required this.table,
    this.record,
    this.preset = const {},
  });
  @override
  State<RecordDialog> createState() => _RecordDialogState();
}

class _RecordDialogState extends State<RecordDialog> {
  late final Map<String, dynamic> values = {
    ...?widget.record?.fields,
    ...widget.preset,
  };
  final Set<String> dirty = {};
  final Map<String, TextEditingController> ctrls = {};
  final Map<String, String> numErrors = {};
  bool saving = false;
  String? error;

  bool get isNew => widget.record == null;

  @override
  void initState() {
    super.initState();
    dirty.addAll(widget.preset.keys);
    for (final f in widget.table.fields) {
      if (const {1, 2, 15, 18}.contains(f.type) ||
          !const {3, 4, 5, 7, 11, 17}.contains(f.type)) {
        final v = values[f.fieldName];
        final text = f.type == 15 && v is Map
            ? (v['link'] ?? '').toString()
            : fieldText(v);
        ctrls[f.fieldName] = TextEditingController(text: text);
      }
    }
  }

  @override
  void dispose() {
    for (final c in ctrls.values) {
      c.dispose();
    }
    super.dispose();
  }

  void _set(String name, dynamic v) => setState(() {
    values[name] = v;
    dirty.add(name);
    error = null;
  });

  Future<void> _save() async {
    if (numErrors.isNotEmpty) {
      setState(() => error = '请先修正数字格式：${numErrors.keys.join('、')}');
      return;
    }
    final s = AppScope.read(context);
    setState(() {
      saving = true;
      error = null;
    });
    try {
      if (isNew) {
        final fields = {
          for (final e in values.entries)
            if (!isEmptyValue(e.value)) e.key: e.value,
        };
        if (fields.isEmpty) {
          setState(() {
            saving = false;
            error = '请至少填写一个字段';
          });
          return;
        }
        await s.api.createRecord(widget.table.key, fields);
      } else {
        final fields = {
          for (final k in dirty) k: isEmptyValue(values[k]) ? null : values[k],
        };
        await s.api.updateRecord(
          widget.table.key,
          widget.record!.recordId,
          fields,
        );
      }
      if (mounted) {
        showToast(context, isNew ? '记录已添加' : '已保存');
        Navigator.pop(context, true);
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

  Future<void> _delete() async {
    final ok = await confirmDialog(
      context,
      title: '删除记录',
      content: '删除后无法恢复，确定删除这条记录吗？',
      ok: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    final s = AppScope.read(context);
    try {
      await s.api.deleteRecord(widget.table.key, widget.record!.recordId);
      if (mounted) {
        showToast(context, '记录已删除');
        Navigator.pop(context, true);
      }
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final narrow = size.width < 640;
    final showActivity =
        !isNew &&
        !narrow &&
        size.width >= 1000 &&
        AppScope.of(context).feature('record.comments');
    return Dialog(
      insetPadding: EdgeInsets.all(narrow ? 12 : 40),
      child: SizedBox(
        width: showActivity ? 1040 : 720,
        height: (size.height * 0.86).clamp(360.0, 820.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 18, 14, 14),
              child: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(
                      color: Fs.purple.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Icon(
                      isNew ? Icons.post_add_rounded : Icons.article_outlined,
                      size: 18,
                      color: Fs.purple,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          isNew ? '添加记录' : '记录详情',
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Text(
                          isNew
                              ? widget.table.name
                              : '${widget.table.name} · ${widget.record!.updatedAt != null ? '更新于 ${fmtDateTime(widget.record!.updatedAt!.toLocal())}' : widget.record!.recordId}',
                          style: const TextStyle(fontSize: 12, color: Fs.text3),
                        ),
                      ],
                    ),
                  ),
                  FsIconButton(
                    icon: Icons.close_rounded,
                    tooltip: '关闭',
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
            ),
            const Divider(),
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(
                    child: ListView(
                      padding: const EdgeInsets.fromLTRB(24, 12, 24, 12),
                      children: [
                        for (final f in widget.table.fields)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 7),
                            child: narrow
                                ? Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      _label(f),
                                      const SizedBox(height: 6),
                                      _editor(f),
                                    ],
                                  )
                                : Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      SizedBox(
                                        width: 180,
                                        child: Padding(
                                          padding: const EdgeInsets.only(
                                            top: 9,
                                          ),
                                          child: _label(f),
                                        ),
                                      ),
                                      Expanded(child: _editor(f)),
                                    ],
                                  ),
                          ),
                      ],
                    ),
                  ),
                  if (showActivity) ...[
                    const VerticalDivider(width: 1),
                    SizedBox(
                      width: 320,
                      child: RecordActivity(
                        table: widget.table,
                        recordId: widget.record!.recordId,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (error != null)
              Container(
                margin: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: const Color(0xFFFDE2E2),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.error_rounded, size: 16, color: Fs.red),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        error!,
                        style: const TextStyle(
                          fontSize: 13,
                          color: Color(0xFFD83931),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            Container(
              padding: const EdgeInsets.fromLTRB(16, 12, 24, 16),
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: Fs.lineLight)),
              ),
              child: Row(
                children: [
                  if (!isNew)
                    TextButton.icon(
                      onPressed: saving ? null : _delete,
                      style: TextButton.styleFrom(foregroundColor: Fs.red),
                      icon: const Icon(Icons.delete_outline_rounded, size: 18),
                      label: const Text('删除记录'),
                    ),
                  if (!isNew && !showActivity && AppScope.of(context).feature('record.comments'))
                    TextButton.icon(
                      onPressed: () => showRecordActivitySheet(context, widget.table, widget.record!.recordId),
                      icon: const Icon(Icons.forum_outlined, size: 18),
                      label: const Text('评论与修改记录'),
                    ),
                  const Spacer(),
                  if (!isNew && dirty.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(right: 12),
                      child: Text(
                        '已修改 ${dirty.length} 个字段',
                        style: const TextStyle(fontSize: 12, color: Fs.text3),
                      ),
                    ),
                  OutlinedButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('取消'),
                  ),
                  const SizedBox(width: 10),
                  FilledButton(
                    onPressed: saving || (!isNew && dirty.isEmpty)
                        ? null
                        : _save,
                    child: saving
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : Text(isNew ? '添加' : '保存'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _label(CosFieldMeta f) => Tooltip(
    message: fieldTypeName(f.type),
    child: Row(
      children: [
        Icon(fieldIcon(f.type), size: 16, color: Fs.text3),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            f.label,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13, color: Fs.text2),
          ),
        ),
      ],
    ),
  );

  Widget _editor(CosFieldMeta f) {
    final name = f.fieldName;
    final v = values[name];
    switch (f.type) {
      case 2:
        return TextField(
          controller: ctrls[name],
          keyboardType: const TextInputType.numberWithOptions(
            decimal: true,
            signed: true,
          ),
          decoration: InputDecoration(
            hintText: '输入数字',
            errorText: numErrors[name],
          ),
          onChanged: (t) {
            final txt = t.trim();
            if (txt.isEmpty) {
              numErrors.remove(name);
              _set(name, null);
              return;
            }
            final n = num.tryParse(txt);
            if (n == null) {
              setState(() => numErrors[name] = '不是有效数字');
            } else {
              numErrors.remove(name);
              _set(name, n);
            }
          },
        );
      case 3:
        final opts = [...?f.options];
        final cur = v == null ? null : fieldText(v);
        if (cur != null && !opts.contains(cur)) opts.insert(0, cur);
        if (opts.isEmpty) return _hint('该字段还没有配置选项');
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final o in opts)
              _SelectChip(
                label: o,
                color: optionColor(f, o),
                selected: cur == o,
                onTap: () => _set(name, cur == o ? null : o),
              ),
          ],
        );
      case 4:
        final opts = [...?f.options];
        final cur = v is List ? v.map(fieldText).toList() : <String>[];
        for (final c in cur) {
          if (!opts.contains(c)) opts.add(c);
        }
        if (opts.isEmpty) return _hint('该字段还没有配置选项');
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final o in opts)
              _SelectChip(
                label: o,
                color: optionColor(f, o),
                selected: cur.contains(o),
                multi: true,
                onTap: () {
                  final next = [...cur];
                  next.contains(o) ? next.remove(o) : next.add(o);
                  _set(name, next.isEmpty ? null : next);
                },
              ),
          ],
        );
      case 5:
        return DateField(
          value: v is num
              ? DateTime.fromMillisecondsSinceEpoch(v.toInt())
              : null,
          onChanged: (d) => _set(name, d?.millisecondsSinceEpoch),
        );
      case 7:
        final on = v == true || v == 'true';
        return Align(
          alignment: Alignment.centerLeft,
          child: Switch(value: on, onChanged: (b) => _set(name, b)),
        );
      case 11:
        final s = AppScope.of(context);
        final list = v is List ? v.whereType<Map>().toList() : <Map>[];
        return Wrap(
          spacing: 6,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            for (final u in list)
              _UserChip(
                name: (u['name'] ?? s.userName(userIdOf(u))).toString(),
                id: userIdOf(u),
                onRemove: () {
                  final next = [...list]..remove(u);
                  _set(name, next.isEmpty ? null : next);
                },
              ),
            TextButton.icon(
              onPressed: () async {
                final ids = await pickUsers(
                  context,
                  users: s.users,
                  title: '选择$name',
                  initial: list.map(userIdOf).toList(),
                );
                if (ids == null) return;
                _set(
                  name,
                  ids.isEmpty
                      ? null
                      : [
                          for (final id in ids)
                            {'id': id, 'name': s.userName(id)},
                        ],
                );
              },
              icon: const Icon(Icons.person_add_alt_outlined, size: 16),
              label: Text(list.isEmpty ? '添加人员' : '修改'),
            ),
          ],
        );
      case 17:
        final list = v is List ? v.whereType<Map>().toList() : <Map>[];
        return Wrap(
          spacing: 6,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            for (final a in list)
              _AttachmentChip(
                file: CosFileRef.fromJson(a.cast<String, dynamic>()),
                onRemove: () {
                  final next = [...list]..remove(a);
                  _set(name, next.isEmpty ? null : next);
                },
              ),
            TextButton.icon(
              onPressed: () async {
                final s = AppScope.read(context);
                try {
                  final f = await s.pickAndUpload();
                  if (f == null) return;
                  _set(name, [
                    ...list,
                    {
                      'file_key': f.fileKey,
                      'name': f.fileName,
                      'file_name': f.fileName,
                      'size': f.size,
                    },
                  ]);
                } catch (e) {
                  if (mounted) {
                    setState(() => error = '上传失败：${describeError(e)}');
                  }
                }
              },
              icon: const Icon(Icons.upload_file_rounded, size: 16),
              label: const Text('上传附件'),
            ),
          ],
        );
      default:
        // 1 文本 / 15 超链接 / 18 关联 / 其他
        return TextField(
          controller: ctrls[name],
          minLines: 1,
          maxLines: f.type == 1 ? 5 : 1,
          decoration: InputDecoration(
            hintText: switch (f.type) {
              15 => 'https://',
              18 => '关联记录 ID',
              _ => '请输入',
            },
            prefixIcon: f.type == 15
                ? const Icon(Icons.link_rounded, size: 18)
                : null,
          ),
          onChanged: (t) => _set(name, t.isEmpty ? null : t),
        );
    }
  }

  Widget _hint(String t) => Padding(
    padding: const EdgeInsets.only(top: 9),
    child: Text(t, style: const TextStyle(fontSize: 13, color: Fs.text3)),
  );
}

class _SelectChip extends StatelessWidget {
  final String label;
  final bool selected;
  final bool multi;
  final VoidCallback onTap;
  final TagColor? color;
  const _SelectChip({
    required this.label,
    required this.selected,
    required this.onTap,
    this.multi = false,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    final c = color ?? TagColor.of(label);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: selected ? c.bg : Colors.white,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(
              color: selected ? c.fg.withValues(alpha: 0.5) : Fs.line,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (selected) ...[
                Icon(
                  multi ? Icons.check_box_rounded : Icons.check_rounded,
                  size: 14,
                  color: c.fg,
                ),
                const SizedBox(width: 4),
              ],
              Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  color: selected ? c.fg : Fs.text1,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
