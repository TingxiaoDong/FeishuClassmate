/// 分享 / 权限面板（R-DC-01、R-WK-01、R-BT-09 共用）：添加协作者（成员 / 部门 / 群）、
/// 角色修改与移除、链接分享（或可见范围）、转移所有者。每次修改立即整体保存。
library;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/phase2_docs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../services/app_links.dart';
import '../theme.dart';
import 'common.dart';

class ShareConfig {
  /// 面板标题，如「分享「组会纪要」」。
  final String title;
  final Future<CosSharing> Function() load;
  final Future<CosSharing> Function(CosSharing s) save;

  /// 可选角色（按权限从低到高）。
  final List<String> roles;

  /// 链接分享 / 可见范围的选项：值 → 文案。为空时不显示这一节。
  final Map<String, String> linkOptions;
  final String linkTitle;

  /// 复制链接的内容；null 时不显示「复制链接」。
  final String? link;

  /// 能否修改（无权限时只读展示）。
  final bool canManage;

  /// 转移所有者（仅所有者可见）；null 表示不支持。
  final Future<void> Function(String userId)? transfer;

  /// 新成员的默认角色。
  final String defaultRole;

  /// 角色文案覆盖（如表的 manager 显示为「可管理」）。
  final Map<String, String> roleLabels;

  const ShareConfig({
    required this.title,
    required this.load,
    required this.save,
    required this.roles,
    this.linkOptions = const {},
    this.linkTitle = '链接分享',
    this.link,
    this.canManage = true,
    this.transfer,
    this.defaultRole = 'viewer',
    this.roleLabels = const {},
  });

  String roleLabel(String r) => roleLabels[r] ?? kRoleLabels[r] ?? r;
}

const kDocLinkOptions = {
  'off': '关闭链接分享',
  'org_view': '组织内获得链接的人可阅读',
  'org_edit': '组织内获得链接的人可编辑',
};

Future<void> showSharePanel(BuildContext context, ShareConfig cfg) {
  final s = AppScope.read(context);
  return showDialog<void>(
    context: context,
    builder: (_) => AppScope(state: s, child: _SharePanel(cfg: cfg)),
  );
}

class _SharePanel extends StatefulWidget {
  final ShareConfig cfg;
  const _SharePanel({required this.cfg});
  @override
  State<_SharePanel> createState() => _SharePanelState();
}

class _SharePanelState extends State<_SharePanel> {
  CosSharing? data;
  String? error;
  bool saving = false;

  ShareConfig get cfg => widget.cfg;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await cfg.load();
      if (mounted) {
        setState(() {
          data = d;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  Future<void> _apply(CosSharing next) async {
    final prev = data;
    setState(() {
      data = next;
      saving = true;
    });
    try {
      final saved = await cfg.save(next);
      if (mounted) setState(() => data = saved);
    } catch (e) {
      if (!mounted) return;
      setState(() => data = prev);
      showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final d = data;
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560, maxHeight: 640),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 18, 16, 18),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Expanded(
                child: Text(cfg.title,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              ),
              if (saving) const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
              FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: () => Navigator.pop(context)),
            ]),
            const SizedBox(height: 12),
            if (error != null)
              EmptyState(
                icon: Icons.lock_outline_rounded,
                title: '权限信息加载失败',
                subtitle: error,
                action: OutlinedButton(onPressed: _load, child: const Text('重试')),
              )
            else if (d == null)
              const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator(strokeWidth: 2)))
            else
              Flexible(child: SingleChildScrollView(child: _body(s, d))),
          ]),
        ),
      ),
    );
  }

  Widget _body(AppState s, CosSharing d) {
    final inherited = d.inheritedSpaceId != null;
    final isOwner = d.ownerId == s.me.userId;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (inherited)
        Container(
          padding: const EdgeInsets.all(12),
          margin: const EdgeInsets.only(bottom: 16),
          decoration: BoxDecoration(color: Fs.primaryBg, borderRadius: BorderRadius.circular(8)),
          child: Row(children: [
            const Icon(Icons.account_tree_outlined, size: 18, color: Fs.primary),
            const SizedBox(width: 10),
            Expanded(
              child: Text('页面权限继承自知识空间「${d.inheritedSpaceName ?? ''}」，成员和角色请在空间设置里管理',
                  style: const TextStyle(fontSize: 13, color: Fs.text1)),
            ),
          ]),
        )
      else if (cfg.canManage)
        Row(children: [
          Expanded(
            child: OutlinedButton.icon(
              style: OutlinedButton.styleFrom(alignment: Alignment.centerLeft, minimumSize: const Size(0, 40)),
              onPressed: () async {
                final added = await _pickMembers(context, s, d);
                if (added == null || added.isEmpty) return;
                final keep = [for (final m in d.members) if (!added.any((a) => a.memberType == m.memberType && a.memberId == m.memberId)) m];
                _apply(d.copyWith(members: [...keep, ...added]));
              },
              icon: const Icon(Icons.person_add_alt_1_outlined, size: 18),
              label: const Text('添加协作者：成员、部门或群', style: TextStyle(color: Fs.text3)),
            ),
          ),
        ]),
      if (cfg.linkOptions.isNotEmpty) ...[
        const SizedBox(height: 18),
        Text(cfg.linkTitle, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        Row(children: [
          Icon(d.linkShare == 'off' || d.linkShare == 'members' ? Icons.link_off_rounded : Icons.public_rounded,
              size: 20, color: d.linkShare == 'off' || d.linkShare == 'members' ? Fs.text3 : Fs.primary),
          const SizedBox(width: 10),
          Expanded(
            child: DropdownButtonFormField<String>(
              key: ValueKey(d.linkShare),
              initialValue: cfg.linkOptions.containsKey(d.linkShare) ? d.linkShare : cfg.linkOptions.keys.first,
              isExpanded: true,
              decoration: const InputDecoration(isDense: true),
              items: [
                for (final e in cfg.linkOptions.entries)
                  DropdownMenuItem(value: e.key, child: Text(e.value, style: const TextStyle(fontSize: 13))),
              ],
              onChanged: cfg.canManage ? (v) => v == null || v == d.linkShare ? null : _apply(d.copyWith(linkShare: v)) : null,
            ),
          ),
          if (cfg.link != null) ...[
            const SizedBox(width: 8),
            OutlinedButton.icon(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: cfg.link!));
                if (mounted) showToast(context, '链接已复制');
              },
              icon: const Icon(Icons.link_rounded, size: 16),
              label: const Text('复制链接'),
            ),
          ],
        ]),
      ],
      if (!inherited) ...[
        const SizedBox(height: 20),
        Text('协作者 · ${d.members.length + (d.ownerId != null ? 1 : 0)}',
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        if (d.ownerId != null) _row(s, CosMember('user', d.ownerId!, 'owner'), d, owner: true, isOwner: isOwner),
        for (final m in d.members) _row(s, m, d, isOwner: isOwner),
        if (d.members.isEmpty && d.ownerId == null)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Text('还没有协作者', style: TextStyle(fontSize: 13, color: Fs.text3)),
          ),
      ],
      if (!cfg.canManage)
        const Padding(
          padding: EdgeInsets.only(top: 12),
          child: Text('你没有管理权限，只能查看', style: TextStyle(fontSize: 12, color: Fs.text3)),
        ),
    ]);
  }

  Widget _row(AppState s, CosMember m, CosSharing d, {bool owner = false, bool isOwner = false}) {
    final (name, sub, avatar) = memberDisplay(s, m);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(children: [
        avatar,
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name + (m.memberType == 'user' && m.memberId == s.me.userId ? '（我）' : ''),
                style: const TextStyle(fontSize: 14)),
            if (sub.isNotEmpty) Text(sub, style: const TextStyle(fontSize: 12, color: Fs.text3)),
          ]),
        ),
        if (owner)
          Row(mainAxisSize: MainAxisSize.min, children: [
            const Text('所有者', style: TextStyle(fontSize: 13, color: Fs.text2)),
            if (isOwner && cfg.transfer != null)
              PopupMenuButton<String>(
                tooltip: '更多',
                icon: const Icon(Icons.expand_more_rounded, size: 18),
                onSelected: (_) => _transfer(s, d),
                itemBuilder: (_) => const [PopupMenuItem(value: 't', child: Text('转移所有者'))],
              )
            else
              const SizedBox(width: 12),
          ])
        else if (cfg.canManage)
          PopupMenuButton<String>(
            tooltip: '修改权限',
            position: PopupMenuPosition.under,
            onSelected: (v) {
              final list = [...d.members];
              final i = list.indexOf(m);
              if (v == '_remove') {
                list.removeAt(i);
              } else {
                list[i] = m.withRole(v);
              }
              _apply(d.copyWith(members: list));
            },
            itemBuilder: (_) => [
              for (final r in cfg.roles)
                CheckedPopupMenuItem(value: r, checked: r == m.role, child: Text(cfg.roleLabel(r))),
              const PopupMenuDivider(),
              const PopupMenuItem(value: '_remove', child: Text('移除', style: TextStyle(color: Fs.red))),
            ],
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text(cfg.roleLabel(m.role), style: const TextStyle(fontSize: 13, color: Fs.text2)),
                const Icon(Icons.expand_more_rounded, size: 18, color: Fs.text3),
              ]),
            ),
          )
        else
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Text(cfg.roleLabel(m.role), style: const TextStyle(fontSize: 13, color: Fs.text2)),
          ),
      ]),
    );
  }

  Future<void> _transfer(AppState s, CosSharing d) async {
    final ids = await pickUsers(context, users: s.users, title: '转移所有者', multiple: false, exclude: {s.me.userId, kBotId});
    if (ids == null || ids.isEmpty || !mounted) return;
    final ok = await confirmDialog(context,
        title: '转移所有者', content: '确定把所有权转给 ${s.userName(ids.first)} 吗？转移后你会成为「可管理」的协作者。', ok: '转移');
    if (!ok) return;
    try {
      await cfg.transfer!(ids.first);
      if (mounted) showToast(context, '已转移给 ${s.userName(ids.first)}');
      _load();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  Future<List<CosMember>?> _pickMembers(BuildContext context, AppState s, CosSharing d) => showDialog<List<CosMember>>(
        context: context,
        builder: (_) => AppScope(state: s, child: _AddMemberDialog(cfg: cfg, existing: d)),
      );
}

/// 成员显示：名字、副标题、头像。部门的 member_id 是部门名（见待联调文档）。
(String, String, Widget) memberDisplay(AppState s, CosMember m) {
  switch (m.memberType) {
    case 'department':
      final n = s.users.where((u) => u.department == m.memberId).length;
      return (
        m.memberId,
        '部门 · $n 人',
        const FsAvatar(name: '部', size: 32, icon: Icons.account_tree_rounded, color: Fs.teal),
      );
    case 'chat':
      final c = s.chat(m.memberId);
      return (
        c == null ? m.memberId : s.chatTitle(c),
        '群组${c == null ? '' : ' · ${c.memberIds.length} 人'}',
        FsAvatar(name: c == null ? '群' : s.chatTitle(c), seed: m.memberId, size: 32, isGroup: true),
      );
    default:
      final u = s.user(m.memberId);
      return (
        s.userName(m.memberId),
        [u?.department, u?.title].whereType<String>().where((e) => e.isNotEmpty).join(' · '),
        FsAvatar(name: s.userName(m.memberId), seed: m.memberId, size: 32),
      );
  }
}

class _AddMemberDialog extends StatefulWidget {
  final ShareConfig cfg;
  final CosSharing existing;
  const _AddMemberDialog({required this.cfg, required this.existing});
  @override
  State<_AddMemberDialog> createState() => _AddMemberDialogState();
}

class _AddMemberDialogState extends State<_AddMemberDialog> {
  String tab = 'user';
  String q = '';
  late String role = widget.cfg.defaultRole;
  final picked = <String, CosMember>{}; // type:id → member

  bool _exists(String type, String id) =>
      (type == 'user' && id == widget.existing.ownerId) ||
      widget.existing.members.any((m) => m.memberType == type && m.memberId == id);

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final kw = q.toLowerCase();
    final entries = <(String type, String id, String name, String sub, Widget avatar)>[];
    if (tab == 'user') {
      for (final u in s.users) {
        if (u.userId == kBotId || u.role == 'bot') continue;
        if (kw.isNotEmpty && !u.name.toLowerCase().contains(kw) && !(u.department ?? '').toLowerCase().contains(kw)) continue;
        entries.add(('user', u.userId, u.name, [u.department, u.title].whereType<String>().join(' · '),
            FsAvatar(name: u.name, seed: u.userId, size: 30)));
      }
    } else if (tab == 'department') {
      final depts = <String, int>{};
      for (final u in s.users) {
        final d = u.department;
        if (d != null && d.isNotEmpty) depts[d] = (depts[d] ?? 0) + 1;
      }
      for (final e in depts.entries) {
        if (kw.isNotEmpty && !e.key.toLowerCase().contains(kw)) continue;
        entries.add(('department', e.key, e.key, '${e.value} 人',
            const FsAvatar(name: '部', size: 30, icon: Icons.account_tree_rounded, color: Fs.teal)));
      }
    } else {
      for (final c in s.visibleChats.where((c) => c.chatType == 'group')) {
        final t = s.chatTitle(c);
        if (kw.isNotEmpty && !t.toLowerCase().contains(kw)) continue;
        entries.add(('chat', c.chatId, t, '${c.memberIds.length} 人', FsAvatar(name: t, seed: c.chatId, size: 30, isGroup: true)));
      }
    }
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480, maxHeight: 600),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('添加协作者', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            SegmentedButton<String>(
              showSelectedIcon: false,
              style: const ButtonStyle(visualDensity: VisualDensity.compact),
              segments: const [
                ButtonSegment(value: 'user', label: Text('成员')),
                ButtonSegment(value: 'department', label: Text('部门')),
                ButtonSegment(value: 'chat', label: Text('群组')),
              ],
              selected: {tab},
              onSelectionChanged: (v) => setState(() => tab = v.first),
            ),
            const SizedBox(height: 10),
            FsSearchField(hint: '搜索', onChanged: (v) => setState(() => q = v.trim())),
            const SizedBox(height: 6),
            Expanded(
              child: entries.isEmpty
                  ? const Center(child: Text('没有可添加的对象', style: TextStyle(color: Fs.text3, fontSize: 13)))
                  : ListView(children: [
                      for (final e in entries)
                        Builder(builder: (_) {
                          final k = '${e.$1}:${e.$2}';
                          final exists = _exists(e.$1, e.$2);
                          return CheckboxListTile(
                            dense: true,
                            contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                            value: exists || picked.containsKey(k),
                            onChanged: exists
                                ? null
                                : (v) => setState(() => v == true ? picked[k] = CosMember(e.$1, e.$2, role) : picked.remove(k)),
                            secondary: e.$5,
                            title: Text(e.$3, style: const TextStyle(fontSize: 14)),
                            subtitle: Text(exists ? '已是协作者' : e.$4, style: const TextStyle(fontSize: 12, color: Fs.text3)),
                          );
                        }),
                    ]),
            ),
            const SizedBox(height: 10),
            Row(children: [
              const Text('权限', style: TextStyle(fontSize: 13, color: Fs.text2)),
              const SizedBox(width: 10),
              SizedBox(
                width: 130,
                child: DropdownButtonFormField<String>(
                  initialValue: role,
                  decoration: const InputDecoration(isDense: true),
                  items: [
                    for (final r in widget.cfg.roles)
                      DropdownMenuItem(value: r, child: Text(widget.cfg.roleLabel(r), style: const TextStyle(fontSize: 13))),
                  ],
                  onChanged: (v) => setState(() => role = v ?? role),
                ),
              ),
              const Spacer(),
              TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
              const SizedBox(width: 6),
              FilledButton(
                onPressed: picked.isEmpty
                    ? null
                    : () => Navigator.pop(context, [for (final m in picked.values) m.withRole(role)]),
                child: Text(picked.isEmpty ? '添加' : '添加 ${picked.length} 个'),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}

/// 文档分享面板的快捷入口。
Future<void> showDocShare(BuildContext context, CosDoc d, {required bool canManage}) {
  final api = AppScope.read(context).api;
  final me = AppScope.read(context).me;
  return showSharePanel(
    context,
    ShareConfig(
      title: '分享「${d.title}」',
      load: () => api.docPermissions(d.docId),
      save: (s) => api.saveDocPermissions(d.docId, s),
      roles: kDocRoles,
      defaultRole: 'editor',
      linkOptions: kDocLinkOptions,
      link: docLink(api, d.docId),
      canManage: canManage,
      transfer: d.owner == me.userId ? (uid) => api.transferDoc(d.docId, uid) : null,
    ),
  );
}

/// 文档链接：服务器地址 + /docs/:id（Web 端上线后可直接打开；客户端用来定位）。
/// 文档的可分享网址（Web 端 hash 路由，见 services/app_links.dart）。
String docLink(CosApiClient api, String docId, {String? webUrl}) =>
    shareUrl(webOriginFor(api, webUrl), AppModule.docs, {'type': 'doc', 'id': docId});

/// Web 端地址：后端给的 web_url → Web 端当前页面 → API 服务器根地址。
String webOriginFor(CosApiClient api, String? webUrl) {
  if (webUrl != null && webUrl.isNotEmpty) return webUrl;
  if (kIsWeb) return '${Uri.base.scheme}://${Uri.base.authority}${Uri.base.path == '/' ? '' : Uri.base.path}';
  final u = Uri.parse(api.baseUrl);
  return '${u.scheme}://${u.authority}';
}

/// 文档当前可见范围的一句话说明（顶栏标签用）。
String docVisibilityText(CosSharing x, String meId) {
  if (x.inheritedSpaceName != null) return '跟随知识库「${x.inheritedSpaceName}」';
  switch (x.linkShare) {
    case 'org_edit':
      return '组织内可编辑';
    case 'org_view':
      return '组织内可阅读';
  }
  // 链接分享关闭：只有所有者和协作者能看
  if (x.members.any((m) => m.memberType != 'user')) return '仅指定成员可见';
  final ids = {?x.ownerId, for (final m in x.members) m.memberId};
  if (ids.isEmpty || (ids.length == 1 && ids.first == meId)) return '仅自己可见';
  return '仅 ${ids.length} 人可见';
}

/// 文档顶栏的可见范围标签：仅自己可见（灰）/ 仅协作者（蓝）/ 组织内（绿）。
class DocVisibilityTag extends StatelessWidget {
  final CosSharing sharing;
  final String meId;
  const DocVisibilityTag({super.key, required this.sharing, required this.meId});

  @override
  Widget build(BuildContext context) {
    final text = docVisibilityText(sharing, meId);
    final open = sharing.linkShare == 'org_view' || sharing.linkShare == 'org_edit';
    final private = text == '仅自己可见';
    return Tooltip(
      message: '点「分享」修改可见范围',
      child: Row(
        key: const ValueKey('doc-visibility'),
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(open ? Icons.public_rounded : Icons.lock_outline_rounded, size: 14, color: open ? const Color(0xFF237B19) : Fs.text3),
          const SizedBox(width: 3),
          FsTag(text, color: open ? TagColor.green : private ? const TagColor(Color(0xFFEFF0F1), Color(0xFF646A73)) : TagColor.blue, fontSize: 11),
        ],
      ),
    );
  }
}
