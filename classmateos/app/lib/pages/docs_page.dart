/// 云文档：左栏（主页 / 我的空间 / 共享给我 / 收藏 / 知识库 / 回收站，R-DC-05）+ 文档列表 + 编辑器。
/// 后端没开 `doc.folders` 时退回一期的单层列表（全部 / 我创建的）。
library;

import 'package:flutter/material.dart';

import '../api/phase2_docs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/doc_editor.dart';

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

enum DocScope {
  recent('主页', Icons.home_outlined, '最近访问'),
  mine('我的空间', Icons.folder_outlined, '我的空间'),
  shared('共享给我', Icons.people_alt_outlined, '共享给我'),
  starred('收藏', Icons.star_outline_rounded, '收藏'),
  trash('回收站', Icons.delete_outline_rounded, '回收站');

  final String label;
  final IconData icon;
  final String heading;
  const DocScope(this.label, this.icon, this.heading);
}

class DocsPage extends StatefulWidget {
  const DocsPage({super.key});
  @override
  State<DocsPage> createState() => _DocsPageState();
}

class _DocsPageState extends State<DocsPage> {
  List<CosDoc> docs = [];
  List<CosFolder> folders = [];
  bool loading = true;
  String? error;
  String? selected;
  String? focusComment;
  String keyword = '';
  bool mineOnly = false;

  DocScope scope = DocScope.recent;

  /// 我的空间里的当前路径（根 → 当前文件夹）。
  List<CosFolder> path = [];
  late final AppState _s = AppScope.read(context);
  int _loadSeq = 0;

  bool get v2 => _s.feature('doc.folders');
  String? get folderId => path.isEmpty ? null : path.last.folderId;

  @override
  void initState() {
    super.initState();
    _s.addListener(_checkTarget);
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkTarget());
    _load();
  }

  @override
  void dispose() {
    _s.removeListener(_checkTarget);
    super.dispose();
  }

  /// 通知跳转：{type: doc, id, comment_id?}
  void _checkTarget() {
    final t = _s.pendingTarget;
    if (t == null || _s.module != AppModule.docs || t['type'] != 'doc') return;
    _s.pendingTarget = null;
    final id = t['id']?.toString();
    if (id == null || !mounted) return;
    final c = (t['comment_id'] ?? t['anchor'])?.toString();
    if (MediaQuery.sizeOf(context).width >= 860) {
      setState(() {
        selected = id;
        focusComment = c;
      });
    } else {
      _openNarrow(id, focusComment: c);
    }
  }

  Future<void> _load() async {
    final seq = ++_loadSeq;
    try {
      final api = _s.api;
      List<CosDoc> list;
      var fs = <CosFolder>[];
      if (!v2) {
        list = await api.listDocs();
      } else if (scope == DocScope.mine) {
        final r = await Future.wait([api.listDocsIn('mine', folderId: folderId), api.listFolders(parentId: folderId)]);
        list = r[0] as List<CosDoc>;
        fs = r[1] as List<CosFolder>;
      } else {
        list = await api.listDocsIn(scope.name);
      }
      if (!mounted || seq != _loadSeq) return;
      setState(() {
        docs = list;
        folders = fs;
        loading = false;
        error = null;
      });
    } catch (e) {
      if (mounted && seq == _loadSeq) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  void _setScope(DocScope s) {
    setState(() {
      scope = s;
      path = [];
      loading = true;
    });
    _load();
  }

  void _enterFolder(List<CosFolder> p) {
    setState(() {
      scope = DocScope.mine;
      path = p;
      loading = true;
    });
    _load();
  }

  Future<void> _create(bool wide, (String, String, IconData, String) tpl) async {
    try {
      final title = tpl.$2.isEmpty ? '未命名文档' : tpl.$2;
      final created = v2 && scope == DocScope.mine && folderId != null
          ? await _s.api.createDocIn(title, tpl.$4, folderId: folderId)
          : await _s.api.createDoc(title, tpl.$4);
      await _load();
      if (!mounted) return;
      if (wide) {
        setState(() => selected = created.docId);
      } else {
        _openNarrow(created.docId);
      }
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _openNarrow(String id, {String? focusComment}) async {
    await pushScoped(
      context,
      Scaffold(
        body: SafeArea(
          child: DocEditor(
            docId: id,
            showBack: true,
            focusCommentId: focusComment,
            onSaved: _load,
            onDeleted: () {
              Navigator.of(context).maybePop();
              _load();
            },
          ),
        ),
      ),
    );
    _load();
  }

  // ---------------- 文件夹与文档操作 ----------------

  Future<String?> _askName(String title, {String initial = '', String hint = ''}) async {
    final ctl = TextEditingController(text: initial);
    final r = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: 360,
          child: TextField(
            controller: ctl,
            autofocus: true,
            maxLength: 50,
            decoration: InputDecoration(hintText: hint),
            onSubmitted: (t) => Navigator.pop(ctx, t),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text), child: const Text('确定')),
        ],
      ),
    );
    ctl.dispose();
    final t = r?.trim();
    return t == null || t.isEmpty ? null : t;
  }

  Future<void> _guard(Future<void> Function() f, [String? ok]) async {
    try {
      await f();
      if (ok != null && mounted) showToast(context, ok);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
    _load();
  }

  Future<void> _newFolder() async {
    final name = await _askName('新建文件夹', hint: '文件夹名称');
    if (name == null) return;
    _guard(() => _s.api.createFolder(name, parentId: folderId));
  }

  Future<void> _folderAction(CosFolder f, String action) async {
    switch (action) {
      case 'open':
        _enterFolder([...path, f]);
      case 'rename':
        final name = await _askName('重命名文件夹', initial: f.name);
        if (name != null) _guard(() => _s.api.updateFolder(f.folderId, name: name));
      case 'move':
        final to = await pickFolder(context, title: '移动「${f.name}」到', exclude: f.folderId);
        if (to == null) return;
        _guard(() => _s.api.updateFolder(f.folderId, parentId: to.id, toRoot: to.id == null), '已移动');
      case 'delete':
        final ok = await confirmDialog(context,
            title: '删除文件夹', content: '「${f.name}」和里面的文档都会移到回收站，30 天内可以恢复。', ok: '删除', danger: true);
        if (ok) _guard(() => _s.api.deleteFolder(f.folderId), '已移到回收站');
    }
  }

  Future<void> _docAction(CosDoc d, String action) async {
    final api = _s.api;
    switch (action) {
      case 'star':
        _guard(() => api.starDoc(d.docId, !d.starred), d.starred ? '已取消收藏' : '已收藏');
      case 'move':
        final to = await pickFolder(context, title: '移动「${d.title}」到');
        if (to == null) return;
        _guard(() => api.moveDoc(d.docId, to.id), '已移动到「${to.name}」');
      case 'delete':
        final ok = await confirmDialog(context, title: '删除文档', content: '「${d.title}」会移到回收站，30 天内可以恢复。', ok: '删除', danger: true);
        if (!ok) return;
        if (selected == d.docId) setState(() => selected = null);
        _guard(() => api.deleteDoc(d.docId), '已移到回收站');
      case 'restore':
        _guard(() => api.restoreDoc(d.docId), '已恢复「${d.title}」');
      case 'purge':
        final ok = await confirmDialog(context, title: '彻底删除', content: '「${d.title}」会被永久删除，无法恢复。', ok: '彻底删除', danger: true);
        if (ok) _guard(() => api.deleteDocForever(d.docId), '已彻底删除');
    }
  }

  // ---------------- 构建 ----------------

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 860;
      final showNav = v2 && c.maxWidth >= 1180;
      final list = _list(context, s, wide, showNav);
      if (!wide) return list;
      return Row(children: [
        if (showNav) ...[SizedBox(width: 208, child: _nav(s, wide)), const VerticalDivider(width: 1)],
        SizedBox(width: 320, child: list),
        const VerticalDivider(width: 1),
        Expanded(
          child: selected == null
              ? _home(context, s)
              : DocEditor(
                  key: ValueKey(selected),
                  docId: selected!,
                  focusCommentId: focusComment,
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

  Widget _newButton(bool wide, {bool expanded = false}) => PopupMenuButton<String>(
        tooltip: '新建',
        position: PopupMenuPosition.under,
        onSelected: (v) => v == 'folder' ? _newFolder() : _create(wide, _templates[int.parse(v)]),
        itemBuilder: (_) => [
          for (var i = 0; i < _templates.length; i++)
            PopupMenuItem(
              value: '$i',
              child: Row(children: [Icon(_templates[i].$3, size: 18, color: Fs.text2), const SizedBox(width: 10), Text(_templates[i].$1)]),
            ),
          if (v2) ...[
            const PopupMenuDivider(),
            const PopupMenuItem(
              value: 'folder',
              child: Row(children: [Icon(Icons.create_new_folder_outlined, size: 18, color: Fs.text2), SizedBox(width: 10), Text('文件夹')]),
            ),
          ],
        ],
        child: Container(
          width: expanded ? double.infinity : null,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(color: Fs.primary, borderRadius: BorderRadius.circular(Fs.radius)),
          child: Row(mainAxisSize: expanded ? MainAxisSize.max : MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: const [
            Icon(Icons.add_rounded, size: 16, color: Colors.white),
            SizedBox(width: 4),
            Text('新建', style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w500)),
          ]),
        ),
      );

  Widget _nav(AppState s, bool wide) {
    Widget item(IconData icon, String label, bool sel, VoidCallback onTap) => HoverBox(
          selected: sel,
          selectedColor: Fs.primaryLight,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
          margin: const EdgeInsets.symmetric(vertical: 1),
          onTap: onTap,
          child: Row(children: [
            Icon(icon, size: 18, color: sel ? Fs.primary : Fs.text2),
            const SizedBox(width: 10),
            Text(label, style: TextStyle(fontSize: 14, color: sel ? Fs.primary : Fs.text1, fontWeight: sel ? FontWeight.w500 : null)),
          ]),
        );
    return Container(
      color: const Color(0xFFF8F9FA),
      child: ListView(padding: const EdgeInsets.fromLTRB(12, 14, 12, 12), children: [
        const Padding(
          padding: EdgeInsets.only(left: 4, bottom: 12),
          child: Text('云文档', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        ),
        _newButton(wide, expanded: true),
        const SizedBox(height: 14),
        for (final sc in DocScope.values.where((x) => x != DocScope.trash))
          _folderDrop(
            sc == DocScope.mine ? const <CosFolder>[] : null,
            item(sc.icon, sc.label, scope == sc && (sc != DocScope.mine || path.isEmpty), () => _setScope(sc)),
          ),
        if (s.feature('wiki')) item(Icons.menu_book_outlined, '知识库', false, () => s.go(AppModule.wiki)),
        const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Divider()),
        item(DocScope.trash.icon, DocScope.trash.label, scope == DocScope.trash, () => _setScope(DocScope.trash)),
      ]),
    );
  }

  /// 文件夹（或「我的空间」根目录）作为拖放目标：把文档拖进去即移动。
  Widget _folderDrop(List<CosFolder>? targetPath, Widget child) {
    if (targetPath == null || !v2) return child;
    final target = targetPath.isEmpty ? null : targetPath.last;
    return DragTarget<CosDoc>(
      onWillAcceptWithDetails: (d) => d.data.folderId != target?.folderId,
      onAcceptWithDetails: (d) => _guard(() => _s.api.moveDoc(d.data.docId, target?.folderId), '已移动到「${target?.name ?? '我的空间'}」'),
      builder: (_, cand, _) => Container(
        decoration: cand.isEmpty
            ? null
            : BoxDecoration(border: Border.all(color: Fs.primary, width: 1.5), borderRadius: BorderRadius.circular(Fs.radius)),
        child: child,
      ),
    );
  }

  Widget _home(BuildContext context, AppState s) => Container(
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
                    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: Fs.line)),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(color: Fs.primaryBg, borderRadius: BorderRadius.circular(8)),
                        child: Icon(t.$3, color: Fs.primary, size: 22),
                      ),
                      const Spacer(),
                      Text(t.$1, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                      const SizedBox(height: 2),
                      Text(t.$4.isEmpty ? '从零开始写作' : '使用模板', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                    ]),
                  ),
                ),
            ]),
            if (v2 && scope == DocScope.mine && path.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text('新文档会放在「${path.last.name}」里', style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ),
            const SizedBox(height: 32),
            Text(v2 ? scope.heading : '最近文档', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            if (docs.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Text('这里还没有文档', style: TextStyle(color: Fs.text3)),
              )
            else
              Container(
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: Fs.line)),
                child: Column(children: [
                  for (final d in docs.take(10))
                    HoverBox(
                      radius: 0,
                      onTap: scope == DocScope.trash ? null : () => setState(() => selected = d.docId),
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                      child: Row(children: [
                        const DocIcon(size: 28),
                        const SizedBox(width: 12),
                        Expanded(child: Text(d.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14))),
                        SizedBox(width: 120, child: Text(s.userName(d.owner), style: const TextStyle(fontSize: 13, color: Fs.text2))),
                        SizedBox(
                          width: 110,
                          child: Text(
                            fmtRelative(scope == DocScope.recent ? (d.lastViewedAt ?? d.updatedAt) : d.updatedAt),
                            textAlign: TextAlign.right,
                            style: const TextStyle(fontSize: 13, color: Fs.text3),
                          ),
                        ),
                      ]),
                    ),
                ]),
              ),
          ],
        ),
      );

  Widget _list(BuildContext context, AppState s, bool wide, bool showNav) {
    final kw = keyword.toLowerCase();
    final list = docs
        .where((d) => kw.isEmpty || d.title.toLowerCase().contains(kw))
        .where((d) => v2 || !mineOnly || d.createdBy == s.me.userId)
        .toList();
    final fs = folders.where((f) => kw.isEmpty || f.name.toLowerCase().contains(kw)).toList();
    final empty = list.isEmpty && fs.isEmpty;
    return Container(
      color: Colors.white,
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 12, 8),
          child: Row(children: [
            Expanded(
              child: HoverBox(
                onTap: wide ? () => setState(() => selected = null) : null,
                padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
                child: Text(v2 && showNav ? scope.heading : '云文档',
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              ),
            ),
            if (v2 && scope == DocScope.mine && showNav)
              FsIconButton(icon: Icons.create_new_folder_outlined, tooltip: '新建文件夹', onPressed: _newFolder),
            if (!showNav) _newButton(wide),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: FsSearchField(hint: '搜索文档', onChanged: (v) => setState(() => keyword = v.trim())),
        ),
        if (!v2)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
            child: Row(children: [for (final m in [false, true]) _chip(m ? '我创建的' : '全部文档', mineOnly == m, () => setState(() => mineOnly = m))]),
          )
        else if (!showNav)
          SizedBox(
            height: 40,
            child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(12, 10, 12, 4), children: [
              for (final sc in DocScope.values) _chip(sc.label, scope == sc, () => _setScope(sc)),
              if (s.feature('wiki')) _chip('知识库', false, () => s.go(AppModule.wiki)),
            ]),
          ),
        if (v2 && scope == DocScope.mine) _breadcrumb(),
        if (v2 && scope == DocScope.trash)
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 6, 16, 2),
            child: Text('删除的文档保留 30 天，可以恢复', style: TextStyle(fontSize: 12, color: Fs.text3)),
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
                  : empty
                      ? EmptyState(
                          icon: scope == DocScope.trash ? Icons.delete_outline_rounded : Icons.description_outlined,
                          title: kw.isNotEmpty ? '没有匹配的文档' : _emptyTitle(),
                          subtitle: kw.isEmpty && (scope == DocScope.mine || !v2) ? '点「新建」创建第一篇文档' : null,
                        )
                      : RefreshIndicator(
                          onRefresh: _load,
                          child: ListView(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            children: [
                              for (final f in fs) _folderRow(f),
                              for (final d in list) _docRow(s, d, wide),
                            ],
                          ),
                        ),
        ),
      ]),
    );
  }

  String _emptyTitle() => switch (scope) {
        _ when !v2 => '还没有文档',
        DocScope.recent => '还没有访问过的文档',
        DocScope.mine => path.isEmpty ? '我的空间还是空的' : '文件夹是空的',
        DocScope.shared => '还没有人和你共享文档',
        DocScope.starred => '还没有收藏的文档',
        DocScope.trash => '回收站是空的',
      };

  Widget _chip(String label, bool sel, VoidCallback onTap) => Padding(
        padding: const EdgeInsets.only(right: 6),
        child: HoverBox(
          selected: sel,
          selectedColor: Fs.primaryLight,
          radius: 14,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          onTap: onTap,
          child: Text(label, style: TextStyle(fontSize: 12, color: sel ? Fs.primary : Fs.text2)),
        ),
      );

  Widget _breadcrumb() => Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 2),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            for (var i = -1; i < path.length; i++) ...[
              if (i >= 0) const Icon(Icons.chevron_right_rounded, size: 16, color: Fs.text3),
              _folderDrop(
                i < 0 ? const [] : path.sublist(0, i + 1),
                HoverBox(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                  onTap: i == path.length - 1 ? null : () => _enterFolder(path.sublist(0, i + 1)),
                  child: Text(i < 0 ? '我的空间' : path[i].name,
                      style: TextStyle(fontSize: 12, color: i == path.length - 1 ? Fs.text1 : Fs.text3)),
                ),
              ),
            ],
          ]),
        ),
      );

  Widget _folderRow(CosFolder f) => _folderDrop(
        [...path, f],
        HoverReveal(
          builder: (_, hover) => HoverBox(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            onTap: () => _enterFolder([...path, f]),
            onSecondaryTap: () {},
            child: Row(children: [
              const DocIcon(size: 34, color: Color(0xFFFFB82E), icon: Icons.folder_rounded),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(f.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                  const SizedBox(height: 2),
                  Text('文件夹${f.updatedAt == null ? '' : ' · ${fmtRelative(f.updatedAt)} 更新'}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                ]),
              ),
              Opacity(
                opacity: hover ? 1 : 0,
                child: PopupMenuButton<String>(
                  tooltip: '更多',
                  icon: const Icon(Icons.more_horiz_rounded, size: 18, color: Fs.text3),
                  onSelected: (v) => _folderAction(f, v),
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: 'open', child: Text('打开')),
                    PopupMenuItem(value: 'rename', child: Text('重命名')),
                    PopupMenuItem(value: 'move', child: Text('移动到')),
                    PopupMenuDivider(),
                    PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(color: Fs.red))),
                  ],
                ),
              ),
            ]),
          ),
        ),
      );

  Widget _docRow(AppState s, CosDoc d, bool wide) {
    final trash = v2 && scope == DocScope.trash;
    final mine = d.owner == s.me.userId;
    final time = switch (scope) {
      DocScope.recent when v2 => '${fmtRelative(d.lastViewedAt ?? d.updatedAt)} 访问',
      DocScope.trash when v2 => '${fmtRelative(d.deletedAt)} 删除',
      _ => '${fmtRelative(d.updatedAt)} 更新',
    };
    final row = HoverReveal(
      builder: (_, hover) => HoverBox(
        selected: wide && d.docId == selected,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        onTap: trash
            ? null
            : () => wide
                ? setState(() {
                    selected = d.docId;
                    focusComment = null;
                  })
                : _openNarrow(d.docId),
        child: Row(children: [
          DocIcon(color: trash ? Fs.textDisabled : Fs.primary),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(
                  child: Text(d.title,
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                ),
                if (d.starred) const Padding(padding: EdgeInsets.only(left: 4), child: Icon(Icons.star_rounded, size: 14, color: Fs.yellow)),
              ]),
              const SizedBox(height: 2),
              Row(children: [
                Flexible(
                  child: Text('${s.userName(d.owner)} · $time',
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text3)),
                ),
                if (v2 && !mine && d.myRole != null) ...[
                  const SizedBox(width: 6),
                  FsTag(kRoleLabels[d.myRole!] ?? d.myRole!, color: TagColor.gray, fontSize: 11),
                ],
              ]),
            ]),
          ),
          if (trash)
            Row(mainAxisSize: MainAxisSize.min, children: [
              FsIconButton(icon: Icons.restore_rounded, tooltip: '恢复', size: 18, onPressed: () => _docAction(d, 'restore')),
              FsIconButton(icon: Icons.delete_forever_outlined, tooltip: '彻底删除', size: 18, color: Fs.red, onPressed: () => _docAction(d, 'purge')),
            ])
          else if (v2)
            Opacity(
              opacity: hover ? 1 : 0,
              child: PopupMenuButton<String>(
                tooltip: '更多',
                icon: const Icon(Icons.more_horiz_rounded, size: 18, color: Fs.text3),
                onSelected: (v) => _docAction(d, v),
                itemBuilder: (_) => [
                  PopupMenuItem(value: 'star', child: Text(d.starred ? '取消收藏' : '收藏')),
                  if (mine) const PopupMenuItem(value: 'move', child: Text('移动到')),
                  if (d.permissions?.canDelete ?? mine) ...[
                    const PopupMenuDivider(),
                    const PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(color: Fs.red))),
                  ],
                ],
              ),
            ),
        ]),
      ),
    );
    if (!v2 || trash || !mine) return row;
    return Draggable<CosDoc>(
      data: d,
      feedback: Material(
        elevation: 6,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            const DocIcon(size: 22),
            const SizedBox(width: 8),
            Text(d.title, style: const TextStyle(fontSize: 13)),
          ]),
        ),
      ),
      childWhenDragging: Opacity(opacity: 0.4, child: row),
      child: row,
    );
  }
}

// ---------------- 选择文件夹 ----------------

/// 选择目标文件夹；id 为 null 表示「我的空间」根目录。取消返回 null。
Future<({String? id, String name})?> pickFolder(BuildContext context, {required String title, String? exclude}) =>
    showScopedDialog<({String? id, String name})>(context, (_) => _FolderPicker(title: title, exclude: exclude));

class _FolderPicker extends StatefulWidget {
  final String title;
  final String? exclude;
  const _FolderPicker({required this.title, this.exclude});
  @override
  State<_FolderPicker> createState() => _FolderPickerState();
}

class _FolderPickerState extends State<_FolderPicker> {
  final Map<String?, List<CosFolder>> children = {};
  final Set<String> expanded = {};
  ({String? id, String name}) picked = (id: null, name: '我的空间');

  @override
  void initState() {
    super.initState();
    _fetch(null);
  }

  Future<void> _fetch(String? parent) async {
    try {
      final list = await AppScope.read(context).api.listFolders(parentId: parent);
      if (mounted) setState(() => children[parent] = list.where((f) => f.folderId != widget.exclude).toList());
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  List<Widget> _rows(String? parent, int depth) => [
        for (final f in children[parent] ?? const <CosFolder>[]) ...[
          HoverBox(
            selected: picked.id == f.folderId,
            selectedColor: Fs.primaryLight,
            padding: EdgeInsets.only(left: 8.0 + depth * 18, right: 8, top: 6, bottom: 6),
            onTap: () => setState(() => picked = (id: f.folderId, name: f.name)),
            child: Row(children: [
              InkWell(
                onTap: () {
                  setState(() => expanded.contains(f.folderId) ? expanded.remove(f.folderId) : expanded.add(f.folderId));
                  if (!children.containsKey(f.folderId)) _fetch(f.folderId);
                },
                child: Icon(expanded.contains(f.folderId) ? Icons.expand_more_rounded : Icons.chevron_right_rounded, size: 18, color: Fs.text3),
              ),
              const SizedBox(width: 4),
              const Icon(Icons.folder_rounded, size: 18, color: Color(0xFFFFB82E)),
              const SizedBox(width: 8),
              Expanded(child: Text(f.name, style: const TextStyle(fontSize: 13))),
            ]),
          ),
          if (expanded.contains(f.folderId)) ..._rows(f.folderId, depth + 1),
        ],
      ];

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        content: SizedBox(
          width: 380,
          height: 340,
          child: ListView(children: [
            HoverBox(
              selected: picked.id == null,
              selectedColor: Fs.primaryLight,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              onTap: () => setState(() => picked = (id: null, name: '我的空间')),
              child: const Row(children: [
                Icon(Icons.home_outlined, size: 18, color: Fs.text2),
                SizedBox(width: 8),
                Text('我的空间', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
              ]),
            ),
            if (!children.containsKey(null)) const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator(strokeWidth: 2))),
            ..._rows(null, 1),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, picked), child: const Text('移动到这里')),
        ],
      );
}
