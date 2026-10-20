/// 角色与权限（R-AD-03）：左侧角色列表，右侧名称、权限点、成员。
/// 内置「超级管理员」「管理员」「成员」不能删除；超级管理员的权限固定为全部。
library;

import 'package:flutter/material.dart';

import '../api/phase2_admin.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'admin_page.dart' show AdminHeader, humanUsers;

class AdminRolesPane extends StatefulWidget {
  final bool readOnly;
  const AdminRolesPane({super.key, this.readOnly = false});
  @override
  State<AdminRolesPane> createState() => _AdminRolesPaneState();
}

class _AdminRolesPaneState extends State<AdminRolesPane> {
  List<CosRole>? roles;
  String? selected;
  String? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final l = await AppScope.read(context).api.listRoles();
      if (!mounted) return;
      setState(() {
        roles = l;
        error = null;
        if (!l.any((r) => r.roleId == selected)) selected = l.firstOrNull?.roleId;
      });
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  void _replace(CosRole r) {
    setState(() {
      final i = roles!.indexWhere((x) => x.roleId == r.roleId);
      i >= 0 ? roles![i] = r : roles!.add(r);
      selected = r.roleId;
    });
    // 自己的权限可能变了
    AppScope.read(context).refreshMe();
  }

  Future<void> _create() async {
    final c = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('新建角色'),
        content: SizedBox(
          width: 360,
          child: TextField(
            key: const ValueKey('role-name'),
            controller: c,
            autofocus: true,
            maxLength: 20,
            decoration: const InputDecoration(labelText: '角色名称', hintText: '如 设备管理员、导师'),
            onSubmitted: (v) => Navigator.pop(ctx, v),
          ),
        ),
        actions: [
          OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('创建')),
        ],
      ),
    );
    c.dispose();
    if (name == null || name.trim().isEmpty || !mounted) return;
    try {
      _replace(await AppScope.read(context).api.saveRole(null, name: name.trim(), permissions: const []));
      if (mounted) showToast(context, '已创建角色，请勾选权限并添加成员');
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ro = widget.readOnly;
    final mobile = MediaQuery.sizeOf(context).width < 720;
    final list = roles;
    final cur = list?.where((r) => r.roleId == selected).firstOrNull;
    final side = list == null
        ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
        : ListView(padding: const EdgeInsets.all(8), children: [
            for (final r in list)
              HoverBox(
                key: ValueKey('role-${r.roleId}'),
                onTap: () => setState(() => selected = r.roleId),
                selected: r.roleId == selected,
                radius: 6,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(children: [
                    Icon(r.isBuiltin ? Icons.shield_rounded : Icons.badge_outlined, size: 18, color: r.isBuiltin ? Fs.primary : Fs.text2),
                    const SizedBox(width: 10),
                    Expanded(child: Text(r.name, overflow: TextOverflow.ellipsis)),
                    if (r.isBuiltin) const FsTag('内置', color: TagColor.gray),
                    const SizedBox(width: 6),
                    Text('${r.memberIds.length}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                  ]),
                ),
              ),
          ]);
    final detail = cur == null
        ? const EmptyState(icon: Icons.verified_user_outlined, title: '选择左侧的角色')
        : _RoleDetail(
            key: ValueKey(cur.roleId),
            role: cur,
            readOnly: ro,
            onSaved: _replace,
            onDeleted: () {
              setState(() {
                roles!.removeWhere((x) => x.roleId == cur.roleId);
                selected = roles!.firstOrNull?.roleId;
              });
              AppScope.read(context).refreshMe();
            },
          );
    return Column(children: [
      AdminHeader(
        title: '角色与权限',
        subtitle: '给角色勾选权限点，再把成员加进角色。一个人可以有多个角色，权限取并集。',
        actions: [
          if (!ro)
            FilledButton.icon(
              key: const ValueKey('role-add'),
              icon: const Icon(Icons.add_rounded, size: 16),
              label: const Text('新建角色'),
              onPressed: _create,
            ),
        ],
      ),
      Expanded(
        child: error != null
            ? EmptyState(icon: Icons.error_outline_rounded, title: error!, action: TextButton(onPressed: _load, child: const Text('重试')))
            : mobile
                ? Column(children: [SizedBox(height: 200, child: side), const Divider(height: 1), Expanded(child: detail)])
                : Row(children: [
                    SizedBox(width: 260, child: Container(color: Colors.white, child: side)),
                    const VerticalDivider(width: 1),
                    Expanded(child: detail),
                  ]),
      ),
    ]);
  }
}

class _RoleDetail extends StatefulWidget {
  final CosRole role;
  final bool readOnly;
  final ValueChanged<CosRole> onSaved;
  final VoidCallback onDeleted;
  const _RoleDetail({super.key, required this.role, required this.readOnly, required this.onSaved, required this.onDeleted});
  @override
  State<_RoleDetail> createState() => _RoleDetailState();
}

class _RoleDetailState extends State<_RoleDetail> {
  late Set<String> perms = {...widget.role.permissions};
  late final desc = TextEditingController(text: widget.role.description);
  bool saving = false;

  bool get locked => widget.readOnly || widget.role.builtin == 'super_admin';
  bool get dirty => perms.length != widget.role.permissions.length || !perms.containsAll(widget.role.permissions) ||
      desc.text.trim() != (widget.role.description ?? '');

  @override
  void dispose() {
    desc.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final s = AppScope.read(context);
    // 自己去掉了「管理角色」会立刻失去这个页面，先提醒
    final mine = widget.role.memberIds.contains(s.me.userId);
    if (mine && widget.role.permissions.contains('admin.roles') && !perms.contains('admin.roles')) {
      final ok = await confirmDialog(context,
          title: '去掉自己的权限', content: '你也在这个角色里。去掉「管理角色」后，如果没有其他角色授予该权限，你将不能再进入这个页面。', ok: '仍然保存', danger: true);
      if (!ok) return;
    }
    setState(() => saving = true);
    try {
      final r = await s.api.saveRole(widget.role.roleId, permissions: perms.toList(), description: desc.text.trim());
      widget.onSaved(r);
      if (mounted) showToast(context, '已保存');
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> _setMembers(List<String> ids, String ok) async {
    try {
      widget.onSaved(await AppScope.read(context).api.setRoleMembers(widget.role.roleId, ids));
      if (mounted) showToast(context, ok);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _rename() async {
    final c = TextEditingController(text: widget.role.name);
    final v = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重命名角色'),
        content: SizedBox(width: 340, child: TextField(controller: c, autofocus: true, maxLength: 20, onSubmitted: (v) => Navigator.pop(ctx, v))),
        actions: [
          OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('保存')),
        ],
      ),
    );
    c.dispose();
    if (v == null || v.trim().isEmpty || v.trim() == widget.role.name || !mounted) return;
    try {
      widget.onSaved(await AppScope.read(context).api.saveRole(widget.role.roleId, name: v.trim()));
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final r = widget.role;
    final ro = widget.readOnly;
    Widget permGroup(String title, List<String> keys) => Container(
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(color: Colors.white, border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(8)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 2),
              child: Text(title, style: const TextStyle(fontSize: 13, color: Fs.text3, fontWeight: FontWeight.w500)),
            ),
            for (final k in keys)
              CheckboxListTile(
                key: ValueKey('perm-$k'),
                dense: true,
                controlAffinity: ListTileControlAffinity.leading,
                value: r.builtin == 'super_admin' || perms.contains(k),
                onChanged: locked ? null : (v) => setState(() => v == true ? perms.add(k) : perms.remove(k)),
                title: Text(kPermissionPoints[k] ?? k, style: const TextStyle(fontSize: 14)),
                subtitle: Text(k, style: const TextStyle(fontSize: 11, color: Fs.text3)),
              ),
          ]),
        );
    return ListView(padding: const EdgeInsets.all(24), children: [
      Row(children: [
        Flexible(child: Text(r.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600))),
        if (!ro && !r.isBuiltin) ...[
          FsIconButton(icon: Icons.edit_outlined, tooltip: '重命名', onPressed: _rename),
        ],
        const Spacer(),
        if (!ro && !r.isBuiltin)
          TextButton.icon(
            style: TextButton.styleFrom(foregroundColor: Fs.red),
            icon: const Icon(Icons.delete_outline_rounded, size: 16),
            label: const Text('删除角色'),
            onPressed: () async {
              final ok = await confirmDialog(context, title: '删除角色', content: '删除「${r.name}」后，成员会失去这个角色带来的权限。', ok: '删除', danger: true);
              if (!ok || !context.mounted) return;
              try {
                await s.api.deleteRole(r.roleId);
                widget.onDeleted();
              } catch (e) {
                if (context.mounted) showToast(context, describeError(e), error: true);
              }
            },
          ),
      ]),
      const SizedBox(height: 8),
      TextField(
        controller: desc,
        enabled: !ro,
        maxLength: 60,
        decoration: const InputDecoration(hintText: '角色说明（可选）', isDense: true),
        onChanged: (_) => setState(() {}),
      ),
      if (r.builtin == 'super_admin')
        const Padding(
          padding: EdgeInsets.only(bottom: 10),
          child: Text('超级管理员拥有全部权限，不能修改。', style: TextStyle(fontSize: 12, color: Fs.orange)),
        ),
      permGroup('管理后台', kAdminPermissions),
      permGroup('内容', [for (final k in kPermissionPoints.keys) if (!kAdminPermissions.contains(k)) k]),
      if (!locked)
        Align(
          alignment: Alignment.centerRight,
          child: FilledButton(
            key: const ValueKey('role-save'),
            onPressed: saving || !dirty ? null : _save,
            child: const Text('保存权限'),
          ),
        ),
      const SizedBox(height: 20),
      Row(children: [
        Text('成员 · ${r.memberIds.length}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        const Spacer(),
        if (!ro)
          OutlinedButton.icon(
            key: const ValueKey('role-add-members'),
            icon: const Icon(Icons.person_add_alt_rounded, size: 16),
            label: const Text('添加成员'),
            onPressed: () async {
              final ids = await pickUsers(context, users: humanUsers(s), title: '添加到「${r.name}」', exclude: r.memberIds.toSet());
              if (ids == null || ids.isEmpty) return;
              await _setMembers([...r.memberIds, ...ids], '已添加 ${ids.length} 人');
            },
          ),
      ]),
      const SizedBox(height: 8),
      if (r.memberIds.isEmpty)
        const Padding(padding: EdgeInsets.all(16), child: Text('这个角色还没有成员', style: TextStyle(color: Fs.text3)))
      else
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final id in r.memberIds)
            InputChip(
              key: ValueKey('role-member-$id'),
              avatar: FsAvatar(name: s.userName(id), seed: id, size: 22),
              label: Text(s.userName(id)),
              onDeleted: ro
                  ? null
                  : () async {
                      if (r.builtin == 'super_admin' && r.memberIds.length == 1) {
                        showToast(context, '至少保留一名超级管理员', error: true);
                        return;
                      }
                      if (id == s.me.userId &&
                          !await confirmDialog(context, title: '移出自己', content: '把自己移出「${r.name}」后，你可能失去部分管理权限。', ok: '移出', danger: true)) {
                        return;
                      }
                      await _setMembers([for (final x in r.memberIds) if (x != id) x], '已移出');
                    },
            ),
        ]),
    ]);
  }
}
