/// 云盘：独立文件列表、真实用量、上传到云盘。
library;

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'messages_page.dart' show downloadFile;

class _Entry {
  final CosDriveFile data;
  CosFileRef get file => data.ref;
  const _Entry(this.data);
}

enum _Space {
  all('全部文件', Icons.folder_copy_outlined),
  mine('我的空间', Icons.cloud_outlined),
  shared('来自会话', Icons.forum_outlined);

  final String label;
  final IconData icon;
  const _Space(this.label, this.icon);
}

const _kinds = ['全部', '图片', '文档', 'PDF', '表格', '演示', '其他'];

class DrivePage extends StatefulWidget {
  const DrivePage({super.key});
  @override
  State<DrivePage> createState() => _DrivePageState();
}

class _DrivePageState extends State<DrivePage> {
  List<_Entry> entries = [];
  bool loading = true;
  String? error;
  String keyword = '';
  String kind = '全部';
  _Space space = _Space.all;
  bool uploading = false;
  int used = 0;
  int quota = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final s = AppScope.read(context);
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final all = <_Entry>[];
      String? token;
      do {
        final p = await s.api.listFiles(pageToken: token);
        all.addAll(p.items.map(_Entry.new));
        token = p.hasMore ? p.pageToken : null;
      } while (token != null);
      final usage = await s.api.fileUsage();
      used = usage.used;
      quota = usage.quota;
      if (mounted) {
        setState(() {
          entries = all;
          loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  Future<void> _upload() async {
    final s = AppScope.read(context);
    setState(() => uploading = true);
    try {
      final f = await s.pickAndUpload();
      if (f == null) return;
      await s.api.addToDrive(f.fileKey);
      await _load();
      if (mounted) showToast(context, '已上传「${f.fileName}」');
    } catch (e) {
      if (mounted) showToast(context, '上传失败：${describeError(e)}', error: true);
    } finally {
      if (mounted) setState(() => uploading = false);
    }
  }

  List<_Entry> _filtered(AppState s) => entries.where((e) {
        if (space == _Space.mine && !e.data.inDrive) return false;
        if (space == _Space.shared && e.data.inDrive) return false;
        if (kind != '全部') {
          final k = FileTypeIcon.infoOf(e.file.fileName).$3;
          final mapped = const {'图片': '图片', '文档': '文档', 'PDF': 'PDF', '表格': '表格', '演示': '演示'}[k] ?? '其他';
          if (mapped != kind) return false;
        }
        if (keyword.isNotEmpty && !e.file.fileName.toLowerCase().contains(keyword.toLowerCase())) return false;
        return true;
      }).toList();

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 820;
      return Row(children: [
        if (wide) SizedBox(width: 220, child: _sidebar(s)),
        if (wide) const VerticalDivider(width: 1),
        Expanded(child: _main(context, s, wide, c.maxWidth)),
      ]);
    });
  }

  Widget _sidebar(AppState s) {
    final total = entries.fold<int>(0, (a, e) => a + e.file.size);
    final mine = used;
    return Container(
      color: Fs.bg,
      padding: const EdgeInsets.all(12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(6, 4, 6, 14),
          child: Text('云盘', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        ),
        SizedBox(
          height: 38,
          child: FilledButton.icon(
            onPressed: uploading ? null : _upload,
            icon: uploading
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.upload_rounded, size: 18),
            label: Text(uploading ? '上传中…' : '上传文件'),
          ),
        ),
        const SizedBox(height: 14),
        for (final sp in _Space.values)
          HoverBox(
            selected: space == sp,
            hoverColor: const Color(0xFFE8E9EB),
            onTap: () => setState(() => space = sp),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            margin: const EdgeInsets.only(bottom: 2),
            child: Row(children: [
              Icon(sp.icon, size: 18, color: space == sp ? Fs.primary : Fs.text2),
              const SizedBox(width: 10),
              Text(sp.label, style: TextStyle(fontSize: 14, color: space == sp ? Fs.primary : Fs.text1)),
            ]),
          ),
        const Spacer(),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(8)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('空间用量', style: TextStyle(fontSize: 12, color: Fs.text2)),
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: quota > 0 ? (mine / quota).clamp(0.0, 1.0) : 0,
                minHeight: 6,
                backgroundColor: Fs.lineLight,
              ),
            ),
            const SizedBox(height: 6),
            Text('我的空间 ${fmtSize(mine)} / ${quota > 0 ? fmtSize(quota) : '未设置配额'}', style: const TextStyle(fontSize: 11, color: Fs.text3)),
            Text('全部文件 ${entries.length} 个 · ${fmtSize(total)}', style: const TextStyle(fontSize: 11, color: Fs.text3)),
          ]),
        ),
      ]),
    );
  }

  Widget _main(BuildContext context, AppState s, bool wide, double width) {
    final list = _filtered(s);
    final showCols = width >= 900;
    return Container(
      color: Colors.white,
      child: Column(children: [
        Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Row(children: [
            Text(space.label, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text('${list.length}', style: const TextStyle(fontSize: 13, color: Fs.text3)),
            const Spacer(),
            SizedBox(
              width: wide ? 240 : 150,
              child: FsSearchField(hint: '搜索文件名', onChanged: (v) => setState(() => keyword = v.trim())),
            ),
            FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', onPressed: _load),
            if (!wide) IconButton(onPressed: uploading ? null : _upload, icon: const Icon(Icons.upload_rounded), tooltip: '上传'),
          ]),
        ),
        SizedBox(
          height: 36,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            children: [
              for (final k in _kinds)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: HoverBox(
                    selected: kind == k,
                    selectedColor: Fs.primaryLight,
                    radius: 14,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                    onTap: () => setState(() => kind = k),
                    child: Text(k, style: TextStyle(fontSize: 12, color: kind == k ? Fs.primary : Fs.text2)),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        if (showCols)
          Container(
            height: 36,
            padding: const EdgeInsets.symmetric(horizontal: 20),
            decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.line))),
            child: const Row(children: [
              Expanded(flex: 5, child: Text('名称', style: TextStyle(fontSize: 12, color: Fs.text3))),
              Expanded(flex: 3, child: Text('来源', style: TextStyle(fontSize: 12, color: Fs.text3))),
              Expanded(flex: 2, child: Text('上传者', style: TextStyle(fontSize: 12, color: Fs.text3))),
              Expanded(flex: 2, child: Text('上传时间', style: TextStyle(fontSize: 12, color: Fs.text3))),
              SizedBox(width: 90, child: Text('大小', style: TextStyle(fontSize: 12, color: Fs.text3))),
              SizedBox(width: 40),
            ]),
          ),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : error != null
                  ? EmptyState(
                      icon: Icons.cloud_off_outlined,
                      title: '加载失败',
                      subtitle: error,
                      action: OutlinedButton(onPressed: _load, child: const Text('重试')),
                    )
                  : list.isEmpty
                      ? EmptyState(
                          icon: Icons.cloud_upload_outlined,
                          title: entries.isEmpty ? '云盘里还没有文件' : '没有符合条件的文件',
                          subtitle: entries.isEmpty ? '上传文件，或在聊天里发送的文件都会出现在这里' : null,
                          action: entries.isEmpty
                              ? FilledButton.icon(
                                  onPressed: _upload,
                                  icon: const Icon(Icons.upload_rounded, size: 18),
                                  label: const Text('上传文件'),
                                )
                              : null,
                        )
                      : ListView.builder(
                          itemCount: list.length,
                          itemBuilder: (_, i) => _row(s, list[i], showCols),
                        ),
        ),
      ]),
    );
  }

  Widget _row(AppState s, _Entry e, bool showCols) {
    final source = e.data.inDrive ? '我的空间' : (s.chat(e.data.sourceChatId ?? '') == null ? (e.data.sourceType == 'table' ? '多维表格' : '来自会话') : s.chatTitle(s.chat(e.data.sourceChatId!)!));
    final uploader = s.userName(e.data.uploaderId);
    final time = e.data.createdAt != null ? fmtRelative(e.data.createdAt) : '-';
    return HoverReveal(
      builder: (context, hover) => HoverBox(
        radius: 0,
        onTap: () => downloadFile(context, e.file.fileKey),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
        child: Row(children: [
          Expanded(
            flex: 5,
            child: Row(children: [
              FileTypeIcon(e.file.fileName, size: 32),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(e.file.fileName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14)),
                  if (!showCols)
                    Text('$source · $uploader · $time · ${fmtSize(e.file.size)}',
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text3)),
                ]),
              ),
            ]),
          ),
          if (showCols) ...[
            Expanded(
              flex: 3,
              child: InkWell(
                onTap: e.data.inDrive ? null : () => e.data.sourceChatId == null ? null : s.openChat(e.data.sourceChatId!),
                child: Row(children: [
                  Icon(e.data.inDrive ? Icons.cloud_outlined : Icons.forum_outlined, size: 14, color: Fs.text3),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(source,
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, color: Fs.text2)),
                  ),
                ]),
              ),
            ),
            Expanded(
              flex: 2,
              child: Row(children: [
                FsAvatar(name: uploader, seed: e.data.uploaderId, size: 20, isBot: e.data.uploaderId == kBotId),
                const SizedBox(width: 6),
                Flexible(child: Text(uploader, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, color: Fs.text2))),
              ]),
            ),
            Expanded(flex: 2, child: Text(time, style: const TextStyle(fontSize: 13, color: Fs.text2))),
            SizedBox(width: 90, child: Text(fmtSize(e.file.size), style: const TextStyle(fontSize: 13, color: Fs.text2))),
          ],
          if (e.data.uploaderId == s.me.userId && e.data.inDrive)
            FsIconButton(icon: Icons.delete_outline_rounded, tooltip: '移出云盘', onPressed: () async {
              final ok = await confirmDialog(context, title: '移出云盘', content: '确定移除「${e.file.fileName}」？被会话或表格引用的文件仍会保留。', ok: '移除', danger: true);
              if (!ok || !context.mounted) return;
              try { await s.api.deleteFile(e.file.fileKey); if (mounted) await _load(); }
              catch (err) { if (context.mounted) showToast(context, describeError(err), error: true); }
            }),
          SizedBox(
            width: 40,
            child: Opacity(
              opacity: hover || !showCols ? 1 : 0,
              child: FsIconButton(
                icon: Icons.download_rounded,
                tooltip: '下载',
                onPressed: () => downloadFile(context, e.file.fileKey),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}
