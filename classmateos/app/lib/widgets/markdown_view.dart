/// 轻量 Markdown 渲染（云文档阅读模式）：标题 / 段落 / 有序无序列表 / 待办 /
/// 引用 / 代码块 / 分割线 / 表格；行内支持粗体、斜体、删除线、行内代码、链接。
library;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../theme.dart';
import 'common.dart';

class MarkdownView extends StatelessWidget {
  final String source;
  final double fontSize;
  const MarkdownView(this.source, {super.key, this.fontSize = 15});

  @override
  Widget build(BuildContext context) {
    final blocks = <Widget>[];
    final lines = source.replaceAll('\r\n', '\n').split('\n');
    var i = 0;
    while (i < lines.length) {
      final line = lines[i];
      final t = line.trimLeft();
      if (t.isEmpty) {
        i++;
        continue;
      }
      // 代码块
      if (t.startsWith('```')) {
        final lang = t.substring(3).trim();
        final buf = <String>[];
        i++;
        while (i < lines.length && !lines[i].trimLeft().startsWith('```')) {
          buf.add(lines[i]);
          i++;
        }
        i++;
        blocks.add(_codeBlock(buf.join('\n'), lang));
        continue;
      }
      // 分割线
      if (RegExp(r'^(-{3,}|\*{3,}|_{3,})$').hasMatch(t)) {
        blocks.add(const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Divider()));
        i++;
        continue;
      }
      // 标题
      final h = RegExp(r'^(#{1,6})\s+(.*)$').firstMatch(t);
      if (h != null) {
        final level = h.group(1)!.length;
        const sizes = [26.0, 22.0, 19.0, 17.0, 16.0, 15.0];
        blocks.add(Padding(
          padding: EdgeInsets.only(top: level <= 2 ? 18 : 12, bottom: 6),
          child: Text.rich(
            _inline(context, h.group(2)!),
            style: TextStyle(fontSize: sizes[level - 1], fontWeight: FontWeight.w600, height: 1.4),
          ),
        ));
        i++;
        continue;
      }
      // 表格
      if (t.startsWith('|') && i + 1 < lines.length && RegExp(r'^\|?\s*:?-{2,}').hasMatch(lines[i + 1].trim())) {
        final rows = <List<String>>[];
        rows.add(_cells(t));
        i += 2;
        while (i < lines.length && lines[i].trimLeft().startsWith('|')) {
          rows.add(_cells(lines[i].trim()));
          i++;
        }
        blocks.add(_table(context, rows));
        continue;
      }
      // 引用
      if (t.startsWith('>')) {
        final buf = <String>[];
        while (i < lines.length && lines[i].trimLeft().startsWith('>')) {
          buf.add(lines[i].trimLeft().substring(1).trimLeft());
          i++;
        }
        blocks.add(Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.fromLTRB(12, 4, 8, 4),
          decoration: const BoxDecoration(border: Border(left: BorderSide(color: Color(0xFFBBBFC4), width: 3))),
          child: Text.rich(_inline(context, buf.join('\n')),
              style: TextStyle(fontSize: fontSize, color: Fs.text2, height: 1.7)),
        ));
        continue;
      }
      // 列表
      final li = RegExp(r'^(\s*)([-*+]|\d+[.)])\s+(.*)$');
      if (li.hasMatch(line)) {
        var n = 0;
        while (i < lines.length && li.hasMatch(lines[i])) {
          final m = li.firstMatch(lines[i])!;
          final indent = (m.group(1)!.length / 2).floor();
          final marker = m.group(2)!;
          var body = m.group(3)!;
          final ordered = RegExp(r'\d').hasMatch(marker);
          n++;
          bool? checked;
          final task = RegExp(r'^\[( |x|X)\]\s*(.*)$').firstMatch(body);
          if (task != null) {
            checked = task.group(1)!.toLowerCase() == 'x';
            body = task.group(2)!;
          }
          blocks.add(Padding(
            padding: EdgeInsets.only(left: 4.0 + indent * 22, top: 3, bottom: 3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 22,
                  child: checked != null
                      ? Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Icon(
                            checked ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded,
                            size: 17,
                            color: checked ? Fs.primary : Fs.text3,
                          ),
                        )
                      : Text(ordered ? marker.replaceAll(')', '.') : (indent == 0 ? '•' : '◦'),
                          style: TextStyle(fontSize: fontSize, color: Fs.primary, height: 1.7)),
                ),
                Expanded(
                  child: Text.rich(
                    _inline(context, body),
                    style: TextStyle(
                      fontSize: fontSize,
                      height: 1.7,
                      color: checked == true ? Fs.text3 : Fs.text1,
                      decoration: checked == true ? TextDecoration.lineThrough : null,
                    ),
                  ),
                ),
              ],
            ),
          ));
          i++;
        }
        if (n > 0) continue;
      }
      // 段落：合并连续非空行
      final buf = <String>[line.trim()];
      i++;
      while (i < lines.length &&
          lines[i].trim().isNotEmpty &&
          !RegExp(r'^(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s|\|)').hasMatch(lines[i].trimLeft())) {
        buf.add(lines[i].trim());
        i++;
      }
      blocks.add(Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Text.rich(_inline(context, buf.join('\n')), style: TextStyle(fontSize: fontSize, height: 1.75)),
      ));
    }
    return SelectionArea(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: blocks),
    );
  }

  List<String> _cells(String row) {
    var r = row.trim();
    if (r.startsWith('|')) r = r.substring(1);
    if (r.endsWith('|')) r = r.substring(0, r.length - 1);
    return r.split('|').map((c) => c.trim()).toList();
  }

  Widget _table(BuildContext context, List<List<String>> rows) {
    final cols = rows.map((r) => r.length).fold<int>(0, (a, b) => a > b ? a : b);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Table(
          defaultColumnWidth: const IntrinsicColumnWidth(),
          border: TableBorder.all(color: Fs.line),
          children: [
            for (var r = 0; r < rows.length; r++)
              TableRow(
                decoration: BoxDecoration(color: r == 0 ? Fs.bg : Colors.white),
                children: [
                  for (var c = 0; c < cols; c++)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(minWidth: 60, maxWidth: 320),
                        child: Text.rich(
                          _inline(context, c < rows[r].length ? rows[r][c] : ''),
                          style: TextStyle(fontSize: 14, fontWeight: r == 0 ? FontWeight.w600 : FontWeight.normal),
                        ),
                      ),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _codeBlock(String code, String lang) => Container(
        margin: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(8), border: Border.all(color: Fs.lineLight)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (lang.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
                child: Text(lang, style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.all(14),
              child: Text(code,
                  style: const TextStyle(fontFamily: 'Menlo', fontFamilyFallback: ['Consolas', 'monospace'], fontSize: 13, height: 1.6)),
            ),
          ],
        ),
      );

  static final _inlineRe = RegExp(
      r'(\*\*(.+?)\*\*)|(~~(.+?)~~)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*(.+?)\*)|(_(.+?)_)');

  TextSpan _inline(BuildContext context, String text) {
    final spans = <InlineSpan>[];
    var last = 0;
    for (final m in _inlineRe.allMatches(text)) {
      if (m.start > last) spans.add(TextSpan(text: text.substring(last, m.start)));
      if (m.group(1) != null) {
        spans.add(TextSpan(children: [_inline(context, m.group(2)!)], style: const TextStyle(fontWeight: FontWeight.w700)));
      } else if (m.group(3) != null) {
        spans.add(TextSpan(text: m.group(4), style: const TextStyle(decoration: TextDecoration.lineThrough, color: Fs.text3)));
      } else if (m.group(5) != null) {
        spans.add(WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(color: const Color(0xFFF0F1F2), borderRadius: BorderRadius.circular(4)),
            child: Text(m.group(6)!,
                style: TextStyle(fontFamily: 'Menlo', fontFamilyFallback: const ['Consolas', 'monospace'], fontSize: fontSize - 2, color: const Color(0xFFD83931))),
          ),
        ));
      } else if (m.group(7) != null) {
        final url = m.group(9)!;
        spans.add(TextSpan(
          text: m.group(8),
          style: const TextStyle(color: Fs.primary),
          recognizer: TapGestureRecognizer()..onTap = () => openExternal(context, url),
        ));
      } else if (m.group(10) != null) {
        spans.add(TextSpan(text: m.group(11), style: const TextStyle(fontStyle: FontStyle.italic)));
      } else if (m.group(12) != null) {
        spans.add(TextSpan(text: m.group(13), style: const TextStyle(fontStyle: FontStyle.italic)));
      }
      last = m.end;
    }
    if (last < text.length) spans.add(TextSpan(text: text.substring(last)));
    return TextSpan(children: spans);
  }
}
