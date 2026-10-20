/// 云文档编辑器（云文档与知识库共用，R-WK-03）：
/// Markdown 编辑 / 分屏 / 阅读、自动保存与冲突保护；分享与权限（R-DC-01）、评论（R-DC-02）、
/// 历史版本（R-DC-03）、插入图片和附件（R-DC-04）、在线协作者头像（R-DC-09）。
library;

import 'job_dialog.dart';
import '../api/phase2_jobs.dart';
import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/phase2_docs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../services/collab_presence.dart';
import '../theme.dart';
import 'agent_sidebar.dart';
import 'common.dart';
import 'cos_file_view.dart';
import 'doc_side_panels.dart';
import 'markdown_view.dart';
import 'share_panel.dart';

enum DocMode { edit, split, read }

enum _Side { none, comments, history }

/// 编辑器「更多」菜单里由外部（如知识库）追加的项。
class DocMenuItem {
  final String label;
  final IconData icon;
  final VoidCallback onTap;
  final bool danger;
  const DocMenuItem(this.label, this.icon, this.onTap, {this.danger = false});
}

class DocEditor extends StatefulWidget {
  final String docId;
  final bool showBack;
  final VoidCallback? onSaved;
  final VoidCallback? onDeleted;

  /// 顶栏标题位置的替代内容（知识库的面包屑）。
  final Widget? header;

  /// 知识库页面：权限继承空间，删除由目录树负责。
  final bool wikiPage;
  final List<DocMenuItem> extraMenu;

  /// 打开后直接定位的评论（通知跳转）。
  final String? focusCommentId;

  const DocEditor({
    super.key,
    required this.docId,
    this.showBack = false,
    this.onSaved,
    this.onDeleted,
    this.header,
    this.wikiPage = false,
    this.extraMenu = const [],
    this.focusCommentId,
  });
  @override
  State<DocEditor> createState() => _DocEditorState();
}

class _Upload {
  final String name;
  final Uint8List bytes;
  final bool image;
  _Upload(this.name, this.bytes, this.image);
}

class _DocEditorState extends State<DocEditor> {
  CosDoc? doc;
  String? error;
  bool forbidden = false;
  final title = TextEditingController();
  final body = TextEditingController();
  final bodyFocus = FocusNode();
  DocMode? mode;
  Timer? _debounce;
  bool dirty = false;
  bool saving = false;
  DateTime? savedAt;
  String? saveError;
  late final CosApiClient api;
  late final AppState app;
  StreamSubscription<CosEvent>? _eventSub;
  bool _subscribed = false;

  _Side side = _Side.none;
  late final DocCommentsController comments;

  // 历史版本预览
  CosDocVersion? previewVersion;
  String? previewMarkdown;
  bool previewDiff = true;
  final _historyKey = GlobalKey<DocHistoryPanelState>();

  // 上传
  final Map<String, _Upload> _uploads = {};
  int _uploadSeq = 0;

  // 在线协作者
  CollabPresence? _presence;
  List<PresencePeer> peers = const [];

  @override
  void initState() {
    super.initState();
    app = AppScope.read(context);
    api = app.api;
    comments = DocCommentsController(widget.docId, api);
    body.addListener(_cursorMoved);
    _eventSub = app.eventStream.listen(_onEvent);
    _load(first: true);
  }

  @override
  void dispose() {
    if (dirty && saveError == null) _save(silent: true);
    _debounce?.cancel();
    _eventSub?.cancel();
    if (_subscribed) app.unsubscribe('doc:${widget.docId}');
    _presence?.dispose();
    comments.dispose();
    title.dispose();
    body.dispose();
    bodyFocus.dispose();
    super.dispose();
  }

  bool get _commentsOn => app.feature('doc.comments');
  bool get _versionsOn => app.feature('doc.versions');
  bool get _permsOn => app.feature('doc.permissions');

  Future<void> _load({bool first = false}) async {
    try {
      final d = await api.getDoc(widget.docId);
      if (!mounted) return;
      setState(() {
        doc = d;
        title.text = d.title;
        body.text = d.markdown ?? '';
        error = null;
        forbidden = false;
      });
      if (first) _afterFirstLoad();
    } catch (e) {
      if (mounted) {
        setState(() {
          forbidden = e is CosApiException && e.statusCode == 403;
          error = describeError(e);
        });
      }
    }
  }

  void _afterFirstLoad() {
    if (_commentsOn) {
      app.subscribe('doc:${widget.docId}');
      _subscribed = true;
      comments.reload().then((_) {
        final f = widget.focusCommentId;
        if (f != null && mounted) {
          comments.focused.value = f;
          setState(() => side = _Side.comments);
        }
      });
    }
    if (app.feature('doc.presence')) {
      _presence = CollabPresence(
        api: api,
        docId: widget.docId,
        userId: app.me.userId,
        name: app.me.name,
        color: '#${(FsAvatar.colorFor(app.me.userId).toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}',
        onChanged: (p) {
          if (mounted) setState(() => peers = p);
        },
        // 查看权限被收回：重新载入，页面会显示无权限状态
        onRevoked: () {
          if (mounted) _load();
        },
      )..start();
    }
  }

  void _onEvent(CosEvent e) {
    if (e.str('doc_id') != widget.docId) return;
    if (e.eventType == 'doc.comment_changed') {
      comments.reload();
    } else if (e.eventType == 'doc.permission_changed') {
      final affected = e.userIds.isEmpty || e.userIds.contains(app.me.userId);
      if (!affected) return;
      final before = doc?.permsFor(app.me).canEdit;
      _load().then((_) {
        if (!mounted) return;
        if (doc != null && before != doc!.permsFor(app.me).canEdit) showToast(context, '你的权限已变更');
      });
    }
  }

  int? _lastLine;
  void _cursorMoved() {
    final p = _presence;
    if (p == null) return;
    final sel = body.selection;
    final line = sel.isValid ? '\n'.allMatches(body.text.substring(0, sel.start.clamp(0, body.text.length))).length + 1 : null;
    if (line != _lastLine) {
      _lastLine = line;
      p.setCursorLine(line);
    }
  }

  void _changed() {
    setState(() {
      dirty = true;
      saveError = null;
    });
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 1200), _save);
  }

  Future<void> _save({bool silent = false}) async {
    if (!dirty || doc == null || saving) return;
    final t = title.text.trim().isEmpty ? '未命名文档' : title.text.trim();
    saving = true;
    final snapshot = body.text;
    if (!silent && mounted) setState(() {});
    try {
      doc = await api.updateDoc(widget.docId, title: t, markdown: snapshot, baseUpdatedAt: doc!.updatedAtRaw);
      if (!mounted) return;
      dirty = body.text != snapshot || (title.text.trim().isEmpty ? '未命名文档' : title.text.trim()) != t;
      savedAt = DateTime.now();
      widget.onSaved?.call();
    } catch (e) {
      saveError = e is CosApiException && e.code == 'DOC_CONFLICT'
          ? '别人刚修改了这篇文档，请在「更多」里重新载入后再编辑'
          : e is CosApiException && e.statusCode == 403
              ? '你已没有编辑权限，修改没有保存'
              : describeError(e);
    } finally {
      saving = false;
      if (!silent && mounted) setState(() {});
      if (mounted && dirty && saveError == null) {
        _debounce?.cancel();
        _debounce = Timer(const Duration(milliseconds: 1200), _save);
      }
    }
  }

  // ---------------- 格式工具栏 ----------------

  void _prefix(String p) {
    final sel = body.selection;
    final text = body.text;
    final pos = sel.isValid ? sel.start : text.length;
    final lineStart = pos == 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
    final rest = text.substring(lineStart);
    final m = RegExp(r'^(#{1,6} |- \[ \] |- |\d+\. |> )').firstMatch(rest);
    final removeLen = m?.group(0)?.length ?? 0;
    final newText = text.replaceRange(lineStart, lineStart + removeLen, m?.group(0) == p ? '' : p);
    final delta = (m?.group(0) == p ? 0 : p.length) - removeLen;
    body.value = TextEditingValue(text: newText, selection: TextSelection.collapsed(offset: (pos + delta).clamp(0, newText.length)));
    bodyFocus.requestFocus();
    _changed();
  }

  void _wrap(String l, [String? r]) {
    r ??= l;
    final sel = body.selection;
    final text = body.text;
    final s = sel.isValid ? sel.start : text.length;
    final e = sel.isValid ? sel.end : text.length;
    final inner = s == e ? '文本' : text.substring(s, e);
    final newText = text.replaceRange(s, e, '$l$inner$r');
    body.value = TextEditingValue(
      text: newText,
      selection: TextSelection(baseOffset: s + l.length, extentOffset: s + l.length + inner.length),
    );
    bodyFocus.requestFocus();
    _changed();
  }

  void _block(String b) {
    final sel = body.selection;
    final text = body.text;
    final pos = sel.isValid ? sel.end : text.length;
    final before = pos > 0 && text[pos - 1] != '\n' ? '\n' : '';
    final ins = '$before$b\n';
    final newText = text.replaceRange(pos, pos, ins);
    body.value = TextEditingValue(text: newText, selection: TextSelection.collapsed(offset: pos + ins.length));
    bodyFocus.requestFocus();
    _changed();
  }

  // ---------------- 插入图片 / 附件（R-DC-04） ----------------

  static const _imageLimit = 20 * 1024 * 1024;

  Future<void> _pickAndInsert({required bool image}) async {
    final f = await FilePicker.pickFile(type: image ? FileType.image : FileType.any);
    if (f == null || !mounted) return;
    final bytes = await f.readAsBytes();
    if (image && bytes.length > _imageLimit) {
      if (mounted) showToast(context, '图片不能超过 20 MB', error: true);
      return;
    }
    insertUpload(f.name, bytes, image: image || _isImageName(f.name));
  }

  static bool _isImageName(String n) => RegExp(r'\.(png|jpe?g|gif|webp|bmp|heic)$', caseSensitive: false).hasMatch(n);

  /// 在光标处插入占位并上传（粘贴 / 拖入接入后也走这里）。
  void insertUpload(String name, Uint8List bytes, {required bool image}) {
    final id = 'u${DateTime.now().millisecondsSinceEpoch}_${_uploadSeq++}';
    _uploads[id] = _Upload(name, bytes, image);
    _block('![上传中…](uploading://$id)');
    _runUpload(id);
  }

  Future<void> _runUpload(String id) async {
    final u = _uploads[id];
    if (u == null) return;
    try {
      final ref = await api.uploadBytes(u.name, u.bytes, ref: {'type': 'doc', 'id': widget.docId});
      final md = u.image
          ? '![${u.name}](${cosFileUrl(ref.fileKey)})'
          : '[📎 ${u.name}](${cosFileUrl(ref.fileKey, name: u.name, size: u.bytes.length)})';
      _uploads.remove(id);
      _replacePlaceholder(id, md);
    } catch (e) {
      _replacePlaceholder(id, '![上传失败](upload-failed://$id)');
      if (mounted) showToast(context, '「${u.name}」上传失败：${describeError(e)}', error: true);
    }
  }

  void _replacePlaceholder(String id, String md) {
    if (!mounted) return;
    final re = RegExp(r'!\[[^\]]*\]\((uploading|upload-failed)://' + RegExp.escape(id) + r'\)');
    final text = body.text;
    final m = re.firstMatch(text);
    if (m == null) return; // 占位被用户删掉了
    final sel = body.selection;
    final delta = md.length - (m.end - m.start);
    int fix(int o) => o >= m.end ? o + delta : o;
    body.value = TextEditingValue(
      text: text.replaceRange(m.start, m.end, md),
      selection: sel.isValid ? TextSelection(baseOffset: fix(sel.baseOffset), extentOffset: fix(sel.extentOffset)) : sel,
    );
    _changed();
  }

  void _retryUpload(String id) {
    if (!_uploads.containsKey(id)) {
      showToast(context, '原文件已不在内存里，请重新插入', error: true);
      return;
    }
    _replacePlaceholder(id, '![上传中…](uploading://$id)');
    _runUpload(id);
  }

  // ---------------- 评论 ----------------

  void _startComment(String quote, {int? offset}) {
    final q = quote.trim();
    if (q.isEmpty) return;
    final off = offset ?? body.text.indexOf(q);
    comments.draft.value = CommentDraft(q, {if (off >= 0) 'offset': off, if (off >= 0) 'length': q.length});
    _openSide(_Side.comments);
  }

  void _focusQuote(String quote) {
    final c = comments.comments.value.where((c) => c.quote == quote && !c.solved).firstOrNull;
    if (c != null) comments.focused.value = c.commentId;
    _openSide(_Side.comments);
  }

  void _openSide(_Side s) {
    final wide = MediaQuery.sizeOf(context).width >= 1100;
    if (s == _Side.history) _exitPreview();
    if (wide) {
      setState(() => side = s);
      return;
    }
    // 窄屏：底部抽屉
    setState(() => side = _Side.none);
    final st = AppScope.read(context);
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (ctx) => AppScope(
        state: st,
        child: SizedBox(
          height: MediaQuery.sizeOf(ctx).height * 0.75,
          child: s == _Side.comments
              ? DocCommentsPanel(
                  ctl: comments,
                  canComment: doc!.permsFor(app.me).canComment,
                  markdown: () => body.text,
                  onClose: () => Navigator.pop(ctx),
                )
              : DocHistoryPanel(
                  docId: widget.docId,
                  selected: previewVersion?.versionId,
                  onSelect: (v) {
                    Navigator.pop(ctx);
                    _preview(v);
                  },
                  onClose: () => Navigator.pop(ctx),
                ),
        ),
      ),
    );
  }

  // ---------------- 历史版本 ----------------

  Future<void> _preview(CosDocVersion v) async {
    setState(() {
      previewVersion = v;
      previewMarkdown = null;
    });
    try {
      final md = await api.versionMarkdown(widget.docId, v.versionId);
      if (mounted && previewVersion?.versionId == v.versionId) setState(() => previewMarkdown = md);
    } catch (e) {
      if (mounted) {
        showToast(context, describeError(e), error: true);
        _exitPreview();
      }
    }
  }

  void _exitPreview() => setState(() {
        previewVersion = null;
        previewMarkdown = null;
      });

  Future<void> _restore(CosDocVersion v) async {
    final ok = await confirmDialog(context,
        title: '还原此版本',
        content: '正文会被替换成这个版本的内容，还原本身也会存成一个新版本，可以随时再还原回来。${dirty ? '\n\n你还有未保存的修改，会被覆盖。' : ''}',
        ok: '还原');
    if (!ok || !mounted) return;
    try {
      _debounce?.cancel();
      dirty = false;
      await api.restoreVersion(widget.docId, v.versionId);
      if (!mounted) return;
      _exitPreview();
      await _load();
      _historyKey.currentState?.reload();
      if (mounted) showToast(context, '已还原到该版本');
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _renameVersion(CosDocVersion v) async {
    final ctl = TextEditingController(text: v.name ?? '');
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('命名版本'),
        content: TextField(
          controller: ctl,
          autofocus: true,
          maxLength: 40,
          decoration: const InputDecoration(hintText: '如「组会前定稿」'),
          onSubmitted: (t) => Navigator.pop(ctx, t),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text), child: const Text('保存')),
        ],
      ),
    );
    ctl.dispose();
    if (name == null) return;
    try {
      await api.renameVersion(widget.docId, v.versionId, name.trim());
      _historyKey.currentState?.reload();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  // ---------------- 权限申请 ----------------

  Future<void> _requestAccess({String role = 'editor'}) async {
    var r = role;
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setS) => AlertDialog(
          title: const Text('申请权限'),
          content: SizedBox(
            width: 380,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('申请会发给文档所有者，同意后你就能使用对应权限。', style: TextStyle(fontSize: 13, color: Fs.text2)),
              const SizedBox(height: 14),
              SegmentedButton<String>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(value: 'viewer', label: Text('可阅读')),
                  ButtonSegment(value: 'commenter', label: Text('可评论')),
                  ButtonSegment(value: 'editor', label: Text('可编辑')),
                ],
                selected: {r},
                onSelectionChanged: (v) => setS(() => r = v.first),
              ),
              const SizedBox(height: 12),
              TextField(controller: note, maxLines: 3, decoration: const InputDecoration(hintText: '备注（选填），如：需要补充实验数据')),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('发送申请')),
          ],
        ),
      ),
    );
    final text = note.text.trim();
    note.dispose();
    if (ok != true) return;
    try {
      await api.requestDocAccess(widget.docId, role: r, note: text);
      if (mounted) showToast(context, '申请已发送，所有者同意后会通知你');
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  // ---------------- 构建 ----------------

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    if (error != null) {
      return Column(children: [
        if (widget.showBack || widget.header != null)
          Container(
            height: 52,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            alignment: Alignment.centerLeft,
            child: Row(children: [
              if (widget.showBack)
                IconButton(icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18), onPressed: () => Navigator.of(context).maybePop()),
              if (widget.header != null) Expanded(child: widget.header!),
            ]),
          ),
        Expanded(
          child: forbidden
              ? EmptyState(
                  icon: Icons.lock_outline_rounded,
                  title: '没有权限访问',
                  subtitle: widget.wikiPage ? '请联系知识空间管理员把你加为成员' : '向文档所有者申请权限后再查看',
                  action: !widget.wikiPage && _permsOn
                      ? FilledButton(onPressed: () => _requestAccess(role: 'viewer'), child: const Text('申请权限'))
                      : null,
                )
              : EmptyState(
                  icon: Icons.error_outline_rounded,
                  title: '文档打开失败',
                  subtitle: error,
                  action: OutlinedButton(onPressed: _load, child: const Text('重试')),
                ),
        ),
      ]);
    }
    final d = doc;
    if (d == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    final perms = d.permsFor(s.me);
    final canEdit = perms.canEdit;
    return LayoutBuilder(builder: (context, c) {
      final showSide = side != _Side.none && c.maxWidth >= 860;
      final contentWidth = c.maxWidth - (showSide ? 340 : 0);
      final wide = contentWidth >= 900;
      var m = mode ?? (canEdit ? (wide ? DocMode.split : DocMode.edit) : DocMode.read);
      if (!canEdit) m = DocMode.read;
      if (m == DocMode.split && !wide) m = DocMode.edit;
      final previewing = previewVersion != null;
      return Container(
        color: Colors.white,
        child: Column(children: [
          _topBar(context, s, d, perms, wide, m),
          if (previewing)
            _previewBanner(perms)
          else ...[
            if (canEdit && m != DocMode.read) _formatBar(perms),
            if (!canEdit) _readonlyBanner(s, d, perms),
          ],
          Expanded(
            child: Row(children: [
              Expanded(
                child: previewing
                    ? (previewMarkdown == null
                        ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                        : VersionPreview(versionMarkdown: previewMarkdown!, currentMarkdown: body.text, showDiff: previewDiff))
                    : switch (m) {
                        DocMode.read => _reader(s, d, perms),
                        DocMode.edit => _editor(s, d, perms),
                        DocMode.split => Row(children: [
                            Expanded(child: _editor(s, d, perms, compact: true)),
                            const VerticalDivider(width: 1),
                            Expanded(child: Container(color: const Color(0xFFFAFBFC), child: _reader(s, d, perms, compact: true))),
                          ]),
                      },
              ),
              if (showSide) ...[
                const VerticalDivider(width: 1),
                SizedBox(
                  width: 340,
                  child: side == _Side.comments
                      ? DocCommentsPanel(
                          ctl: comments,
                          canComment: perms.canComment,
                          markdown: () => body.text,
                          onClose: () => setState(() => side = _Side.none),
                          onQuoteTap: (q) {
                            final i = body.text.indexOf(q);
                            if (i >= 0 && m != DocMode.read) {
                              body.selection = TextSelection(baseOffset: i, extentOffset: i + q.length);
                              bodyFocus.requestFocus();
                            }
                          },
                        )
                      : DocHistoryPanel(
                          key: _historyKey,
                          docId: widget.docId,
                          selected: previewVersion?.versionId,
                          onSelect: _preview,
                          onClose: () {
                            _exitPreview();
                            setState(() => side = _Side.none);
                          },
                        ),
                ),
              ],
            ]),
          ),
        ]),
      );
    });
  }

  Widget _readonlyBanner(AppState s, CosDoc d, CosPermissions perms) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        color: const Color(0xFFFFF7E8),
        child: Row(children: [
          const Icon(Icons.visibility_outlined, size: 16, color: Fs.orange),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              widget.wikiPage
                  ? '你在这个知识空间只能阅读'
                  : _permsOn
                      ? (perms.canComment ? '你可以阅读和评论这篇文档' : '你只能阅读这篇文档')
                      : '你可以阅读这篇文档；只有创建者 ${s.userName(d.createdBy)} 可以编辑',
              style: const TextStyle(fontSize: 13, color: Color(0xFF8F5B00)),
            ),
          ),
          if (_permsOn && !widget.wikiPage)
            TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(0, 30)),
              onPressed: _requestAccess,
              child: const Text('申请编辑权限'),
            ),
        ]),
      );

  Widget _previewBanner(CosPermissions perms) {
    final v = previewVersion!;
    return Container(
      height: 44,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      color: Fs.primaryBg,
      child: Row(children: [
        const Icon(Icons.history_rounded, size: 18, color: Fs.primary),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            '正在查看 ${v.name ?? (v.createdAt == null ? '' : fmtDateTime(v.createdAt!.toLocal()))} 的版本',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13),
          ),
        ),
        const Text('对比当前', style: TextStyle(fontSize: 12, color: Fs.text2)),
        Transform.scale(
          scale: 0.75,
          child: Switch(value: previewDiff, onChanged: (v) => setState(() => previewDiff = v)),
        ),
        TextButton(onPressed: () => _renameVersion(v), child: const Text('命名')),
        if (perms.canEdit) FilledButton(onPressed: () => _restore(v), child: const Text('还原此版本')),
        const SizedBox(width: 6),
        OutlinedButton(onPressed: _exitPreview, child: const Text('退出')),
      ]),
    );
  }

  Widget _presenceAvatars(AppState s) {
    if (peers.isEmpty) return const SizedBox.shrink();
    final shown = peers.take(5).toList();
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        for (final p in shown)
          Tooltip(
            message: '${s.userName(p.userId)}${p.line != null ? ' 正在编辑第 ${p.line} 行' : ' 正在查看'}',
            child: Padding(
              padding: const EdgeInsets.only(left: 2),
              child: Container(
                decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 2)),
                child: FsAvatar(name: s.userName(p.userId), seed: p.userId, size: 26),
              ),
            ),
          ),
        if (peers.length > 5)
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: Text('+${peers.length - 5}', style: const TextStyle(fontSize: 12, color: Fs.text2)),
          ),
      ]),
    );
  }

  Widget _topBar(BuildContext context, AppState s, CosDoc d, CosPermissions perms, bool wide, DocMode m) {
    final canEdit = perms.canEdit;
    final status = saveError != null
        ? '保存失败'
        : saving
            ? '保存中…'
            : dirty
                ? '编辑中'
                : savedAt != null
                    ? '已保存 ${fmtHm(savedAt!)}'
                    : '已同步到云端';
    return Container(
      height: 52,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
      child: Row(children: [
        if (widget.showBack)
          IconButton(icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18), onPressed: () => Navigator.of(context).maybePop()),
        if (widget.header != null)
          Flexible(child: widget.header!)
        else ...[
          const DocIcon(size: 24),
          const SizedBox(width: 10),
          Flexible(
            child: ValueListenableBuilder(
              valueListenable: title,
              builder: (_, v, _) => Text(v.text.isEmpty ? '未命名文档' : v.text,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
            ),
          ),
        ],
        const SizedBox(width: 10),
        if (canEdit && wide)
          Tooltip(
            message: saveError ?? '',
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(
                saveError != null ? Icons.error_outline_rounded : (dirty || saving ? Icons.sync_rounded : Icons.cloud_done_outlined),
                size: 14,
                color: saveError != null ? Fs.red : Fs.text3,
              ),
              const SizedBox(width: 4),
              Text(status, style: TextStyle(fontSize: 12, color: saveError != null ? Fs.red : Fs.text3)),
            ]),
          ),
        const Spacer(),
        _presenceAvatars(s),
        if (canEdit && previewVersion == null)
          SegmentedButton<DocMode>(
            showSelectedIcon: false,
            style: SegmentedButton.styleFrom(
              visualDensity: VisualDensity.compact,
              textStyle: const TextStyle(fontSize: 12),
              selectedBackgroundColor: Fs.primaryLight,
              selectedForegroundColor: Fs.primary,
              side: const BorderSide(color: Fs.line),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Fs.radius)),
            ),
            segments: [
              ButtonSegment(value: DocMode.edit, icon: const Icon(Icons.edit_outlined, size: 15), label: wide ? const Text('编辑') : null),
              if (wide) const ButtonSegment(value: DocMode.split, icon: Icon(Icons.vertical_split_outlined, size: 15), label: Text('分屏')),
              ButtonSegment(value: DocMode.read, icon: const Icon(Icons.chrome_reader_mode_outlined, size: 15), label: wide ? const Text('阅读') : null),
            ],
            selected: {m},
            onSelectionChanged: (v) => setState(() => mode = v.first),
          ),
        if (_commentsOn)
          ValueListenableBuilder(
            valueListenable: comments.comments,
            builder: (_, list, _) {
              final n = list.where((c) => !c.solved).length;
              return Padding(
                padding: const EdgeInsets.only(left: 4),
                child: Badge(
                  isLabelVisible: n > 0,
                  label: Text('$n', style: const TextStyle(fontSize: 10)),
                  backgroundColor: Fs.primary,
                  offset: const Offset(-2, 2),
                  child: FsIconButton(
                    icon: side == _Side.comments ? Icons.mode_comment_rounded : Icons.mode_comment_outlined,
                    tooltip: '评论',
                    color: side == _Side.comments ? Fs.primary : null,
                    onPressed: () => side == _Side.comments ? setState(() => side = _Side.none) : _openSide(_Side.comments),
                  ),
                ),
              );
            },
          ),
        if (_versionsOn)
          FsIconButton(
            icon: Icons.history_rounded,
            tooltip: '历史记录',
            color: side == _Side.history ? Fs.primary : null,
            onPressed: () {
              if (side == _Side.history) {
                _exitPreview();
                setState(() => side = _Side.none);
              } else {
                _openSide(_Side.history);
              }
            },
          ),
        AgentSidebarButton(contextOf: () {
          final sel = body.selection;
          final picked = sel.isValid && !sel.isCollapsed ? sel.textInside(body.text) : null;
          return AgentContext(kind: widget.wikiPage ? 'wiki' : 'doc', id: d.docId, title: title.text.trim().isEmpty ? d.title : title.text.trim(), selection: picked);
        }),
        if (_permsOn) ...[
          const SizedBox(width: 6),
          FilledButton.icon(
            style: FilledButton.styleFrom(minimumSize: const Size(0, 32), padding: const EdgeInsets.symmetric(horizontal: 12)),
            onPressed: () => widget.wikiPage
                ? showSharePanel(
                    context,
                    ShareConfig(
                      title: '分享「${d.title}」',
                      load: () => api.docPermissions(d.docId),
                      save: (x) => api.saveDocPermissions(d.docId, x),
                      roles: kDocRoles,
                      linkOptions: kDocLinkOptions,
                      link: docLink(api, d.docId),
                      canManage: perms.canManage,
                    ),
                  )
                : showDocShare(context, d, canManage: perms.canManage),
            icon: const Icon(Icons.lock_open_rounded, size: 16),
            label: const Text('分享'),
          ),
        ],
        const SizedBox(width: 2),
        _moreMenu(context, s, d, perms),
      ]),
    );
  }

  Widget _moreMenu(BuildContext context, AppState s, CosDoc d, CosPermissions perms) {
    PopupMenuItem<String> item(String v, IconData i, String t, {bool danger = false}) => PopupMenuItem(
          value: v,
          child: Row(children: [
            Icon(i, size: 18, color: danger ? Fs.red : null),
            const SizedBox(width: 10),
            Text(t, style: danger ? const TextStyle(color: Fs.red) : null),
          ]),
        );
    final starOn = app.feature('doc.folders') && !widget.wikiPage;
    final canDelete = !widget.wikiPage && (d.permissions != null ? perms.canDelete : (d.createdBy == s.me.userId || s.me.isAdmin));
    return PopupMenuButton<String>(
      tooltip: '更多',
      icon: const Icon(Icons.more_horiz_rounded, size: 20),
      onSelected: (v) async {
        if (v.startsWith('x:')) {
          widget.extraMenu[int.parse(v.substring(2))].onTap();
        } else if (v == 'copy') {
          await Clipboard.setData(ClipboardData(text: body.text));
          if (context.mounted) showToast(context, '已复制 Markdown 全文');
        } else if (v == 'star') {
          try {
            await api.starDoc(d.docId, !d.starred);
            await _load();
            if (context.mounted) showToast(context, d.starred ? '已取消收藏' : '已收藏');
            widget.onSaved?.call();
          } catch (e) {
            if (context.mounted) showToast(context, describeError(e), error: true);
          }
        } else if (v.startsWith('dl:')) {
          final fmt = v.substring(3);
          final base = (title.text.trim().isEmpty ? '未命名文档' : title.text.trim()).replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
          if (fmt == 'md') {
            // Markdown 前端直接生成，不走后端
            await saveTextLocally(context, '$base.md', '# ${title.text.trim()}\n\n${body.text}', mime: 'text/markdown');
          } else {
            if (dirty) await _save(silent: true);
            if (!context.mounted) return;
            if (dirty || saveError != null) {
              showToast(context, '请先保存成功再导出，避免下载旧版本', error: true);
              return;
            }
            await runJobDialog(context, title: '导出为 ${fmt == 'pdf' ? 'PDF' : 'Word'}', start: () => api.startDocExport(d.docId, fmt));
          }
        } else if (v == 'history') {
          _openSide(_Side.history);
        } else if (v == 'reload') {
          if (dirty) {
            final ok = await confirmDialog(context, title: '重新载入', content: '未保存的草稿会被替换。请先复制 Markdown 备份，确定继续吗？', ok: '重新载入');
            if (!ok || !mounted) return;
          }
          _debounce?.cancel();
          dirty = false;
          saveError = null;
          _load();
        } else if (v == 'delete') {
          final ok = await confirmDialog(context,
              title: '删除文档',
              content: app.feature('doc.folders') ? '「${d.title}」会移到回收站，30 天内可以恢复。' : '确定删除「${d.title}」吗？删除后无法恢复。',
              ok: '删除',
              danger: true);
          if (!ok || !context.mounted) return;
          try {
            _debounce?.cancel();
            dirty = false;
            await api.deleteDoc(widget.docId);
            if (context.mounted) showToast(context, app.feature('doc.folders') ? '已移到回收站' : '文档已删除');
            widget.onDeleted?.call();
          } catch (e) {
            if (context.mounted) showToast(context, describeError(e), error: true);
          }
        }
      },
      itemBuilder: (_) => [
        for (var i = 0; i < widget.extraMenu.length; i++)
          item('x:$i', widget.extraMenu[i].icon, widget.extraMenu[i].label, danger: widget.extraMenu[i].danger),
        if (starOn) item('star', d.starred ? Icons.star_rounded : Icons.star_outline_rounded, d.starred ? '取消收藏' : '收藏'),
        if (_versionsOn) item('history', Icons.history_rounded, '历史记录'),
        item('copy', Icons.copy_rounded, '复制 Markdown'),
        if (app.feature('doc.export')) ...[
          const PopupMenuDivider(),
          item('dl:md', Icons.download_rounded, '下载为 Markdown'),
          item('dl:pdf', Icons.picture_as_pdf_outlined, '下载为 PDF'),
          item('dl:docx', Icons.article_outlined, '下载为 Word'),
        ] else
          item('dl:md', Icons.download_rounded, '下载为 Markdown'),
        item('reload', Icons.refresh_rounded, '重新载入'),
        if (canDelete) ...[
          const PopupMenuDivider(),
          item('delete', Icons.delete_outline_rounded, '删除文档', danger: true),
        ],
      ],
    );
  }

  Widget _formatBar(CosPermissions perms) {
    Widget b(IconData icon, String tip, VoidCallback f) => FsIconButton(icon: icon, tooltip: tip, onPressed: f, size: 18);
    Widget sep() => Container(width: 1, height: 16, margin: const EdgeInsets.symmetric(horizontal: 6), color: Fs.line);
    Widget h(String label, String p) => Tooltip(
          message: '标题 ${label.substring(1)}',
          child: HoverBox(
            onTap: () => _prefix(p),
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
            child: Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Fs.text2)),
          ),
        );
    return Container(
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: [
          h('H1', '# '),
          h('H2', '## '),
          h('H3', '### '),
          sep(),
          b(Icons.format_bold_rounded, '加粗', () => _wrap('**')),
          b(Icons.format_italic_rounded, '斜体', () => _wrap('*')),
          b(Icons.strikethrough_s_rounded, '删除线', () => _wrap('~~')),
          b(Icons.code_rounded, '行内代码', () => _wrap('`')),
          b(Icons.link_rounded, '链接', () => _wrap('[', '](https://)')),
          sep(),
          b(Icons.format_list_bulleted_rounded, '无序列表', () => _prefix('- ')),
          b(Icons.format_list_numbered_rounded, '有序列表', () => _prefix('1. ')),
          b(Icons.check_box_outlined, '待办', () => _prefix('- [ ] ')),
          b(Icons.format_quote_rounded, '引用', () => _prefix('> ')),
          sep(),
          b(Icons.image_outlined, '插入图片（最大 20 MB）', () => _pickAndInsert(image: true)),
          b(Icons.attach_file_rounded, '插入附件', () => _pickAndInsert(image: false)),
          b(Icons.data_object_rounded, '代码块', () => _block('```\n\n```')),
          b(Icons.table_chart_outlined, '表格', () => _block('| 列 1 | 列 2 | 列 3 |\n|---|---|---|\n|  |  |  |')),
          b(Icons.horizontal_rule_rounded, '分割线', () => _block('---')),
          if (_commentsOn && perms.canComment) ...[
            sep(),
            b(Icons.add_comment_outlined, '评论选中的文字', () {
              final sel = body.selection;
              if (!sel.isValid || sel.isCollapsed) {
                showToast(context, '先选中要评论的文字');
                return;
              }
              _startComment(body.text.substring(sel.start, sel.end), offset: sel.start);
            }),
          ],
        ]),
      ),
    );
  }

  Widget _meta(AppState s, CosDoc d) => Row(children: [
        FsAvatar(name: s.userName(d.owner), seed: d.owner, size: 20),
        const SizedBox(width: 6),
        Text(s.userName(d.owner), style: const TextStyle(fontSize: 12, color: Fs.text2)),
        const SizedBox(width: 10),
        Flexible(
          child: Text(
            d.updatedAt != null ? '最近修改 ${fmtDateTime((savedAt ?? d.updatedAt!).toLocal())}' : '',
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12, color: Fs.text3),
          ),
        ),
        if (d.myRole != null) ...[
          const SizedBox(width: 10),
          FsTag(d.owner == s.me.userId ? '所有者' : (kRoleLabels[d.myRole!] ?? d.myRole!), color: TagColor.gray),
        ],
      ]);

  Widget _editor(AppState s, CosDoc d, CosPermissions perms, {bool compact = false}) => SingleChildScrollView(
        padding: EdgeInsets.symmetric(horizontal: compact ? 32 : 24, vertical: 28),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 820),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              TextField(
                controller: title,
                onChanged: (_) => _changed(),
                style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w700, height: 1.3),
                maxLines: null,
                decoration: const InputDecoration(
                  hintText: '请输入标题',
                  hintStyle: TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: Fs.textDisabled),
                  filled: false,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  contentPadding: EdgeInsets.zero,
                ),
              ),
              const SizedBox(height: 10),
              _meta(s, d),
              const SizedBox(height: 20),
              TextField(
                controller: body,
                focusNode: bodyFocus,
                onChanged: (_) => _changed(),
                maxLines: null,
                minLines: 20,
                keyboardType: TextInputType.multiline,
                style: const TextStyle(fontSize: 15, height: 1.75, fontFamilyFallback: ['PingFang SC', 'Menlo']),
                contextMenuBuilder: (ctx, state) {
                  final sel = state.textEditingValue.selection;
                  final canC = _commentsOn && perms.canComment && sel.isValid && !sel.isCollapsed;
                  return AdaptiveTextSelectionToolbar.buttonItems(
                    anchors: state.contextMenuAnchors,
                    buttonItems: [
                      ...state.contextMenuButtonItems,
                      if (canC)
                        ContextMenuButtonItem(
                          label: '评论',
                          onPressed: () {
                            ContextMenuController.removeAny();
                            _startComment(state.textEditingValue.text.substring(sel.start, sel.end), offset: sel.start);
                          },
                        ),
                    ],
                  );
                },
                decoration: const InputDecoration(
                  hintText: '开始写作…支持 Markdown：# 标题、- 列表、- [ ] 待办、**加粗**、> 引用；工具栏可插入图片和附件',
                  filled: false,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  contentPadding: EdgeInsets.zero,
                ),
              ),
            ]),
          ),
        ),
      );

  Widget _reader(AppState s, CosDoc d, CosPermissions perms, {bool compact = false}) => SingleChildScrollView(
        padding: EdgeInsets.symmetric(horizontal: compact ? 32 : 24, vertical: 28),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 820),
            child: AnimatedBuilder(
              animation: Listenable.merge([body, comments.comments]),
              builder: (_, _) {
                final quotes = [
                  for (final c in comments.comments.value)
                    if (!c.solved && !c.isWhole && c.quote != null && body.text.contains(c.quote!)) c.quote!,
                ];
                final whole = comments.comments.value.where((c) => c.isWhole && !c.solved).length;
                return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  ValueListenableBuilder(
                    valueListenable: title,
                    builder: (_, t, _) => Text(t.text.isEmpty ? '未命名文档' : t.text,
                        style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w700, height: 1.3)),
                  ),
                  const SizedBox(height: 10),
                  _meta(s, d),
                  const SizedBox(height: 20),
                  if (body.text.trim().isEmpty)
                    const Text('（空文档）', style: TextStyle(color: Fs.text3))
                  else
                    MarkdownView(
                      body.text,
                      highlights: quotes,
                      onHighlightTap: _commentsOn ? _focusQuote : null,
                      onComment: _commentsOn && perms.canComment ? _startComment : null,
                      onRetryUpload: _retryUpload,
                    ),
                  if (_commentsOn) ...[
                    const SizedBox(height: 32),
                    const Divider(),
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Row(children: [
                        const Icon(Icons.forum_outlined, size: 18, color: Fs.text3),
                        const SizedBox(width: 8),
                        Text(whole == 0 ? '全文评论' : '全文评论 · $whole', style: const TextStyle(fontSize: 14, color: Fs.text2)),
                        const Spacer(),
                        TextButton(
                          onPressed: () => _openSide(_Side.comments),
                          child: Text(perms.canComment ? '写评论' : '查看评论'),
                        ),
                      ]),
                    ),
                  ],
                ]);
              },
            ),
          ),
        ),
      );
}

/// 云文档图标（列表、顶栏共用）。
class DocIcon extends StatelessWidget {
  final double size;
  final Color color;
  final IconData icon;
  const DocIcon({super.key, this.size = 34, this.color = Fs.primary, this.icon = Icons.article_rounded});
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(size * 0.22)),
        child: Icon(icon, color: Colors.white, size: size * 0.6),
      );
}
