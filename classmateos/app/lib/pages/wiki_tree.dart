/// 知识库目录树（R-WK-02）：懒加载、悬停「+」和「…」、拖拽调整顺序和层级；
/// 以及知识空间的新建 / 设置弹窗、「移动到」选择器。
library;

import 'package:flutter/material.dart';

import '../api/phase2_docs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/share_panel.dart';

// ---------------- 空间外观 ----------------

const kSpaceIcons = <String, IconData>{
  'book': Icons.menu_book_rounded,
  'school': Icons.school_rounded,
  'inventory': Icons.inventory_2_rounded,
  'science': Icons.science_rounded,
  'robot': Icons.smart_toy_rounded,
  'idea': Icons.lightbulb_rounded,
  'rocket': Icons.rocket_launch_rounded,
  'folder': Icons.folder_rounded,
};

const kSpaceColors = <String, Color>{
  'blue': Fs.primary,
  'green': Color(0xFF2EA121),
  'orange': Fs.orange,
  'purple': Fs.purple,
  'red': Fs.red,
  'cyan': Fs.cyan,
  'turquoise': Fs.teal,
  'carmine': Fs.violet,
};

IconData spaceIcon(String k) => kSpaceIcons[k] ?? Icons.menu_book_rounded;
Color spaceColor(String k) => kSpaceColors[k] ?? Fs.primary;

class SpaceAvatar extends StatelessWidget {
  final CosWikiSpace space;
  final double size;
  const SpaceAvatar(this.space, {super.key, this.size = 32});
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: spaceColor(space.color), borderRadius: BorderRadius.circular(size * 0.25)),
        child: Icon(spaceIcon(space.icon), size: size * 0.58, color: Colors.white),
      );
}

const kSpaceVisibility = {'org': '组织内所有人可阅读', 'members': '仅空间成员可访问'};

// ---------------- 新建 / 设置空间 ----------------

/// 新建（space == null）或编辑空间基本信息；返回保存后的空间，取消返回 null。
Future<CosWikiSpace?> showSpaceEditor(BuildContext context, {CosWikiSpace? space}) =>
    showScopedDialog<CosWikiSpace>(context, (_) => _SpaceEditor(space: space));

class _SpaceEditor extends StatefulWidget {
  final CosWikiSpace? space;
  const _SpaceEditor({this.space});
  @override
  State<_SpaceEditor> createState() => _SpaceEditorState();
}

class _SpaceEditorState extends State<_SpaceEditor> {
  late final name = TextEditingController(text: widget.space?.name ?? '');
  late final desc = TextEditingController(text: widget.space?.description ?? '');
  late String icon = widget.space?.icon ?? 'book';
  late String color = widget.space?.color ?? 'blue';
  late String visibility = widget.space?.visibility ?? 'org';
  String? nameError;
  bool saving = false;

  @override
  void dispose() {
    name.dispose();
    desc.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final n = name.text.trim();
    if (n.isEmpty) {
      setState(() => nameError = '请填写空间名称');
      return;
    }
    setState(() => saving = true);
    final api = AppScope.read(context).api;
    final body = {'name': n, 'description': desc.text.trim(), 'icon': icon, 'color': color, 'visibility': visibility};
    try {
      final s = widget.space == null ? await api.createSpace(body) : await api.updateSpace(widget.space!.spaceId, body);
      if (mounted) Navigator.pop(context, s);
    } catch (e) {
      if (!mounted) return;
      setState(() => saving = false);
      showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final preview = CosWikiSpace(spaceId: '', name: name.text, icon: icon, color: color);
    return AlertDialog(
      title: Text(widget.space == null ? '新建知识空间' : '空间设置'),
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SpaceAvatar(preview, size: 44),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  controller: name,
                  autofocus: widget.space == null,
                  maxLength: 30,
                  onChanged: (_) => setState(() => nameError = null),
                  decoration: InputDecoration(labelText: '空间名称', errorText: nameError),
                ),
              ),
            ]),
            const SizedBox(height: 6),
            TextField(controller: desc, maxLines: 2, maxLength: 120, decoration: const InputDecoration(labelText: '简介（选填）')),
            const SizedBox(height: 8),
            const Text('图标', style: TextStyle(fontSize: 13, color: Fs.text2)),
            const SizedBox(height: 6),
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final e in kSpaceIcons.entries)
                HoverBox(
                  selected: icon == e.key,
                  selectedColor: Fs.primaryLight,
                  padding: const EdgeInsets.all(6),
                  onTap: () => setState(() => icon = e.key),
                  child: Icon(e.value, size: 22, color: icon == e.key ? Fs.primary : Fs.text2),
                ),
            ]),
            const SizedBox(height: 12),
            const Text('封面色', style: TextStyle(fontSize: 13, color: Fs.text2)),
            const SizedBox(height: 6),
            Wrap(spacing: 8, children: [
              for (final e in kSpaceColors.entries)
                GestureDetector(
                  onTap: () => setState(() => color = e.key),
                  child: Container(
                    width: 26,
                    height: 26,
                    decoration: BoxDecoration(
                      color: e.value,
                      shape: BoxShape.circle,
                      border: Border.all(color: color == e.key ? Fs.text1 : Colors.transparent, width: 2),
                    ),
                    child: color == e.key ? const Icon(Icons.check_rounded, size: 16, color: Colors.white) : null,
                  ),
                ),
            ]),
            const SizedBox(height: 14),
            const Text('可见范围', style: TextStyle(fontSize: 13, color: Fs.text2)),
            RadioGroup<String>(
              groupValue: visibility,
              onChanged: (v) => setState(() => visibility = v ?? visibility),
              child: Column(children: [
                for (final e in kSpaceVisibility.entries)
                  RadioListTile<String>(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    value: e.key,
                    title: Text(e.value, style: const TextStyle(fontSize: 13)),
                  ),
              ]),
            ),
          ]),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: saving ? null : _save, child: Text(widget.space == null ? '创建' : '保存')),
      ],
    );
  }
}

/// 空间成员与角色（R-WK-01）。
Future<void> showSpaceMembers(BuildContext context, CosWikiSpace sp) {
  final api = AppScope.read(context).api;
  return showSharePanel(
    context,
    ShareConfig(
      title: '「${sp.name}」成员',
      load: () => api.spaceMembers(sp.spaceId),
      save: (s) => api.saveSpaceMembers(sp.spaceId, s),
      roles: kSpaceRoles,
      defaultRole: 'editor',
      linkOptions: kSpaceVisibility,
      linkTitle: '可见范围',
      canManage: sp.isAdmin,
    ),
  );
}

// ---------------- 移动到 ----------------

/// 选择目标位置：空间 + 父页面（null = 空间第一层）。
Future<({String spaceId, String? parentId, String label})?> pickWikiLocation(
  BuildContext context, {
  required String title,
  required String initialSpace,
  String? excludeNode,
}) =>
    showScopedDialog(context, (_) => _LocationPicker(title: title, initialSpace: initialSpace, exclude: excludeNode));

class _LocationPicker extends StatefulWidget {
  final String title;
  final String initialSpace;
  final String? exclude;
  const _LocationPicker({required this.title, required this.initialSpace, this.exclude});
  @override
  State<_LocationPicker> createState() => _LocationPickerState();
}

class _LocationPickerState extends State<_LocationPicker> {
  List<CosWikiSpace> spaces = [];
  late String space = widget.initialSpace;
  final Map<String?, List<CosWikiNode>> children = {};
  final Set<String> expanded = {};
  String? parent;
  String parentLabel = '';

  @override
  void initState() {
    super.initState();
    AppScope.read(context).api.listSpaces().then((v) {
      if (mounted) setState(() => spaces = v.where((s) => s.canEdit).toList());
    }).catchError((Object _) {});
    _fetch(null);
  }

  Future<void> _fetch(String? p) async {
    try {
      final list = await AppScope.read(context).api.listNodes(space, parentId: p);
      if (mounted) setState(() => children[p] = list.where((n) => n.nodeId != widget.exclude).toList());
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  String get spaceName => spaces.where((s) => s.spaceId == space).firstOrNull?.name ?? '';

  List<Widget> _rows(String? p, int depth) => [
        for (final n in children[p] ?? const <CosWikiNode>[]) ...[
          HoverBox(
            selected: parent == n.nodeId,
            selectedColor: Fs.primaryLight,
            padding: EdgeInsets.only(left: 6.0 + depth * 18, right: 8, top: 6, bottom: 6),
            onTap: () => setState(() {
              parent = n.nodeId;
              parentLabel = n.title;
            }),
            child: Row(children: [
              SizedBox(
                width: 20,
                child: n.hasChildren
                    ? InkWell(
                        onTap: () {
                          setState(() => expanded.contains(n.nodeId) ? expanded.remove(n.nodeId) : expanded.add(n.nodeId));
                          if (!children.containsKey(n.nodeId)) _fetch(n.nodeId);
                        },
                        child: Icon(expanded.contains(n.nodeId) ? Icons.expand_more_rounded : Icons.chevron_right_rounded,
                            size: 18, color: Fs.text3),
                      )
                    : null,
              ),
              const Icon(Icons.article_outlined, size: 16, color: Fs.text2),
              const SizedBox(width: 6),
              Expanded(child: Text(n.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
            ]),
          ),
          if (expanded.contains(n.nodeId)) ..._rows(n.nodeId, depth + 1),
        ],
      ];

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        content: SizedBox(
          width: 420,
          height: 380,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (spaces.length > 1)
              DropdownButtonFormField<String>(
                initialValue: spaces.any((s) => s.spaceId == space) ? space : null,
                decoration: const InputDecoration(isDense: true, labelText: '知识空间'),
                items: [for (final s in spaces) DropdownMenuItem(value: s.spaceId, child: Text(s.name))],
                onChanged: (v) {
                  if (v == null || v == space) return;
                  setState(() {
                    space = v;
                    children.clear();
                    expanded.clear();
                    parent = null;
                  });
                  _fetch(null);
                },
              ),
            const SizedBox(height: 8),
            Expanded(
              child: ListView(children: [
                HoverBox(
                  selected: parent == null,
                  selectedColor: Fs.primaryLight,
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                  onTap: () => setState(() => parent = null),
                  child: Text('「$spaceName」第一层', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                ),
                if (!children.containsKey(null)) const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator(strokeWidth: 2))),
                ..._rows(null, 1),
              ]),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(context, (spaceId: space, parentId: parent, label: parent == null ? spaceName : parentLabel)),
            child: const Text('移动到这里'),
          ),
        ],
      );
}

// ---------------- 目录树 ----------------

enum WikiDrop { before, inside, after }

class WikiTree extends StatefulWidget {
  final CosWikiSpace space;
  final String? selected;
  final ValueChanged<CosWikiNode> onOpen;

  /// 当前页面被删除 / 移走时通知外层。
  final ValueChanged<String>? onRemoved;
  const WikiTree({super.key, required this.space, this.selected, required this.onOpen, this.onRemoved});
  @override
  State<WikiTree> createState() => WikiTreeState();
}

class WikiTreeState extends State<WikiTree> {
  final Map<String?, List<CosWikiNode>> children = {};
  final Set<String> expanded = {};
  final Set<String?> loading = {};
  String? error;

  // 拖拽指示
  String? dropOn;
  WikiDrop? dropZone;

  AppState get app => AppScope.read(context);
  bool get canEdit => widget.space.canEdit;

  @override
  void initState() {
    super.initState();
    load(null);
  }

  Future<void> load(String? parent) async {
    loading.add(parent);
    try {
      final list = await app.api.listNodes(widget.space.spaceId, parentId: parent);
      if (!mounted) return;
      setState(() {
        children[parent] = list;
        loading.remove(parent);
        if (parent == null) error = null;
        // 父节点的 has_children 以实际结果为准
        if (parent != null) _patch(parent, (n) => n.copyWith(hasChildren: list.isNotEmpty));
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        loading.remove(parent);
        if (parent == null) error = describeError(e);
      });
    }
  }

  /// 刷新所有已加载的层级（实时事件、移动之后）。
  Future<void> refreshLoaded() => Future.wait([for (final k in children.keys.toList()) load(k)]);

  CosWikiNode? find(String id) {
    for (final l in children.values) {
      for (final n in l) {
        if (n.nodeId == id) return n;
      }
    }
    return null;
  }

  void _patch(String id, CosWikiNode Function(CosWikiNode) f) {
    for (final e in children.entries) {
      final i = e.value.indexWhere((n) => n.nodeId == id);
      if (i >= 0) e.value[i] = f(e.value[i]);
    }
  }

  /// 展开到某个节点（搜索结果、通知跳转）：传入祖先链（根 → 父）。
  Future<void> reveal(List<CosWikiNode> ancestors) async {
    for (final a in ancestors) {
      expanded.add(a.nodeId);
      if (!children.containsKey(a.nodeId)) await load(a.nodeId);
    }
    if (mounted) setState(() {});
  }

  void toggle(CosWikiNode n) {
    setState(() => expanded.contains(n.nodeId) ? expanded.remove(n.nodeId) : expanded.add(n.nodeId));
    if (expanded.contains(n.nodeId) && !children.containsKey(n.nodeId)) load(n.nodeId);
  }

  bool _isDescendant(String nodeId, String? maybeChild) {
    var p = maybeChild;
    while (p != null) {
      if (p == nodeId) return true;
      p = find(p)?.parentId;
    }
    return false;
  }

  Future<void> createPage({String? parentId}) async {
    try {
      final n = await app.api.createNode(widget.space.spaceId, parentId: parentId, title: '未命名页面');
      if (parentId != null) expanded.add(parentId);
      await load(parentId);
      widget.onOpen(n);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _move(CosWikiNode n, {required String spaceId, String? parentId, String? afterId}) async {
    try {
      await app.api.moveNode(n.nodeId, spaceId: spaceId, parentId: parentId, afterNodeId: afterId);
      if (parentId != null) expanded.add(parentId);
      await Future.wait([load(n.parentId), load(parentId), ...[for (final k in children.keys.toList()) if (k != n.parentId && k != parentId) load(k)]]);
      if (spaceId != widget.space.spaceId) {
        widget.onRemoved?.call(n.nodeId);
        if (mounted) showToast(context, '已移动到其他知识空间');
      }
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _onDrop(CosWikiNode dragged, CosWikiNode target, WikiDrop zone) async {
    if (dragged.nodeId == target.nodeId || _isDescendant(dragged.nodeId, target.nodeId)) return;
    switch (zone) {
      case WikiDrop.inside:
        final kids = children[target.nodeId];
        final last = kids?.where((k) => k.nodeId != dragged.nodeId).lastOrNull;
        await _move(dragged, spaceId: widget.space.spaceId, parentId: target.nodeId, afterId: last?.nodeId);
      case WikiDrop.after:
        await _move(dragged, spaceId: widget.space.spaceId, parentId: target.parentId, afterId: target.nodeId);
      case WikiDrop.before:
        final sib = (children[target.parentId] ?? const <CosWikiNode>[]).where((k) => k.nodeId != dragged.nodeId).toList();
        final i = sib.indexWhere((k) => k.nodeId == target.nodeId);
        await _move(dragged, spaceId: widget.space.spaceId, parentId: target.parentId, afterId: i > 0 ? sib[i - 1].nodeId : null);
    }
  }

  Future<void> _rename(CosWikiNode n) async {
    final ctl = TextEditingController(text: n.title);
    final t = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重命名'),
        content: SizedBox(
          width: 360,
          child: TextField(controller: ctl, autofocus: true, maxLength: 80, onSubmitted: (v) => Navigator.pop(ctx, v)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text), child: const Text('确定')),
        ],
      ),
    );
    ctl.dispose();
    final title = t?.trim();
    if (title == null || title.isEmpty || title == n.title) return;
    try {
      final r = await app.api.renameNode(n.nodeId, title);
      setState(() => _patch(n.nodeId, (x) => x.copyWith(title: r.title)));
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> nodeAction(CosWikiNode n, String action) async {
    switch (action) {
      case 'add':
        await createPage(parentId: n.nodeId);
      case 'rename':
        await _rename(n);
      case 'move':
        final to = await pickWikiLocation(context, title: '移动「${n.title}」到', initialSpace: widget.space.spaceId, excludeNode: n.nodeId);
        if (to == null) return;
        final last = to.spaceId == widget.space.spaceId ? children[to.parentId]?.where((k) => k.nodeId != n.nodeId).lastOrNull : null;
        await _move(n, spaceId: to.spaceId, parentId: to.parentId, afterId: last?.nodeId);
      case 'copy':
      case 'copy_all':
        try {
          final c = await app.api.copyNode(n.nodeId, withChildren: action == 'copy_all');
          await load(n.parentId);
          widget.onOpen(c);
          if (mounted) showToast(context, '已创建副本');
        } catch (e) {
          if (mounted) showToast(context, describeError(e), error: true);
        }
      case 'star':
        try {
          await app.api.starNode(n.nodeId, !n.starred);
          setState(() => _patch(n.nodeId, (x) => x.copyWith(starred: !n.starred)));
          if (mounted) showToast(context, n.starred ? '已取消收藏' : '已收藏');
        } catch (e) {
          if (mounted) showToast(context, describeError(e), error: true);
        }
      case 'delete':
        final ok = await confirmDialog(context,
            title: '删除页面',
            content: n.hasChildren ? '「${n.title}」和它的所有子页面都会移到回收站。' : '「${n.title}」会移到回收站。',
            ok: '删除',
            danger: true);
        if (!ok) return;
        try {
          await app.api.deleteNode(n.nodeId);
          await load(n.parentId);
          widget.onRemoved?.call(n.nodeId);
        } catch (e) {
          if (mounted) showToast(context, describeError(e), error: true);
        }
    }
  }

  List<PopupMenuEntry<String>> menuItems(CosWikiNode n) => [
        if (canEdit) const PopupMenuItem(value: 'add', child: Text('新建子页面')),
        if (canEdit) const PopupMenuItem(value: 'rename', child: Text('重命名')),
        PopupMenuItem(value: 'star', child: Text(n.starred ? '取消收藏' : '收藏')),
        if (canEdit) ...[
          const PopupMenuItem(value: 'move', child: Text('移动到')),
          const PopupMenuItem(value: 'copy', child: Text('创建副本')),
          if (n.hasChildren) const PopupMenuItem(value: 'copy_all', child: Text('创建副本（含子页面）')),
          const PopupMenuDivider(),
          const PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(color: Fs.red))),
        ],
      ];

  @override
  Widget build(BuildContext context) {
    if (error != null) {
      return EmptyState(
        icon: Icons.account_tree_outlined,
        title: '目录加载失败',
        subtitle: error,
        action: OutlinedButton(onPressed: () => load(null), child: const Text('重试')),
      );
    }
    if (!children.containsKey(null)) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    final rows = <Widget>[];
    void walk(String? parent, int depth) {
      for (final n in children[parent] ?? const <CosWikiNode>[]) {
        rows.add(_row(n, depth));
        if (expanded.contains(n.nodeId)) {
          if (loading.contains(n.nodeId) && !children.containsKey(n.nodeId)) {
            rows.add(Padding(
              padding: EdgeInsets.only(left: 30.0 + depth * 16, top: 4, bottom: 4),
              child: const Text('加载中…', style: TextStyle(fontSize: 12, color: Fs.text3)),
            ));
          } else {
            walk(n.nodeId, depth + 1);
          }
        }
      }
    }

    walk(null, 0);
    if (rows.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Column(children: [
          const Text('这个空间还没有页面', style: TextStyle(fontSize: 13, color: Fs.text3)),
          if (canEdit) TextButton(onPressed: () => createPage(), child: const Text('新建第一个页面')),
        ]),
      );
    }
    return ListView(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4), children: rows);
  }

  Widget _row(CosWikiNode n, int depth) {
    final sel = n.nodeId == widget.selected;
    final indicator = dropOn == n.nodeId ? dropZone : null;
    Widget content(bool hover) => Container(
          height: 34,
          padding: EdgeInsets.only(left: 4.0 + depth * 16, right: 2),
          decoration: BoxDecoration(
            color: indicator == WikiDrop.inside ? Fs.primaryLight : (sel ? Fs.selected : (hover ? Fs.hover : null)),
            borderRadius: BorderRadius.circular(Fs.radius),
            border: Border(
              top: BorderSide(color: indicator == WikiDrop.before ? Fs.primary : Colors.transparent, width: 2),
              bottom: BorderSide(color: indicator == WikiDrop.after ? Fs.primary : Colors.transparent, width: 2),
            ),
          ),
          child: Row(children: [
            SizedBox(
              width: 22,
              child: n.hasChildren
                  ? InkWell(
                      borderRadius: BorderRadius.circular(4),
                      onTap: () => toggle(n),
                      child: Icon(expanded.contains(n.nodeId) ? Icons.expand_more_rounded : Icons.chevron_right_rounded,
                          size: 18, color: Fs.text3),
                    )
                  : null,
            ),
            Icon(n.objType == 'bitable_view' ? Icons.grid_view_rounded : Icons.article_outlined,
                size: 16, color: sel ? Fs.primary : Fs.text2),
            const SizedBox(width: 6),
            Expanded(
              child: Text(n.title.isEmpty ? '未命名页面' : n.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, color: sel ? Fs.primary : Fs.text1, fontWeight: sel ? FontWeight.w500 : null)),
            ),
            if (hover && canEdit)
              Tooltip(
                message: '新建子页面',
                child: InkWell(
                  borderRadius: BorderRadius.circular(4),
                  onTap: () => createPage(parentId: n.nodeId),
                  child: const Padding(padding: EdgeInsets.all(3), child: Icon(Icons.add_rounded, size: 16, color: Fs.text2)),
                ),
              ),
            if (hover)
              SizedBox(
                width: 24,
                height: 24,
                child: PopupMenuButton<String>(
                  tooltip: '更多',
                  padding: EdgeInsets.zero,
                  iconSize: 16,
                  icon: const Icon(Icons.more_horiz_rounded, size: 16, color: Fs.text2),
                  onSelected: (v) => nodeAction(n, v),
                  itemBuilder: (_) => menuItems(n),
                ),
              ),
          ]),
        );

    final tile = HoverReveal(
      builder: (_, hover) => GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => widget.onOpen(n),
        onDoubleTap: n.hasChildren ? () => toggle(n) : null,
        child: content(hover),
      ),
    );
    if (!canEdit) return tile;
    return DragTarget<CosWikiNode>(
      onWillAcceptWithDetails: (d) => d.data.nodeId != n.nodeId && !_isDescendant(d.data.nodeId, n.nodeId),
      onMove: (d) {
        // 行高 34：用指针纵坐标在行内的位置判断放到前 / 里 / 后
        final rowBox = _rowKeys[n.nodeId]?.currentContext?.findRenderObject();
        if (rowBox is! RenderBox) return;
        final y = rowBox.globalToLocal(d.offset).dy;
        final h = rowBox.size.height;
        final z = y < h * 0.28 ? WikiDrop.before : (y > h * 0.72 ? WikiDrop.after : WikiDrop.inside);
        if (dropOn != n.nodeId || dropZone != z) {
          setState(() {
            dropOn = n.nodeId;
            dropZone = z;
          });
        }
      },
      onLeave: (_) {
        if (dropOn == n.nodeId) setState(() => dropOn = null);
      },
      onAcceptWithDetails: (d) {
        final z = dropZone ?? WikiDrop.inside;
        setState(() => dropOn = null);
        _onDrop(d.data, n, z);
      },
      builder: (_, _, _) => Draggable<CosWikiNode>(
        data: n,
        dragAnchorStrategy: pointerDragAnchorStrategy,
        feedback: Material(
          elevation: 6,
          borderRadius: BorderRadius.circular(6),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.article_outlined, size: 16, color: Fs.text2),
              const SizedBox(width: 6),
              Text(n.title, style: const TextStyle(fontSize: 13)),
            ]),
          ),
        ),
        childWhenDragging: Opacity(opacity: 0.4, child: tile),
        child: KeyedSubtree(key: _rowKeys.putIfAbsent(n.nodeId, GlobalKey.new), child: tile),
      ),
    );
  }

  final Map<String, GlobalKey> _rowKeys = {};
}
