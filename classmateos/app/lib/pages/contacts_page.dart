/// 通讯录：组织成员 / 我的群组 / 机器人，右侧个人名片（发消息、约会议）。
library;

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'calendar_page.dart' show EventEditor;
import 'contacts_org.dart';
import 'shell.dart';

enum _Section {
  org('组织成员', Icons.account_tree_outlined),
  groups('我的群组', Icons.groups_outlined),
  bots('机器人', Icons.smart_toy_outlined);

  final String label;
  final IconData icon;
  const _Section(this.label, this.icon);
}

class ContactsPage extends StatefulWidget {
  const ContactsPage({super.key});
  @override
  State<ContactsPage> createState() => _ContactsPageState();
}

class _ContactsPageState extends State<ContactsPage> {
  _Section section = _Section.org;
  String? selectedUser;
  String keyword = '';

  Future<void> _message(String userId) async {
    final s = AppScope.read(context);
    try {
      await s.openP2p(userId);
      if (mounted && Navigator.of(context).canPop()) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 900;
      final mid = c.maxWidth >= 600;
      return Row(children: [
        if (mid) SizedBox(width: 210, child: _sections()),
        if (mid) const VerticalDivider(width: 1),
        if (wide) SizedBox(width: 340, child: _list(context, s, wide, mid)) else Expanded(child: _list(context, s, wide, mid)),
        if (wide) const VerticalDivider(width: 1),
        if (wide)
          Expanded(
            child: selectedUser == null
                ? const BrandPlaceholder(text: '选择联系人查看名片')
                : _ProfileCard(userId: selectedUser!, onMessage: _message),
          ),
      ]);
    });
  }

  Widget _sections() => Container(
        color: Fs.bg,
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(6, 4, 6, 14),
            child: Text('通讯录', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          ),
          for (final sec in _Section.values)
            HoverBox(
              selected: section == sec,
              hoverColor: const Color(0xFFE8E9EB),
              onTap: () => setState(() => section = sec),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
              margin: const EdgeInsets.only(bottom: 2),
              child: Row(children: [
                Icon(sec.icon, size: 18, color: section == sec ? Fs.primary : Fs.text2),
                const SizedBox(width: 10),
                Text(sec.label, style: TextStyle(fontSize: 14, color: section == sec ? Fs.primary : Fs.text1)),
              ]),
            ),
        ]),
      );

  Widget _list(BuildContext context, AppState s, bool wide, bool mid) {
    void openUser(String id) {
      if (wide) {
        setState(() => selectedUser = id);
      } else {
        pushScoped(
          context,
          Scaffold(appBar: AppBar(title: const Text('个人名片')), body: _ProfileCard(userId: id, onMessage: _message)),
        );
      }
    }

    final k = keyword.toLowerCase();
    final children = <Widget>[];
    switch (section) {
      case _Section.org when s.feature('org.departments') && k.isEmpty:
        // 迭代 5：按组织架构逐级浏览；有搜索词时仍按姓名过滤全员
        children.add(ContactsOrgBrowser(selectedUser: selectedUser, onOpenUser: openUser));
      case _Section.org:
        final users = s.users
            .where((u) => k.isEmpty || u.name.toLowerCase().contains(k) || u.userId.toLowerCase().contains(k) || (u.department ?? '').toLowerCase().contains(k))
            .toList()
          ..sort((a, b) => (a.role == 'admin' ? 0 : 1).compareTo(b.role == 'admin' ? 0 : 1));
        children.add(Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
          child: Row(children: [
            const FsAvatar(name: 'Lab', size: 28, isGroup: true, icon: Icons.apartment_rounded, color: Fs.primary),
            const SizedBox(width: 10),
            const Expanded(child: Text('组织成员', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500))),
            Text('${s.users.length} 人', style: const TextStyle(fontSize: 12, color: Fs.text3)),
          ]),
        ));
        final departments = <String, List<CosUser>>{};
        for (final u in users) {
          departments.putIfAbsent(u.department?.trim().isNotEmpty == true ? u.department! : '未分配部门', () => []).add(u);
        }
        for (final entry in departments.entries) {
          children.add(Padding(padding: const EdgeInsets.fromLTRB(12, 16, 12, 6),
            child: Text('${entry.key} · ${entry.value.length}', style: const TextStyle(color: Fs.text3, fontSize: 12))));
          for (final u in entry.value) {
            children.add(_personTile(s, u, selectedUser == u.userId, () => openUser(u.userId)));
          }
        }
      case _Section.groups:
        final groups = s.visibleChats
            .where((c) => c.chatType == 'group')
            .where((c) => k.isEmpty || s.chatTitle(c).toLowerCase().contains(k))
            .toList();
        if (groups.isEmpty) {
          children.add(const Padding(
            padding: EdgeInsets.all(32),
            child: Center(child: Text('还没有加入任何群组', style: TextStyle(color: Fs.text3))),
          ));
        }
        for (final g in groups) {
          children.add(HoverBox(
            onTap: () => s.openChat(g.chatId),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            margin: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(children: [
              FsAvatar(name: s.chatTitle(g), seed: g.chatId, size: 36, isGroup: true),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(s.chatTitle(g), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14)),
                  Text('${g.memberIds.length} 位成员', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                ]),
              ),
              const Icon(Icons.chat_bubble_outline_rounded, size: 16, color: Fs.text3),
            ]),
          ));
        }
      case _Section.bots:
        children.add(HoverBox(
          selected: selectedUser == kBotId,
          onTap: () => openUser(kBotId),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          margin: const EdgeInsets.symmetric(horizontal: 8),
          child: const Row(children: [
            FsAvatar(name: kBotName, size: 36, isBot: true),
            SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(kBotName, style: TextStyle(fontSize: 14)),
                Text('实验室智能助理 · 项目管理 / 导览 / 论文检索', style: TextStyle(fontSize: 12, color: Fs.text3)),
              ]),
            ),
            FsTag('机器人', color: TagColor.blue, fontSize: 10),
          ]),
        ));
    }
    return Container(
      color: Colors.white,
      child: Column(children: [
        if (!mid)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
            child: SegmentedButton<_Section>(
              showSelectedIcon: false,
              style: SegmentedButton.styleFrom(
                visualDensity: VisualDensity.compact,
                selectedBackgroundColor: Fs.primaryLight,
                selectedForegroundColor: Fs.primary,
                side: const BorderSide(color: Fs.line),
              ),
              segments: [for (final sec in _Section.values) ButtonSegment(value: sec, label: Text(sec.label))],
              selected: {section},
              onSelectionChanged: (v) => setState(() => section = v.first),
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 14, 12, 8),
          child: FsSearchField(hint: '搜索联系人、群组', onChanged: (v) => setState(() => keyword = v.trim())),
        ),
        Expanded(child: ListView(padding: const EdgeInsets.only(bottom: 12), children: children)),
      ]),
    );
  }

  Widget _personTile(AppState s, CosUser u, bool selected, VoidCallback onTap) => HoverBox(
        selected: selected,
        onTap: onTap,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        margin: const EdgeInsets.symmetric(horizontal: 8),
        child: Row(children: [
          FsAvatar(name: u.name, seed: u.userId, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(u.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14))),
                if (u.userId == s.me.userId) const Text('（我）', style: TextStyle(fontSize: 12, color: Fs.text3)),
              ]),
              Text(u.email ?? u.userId, style: const TextStyle(fontSize: 12, color: Fs.text3)),
            ]),
          ),
          if (u.role == 'admin') const FsTag('管理员', color: TagColor.blue, fontSize: 10),
        ]),
      );
}

class _ProfileCard extends StatelessWidget {
  final String userId;
  final ValueChanged<String> onMessage;
  const _ProfileCard({required this.userId, required this.onMessage});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final isBot = userId == kBotId;
    final u = s.user(userId);
    final name = s.userName(userId);
    final isMe = userId == s.me.userId;
    final role = isBot ? '机器人' : (u?.role == 'admin' ? '管理员' : (u?.role == 'bot' ? '机器人' : '成员'));
    return Container(
      color: Fs.bg,
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Container(
            width: 440,
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(14), boxShadow: Fs.shadow),
            clipBehavior: Clip.antiAlias,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Container(
                height: 110,
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: isBot
                        ? const [Color(0xFF4E83FD), Color(0xFF7F3BF5)]
                        : [FsAvatar.colorFor(userId).withValues(alpha: 0.85), FsAvatar.colorFor(userId).withValues(alpha: 0.45)],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                ),
              ),
              Transform.translate(
                offset: const Offset(0, -40),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 28),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Container(
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        shape: isBot ? BoxShape.rectangle : BoxShape.circle,
                        borderRadius: isBot ? BorderRadius.circular(24) : null,
                      ),
                      child: FsAvatar(name: name, seed: userId, size: 76, isBot: isBot),
                    ),
                    const SizedBox(height: 12),
                    Row(children: [
                      Text(name, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
                      const SizedBox(width: 8),
                      FsTag(role, color: isBot || role == '管理员' ? TagColor.blue : TagColor.gray),
                    ]),
                    const SizedBox(height: 4),
                    Text(isBot ? '飞书同学大脑 · 自动回复与提醒' : [u?.department, u?.title].whereType<String>().where((v) => v.isNotEmpty).join(' · '),
                        style: const TextStyle(fontSize: 13, color: Fs.text3)),
                    const SizedBox(height: 22),
                    Row(children: [
                      if (!isMe)
                        Expanded(
                          child: FilledButton.icon(
                            onPressed: () => onMessage(userId),
                            icon: const Icon(Icons.chat_bubble_outline_rounded, size: 17),
                            label: const Text('发消息'),
                          ),
                        ),
                      if (!isMe && !isBot) ...[
                        const SizedBox(width: 10),
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: () async {
                              final ok = await showScopedDialog<bool>(
                                  context, (_) => EventEditor(initialAttendees: [userId]));
                              if (ok == true && context.mounted) s.go(AppModule.calendar);
                            },
                            icon: const Icon(Icons.event_outlined, size: 17),
                            label: const Text('约会议'),
                          ),
                        ),
                      ],
                    ]),
                    const SizedBox(height: 22),
                    const Divider(),
                    const SizedBox(height: 10),
                    _info(Icons.badge_outlined, '用户 ID', userId),
                    if (u?.email != null) _info(Icons.mail_outline_rounded, '邮箱', u!.email!),
                    _info(Icons.shield_outlined, '角色', role),
                    if (!isBot && u?.primaryDepartmentId != null && s.feature('org.departments'))
                      _infoWidget(Icons.apartment_rounded, '部门', DepartmentPathText(departmentId: u!.primaryDepartmentId!, fallback: u.department))
                    else
                      _info(Icons.apartment_rounded, '部门', isBot ? '系统服务' : (u?.department ?? '未设置')),
                    if (!isBot && u?.leaderId != null)
                      _infoWidget(
                        Icons.supervisor_account_outlined,
                        '直属上级',
                        InkWell(
                          onTap: () => onMessage(u.leaderId!),
                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                            FsAvatar(name: s.userName(u!.leaderId!), seed: u.leaderId, size: 20),
                            const SizedBox(width: 6),
                            Text(s.userName(u.leaderId!), style: const TextStyle(fontSize: 14, color: Fs.primary)),
                          ]),
                        ),
                      ),
                    if (u?.title != null) _info(Icons.work_outline, '职位', u!.title!),
                    if (u?.phone != null) _info(Icons.phone_outlined, '电话', u!.phone!),
                  ]),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _infoWidget(IconData icon, String label, Widget value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          Icon(icon, size: 17, color: Fs.text3),
          const SizedBox(width: 10),
          SizedBox(width: 64, child: Text(label, style: const TextStyle(fontSize: 13, color: Fs.text3))),
          Expanded(child: Align(alignment: Alignment.centerLeft, child: value)),
        ]),
      );

  Widget _info(IconData icon, String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          Icon(icon, size: 17, color: Fs.text3),
          const SizedBox(width: 10),
          SizedBox(width: 64, child: Text(label, style: const TextStyle(fontSize: 13, color: Fs.text3))),
          Expanded(child: SelectableText(value, style: const TextStyle(fontSize: 14))),
        ]),
      );
}
