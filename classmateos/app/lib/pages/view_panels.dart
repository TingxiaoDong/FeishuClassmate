/// 视图配置面板（R-BT-03）：筛选、排序、分组、隐藏字段 / 列顺序。
/// 每次修改都通过 [onChanged] 实时回传，由表格页负责自动保存到视图。
library;

import 'package:flutter/material.dart';

import '../api/phase2.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'bitable_field.dart';

typedef ConfigChanged = void Function(CosViewConfig cfg);

/// 在锚点下方弹出一个面板（桌面）；窄屏用底部弹层。
Future<void> showViewPanel(BuildContext context, {required String title, required Widget Function(StateSetter) body}) {
  final s = AppScope.read(context);
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black12,
    builder: (ctx) => AppScope(
      state: s,
      child: Dialog(
        alignment: Alignment.topCenter,
        insetPadding: const EdgeInsets.only(top: 120, left: 24, right: 24, bottom: 24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640, maxHeight: 520),
          child: StatefulBuilder(
            builder: (ctx, setS) => Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 12, 16),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  Expanded(child: Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
                  FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: () => Navigator.pop(ctx)),
                ]),
                const SizedBox(height: 8),
                Flexible(child: SingleChildScrollView(child: body(setS))),
              ]),
            ),
          ),
        ),
      ),
    ),
  );
}

Widget _fieldDropdown(List<CosFieldMeta> fields, String? value, ValueChanged<String> onChanged, {double width = 150}) =>
    SizedBox(
      width: width,
      child: DropdownButtonFormField<String>(
        initialValue: fields.any((f) => f.fieldName == value) ? value : null,
        isExpanded: true,
        decoration: const InputDecoration(isDense: true),
        items: [
          for (final f in fields)
            DropdownMenuItem(
              value: f.fieldName,
              child: Row(children: [
                Icon(fieldIcon(f.type), size: 15, color: Fs.text3),
                const SizedBox(width: 6),
                Flexible(child: Text(f.label, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
              ]),
            ),
        ],
        onChanged: (v) => v == null ? null : onChanged(v),
      ),
    );

// ---------------- 筛选 ----------------

/// 根据运算符整理值的形状：is / is_not 为 List<String>，比较类为 num，contains 为 String。
dynamic normalizeValue(String op, dynamic v) {
  if (kNoValueOperators.contains(op)) return null;
  if (op == 'is' || op == 'is_not') {
    if (v == null) return <String>[];
    return v is List ? [for (final e in v) e.toString()] : [v.toString()];
  }
  if (op == 'contains' || op == 'not_contains') return v is List ? v.join(' ') : (v ?? '').toString();
  final x = v is List ? (v.isEmpty ? null : v.first) : v;
  return x is num ? x : num.tryParse('${x ?? ''}');
}

Future<void> showFilterPanel(BuildContext context, CosTableMeta meta, CosViewConfig cfg, ConfigChanged onChanged) {
  var c = cfg;
  void set(StateSetter setS, CosViewConfig n) {
    setS(() => c = n);
    onChanged(n);
  }

  return showViewPanel(
    context,
    title: '筛选条件',
    body: (setS) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (c.conditions.isEmpty)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 12),
          child: Text('还没有筛选条件，添加后只显示符合条件的记录', style: TextStyle(color: Fs.text3, fontSize: 13)),
        ),
      for (var i = 0; i < c.conditions.length; i++)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(
              width: 64,
              child: i == 0
                  ? const Padding(padding: EdgeInsets.only(top: 10), child: Text('当', style: TextStyle(fontSize: 13)))
                  : i == 1
                      ? DropdownButtonFormField<String>(
                          initialValue: c.conjunction,
                          decoration: const InputDecoration(isDense: true),
                          items: const [
                            DropdownMenuItem(value: 'and', child: Text('且', style: TextStyle(fontSize: 13))),
                            DropdownMenuItem(value: 'or', child: Text('或', style: TextStyle(fontSize: 13))),
                          ],
                          onChanged: (v) => set(setS, c.copyWith(conjunction: v)),
                        )
                      : Padding(
                          padding: const EdgeInsets.only(top: 10),
                          child: Text(c.conjunction == 'or' ? '或' : '且', style: const TextStyle(fontSize: 13)),
                        ),
            ),
            const SizedBox(width: 6),
            _fieldDropdown(meta.fields, c.conditions[i].fieldName, (v) {
              final f = meta.field(v)!;
              final op = operatorsFor(f.type).first;
              final list = [...c.conditions]..[i] = CosFilterCondition(v, op, normalizeValue(op, null));
              set(setS, c.copyWith(conditions: list));
            }, width: 140),
            const SizedBox(width: 6),
            SizedBox(
              width: 112,
              child: Builder(builder: (_) {
                final cond = c.conditions[i];
                final ops = operatorsFor(meta.field(cond.fieldName)?.type ?? 1);
                return DropdownButtonFormField<String>(
                  key: ValueKey('${cond.fieldName}-op'),
                  initialValue: ops.contains(cond.operator) ? cond.operator : ops.first,
                  isExpanded: true,
                  decoration: const InputDecoration(isDense: true),
                  items: [
                    for (final o in ops)
                      DropdownMenuItem(value: o, child: Text(kFilterOperators[o]!, style: const TextStyle(fontSize: 13))),
                  ],
                  onChanged: (o) {
                    final list = [...c.conditions]..[i] = cond.copyWith(operator: o, value: normalizeValue(o!, cond.value));
                    set(setS, c.copyWith(conditions: list));
                  },
                );
              }),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: ConditionValueEditor(
                key: ValueKey('${c.conditions[i].fieldName}-${c.conditions[i].operator}-$i'),
                field: meta.field(c.conditions[i].fieldName),
                condition: c.conditions[i],
                onChanged: (v) {
                  final list = [...c.conditions]..[i] = c.conditions[i].copyWith(value: v);
                  set(setS, c.copyWith(conditions: list));
                },
              ),
            ),
            FsIconButton(
              icon: Icons.delete_outline_rounded,
              tooltip: '删除条件',
              size: 18,
              onPressed: () => set(setS, c.copyWith(conditions: [...c.conditions]..removeAt(i))),
            ),
          ]),
        ),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed: meta.fields.isEmpty
              ? null
              : () {
                  final f = meta.fields.first;
                  final op = operatorsFor(f.type).first;
                  set(setS, c.copyWith(conditions: [...c.conditions, CosFilterCondition(f.fieldName, op, normalizeValue(op, null))]));
                },
          icon: const Icon(Icons.add_rounded, size: 18),
          label: const Text('添加条件'),
        ),
      ),
    ]),
  );
}

/// 条件的值：按字段类型选择控件。
class ConditionValueEditor extends StatefulWidget {
  final CosFieldMeta? field;
  final CosFilterCondition condition;
  final ValueChanged<dynamic> onChanged;
  const ConditionValueEditor({super.key, required this.field, required this.condition, required this.onChanged});
  @override
  State<ConditionValueEditor> createState() => _ConditionValueEditorState();
}

class _ConditionValueEditorState extends State<ConditionValueEditor> {
  late final text = TextEditingController(text: _initialText());

  String _initialText() {
    final v = widget.condition.value;
    if (v is List) return v.join(', ');
    return v?.toString() ?? '';
  }

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final op = widget.condition.operator;
    final f = widget.field;
    if (kNoValueOperators.contains(op) || f == null) return const SizedBox(height: 40);
    final v = widget.condition.value;
    final listValue = v is List ? [for (final e in v) e.toString()] : <String>[];
    final isList = op == 'is' || op == 'is_not';
    if (isList && (f.type == 3 || f.type == 4)) {
      return Wrap(spacing: 6, runSpacing: 6, children: [
        for (final o in f.options ?? const <String>[])
          FilterChip(
            label: Text(o, style: const TextStyle(fontSize: 12)),
            selected: listValue.contains(o),
            showCheckmark: false,
            selectedColor: optionColor(f, o).bg,
            visualDensity: VisualDensity.compact,
            onSelected: (sel) => widget.onChanged(sel ? [...listValue, o] : (listValue..remove(o))),
          ),
      ]);
    }
    if (f.type == 7) {
      return DropdownButtonFormField<String>(
        initialValue: listValue.isEmpty ? 'true' : listValue.first,
        decoration: const InputDecoration(isDense: true),
        items: const [
          DropdownMenuItem(value: 'true', child: Text('已勾选', style: TextStyle(fontSize: 13))),
          DropdownMenuItem(value: 'false', child: Text('未勾选', style: TextStyle(fontSize: 13))),
        ],
        onChanged: (x) => widget.onChanged([x!]),
      );
    }
    if (isList && f.type == 11) {
      final s = AppScope.of(context);
      return Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
        for (final id in listValue)
          InputChip(
            label: Text(s.userName(id), style: const TextStyle(fontSize: 12)),
            visualDensity: VisualDensity.compact,
            onDeleted: () => widget.onChanged([...listValue]..remove(id)),
          ),
        TextButton(
          onPressed: () async {
            final ids = await pickUsers(context, users: s.users, title: '选择人员', initial: listValue);
            if (ids != null) widget.onChanged(ids);
          },
          child: const Text('选择人员'),
        ),
      ]);
    }
    if (f.type == 5) {
      final ms = isList ? (listValue.isEmpty ? null : num.tryParse(listValue.first)) : (v is num ? v : null);
      return OutlinedButton.icon(
        style: OutlinedButton.styleFrom(alignment: Alignment.centerLeft),
        onPressed: () async {
          final d = await pickDateTime(context,
              initial: ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms.toInt()), withTime: false);
          if (d == null) return;
          final t = DateTime(d.year, d.month, d.day).millisecondsSinceEpoch;
          widget.onChanged(isList ? ['$t'] : t);
        },
        icon: const Icon(Icons.event_outlined, size: 16),
        label: Text(ms == null ? '选择日期' : fmtDate(DateTime.fromMillisecondsSinceEpoch(ms.toInt()))),
      );
    }
    return TextField(
      controller: text,
      keyboardType: f.type == 2 ? const TextInputType.numberWithOptions(decimal: true, signed: true) : null,
      decoration: InputDecoration(isDense: true, hintText: isList ? '多个值用逗号分隔' : '输入值'),
      onChanged: (t) {
        if (isList) {
          widget.onChanged([for (final e in t.split(RegExp(r'[,，]'))) if (e.trim().isNotEmpty) e.trim()]);
        } else if (op == 'contains' || op == 'not_contains') {
          widget.onChanged(t);
        } else {
          widget.onChanged(num.tryParse(t.trim()));
        }
      },
    );
  }
}

// ---------------- 排序 / 分组 ----------------

Future<void> showSortPanel(BuildContext context, CosTableMeta meta, CosViewConfig cfg, ConfigChanged onChanged,
    {bool group = false}) {
  var c = cfg;
  List<CosSortSpec> specs() => group ? c.group : c.sort;
  void set(StateSetter setS, List<CosSortSpec> list) {
    final n = group ? c.copyWith(group: list) : c.copyWith(sort: list);
    setS(() => c = n);
    onChanged(n);
  }

  final max = group ? 3 : 5;
  return showViewPanel(
    context,
    title: group ? '分组（最多 3 级）' : '排序',
    body: (setS) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (specs().isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Text(group ? '按字段把记录分成几组，组头显示数量，可以折叠' : '还没有排序规则，记录按创建顺序显示',
              style: const TextStyle(color: Fs.text3, fontSize: 13)),
        ),
      for (var i = 0; i < specs().length; i++)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(children: [
            SizedBox(
              width: 64,
              child: Text(group ? '第 ${i + 1} 级' : (i == 0 ? '按' : '然后按'), style: const TextStyle(fontSize: 13)),
            ),
            _fieldDropdown(
              meta.fields.where((f) => f.fieldName == specs()[i].fieldName || !specs().any((s) => s.fieldName == f.fieldName)).toList(),
              specs()[i].fieldName,
              (v) => set(setS, [...specs()]..[i] = CosSortSpec(v, desc: specs()[i].desc)),
              width: 200,
            ),
            const SizedBox(width: 8),
            SegmentedButton<bool>(
              showSelectedIcon: false,
              style: const ButtonStyle(visualDensity: VisualDensity.compact),
              segments: const [
                ButtonSegment(value: false, label: Text('升序', style: TextStyle(fontSize: 12))),
                ButtonSegment(value: true, label: Text('降序', style: TextStyle(fontSize: 12))),
              ],
              selected: {specs()[i].desc},
              onSelectionChanged: (s) => set(setS, [...specs()]..[i] = CosSortSpec(specs()[i].fieldName, desc: s.first)),
            ),
            const Spacer(),
            FsIconButton(
              icon: Icons.delete_outline_rounded,
              tooltip: '删除',
              size: 18,
              onPressed: () => set(setS, [...specs()]..removeAt(i)),
            ),
          ]),
        ),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed: specs().length >= max || specs().length >= meta.fields.length
              ? null
              : () {
                  final f = meta.fields.firstWhere((f) => !specs().any((s) => s.fieldName == f.fieldName));
                  set(setS, [...specs(), CosSortSpec(f.fieldName)]);
                },
          icon: const Icon(Icons.add_rounded, size: 18),
          label: Text(group ? '添加分组' : '添加排序'),
        ),
      ),
    ]),
  );
}

// ---------------- 隐藏字段 / 列顺序 ----------------

Future<void> showFieldsPanel(BuildContext context, CosTableMeta meta, CosViewConfig cfg, ConfigChanged onChanged) {
  var c = cfg;
  final primary = meta.primaryField ?? meta.fields.firstOrNull?.fieldName;
  return showViewPanel(
    context,
    title: '字段显示与顺序（仅当前视图）',
    body: (setS) {
      final ordered = c.orderedFields(meta.fields);
      void set(CosViewConfig n) {
        setS(() => c = n);
        onChanged(n);
      }

      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Text('已隐藏 ${c.hiddenFields.where((h) => meta.field(h) != null).length} 个字段',
              style: const TextStyle(fontSize: 12, color: Fs.text3)),
          const Spacer(),
          TextButton(
            onPressed: c.hiddenFields.isEmpty ? null : () => set(c.copyWith(hiddenFields: const [])),
            child: const Text('全部显示'),
          ),
        ]),
        ReorderableListView.builder(
          shrinkWrap: true,
          buildDefaultDragHandles: false,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: ordered.length,
          onReorderItem: (a, b) {
            final names = [for (final f in ordered) f.fieldName];
            names.insert(b, names.removeAt(a));
            set(c.copyWith(fieldOrder: names));
          },
          itemBuilder: (_, i) {
            final f = ordered[i];
            final hidden = c.hiddenFields.contains(f.fieldName);
            return ListTile(
              key: ValueKey(f.fieldName),
              dense: true,
              leading: ReorderableDragStartListener(
                index: i,
                child: const MouseRegion(
                  cursor: SystemMouseCursors.grab,
                  child: Icon(Icons.drag_indicator_rounded, size: 18, color: Fs.text3),
                ),
              ),
              title: Row(children: [
                Icon(fieldIcon(f.type), size: 15, color: hidden ? Fs.textDisabled : Fs.text2),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(f.label,
                      overflow: TextOverflow.ellipsis, style: TextStyle(color: hidden ? Fs.text3 : Fs.text1, fontSize: 13)),
                ),
              ]),
              trailing: f.fieldName == primary
                  ? const Text('主字段', style: TextStyle(fontSize: 12, color: Fs.text3))
                  : Switch(
                      value: !hidden,
                      onChanged: (show) => set(c.copyWith(
                        hiddenFields: show
                            ? (c.hiddenFields.where((h) => h != f.fieldName).toList())
                            : [...c.hiddenFields, f.fieldName],
                      )),
                    ),
            );
          },
        ),
      ]);
    },
  );
}
