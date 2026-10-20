/// AI 助手（AGENT_PLAN M5）：文档 / 表格右侧的「AI 助手」侧栏 + 机器人回复里的结果卡片。
///
/// 侧栏就是和机器人的单聊：发消息时带上 `content.agent_context`（当前打开的对象、选中的内容），
/// 大脑据此知道「这篇 / 这张表」指什么；读写仍按同学本人的权限核验。
/// 机器人回复的 `content.agent_result` 显示成结果卡片：建好 / 改过的对象可以直接点开。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import 'common.dart';

/// 侧栏要带给机器人的当前对象。
class AgentContext {
  final String kind; // doc | table | wiki | file | task | calendar
  final String id;
  final String? title;
  final String? selection;
  final String? viewId;
  const AgentContext({required this.kind, required this.id, this.title, this.selection, this.viewId});

  Map<String, dynamic> toJson({bool withSelection = true}) => {
    'kind': kind,
    'id': id,
    if (title != null && title!.isNotEmpty) 'title': title,
    if (withSelection && selection != null && selection!.trim().isNotEmpty) 'selection': selection!.length > 2000 ? selection!.substring(0, 2000) : selection,
    if (viewId != null && viewId!.isNotEmpty) 'view_id': viewId,
  };

  String get kindLabel => switch (kind) {
    'doc' => '文档',
    'table' => '多维表格',
    'wiki' => '知识库',
    'file' => '文件',
    'task' => '任务',
    _ => '日程',
  };
}

/// 打开右侧 AI 助手面板。
Future<void> showAgentSidebar(BuildContext context, AgentContext ctx) {
  // 弹层挂在 Navigator 覆盖层上，不在 AppScope 子树里，要重新包一层（同 showScopedDialog）
  final s = AppScope.read(context);
  return showGeneralDialog(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭 AI 助手',
    barrierColor: Colors.black12,
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (_, _, _) => Align(
      alignment: Alignment.centerRight,
      child: Material(
        elevation: 8,
        color: Colors.white,
        child: SizedBox(
          width: MediaQuery.sizeOf(context).width < 520 ? MediaQuery.sizeOf(context).width : 400,
          height: double.infinity,
          child: SafeArea(
            child: AppScope(
              state: s,
              child: AgentSidebar(context: ctx),
            ),
          ),
        ),
      ),
    ),
    transitionBuilder: (_, a, _, child) => SlideTransition(
      position: Tween(begin: const Offset(1, 0), end: Offset.zero).animate(CurvedAnimation(parent: a, curve: Curves.easeOut)),
      child: child,
    ),
  );
}

/// 工具栏上的「AI 助手」按钮；平台没开这个功能时不显示。
class AgentSidebarButton extends StatelessWidget {
  final AgentContext Function() contextOf;
  const AgentSidebarButton({super.key, required this.contextOf});
  @override
  Widget build(BuildContext context) {
    if (!AppScope.of(context).feature('agent.sidebar')) return const SizedBox.shrink();
    return FsIconButton(icon: Icons.auto_awesome_outlined, tooltip: 'AI 助手', color: Fs.purple, onPressed: () => showAgentSidebar(context, contextOf()));
  }
}

class AgentSidebar extends StatefulWidget {
  final AgentContext context;
  const AgentSidebar({super.key, required this.context});
  @override
  State<AgentSidebar> createState() => _AgentSidebarState();
}

class _AgentSidebarState extends State<AgentSidebar> {
  late final AppState _s = AppScope.read(context);
  final _input = TextEditingController();
  final _scroll = ScrollController();
  StreamSubscription<CosEvent>? _sub;
  String? _chatId;
  String? _error;
  bool _sending = false;
  bool _withSelection = true;

  /// 只显示这次打开侧栏后的对话（完整记录在消息里和机器人的单聊中）。
  final List<CosMessage> _items = [];

  bool get _waiting => _items.isNotEmpty && _items.last.senderId != kBotId;

  @override
  void initState() {
    super.initState();
    _sub = _s.eventStream.listen((e) {
      final m = e.message;
      if (!mounted || m == null || m.chatId != _chatId) return;
      if (e.eventType != 'message.receive' && e.eventType != 'message.updated') return;
      if (m.senderId != kBotId) return;
      setState(() {
        final i = _items.indexWhere((x) => x.messageId == m.messageId);
        if (i >= 0) {
          _items[i] = m;
        } else {
          _items.add(m);
        }
      });
      _toBottom();
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _toBottom() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
  });

  Future<void> _send([String? preset]) async {
    final text = (preset ?? _input.text).trim();
    if (text.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      _chatId ??= (await _s.api.createChat(chatType: 'p2p', memberIds: [kBotId])).chatId;
      final m = await _s.api.sendMessage(_chatId!, 'text', {'text': text, 'agent_context': widget.context.toJson(withSelection: _withSelection)});
      _input.clear();
      setState(() => _items.add(m));
      _toBottom();
    } catch (e) {
      setState(() => _error = '发送失败：${describeError(e)}');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.context;
    final hasSel = c.selection != null && c.selection!.trim().isNotEmpty;
    final quick = c.kind == 'table' ? const ['总结这张表的数据', '找出异常或缺失的记录', '按负责人统计数量'] : const ['总结这篇文档', '列出里面的待办', '帮我润色选中的内容'];
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
          child: Row(
            children: [
              const Icon(Icons.auto_awesome, color: Fs.purple, size: 20),
              const SizedBox(width: 8),
              const Expanded(
                child: Text('AI 助手', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              ),
              FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: () => Navigator.of(context).pop()),
            ],
          ),
        ),
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(8)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '当前${c.kindLabel}：${c.title?.isNotEmpty == true ? c.title : c.id}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: Fs.text2),
              ),
              if (hasSel)
                Row(
                  children: [
                    Expanded(
                      child: Text('已选中 ${c.selection!.trim().length} 字', style: const TextStyle(fontSize: 12, color: Fs.text3)),
                    ),
                    const Text('附带选中内容', style: TextStyle(fontSize: 12, color: Fs.text3)),
                    Switch(value: _withSelection, onChanged: (v) => setState(() => _withSelection = v)),
                  ],
                ),
              const Text('助手按你本人的权限读写，改动会记在你名下。', style: TextStyle(fontSize: 11, color: Fs.text3)),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: _items.isEmpty
              ? ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    const Text('可以这样问：', style: TextStyle(fontSize: 12, color: Fs.text3)),
                    const SizedBox(height: 8),
                    for (final q in quick)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: OutlinedButton(
                          onPressed: _sending ? null : () => _send(q),
                          child: Align(alignment: Alignment.centerLeft, child: Text(q)),
                        ),
                      ),
                  ],
                )
              : ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.all(16),
                  itemCount: _items.length + (_waiting ? 1 : 0),
                  itemBuilder: (_, i) {
                    if (i == _items.length) {
                      return const Padding(
                        padding: EdgeInsets.symmetric(vertical: 8),
                        child: Row(
                          children: [
                            SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                            SizedBox(width: 8),
                            Text('助手正在处理…', style: TextStyle(fontSize: 12, color: Fs.text3)),
                          ],
                        ),
                      );
                    }
                    return _bubble(_items[i]);
                  },
                ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(_error!, style: const TextStyle(fontSize: 12, color: Fs.red)),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _input,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _send(),
                  decoration: const InputDecoration(hintText: '让助手帮你做点什么…', isDense: true, border: OutlineInputBorder()),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                onPressed: _sending ? null : () => _send(),
                icon: _sending
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.send_rounded, size: 18),
                tooltip: '发送',
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _bubble(CosMessage m) {
    final mine = m.senderId != kBotId;
    final text = m.text.isNotEmpty ? m.text : (m.content['markdown'] ?? m.content['text'] ?? '').toString();
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        constraints: const BoxConstraints(maxWidth: 320),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(color: mine ? Fs.primaryLight : Fs.bg, borderRadius: BorderRadius.circular(10)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            SelectableText(text, style: const TextStyle(fontSize: 14, height: 1.5)),
            if (!mine) AgentResultCard.maybe(m),
          ],
        ),
      ),
    );
  }
}

/// 机器人回复的结果卡片：建好 / 改过的对象（可点开）+ 每一步成没成功。
class AgentResultCard extends StatelessWidget {
  final List<Map<String, dynamic>> links;
  final List<Map<String, dynamic>> steps;
  const AgentResultCard({super.key, required this.links, this.steps = const []});

  /// 消息里有 `agent_result` 时出卡片，否则什么也不显示。
  static Widget maybe(CosMessage m) {
    final r = m.content['agent_result'];
    if (r is! Map) return const SizedBox.shrink();
    final links = [
      for (final l in (r['links'] as List? ?? const []))
        if (l is Map) l.cast<String, dynamic>(),
    ];
    final steps = [
      for (final s in (r['steps'] as List? ?? const []))
        if (s is Map) s.cast<String, dynamic>(),
    ];
    if (links.isEmpty) return const SizedBox.shrink();
    return AgentResultCard(key: ValueKey('agent-result-${m.messageId}'), links: links, steps: steps);
  }

  /// cos://{kind}/{id} → App 内打开目标。
  static Map<String, dynamic>? targetOf(Map<String, dynamic> l) {
    final m = RegExp(r'^cos://([a-z]+)/(.+)$').firstMatch(l['link']?.toString() ?? '');
    if (m == null) return null;
    final kind = l['kind']?.toString() ?? m.group(1)!;
    final id = l['id']?.toString() ?? m.group(2)!;
    return switch (kind) {
      'doc' => {'type': 'doc', 'id': id},
      'wiki' => {'type': 'wiki_node', 'id': id},
      'table' => {'type': 'table', 'id': id, 'table_key': id},
      'task' => {'type': 'task', 'id': id},
      'calendar' || 'event' => {'type': 'event', 'id': id},
      'chat' => {'type': 'chat', 'id': id},
      _ => null,
    };
  }

  static IconData _icon(String kind) => switch (kind) {
    'doc' => Icons.description_outlined,
    'wiki' => Icons.menu_book_outlined,
    'table' || 'record' => Icons.grid_view_outlined,
    'task' => Icons.task_alt_outlined,
    'calendar' || 'event' => Icons.event_outlined,
    _ => Icons.link_rounded,
  };

  @override
  Widget build(BuildContext context) {
    final failed = steps.where((s) => s['ok'] != true).length;
    // 底色用 Material：里面的 InkWell / ExpansionTile 水波纹画在最近的 Material 上，
    // 用 Container 底色会挡住（调试版还会报断言）。
    return Container(
      margin: const EdgeInsets.only(top: 8),
      constraints: const BoxConstraints(maxWidth: 360),
      child: Material(
        color: Colors.white,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: const BorderSide(color: Fs.line),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
              child: Row(
                children: [
                  const Icon(Icons.auto_awesome, size: 14, color: Fs.purple),
                  const SizedBox(width: 6),
                  Text('这次处理了 ${links.length} 个对象', style: const TextStyle(fontSize: 12, color: Fs.text2)),
                  const Spacer(),
                  if (steps.isNotEmpty)
                    Text(
                      failed == 0 ? '${steps.length} 步全部完成' : '$failed 步没完成',
                      style: TextStyle(fontSize: 11, color: failed == 0 ? const Color(0xFF2EA121) : Fs.red),
                    ),
                ],
              ),
            ),
            for (final l in links)
              Builder(
                builder: (context) {
                  final target = targetOf(l);
                  final kind = l['kind']?.toString() ?? '';
                  return InkWell(
                    onTap: target == null
                        ? null
                        : () {
                            // 先拿到 AppState 再关侧栏：关掉后这个 context 就不能再用了
                            final s = AppScope.read(context);
                            Navigator.of(context).popUntil((r) => r is! PopupRoute && r.isFirst || r is PageRoute);
                            s.openTarget(target);
                          },
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      child: Row(
                        children: [
                          Icon(_icon(kind), size: 16, color: Fs.primary),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              l['summary']?.toString() ?? l['link']?.toString() ?? '',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13),
                            ),
                          ),
                          if (target != null) const Icon(Icons.chevron_right_rounded, size: 16, color: Fs.text3),
                        ],
                      ),
                    ),
                  );
                },
              ),
            if (steps.isNotEmpty)
              ExpansionTile(
                dense: true,
                tilePadding: const EdgeInsets.symmetric(horizontal: 12),
                title: const Text('查看步骤', style: TextStyle(fontSize: 12, color: Fs.text3)),
                children: [
                  for (final s in steps)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
                      child: Row(
                        children: [
                          Icon(
                            s['ok'] == true ? Icons.check_circle_outline : Icons.error_outline,
                            size: 14,
                            color: s['ok'] == true ? const Color(0xFF2EA121) : Fs.red,
                          ),
                          const SizedBox(width: 6),
                          Expanded(child: Text(s['label']?.toString() ?? '', style: const TextStyle(fontSize: 12))),
                        ],
                      ),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

/// 工作台「AI 助手」卡片：今日调用、成功率、平均耗时、失败最多的工具。
class AgentMetricsCard extends StatefulWidget {
  const AgentMetricsCard({super.key});
  @override
  State<AgentMetricsCard> createState() => _AgentMetricsCardState();
}

class _AgentMetricsCardState extends State<AgentMetricsCard> {
  Map<String, dynamic>? data;
  String? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await AppScope.read(context).api.request('GET', '/agent/metrics', query: {'days': '7'});
      if (mounted) setState(() => (data = d, error = null));
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = data;
    final today = (d?['today'] as Map?) ?? const {};
    final fails = (d?['top_failures'] as List?) ?? const [];
    final daily = (d?['daily'] as List?) ?? const [];
    final maxCalls = daily.fold<num>(1, (a, x) => ((x as Map)['calls'] as num? ?? 0) > a ? (x['calls'] as num) : a);
    Widget stat(String v, String label) => Expanded(
      child: Column(
        children: [
          Text(v, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
          Text(label, style: const TextStyle(fontSize: 11, color: Fs.text3)),
        ],
      ),
    );
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Fs.lineLight),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.auto_awesome, size: 18, color: Fs.purple),
              const SizedBox(width: 8),
              const Text('AI 助手', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              const Spacer(),
              FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', size: 16, onPressed: _load),
            ],
          ),
          const SizedBox(height: 10),
          if (error != null)
            Text('指标加载失败：$error', style: const TextStyle(fontSize: 12, color: Fs.text3))
          else if (d == null)
            const Center(
              child: Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else ...[
            Row(
              children: [
                stat('${today['calls'] ?? 0}', '今日调用'),
                stat(today['success_rate'] == null ? '—' : '${today['success_rate']}%', '成功率'),
                stat(today['avg_ms'] == null ? '—' : _ms(today['avg_ms'] as num), '平均耗时'),
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 36,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  for (final x in daily)
                    Expanded(
                      child: Tooltip(
                        message: '${(x as Map)['date']}：${x['calls']} 次',
                        child: Container(
                          margin: const EdgeInsets.symmetric(horizontal: 2),
                          height: 4 + 32 * (((x['calls'] as num?) ?? 0) / maxCalls),
                          decoration: BoxDecoration(color: Fs.purple.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(2)),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 10),
            if (fails.isEmpty)
              const Text('近 7 天没有失败的调用', style: TextStyle(fontSize: 12, color: Fs.text3))
            else ...[
              const Text('失败较多的工具', style: TextStyle(fontSize: 12, color: Fs.text3)),
              for (final f in fails.take(3))
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text('${(f as Map)['tool']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
                      ),
                      Text('${f['failed']}/${f['calls']} 次失败', style: const TextStyle(fontSize: 12, color: Fs.red)),
                    ],
                  ),
                ),
            ],
          ],
        ],
      ),
    );
  }

  static String _ms(num ms) => ms >= 1000 ? '${(ms / 1000).toStringAsFixed(1)}s' : '${ms.round()}ms';
}
