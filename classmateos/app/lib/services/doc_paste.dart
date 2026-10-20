/// 文档编辑器粘贴 / 拖入文件（R-DC-04 补充）：读剪贴板里的文件和截图。
/// 平台能力用 [DocClipboard] 的静态函数包一层，测试里可以替换；插件不可用（如 Web 读不到文件列表）时按「没有」处理。
library;

import 'package:cross_file/cross_file.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:pasteboard/pasteboard.dart';

/// 要上传的一个文件。
typedef PastedFile = ({String name, Uint8List bytes});

/// 一次粘贴的内容：文件（含截图）或文字，二选一。
class PasteContent {
  final List<PastedFile> files;
  final String? text;
  const PasteContent({this.files = const [], this.text});
  bool get isEmpty => files.isEmpty && (text == null || text!.isEmpty);
}

class DocClipboard {
  /// 复制的文件路径（Finder / 资源管理器里 ⌘C 的文件）。
  static Future<List<String>> Function() files = () => Pasteboard.files();

  /// 剪贴板里的图片（PNG）。
  static Future<Uint8List?> Function() image = () => Pasteboard.image;

  /// 剪贴板里的纯文字。
  static Future<String?> Function() text = () async => (await Clipboard.getData(Clipboard.kTextPlain))?.text;

  /// 按路径读文件。
  static Future<PastedFile> Function(String path) readPath = (p) async {
    final f = XFile(p);
    return (name: f.name, bytes: await f.readAsBytes());
  };

  static Future<T?> _try<T>(Future<T> Function() f) async {
    try {
      return await f();
    } catch (e) {
      debugPrint('DocClipboard: $e');
      return null;
    }
  }

  /// 依次看：复制的文件 → 文字 → 图片。
  /// 文字优先于图片：从 Word / Excel 复制文字时剪贴板里还会附带一张截图，这时应该粘贴文字。
  static Future<PasteContent> read() async {
    final paths = await _try(files) ?? const <String>[];
    if (paths.isNotEmpty) {
      final out = <PastedFile>[];
      for (final p in paths) {
        final f = await _try(() => readPath(p));
        if (f != null) out.add(f);
      }
      if (out.isNotEmpty) return PasteContent(files: out);
    }
    final t = await _try(text);
    if (t != null && t.isNotEmpty) return PasteContent(text: t);
    final img = await _try(image);
    if (img != null && img.isNotEmpty) return PasteContent(files: [(name: screenshotName(DateTime.now()), bytes: img)]);
    return const PasteContent();
  }

  /// 截图文件名：截图_20261020_183005.png
  static String screenshotName(DateTime t) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '截图_${t.year}${two(t.month)}${two(t.day)}_${two(t.hour)}${two(t.minute)}${two(t.second)}.png';
  }
}
