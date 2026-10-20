/// 主框架：桌面端左侧导航栏（飞书桌面端样式），手机端底部标签栏。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'admin_page.dart';
import 'bitable_page.dart';
import 'calendar_page.dart';
import 'contacts_page.dart';
import 'docs_page.dart';
import 'wiki_page.dart';
import 'drive_page.dart';
import 'global_search.dart';
import 'message_extras.dart';
import 'message_more.dart';
import 'login_page.dart';
import 'me_page.dart';
import 'messages_page.dart';
import 'notification_center.dart';
import 'tasks_page.dart';
import 'workbench_page.dart';

class ModuleMeta {
  final IconData icon;
  final IconData activeIcon;
  final Color color;
  const ModuleMeta(this.icon, this.activeIcon, this.color);

  static ModuleMeta of(AppModule m) => switch (m) {
        AppModule.messages => const ModuleMeta(Icons.chat_bubble_outline_rounded, Icons.chat_bubble_rounded, Fs.primary),
        AppModule.calendar => const ModuleMeta(Icons.calendar_today_outlined, Icons.calendar_month_rounded, Fs.orange),
        AppModule.docs => const ModuleMeta(Icons.description_outlined, Icons.description_rounded, Color(0xFF3370FF)),
        AppModule.wiki => const ModuleMeta(Icons.menu_book_outlined, Icons.menu_book_rounded, Color(0xFF00B6C1)),
        AppModule.bitable => const ModuleMeta(Icons.grid_view_outlined, Icons.grid_view_rounded, Fs.purple),
        AppModule.tasks => const ModuleMeta(Icons.task_alt_outlined, Icons.task_alt_rounded, Color(0xFF2EA121)),
        AppModule.drive => const ModuleMeta(Icons.cloud_outlined, Icons.cloud_rounded, Fs.cyan),
        AppModule.contacts => const ModuleMeta(Icons.perm_contact_calendar_outlined, Icons.perm_contact_calendar_rounded, Fs.teal),
        AppModule.workbench => const ModuleMeta(Icons.apps_outlined, Icons.apps_rounded, Fs.violet),
        AppModule.admin => const ModuleMeta(Icons.admin_panel_settings_outlined, Icons.admin_panel_settings_rounded, Color(0xFF646A73)),
        AppModule.me => const ModuleMeta(Icons.person_outline_rounded, Icons.person_rounded, Fs.primary),
      };
}

Widget buildModulePage(AppModule m) => switch (m) {
      AppModule.messages => const MessagesPage(),
      AppModule.calendar => const CalendarPage(),
      AppModule.docs => const DocsPage(),
      AppModule.wiki => const WikiPage(),
      AppModule.bitable => const BitablePage(),
      AppModule.tasks => const TasksPage(),
      AppModule.drive => const DrivePage(),
      AppModule.contacts => const ContactsPage(),
      AppModule.workbench => const WorkbenchPage(),
      AppModule.admin => const AdminPage(),
      AppModule.me => const MePage(),
    };

/// 手机底部 5 个标签（需求文档 1.3）；其余模块从工作台的应用网格进入。
const _mobileTabs = [
  AppModule.messages,
  AppModule.calendar,
  AppModule.bitable,
  AppModule.workbench,
  AppModule.me,
];

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  /// 访问过的模块才构建（保留各模块状态，又不一次性请求全部数据）。
  final Set<AppModule> visited = {};

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    visited.add(s.module);
    final mobile = MediaQuery.sizeOf(context).width < 720;
    final stack = IndexedStack(
      index: s.module.index,
      children: [
        for (final m in AppModule.values)
          visited.contains(m) ? KeyedSubtree(key: ValueKey(m), child: buildModulePage(m)) : const SizedBox.shrink(),
      ],
    );
    final page = mobile
        ? _mobile(context, s, stack)
        : Scaffold(
            body: Column(children: [
              const UrgentBanner(),
              Expanded(
                child: Row(
                  children: [
                    _NavRail(state: s),
                    const VerticalDivider(width: 1),
                    Expanded(child: stack),
                  ],
                ),
              ),
            ]),
          );
    if (!s.feature('search')) return page;
    // ⌘K / Ctrl+K 打开全局搜索（R-SR-01）
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true): () => showGlobalSearch(context),
        const SingleActivator(LogicalKeyboardKey.keyK, control: true): () => showGlobalSearch(context),
      },
      child: Focus(autofocus: true, child: page),
    );
  }

  Widget _mobile(BuildContext context, AppState s, Widget stack) {
    final inTabs = _mobileTabs.contains(s.module);
    final idx = inTabs ? _mobileTabs.indexOf(s.module) : _mobileTabs.indexOf(AppModule.workbench);
    return Scaffold(
      appBar: inTabs
          ? null
          : AppBar(
              leading: IconButton(
                tooltip: '返回工作台',
                icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18),
                onPressed: () => s.go(AppModule.workbench),
              ),
              title: Text(s.module.label),
            ),
      body: SafeArea(bottom: false, child: Column(children: [const UrgentBanner(), Expanded(child: stack)])),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(border: Border(top: BorderSide(color: Fs.line))),
        child: NavigationBar(
          selectedIndex: idx,
          onDestinationSelected: (i) => s.go(_mobileTabs[i]),
          destinations: [
            for (final m in _mobileTabs)
              NavigationDestination(
                icon: _badge(s, m, Icon(ModuleMeta.of(m).icon)),
                selectedIcon: _badge(s, m, Icon(ModuleMeta.of(m).activeIcon)),
                label: m.label,
              ),
          ],
        ),
      ),
    );
  }

  Widget _badge(AppState s, AppModule m, Widget child) {
    final n = m == AppModule.messages ? s.totalUnread : 0;
    return Badge(
      isLabelVisible: n > 0,
      label: Text(n > 99 ? '99+' : '$n'),
      backgroundColor: Fs.red,
      child: child,
    );
  }
}

class _NavRail extends StatelessWidget {
  final AppState state;
  const _NavRail({required this.state});

  @override
  Widget build(BuildContext context) {
    final s = state;
    return Container(
      width: 72,
      color: Fs.bgNav,
      child: Column(
        children: [
          const SizedBox(height: 14),
          _AvatarMenu(state: s),
          const SizedBox(height: 6),
          const NotificationBell(),
          if (s.feature('search'))
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: FsIconButton(
                icon: Icons.search_rounded,
                tooltip: '搜索（⌘K / Ctrl+K）',
                onPressed: () => showGlobalSearch(context),
              ),
            ),
          const SizedBox(height: 8),
          Expanded(
            child: SingleChildScrollView(
              child: Column(children: [
                for (final m in AppModule.values)
                  if (m != AppModule.me && s.moduleVisible(m)) _item(context, s, m),
              ]),
            ),
          ),
          Tooltip(
            message: s.wsConnected ? '实时连接正常' : '实时连接已断开，正在重连…',
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14, top: 6),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: s.wsConnected ? Fs.green : Fs.orange,
                  ),
                ),
                const SizedBox(width: 4),
                Text(s.wsConnected ? '在线' : '重连中',
                    style: const TextStyle(fontSize: 10, color: Fs.text3)),
              ]),
            ),
          ),
        ],
      ),
    );
  }

  Widget _item(BuildContext context, AppState s, AppModule m) {
    final sel = s.module == m;
    final meta = ModuleMeta.of(m);
    final n = m == AppModule.messages ? s.totalUnread : 0;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: HoverBox(
        onTap: () => s.go(m),
        radius: 10,
        selected: sel,
        selectedColor: Colors.white,
        hoverColor: const Color(0xFFE2E4E8),
        child: SizedBox(
          width: 60,
          height: 56,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Badge(
                isLabelVisible: n > 0,
                label: Text(n > 99 ? '99+' : '$n', style: const TextStyle(fontSize: 10)),
                backgroundColor: Fs.red,
                offset: const Offset(8, -4),
                child: Icon(sel ? meta.activeIcon : meta.icon, size: 22, color: sel ? Fs.primary : Fs.text2),
              ),
              const SizedBox(height: 4),
              Text(m.label,
                  style: TextStyle(
                    fontSize: 11,
                    color: sel ? Fs.primary : Fs.text2,
                    fontWeight: sel ? FontWeight.w600 : FontWeight.normal,
                  )),
            ],
          ),
        ),
      ),
    );
  }
}

class _AvatarMenu extends StatelessWidget {
  final AppState state;
  const _AvatarMenu({required this.state});

  @override
  Widget build(BuildContext context) {
    final me = state.me;
    return PopupMenuButton<String>(
      tooltip: me.name,
      offset: const Offset(64, 0),
      onSelected: (v) async {
        if (v == 'logout') {
          final ok = await confirmDialog(context, title: '退出登录', content: '确定要退出当前账号吗？', ok: '退出');
          if (ok) state.logout();
        } else if (v == 'notify_settings') {
          showNotificationSettings(context);
        } else if (v == 'favorites') {
          showFavorites(context);
        } else if (v == 'profile') {
          state.go(AppModule.contacts);
        } else if (v == 'me') {
          state.go(AppModule.me);
        } else if (v == 'admin') {
          state.go(AppModule.admin);
        }
      },
      itemBuilder: (_) => [
        PopupMenuItem<String>(
          enabled: false,
          child: SizedBox(
            width: 220,
            child: Row(children: [
              FsAvatar(name: me.name, seed: me.userId, size: 44, url: me.avatarUrl),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(me.name, style: const TextStyle(fontSize: 16, color: Fs.text1, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(me.userId, style: const TextStyle(fontSize: 12, color: Fs.text3)),
                ]),
              ),
              if (me.role == 'admin') const FsTag('管理员', color: TagColor.blue),
            ]),
          ),
        ),
        const PopupMenuDivider(),
        PopupMenuItem<String>(
          enabled: false,
          height: 36,
          child: Row(children: [
            const Icon(Icons.dns_outlined, size: 16, color: Fs.text3),
            const SizedBox(width: 8),
            Expanded(
              child: Text(state.api.origin,
                  overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text3)),
            ),
          ]),
        ),
        const PopupMenuItem(
          value: 'me',
          child: Row(children: [Icon(Icons.manage_accounts_outlined, size: 18), SizedBox(width: 10), Text('个人设置')]),
        ),
        const PopupMenuItem(
          value: 'profile',
          child: Row(children: [Icon(Icons.badge_outlined, size: 18), SizedBox(width: 10), Text('通讯录')]),
        ),
        if (state.canAdmin)
          const PopupMenuItem(
            value: 'admin',
            child: Row(children: [Icon(Icons.admin_panel_settings_outlined, size: 18), SizedBox(width: 10), Text('管理后台')]),
          ),
        if (state.feature('message.favorite'))
          const PopupMenuItem(
            value: 'favorites',
            child: Row(children: [Icon(Icons.star_outline_rounded, size: 18), SizedBox(width: 10), Text('我的收藏')]),
          ),
        if (state.feature('notifications'))
          const PopupMenuItem(
            value: 'notify_settings',
            child: Row(children: [Icon(Icons.notifications_active_outlined, size: 18), SizedBox(width: 10), Text('通知设置')]),
          ),
        const PopupMenuItem(
          value: 'logout',
          child: Row(children: [
            Icon(Icons.logout_rounded, size: 18, color: Fs.red),
            SizedBox(width: 10),
            Text('退出登录', style: TextStyle(color: Fs.red)),
          ]),
        ),
      ],
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          FsAvatar(name: me.name, seed: me.userId, size: 38, url: me.avatarUrl),
          Positioned(
            right: -1,
            bottom: -1,
            child: Container(
              width: 12,
              height: 12,
              decoration: BoxDecoration(
                color: Fs.green,
                shape: BoxShape.circle,
                border: Border.all(color: Fs.bgNav, width: 2),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 在没有内容时显示的应用 Logo 占位（部分页面复用）。
class BrandPlaceholder extends StatelessWidget {
  final String text;
  const BrandPlaceholder({super.key, required this.text});
  @override
  Widget build(BuildContext context) => Container(
        color: Fs.bg,
        child: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Opacity(opacity: 0.35, child: AppLogo(size: 72)),
            const SizedBox(height: 16),
            Text(text, style: const TextStyle(color: Fs.text3, fontSize: 14)),
          ]),
        ),
      );
}
