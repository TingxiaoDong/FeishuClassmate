/// 多维表格区域复制粘贴（R-BT-06 补充）：单元格值 ↔ 制表符分隔文字（TSV，Excel / Numbers / 飞书表格通用）。
/// 这里只做格式转换，不碰界面和接口，方便单测。
library;

import '../models.dart';
import 'bitable_field.dart';

/// 粘贴时能写入的字段类型：文本、数字、单选、多选、日期、复选框、人员、超链接。
/// 附件、关联、公式等跳过（和「批量修改」一致）。
const kPasteFieldTypes = {1, 2, 3, 4, 5, 7, 11, 15};

/// 一个单元格复制出去的文字。日期按「2026-10-20」或「2026-10-20 14:30」，人员 / 多选用「、」连接。
String cellCopyText(CosFieldMeta f, dynamic v) {
  if (v == null) return '';
  if (f.type == 5 && v is num) return fmtFieldDate(v);
  if (f.type == 15 && v is Map) return (v['link'] ?? v['text'] ?? '').toString();
  return fieldText(v);
}

/// 二维文字 → TSV。含制表符、换行或引号的格子按 Excel 的规则加引号。
String toTsv(List<List<String>> rows) => rows
    .map((r) => r.map((c) => c.contains(RegExp('[\t\n\r"]')) ? '"${c.replaceAll('"', '""')}"' : c).join('\t'))
    .join('\n');

/// TSV → 二维文字。支持 Excel 带引号的多行格子；去掉末尾的空行。
List<List<String>> parseTsv(String text) {
  final rows = <List<String>>[];
  var row = <String>[];
  final cell = StringBuffer();
  var quoted = false;
  var i = 0;
  final s = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  while (i < s.length) {
    final ch = s[i];
    if (quoted) {
      if (ch == '"') {
        if (i + 1 < s.length && s[i + 1] == '"') {
          cell.write('"');
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        cell.write(ch);
      }
    } else if (ch == '"' && cell.isEmpty) {
      quoted = true;
    } else if (ch == '\t') {
      row.add(cell.toString());
      cell.clear();
    } else if (ch == '\n') {
      row.add(cell.toString());
      cell.clear();
      rows.add(row);
      row = <String>[];
    } else {
      cell.write(ch);
    }
    i++;
  }
  row.add(cell.toString());
  rows.add(row);
  while (rows.isNotEmpty && rows.last.every((c) => c.isEmpty)) {
    rows.removeLast();
  }
  return rows;
}

/// 粘贴一个格子的结果：成功时 [value] 是要写入的值（null 表示清空），失败时 [error] 是中文原因。
class PasteValue {
  final dynamic value;
  final String? error;
  const PasteValue.ok(this.value) : error = null;
  const PasteValue.fail(String this.error) : value = null;
  bool get ok => error == null;
}

final _splitRe = RegExp(r'\s*[、,，;；]\s*');

/// 把粘贴进来的文字按字段类型转换成接口值。
PasteValue parsePasteValue(CosFieldMeta f, String raw, List<CosUser> users) {
  final t = raw.trim();
  if (!kPasteFieldTypes.contains(f.type)) return PasteValue.fail('「${f.label}」不支持粘贴');
  if (t.isEmpty) return const PasteValue.ok(null);
  switch (f.type) {
    case 2:
      final n = num.tryParse(t.replaceAll(RegExp(r'[,，\s]'), ''));
      return n == null ? PasteValue.fail('「$t」不是数字') : PasteValue.ok(n);
    case 3:
      final opts = f.options ?? const <String>[];
      return opts.contains(t) ? PasteValue.ok(t) : PasteValue.fail('「$t」不是「${f.label}」的选项');
    case 4:
      final opts = f.options ?? const <String>[];
      final list = t.split(_splitRe).where((x) => x.isNotEmpty).toList();
      final bad = list.where((x) => !opts.contains(x)).toList();
      return bad.isEmpty ? PasteValue.ok(list) : PasteValue.fail('「${bad.join('、')}」不是「${f.label}」的选项');
    case 5:
      final d = parsePasteDate(t);
      return d == null ? PasteValue.fail('「$t」不是日期') : PasteValue.ok(d.millisecondsSinceEpoch);
    case 7:
      const yes = {'是', 'true', '1', '✓', '√', 'yes', 'y', 'x', '已完成', '勾选'};
      const no = {'否', 'false', '0', 'no', 'n', '未完成'};
      final k = t.toLowerCase();
      if (yes.contains(k)) return const PasteValue.ok(true);
      if (no.contains(k)) return const PasteValue.ok(false);
      return PasteValue.fail('「$t」不是“是 / 否”');
    case 11:
      final out = <Map<String, dynamic>>[];
      final bad = <String>[];
      for (final n in t.split(_splitRe).where((x) => x.isNotEmpty)) {
        final hit = users.where((u) => u.name == n || u.userId == n).toList();
        if (hit.length == 1) {
          out.add({'id': hit.first.userId, 'name': hit.first.name});
        } else {
          bad.add(hit.isEmpty ? n : '$n（重名）');
        }
      }
      return bad.isEmpty ? PasteValue.ok(out) : PasteValue.fail('找不到成员「${bad.join('、')}」');
    default: // 1 文本、15 超链接：原样写入（保留格子里的换行）
      return PasteValue.ok(raw.trimRight());
  }
}

/// 认这些写法：2026-10-20、2026/10/20、2026.10.20、2026年10月20日，后面可带 14:30；也认毫秒时间戳。
DateTime? parsePasteDate(String t) {
  final m = RegExp(r'^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\s+(\d{1,2}):(\d{2}))?$').firstMatch(t.trim());
  if (m != null) {
    final y = int.parse(m[1]!), mo = int.parse(m[2]!), d = int.parse(m[3]!);
    final h = m[4] == null ? 0 : int.parse(m[4]!), mi = m[5] == null ? 0 : int.parse(m[5]!);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    final dt = DateTime(y, mo, d, h, mi);
    return dt.month == mo ? dt : null; // 2 月 30 日之类
  }
  final n = int.tryParse(t);
  if (n != null && n > 100000000000) return DateTime.fromMillisecondsSinceEpoch(n);
  return null;
}
