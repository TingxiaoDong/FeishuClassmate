/// 异步任务进度弹窗（导入、导出、成员导入、日志导出共用）。
/// 优先用 WS 的 `job.updated` 事件，每 2 秒轮询 `/jobs/:job_id` 兜底（需求文档 R-BT-07）。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../api/phase2_jobs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../pages/messages_page.dart' show downloadFile;
import '../theme.dart';
import 'common.dart';

/// 启动任务并显示进度，返回最终状态（用户关掉弹窗或启动失败时返回 null）。
/// [kind] 决定完成后的展示：export（下载文件）或 import（成功 / 失败条数 + 失败明细下载）。
Future<CosJob?> runJobDialog(
  BuildContext context, {
  required String title,
  required Future<String> Function() start,
  String kind = 'export',
  bool autoDownload = true,
}) =>
    showDialog<CosJob>(
      context: context,
      barrierDismissible: false,
      builder: (_) => AppScope(
        state: AppScope.read(context),
        child: _JobDialog(title: title, start: start, kind: kind, autoDownload: autoDownload),
      ),
    );

class _JobDialog extends StatefulWidget {
  final String title;
  final Future<String> Function() start;
  final String kind;
  final bool autoDownload;
  const _JobDialog({required this.title, required this.start, required this.kind, required this.autoDownload});
  @override
  State<_JobDialog> createState() => _JobDialogState();
}

class _JobDialogState extends State<_JobDialog> {
  String? jobId;
  CosJob? job;
  String? error;
  Timer? _poll;
  StreamSubscription<CosEvent>? _sub;
  bool _downloaded = false;

  @override
  void initState() {
    super.initState();
    _run();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _run() async {
    final s = AppScope.read(context);
    try {
      final id = await widget.start();
      if (!mounted) return;
      if (id.isEmpty) throw const CosApiException(0, '后端没有返回任务编号');
      setState(() => jobId = id);
      _sub = s.eventStream.listen((e) {
        if (e.eventType == 'job.updated' && e.raw['job_id'] == id) _apply(CosJob.fromJson(e.raw));
      });
      _poll = Timer.periodic(const Duration(seconds: 2), (_) => _fetch());
      _fetch();
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  Future<void> _fetch() async {
    final id = jobId;
    if (id == null || (job?.finished ?? false)) return;
    try {
      _apply(await AppScope.read(context).api.getJob(id));
    } catch (_) {/* 网络抖动时等下一轮 */}
  }

  void _apply(CosJob j) {
    if (!mounted || (job?.finished ?? false)) return;
    setState(() => job = j);
    if (j.finished) {
      _poll?.cancel();
      _sub?.cancel();
      if (j.ok && widget.kind == 'export' && widget.autoDownload && j.fileKey != null && !_downloaded) {
        _downloaded = true;
        downloadFile(context, j.fileKey!);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final j = job;
    final done = j?.finished ?? false;
    Widget body;
    if (error != null) {
      body = Row(children: [
        const Icon(Icons.error_outline_rounded, color: Fs.red, size: 20),
        const SizedBox(width: 8),
        Expanded(child: Text(error!, style: const TextStyle(color: Fs.red))),
      ]);
    } else if (j == null || !done) {
      final p = j?.progress ?? 0;
      body = Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        LinearProgressIndicator(value: j == null || p == 0 ? null : p, minHeight: 6, borderRadius: BorderRadius.circular(3)),
        const SizedBox(height: 10),
        Text(j == null ? '正在提交…' : (j.status == 'pending' ? '排队中…' : '处理中 ${(p * 100).round()}%'),
            style: const TextStyle(color: Fs.text2, fontSize: 13)),
        const SizedBox(height: 4),
        const Text('可以关掉这个窗口，完成后会在通知里提醒你', style: TextStyle(color: Fs.text3, fontSize: 12)),
      ]);
    } else if (!j.ok) {
      body = Text(j.message ?? '任务失败，请稍后重试', style: const TextStyle(color: Fs.red));
    } else if (widget.kind == 'import') {
      body = Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Icon(Icons.check_circle_rounded, color: Fs.green, size: 20),
          const SizedBox(width: 8),
          Text('成功 ${j.succeeded} 条', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          if (j.failed > 0) ...[
            const SizedBox(width: 12),
            Text('失败 ${j.failed} 条', style: const TextStyle(fontSize: 15, color: Fs.red, fontWeight: FontWeight.w600)),
          ],
        ]),
        if (j.failed > 0 && j.errorFileKey != null) ...[
          const SizedBox(height: 10),
          TextButton.icon(
            key: const ValueKey('job-error-file'),
            icon: const Icon(Icons.download_rounded, size: 16),
            label: const Text('下载失败明细'),
            onPressed: () => downloadFile(context, j.errorFileKey!),
          ),
        ],
      ]);
    } else {
      body = Row(children: [
        const Icon(Icons.check_circle_rounded, color: Fs.green, size: 20),
        const SizedBox(width: 8),
        Expanded(child: Text(j.fileName ?? '已完成，开始下载', overflow: TextOverflow.ellipsis)),
        if (j.fileKey != null)
          TextButton(onPressed: () => downloadFile(context, j.fileKey!), child: const Text('重新下载')),
      ]);
    }
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(width: 380, child: body),
      actions: [
        if (!done && error == null)
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('后台进行'))
        else
          FilledButton(onPressed: () => Navigator.pop(context, j), child: const Text('完成')),
      ],
    );
  }
}

/// 把前端生成的内容存到本机（桌面弹保存对话框，Web 触发浏览器下载）。返回是否保存。
Future<bool> saveBytesLocally(BuildContext context, String fileName, Uint8List bytes, {String mime = 'application/octet-stream'}) async {
  try {
    final uri = await FilePicker.saveFile(fileName: fileName, bytes: bytes, mimeType: mime, dialogTitle: '保存文件');
    if (uri == null) return false;
    if (context.mounted) showToast(context, '已保存 $fileName');
    return true;
  } catch (e) {
    if (context.mounted) showToast(context, '保存失败：$e', error: true);
    return false;
  }
}

Future<bool> saveTextLocally(BuildContext context, String fileName, String text, {String mime = 'text/plain'}) =>
    saveBytesLocally(context, fileName, Uint8List.fromList(utf8.encode(text)), mime: '$mime; charset=utf-8');
