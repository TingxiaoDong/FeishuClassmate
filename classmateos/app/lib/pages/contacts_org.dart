/// 通讯录按组织架构浏览（R-AD-02）：面包屑 + 下级部门 + 本部门成员，逐级进入。
/// 名片上的「部门路径」「直属上级」也在这里。只在功能开关 org.departments 打开时使用。
library;

import 'package:flutter/material.dart';

import '../api/phase2_admin.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ContactsOrgBrowser extends StatefulWidget {
  final String? selectedUser;
  final ValueChanged<String> onOpenUser;
  const ContactsOrgBrowser({super.key, this.selectedUser, required this.onOpenUser});
  @override
  State<ContactsOrgBrowser> createState() => _ContactsOrgBrowserState();
}

class _ContactsOrgBrowserState extends State<ContactsOrgBrowser> {
  /// 面包屑：从根到当前部门；空表示最上层。
  final List<CosDepartment> path = [];
  List<CosDepartment>? subs;
  List<CosUser> members = [];
  String? error;
  int _req = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = AppScope.read(context).api;
    final id = path.lastOrNull?.departmentId;
    final req = ++_req;
    setState(() {
      subs = null;
      error = null;
    });
    try {
      final r = await Future.wait([
        api.listDepartments(parentId: id),
        if (id != null) api.departmentUsers(id) else Future.value(<CosUser>[]),
      ]);
      if (!mounted || req != _req) return;
      setState(() {
        subs = r[0] as List<CosDepartment>;
        members = r[1] as List<CosUser>;
      });
    } catch (e) {
      if (mounted && req == _req) setState(() => error = describeError(e));
    }
  }

  void _enter(CosDepartment d) {
    path.add(d);
    _load();
  }

  void _jump(int depth) {
    if (depth == path.length) return;
    path.removeRange(depth, path.length);
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final cur = path.lastOrNull;
    final crumbs = <Widget>[
      InkWell(
        key: const ValueKey('org-crumb-root'),
        onTap: () => _jump(0),
        child: Text('组织架构', style: TextStyle(fontSize: 13, color: path.isEmpty ? Fs.text1 : Fs.primary)),
      ),
      for (var i = 0; i < path.length; i++) ...[
        const Icon(Icons.chevron_right_rounded, size: 16, color: Fs.text3),
        InkWell(
          onTap: () => _jump(i + 1),
          child: Text(path[i].name, style: TextStyle(fontSize: 13, color: i == path.length - 1 ? Fs.text1 : Fs.primary)),
        ),
      ],
    ];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 2, 14, 8),
        child: Wrap(crossAxisAlignment: WrapCrossAlignment.center, runSpacing: 4, children: crumbs),
      ),
      if (error != null)
        Padding(padding: const EdgeInsets.all(16), child: Text(error!, style: const TextStyle(color: Fs.red)))
      else if (subs == null)
        const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator(strokeWidth: 2)))
      else ...[
        if (cur?.leaderId != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 6),
            child: Text('负责人：${s.userName(cur!.leaderId!)}', style: const TextStyle(fontSize: 12, color: Fs.text3)),
          ),
        for (final d in subs!)
          HoverBox(
            key: ValueKey('org-dept-${d.departmentId}'),
            onTap: () => _enter(d),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            margin: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(children: [
              FsAvatar(name: d.name, seed: d.departmentId, size: 36, isGroup: true, icon: Icons.apartment_rounded, color: const Color(0xFF4E83FD)),
              const SizedBox(width: 12),
              Expanded(child: Text(d.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14))),
              Text('${d.memberCount} 人', style: const TextStyle(fontSize: 12, color: Fs.text3)),
              const Icon(Icons.chevron_right_rounded, size: 18, color: Fs.text3),
            ]),
          ),
        if (cur != null && members.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 6),
            child: Text('成员 · ${members.length}', style: const TextStyle(color: Fs.text3, fontSize: 12)),
          ),
        for (final u in members.toList()..sort((a, b) => (a.userId == cur?.leaderId ? 0 : 1).compareTo(b.userId == cur?.leaderId ? 0 : 1)))
          HoverBox(
            key: ValueKey('org-user-${u.userId}'),
            selected: widget.selectedUser == u.userId,
            onTap: () => widget.onOpenUser(u.userId),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            margin: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(children: [
              FsAvatar(name: u.name, seed: u.userId, size: 36, url: u.avatarUrl),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Flexible(child: Text(u.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14))),
                    if (u.userId == s.me.userId) const Text('（我）', style: TextStyle(fontSize: 12, color: Fs.text3)),
                  ]),
                  Text(u.title ?? u.email ?? '', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                ]),
              ),
              if (u.userId == cur?.leaderId) const FsTag('负责人', color: TagColor.orange, fontSize: 10),
            ]),
          ),
        if (cur != null && subs!.isEmpty && members.isEmpty)
          const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('这个部门还没有成员', style: TextStyle(color: Fs.text3)))),
      ],
    ]);
  }
}

/// 名片上的「部门路径」，如「具身智能实验室 / 机器人组」。
class DepartmentPathText extends StatelessWidget {
  final String departmentId;
  final String? fallback;
  const DepartmentPathText({super.key, required this.departmentId, this.fallback});

  static final Map<String, Future<String>> _cache = {};

  @override
  Widget build(BuildContext context) {
    final api = AppScope.read(context).api;
    final f = _cache.putIfAbsent('${api.origin}:$departmentId', () async {
      try {
        return (await api.departmentPath(departmentId)).map((d) => d.name).join(' / ');
      } catch (_) {
        _cache.remove('${api.origin}:$departmentId');
        return fallback ?? '';
      }
    });
    return FutureBuilder<String>(
      future: f,
      builder: (_, snap) => Text(
        snap.data?.isNotEmpty == true ? snap.data! : (fallback ?? '未设置'),
        style: const TextStyle(fontSize: 14, color: Fs.text1),
      ),
    );
  }

  /// 管理后台改了部门后清缓存。
  static void clearCache() => _cache.clear();
}
