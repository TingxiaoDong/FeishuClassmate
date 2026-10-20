/// 全局搜索（R-SR-01）：⌘K / Ctrl+K 打开的浮层。
/// 输入即搜（防抖 300ms），综合按类型分组，每组 3 条 +「查看更多」；顶部标签只看一类，每类有专属筛选；
/// 高亮只认 `<em>`；方向键上下选、回车打开；没输入时显示最近搜索和最近访问。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/phase2_im.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// 搜索类型 → 标签名、图标（审批已取消，不搜）。
const kSearchTypes = <String, (String, IconData)>{
  'user': ('联系人', Icons.person_outline_rounded),
  'chat': ('群组', Icons.groups_outlined),
  'message': ('消息', Icons.chat_bubble_outline_rounded),
  'doc': ('云文档', Icons.description_outlined),
  'wiki': ('知识库', Icons.menu_book_outlined),
  'record': ('多维表格', Icons.grid_view_outlined),
  'task': ('任务', Icons.task_alt_outlined),
  'event': ('日程', Icons.calendar_today_outlined),
};

const _kRecentKey = 'cos_recent_searches';
const kMaxRecentSearches = 20;

/// 前端本地的最近搜索（最多 20 条，最新在前）。
Future<List<String>> loadRecentSearches() async {
  final p = await SharedPreferences.getInstance();
  return p.getStringList(_kRecentKey) ?? const [];
}

Future<List<String>> saveRecentSearch(String q) async {
  final t = q.trim();
  final p = await SharedPreferences.getInstance();
  final l = [...(p.getStringList(_kRecentKey) ?? const <String>[])]..remove(t);
  if (t.isNotEmpty) l.insert(0, t);
  final out = l.take(kMaxRecentSearches).toList();
  await p.setStringList(_kRecentKey, out);
  return out;
}

/// 把带 `<em>` 的文字拆成高亮片段；其他标签一律当普通文字显示。
List<TextSpan> highlightSpans(String raw, {TextStyle? base, TextStyle? hit}) {
  final out = <TextSpan>[];
  final re = RegExp(r'<em>(.*?)</em>', dotAll: true);
  var last = 0;
  for (final m in re.allMatches(raw)) {
    if (m.start > last) out.add(TextSpan(text: raw.substring(last, m.start), style: base));
    out.add(TextSpan(text: m.group(1), style: hit ?? const TextStyle(color: Fs.primary, fontWeight: FontWeight.w600)));
    last = m.end;
  }
  if (last < raw.length) out.add(TextSpan(text: raw.substring(last), style: base));
  return out;
}

String stripEm(String raw) => raw.replaceAll('<em>', '').replaceAll('</em>', '');

Future<void> showGlobalSearch(BuildContext context, {String initial = ''}) {
  final s = AppScope.read(context);
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black26,
    builder: (_) => AppScope(state: s, child: GlobalSearchPanel(initial: initial)),
  );
}

/// 打开一条搜索结果（关闭浮层后调用）。
Future<void> openSearchItem(BuildContext context, AppState s, CosSearchItem item) async {
  switch (item.type) {
    case 'user':
      try {
        final c = await s.api.createChat(chatType: 'p2p', memberIds: [item.id]);
        await s.refreshChats();
        s.openChat(c.chatId);
      } catch (e) {
        if (context.mounted) showToast(context, describeError(e), error: true);
      }
    case 'chat':
      s.openChat(item.id);
    default:
      s.openTarget(item.target);
  }
}

class GlobalSearchPanel extends StatefulWidget {
  final String initial;
  const GlobalSearchPanel({super.key, this.initial = ''});
  @override
  State<GlobalSearchPanel> createState() => _GlobalSearchPanelState();
}

class _GlobalSearchPanelState extends State<GlobalSearchPanel> {
  late final TextEditingController q = TextEditingController(text: widget.initial);
  late final FocusNode focus = FocusNode(onKeyEvent: _onKey);
  late final AppState _s = AppScope.read(context);
  Timer? _debounce;
  int _seq = 0;

  /// '' = 综合。
  String tab = '';
  final Map<String, String> filters = {};
  List<CosSearchGroup> groups = [];
  bool loading = false, loadingMore = false;
  String? error;
  int cursor = 0;
  List<String> recentSearches = [];
  List<CosRecentItem> recentVisits = [];
  List<CosTableMeta> tables = [];

  /// 发给后端的筛选（去掉前端自己用的 `_` 开头的键）。
  Map<String, String> get _query => {for (final e in filters.entries) if (!e.key.startsWith('_')) e.key: e.value};

  List<String> get _types => [for (final t in kSearchTypes.keys) if (t != 'wiki' || _s.feature('wiki')) t];

  /// 当前可用方向键选中的结果（综合时每组最多 3 条）。
  List<CosSearchItem> get flat => [
        for (final g in groups) ...(tab.isEmpty ? g.items.take(3) : g.items),
      ];

  @override
  void initState() {
    super.initState();
    loadRecentSearches().then((l) {
      if (mounted) setState(() => recentSearches = l);
    });
    _s.api.recentVisits().then((l) {
      if (mounted) setState(() => recentVisits = l);
    }).catchError((Object _) {});
    if (widget.initial.isNotEmpty) _search();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    q.dispose();
    focus.dispose();
    super.dispose();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    final n = flat.length;
    if (e.logicalKey == LogicalKeyboardKey.arrowDown && n > 0) {
      setState(() => cursor = (cursor + 1) % n);
      return KeyEventResult.handled;
    }
    if (e.logicalKey == LogicalKeyboardKey.arrowUp && n > 0) {
      setState(() => cursor = (cursor - 1 + n) % n);
      return KeyEventResult.handled;
    }
    if (e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.numpadEnter) {
      if (q.value.composing.isValid && !q.value.composing.isCollapsed) return KeyEventResult.ignored; // 输入法组字中
      if (n > 0) _open(flat[cursor.clamp(0, n - 1)]);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  void _changed(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), _search);
    setState(() {});
  }

  Future<void> _search() async {
    final text = q.text.trim();
    final seq = ++_seq;
    if (text.isEmpty) {
      setState(() {
        groups = [];
        loading = false;
        error = null;
      });
      return;
    }
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final r = await _s.api.search(
        text,
        types: tab.isEmpty ? _types : [tab],
        pageSize: tab.isEmpty ? 3 : 20,
        filters: tab.isEmpty ? const {} : _query,
      );
      if (!mounted || seq != _seq) return; // 只认最后一次输入的结果
      setState(() {
        groups = [for (final g in r) if (g.items.isNotEmpty && (tab.isEmpty || g.type == tab)) g];
        loading = false;
        cursor = 0;
      });
    } catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() {
        loading = false;
        error = e is CosApiException && e.statusCode == 404 ? '搜索功能还没开放' : describeError(e);
      });
    }
  }

  Future<void> _more() async {
    if (tab.isEmpty || groups.isEmpty || !groups.first.hasMore || loadingMore) return;
    setState(() => loadingMore = true);
    try {
      final g0 = groups.first;
      final r = await _s.api.search(q.text.trim(), types: [tab], pageSize: 20, pageToken: g0.pageToken, filters: _query);
      final g = r.where((x) => x.type == tab).firstOrNull;
      if (!mounted) return;
      setState(() {
        groups = [CosSearchGroup(tab, g?.total ?? g0.total, [...g0.items, ...?g?.items], g?.pageToken)];
      });
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => loadingMore = false);
    }
  }

  void _setTab(String t) {
    setState(() {
      tab = t;
      filters.clear();
      groups = [];
    });
    if (t == 'record' && tables.isEmpty) {
      _s.api.listTables().then((l) {
        if (mounted) setState(() => tables = l);
      }).catchError((Object _) {});
    }
    _search();
  }

  Future<void> _open(CosSearchItem item) async {
    if (q.text.trim().isNotEmpty) unawaited(saveRecentSearch(q.text));
    final nav = Navigator.of(context);
    nav.pop();
    await openSearchItem(context, _s, item);
  }

  // ---------------- 视图 ----------------

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final narrow = size.width < 720;
    return Align(
      alignment: narrow ? Alignment.topCenter : const Alignment(0, -0.6),
      child: Padding(
        padding: EdgeInsets.only(top: narrow ? 0 : 24),
        child: Material(
          color: Colors.white,
          elevation: 12,
          borderRadius: BorderRadius.circular(narrow ? 0 : 12),
          clipBehavior: Clip.antiAlias,
          child: SizedBox(
            width: narrow ? size.width : 680,
            height: narrow ? size.height : (size.height * 0.72).clamp(360.0, 640.0),
            child: SafeArea(
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                _input(narrow),
                _tabs(),
                if (tab.isNotEmpty) _filterRow(),
                const Divider(height: 1),
                Expanded(child: _body()),
                _footer(narrow),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  Widget _input(bool narrow) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
        child: Row(children: [
          const Icon(Icons.search_rounded, color: Fs.text3),
          const SizedBox(width: 10),
          Expanded(
            child: TextField(
              key: const ValueKey('global-search-input'),
              controller: q,
              focusNode: focus,
              autofocus: true,
              style: const TextStyle(fontSize: 16),
              decoration: const InputDecoration(
                hintText: '搜索联系人、群组、消息、文档、知识库、记录、任务、日程',
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                filled: false,
                isDense: true,
              ),
              onChanged: _changed,
            ),
          ),
          if (q.text.isNotEmpty)
            FsIconButton(icon: Icons.cancel_rounded, tooltip: '清空', onPressed: () {
              q.clear();
              _changed('');
              focus.requestFocus();
            }),
          if (narrow) TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        ]),
      );

  Widget _tabs() => SizedBox(
        height: 40,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
          for (final t in ['', ..._types])
            Padding(
              padding: const EdgeInsets.only(right: 4, top: 4, bottom: 4),
              child: ChoiceChip(
                key: ValueKey('search-tab-${t.isEmpty ? 'all' : t}'),
                label: Text(t.isEmpty ? '综合' : kSearchTypes[t]!.$1),
                selected: tab == t,
                showCheckmark: false,
                visualDensity: VisualDensity.compact,
                onSelected: (_) => _setTab(t),
              ),
            ),
        ]),
      );

  static const _times = <String, String>{'': '不限时间', '7': '近 7 天', '30': '近 30 天', '365': '近一年'};

  void _setFilter(String k, String? v) {
    setState(() {
      if (v == null || v.isEmpty) {
        filters.remove(k);
      } else {
        filters[k] = v;
      }
    });
    _search();
  }

  void _setTime(String days) {
    setState(() {
      filters.remove('start_ms');
      filters.remove('end_ms');
      if (days.isNotEmpty) {
        final now = DateTime.now();
        filters['start_ms'] = '${now.subtract(Duration(days: int.parse(days))).millisecondsSinceEpoch}';
      }
      filters['_time'] = days; // 只给前端记住选了哪项，发请求前去掉
    });
    _search();
  }

  Widget _filterRow() {
    final s = AppScope.of(context);
    Widget drop(String label, String key, Map<String, String> options) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: PopupMenuButton<String>(
            tooltip: label,
            onSelected: (v) => key == '_time' ? _setTime(v) : _setFilter(key, v),
            itemBuilder: (_) => [for (final e in options.entries) PopupMenuItem(value: e.key, height: 36, child: Text(e.value))],
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: (filters[key] ?? '').isNotEmpty ? Fs.primaryLight : Fs.hover,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text(options[filters[key] ?? ''] ?? label, style: const TextStyle(fontSize: 12)),
                const Icon(Icons.arrow_drop_down_rounded, size: 18, color: Fs.text3),
              ]),
            ),
          ),
        );
    final people = {'': '不限', for (final u in s.users.where((u) => u.role != 'bot')) u.userId: u.name};
    final row = switch (tab) {
      'message' => [
          drop('会话', 'chat_id', {'': '全部会话', for (final c in s.visibleChats) c.chatId: s.chatTitle(c)}),
          drop('发送人', 'sender_id', people),
          drop('时间', '_time', _times),
        ],
      'doc' || 'wiki' => [
          drop('所有者', 'owner_id', people),
          drop('更新时间', '_time', _times),
        ],
      'record' => [
          drop('数据表', 'table_key', {'': '全部数据表', for (final t in tables) t.key: t.name}),
        ],
      _ => <Widget>[],
    };
    if (row.isEmpty) return const SizedBox.shrink();
    return Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Row(children: row));
  }

  Widget _body() {
    if (q.text.trim().isEmpty) return _idle();
    if (loading && groups.isEmpty) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    if (error != null) return EmptyState(icon: Icons.search_off_rounded, title: '搜索失败', subtitle: error);
    if (groups.isEmpty) {
      return EmptyState(icon: Icons.search_off_rounded, title: '没有找到「${q.text.trim()}」相关的结果', subtitle: '换个关键词试试');
    }
    var index = 0;
    final children = <Widget>[];
    for (final g in groups) {
      final meta = kSearchTypes[g.type];
      if (tab.isEmpty) {
        children.add(Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Row(children: [
            Text(meta?.$1 ?? g.type, style: const TextStyle(fontSize: 12, color: Fs.text3, fontWeight: FontWeight.w600)),
            const Spacer(),
            if (g.total > 3 || g.hasMore)
              InkWell(
                key: ValueKey('search-more-${g.type}'),
                onTap: () => _setTab(g.type),
                child: Text('查看更多（${g.total}）', style: const TextStyle(fontSize: 12, color: Fs.primary)),
              ),
          ]),
        ));
      }
      for (final it in (tab.isEmpty ? g.items.take(3) : g.items)) {
        final i = index++;
        children.add(_row(it, i == cursor));
      }
    }
    if (tab.isNotEmpty && groups.isNotEmpty && groups.first.hasMore) {
      children.add(Center(
        child: TextButton(onPressed: loadingMore ? null : _more, child: Text(loadingMore ? '加载中…' : '加载更多')),
      ));
    }
    return ListView(padding: const EdgeInsets.only(bottom: 8), children: children);
  }

  Widget _row(CosSearchItem it, bool active) {
    final s = AppScope.of(context);
    final meta = kSearchTypes[it.type];
    final sub = <String>[
      if (it.snippet.isNotEmpty) it.snippet,
      if (it.type == 'message' && it.extra['chat_id'] != null)
        '${s.chat(it.extra['chat_id'].toString()) == null ? '' : s.chatTitle(s.chat(it.extra['chat_id'].toString())!)}'
            '${it.extra['sender_id'] == null ? '' : ' · ${s.userName(it.extra['sender_id'].toString())}'}',
      if (it.type == 'record' && it.extra['table_name'] != null) '${it.extra['table_name']}',
      if ((it.type == 'doc' || it.type == 'wiki') && it.extra['owner_id'] != null) '所有者 ${s.userName(it.extra['owner_id'].toString())}',
    ].where((x) => x.trim().isNotEmpty).toList();
    final leading = it.type == 'user'
        ? FsAvatar(name: stripEm(it.title), seed: it.id, size: 32)
        : it.type == 'chat'
            ? FsAvatar(name: stripEm(it.title), seed: it.id, size: 32, isGroup: true)
            : Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(8)),
                child: Icon(meta?.$2 ?? Icons.search, size: 18, color: Fs.text2),
              );
    return Material(
      color: active ? Fs.selected : Colors.transparent,
      child: InkWell(
        key: ValueKey('search-item-${it.type}-${it.id}'),
        onTap: () => _open(it),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(children: [
            leading,
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text.rich(
                  TextSpan(children: highlightSpans(it.title.isEmpty ? '（无标题）' : it.title, base: const TextStyle(fontSize: 14, color: Fs.text1))),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (sub.isNotEmpty)
                  Text.rich(
                    TextSpan(children: highlightSpans(sub.join(' · '), base: const TextStyle(fontSize: 12, color: Fs.text3))),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
              ]),
            ),
            if (it.updatedAt != null)
              Text(fmtRelative(it.updatedAt), style: const TextStyle(fontSize: 11, color: Fs.text3)),
          ]),
        ),
      ),
    );
  }

  Widget _idle() {
    final s = AppScope.of(context);
    return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 12), children: [
      if (recentSearches.isNotEmpty) ...[
        Row(children: [
          const Text('最近搜索', style: TextStyle(fontSize: 12, color: Fs.text3, fontWeight: FontWeight.w600)),
          const Spacer(),
          InkWell(
            onTap: () async {
              final p = await SharedPreferences.getInstance();
              await p.remove(_kRecentKey);
              if (mounted) setState(() => recentSearches = []);
            },
            child: const Text('清空', style: TextStyle(fontSize: 12, color: Fs.text3)),
          ),
        ]),
        const SizedBox(height: 8),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final r in recentSearches)
            ActionChip(
              label: Text(r, style: const TextStyle(fontSize: 12)),
              visualDensity: VisualDensity.compact,
              onPressed: () {
                q.text = r;
                q.selection = TextSelection.collapsed(offset: r.length);
                _search();
              },
            ),
        ]),
        const SizedBox(height: 16),
      ],
      if (recentVisits.isNotEmpty) ...[
        const Text('最近访问', style: TextStyle(fontSize: 12, color: Fs.text3, fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        for (final v in recentVisits)
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(kSearchTypes[v.type == 'table' ? 'record' : v.type]?.$2 ?? Icons.history_rounded, size: 18, color: Fs.text2),
            title: Text(v.title.isEmpty ? '（无标题）' : v.title, maxLines: 1, overflow: TextOverflow.ellipsis),
            trailing: Text(fmtRelative(v.visitedAt), style: const TextStyle(fontSize: 11, color: Fs.text3)),
            onTap: () {
              Navigator.pop(context);
              s.openTarget(v.type == 'table' ? {'type': 'table', 'id': v.id} : v.asSearchItem.target);
            },
          ),
      ],
      if (recentSearches.isEmpty && recentVisits.isEmpty)
        const Padding(
          padding: EdgeInsets.only(top: 60),
          child: Center(child: Text('输入关键词开始搜索', style: TextStyle(color: Fs.text3))),
        ),
    ]);
  }

  Widget _footer(bool narrow) => narrow
      ? const SizedBox.shrink()
      : Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: const BoxDecoration(color: Fs.bg, border: Border(top: BorderSide(color: Fs.lineLight))),
          child: const Text('↑ ↓ 选择    Enter 打开    Esc 关闭', style: TextStyle(fontSize: 11, color: Fs.text3)),
        );
}
