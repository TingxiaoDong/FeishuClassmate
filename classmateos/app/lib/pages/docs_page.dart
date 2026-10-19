/// 云文档：文档列表 + Markdown 编辑器（编辑 / 分屏 / 阅读，自动保存，格式工具栏，模板）。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/markdown_view.dart';

const _templates = <(String, String, IconData, String)>[
  ('空白文档', '', Icons.note_add_outlined, ''),
  (
    '会议纪要',
    '会议纪要',
    Icons.groups_2_outlined,
    '# 会议纪要\n\n**时间**：\n**地点**：\n**参会人**：\n\n## 议题\n\n1. \n\n## 讨论记录\n\n- \n\n## 待办事项\n\n- [ ] \n- [ ] \n',
  ),
  (
    '项目周报',
    '项目周报',
    Icons.insights_outlined,
    '# 项目周报\n\n## 本周进展\n\n- \n\n## 遇到的问题\n\n- \n\n## 下周计划\n\n- [ ] \n\n## 需要的支持\n\n> \n',
  ),
  (
    '讲解稿',
    '展厅讲解稿',
    Icons.record_voice_over_outlined,
    '# 展厅讲解稿\n\n## 开场\n\n大家好，欢迎来到实验室。\n\n## 展项一\n\n- 讲解要点：\n- 时长：\n\n## 结束语\n\n感谢大家的参观！\n',
  ),
  (
    '研究报告',
    '研究报告',
    Icons.science_outlined,
    '# 研究报告\n\n## 摘要\n\n\n## 背景\n\n\n## 方法\n\n\n## 实验结果\n\n| 指标 | 基线 | 本方法 |\n|---|---|---|\n|  |  |  |\n\n## 结论\n\n',
  ),
];

class DocsPage extends StatefulWidget {
  const DocsPage({super.key});
  @override
  State<DocsPage> createState() => _DocsPageState();
}

class _DocsPageState extends State<DocsPage> {
  List<CosDoc> docs = [];
  bool loading = true;
  String? error;
  String? selected;
  String keyword = '';
  bool mineOnly = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await AppScope.read(context).api.listDocs();
      if (!mounted) return;
      setState(() {
        docs = list;
        loading = false;
        error = null;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  Future<void> _create(bool wide, (String, String, IconData, String) tpl) async {
    final s = AppScope.read(context);
    try {
      final created = await s.api.createDoc(tpl.$2.isEmpty ? '未命名文档' : tpl.$2, tpl.$4);
      final id = created.docId;
      await _load();
      if (!mounted) return;
      if (wide) {
        setState(() => selected = id);
      } else {
        _openNarrow(id);
      }
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _openNarrow(String id) async {
    await pushScoped(context, Scaffold(body: SafeArea(child: DocEditor(docId: id, showBack: true, onSaved: _load, onDeleted: () {
              Navigator.of(context).maybePop();
              _load();
            }))));
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 860;
      final list = _list(context, wide);
      if (!wide) return list;
      return Row(children: [
        SizedBox(width: 300, child: list),
        const VerticalDivider(width: 1),
        Expanded(
          child: selected == null
              ? _home(context)
              : DocEditor(
                  key: ValueKey(selected),
                  docId: selected!,
                  onSaved: _load,
                  onDeleted: () {
                    setState(() => selected = null);
                    _load();
                  },
                ),
        ),
      ]);
    });
  }

  /// 未选中文档时的首页：模板入口 + 最近文档。
  Widget _home(BuildContext context) => Container(
        color: Fs.bg,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(40, 36, 40, 36),
          children: [
            const Text('新建文档', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
            const SizedBox(height: 16),
            Wrap(spacing: 16, runSpacing: 16, children: [
              for (final t in _templates)
                HoverBox(
                  onTap: () => _create(true, t),
                  hoverColor: Colors.white,
                  radius: 10,
                  child: Container(
                    width: 168,
                    height: 128,
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: Fs.line),
                    ),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(color: Fs.primaryBg, borderRadius: BorderRadius.circular(8)),
                        child: Icon(t.$3, color: Fs.primary, size: 22),
                      ),
                      const Spacer(),
                      Text(t.$1, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                      const SizedBox(height: 2),
                      Text(t.$4.isEmpty ? '从零开始写作' : '使用模板',
                          style: const TextStyle(fontSize: 12, color: Fs.text3)),
                    ]),
                  ),
                ),
            ]),
            const SizedBox(height: 32),
            const Text('最近文档', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            if (docs.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Text('还没有文档，选一个模板开始吧', style: TextStyle(color: Fs.text3)),
              )
            else
              Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Fs.line),
                ),
                child: Column(children: [
                  for (final d in docs.take(8))
                    HoverBox(
                      radius: 0,
                      onTap: () => setState(() => selected = d.docId),
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                      child: Row(children: [
                        const _DocIcon(size: 28),
                        const SizedBox(width: 12),
                        Expanded(child: Text(d.title, style: const TextStyle(fontSize: 14))),
                        SizedBox(
                          width: 120,
                          child: Text(AppScope.of(context).userName(d.createdBy),
                              style: const TextStyle(fontSize: 13, color: Fs.text2)),
                        ),
                        SizedBox(
                          width: 100,
                          child: Text(fmtRelative(d.updatedAt),
                              textAlign: TextAlign.right, style: const TextStyle(fontSize: 13, color: Fs.text3)),
                        ),
                      ]),
                    ),
                ]),
              ),
          ],
        ),
      );

  Widget _list(BuildContext context, bool wide) {
    final s = AppScope.of(context);
    final list = docs
        .where((d) => keyword.isEmpty || d.title.toLowerCase().contains(keyword.toLowerCase()))
        .where((d) => !mineOnly || d.createdBy == s.me.userId)
        .toList();
    return Container(
      color: Colors.white,
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 12, 8),
          child: Row(children: [
            HoverBox(
              onTap: wide ? () => setState(() => selected = null) : null,
              padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
              child: const Text('云文档', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
            ),
            const Spacer(),
            PopupMenuButton<int>(
              tooltip: '新建文档',
              position: PopupMenuPosition.under,
              onSelected: (i) => _create(wide, _templates[i]),
              itemBuilder: (_) => [
                for (var i = 0; i < _templates.length; i++)
                  PopupMenuItem(
                    value: i,
                    child: Row(children: [
                      Icon(_templates[i].$3, size: 18, color: Fs.text2),
                      const SizedBox(width: 10),
                      Text(_templates[i].$1),
                    ]),
                  ),
              ],
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                decoration: BoxDecoration(color: Fs.primary, borderRadius: BorderRadius.circular(Fs.radius)),
                child: const Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(Icons.add_rounded, size: 16, color: Colors.white),
                  SizedBox(width: 4),
                  Text('新建', style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w500)),
                ]),
              ),
            ),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: FsSearchField(hint: '搜索文档', onChanged: (v) => setState(() => keyword = v.trim())),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
          child: Row(children: [
            for (final m in [false, true])
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: HoverBox(
                  selected: mineOnly == m,
                  selectedColor: Fs.primaryLight,
                  radius: 14,
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  onTap: () => setState(() => mineOnly = m),
                  child: Text(m ? '我创建的' : '全部文档',
                      style: TextStyle(fontSize: 12, color: mineOnly == m ? Fs.primary : Fs.text2)),
                ),
              ),
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
                          icon: Icons.description_outlined,
                          title: keyword.isEmpty ? '还没有文档' : '没有匹配的文档',
                          subtitle: keyword.isEmpty ? '点「新建」创建第一篇文档' : null,
                        )
                      : RefreshIndicator(
                          onRefresh: _load,
                          child: ListView.builder(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            itemCount: list.length,
                            itemBuilder: (_, i) {
                              final d = list[i];
                              return HoverBox(
                                selected: wide && d.docId == selected,
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                                onTap: () => wide ? setState(() => selected = d.docId) : _openNarrow(d.docId),
                                child: Row(children: [
                                  const _DocIcon(),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                      Text(d.title,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                                      const SizedBox(height: 2),
                                      Text('${s.userName(d.createdBy)} · ${fmtRelative(d.updatedAt)} 更新',
                                          style: const TextStyle(fontSize: 12, color: Fs.text3)),
                                    ]),
                                  ),
                                ]),
                              );
                            },
                          ),
                        ),
        ),
      ]),
    );
  }
}

class _DocIcon extends StatelessWidget {
  final double size;
  const _DocIcon({this.size = 34});
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: Fs.primary, borderRadius: BorderRadius.circular(size * 0.22)),
        child: Icon(Icons.article_rounded, color: Colors.white, size: size * 0.6),
      );
}

// ---------------- 编辑器 ----------------

enum _Mode { edit, split, read }

class DocEditor extends StatefulWidget {
  final String docId;
  final bool showBack;
  final VoidCallback? onSaved;
  final VoidCallback? onDeleted;
  const DocEditor({super.key, required this.docId, this.showBack = false, this.onSaved, this.onDeleted});
  @override
  State<DocEditor> createState() => _DocEditorState();
}

class _DocEditorState extends State<DocEditor> {
  CosDoc? doc;
  String? error;
  final title = TextEditingController();
  final body = TextEditingController();
  final bodyFocus = FocusNode();
  _Mode? mode;
  Timer? _debounce;
  bool dirty = false;
  bool saving = false;
  DateTime? savedAt;
  String? saveError;
  late final CosApiClient api;

  @override
  void initState() {
    super.initState();
    api = AppScope.read(context).api;
    _load();
  }

  @override
  void dispose() {
    if (dirty && saveError == null) _save(silent: true);
    _debounce?.cancel();
    title.dispose();
    body.dispose();
    bodyFocus.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await api.getDoc(widget.docId);
      if (!mounted) return;
      setState(() {
        doc = d;
        title.text = d.title;
        body.text = d.markdown ?? '';
        error = null;
      });
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
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

  // 格式工具栏：行首前缀 / 选区包裹 / 插入块
  void _prefix(String p) {
    final sel = body.selection;
    final text = body.text;
    final pos = sel.isValid ? sel.start : text.length;
    final lineStart = pos == 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
    // 已有标题 / 列表前缀时先去掉，避免叠加
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

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    if (error != null) {
      return EmptyState(
        icon: Icons.error_outline_rounded,
        title: '文档打开失败',
        subtitle: error,
        action: OutlinedButton(onPressed: _load, child: const Text('重试')),
      );
    }
    final d = doc;
    if (d == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    final canEdit = d.canEdit ?? (d.createdBy == s.me.userId);
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 1000;
      var m = mode ?? (canEdit ? (wide ? _Mode.split : _Mode.edit) : _Mode.read);
      if (!canEdit) m = _Mode.read;
      if (m == _Mode.split && !wide) m = _Mode.edit;
      return Container(
        color: Colors.white,
        child: Column(children: [
          _topBar(context, s, d, canEdit, wide, m),
          if (canEdit && m != _Mode.read) _formatBar(),
          if (!canEdit)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: const Color(0xFFFFF7E8),
              child: Row(children: [
                const Icon(Icons.visibility_outlined, size: 16, color: Fs.orange),
                const SizedBox(width: 8),
                Text('你可以阅读这篇文档；只有创建者 ${s.userName(d.createdBy)} 可以编辑',
                    style: const TextStyle(fontSize: 13, color: Color(0xFF8F5B00))),
              ]),
            ),
          Expanded(
            child: switch (m) {
              _Mode.read => _reader(s, d),
              _Mode.edit => _editor(s, d),
              _Mode.split => Row(children: [
                  Expanded(child: _editor(s, d, compact: true)),
                  const VerticalDivider(width: 1),
                  Expanded(child: Container(color: const Color(0xFFFAFBFC), child: _reader(s, d, compact: true))),
                ]),
            },
          ),
        ]),
      );
    });
  }

  Widget _topBar(BuildContext context, AppState s, CosDoc d, bool canEdit, bool wide, _Mode m) {
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
          IconButton(
            icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18),
            onPressed: () => Navigator.of(context).maybePop(),
          ),
        const _DocIcon(size: 24),
        const SizedBox(width: 10),
        Flexible(
          child: ValueListenableBuilder(
            valueListenable: title,
            builder: (_, v, _) => Text(v.text.isEmpty ? '未命名文档' : v.text,
                maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
          ),
        ),
        const SizedBox(width: 10),
        if (canEdit)
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
        if (canEdit)
          SegmentedButton<_Mode>(
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
              const ButtonSegment(value: _Mode.edit, icon: Icon(Icons.edit_outlined, size: 15), label: Text('编辑')),
              if (wide)
                const ButtonSegment(value: _Mode.split, icon: Icon(Icons.vertical_split_outlined, size: 15), label: Text('分屏')),
              const ButtonSegment(value: _Mode.read, icon: Icon(Icons.chrome_reader_mode_outlined, size: 15), label: Text('阅读')),
            ],
            selected: {m},
            onSelectionChanged: (v) => setState(() => mode = v.first),
          ),
        const SizedBox(width: 4),
        PopupMenuButton<String>(
          tooltip: '更多',
          icon: const Icon(Icons.more_horiz_rounded, size: 20),
          onSelected: (v) async {
            if (v == 'copy') {
              await Clipboard.setData(ClipboardData(text: body.text));
              if (context.mounted) showToast(context, '已复制 Markdown 全文');
            } else if (v == 'reload') {
              if (dirty) {
                final ok = await confirmDialog(context, title: '重新载入', content: '未保存的草稿会被替换。请先复制 Markdown 备份，确定继续吗？', ok: '重新载入');
                if (!ok || !mounted) return;
              }
              _debounce?.cancel();
              dirty = false;
              _load();
            } else if (v == 'delete') {
              final ok = await confirmDialog(context,
                  title: '删除文档', content: '确定删除「${d.title}」吗？删除后无法恢复。', ok: '删除', danger: true);
              if (!ok || !context.mounted) return;
              try {
                _debounce?.cancel();
                dirty = false;
                await api.deleteDoc(widget.docId);
                if (context.mounted) showToast(context, '文档已删除');
                widget.onDeleted?.call();
              } catch (e) {
                if (context.mounted) showToast(context, describeError(e), error: true);
              }
            }
          },
          itemBuilder: (_) => [
            const PopupMenuItem(
                value: 'copy', child: Row(children: [Icon(Icons.copy_rounded, size: 18), SizedBox(width: 10), Text('复制 Markdown')])),
            const PopupMenuItem(
                value: 'reload',
                child: Row(children: [Icon(Icons.refresh_rounded, size: 18), SizedBox(width: 10), Text('重新载入')])),
            if (d.createdBy == s.me.userId || s.me.isAdmin)
              const PopupMenuItem(
                  value: 'delete',
                  child: Row(children: [
                    Icon(Icons.delete_outline_rounded, size: 18, color: Fs.red),
                    SizedBox(width: 10),
                    Text('删除文档', style: TextStyle(color: Fs.red)),
                  ])),
          ],
        ),
      ]),
    );
  }

  Widget _formatBar() {
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
          b(Icons.data_object_rounded, '代码块', () => _block('```\n\n```')),
          b(Icons.table_chart_outlined, '表格', () => _block('| 列 1 | 列 2 | 列 3 |\n|---|---|---|\n|  |  |  |')),
          b(Icons.horizontal_rule_rounded, '分割线', () => _block('---')),
        ]),
      ),
    );
  }

  Widget _meta(AppState s, CosDoc d) => Row(children: [
        FsAvatar(name: s.userName(d.createdBy), seed: d.createdBy, size: 20),
        const SizedBox(width: 6),
        Text(s.userName(d.createdBy), style: const TextStyle(fontSize: 12, color: Fs.text2)),
        const SizedBox(width: 10),
        Text(
          d.updatedAt != null ? '最近修改 ${fmtDateTime((savedAt ?? d.updatedAt!).toLocal())}' : '',
          style: const TextStyle(fontSize: 12, color: Fs.text3),
        ),
      ]);

  Widget _editor(AppState s, CosDoc d, {bool compact = false}) => SingleChildScrollView(
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
                decoration: const InputDecoration(
                  hintText: '开始写作…支持 Markdown：# 标题、- 列表、- [ ] 待办、**加粗**、> 引用',
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

  Widget _reader(AppState s, CosDoc d, {bool compact = false}) => SingleChildScrollView(
        padding: EdgeInsets.symmetric(horizontal: compact ? 32 : 24, vertical: 28),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 820),
            child: ValueListenableBuilder(
              valueListenable: body,
              builder: (_, v, _) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                ValueListenableBuilder(
                  valueListenable: title,
                  builder: (_, t, _) => Text(t.text.isEmpty ? '未命名文档' : t.text,
                      style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w700, height: 1.3)),
                ),
                const SizedBox(height: 10),
                _meta(s, d),
                const SizedBox(height: 20),
                if (v.text.trim().isEmpty)
                  const Text('（空文档）', style: TextStyle(color: Fs.text3))
                else
                  MarkdownView(v.text),
              ]),
            ),
          ),
        ),
      );
}
