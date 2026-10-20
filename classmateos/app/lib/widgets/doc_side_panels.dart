/// 文档右侧栏：评论（R-DC-02）与历史版本（R-DC-03）。
/// 宽屏嵌在编辑器右侧，窄屏放进底部抽屉；数据由编辑器持有（ValueNotifier），两处共用。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/phase2_docs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../services/line_diff.dart';
import '../theme.dart';
import 'common.dart';

/// 新评论草稿：选中的原文 + 锚点。
class CommentDraft {
  final String quote;
  final Map<String, dynamic> anchor;
  const CommentDraft(this.quote, this.anchor);
}

class DocCommentsController {
  final String docId;
  final CosApiClient api;
  final ValueNotifier<List<CosComment>> comments = ValueNotifier(const []);
  final ValueNotifier<CommentDraft?> draft = ValueNotifier(null);
  final ValueNotifier<String?> focused = ValueNotifier(null);
  final ValueNotifier<String?> error = ValueNotifier(null);
  bool loaded = false;

  DocCommentsController(this.docId, this.api);

  Future<void> reload() async {
    try {
      comments.value = await api.listComments(docId);
      error.value = null;
    } catch (e) {
      error.value = describeError(e);
    }
    loaded = true;
  }

  int get openCount => comments.value.where((c) => !c.solved).length;

  void dispose() {
    comments.dispose();
    draft.dispose();
    focused.dispose();
    error.dispose();
  }
}

/// 带 @ 的文本：高亮提及。
TextSpan richTextSpan(CosRichText t, {TextStyle? style}) {
  if (t.mentions.isEmpty) return TextSpan(text: t.text, style: style);
  final spans = <InlineSpan>[];
  var last = 0;
  final ms = [...t.mentions]..sort((a, b) => a.offset.compareTo(b.offset));
  for (final m in ms) {
    if (m.offset < last || m.offset + m.length > t.text.length) continue;
    if (m.offset > last) spans.add(TextSpan(text: t.text.substring(last, m.offset)));
    spans.add(TextSpan(text: t.text.substring(m.offset, m.offset + m.length), style: const TextStyle(color: Fs.primary)));
    last = m.offset + m.length;
  }
  if (last < t.text.length) spans.add(TextSpan(text: t.text.substring(last)));
  return TextSpan(children: spans, style: style);
}

/// 评论输入框：@ 按钮选人，⌘/Ctrl + Enter 发送。
class CommentInput extends StatefulWidget {
  final String hint;
  final String initial;
  final bool autofocus;
  final Future<bool> Function(CosRichText text) onSend;
  final VoidCallback? onCancel;
  const CommentInput({super.key, this.hint = '回复', this.initial = '', this.autofocus = false, required this.onSend, this.onCancel});
  @override
  State<CommentInput> createState() => _CommentInputState();
}

class _CommentInputState extends State<CommentInput> {
  late final ctl = TextEditingController(text: widget.initial);
  final focus = FocusNode();
  bool sending = false;

  @override
  void dispose() {
    ctl.dispose();
    focus.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final s = AppScope.read(context);
    final t = ctl.text.trim();
    if (t.isEmpty || sending) return;
    setState(() => sending = true);
    final ok = await widget.onSend(CosRichText.parse(t, s.users));
    if (!mounted) return;
    setState(() => sending = false);
    if (ok) ctl.clear();
  }

  Future<void> _mention() async {
    final s = AppScope.read(context);
    final ids = await pickUsers(context, users: s.users, title: '提及成员', multiple: false, exclude: {kBotId});
    if (ids == null || ids.isEmpty) return;
    final ins = '@${s.userName(ids.first)} ';
    final sel = ctl.selection;
    final pos = sel.isValid ? sel.start : ctl.text.length;
    ctl.value = TextEditingValue(
      text: ctl.text.replaceRange(pos, sel.isValid ? sel.end : pos, ins),
      selection: TextSelection.collapsed(offset: pos + ins.length),
    );
    focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.enter, meta: true): _send,
          const SingleActivator(LogicalKeyboardKey.enter, control: true): _send,
        },
        child: Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: focus.hasFocus ? Fs.primary : Fs.line),
          ),
          child: Column(children: [
            TextField(
              controller: ctl,
              focusNode: focus,
              autofocus: widget.autofocus,
              minLines: 1,
              maxLines: 6,
              style: const TextStyle(fontSize: 13),
              onChanged: (_) => setState(() {}),
              onTap: () => setState(() {}),
              decoration: InputDecoration(
                hintText: widget.hint,
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
              ),
            ),
            Row(children: [
              FsIconButton(icon: Icons.alternate_email_rounded, tooltip: '提及成员', size: 16, onPressed: _mention),
              const Spacer(),
              if (widget.onCancel != null)
                TextButton(
                  style: TextButton.styleFrom(minimumSize: const Size(40, 28), foregroundColor: Fs.text2),
                  onPressed: widget.onCancel,
                  child: const Text('取消', style: TextStyle(fontSize: 12)),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 6, 6),
                child: FilledButton(
                  style: FilledButton.styleFrom(minimumSize: const Size(52, 28), padding: const EdgeInsets.symmetric(horizontal: 10)),
                  onPressed: ctl.text.trim().isEmpty || sending ? null : _send,
                  child: Text(sending ? '发送中' : '发送', style: const TextStyle(fontSize: 12)),
                ),
              ),
            ]),
          ]),
        ),
      );
}

class DocCommentsPanel extends StatefulWidget {
  final DocCommentsController ctl;
  final bool canComment;

  /// 当前正文（判断「原文已删除」）。
  final String Function() markdown;
  final VoidCallback? onClose;
  final ValueChanged<String>? onQuoteTap;
  const DocCommentsPanel({super.key, required this.ctl, required this.canComment, required this.markdown, this.onClose, this.onQuoteTap});
  @override
  State<DocCommentsPanel> createState() => _DocCommentsPanelState();
}

class _DocCommentsPanelState extends State<DocCommentsPanel> {
  bool showSolved = false;
  String? replying;
  String? editing; // reply id

  DocCommentsController get c => widget.ctl;
  CosApiClient get api => c.api;

  Future<bool> _guard(Future<void> Function() f) async {
    try {
      await f();
      await c.reload();
      return true;
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return Container(
      color: const Color(0xFFFAFBFC),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          height: 48,
          padding: const EdgeInsets.only(left: 16, right: 6),
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
          child: ValueListenableBuilder(
            valueListenable: c.comments,
            builder: (_, list, _) => Row(children: [
              const Text('评论', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              const SizedBox(width: 12),
              for (final solved in [false, true])
                Padding(
                  padding: const EdgeInsets.only(right: 4),
                  child: HoverBox(
                    selected: showSolved == solved,
                    selectedColor: Fs.primaryLight,
                    radius: 12,
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    onTap: () => setState(() => showSolved = solved),
                    child: Text('${solved ? '已解决' : '未解决'} ${list.where((x) => x.solved == solved).length}',
                        style: TextStyle(fontSize: 12, color: showSolved == solved ? Fs.primary : Fs.text2)),
                  ),
                ),
              const Spacer(),
              if (widget.onClose != null) FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', size: 18, onPressed: widget.onClose),
            ]),
          ),
        ),
        Expanded(
          child: AnimatedBuilder(
            animation: Listenable.merge([c.comments, c.draft, c.focused, c.error]),
            builder: (context, _) {
              final md = widget.markdown();
              final list = c.comments.value.where((x) => x.solved == showSolved).toList()
                ..sort((a, b) {
                  // 划词评论按原文在正文里的位置，全文评论排在最后
                  int pos(CosComment x) => x.isWhole ? 1 << 30 : (x.quote == null ? -1 : md.indexOf(x.quote!)).clamp(-1, 1 << 29);
                  final p = pos(a).compareTo(pos(b));
                  return p != 0 ? p : (a.createdAt ?? DateTime(0)).compareTo(b.createdAt ?? DateTime(0));
                });
              final draft = c.draft.value;
              return ListView(padding: const EdgeInsets.all(12), children: [
                if (c.error.value != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text('评论加载失败：${c.error.value}', style: const TextStyle(color: Fs.red, fontSize: 12)),
                  ),
                if (draft != null && !showSolved) _draftCard(draft),
                if (list.isEmpty && draft == null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 40),
                    child: Column(children: [
                      const Icon(Icons.mode_comment_outlined, size: 36, color: Fs.textDisabled),
                      const SizedBox(height: 10),
                      Text(showSolved ? '没有已解决的评论' : '还没有评论', style: const TextStyle(color: Fs.text3, fontSize: 13)),
                      if (!showSolved && widget.canComment)
                        const Padding(
                          padding: EdgeInsets.only(top: 6),
                          child: Text('选中正文里的文字，右键选择「评论」', style: TextStyle(color: Fs.text3, fontSize: 12)),
                        ),
                    ]),
                  ),
                for (final x in list) _card(s, x, md),
              ]);
            },
          ),
        ),
        if (widget.canComment && !showSolved)
          Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            decoration: const BoxDecoration(border: Border(top: BorderSide(color: Fs.lineLight))),
            child: CommentInput(
              hint: '全文评论（⌘ + Enter 发送）',
              onSend: (t) => _guard(() => api.createComment(c.docId, t, whole: true)),
            ),
          ),
      ]),
    );
  }

  Widget _quote(String text, {bool deleted = false, VoidCallback? onTap}) => GestureDetector(
        onTap: onTap,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.only(left: 8),
          decoration: BoxDecoration(border: Border(left: BorderSide(color: deleted ? Fs.textDisabled : const Color(0xFFFFC60A), width: 3))),
          child: Text(
            deleted ? '原文已删除' : text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12, color: Fs.text3, fontStyle: deleted ? FontStyle.italic : null),
          ),
        ),
      );

  Widget _draftCard(CommentDraft d) => _box(
        highlighted: true,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _quote(d.quote),
          CommentInput(
            hint: '输入评论，@ 提及成员',
            autofocus: true,
            onCancel: () => c.draft.value = null,
            onSend: (t) async {
              final ok = await _guard(() => api.createComment(c.docId, t, quote: d.quote, anchor: d.anchor));
              if (ok) c.draft.value = null;
              return ok;
            },
          ),
        ]),
      );

  Widget _box({required Widget child, bool highlighted = false}) => Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: highlighted ? Fs.primary : Fs.lineLight),
          boxShadow: highlighted ? Fs.shadow : null,
        ),
        child: child,
      );

  Widget _card(AppState s, CosComment x, String md) {
    final deleted = !x.isWhole && (x.quoteDeleted || (x.quote != null && !md.contains(x.quote!)));
    return _box(
      highlighted: c.focused.value == x.commentId,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          if (x.isWhole)
            const Padding(padding: EdgeInsets.only(bottom: 8), child: FsTag('全文评论', color: TagColor.gray))
          else
            Expanded(
              child: _quote(x.quote ?? '', deleted: deleted, onTap: deleted || widget.onQuoteTap == null ? null : () => widget.onQuoteTap!(x.quote!)),
            ),
          if (x.isWhole) const Spacer(),
          if (widget.canComment)
            Tooltip(
              message: x.solved ? '重新打开' : '解决',
              child: InkWell(
                borderRadius: BorderRadius.circular(4),
                onTap: () => _guard(() => api.solveComment(c.docId, x.commentId, !x.solved)),
                child: Padding(
                  padding: const EdgeInsets.all(4),
                  child: Icon(x.solved ? Icons.replay_rounded : Icons.check_circle_outline_rounded,
                      size: 18, color: x.solved ? Fs.text3 : Fs.green),
                ),
              ),
            ),
        ]),
        for (final r in x.replies) _reply(s, x, r),
        if (widget.canComment && !x.solved)
          replying == x.commentId
              ? Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: CommentInput(
                    autofocus: true,
                    onCancel: () => setState(() => replying = null),
                    onSend: (t) async {
                      final ok = await _guard(() => api.replyComment(c.docId, x.commentId, t));
                      if (ok && mounted) setState(() => replying = null);
                      return ok;
                    },
                  ),
                )
              : Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    style: TextButton.styleFrom(minimumSize: const Size(0, 28), padding: const EdgeInsets.symmetric(horizontal: 6)),
                    onPressed: () => setState(() => replying = x.commentId),
                    child: const Text('回复', style: TextStyle(fontSize: 12)),
                  ),
                ),
      ]),
    );
  }

  Widget _reply(AppState s, CosComment x, CosCommentReply r) {
    final mine = r.userId == s.me.userId;
    if (editing == r.replyId) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: CommentInput(
          initial: r.content.text,
          autofocus: true,
          onCancel: () => setState(() => editing = null),
          onSend: (t) async {
            final ok = await _guard(() => api.editReply(c.docId, x.commentId, r.replyId, t));
            if (ok && mounted) setState(() => editing = null);
            return ok;
          },
        ),
      );
    }
    return HoverReveal(
      builder: (_, hover) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          FsAvatar(name: s.userName(r.userId), seed: r.userId, size: 24),
          const SizedBox(width: 8),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(s.userName(r.userId), style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600))),
                const SizedBox(width: 6),
                Text(r.createdAt == null ? '' : fmtRelative(r.createdAt!.toLocal()) + (r.updatedAt != null ? ' · 已编辑' : ''),
                    style: const TextStyle(fontSize: 11, color: Fs.text3)),
              ]),
              const SizedBox(height: 2),
              Text.rich(richTextSpan(r.content), style: const TextStyle(fontSize: 13, height: 1.5)),
            ]),
          ),
          if (mine && hover)
            PopupMenuButton<String>(
              tooltip: '更多',
              padding: EdgeInsets.zero,
              iconSize: 16,
              icon: const Icon(Icons.more_horiz_rounded, size: 16, color: Fs.text3),
              onSelected: (v) async {
                if (v == 'edit') {
                  setState(() => editing = r.replyId);
                } else {
                  final ok = await confirmDialog(context, title: '删除回复', content: '确定删除这条回复吗？', ok: '删除', danger: true);
                  if (ok) _guard(() => api.deleteReply(c.docId, x.commentId, r.replyId));
                }
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'edit', child: Text('编辑')),
                PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(color: Fs.red))),
              ],
            ),
        ]),
      ),
    );
  }
}

// ---------------- 历史版本 ----------------

class DocHistoryPanel extends StatefulWidget {
  final String docId;
  final String? selected;
  final ValueChanged<CosDocVersion> onSelect;
  final VoidCallback? onClose;
  const DocHistoryPanel({super.key, required this.docId, this.selected, required this.onSelect, this.onClose});
  @override
  State<DocHistoryPanel> createState() => DocHistoryPanelState();
}

class DocHistoryPanelState extends State<DocHistoryPanel> {
  List<CosDocVersion>? versions;
  String? error;

  @override
  void initState() {
    super.initState();
    reload();
  }

  Future<void> reload() async {
    try {
      final v = await AppScope.read(context).api.listVersions(widget.docId);
      if (mounted) {
        setState(() {
          versions = v;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final vs = versions;
    return Container(
      color: const Color(0xFFFAFBFC),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          height: 48,
          padding: const EdgeInsets.only(left: 16, right: 6),
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
          child: Row(children: [
            const Text('历史记录', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const Spacer(),
            FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', size: 18, onPressed: reload),
            if (widget.onClose != null) FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', size: 18, onPressed: widget.onClose),
          ]),
        ),
        Expanded(
          child: error != null
              ? EmptyState(icon: Icons.history_rounded, title: '历史记录加载失败', subtitle: error, action: OutlinedButton(onPressed: reload, child: const Text('重试')))
              : vs == null
                  ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                  : vs.isEmpty
                      ? const EmptyState(icon: Icons.history_rounded, title: '还没有历史版本', subtitle: '停止编辑 2 分钟或距上个版本 30 分钟后会自动保存一版')
                      : ListView.builder(
                          padding: const EdgeInsets.all(8),
                          itemCount: vs.length,
                          itemBuilder: (_, i) {
                            final v = vs[i];
                            final sel = v.versionId == widget.selected;
                            return HoverBox(
                              selected: sel,
                              selectedColor: Fs.primaryLight,
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                              onTap: () => widget.onSelect(v),
                              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Padding(
                                  padding: const EdgeInsets.only(top: 5),
                                  child: Icon(Icons.circle, size: 8, color: i == 0 ? Fs.primary : Fs.textDisabled),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                    Text(
                                      v.name ?? (v.createdAt == null ? '未命名版本' : fmtDateTime(v.createdAt!.toLocal())),
                                      style: TextStyle(fontSize: 13, fontWeight: v.name != null ? FontWeight.w600 : FontWeight.w500),
                                    ),
                                    const SizedBox(height: 3),
                                    Text.rich(TextSpan(children: [
                                      TextSpan(text: '${s.operatorName(v.createdBy, viaBot: v.viaBot)}  '),
                                      if (v.name != null && v.createdAt != null) TextSpan(text: '${fmtDateTime(v.createdAt!.toLocal())}  '),
                                      TextSpan(text: '+${v.added}', style: const TextStyle(color: Fs.green)),
                                      const TextSpan(text: ' '),
                                      TextSpan(text: '−${v.removed}', style: const TextStyle(color: Fs.red)),
                                    ]), style: const TextStyle(fontSize: 12, color: Fs.text3)),
                                  ]),
                                ),
                                if (i == 0) const FsTag('最新', color: TagColor.blue),
                              ]),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}

/// 版本内容预览：与当前版本对比（新增标绿、删除标红划线），或只看那一版。
class VersionPreview extends StatelessWidget {
  final String versionMarkdown;
  final String currentMarkdown;
  final bool showDiff;
  const VersionPreview({super.key, required this.versionMarkdown, required this.currentMarkdown, this.showDiff = true});

  @override
  Widget build(BuildContext context) {
    // 「从这一版到当前」：当前比这一版多的是新增，少的是删除
    final lines = showDiff ? diffLines(versionMarkdown, currentMarkdown) : [for (final l in versionMarkdown.split('\n')) DiffLine(DiffOp.same, l)];
    final stat = diffStat(lines);
    return SelectionArea(
      child: ListView(padding: const EdgeInsets.fromLTRB(32, 20, 32, 40), children: [
        if (showDiff)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text.rich(TextSpan(children: [
              const TextSpan(text: '与当前版本相比：'),
              TextSpan(text: '新增 ${stat.added} 字', style: const TextStyle(color: Color(0xFF237B19))),
              const TextSpan(text: '，'),
              TextSpan(text: '删除 ${stat.removed} 字', style: const TextStyle(color: Fs.red)),
            ]), style: const TextStyle(fontSize: 12, color: Fs.text3)),
          ),
        for (final l in lines)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
            color: switch (l.op) {
              DiffOp.added => const Color(0xFFE4F7E1),
              DiffOp.removed => const Color(0xFFFDE8E7),
              DiffOp.same => null,
            },
            child: Text.rich(
              TextSpan(children: [
                TextSpan(
                  text: switch (l.op) { DiffOp.added => '+ ', DiffOp.removed => '− ', DiffOp.same => '  ' },
                  style: const TextStyle(color: Fs.text3),
                ),
                TextSpan(
                  text: l.text.isEmpty ? ' ' : l.text,
                  style: TextStyle(
                    decoration: l.op == DiffOp.removed ? TextDecoration.lineThrough : null,
                    color: switch (l.op) { DiffOp.added => const Color(0xFF237B19), DiffOp.removed => Fs.red, DiffOp.same => Fs.text1 },
                  ),
                ),
              ]),
              style: const TextStyle(fontSize: 14, height: 1.7, fontFamilyFallback: ['PingFang SC', 'Menlo']),
            ),
          ),
      ]),
    );
  }
}
