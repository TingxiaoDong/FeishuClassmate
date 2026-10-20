/// 管理后台（R-AD-01～05，仅有 admin.* 权限的人可见）。
/// 桌面端：左侧分区导航 + 右侧内容；手机端：顶部分区标签，只能查看，不显示修改按钮。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:file_picker/file_picker.dart';

import '../api/phase2_admin.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/job_dialog.dart';
import '../pages/messages_page.dart' show downloadFile;
import 'admin_audit.dart';
import 'admin_org.dart';
import 'admin_roles.dart';

enum AdminSection {
  members('成员管理', Icons.people_alt_outlined, 'admin.members'),
  org('组织架构', Icons.account_tree_outlined, 'admin.departments'),
  roles('角色与权限', Icons.verified_user_outlined, 'admin.roles'),
  audit('操作日志', Icons.receipt_long_outlined, 'admin.audit'),
  security('安全设置', Icons.shield_outlined, 'admin.security');

  final String label;
  final IconData icon;
  final String permission;
  const AdminSection(this.label, this.icon, this.permission);
}

class AdminPage extends StatefulWidget {
  const AdminPage({super.key});
  @override
  State<AdminPage> createState() => _AdminPageState();
}

class _AdminPageState extends State<AdminPage> {
  AdminSection? section;

  List<AdminSection> _visible(AppState s) => [
        for (final x in AdminSection.values)
          if (s.can(x.permission) && (x != AdminSection.org || s.feature('org.departments'))) x,
      ];

  Widget _content(AdminSection x, bool readOnly) => switch (x) {
        AdminSection.members => AdminMembersPane(readOnly: readOnly),
        AdminSection.org => AdminOrgPane(readOnly: readOnly),
        AdminSection.roles => AdminRolesPane(readOnly: readOnly),
        AdminSection.audit => const AdminAuditPane(),
        AdminSection.security => AdminSecurityPane(readOnly: readOnly),
      };

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final list = _visible(s);
    if (list.isEmpty) return const EmptyState(icon: Icons.lock_outline_rounded, title: '你没有管理后台的权限');
    final cur = list.contains(section) ? section! : list.first;
    final mobile = MediaQuery.sizeOf(context).width < 720;
    if (mobile) {
      return DefaultTabController(
        key: ValueKey(list.length),
        length: list.length,
        initialIndex: list.indexOf(cur),
        child: Column(children: [
          Material(
            color: Colors.white,
            child: TabBar(
              isScrollable: true,
              tabAlignment: TabAlignment.start,
              onTap: (i) => setState(() => section = list[i]),
              tabs: [for (final x in list) Tab(text: x.label)],
            ),
          ),
          Container(
            width: double.infinity,
            color: Fs.orangeLight,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: const Text('手机端只能查看，修改请在电脑上操作', style: TextStyle(fontSize: 12, color: Fs.orange)),
          ),
          Expanded(child: _content(cur, true)),
        ]),
      );
    }
    return Row(children: [
      Container(
        width: 216,
        color: Fs.bgSide,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(18, 20, 18, 12),
            child: Row(children: [
              Icon(Icons.admin_panel_settings_rounded, color: Fs.primary, size: 22),
              SizedBox(width: 8),
              Text('管理后台', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            ]),
          ),
          for (final x in list)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
              child: HoverBox(
                key: ValueKey('admin-nav-${x.name}'),
                onTap: () => setState(() => section = x),
                selected: x == cur,
                radius: 6,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(children: [
                    Icon(x.icon, size: 18, color: x == cur ? Fs.primary : Fs.text2),
                    const SizedBox(width: 10),
                    Text(x.label,
                        style: TextStyle(
                          fontSize: 14,
                          color: x == cur ? Fs.primary : Fs.text1,
                          fontWeight: x == cur ? FontWeight.w600 : FontWeight.normal,
                        )),
                  ]),
                ),
              ),
            ),
        ]),
      ),
      const VerticalDivider(width: 1),
      Expanded(child: KeyedSubtree(key: ValueKey(cur), child: _content(cur, false))),
    ]);
  }
}

/// 管理后台各分区的标题栏。
class AdminHeader extends StatelessWidget {
  final String title;
  final String? subtitle;
  final List<Widget> actions;
  const AdminHeader({super.key, required this.title, this.subtitle, this.actions = const []});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(24, 18, 20, 14),
        decoration: const BoxDecoration(color: Colors.white, border: Border(bottom: BorderSide(color: Fs.line))),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              if (subtitle != null) ...[
                const SizedBox(height: 2),
                Text(subtitle!, style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ],
            ]),
          ),
          ...actions.expand((w) => [const SizedBox(width: 8), w]),
        ]),
      );
}

/// 一次性密码展示（重置密码、新建成员）。
Future<void> showOneTimePassword(BuildContext context, String name, String password, {String title = '新密码'}) => showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: 380,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('$name 的登录密码：', style: const TextStyle(color: Fs.text2)),
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(6), border: Border.all(color: Fs.line)),
              child: Row(children: [
                Expanded(
                  child: SelectableText(password,
                      key: const ValueKey('otp-text'), style: const TextStyle(fontSize: 18, fontFamily: 'monospace', letterSpacing: 1)),
                ),
                FsIconButton(
                  icon: Icons.copy_rounded,
                  tooltip: '复制',
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: password));
                    showToast(ctx, '已复制');
                  },
                ),
              ]),
            ),
            const SizedBox(height: 10),
            const Text('只显示这一次，关闭后无法再查看。请通过私聊发给本人，并提醒首次登录后修改。',
                style: TextStyle(fontSize: 12, color: Fs.orange, height: 1.5)),
          ]),
        ),
        actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('我已记下'))],
      ),
    );

// ---------------- 成员管理 ----------------

class AdminMembersPane extends StatefulWidget {
  final bool readOnly;
  const AdminMembersPane({super.key, this.readOnly = false});
  @override
  State<AdminMembersPane> createState() => _AdminMembersPaneState();
}

class _AdminMembersPaneState extends State<AdminMembersPane> {
  final List<CosAdminUser> items = [];
  List<DeptNode> depts = [];
  List<CosRole> roles = [];
  String keyword = '';
  String? deptId;
  String? status;
  String? pageToken;
  bool hasMore = false, loading = true;
  int? total;
  String? error;

  @override
  void initState() {
    super.initState();
    _loadMeta();
    _load();
  }

  Future<void> _loadMeta() async {
    final s = AppScope.read(context);
    try {
      final d = s.feature('org.departments') ? await loadDepartmentTree(s.api) : <DeptNode>[];
      final r = s.can('admin.roles') ? await s.api.listRoles() : <CosRole>[];
      if (mounted) {
        setState(() {
          depts = d;
          roles = r;
        });
      }
    } catch (_) {/* 只影响筛选和角色名显示 */}
  }

  Future<void> _load({bool more = false}) async {
    final api = AppScope.read(context).api;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final p = await api.adminListUsers(q: keyword, departmentId: deptId, status: status, pageToken: more ? pageToken : null);
      if (!mounted) return;
      setState(() {
        if (!more) items.clear();
        items.addAll(p.items);
        pageToken = p.pageToken;
        hasMore = p.hasMore;
        total = p.total;
        loading = false;
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

  void _replace(CosAdminUser u) {
    final i = items.indexWhere((x) => x.user.userId == u.user.userId);
    setState(() => i >= 0 ? items[i] = u : items.insert(0, u));
    AppScope.read(context).refreshUsers();
  }

  Future<void> _edit([CosAdminUser? u]) async {
    final r = await showScopedDialog<(CosAdminUser, String?)>(context, (_) => _MemberDialog(user: u, depts: depts));
    if (r == null || !mounted) return;
    _replace(r.$1);
    if (r.$2 != null) await showOneTimePassword(context, r.$1.user.name, r.$2!, title: '成员已添加');
  }

  Future<void> _action(CosAdminUser u, String a) async {
    final s = AppScope.read(context);
    final name = u.user.name;
    try {
      switch (a) {
        case 'edit':
          return await _edit(u);
        case 'reset':
          if (!await confirmDialog(context, title: '重置密码', content: '重置后 $name 的旧密码立即失效，所有设备会退出登录。', ok: '重置')) return;
          final pw = await s.api.adminResetPassword(u.user.userId);
          if (mounted) await showOneTimePassword(context, name, pw);
        case 'logout':
          if (!await confirmDialog(context, title: '强制下线', content: '$name 在所有设备上都会退出登录。', ok: '下线', danger: true)) return;
          await s.api.adminLogoutAll(u.user.userId);
          if (mounted) showToast(context, '已让 $name 在所有设备下线');
        case 'toggle':
          if (!u.disabled &&
              !await confirmDialog(context, title: '禁用成员', content: '禁用后 $name 不能登录，已登录的设备会立即退出。数据会保留，可以随时启用。', ok: '禁用', danger: true)) {
            return;
          }
          _replace(await s.api.adminSetUserStatus(u.user.userId, !u.disabled));
          if (mounted) showToast(context, u.disabled ? '已启用 $name' : '已禁用 $name');
      }
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  String _deptNames(CosAdminUser u) {
    if (u.departmentIds.isEmpty) return u.user.department ?? '—';
    final byId = {for (final d in depts) d.dept.departmentId: d.dept.name};
    final primary = u.primaryDepartmentId ?? u.departmentIds.first;
    final names = [
      if (byId[primary] != null) byId[primary]!,
      for (final id in u.departmentIds)
        if (id != primary && byId[id] != null) byId[id]!,
    ];
    return names.isEmpty ? (u.user.department ?? '—') : names.join('、');
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final ro = widget.readOnly;
    final roleName = {for (final r in roles) r.roleId: r.name};
    return Column(children: [
      AdminHeader(
        title: '成员管理',
        subtitle: total == null ? null : '共 $total 人',
        actions: [
          if (!ro && s.feature('user.import'))
            OutlinedButton.icon(
              key: const ValueKey('member-import'),
              icon: const Icon(Icons.upload_file_rounded, size: 16),
              label: const Text('批量导入'),
              onPressed: () async {
                final ok = await showScopedDialog<bool>(context, (_) => const _ImportMembersDialog());
                if (ok == true) _load();
              },
            ),
          if (!ro)
            FilledButton.icon(
              key: const ValueKey('member-add'),
              icon: const Icon(Icons.person_add_alt_1_rounded, size: 16),
              label: const Text('添加成员'),
              onPressed: () => _edit(),
            ),
        ],
      ),
      Container(
        color: Colors.white,
        padding: const EdgeInsets.fromLTRB(24, 10, 20, 10),
        child: Wrap(spacing: 10, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          SizedBox(
            width: 240,
            child: FsSearchField(
              hint: '搜索姓名、账号、邮箱',
              onChanged: (v) {
                keyword = v.trim();
                _load();
              },
            ),
          ),
          if (depts.isNotEmpty)
            _FilterDropdown<String?>(
              value: deptId,
              hint: '全部部门',
              items: {null: '全部部门', for (final d in depts) d.dept.departmentId: '${'　' * d.depth}${d.dept.name}'},
              onChanged: (v) {
                deptId = v;
                _load();
              },
            ),
          _FilterDropdown<String?>(
            value: status,
            hint: '全部状态',
            items: const {null: '全部状态', 'active': '正常', 'disabled': '已禁用'},
            onChanged: (v) {
              status = v;
              _load();
            },
          ),
        ]),
      ),
      const Divider(height: 1),
      Expanded(
        child: error != null
            ? EmptyState(icon: Icons.error_outline_rounded, title: error!, action: TextButton(onPressed: _load, child: const Text('重试')))
            : items.isEmpty && loading
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : items.isEmpty
                    ? const EmptyState(icon: Icons.person_search_rounded, title: '没有符合条件的成员')
                    : LayoutBuilder(builder: (context, c) {
                        final compact = c.maxWidth < 900;
                        return ListView.builder(
                          itemCount: items.length + 2,
                          itemBuilder: (context, i) {
                            if (i == 0) return compact ? const SizedBox.shrink() : const _MemberHeaderRow();
                            if (i == items.length + 1) {
                              return hasMore
                                  ? Center(
                                      child: TextButton(
                                        onPressed: loading ? null : () => _load(more: true),
                                        child: Text(loading ? '加载中…' : '加载更多'),
                                      ),
                                    )
                                  : const SizedBox(height: 24);
                            }
                            final u = items[i - 1];
                            return _MemberRow(
                              key: ValueKey('member-${u.user.userId}'),
                              u: u,
                              compact: compact,
                              dept: _deptNames(u),
                              roles: [for (final r in u.roleIds) ?roleName[r]],
                              onAction: ro ? null : (a) => _action(u, a),
                              isMe: u.user.userId == s.me.userId,
                            );
                          },
                        );
                      }),
      ),
    ]);
  }
}

class _FilterDropdown<T> extends StatelessWidget {
  final T value;
  final String hint;
  final Map<T, String> items;
  final ValueChanged<T> onChanged;
  const _FilterDropdown({super.key, required this.value, required this.hint, required this.items, required this.onChanged});
  @override
  Widget build(BuildContext context) => Container(
        height: 34,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(6)),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<T>(
            value: value,
            hint: Text(hint),
            isDense: true,
            style: const TextStyle(fontSize: 13, color: Fs.text1),
            items: [for (final e in items.entries) DropdownMenuItem<T>(value: e.key, child: Text(e.value))],
            onChanged: (v) => onChanged(v as T),
          ),
        ),
      );
}

const _cols = [180.0, 120.0, 180.0, 110.0, 160.0, 80.0, 120.0];

class _MemberHeaderRow extends StatelessWidget {
  const _MemberHeaderRow();
  @override
  Widget build(BuildContext context) {
    const labels = ['姓名', '账号', '部门', '职位', '角色', '状态', '最后登录'];
    return Container(
      color: Fs.bg,
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 9),
      child: Row(children: [
        for (var i = 0; i < labels.length; i++)
          SizedBox(width: _cols[i], child: Text(labels[i], style: const TextStyle(fontSize: 12, color: Fs.text3, fontWeight: FontWeight.w500))),
        const Spacer(),
        const SizedBox(width: 40),
      ]),
    );
  }
}

class _MemberRow extends StatelessWidget {
  final CosAdminUser u;
  final bool compact;
  final String dept;
  final List<String> roles;
  final ValueChanged<String>? onAction;
  final bool isMe;
  const _MemberRow({super.key, required this.u, required this.compact, required this.dept, required this.roles, this.onAction, this.isMe = false});

  Widget _status() => u.disabled ? const FsTag('已禁用', color: TagColor.gray) : const FsTag('正常', color: TagColor.green);

  Widget _menu(BuildContext context) => onAction == null
      ? const SizedBox(width: 40)
      : PopupMenuButton<String>(
          key: ValueKey('member-menu-${u.user.userId}'),
          tooltip: '操作',
          icon: const Icon(Icons.more_horiz_rounded, size: 18, color: Fs.text2),
          onSelected: onAction,
          itemBuilder: (_) => [
            const PopupMenuItem(value: 'edit', child: Text('编辑资料')),
            const PopupMenuItem(value: 'reset', child: Text('重置密码')),
            const PopupMenuItem(value: 'logout', child: Text('强制下线')),
            if (!isMe)
              PopupMenuItem(
                value: 'toggle',
                child: Text(u.disabled ? '启用' : '禁用', style: TextStyle(color: u.disabled ? Fs.text1 : Fs.red)),
              ),
          ],
        );

  @override
  Widget build(BuildContext context) {
    final name = Row(children: [
      FsAvatar(name: u.user.name, seed: u.user.userId, size: 28, url: u.user.avatarUrl),
      const SizedBox(width: 8),
      Flexible(
        child: Text(u.user.name,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 14, color: u.disabled ? Fs.text3 : Fs.text1, fontWeight: FontWeight.w500)),
      ),
      if (isMe) const Text('（我）', style: TextStyle(fontSize: 12, color: Fs.text3)),
    ]);
    final last = u.lastLoginAt == null ? '从未登录' : fmtRelative(u.lastLoginAt);
    if (compact) {
      return Container(
        decoration: const BoxDecoration(color: Colors.white, border: Border(bottom: BorderSide(color: Fs.lineLight))),
        padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [Flexible(child: name), const SizedBox(width: 8), _status()]),
              const SizedBox(height: 4),
              Text([u.username ?? '', dept, u.user.title ?? ''].where((e) => e.isNotEmpty && e != '—').join(' · '),
                  style: const TextStyle(fontSize: 12, color: Fs.text3)),
              Text('最后登录：$last', style: const TextStyle(fontSize: 12, color: Fs.text3)),
            ]),
          ),
          _menu(context),
        ]),
      );
    }
    Widget cell(int i, Widget child) => SizedBox(width: _cols[i], child: child);
    Widget text(String t) => Text(t, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, color: Fs.text2));
    return HoverBox(
      onTap: onAction == null ? null : () => onAction!('edit'),
      radius: 0,
      child: Container(
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
        child: Row(children: [
          cell(0, name),
          cell(1, text(u.username ?? '—')),
          cell(2, Tooltip(message: dept, child: text(dept))),
          cell(3, text(u.user.title ?? '—')),
          cell(
            4,
            roles.isEmpty
                ? text('—')
                : Wrap(spacing: 4, runSpacing: 2, children: [for (final r in roles.take(2)) FsTag(r, color: TagColor.blue)]),
          ),
          cell(5, Align(alignment: Alignment.centerLeft, child: _status())),
          cell(6, text(last)),
          const Spacer(),
          _menu(context),
        ]),
      ),
    );
  }
}

// ---------------- 添加 / 编辑成员 ----------------

class _MemberDialog extends StatefulWidget {
  final CosAdminUser? user;
  final List<DeptNode> depts;
  const _MemberDialog({this.user, required this.depts});
  @override
  State<_MemberDialog> createState() => _MemberDialogState();
}

class _MemberDialogState extends State<_MemberDialog> {
  late final name = TextEditingController(text: widget.user?.user.name);
  late final username = TextEditingController(text: widget.user?.username);
  late final email = TextEditingController(text: widget.user?.user.email);
  late final phone = TextEditingController(text: widget.user?.user.phone);
  late final title = TextEditingController(text: widget.user?.user.title);
  late List<String> deptIds = [...?widget.user?.departmentIds];
  late String? primary = widget.user?.primaryDepartmentId ?? widget.user?.departmentIds.firstOrNull;
  late String? leader = widget.user?.leaderId;
  final Map<String, String> errs = {};
  String? error;
  bool saving = false;

  bool get isNew => widget.user == null;

  @override
  void dispose() {
    for (final c in [name, username, email, phone, title]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      errs.clear();
      error = null;
      if (name.text.trim().isEmpty) errs['name'] = '请填写姓名';
      if (isNew && !RegExp(r'^[A-Za-z0-9_.\-]{2,32}$').hasMatch(username.text.trim())) errs['username'] = '2～32 位字母、数字、下划线、点或短横线';
      if (email.text.trim().isNotEmpty && !email.text.contains('@')) errs['email'] = '邮箱格式不对';
    });
    if (errs.isNotEmpty) return;
    setState(() => saving = true);
    final body = <String, dynamic>{
      'name': name.text.trim(),
      if (isNew) 'username': username.text.trim(),
      'email': email.text.trim().isEmpty ? null : email.text.trim(),
      'phone': phone.text.trim().isEmpty ? null : phone.text.trim(),
      'title': title.text.trim().isEmpty ? null : title.text.trim(),
      if (widget.depts.isNotEmpty) ...{
        'department_ids': deptIds,
        'primary_department_id': deptIds.contains(primary) ? primary : deptIds.firstOrNull,
      },
      'leader_id': leader,
    };
    try {
      final r = await AppScope.read(context).api.adminSaveUser(widget.user?.user.userId, body);
      if (mounted) Navigator.pop(context, r);
    } on CosApiException catch (e) {
      setState(() {
        saving = false;
        if (e.code == 'USERNAME_EXISTS') {
          errs['username'] = e.message;
        } else {
          for (final x in e.errors) {
            final f = x['field']?.toString();
            if (f != null) errs[f] = x['message']?.toString() ?? '填写有误';
          }
          if (errs.isEmpty) error = e.friendly;
        }
      });
    } catch (e) {
      setState(() {
        saving = false;
        error = describeError(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final byId = {for (final d in widget.depts) d.dept.departmentId: d.dept.name};
    Widget field(String k, String label, TextEditingController c, {bool enabled = true, String? hint}) => Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: TextField(
            key: ValueKey('member-$k'),
            controller: c,
            enabled: enabled,
            decoration: InputDecoration(labelText: label, hintText: hint, errorText: errs[k]),
            onChanged: (_) => errs.containsKey(k) ? setState(() => errs.remove(k)) : null,
          ),
        );
    return AlertDialog(
      title: Text(isNew ? '添加成员' : '编辑成员'),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Expanded(child: field('name', '姓名 *', name)),
              const SizedBox(width: 12),
              Expanded(child: field('username', '登录账号 *', username, enabled: isNew, hint: '如 zhangsan')),
            ]),
            Row(children: [
              Expanded(child: field('email', '邮箱', email)),
              const SizedBox(width: 12),
              Expanded(child: field('phone', '电话', phone)),
            ]),
            field('title', '职位', title, hint: '如 硕士生、博士后'),
            if (widget.depts.isNotEmpty) ...[
              const Text('所属部门', style: TextStyle(fontSize: 12, color: Fs.text3)),
              const SizedBox(height: 6),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final id in deptIds)
                  InputChip(
                    label: Text(byId[id] ?? id),
                    avatar: id == primary ? const Icon(Icons.star_rounded, size: 14, color: Fs.orange) : null,
                    tooltip: id == primary ? '主部门' : '点击设为主部门',
                    onPressed: () => setState(() => primary = id),
                    onDeleted: () => setState(() => deptIds.remove(id)),
                  ),
                PopupMenuButton<String>(
                  tooltip: '添加部门',
                  onSelected: (id) => setState(() {
                    deptIds.add(id);
                    primary ??= id;
                  }),
                  itemBuilder: (_) => [
                    for (final d in widget.depts)
                      if (!deptIds.contains(d.dept.departmentId))
                        PopupMenuItem(value: d.dept.departmentId, child: Text('${'　' * d.depth}${d.dept.name}')),
                  ],
                  child: const Chip(avatar: Icon(Icons.add_rounded, size: 16), label: Text('添加部门')),
                ),
              ]),
              if (deptIds.length > 1)
                const Padding(
                  padding: EdgeInsets.only(top: 4),
                  child: Text('带星标的是主部门，通讯录和名片上显示主部门', style: TextStyle(fontSize: 11, color: Fs.text3)),
                ),
              const SizedBox(height: 12),
            ],
            Row(children: [
              const Text('直属上级', style: TextStyle(fontSize: 13, color: Fs.text2)),
              const SizedBox(width: 12),
              if (leader != null) ...[
                FsAvatar(name: s.userName(leader!), seed: leader, size: 22),
                const SizedBox(width: 6),
                Text(s.userName(leader!)),
                IconButton(icon: const Icon(Icons.close_rounded, size: 16), onPressed: () => setState(() => leader = null)),
              ],
              TextButton(
                onPressed: () async {
                  final ids = await pickUsers(context,
                      users: s.users.where((u) => !u.isBot).toList(),
                      title: '选择直属上级',
                      multiple: false,
                      exclude: {if (widget.user != null) widget.user!.user.userId});
                  if (ids != null && ids.isNotEmpty) setState(() => leader = ids.first);
                },
                child: Text(leader == null ? '选择' : '更换'),
              ),
            ]),
            if (isNew)
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text('保存后会生成初始密码，只显示一次。', style: TextStyle(fontSize: 12, color: Fs.text3)),
              ),
            if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: const TextStyle(color: Fs.red))),
          ]),
        ),
      ),
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          key: const ValueKey('member-save'),
          onPressed: saving ? null : _save,
          child: saving ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('保存'),
        ),
      ],
    );
  }
}

// ---------------- 批量导入成员 ----------------

class _ImportMembersDialog extends StatefulWidget {
  const _ImportMembersDialog();
  @override
  State<_ImportMembersDialog> createState() => _ImportMembersDialogState();
}

class _ImportMembersDialogState extends State<_ImportMembersDialog> {
  CosFileRef? file;
  Map<String, dynamic>? preview;
  String? error;
  bool busy = false;

  Future<void> _template() async {
    try {
      final key = await AppScope.read(context).api.userImportTemplate();
      if (mounted) await downloadFile(context, key);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<void> _pick() async {
    final s = AppScope.read(context);
    final f = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: ['xlsx', 'csv']);
    if (f == null) return;
    setState(() {
      busy = true;
      error = null;
      preview = null;
    });
    try {
      final bytes = await f.readAsBytes();
      final ref = await s.api.uploadBytes(f.name, bytes);
      final p = await s.api.previewUserImport(ref.fileKey);
      if (mounted) {
        setState(() {
          file = ref;
          preview = p;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _import() async {
    final s = AppScope.read(context);
    final job = await runJobDialog(context, title: '导入成员', kind: 'import', start: () => s.api.startUserImport(file!.fileKey));
    if (!mounted) return;
    s.refreshUsers();
    Navigator.pop(context, job != null);
  }

  @override
  Widget build(BuildContext context) {
    final p = preview;
    final headers = [for (final h in (p?['headers'] as List? ?? const [])) h.toString()];
    final rows = [for (final r in (p?['rows'] as List? ?? const [])) if (r is List) [for (final c in r) c?.toString() ?? '']];
    final errors = {
      for (final e in (p?['errors'] as List? ?? const []))
        if (e is Map) (e['row'] as num).toInt(): e['message'].toString(),
    };
    final total = (p?['total_rows'] as num?)?.toInt() ?? rows.length;
    return AlertDialog(
      title: const Text('批量导入成员'),
      content: SizedBox(
        width: 640,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            const _Step(n: 1, text: '下载模板，按格式填写'),
            const Spacer(),
            TextButton.icon(onPressed: _template, icon: const Icon(Icons.download_rounded, size: 16), label: const Text('下载模板')),
          ]),
          const SizedBox(height: 4),
          Row(children: [
            const _Step(n: 2, text: '上传填好的 Excel 或 CSV'),
            const Spacer(),
            OutlinedButton.icon(
              key: const ValueKey('import-pick'),
              onPressed: busy ? null : _pick,
              icon: const Icon(Icons.upload_file_rounded, size: 16),
              label: Text(file == null ? '选择文件' : '重新选择'),
            ),
          ]),
          if (busy) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator(strokeWidth: 2))),
          if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: const TextStyle(color: Fs.red))),
          if (p != null) ...[
            const SizedBox(height: 12),
            _Step(n: 3, text: '确认预览（共 $total 行${errors.isEmpty ? '' : '，${errors.length} 行有问题，导入时跳过'}）'),
            const SizedBox(height: 8),
            Container(
              constraints: const BoxConstraints(maxHeight: 260),
              decoration: BoxDecoration(border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(6)),
              child: SingleChildScrollView(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: DataTable(
                    headingRowHeight: 34,
                    dataRowMinHeight: 32,
                    dataRowMaxHeight: 40,
                    columnSpacing: 20,
                    columns: [
                      const DataColumn(label: Text('行')),
                      for (final h in headers) DataColumn(label: Text(h)),
                      const DataColumn(label: Text('检查结果')),
                    ],
                    rows: [
                      for (var i = 0; i < rows.length; i++)
                        DataRow(
                          color: WidgetStatePropertyAll(errors.containsKey(i) ? Fs.redLight : null),
                          cells: [
                            DataCell(Text('${i + 1}')),
                            for (var c = 0; c < headers.length; c++) DataCell(Text(c < rows[i].length ? rows[i][c] : '')),
                            DataCell(errors.containsKey(i)
                                ? Text(errors[i]!, style: const TextStyle(color: Fs.red, fontSize: 12))
                                : const Icon(Icons.check_rounded, size: 16, color: Fs.green)),
                          ],
                        ),
                    ],
                  ),
                ),
              ),
            ),
            if (total > rows.length)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('只预览前 ${rows.length} 行', style: const TextStyle(fontSize: 12, color: Fs.text3)),
              ),
          ],
        ]),
      ),
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          key: const ValueKey('import-start'),
          onPressed: p == null || busy ? null : _import,
          child: const Text('开始导入'),
        ),
      ],
    );
  }
}

class _Step extends StatelessWidget {
  final int n;
  final String text;
  const _Step({required this.n, required this.text});
  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        CircleAvatar(radius: 10, backgroundColor: Fs.primary, child: Text('$n', style: const TextStyle(fontSize: 11, color: Colors.white))),
        const SizedBox(width: 8),
        Text(text, style: const TextStyle(fontSize: 14)),
      ]);
}

/// 成员目录只读查询（组织架构、角色页复用）。
List<CosUser> humanUsers(AppState s) => s.users.where((u) => !u.isBot).toList();
