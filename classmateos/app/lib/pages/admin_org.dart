/// 组织架构（R-AD-02）：左侧部门树（多层，拖拽移动、上移下移），右侧部门信息和成员。
/// [loadDepartmentTree] 也给成员管理、通讯录用。
library;

import 'package:flutter/material.dart';

import '../api/phase2_admin.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'admin_page.dart' show AdminHeader, humanUsers;

/// 展平后的部门（前序遍历，带层级）。
class DeptNode {
  final CosDepartment dept;
  final int depth;
  const DeptNode(this.dept, this.depth);
}

/// 拉取整棵部门树（逐层请求，最多 6 层、500 个部门）。
Future<List<DeptNode>> loadDepartmentTree(CosApiClient api) async {
  final out = <DeptNode>[];
  Future<void> walk(String? parent, int depth) async {
    if (depth > 6 || out.length > 500) return;
    for (final d in await api.listDepartments(parentId: parent)) {
      out.add(DeptNode(d, depth));
      if (d.hasChildren) await walk(d.departmentId, depth + 1);
    }
  }

  await walk(null, 0);
  return out;
}

class AdminOrgPane extends StatefulWidget {
  final bool readOnly;
  const AdminOrgPane({super.key, this.readOnly = false});
  @override
  State<AdminOrgPane> createState() => _AdminOrgPaneState();
}

class _AdminOrgPaneState extends State<AdminOrgPane> {
  List<DeptNode>? nodes;
  final Set<String> collapsed = {};
  String? selected;
  String? error;
  String? dropTarget;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final l = await loadDepartmentTree(AppScope.read(context).api);
      if (!mounted) return;
      setState(() {
        nodes = l;
        error = null;
        if (selected == null || !l.any((n) => n.dept.departmentId == selected)) selected = l.firstOrNull?.dept.departmentId;
      });
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  CosDepartment? _dept(String? id) => nodes?.where((n) => n.dept.departmentId == id).firstOrNull?.dept;

  bool _isDescendant(String id, String ofId) {
    String? p = _dept(id)?.parentId;
    while (p != null) {
      if (p == ofId) return true;
      p = _dept(p)?.parentId;
    }
    return false;
  }

  /// 可见行（折叠的部门隐藏下级）。
  List<DeptNode> get _visible {
    final out = <DeptNode>[];
    int? hideBelow;
    for (final n in nodes ?? const <DeptNode>[]) {
      if (hideBelow != null && n.depth > hideBelow) continue;
      hideBelow = null;
      out.add(n);
      if (collapsed.contains(n.dept.departmentId)) hideBelow = n.depth;
    }
    return out;
  }

  Future<void> _run(Future<void> Function() f, [String? ok]) async {
    try {
      await f();
      await _load();
      if (mounted) AppScope.read(context).refreshUsers();
      if (ok != null && mounted) showToast(context, ok);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<String?> _askName(String title, [String initial = '']) async {
    final c = TextEditingController(text: initial);
    final v = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: 360,
          child: TextField(
            key: const ValueKey('dept-name'),
            controller: c,
            autofocus: true,
            maxLength: 40,
            decoration: const InputDecoration(labelText: '部门名称'),
            onSubmitted: (v) => Navigator.pop(ctx, v),
          ),
        ),
        actions: [
          OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('确定')),
        ],
      ),
    );
    c.dispose();
    return v == null || v.trim().isEmpty ? null : v.trim();
  }

  Future<void> _create(String? parentId) async {
    final name = await _askName(parentId == null ? '新建部门' : '新建「${_dept(parentId)?.name}」的子部门');
    if (name == null || !mounted) return;
    final api = AppScope.read(context).api;
    await _run(() async {
      final d = await api.createDepartment(name: name, parentId: parentId);
      selected = d.departmentId;
      if (parentId != null) collapsed.remove(parentId);
    }, '已新建部门');
  }

  Future<void> _menu(CosDepartment d, String a) async {
    final api = AppScope.read(context).api;
    final siblings = [for (final n in nodes!) if (n.dept.parentId == d.parentId) n.dept];
    final idx = siblings.indexWhere((x) => x.departmentId == d.departmentId);
    switch (a) {
      case 'child':
        return _create(d.departmentId);
      case 'rename':
        final name = await _askName('重命名部门', d.name);
        if (name != null && name != d.name) await _run(() => api.updateDepartment(d.departmentId, name: name));
      case 'up':
        if (idx > 0) await _run(() => api.updateDepartment(d.departmentId, order: idx - 1));
      case 'down':
        if (idx < siblings.length - 1) await _run(() => api.updateDepartment(d.departmentId, order: idx + 1));
      case 'top':
        await _run(() => api.updateDepartment(d.departmentId, parentId: null), '已移到最上层');
      case 'delete':
        if (!mounted) return;
        final ok = await confirmDialog(context, title: '删除部门', content: '确定删除「${d.name}」吗？部门里不能有成员和下级部门。', ok: '删除', danger: true);
        if (ok) await _run(() => api.deleteDepartment(d.departmentId), '已删除');
    }
  }

  Future<void> _move(String id, String newParent) async {
    if (id == newParent || _isDescendant(newParent, id) || _dept(id)?.parentId == newParent) return;
    final api = AppScope.read(context).api;
    await _run(() async {
      await api.updateDepartment(id, parentId: newParent);
      collapsed.remove(newParent);
    }, '已移动到「${_dept(newParent)?.name}」');
  }

  Widget _row(DeptNode n) {
    final d = n.dept;
    final ro = widget.readOnly;
    final sel = d.departmentId == selected;
    final row = HoverBox(
      key: ValueKey('dept-${d.departmentId}'),
      onTap: () => setState(() => selected = d.departmentId),
      selected: sel,
      radius: 6,
      child: Container(
        decoration: dropTarget == d.departmentId
            ? BoxDecoration(border: Border.all(color: Fs.primary, width: 1.5), borderRadius: BorderRadius.circular(6))
            : null,
        padding: EdgeInsets.only(left: 6.0 + n.depth * 18, right: 2, top: 6, bottom: 6),
        child: Row(children: [
          SizedBox(
            width: 20,
            child: d.hasChildren
                ? InkWell(
                    onTap: () => setState(() => collapsed.contains(d.departmentId) ? collapsed.remove(d.departmentId) : collapsed.add(d.departmentId)),
                    child: Icon(collapsed.contains(d.departmentId) ? Icons.arrow_right_rounded : Icons.arrow_drop_down_rounded, size: 20, color: Fs.text3),
                  )
                : null,
          ),
          Icon(n.depth == 0 ? Icons.apartment_rounded : Icons.folder_outlined, size: 16, color: sel ? Fs.primary : Fs.text2),
          const SizedBox(width: 6),
          Expanded(
            child: Text(d.name,
                overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: sel ? Fs.primary : Fs.text1, fontWeight: sel ? FontWeight.w600 : null)),
          ),
          Text('${d.memberCount}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
          if (!ro)
            PopupMenuButton<String>(
              key: ValueKey('dept-menu-${d.departmentId}'),
              tooltip: '更多',
              padding: EdgeInsets.zero,
              iconSize: 16,
              icon: const Icon(Icons.more_horiz_rounded, size: 16, color: Fs.text3),
              onSelected: (a) => _menu(d, a),
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'child', child: Text('新建子部门')),
                const PopupMenuItem(value: 'rename', child: Text('重命名')),
                const PopupMenuItem(value: 'up', child: Text('上移')),
                const PopupMenuItem(value: 'down', child: Text('下移')),
                if (d.parentId != null) const PopupMenuItem(value: 'top', child: Text('移到最上层')),
                const PopupMenuDivider(),
                const PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(color: Fs.red))),
              ],
            )
          else
            const SizedBox(width: 8),
        ]),
      ),
    );
    if (ro) return row;
    return LongPressDraggable<String>(
      data: d.departmentId,
      delay: const Duration(milliseconds: 250),
      feedback: Material(
        elevation: 4,
        borderRadius: BorderRadius.circular(6),
        child: Padding(padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), child: Text(d.name)),
      ),
      childWhenDragging: Opacity(opacity: 0.4, child: row),
      child: DragTarget<String>(
        onWillAcceptWithDetails: (x) {
          final ok = x.data != d.departmentId && !_isDescendant(d.departmentId, x.data);
          if (ok) setState(() => dropTarget = d.departmentId);
          return ok;
        },
        onLeave: (_) => setState(() => dropTarget = null),
        onAcceptWithDetails: (x) {
          setState(() => dropTarget = null);
          _move(x.data, d.departmentId);
        },
        builder: (_, _, _) => row,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ro = widget.readOnly;
    final mobile = MediaQuery.sizeOf(context).width < 720;
    final tree = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (!ro)
        const Padding(
          padding: EdgeInsets.fromLTRB(14, 10, 14, 4),
          child: Text('长按拖动部门到另一个部门上，即可调整上下级', style: TextStyle(fontSize: 11, color: Fs.text3)),
        ),
      Expanded(
        child: nodes == null
            ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
            : nodes!.isEmpty
                ? const EmptyState(icon: Icons.account_tree_outlined, title: '还没有部门')
                : ListView(padding: const EdgeInsets.all(8), children: [for (final n in _visible) _row(n)]),
      ),
    ]);
    final detail = selected == null
        ? const EmptyState(icon: Icons.account_tree_outlined, title: '选择左侧的部门')
        : _DeptDetail(
            key: ValueKey(selected),
            dept: _dept(selected)!,
            path: _path(selected!),
            readOnly: ro,
            onChanged: _load,
          );
    return Column(children: [
      AdminHeader(
        title: '组织架构',
        subtitle: nodes == null ? null : '共 ${nodes!.length} 个部门',
        actions: [
          if (!ro)
            FilledButton.icon(
              key: const ValueKey('dept-add'),
              icon: const Icon(Icons.add_rounded, size: 16),
              label: const Text('新建部门'),
              onPressed: () => _create(null),
            ),
        ],
      ),
      Expanded(
        child: error != null
            ? EmptyState(icon: Icons.error_outline_rounded, title: error!, action: TextButton(onPressed: _load, child: const Text('重试')))
            : mobile
                ? Column(children: [SizedBox(height: 220, child: tree), const Divider(height: 1), Expanded(child: detail)])
                : Row(children: [
                    SizedBox(width: 300, child: Container(color: Colors.white, child: tree)),
                    const VerticalDivider(width: 1),
                    Expanded(child: detail),
                  ]),
      ),
    ]);
  }

  List<CosDepartment> _path(String id) {
    final out = <CosDepartment>[];
    CosDepartment? d = _dept(id);
    while (d != null && out.length < 20) {
      out.insert(0, d);
      d = _dept(d.parentId);
    }
    return out;
  }
}

class _DeptDetail extends StatefulWidget {
  final CosDepartment dept;
  final List<CosDepartment> path;
  final bool readOnly;
  final Future<void> Function() onChanged;
  const _DeptDetail({super.key, required this.dept, required this.path, required this.readOnly, required this.onChanged});
  @override
  State<_DeptDetail> createState() => _DeptDetailState();
}

class _DeptDetailState extends State<_DeptDetail> {
  List<CosAdminUser>? members;
  String? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final p = await AppScope.read(context).api.adminListUsers(departmentId: widget.dept.departmentId, pageSize: 200);
      if (mounted) setState(() => members = p.items);
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  Future<void> _run(Future<void> Function() f, String ok) async {
    try {
      await f();
      await _load();
      await widget.onChanged();
      if (mounted) showToast(context, ok);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final d = widget.dept;
    final ro = widget.readOnly;
    final api = s.api;
    return ListView(padding: const EdgeInsets.all(24), children: [
      Text(widget.path.map((e) => e.name).join(' / '), style: const TextStyle(fontSize: 12, color: Fs.text3)),
      const SizedBox(height: 6),
      Text(d.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
      const SizedBox(height: 14),
      Row(children: [
        const SizedBox(width: 72, child: Text('负责人', style: TextStyle(color: Fs.text3))),
        if (d.leaderId != null) ...[
          FsAvatar(name: s.userName(d.leaderId!), seed: d.leaderId, size: 24),
          const SizedBox(width: 6),
          Text(s.userName(d.leaderId!)),
        ] else
          const Text('未设置', style: TextStyle(color: Fs.text3)),
        if (!ro) ...[
          const SizedBox(width: 8),
          TextButton(
            key: const ValueKey('dept-leader'),
            onPressed: () async {
              final ids = await pickUsers(context, users: humanUsers(s), title: '选择部门负责人', multiple: false);
              if (ids == null || ids.isEmpty) return;
              await _run(() => api.updateDepartment(d.departmentId, leaderId: ids.first), '负责人已更新');
            },
            child: Text(d.leaderId == null ? '设置' : '更换'),
          ),
          if (d.leaderId != null)
            TextButton(
              onPressed: () => _run(() => api.updateDepartment(d.departmentId, leaderId: ''), '已清除负责人'),
              child: const Text('清除'),
            ),
        ],
      ]),
      const SizedBox(height: 20),
      Row(children: [
        Text('部门成员 · ${members?.length ?? d.memberCount}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        const Spacer(),
        if (!ro)
          OutlinedButton.icon(
            key: const ValueKey('dept-add-members'),
            icon: const Icon(Icons.person_add_alt_rounded, size: 16),
            label: const Text('添加成员'),
            onPressed: () async {
              final ids = await pickUsers(context,
                  users: humanUsers(s), title: '添加到「${d.name}」', exclude: {for (final m in members ?? <CosAdminUser>[]) m.user.userId});
              if (ids == null || ids.isEmpty) return;
              await _run(() => api.addDepartmentMembers(d.departmentId, ids), '已添加 ${ids.length} 人');
            },
          ),
      ]),
      const SizedBox(height: 8),
      if (error != null)
        Text(error!, style: const TextStyle(color: Fs.red))
      else if (members == null)
        const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator(strokeWidth: 2)))
      else if (members!.isEmpty)
        const Padding(padding: EdgeInsets.all(20), child: Center(child: Text('部门里还没有成员', style: TextStyle(color: Fs.text3))))
      else
        Container(
          decoration: BoxDecoration(color: Colors.white, border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(8)),
          child: Column(children: [
            for (final m in members!)
              ListTile(
                key: ValueKey('dept-member-${m.user.userId}'),
                leading: FsAvatar(name: m.user.name, seed: m.user.userId, size: 32, url: m.user.avatarUrl),
                title: Row(children: [
                  Text(m.user.name),
                  if (m.user.userId == d.leaderId) ...[const SizedBox(width: 6), const FsTag('负责人', color: TagColor.orange)],
                  if (m.primaryDepartmentId != null && m.primaryDepartmentId != d.departmentId) ...[
                    const SizedBox(width: 6),
                    const FsTag('兼任', color: TagColor.gray),
                  ],
                ]),
                subtitle: Text(m.user.title ?? '', style: const TextStyle(fontSize: 12)),
                trailing: ro
                    ? null
                    : TextButton(
                        style: TextButton.styleFrom(foregroundColor: Fs.text2),
                        onPressed: () async {
                          final ok = await confirmDialog(context, title: '移出部门', content: '把 ${m.user.name} 移出「${d.name}」？', ok: '移出');
                          if (ok) await _run(() => api.removeDepartmentMember(d.departmentId, m.user.userId), '已移出');
                        },
                        child: const Text('移出'),
                      ),
              ),
          ]),
        ),
    ]);
  }
}
