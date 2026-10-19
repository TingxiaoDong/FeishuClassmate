/// 视图的本地计算：筛选、排序、分组。
/// 后端按视图计算时，前端用同一套规则处理临时筛选、实时插入的新记录和分组展示。
library;

import '../api/phase2.dart';
import '../models.dart';
import 'bitable_field.dart';

/// 单元格里可比较的「值集合」：选项文字、人员 ID、复选框 true/false、其余为显示文字。
Set<String> valueTokens(dynamic v) {
  if (v == null) return const {};
  if (v is bool) return {'$v'};
  if (v is List) {
    return {
      for (final e in v)
        if (e is Map) (userIdOf(e).isNotEmpty ? userIdOf(e) : (e['name'] ?? e['text'] ?? '').toString()) else e.toString(),
    }..remove('');
  }
  if (v is Map) {
    final id = userIdOf(v);
    return {id.isNotEmpty ? id : fieldText(v)};
  }
  final t = fieldText(v);
  return t.isEmpty ? const {} : {t};
}

num? _numOf(dynamic v) {
  if (v is num) return v;
  if (v is String) return num.tryParse(v);
  return null;
}

bool _inRange(num ms, DateTime from, DateTime to) =>
    ms >= from.millisecondsSinceEpoch && ms < to.millisecondsSinceEpoch;

bool matchCondition(CosFilterCondition c, Map<String, dynamic> fields, {DateTime? now}) {
  final v = fields[c.fieldName];
  final n = now ?? DateTime.now();
  final day = DateTime(n.year, n.month, n.day);
  switch (c.operator) {
    case 'is_empty':
      return isEmptyValue(v);
    case 'is_not_empty':
      return !isEmptyValue(v);
    case 'contains':
    case 'not_contains':
      final q = (c.value is List ? (c.value as List).join(' ') : (c.value ?? '')).toString().trim().toLowerCase();
      if (q.isEmpty) return true;
      final hit = fieldText(v).toLowerCase().contains(q) || valueTokens(v).any((t) => t.toLowerCase().contains(q));
      return c.operator == 'contains' ? hit : !hit;
    case 'is':
    case 'is_not':
      final want = c.value is List
          ? {for (final e in c.value as List) e.toString()}
          : (c.value == null || c.value.toString().isEmpty ? <String>{} : {c.value.toString()});
      if (want.isEmpty) return true; // 条件没填完不生效
      bool hit;
      if (v is num || v is String && num.tryParse(v) != null) {
        final a = _numOf(v);
        hit = want.any((w) => num.tryParse(w) == a);
        // 日期「等于」按天比较
        if (!hit && v is num && v > 100000000000) {
          final d = DateTime.fromMillisecondsSinceEpoch(v.toInt());
          hit = want.any((w) {
            final m = num.tryParse(w);
            if (m == null) return false;
            final e = DateTime.fromMillisecondsSinceEpoch(m.toInt());
            return d.year == e.year && d.month == e.month && d.day == e.day;
          });
        }
      } else {
        final tokens = v == null ? const <String>{'false'} : valueTokens(v);
        hit = tokens.any(want.contains) || (v is! List && want.contains(fieldText(v)));
      }
      return c.operator == 'is' ? hit : !hit;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      final a = _numOf(v), b = _numOf(c.value is List && (c.value as List).isNotEmpty ? (c.value as List).first : c.value);
      if (b == null) return true;
      if (a == null) return false;
      return switch (c.operator) { 'gt' => a > b, 'gte' => a >= b, 'lt' => a < b, _ => a <= b };
    case 'today':
      return v is num && _inRange(v, day, day.add(const Duration(days: 1)));
    case 'this_week':
      final start = day.subtract(Duration(days: day.weekday - 1));
      return v is num && _inRange(v, start, start.add(const Duration(days: 7)));
    case 'last_7_days':
      return v is num && _inRange(v, day.subtract(const Duration(days: 6)), day.add(const Duration(days: 1)));
    case 'this_month':
      return v is num && _inRange(v, DateTime(n.year, n.month), DateTime(n.year, n.month + 1));
  }
  return true;
}

bool matchFilter(CosViewConfig cfg, CosRecord r) {
  final cs = cfg.conditions;
  if (cs.isEmpty) return true;
  return cfg.conjunction == 'or' ? cs.any((c) => matchCondition(c, r.fields)) : cs.every((c) => matchCondition(c, r.fields));
}

int compareValues(dynamic a, dynamic b) {
  final ea = isEmptyValue(a), eb = isEmptyValue(b);
  if (ea && eb) return 0;
  if (ea) return 1; // 空值总在最后
  if (eb) return -1;
  final na = _numOf(a), nb = _numOf(b);
  if (na != null && nb != null) return na.compareTo(nb);
  if (a is bool && b is bool) return a == b ? 0 : (a ? -1 : 1);
  return fieldText(a).compareTo(fieldText(b));
}

int compareRecords(List<CosSortSpec> specs, CosRecord a, CosRecord b) {
  for (final s in specs) {
    final c = compareValues(a.fields[s.fieldName], b.fields[s.fieldName]);
    if (c != 0) {
      // 空值无论升降序都在最后
      final ea = isEmptyValue(a.fields[s.fieldName]), eb = isEmptyValue(b.fields[s.fieldName]);
      if (ea != eb) return c;
      return s.desc ? -c : c;
    }
  }
  return 0;
}

/// 筛选 + 关键词 + 排序（分组字段优先参与排序，保证同组连续）。
List<CosRecord> applyView(CosViewConfig cfg, List<CosRecord> records, {String keyword = ''}) {
  final k = keyword.toLowerCase();
  final list = [
    for (final r in records)
      if (matchFilter(cfg, r) &&
          (k.isEmpty || r.fields.values.any((v) => fieldText(v).toLowerCase().contains(k))))
        r,
  ];
  final specs = [...cfg.group, ...cfg.sort];
  if (specs.isNotEmpty) {
    // 稳定排序：先按原顺序编号
    final idx = {for (var i = 0; i < list.length; i++) list[i].recordId: i};
    list.sort((a, b) {
      final c = compareRecords(specs, a, b);
      return c != 0 ? c : idx[a.recordId]!.compareTo(idx[b.recordId]!);
    });
  }
  return list;
}

/// 分组的显示值（多选、人员合并成一个组）。
String groupValue(dynamic v) => isEmptyValue(v) ? '' : fieldText(v);

/// 表格里的一行：分组头或记录。
sealed class GridRow {
  const GridRow();
}

class GroupHeaderRow extends GridRow {
  final int depth;
  final List<String> path;
  final String fieldName;
  final int count;
  final bool collapsed;
  const GroupHeaderRow(this.depth, this.path, this.fieldName, this.count, this.collapsed);
  String get key => path.join('\u0001');
}

class RecordRow extends GridRow {
  final CosRecord record;
  final int index;
  final List<String> path;
  const RecordRow(this.record, this.index, this.path);
}

class AddRow extends GridRow {
  final List<String> path;
  const AddRow(this.path);
}

/// 把排好序的记录按分组展开成行；[collapsed] 是折叠的组（path 以 \u0001 连接）。
List<GridRow> buildGridRows(List<CosRecord> sorted, List<CosSortSpec> group, Set<String> collapsed) {
  if (group.isEmpty) {
    return [for (var i = 0; i < sorted.length; i++) RecordRow(sorted[i], i, const []), const AddRow([])];
  }
  final out = <GridRow>[];
  var index = 0;
  void walk(List<CosRecord> recs, int depth, List<String> path) {
    if (depth == group.length) {
      for (final r in recs) {
        out.add(RecordRow(r, index++, path));
      }
      out.add(AddRow(path));
      return;
    }
    final f = group[depth].fieldName;
    final buckets = <String, List<CosRecord>>{};
    for (final r in recs) {
      buckets.putIfAbsent(groupValue(r.fields[f]), () => []).add(r);
    }
    for (final e in buckets.entries) {
      final p = [...path, e.key];
      final h = GroupHeaderRow(depth, p, f, e.value.length, collapsed.contains(p.join('\u0001')));
      out.add(h);
      if (!h.collapsed) walk(e.value, depth + 1, p);
    }
  }

  walk(sorted, 0, const []);
  return out;
}
