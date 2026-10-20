/// 知识库（R-WK-01 ~ 04）：首页（空间卡片、最近访问、收藏）+ 空间页（目录树 + 页面编辑器 + 面包屑 + 空间内搜索）。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../api/phase2_docs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/doc_editor.dart';
import 'wiki_tree.dart';

class WikiPage extends StatefulWidget {
  const WikiPage({super.key});
  @override
  State<WikiPage> createState() => _WikiPageState();
}

class _WikiPageState extends State<WikiPage> {
  List<CosWikiSpace> spaces = [];
  List<CosWikiNode> recent = [];
  List<CosWikiNode> starred = [];
  bool loading = true;
  String? error;

  CosWikiSpace? space;
  String? initialNode;
  late final AppState _s = AppScope.read(context);

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

  /// 通知跳转：{type: wiki | wiki_node, id: node_id, space_id?, comment_id?}
  Future<void> _checkTarget() async {
    final t = _s.pendingTarget;
    if (t == null || _s.module != AppModule.wiki) return;
    if (t['type'] != 'wiki' && t['type'] != 'wiki_node' && t['type'] != 'wiki_space') return;
    _s.pendingTarget = null;
    final id = t['id']?.toString();
    if (id == null) return;
    if (t['type'] == 'wiki_space') {
      // 迭代 5：工作台快捷方式直接打开知识空间
      try {
        final sp = await _s.api.getSpace(id);
        if (mounted) _openSpace(sp);
      } catch (e) {
        if (mounted) showToast(context, describeError(e), error: true);
      }
      return;
    }
    try {
      final n = await _s.api.getNode(id);
      final sp = await _s.api.getSpace(n.spaceId);
      if (mounted) _openSpace(sp, node: n.nodeId);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _load() async {
    try {
      final r = await Future.wait([
        _s.api.listSpaces(),
        _s.api.wikiRecent().catchError((Object _) => <CosWikiNode>[]),
        _s.api.wikiStarred().catchError((Object _) => <CosWikiNode>[]),
      ]);
      if (!mounted) return;
      setState(() {
        spaces = r[0] as List<CosWikiSpace>;
        recent = r[1] as List<CosWikiNode>;
        starred = r[2] as List<CosWikiNode>;
        loading = false;
        error = null;
        if (space != null) space = spaces.where((x) => x.spaceId == space!.spaceId).firstOrNull ?? space;
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

  void _openSpace(CosWikiSpace sp, {String? node}) => setState(() {
        space = sp;
        initialNode = node;
      });

  Future<void> _openNode(CosWikiNode n) async {
    final sp = spaces.where((s) => s.spaceId == n.spaceId).firstOrNull;
    if (sp != null) {
      _openSpace(sp, node: n.nodeId);
      return;
    }
    try {
      final got = await _s.api.getSpace(n.spaceId);
      if (mounted) _openSpace(got, node: n.nodeId);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _newSpace() async {
    final sp = await showSpaceEditor(context);
    if (sp == null) return;
    await _load();
    if (mounted) _openSpace(sp);
  }

  @override
  Widget build(BuildContext context) {
    if (space != null) {
      return SpaceView(
        key: ValueKey('${space!.spaceId}|$initialNode'),
        space: space!,
        initialNode: initialNode,
        onBack: () {
          setState(() => space = null);
          _load();
        },
        onSpaceChanged: (sp) => setState(() => space = sp),
        onSpaceDeleted: () {
          setState(() => space = null);
          _load();
        },
      );
    }
    return Container(
      color: Fs.bg,
      child: loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : error != null
              ? EmptyState(
                  icon: Icons.cloud_off_outlined,
                  title: '知识库加载失败',
                  subtitle: error,
                  action: OutlinedButton(onPressed: _load, child: const Text('重试')),
                )
              : RefreshIndicator(onRefresh: _load, child: _home(context)),
    );
  }

  Widget _home(BuildContext context) {
    final s = AppScope.of(context);
    final narrow = MediaQuery.sizeOf(context).width < 700;
    return ListView(
      padding: EdgeInsets.fromLTRB(narrow ? 16 : 40, 28, narrow ? 16 : 40, 40),
      children: [
        Row(children: [
          const Text('知识库', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
          const SizedBox(width: 12),
          const Expanded(
            child: Text('沉淀实验室的规范、手册和经验', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: Fs.text3)),
          ),
          FilledButton.icon(onPressed: _newSpace, icon: const Icon(Icons.add_rounded, size: 18), label: const Text('新建知识空间')),
        ]),
        const SizedBox(height: 16),
        _GlobalWikiSearch(onOpen: _openNode),
        if (recent.isNotEmpty) ...[
          const SizedBox(height: 28),
          _sectionTitle('最近访问'),
          _nodeStrip(s, recent),
        ],
        if (starred.isNotEmpty) ...[
          const SizedBox(height: 24),
          _sectionTitle('我的收藏'),
          _nodeStrip(s, starred),
        ],
        const SizedBox(height: 28),
        _sectionTitle('全部知识空间 · ${spaces.length}'),
        if (spaces.isEmpty)
          Container(
            padding: const EdgeInsets.symmetric(vertical: 48),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), border: Border.all(color: Fs.lineLight)),
            child: Column(children: [
              const Icon(Icons.menu_book_outlined, size: 44, color: Fs.textDisabled),
              const SizedBox(height: 10),
              const Text('还没有知识空间', style: TextStyle(color: Fs.text2)),
              const SizedBox(height: 8),
              TextButton(onPressed: _newSpace, child: const Text('创建第一个知识空间')),
            ]),
          )
        else
          LayoutBuilder(builder: (context, c) {
            final cols = (c.maxWidth / 300).floor().clamp(1, 4);
            final w = (c.maxWidth - (cols - 1) * 16) / cols;
            return Wrap(spacing: 16, runSpacing: 16, children: [for (final sp in spaces) SizedBox(width: w, child: _spaceCard(sp))]);
          }),
      ],
    );
  }

  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Text(t, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
      );

  Widget _nodeStrip(AppState s, List<CosWikiNode> nodes) => SizedBox(
        height: 92,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          itemCount: nodes.length,
          separatorBuilder: (_, _) => const SizedBox(width: 12),
          itemBuilder: (_, i) {
            final n = nodes[i];
            return HoverBox(
              onTap: () => _openNode(n),
              hoverColor: Colors.white,
              radius: 10,
              child: Container(
                width: 220,
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: Fs.lineLight)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    const Icon(Icons.article_outlined, size: 18, color: Fs.primary),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(n.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                    ),
                    if (n.starred) const Icon(Icons.star_rounded, size: 14, color: Fs.yellow),
                  ]),
                  const Spacer(),
                  Text(n.spaceName ?? spaces.where((x) => x.spaceId == n.spaceId).firstOrNull?.name ?? '',
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text2)),
                  const SizedBox(height: 2),
                  Text('${n.updatedBy == null ? '' : '${s.userName(n.updatedBy!)} · '}${fmtRelative(n.updatedAt)} 更新',
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: Fs.text3)),
                ]),
              ),
            );
          },
        ),
      );

  Widget _spaceCard(CosWikiSpace sp) {
    final color = spaceColor(sp.color);
    return HoverBox(
      onTap: () => _openSpace(sp),
      hoverColor: Colors.white,
      radius: 12,
      child: Container(
        height: 168,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), border: Border.all(color: Fs.lineLight), boxShadow: Fs.shadow),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            height: 52,
            decoration: BoxDecoration(
              gradient: LinearGradient(colors: [color.withValues(alpha: 0.85), color.withValues(alpha: 0.45)]),
            ),
            alignment: Alignment.bottomLeft,
            padding: const EdgeInsets.only(left: 16),
            child: Transform.translate(
              offset: const Offset(0, 18),
              child: Container(
                decoration: BoxDecoration(border: Border.all(color: Colors.white, width: 3), borderRadius: BorderRadius.circular(12)),
                child: SpaceAvatar(sp, size: 40),
              ),
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 26, 16, 12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(
                    child: Text(sp.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  ),
                  if (sp.visibility == 'members') const Tooltip(message: '仅成员可访问', child: Icon(Icons.lock_outline_rounded, size: 14, color: Fs.text3)),
                ]),
                const SizedBox(height: 4),
                Expanded(
                  child: Text(sp.description.isEmpty ? '暂无简介' : sp.description,
                      maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text2, height: 1.4)),
                ),
                Row(children: [
                  Text('${sp.pageCount} 个页面', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                  const Spacer(),
                  FsTag(kSpaceRoleLabel[sp.myRole] ?? sp.myRole, color: sp.isAdmin ? TagColor.blue : TagColor.gray, fontSize: 11),
                ]),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

const kSpaceRoleLabel = {'admin': '管理员', 'editor': '可编辑', 'viewer': '可阅读'};

// ---------------- 全局知识库搜索 ----------------

class _GlobalWikiSearch extends StatelessWidget {
  final ValueChanged<CosWikiNode> onOpen;
  const _GlobalWikiSearch({required this.onOpen});
  @override
  Widget build(BuildContext context) => HoverBox(
        onTap: () async {
          final hit = await showWikiSearch(context);
          if (hit != null) onOpen(hit);
        },
        hoverColor: Colors.white,
        child: Container(
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(Fs.radius), border: Border.all(color: Fs.line)),
          child: const Row(children: [
            Icon(Icons.search_rounded, size: 18, color: Fs.text3),
            SizedBox(width: 8),
            Text('搜索所有知识空间的页面标题和正文', style: TextStyle(fontSize: 14, color: Fs.text3)),
          ]),
        ),
      );
}

/// 知识库搜索弹窗；[spaceId] 不为空时只搜这个空间。返回选中的页面（只含 node_id / space_id / title）。
Future<CosWikiNode?> showWikiSearch(BuildContext context, {String? spaceId, String? spaceName}) =>
    showScopedDialog<CosWikiNode>(context, (_) => _WikiSearchDialog(spaceId: spaceId, spaceName: spaceName));

class _WikiSearchDialog extends StatefulWidget {
  final String? spaceId;
  final String? spaceName;
  const _WikiSearchDialog({this.spaceId, this.spaceName});
  @override
  State<_WikiSearchDialog> createState() => _WikiSearchDialogState();
}

class _WikiSearchDialogState extends State<_WikiSearchDialog> {
  final q = TextEditingController();
  Timer? _deb;
  List<CosSearchHit> hits = [];
  bool searching = false;
  String? error;
  int _seq = 0;

  @override
  void dispose() {
    _deb?.cancel();
    q.dispose();
    super.dispose();
  }

  void _changed(String _) {
    _deb?.cancel();
    _deb = Timer(const Duration(milliseconds: 300), _search);
  }

  Future<void> _search() async {
    final t = q.text.trim();
    final seq = ++_seq;
    if (t.isEmpty) {
      setState(() => hits = []);
      return;
    }
    setState(() => searching = true);
    try {
      final r = await AppScope.read(context).api.searchWiki(t, spaceId: widget.spaceId);
      if (!mounted || seq != _seq) return;
      setState(() {
        hits = r;
        searching = false;
        error = null;
      });
    } catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() {
        searching = false;
        error = describeError(e);
      });
    }
  }

  /// 把 <em>…</em> 高亮渲染成蓝色加粗。
  Widget _snippet(String s) {
    final spans = <TextSpan>[];
    final re = RegExp(r'<em>(.*?)</em>');
    var last = 0;
    for (final m in re.allMatches(s)) {
      spans.add(TextSpan(text: s.substring(last, m.start)));
      spans.add(TextSpan(text: m.group(1), style: const TextStyle(color: Fs.primary, fontWeight: FontWeight.w600)));
      last = m.end;
    }
    spans.add(TextSpan(text: s.substring(last)));
    return Text.rich(TextSpan(children: spans), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text2, height: 1.4));
  }

  @override
  Widget build(BuildContext context) => Dialog(
        alignment: Alignment.topCenter,
        insetPadding: const EdgeInsets.only(top: 80, left: 24, right: 24, bottom: 24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 620, maxHeight: 560),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
              child: TextField(
                controller: q,
                autofocus: true,
                onChanged: _changed,
                onSubmitted: (_) => _search(),
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.search_rounded, size: 20),
                  hintText: widget.spaceId == null ? '搜索知识库' : '在「${widget.spaceName ?? ''}」中搜索',
                ),
              ),
            ),
            const Divider(),
            Flexible(
              child: searching && hits.isEmpty
                  ? const Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator(strokeWidth: 2))
                  : error != null
                      ? Padding(padding: const EdgeInsets.all(32), child: Text(error!, style: const TextStyle(color: Fs.red)))
                      : hits.isEmpty
                          ? Padding(
                              padding: const EdgeInsets.all(32),
                              child: Text(q.text.trim().isEmpty ? '输入关键词，搜索页面标题和正文' : '没有找到相关页面',
                                  style: const TextStyle(color: Fs.text3, fontSize: 13)),
                            )
                          : ListView(shrinkWrap: true, padding: const EdgeInsets.all(8), children: [
                              for (final h in hits)
                                HoverBox(
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                                  onTap: () => Navigator.pop(
                                    context,
                                    CosWikiNode(
                                      nodeId: h.id,
                                      spaceId: (h.raw['space_id'] ?? widget.spaceId ?? '').toString(),
                                      title: h.title,
                                      spaceName: h.raw['space_name']?.toString(),
                                    ),
                                  ),
                                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                    const Padding(padding: EdgeInsets.only(top: 2), child: Icon(Icons.article_outlined, size: 18, color: Fs.primary)),
                                    const SizedBox(width: 10),
                                    Expanded(
                                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                        _snippet(h.title.isEmpty ? '未命名页面' : h.title).copyWithStyle(),
                                        if (h.snippet.isNotEmpty) ...[const SizedBox(height: 3), _snippet(h.snippet)],
                                        if (h.raw['space_name'] != null || h.raw['path'] != null) ...[
                                          const SizedBox(height: 3),
                                          Text(
                                            [h.raw['space_name'], h.raw['path']].whereType<Object>().join(' / '),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(fontSize: 11, color: Fs.text3),
                                          ),
                                        ],
                                      ]),
                                    ),
                                  ]),
                                ),
                            ]),
            ),
          ]),
        ),
      );
}

extension on Widget {
  /// 标题行：字号放大一点。
  Widget copyWithStyle() => DefaultTextStyle.merge(style: const TextStyle(fontSize: 14, color: Fs.text1), child: this);
}

// ---------------- 空间页 ----------------

class SpaceView extends StatefulWidget {
  final CosWikiSpace space;
  final String? initialNode;
  final VoidCallback onBack;
  final ValueChanged<CosWikiSpace> onSpaceChanged;
  final VoidCallback onSpaceDeleted;
  const SpaceView({
    super.key,
    required this.space,
    this.initialNode,
    required this.onBack,
    required this.onSpaceChanged,
    required this.onSpaceDeleted,
  });
  @override
  State<SpaceView> createState() => _SpaceViewState();
}

class _SpaceViewState extends State<SpaceView> {
  final _tree = GlobalKey<WikiTreeState>();
  CosWikiNode? node;
  List<CosWikiNode> ancestors = [];
  String? nodeError;
  late final AppState _s = AppScope.read(context);
  StreamSubscription<CosEvent>? _sub;
  bool treeOpen = true;

  CosWikiSpace get sp => widget.space;
  String get topic => 'wiki:${sp.spaceId}';

  @override
  void initState() {
    super.initState();
    _s.subscribe(topic);
    _sub = _s.eventStream.listen(_onEvent);
    if (widget.initialNode != null) _open(widget.initialNode!);
  }

  @override
  void dispose() {
    _sub?.cancel();
    _s.unsubscribe(topic);
    super.dispose();
  }

  void _onEvent(CosEvent e) {
    if (e.str('space_id') != sp.spaceId) return;
    switch (e.eventType) {
      case 'wiki.node_changed':
        _tree.currentState?.refreshLoaded();
        final id = e.str('node_id');
        final action = e.str('action');
        if (id != null && id == node?.nodeId) {
          if (action == 'deleted' || (action == 'moved' && e.str('to_space_id') != null && e.str('to_space_id') != sp.spaceId)) {
            showToast(context, '当前页面已被删除或移走', error: true);
            setState(() => node = null);
          } else {
            _refreshCrumbs(id);
          }
        }
      case 'wiki.space_changed':
        _s.api.getSpace(sp.spaceId).then(widget.onSpaceChanged).catchError((Object _) {
          if (mounted) {
            showToast(context, '你已无法访问这个知识空间', error: true);
            widget.onSpaceDeleted();
          }
        });
      case 'resync.required':
        _tree.currentState?.refreshLoaded();
    }
  }

  Future<void> _open(String nodeId) async {
    setState(() => nodeError = null);
    try {
      final r = await Future.wait([_s.api.getNode(nodeId), _s.api.nodeAncestors(nodeId).catchError((Object _) => <CosWikiNode>[])]);
      if (!mounted) return;
      final n = r[0] as CosWikiNode;
      final anc = (r[1] as List<CosWikiNode>).where((a) => a.nodeId != n.nodeId).toList();
      setState(() {
        node = n;
        ancestors = anc;
      });
      // 展开目录到这个页面
      await _tree.currentState?.reveal(anc);
    } catch (e) {
      if (mounted) setState(() => nodeError = describeError(e));
    }
  }

  Future<void> _refreshCrumbs(String nodeId) async {
    try {
      final r = await Future.wait([_s.api.getNode(nodeId), _s.api.nodeAncestors(nodeId)]);
      if (!mounted || node?.nodeId != nodeId) return;
      setState(() {
        node = r[0] as CosWikiNode;
        ancestors = (r[1] as List<CosWikiNode>).where((a) => a.nodeId != nodeId).toList();
      });
    } catch (_) {}
  }

  /// 新建页面。手机上目录在抽屉里，抽屉没打开时目录树不存在：直接建好再打开（目录打开时会重新加载）。
  bool _creatingPage = false;

  Future<void> _createPage({String? parentId}) async {
    if (_creatingPage || !sp.canEdit) return;
    _creatingPage = true;
    try {
      final tree = _tree.currentState;
      if (tree != null) {
        await tree.createPage(parentId: parentId);
      } else {
        final n = await _s.api.createNode(sp.spaceId, parentId: parentId, title: '未命名页面');
        if (mounted) await _open(n.nodeId);
      }
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      _creatingPage = false;
    }
  }

  void _openNode(CosWikiNode n, {bool closeDrawer = false}) {
    if (closeDrawer) Navigator.of(context).maybePop();
    if (n.nodeId == node?.nodeId) return;
    _open(n.nodeId);
  }

  Future<void> _spaceAction(String v) async {
    switch (v) {
      case 'settings':
        final r = await showSpaceEditor(context, space: sp);
        if (r != null) widget.onSpaceChanged(r);
      case 'members':
        await showSpaceMembers(context, sp);
        try {
          widget.onSpaceChanged(await _s.api.getSpace(sp.spaceId));
        } catch (_) {}
      case 'import':
        final d = await _pickDoc();
        if (d == null) return;
        try {
          final n = await _s.api.importDocToWiki(sp.spaceId, d.docId, parentId: node?.nodeId);
          await _tree.currentState?.load(node?.nodeId);
          if (node != null) await _tree.currentState?.reveal([...ancestors, node!]);
          _open(n.nodeId);
          if (mounted) showToast(context, '已把「${d.title}」移入知识库');
        } catch (e) {
          if (mounted) showToast(context, describeError(e), error: true);
        }
      case 'delete':
        final ok = await confirmDialog(context,
            title: '删除知识空间', content: '「${sp.name}」和里面的 ${sp.pageCount} 个页面会一起移到回收站，30 天内可在回收站恢复。', ok: '删除', danger: true);
        if (!ok) return;
        try {
          await _s.api.deleteSpace(sp.spaceId);
          if (mounted) showToast(context, '已删除知识空间');
          widget.onSpaceDeleted();
        } catch (e) {
          if (mounted) showToast(context, describeError(e), error: true);
        }
    }
  }

  Future<CosDoc?> _pickDoc() async {
    List<CosDoc> docs;
    try {
      docs = (await _s.api.listDocs()).where((d) => d.wikiSpaceId == null && d.owner == _s.me.userId).toList();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
      return null;
    }
    if (!mounted) return null;
    return showDialog<CosDoc>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('把云文档移入知识库'),
        content: SizedBox(
          width: 420,
          height: 360,
          child: docs.isEmpty
              ? const Center(child: Text('没有可移入的文档（只能移入自己创建的文档）', style: TextStyle(color: Fs.text3)))
              : ListView(children: [
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(node == null ? '会放到空间的第一层' : '会放到「${node!.title}」下面',
                        style: const TextStyle(fontSize: 12, color: Fs.text3)),
                  ),
                  for (final d in docs)
                    HoverBox(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                      onTap: () => Navigator.pop(ctx, d),
                      child: Row(children: [
                        const DocIcon(size: 26),
                        const SizedBox(width: 10),
                        Expanded(child: Text(d.title, maxLines: 1, overflow: TextOverflow.ellipsis)),
                        Text(fmtRelative(d.updatedAt), style: const TextStyle(fontSize: 12, color: Fs.text3)),
                      ]),
                    ),
                ]),
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消'))],
      ),
    );
  }

  Widget _sidebar({bool drawer = false}) => Container(
        color: const Color(0xFFF8F9FA),
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 10, 8, 6),
            child: Row(children: [
              FsIconButton(icon: Icons.arrow_back_ios_new_rounded, size: 16, tooltip: '返回知识库首页', onPressed: widget.onBack),
              const SizedBox(width: 2),
              SpaceAvatar(sp, size: 26),
              const SizedBox(width: 8),
              Expanded(
                child: Text(sp.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
              ),
              PopupMenuButton<String>(
                tooltip: '空间设置',
                icon: const Icon(Icons.more_horiz_rounded, size: 18),
                onSelected: _spaceAction,
                itemBuilder: (_) => [
                  if (sp.isAdmin) const PopupMenuItem(value: 'settings', child: Text('空间设置')),
                  PopupMenuItem(value: 'members', child: Text(sp.isAdmin ? '成员与权限' : '查看成员')),
                  if (sp.canEdit) const PopupMenuItem(value: 'import', child: Text('移入云文档')),
                  if (sp.isAdmin) ...[
                    const PopupMenuDivider(),
                    const PopupMenuItem(value: 'delete', child: Text('删除空间', style: TextStyle(color: Fs.red))),
                  ],
                ],
              ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: HoverBox(
              onTap: () async {
                final hit = await showWikiSearch(context, spaceId: sp.spaceId, spaceName: sp.name);
                if (hit != null) _openNode(hit, closeDrawer: drawer);
              },
              hoverColor: Colors.white,
              child: Container(
                height: 34,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(Fs.radius), border: Border.all(color: Fs.line)),
                child: const Row(children: [
                  Icon(Icons.search_rounded, size: 16, color: Fs.text3),
                  SizedBox(width: 6),
                  Text('搜索本空间', style: TextStyle(fontSize: 13, color: Fs.text3)),
                ]),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 8, 4),
            child: Row(children: [
              const Expanded(child: Text('目录', style: TextStyle(fontSize: 12, color: Fs.text3))),
              if (sp.canEdit)
                FsIconButton(
                  icon: Icons.add_rounded,
                  size: 18,
                  tooltip: '新建页面',
                  onPressed: _createPage,
                ),
            ]),
          ),
          Expanded(
            child: WikiTree(
              key: _tree,
              space: sp,
              selected: node?.nodeId,
              onOpen: (n) => _openNode(n, closeDrawer: drawer),
              onRemoved: (id) {
                if (id == node?.nodeId || ancestors.any((a) => a.nodeId == id)) setState(() => node = null);
              },
            ),
          ),
          if (!sp.canEdit)
            const Padding(
              padding: EdgeInsets.all(12),
              child: Text('你在这个空间只能阅读', style: TextStyle(fontSize: 12, color: Fs.text3)),
            ),
        ]),
      );

  Widget _crumbs(bool showMenuButton) {
    final items = <(String, String?)>[(sp.name, null), for (final a in ancestors) (a.title, a.nodeId), if (node != null) (node!.title, node!.nodeId)];
    return Row(children: [
      if (showMenuButton)
        Builder(
          builder: (ctx) => FsIconButton(icon: Icons.menu_rounded, tooltip: '目录', onPressed: () => Scaffold.of(ctx).openDrawer()),
        ),
      Flexible(
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          reverse: true,
          child: Row(children: [
            for (var i = 0; i < items.length; i++) ...[
              if (i > 0) const Icon(Icons.chevron_right_rounded, size: 16, color: Fs.text3),
              HoverBox(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 3),
                onTap: i == items.length - 1
                    ? null
                    : items[i].$2 == null
                        ? () => setState(() => node = null)
                        : () => _open(items[i].$2!),
                child: Text(
                  items[i].$1.isEmpty ? '未命名页面' : items[i].$1,
                  style: TextStyle(fontSize: 13, color: i == items.length - 1 ? Fs.text1 : Fs.text2, fontWeight: i == items.length - 1 ? FontWeight.w500 : null),
                ),
              ),
            ],
          ]),
        ),
      ),
    ]);
  }

  Widget _content(bool narrow) {
    if (nodeError != null) {
      return Column(children: [
        SizedBox(height: 52, child: Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: _crumbs(narrow))),
        Expanded(
          child: EmptyState(
            icon: Icons.error_outline_rounded,
            title: '页面打开失败',
            subtitle: nodeError,
            action: OutlinedButton(onPressed: () => setState(() => nodeError = null), child: const Text('返回空间首页')),
          ),
        ),
      ]);
    }
    final n = node;
    if (n == null) return _spaceHome(narrow);
    if (n.objType != 'doc') {
      return Column(children: [
        SizedBox(height: 52, child: Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: _crumbs(narrow))),
        Expanded(
          child: EmptyState(
            icon: Icons.grid_view_rounded,
            title: n.title,
            subtitle: '这是一个多维表格视图，在多维表格模块中打开',
            action: FilledButton(onPressed: () => _s.openTarget({'type': 'table', 'id': n.objId}), child: const Text('打开多维表格')),
          ),
        ),
      ]);
    }
    return DocEditor(
      key: ValueKey(n.objId),
      docId: n.objId,
      wikiPage: true,
      header: _crumbs(narrow),
      onSaved: () {
        // 标题改了要同步到目录树和面包屑
        _tree.currentState?.load(n.parentId);
        _refreshCrumbs(n.nodeId);
      },
      extraMenu: [
        DocMenuItem(n.starred ? '取消收藏' : '收藏', n.starred ? Icons.star_rounded : Icons.star_outline_rounded, () async {
          await _tree.currentState?.nodeAction(n, 'star');
          setState(() => node = n.copyWith(starred: !n.starred));
        }),
        if (sp.canEdit) ...[
          DocMenuItem('新建子页面', Icons.note_add_outlined, () => _createPage(parentId: n.nodeId)),
          DocMenuItem('移动到', Icons.drive_file_move_outline, () => _tree.currentState?.nodeAction(n, 'move')),
          DocMenuItem('创建副本', Icons.copy_all_rounded, () => _tree.currentState?.nodeAction(n, 'copy')),
          DocMenuItem('删除页面', Icons.delete_outline_rounded, () => _tree.currentState?.nodeAction(n, 'delete'), danger: true),
        ],
      ],
    );
  }

  Widget _spaceHome(bool narrow) => Column(children: [
        SizedBox(height: 52, child: Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: _crumbs(narrow))),
        const Divider(),
        Expanded(
          child: ListView(padding: EdgeInsets.fromLTRB(narrow ? 20 : 48, 32, narrow ? 20 : 48, 32), children: [
            Row(children: [
              SpaceAvatar(sp, size: 56),
              const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(sp.name, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text('${sp.pageCount} 个页面 · ${kSpaceVisibility[sp.visibility] ?? ''}', style: const TextStyle(fontSize: 13, color: Fs.text3)),
                ]),
              ),
            ]),
            if (sp.description.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text(sp.description, style: const TextStyle(fontSize: 14, color: Fs.text2, height: 1.6)),
            ],
            const SizedBox(height: 28),
            Wrap(spacing: 12, runSpacing: 12, children: [
              if (sp.canEdit)
                FilledButton.icon(
                  onPressed: _createPage,
                  icon: const Icon(Icons.add_rounded, size: 18),
                  label: const Text('新建页面'),
                ),
              if (sp.canEdit)
                OutlinedButton.icon(
                  onPressed: () => _spaceAction('import'),
                  icon: const Icon(Icons.drive_file_move_outline, size: 18),
                  label: const Text('移入云文档'),
                ),
              OutlinedButton.icon(
                onPressed: () => _spaceAction('members'),
                icon: const Icon(Icons.group_outlined, size: 18),
                label: Text(sp.isAdmin ? '成员与权限' : '查看成员'),
              ),
            ]),
            const SizedBox(height: 28),
            const Text('从左侧目录选择一个页面开始阅读', style: TextStyle(fontSize: 13, color: Fs.text3)),
          ]),
        ),
      ]);

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, c) {
        final narrow = c.maxWidth < 860;
        if (narrow) {
          return Scaffold(
            backgroundColor: Colors.white,
            drawer: Drawer(width: 300, shape: const RoundedRectangleBorder(), child: SafeArea(child: _sidebar(drawer: true))),
            body: _content(true),
          );
        }
        return Row(children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            width: treeOpen ? 272 : 0,
            child: treeOpen ? _sidebar() : null,
          ),
          if (treeOpen) const VerticalDivider(width: 1),
          Expanded(
            child: Stack(children: [
              Positioned.fill(child: _content(false)),
              Positioned(
                left: 0,
                bottom: 16,
                child: Material(
                  color: Colors.white,
                  elevation: 2,
                  shape: const RoundedRectangleBorder(borderRadius: BorderRadius.horizontal(right: Radius.circular(14))),
                  child: InkWell(
                    onTap: () => setState(() => treeOpen = !treeOpen),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(4, 6, 6, 6),
                      child: Icon(treeOpen ? Icons.chevron_left_rounded : Icons.chevron_right_rounded, size: 18, color: Fs.text2),
                    ),
                  ),
                ),
              ),
            ]),
          ),
        ]);
      });
}
