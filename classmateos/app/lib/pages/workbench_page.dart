/// 工作台：问候横幅 + 常用应用 + 我的待办 / 今日日程 + 实验室数据看板（六卡，对齐 dashboard/）。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'notification_center.dart';
import 'workbench_apps.dart';
import '../api/phase2_jobs.dart';
import 'message_more.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/agent_sidebar.dart';
import '../widgets/robot_card.dart';
import 'shell.dart';
import 'tasks_page.dart' show fmtDue;

class WorkbenchPage extends StatefulWidget {
  const WorkbenchPage({super.key});
  @override
  State<WorkbenchPage> createState() => _WorkbenchPageState();
}

class _WorkbenchPageState extends State<WorkbenchPage> {
  StreamSubscription<CosEvent>? _liveEvents;
  Map<String, dynamic>? summary;
  String? summaryError;
  List<CosTask> tasks = [];
  List<CosCalendarEvent> todayEvents = [];
  bool loading = true;

  /// 迭代 5（R-WB-02）：报表时间范围。
  CosReportRange range = CosReportRange.week;

  @override
  void initState() {
    super.initState();
    _liveEvents = AppScope.read(context).eventStream.listen((e) {
      if (mounted && (e.eventType.startsWith('calendar.') || e.eventType.startsWith('task.') || e.eventType == 'resync.required')) _load();
    });
    _load();
  }

  @override
  void dispose() {
    _liveEvents?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final s = AppScope.read(context);
    setState(() => loading = true);
    final today = dayStart(DateTime.now());
    await Future.wait([
      (s.feature('dashboard.range') ? s.api.dashboardSummaryRange(range) : s.api.dashboardSummary()).then((v) {
        summary = v;
        summaryError = null;
      }).catchError((Object e) {
        summaryError = describeError(e);
      }),
      s.api.listTasks().then((v) => tasks = v).catchError((Object _) => <CosTask>[]),
      s.api
          .listEvents(today, today.add(const Duration(days: 1)))
          .then((v) => todayEvents = v)
          .catchError((Object _) => <CosCalendarEvent>[]),
    ]);
    if (mounted) setState(() => loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final myTodo = tasks.where((t) => t.assigneeId == s.me.userId && (t.status == 'pending' || t.status == 'in_progress')).toList()
      ..sort((a, b) => (a.due ?? DateTime(9999)).compareTo(b.due ?? DateTime(9999)));
    return Container(
      color: Fs.bg,
      child: RefreshIndicator(
        onRefresh: _load,
        child: LayoutBuilder(builder: (context, c) {
          final w = c.maxWidth.clamp(0.0, 1240.0) - 48;
          final cols = w >= 1000 ? 3 : (w >= 640 ? 2 : 1);
          final cardW = (w - (cols - 1) * 16) / cols;
          return ListView(
            padding: EdgeInsets.symmetric(horizontal: ((c.maxWidth - 1240) / 2).clamp(0.0, double.infinity) + 24, vertical: 24),
            children: [
              if (MediaQuery.sizeOf(context).width < 720 && s.feature('notifications'))
                const Align(alignment: Alignment.centerRight, child: NotificationBell()),
              if (MediaQuery.sizeOf(context).width < 720 && s.feature('message.favorite'))
                Align(alignment: Alignment.centerRight, child: TextButton.icon(onPressed: () => showFavorites(context), icon: const Icon(Icons.star_outline_rounded), label: const Text('我的收藏'))),
              _banner(s, myTodo.length),
              const SizedBox(height: 16),
              const RobotCard(),
              if (s.feature('agent.metrics')) ...[const SizedBox(height: 16), const AgentMetricsCard()],
              const SizedBox(height: 20),
              _sectionTitle('常用应用'),
              const SizedBox(height: 10),
              if (s.feature('workbench.apps')) const WorkbenchApps() else _apps(s),
              const SizedBox(height: 24),
              Wrap(spacing: 16, runSpacing: 16, children: [
                SizedBox(width: cols == 1 ? w : (w - 16) / 2, child: _todoCard(s, myTodo)),
                SizedBox(width: cols == 1 ? w : (w - 16) / 2, child: _eventsCard(s)),
              ]),
              const SizedBox(height: 28),
              Row(children: [
                _sectionTitle('实验室数据看板'),
                const SizedBox(width: 10),
                if (summary?['generated_at'] != null)
                  Text('更新于 ${fmtHm(DateTime.parse(summary!['generated_at'] as String).toLocal())}',
                      style: const TextStyle(fontSize: 12, color: Fs.text3)),
                const Spacer(),
                if (s.feature('dashboard.range')) _rangePicker(),
                TextButton.icon(
                  onPressed: loading ? null : _load,
                  icon: loading
                      ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.refresh_rounded, size: 16),
                  label: const Text('刷新'),
                ),
              ]),
              const SizedBox(height: 10),
              if (summaryError != null)
                _Card(
                  title: '数据看板',
                  icon: Icons.insert_chart_outlined,
                  color: Fs.red,
                  child: Text('看板数据加载失败：$summaryError', style: const TextStyle(color: Fs.text2)),
                )
              else if (summary == null)
                const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator(strokeWidth: 2)))
              else
                Wrap(spacing: 16, runSpacing: 16, children: [
                  for (final card in _dashboardCards(summary!)) SizedBox(width: cardW, height: 268, child: card),
                ]),
            ],
          );
        }),
      ),
    );
  }

  Widget _rangePicker() {
    Future<void> pick(String r) async {
      var next = CosReportRange(r);
      if (r == 'custom') {
        final now = DateTime.now();
        final d = await showDateRangePicker(
          context: context,
          firstDate: DateTime(now.year - 2),
          lastDate: now,
          initialDateRange: range.start == null ? null : DateTimeRange(start: range.start!, end: range.end!.subtract(const Duration(days: 1))),
        );
        if (d == null) return;
        next = CosReportRange('custom', d.start, d.end.add(const Duration(days: 1)));
      }
      setState(() {
        range = next;
        summary = null;
      });
      _load();
    }

    return SegmentedButton<String>(
      key: const ValueKey('report-range'),
      showSelectedIcon: false,
      style: SegmentedButton.styleFrom(
        visualDensity: VisualDensity.compact,
        selectedBackgroundColor: Fs.primaryLight,
        selectedForegroundColor: Fs.primary,
        side: const BorderSide(color: Fs.line),
        textStyle: const TextStyle(fontSize: 12),
      ),
      segments: [
        const ButtonSegment(value: 'week', label: Text('本周')),
        const ButtonSegment(value: 'month', label: Text('本月')),
        const ButtonSegment(value: 'semester', label: Text('本学期')),
        ButtonSegment(value: 'custom', label: Text(range.range == 'custom' ? range.label : '自定义')),
      ],
      selected: {range.range},
      // 再点一次「自定义」可以重新选日期
      onSelectionChanged: (v) => pick(v.first),
      emptySelectionAllowed: false,
    );
  }

  Widget _sectionTitle(String t) => Text(t, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600));

  Widget _banner(AppState s, int todo) {
    final now = DateTime.now();
    Widget stat(String n, String label, VoidCallback onTap) => InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            child: Column(children: [
              Text(n, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: Colors.white)),
              Text(label, style: TextStyle(fontSize: 12, color: Colors.white.withValues(alpha: 0.85))),
            ]),
          ),
        );
    return Container(
      padding: const EdgeInsets.fromLTRB(28, 24, 20, 24),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(14),
        gradient: const LinearGradient(
          colors: [Color(0xFF2B5FE8), Color(0xFF4E83FD), Color(0xFF7F9CFF)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Wrap(
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        runSpacing: 16,
        children: [
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text('${greeting()}，${s.me.name}',
                style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: Colors.white)),
            const SizedBox(height: 6),
            Text('今天是 ${now.year}年${fmtDateCn(now)} ${weekdayCn(now)}，祝你工作顺利',
                style: TextStyle(fontSize: 14, color: Colors.white.withValues(alpha: 0.88))),
          ]),
          Row(mainAxisSize: MainAxisSize.min, children: [
            stat('${s.totalUnread}', '未读消息', () => s.go(AppModule.messages)),
            stat('${todayEvents.length}', '今日日程', () => s.go(AppModule.calendar)),
            stat('$todo', '待办任务', () => s.go(AppModule.tasks)),
          ]),
        ],
      ),
    );
  }

  Widget _apps(AppState s) {
    const desc = {
      AppModule.messages: '单聊群聊',
      AppModule.calendar: '会议排期',
      AppModule.docs: '文档协作',
      AppModule.wiki: '知识沉淀',
      AppModule.bitable: '数据管理',
      AppModule.tasks: '待办跟进',
      AppModule.drive: '文件存储',
      AppModule.contacts: '组织成员',
    };
    return Wrap(spacing: 12, runSpacing: 12, children: [
      for (final m in AppModule.values.where((m) => m != AppModule.workbench && m != AppModule.me && s.moduleVisible(m)))
        HoverBox(
          onTap: () => s.go(m),
          hoverColor: Colors.white,
          radius: 12,
          child: Container(
            width: 148,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Fs.lineLight),
            ),
            child: Row(children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [ModuleMeta.of(m).color.withValues(alpha: 0.75), ModuleMeta.of(m).color],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(ModuleMeta.of(m).activeIcon, color: Colors.white, size: 20),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(m.label, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                  Text(desc[m] ?? '', style: const TextStyle(fontSize: 11, color: Fs.text3)),
                ]),
              ),
            ]),
          ),
        ),
    ]);
  }

  Widget _todoCard(AppState s, List<CosTask> todo) => _Card(
        title: '我的待办',
        icon: Icons.task_alt_rounded,
        color: const Color(0xFF2EA121),
        trailing: TextButton(onPressed: () => s.go(AppModule.tasks), child: const Text('全部')),
        child: todo.isEmpty
            ? const _Empty('没有待办任务，太棒了')
            : Column(children: [
                for (final t in todo.take(5))
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Row(children: [
                      Icon(t.status == 'in_progress' ? Icons.timelapse_rounded : Icons.radio_button_unchecked_rounded,
                          size: 16, color: t.status == 'in_progress' ? Fs.primary : Fs.textDisabled),
                      const SizedBox(width: 10),
                      Expanded(child: Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14))),
                      if (t.due != null)
                        Text(fmtDue(t.due!),
                            style: TextStyle(fontSize: 12, color: t.due!.isBefore(DateTime.now()) ? Fs.red : Fs.text3)),
                    ]),
                  ),
              ]),
      );

  Widget _eventsCard(AppState s) => _Card(
        title: '今日日程',
        icon: Icons.event_note_rounded,
        color: Fs.orange,
        trailing: TextButton(onPressed: () => s.go(AppModule.calendar), child: const Text('打开日历')),
        child: todayEvents.isEmpty
            ? const _Empty('今天没有日程')
            : Column(children: [
                for (final e in todayEvents.take(5))
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Row(children: [
                      SizedBox(
                        width: 92,
                        child: Text('${fmtHm(e.start)} - ${fmtHm(e.end)}', style: const TextStyle(fontSize: 12, color: Fs.text2)),
                      ),
                      Container(width: 3, height: 18, color: e.createdBy == s.me.userId ? Fs.primary : const Color(0xFF2EA121)),
                      const SizedBox(width: 10),
                      Expanded(child: Text(e.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14))),
                    ]),
                  ),
              ]),
      );

  // ---------------- 六卡 ----------------

  Map<String, num> _numMap(dynamic m) =>
      m is Map ? {for (final e in m.entries) e.key.toString(): (e.value as num?) ?? 0} : const {};

  List<Widget> _dashboardCards(Map<String, dynamic> d) {
    final kpi = (d['projects_kpi'] as Map?) ?? const {};
    final usage = (d['tool_usage'] as Map?) ?? const {};
    final success = ((d['tool_success'] as Map?)?['by_tool'] as Map?) ?? const {};
    final equip = (d['equipment'] as Map?) ?? const {};
    final subs = (d['submissions'] as Map?) ?? const {};
    // 正式格式是数组；兼容对象写法 {recent: [...]} / {items: [...]}，避免格式不符时整页报错
    final rawFailures = d['failures'];
    final failures = rawFailures is List
        ? rawFailures
        : rawFailures is Map
            ? ((rawFailures['recent'] ?? rawFailures['items']) is List ? (rawFailures['recent'] ?? rawFailures['items']) as List : const [])
            : const [];
    final overdue = (kpi['gantt_overdue'] as num?) ?? 0;

    return [
      _Card(
        title: '项目概览',
        icon: Icons.rocket_launch_outlined,
        color: Fs.primary,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            _bigNumber('${kpi['projects_total'] ?? 0}', '项目总数'),
            _bigNumber('${kpi['gantt_total'] ?? 0}', '甘特节点'),
            _bigNumber('$overdue', '逾期节点', color: overdue > 0 ? Fs.red : null),
          ]),
          const SizedBox(height: 14),
          Expanded(child: _StackBar(_numMap(kpi['projects_by_status']), empty: '还没有项目')),
        ]),
      ),
      _Card(
        title: '本周工具调用',
        icon: Icons.bolt_rounded,
        color: Fs.purple,
        trailing: Text('共 ${usage['total'] ?? 0} 次', style: const TextStyle(fontSize: 12, color: Fs.text3)),
        child: _Bars(_numMap(usage['by_tool']), color: Fs.purple, empty: '近 7 天没有工具调用'),
      ),
      _Card(
        title: '工具成功率',
        icon: Icons.verified_outlined,
        color: const Color(0xFF2EA121),
        child: success.isEmpty
            ? const _Empty('暂无调用记录')
            : ListView(
                padding: EdgeInsets.zero,
                children: [
                  for (final e in success.entries.take(8))
                    Builder(builder: (_) {
                      final v = (e.value as Map?) ?? const {};
                      final rate = ((v['rate'] as num?) ?? 0).toDouble();
                      final color = rate >= 90 ? const Color(0xFF2EA121) : (rate >= 70 ? Fs.orange : Fs.red);
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 5),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Row(children: [
                            Expanded(
                              child: Text(e.key.toString(),
                                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
                            ),
                            Text('${fmtNumber(rate)}%  ',
                                style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w600)),
                            Text('${v['ok'] ?? 0}/${v['total'] ?? 0}', style: const TextStyle(fontSize: 11, color: Fs.text3)),
                          ]),
                          const SizedBox(height: 4),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(3),
                            child: LinearProgressIndicator(
                              value: rate / 100,
                              minHeight: 5,
                              color: color,
                              backgroundColor: Fs.lineLight,
                            ),
                          ),
                        ]),
                      );
                    }),
                ],
              ),
      ),
      _Card(
        title: '器材状态',
        icon: Icons.precision_manufacturing_outlined,
        color: Fs.teal,
        trailing: Text('共 ${equip['total'] ?? 0} 件', style: const TextStyle(fontSize: 12, color: Fs.text3)),
        child: _StackBar(_numMap(equip['by_state']), empty: '还没有登记器材'),
      ),
      _Card(
        title: '投稿管线',
        icon: Icons.article_outlined,
        color: Fs.orange,
        trailing: Text('共 ${subs['total'] ?? 0} 篇', style: const TextStyle(fontSize: 12, color: Fs.text3)),
        child: _Bars(_numMap(subs['by_status']), color: Fs.orange, empty: '还没有投稿记录'),
      ),
      _Card(
        title: '近期失败归档',
        icon: Icons.report_gmailerrorred_rounded,
        color: Fs.red,
        child: failures.isEmpty
            ? const _Empty('没有失败记录')
            : ListView(
                padding: EdgeInsets.zero,
                children: [
                  for (final f in failures.whereType<Map>())
                    Builder(builder: (_) {
                      final fields = (f['fields'] as Map?) ?? const {};
                      final title = (fields['title'] ?? fields['summary'] ?? fields['tool_name'] ?? fields.values.firstOrNull ?? f['record_id'])
                          .toString();
                      final reason = (fields['reason'] ?? fields['error'] ?? fields['lesson'] ?? '').toString();
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          const Padding(
                            padding: EdgeInsets.only(top: 5),
                            child: Icon(Icons.circle, size: 7, color: Fs.red),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                              if (reason.isNotEmpty)
                                Text(reason,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 12, color: Fs.text3)),
                            ]),
                          ),
                        ]),
                      );
                    }),
                ],
              ),
      ),
    ];
  }

  Widget _bigNumber(String n, String label, {Color? color}) => Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(n, style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: color ?? Fs.text1)),
          Text(label, style: const TextStyle(fontSize: 12, color: Fs.text3)),
        ]),
      );
}

class _Card extends StatelessWidget {
  final String title;
  final IconData icon;
  final Color color;
  final Widget child;
  final Widget? trailing;
  const _Card({required this.title, required this.icon, required this.color, required this.child, this.trailing});

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, c) => _build(c.hasBoundedHeight));

  Widget _build(bool bounded) => Container(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Fs.lineLight),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          SizedBox(
            height: 32,
            child: Row(children: [
              Container(
                padding: const EdgeInsets.all(5),
                decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(7)),
                child: Icon(icon, size: 16, color: color),
              ),
              const SizedBox(width: 8),
              Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              const Spacer(),
              ?trailing,
            ]),
          ),
          const SizedBox(height: 10),
          if (bounded) Flexible(child: child) else child,
        ]),
      );
}

class _Empty extends StatelessWidget {
  final String text;
  const _Empty(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 20),
        child: Center(child: Text(text, style: const TextStyle(fontSize: 13, color: Fs.text3))),
      );
}

/// 横向条形图（按数值降序）。
class _Bars extends StatelessWidget {
  final Map<String, num> data;
  final Color color;
  final String empty;
  const _Bars(this.data, {required this.color, required this.empty});

  @override
  Widget build(BuildContext context) {
    if (data.isEmpty) return _Empty(empty);
    final entries = data.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    final max = entries.first.value == 0 ? 1 : entries.first.value;
    return ListView(padding: EdgeInsets.zero, children: [
      for (final e in entries.take(7))
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(children: [
            SizedBox(
              width: 96,
              child: Text(e.key, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text2)),
            ),
            Expanded(
              child: LayoutBuilder(
                builder: (_, c) => Align(
                  alignment: Alignment.centerLeft,
                  child: Container(
                    width: (c.maxWidth * (e.value / max)).clamp(4.0, c.maxWidth),
                    height: 14,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(colors: [color.withValues(alpha: 0.55), color]),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
              ),
            ),
            SizedBox(
              width: 36,
              child: Text(fmtNumber(e.value), textAlign: TextAlign.right, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            ),
          ]),
        ),
    ]);
  }
}

/// 堆叠占比条 + 图例（状态分布）。
class _StackBar extends StatelessWidget {
  final Map<String, num> data;
  final String empty;
  const _StackBar(this.data, {required this.empty});

  @override
  Widget build(BuildContext context) {
    final total = data.values.fold<num>(0, (a, b) => a + b);
    if (data.isEmpty || total == 0) return _Empty(empty);
    final entries = data.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      ClipRRect(
        borderRadius: BorderRadius.circular(5),
        child: SizedBox(
          height: 12,
          child: Row(children: [
            for (final e in entries)
              Expanded(
                flex: (e.value * 1000 ~/ total).clamp(1, 1000),
                child: Container(color: TagColor.of(e.key).fg.withValues(alpha: 0.8)),
              ),
          ]),
        ),
      ),
      const SizedBox(height: 14),
      Flexible(
        child: ListView(shrinkWrap: true, padding: EdgeInsets.zero, children: [
          for (final e in entries)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(color: TagColor.of(e.key).fg.withValues(alpha: 0.8), borderRadius: BorderRadius.circular(3)),
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(e.key, style: const TextStyle(fontSize: 13))),
                Text(fmtNumber(e.value), style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                SizedBox(
                  width: 52,
                  child: Text('${(e.value / total * 100).toStringAsFixed(0)}%',
                      textAlign: TextAlign.right, style: const TextStyle(fontSize: 12, color: Fs.text3)),
                ),
              ]),
            ),
        ]),
      ),
    ]);
  }
}
