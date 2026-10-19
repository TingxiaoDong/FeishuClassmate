/// 文档里的图片和附件（R-DC-04）：Markdown 里写 `cos-file://file_key`，渲染时换成
/// `GET /files/:file_key/download-url` 的签名地址（带内存缓存，签名过期前复用）。
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../theme.dart';
import 'common.dart';

const kCosFileScheme = 'cos-file://';

/// cos-file://key?name=a.pdf&size=123 → (key, name, size)
({String key, String? name, int? size}) parseCosFile(String url) {
  final rest = url.substring(kCosFileScheme.length);
  final i = rest.indexOf('?');
  if (i < 0) return (key: Uri.decodeComponent(rest), name: null, size: null);
  final q = Uri.splitQueryString(rest.substring(i + 1));
  return (key: Uri.decodeComponent(rest.substring(0, i)), name: q['name'], size: int.tryParse(q['size'] ?? ''));
}

String cosFileUrl(String key, {String? name, int? size}) {
  final q = {if (name != null) 'name': name, if (size != null) 'size': '$size'};
  return '$kCosFileScheme${Uri.encodeComponent(key)}${q.isEmpty ? '' : '?${Uri(queryParameters: q).query}'}';
}

class _Cached {
  final Future<String> url;
  final DateTime at;
  _Cached(this.url, this.at);
}

final Map<String, _Cached> _urlCache = {};

/// 签名地址缓存 40 分钟（后端签名有效期更长，提前刷新）。
Future<String> resolveCosFile(CosApiClient api, String key, {bool attachment = false}) {
  final k = '$key|$attachment';
  final c = _urlCache[k];
  if (c != null && DateTime.now().difference(c.at).inMinutes < 40) return c.url;
  final f = api.downloadUrl(key, attachment: attachment);
  _urlCache[k] = _Cached(f, DateTime.now());
  f.catchError((Object _) {
    _urlCache.remove(k);
    return '';
  });
  return f;
}

Uint8List? _dataUrlBytes(String url) {
  if (!url.startsWith('data:')) return null;
  final i = url.indexOf(',');
  return i < 0 ? null : base64Decode(url.substring(i + 1));
}

Widget _imageFor(String url, {BoxFit fit = BoxFit.contain, double? maxHeight}) {
  final bytes = _dataUrlBytes(url);
  Widget err(BuildContext _, Object _, StackTrace? _) => Container(
        height: 120,
        alignment: Alignment.center,
        color: Fs.bg,
        child: const Text('图片加载失败', style: TextStyle(color: Fs.text3, fontSize: 13)),
      );
  final img = bytes != null
      ? Image.memory(bytes, fit: fit, errorBuilder: err)
      : Image.network(url, fit: fit, errorBuilder: err, loadingBuilder: (c, child, p) => p == null
          ? child
          : const SizedBox(height: 160, child: Center(child: CircularProgressIndicator(strokeWidth: 2))));
  return maxHeight == null ? img : ConstrainedBox(constraints: BoxConstraints(maxHeight: maxHeight), child: img);
}

/// 文档里的图片：支持 cos-file:// 和普通 http 地址，点击放大。
class DocImage extends StatelessWidget {
  final String url;
  final String alt;
  const DocImage({super.key, required this.url, this.alt = ''});

  @override
  Widget build(BuildContext context) {
    if (url.startsWith(kCosFileScheme)) {
      final api = AppScope.maybeOf(context)?.api;
      if (api == null) return _placeholder('图片');
      return FutureBuilder<String>(
        future: resolveCosFile(api, parseCosFile(url).key),
        builder: (context, snap) {
          if (snap.hasError) return _placeholder('图片加载失败：${describeError(snap.error!)}');
          if (!snap.hasData) return const SizedBox(height: 160, child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
          return _frame(context, snap.data!);
        },
      );
    }
    return _frame(context, url);
  }

  Widget _placeholder(String t) => Container(
        height: 80,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(8)),
        child: Text(t, style: const TextStyle(color: Fs.text3, fontSize: 13)),
      );

  Widget _frame(BuildContext context, String resolved) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Align(
          alignment: Alignment.centerLeft,
          child: MouseRegion(
            cursor: SystemMouseCursors.zoomIn,
            child: GestureDetector(
              onTap: () => showDialog<void>(
                context: context,
                barrierColor: Colors.black87,
                builder: (ctx) => GestureDetector(
                  onTap: () => Navigator.pop(ctx),
                  child: Stack(children: [
                    Positioned.fill(child: InteractiveViewer(maxScale: 6, child: Center(child: _imageFor(resolved)))),
                    Positioned(
                      top: 24,
                      right: 24,
                      child: IconButton(
                        onPressed: () => Navigator.pop(ctx),
                        icon: const Icon(Icons.close_rounded, color: Colors.white),
                      ),
                    ),
                  ]),
                ),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: Tooltip(message: alt, child: _imageFor(resolved, maxHeight: 480)),
              ),
            ),
          ),
        ),
      );
}

/// 附件卡片：图标 + 文件名 + 大小，点击下载。
class AttachmentCard extends StatelessWidget {
  final String url;
  final String label;
  const AttachmentCard({super.key, required this.url, required this.label});

  @override
  Widget build(BuildContext context) {
    final f = parseCosFile(url);
    final name = f.name ?? label.replaceFirst(RegExp(r'^📎\s*'), '');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Align(
        alignment: Alignment.centerLeft,
        child: HoverBox(
          radius: 8,
          onTap: () async {
            final api = AppScope.maybeOf(context)?.api;
            if (api == null) return;
            try {
              final u = await resolveCosFile(api, f.key, attachment: true);
              if (context.mounted) await openExternal(context, u);
            } catch (e) {
              if (context.mounted) showToast(context, describeError(e), error: true);
            }
          },
          child: Container(
            width: 360,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), border: Border.all(color: Fs.line)),
            child: Row(children: [
              FileTypeIcon(name, size: 36),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                  const SizedBox(height: 2),
                  Text(f.size == null ? '点击下载' : '${fmtSize(f.size!)} · 点击下载', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                ]),
              ),
              const Icon(Icons.download_rounded, size: 18, color: Fs.text3),
            ]),
          ),
        ),
      ),
    );
  }
}

/// 上传中 / 上传失败的占位块。
class UploadPlaceholder extends StatelessWidget {
  final bool failed;
  final VoidCallback? onRetry;
  const UploadPlaceholder({super.key, this.failed = false, this.onRetry});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Align(
          alignment: Alignment.centerLeft,
          child: HoverBox(
            onTap: failed ? onRetry : null,
            radius: 8,
            child: Container(
              width: 280,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: failed ? const Color(0xFFFFF1F0) : Fs.bg,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: failed ? const Color(0xFFFBC9C7) : Fs.lineLight),
              ),
              child: Row(children: [
                failed
                    ? const Icon(Icons.error_outline_rounded, size: 18, color: Fs.red)
                    : const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                const SizedBox(width: 10),
                Text(failed ? '上传失败，点击重试' : '上传中…', style: TextStyle(fontSize: 13, color: failed ? Fs.red : Fs.text2)),
              ]),
            ),
          ),
        ),
      );
}
