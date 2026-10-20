/// 日历：迷你月历 + 周视图 / 日视图时间轴，点击空白处快速创建日程。
library;

import '../services/rrule.dart';
import '../widgets/recurrence_picker.dart';
import 'dart:async';

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';

const _hourH = 52.0;

DateTime weekStart(DateTime d) => dayStart(d).subtract(Duration(days: d.weekday - 1));

class CalendarPage extends StatefulWidget {
  const CalendarPage({super.key});
  @override
  State<CalendarPage> createState() => _CalendarPageState();
}

class _CalendarPageState extends State<CalendarPage> {
  StreamSubscription<CosEvent>? _liveEvents;
  DateTime focus = dayStart(DateTime.now());
  DateTime miniMonth = DateTime(DateTime.now().year, DateTime.now().month);
  bool weekView = true;
  List<CosCalendarEvent> events = [];
  bool loading = false;
  bool showMine = true;
  bool showInvited = true;
  final vCtrl = ScrollController(initialScrollOffset: _hourH * 7.5);
  Timer? clock;

  @override
  void initState() {
    super.initState();
    _s.addListener(_checkTarget);
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkTarget());
    _liveEvents = AppScope.read(context).eventStream.listen((e) {
      if (mounted && (e.eventType.startsWith('calendar.') || e.eventType.startsWith('task.') || e.eventType == 'resync.required')) _load();
    });
    _load();
    // 每分钟刷新一次「当前时间」红线
    clock = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  late final AppState _s = AppScope.read(context);

  /// 从全局搜索 / 通知跳过来：{type: calendar | event, id, start_ms?}，翻到日程所在的那一周并打开详情。
  Future<void> _checkTarget() async {
    final t = _s.pendingTarget;
    if (!mounted || t == null || _s.module != AppModule.calendar) return;
    if (t['type'] != 'calendar' && t['type'] != 'event') return;
    _s.pendingTarget = null;
    final ms = t['start_ms'] is num ? (t['start_ms'] as num).toInt() : int.tryParse('${t['start_ms'] ?? ''}');
    if (ms == null) return;
    final d = dayStart(DateTime.fromMillisecondsSinceEpoch(ms));
    setState(() {
      focus = d;
      miniMonth = DateTime(d.year, d.month);
    });
    await _load();
    if (!mounted) return;
    final e = events.where((x) => x.eventId == t['id']).firstOrNull;
    if (e != null) _detail(e);
  }

  @override
  void dispose() {
    _s.removeListener(_checkTarget);
    _liveEvents?.cancel();
    clock?.cancel();
    vCtrl.dispose();
    super.dispose();
  }

  (DateTime, DateTime) _range(int days) {
    final start = days == 7 ? weekStart(focus) : focus;
    return (start, start.add(Duration(days: days)));
  }

  Future<void> _load() async {
    setState(() => loading = true);
    // 拉宽窗口（前后各一周），切换周/日时不用重复请求
    final from = weekStart(focus).subtract(const Duration(days: 7));
    final to = from.add(const Duration(days: 21));
    try {
      final list = await AppScope.read(context).api.listEvents(from, to, expandRecurring: AppScope.read(context).feature('calendar.recurrence'));
      if (mounted) setState(() => events = list);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  void _goto(DateTime d) {
    final old = weekStart(focus);
    setState(() {
      focus = dayStart(d);
      miniMonth = DateTime(d.year, d.month);
    });
    if (weekStart(d) != old) _load();
  }

  List<CosCalendarEvent> get filtered {
    final me = AppScope.read(context).me.userId;
    return events.where((e) => e.createdBy == me ? showMine : showInvited).toList();
  }

  Future<void> _create({DateTime? start}) async {
    final ok = await showScopedDialog<bool>(context, (_) => EventEditor(initialStart: start));
    if (ok == true) _load();
  }

  Future<void> _detail(CosCalendarEvent e) async {
    final r = await showScopedDialog<String>(context, (_) => _EventDetail(event: e));
    if (!mounted) return;
    if (r == 'edit') {
      final ok = await showScopedDialog<bool>(context, (_) => EventEditor(event: e));
      if (ok == true) _load();
    } else if (r != null) {
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 960;
      final days = !weekView || c.maxWidth < 560 ? 1 : 7;
      return Row(children: [
        if (wide) SizedBox(width: 264, child: _sidebar(context)),
        if (wide) const VerticalDivider(width: 1),
        Expanded(
          child: Container(
            color: Colors.white,
            child: Column(children: [
              _header(context, days, wide, c.maxWidth < 560),
              if (loading) const LinearProgressIndicator(minHeight: 2) else const SizedBox(height: 2),
              Expanded(child: _grid(context, days)),
            ]),
          ),
        ),
      ]);
    });
  }

  Widget _header(BuildContext context, int days, bool wide, bool forceDay) {
    final (start, end) = _range(days);
    final last = end.subtract(const Duration(days: 1));
    final title = days == 1
        ? '${focus.year}年${focus.month}月${focus.day}日 ${weekdayCn(focus)}'
        : start.month == last.month
            ? '${start.year}年${start.month}月'
            : '${start.year}年${start.month}月 - ${last.month}月';
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Row(children: [
        OutlinedButton(
          onPressed: () => _goto(DateTime.now()),
          style: OutlinedButton.styleFrom(minimumSize: const Size(52, 32)),
          child: const Text('今天'),
        ),
        const SizedBox(width: 8),
        FsIconButton(
          icon: Icons.chevron_left_rounded,
          tooltip: days == 1 ? '前一天' : '上一周',
          onPressed: () => _goto(focus.subtract(Duration(days: days))),
        ),
        FsIconButton(
          icon: Icons.chevron_right_rounded,
          tooltip: days == 1 ? '后一天' : '下一周',
          onPressed: () => _goto(focus.add(Duration(days: days))),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(title,
              maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        ),
        const Spacer(),
        if (!forceDay)
          SegmentedButton<bool>(
            showSelectedIcon: false,
            style: SegmentedButton.styleFrom(
              visualDensity: VisualDensity.compact,
              selectedBackgroundColor: Fs.primaryLight,
              selectedForegroundColor: Fs.primary,
              side: const BorderSide(color: Fs.line),
              textStyle: const TextStyle(fontSize: 13),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Fs.radius)),
            ),
            segments: const [
              ButtonSegment(value: false, label: Text('日')),
              ButtonSegment(value: true, label: Text('周')),
            ],
            selected: {weekView},
            onSelectionChanged: (v) => setState(() => weekView = v.first),
          ),
        const SizedBox(width: 4),
        FsIconButton(icon: Icons.refresh_rounded, tooltip: '刷新', onPressed: _load),
        if (!wide) ...[
          const SizedBox(width: 4),
          FilledButton(
            onPressed: () => _create(),
            style: FilledButton.styleFrom(minimumSize: const Size(36, 32), padding: const EdgeInsets.symmetric(horizontal: 10)),
            child: const Icon(Icons.add_rounded, size: 18),
          ),
        ],
      ]),
    );
  }

  // ---------------- 左侧栏 ----------------

  Widget _sidebar(BuildContext context) {
    final s = AppScope.of(context);
    final today = dayStart(DateTime.now());
    final todayEvents = filtered.where((e) => e.start.isBefore(today.add(const Duration(days: 1))) && e.end.isAfter(today)).toList();
    return Container(
      color: Fs.bg,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        SizedBox(
          height: 40,
          child: FilledButton.icon(
            onPressed: () => _create(),
            icon: const Icon(Icons.add_rounded, size: 20),
            label: const Text('创建日程'),
          ),
        ),
        const SizedBox(height: 18),
        _miniCalendar(),
        const SizedBox(height: 20),
        const Text('我的日历', style: TextStyle(fontSize: 13, color: Fs.text2, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        _calToggle('我创建的日程', Fs.primary, showMine, (v) => setState(() => showMine = v)),
        _calToggle('邀请我的日程', const Color(0xFF2EA121), showInvited, (v) => setState(() => showInvited = v)),
        const SizedBox(height: 20),
        Row(children: [
          const Text('今日安排', style: TextStyle(fontSize: 13, color: Fs.text2, fontWeight: FontWeight.w600)),
          const Spacer(),
          Text('${todayEvents.length} 项', style: const TextStyle(fontSize: 12, color: Fs.text3)),
        ]),
        const SizedBox(height: 8),
        if (todayEvents.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text('今天没有日程，安心工作吧', style: TextStyle(fontSize: 12, color: Fs.text3)),
          ),
        for (final e in todayEvents)
          HoverBox(
            onTap: () => _detail(e),
            hoverColor: const Color(0xFFE8E9EB),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
            child: Row(children: [
              Container(
                width: 3,
                height: 30,
                decoration: BoxDecoration(
                  color: e.createdBy == s.me.userId ? Fs.primary : const Color(0xFF2EA121),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(e.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                  Text('${fmtHm(e.start)} - ${fmtHm(e.end)}', style: const TextStyle(fontSize: 11, color: Fs.text3)),
                ]),
              ),
            ]),
          ),
      ]),
    );
  }

  Widget _calToggle(String label, Color color, bool on, ValueChanged<bool> f) => HoverBox(
        onTap: () => f(!on),
        hoverColor: const Color(0xFFE8E9EB),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
        child: Row(children: [
          Container(
            width: 16,
            height: 16,
            decoration: BoxDecoration(
              color: on ? color : Colors.transparent,
              border: Border.all(color: color, width: 1.5),
              borderRadius: BorderRadius.circular(4),
            ),
            child: on ? const Icon(Icons.check_rounded, size: 12, color: Colors.white) : null,
          ),
          const SizedBox(width: 10),
          Text(label, style: const TextStyle(fontSize: 13)),
        ]),
      );

  Widget _miniCalendar() {
    final first = miniMonth;
    final gridStart = weekStart(first);
    final today = dayStart(DateTime.now());
    final ws = weekStart(focus);
    return Column(children: [
      Row(children: [
        Text('${first.year}年${first.month}月', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        const Spacer(),
        FsIconButton(
          icon: Icons.chevron_left_rounded,
          tooltip: '上个月',
          size: 18,
          onPressed: () => setState(() => miniMonth = DateTime(first.year, first.month - 1)),
        ),
        FsIconButton(
          icon: Icons.chevron_right_rounded,
          tooltip: '下个月',
          size: 18,
          onPressed: () => setState(() => miniMonth = DateTime(first.year, first.month + 1)),
        ),
      ]),
      const SizedBox(height: 6),
      Row(children: [
        for (final w in const ['一', '二', '三', '四', '五', '六', '日'])
          Expanded(child: Center(child: Text(w, style: const TextStyle(fontSize: 11, color: Fs.text3)))),
      ]),
      const SizedBox(height: 4),
      for (var r = 0; r < 6; r++)
        Container(
          decoration: BoxDecoration(
            color: weekView && gridStart.add(Duration(days: r * 7)) == ws ? Fs.primaryLight : null,
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(children: [
            for (var c = 0; c < 7; c++)
              Expanded(child: _miniDay(gridStart.add(Duration(days: r * 7 + c)), first, today)),
          ]),
        ),
    ]);
  }

  Widget _miniDay(DateTime d, DateTime month, DateTime today) {
    final isToday = d == today;
    final isFocus = d == focus && !weekView;
    final inMonth = d.month == month.month;
    final hasEvent = events.any((e) => sameDay(e.start, d));
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () => _goto(d),
      child: SizedBox(
        height: 30,
        child: Stack(alignment: Alignment.center, children: [
          Container(
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: isToday ? Fs.primary : (isFocus ? Fs.primaryLight : null),
            ),
            child: Text(
              '${d.day}',
              style: TextStyle(
                fontSize: 12,
                color: isToday ? Colors.white : (inMonth ? Fs.text1 : Fs.textDisabled),
                fontWeight: isToday ? FontWeight.w600 : FontWeight.normal,
              ),
            ),
          ),
          if (hasEvent && !isToday)
            Positioned(
              bottom: 1,
              child: Container(width: 4, height: 4, decoration: const BoxDecoration(color: Fs.primary, shape: BoxShape.circle)),
            ),
        ]),
      ),
    );
  }

  // ---------------- 时间轴 ----------------

  Widget _grid(BuildContext context, int days) {
    final (start, _) = _range(days);
    final dates = [for (var i = 0; i < days; i++) start.add(Duration(days: i))];
    final today = dayStart(DateTime.now());
    final s = AppScope.of(context);
    const gutter = 56.0;
    return Column(children: [
      Container(
        height: 62,
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.line))),
        child: Row(children: [
          const SizedBox(
            width: gutter,
            child: Align(
              alignment: Alignment.bottomCenter,
              child: Padding(
                padding: EdgeInsets.only(bottom: 6),
                child: Text('GMT+8', style: TextStyle(fontSize: 10, color: Fs.text3)),
              ),
            ),
          ),
          for (final d in dates)
            Expanded(
              child: InkWell(
                onTap: days == 7
                    ? () => setState(() {
                          focus = d;
                          weekView = false;
                        })
                    : null,
                child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Text(weekdayCn(d), style: TextStyle(fontSize: 12, color: d == today ? Fs.primary : Fs.text2)),
                  const SizedBox(height: 4),
                  Container(
                    width: 30,
                    height: 30,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(shape: BoxShape.circle, color: d == today ? Fs.primary : null),
                    child: Text('${d.day}',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                          color: d == today ? Colors.white : (d.weekday >= 6 ? Fs.text3 : Fs.text1),
                        )),
                  ),
                ]),
              ),
            ),
        ]),
      ),
      Expanded(
        child: SingleChildScrollView(
          controller: vCtrl,
          child: SizedBox(
            height: _hourH * 24 + 12,
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(
                width: gutter,
                child: Stack(children: [
                  for (var h = 1; h < 24; h++)
                    Positioned(
                      top: h * _hourH - 7,
                      right: 8,
                      child: Text('${two(h)}:00', style: const TextStyle(fontSize: 11, color: Fs.text3)),
                    ),
                ]),
              ),
              for (final d in dates)
                Expanded(
                  child: LayoutBuilder(builder: (context, c) => _dayColumn(context, s, d, c.maxWidth, d == today)),
                ),
            ]),
          ),
        ),
      ),
    ]);
  }

  Widget _dayColumn(BuildContext context, AppState s, DateTime day, double width, bool isToday) {
    final dayEnd = day.add(const Duration(days: 1));
    final list = filtered.where((e) => e.start.isBefore(dayEnd) && e.end.isAfter(day)).toList()
      ..sort((a, b) => a.start.compareTo(b.start));
    // 重叠日程分列：同一簇内贪心分配列号
    final col = <String, int>{};
    final cols = <String, int>{};
    var cluster = <CosCalendarEvent>[];
    var clusterEnd = DateTime(0);
    final colEnds = <DateTime>[];
    void flush() {
      final n = colEnds.length;
      for (final e in cluster) {
        cols[e.eventId] = n;
      }
      cluster = [];
      colEnds.clear();
    }

    for (final e in list) {
      if (cluster.isNotEmpty && !e.start.isBefore(clusterEnd)) flush();
      var placed = false;
      for (var i = 0; i < colEnds.length; i++) {
        if (!e.start.isBefore(colEnds[i])) {
          col[e.eventId] = i;
          colEnds[i] = e.end;
          placed = true;
          break;
        }
      }
      if (!placed) {
        col[e.eventId] = colEnds.length;
        colEnds.add(e.end);
      }
      cluster.add(e);
      if (e.end.isAfter(clusterEnd)) clusterEnd = e.end;
    }
    flush();

    final now = DateTime.now();
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapUp: (d) {
        final mins = (d.localPosition.dy / _hourH * 60).floor();
        final rounded = (mins ~/ 30) * 30;
        _create(start: day.add(Duration(minutes: rounded.clamp(0, 23 * 60 + 30))));
      },
      child: Container(
        decoration: BoxDecoration(
          color: isToday ? const Color(0xFFFAFCFF) : null,
          border: const Border(left: BorderSide(color: Fs.lineLight)),
        ),
        child: Stack(clipBehavior: Clip.none, children: [
          for (var h = 1; h < 24; h++)
            Positioned(top: h * _hourH, left: 0, right: 0, child: Container(height: 1, color: Fs.lineLight)),
          for (final e in list) _eventBlock(s, e, day, width, col[e.eventId] ?? 0, cols[e.eventId] ?? 1),
          if (isToday)
            Positioned(
              top: (now.hour * 60 + now.minute) / 60 * _hourH - 4,
              left: -4,
              right: 0,
              child: Row(children: [
                Container(width: 8, height: 8, decoration: const BoxDecoration(color: Fs.red, shape: BoxShape.circle)),
                Expanded(child: Container(height: 1.5, color: Fs.red)),
              ]),
            ),
        ]),
      ),
    );
  }

  Widget _eventBlock(AppState s, CosCalendarEvent e, DateTime day, double width, int col, int cols) {
    final dayEnd = day.add(const Duration(days: 1));
    final st = e.start.isBefore(day) ? day : e.start;
    final en = e.end.isAfter(dayEnd) ? dayEnd : e.end;
    final top = st.difference(day).inMinutes / 60 * _hourH;
    final h = (en.difference(st).inMinutes / 60 * _hourH).clamp(20.0, _hourH * 24);
    final w = (width - 6) / cols;
    final mine = e.createdBy == s.me.userId;
    final color = mine ? Fs.primary : const Color(0xFF2EA121);
    final bg = mine ? const Color(0xFFE1EAFF) : const Color(0xFFD9F5D6);
    return Positioned(
      top: top + 1,
      left: 2 + col * w,
      width: w - 2,
      height: h - 2,
      child: Tooltip(
        message: '${e.isRecurring ? '↻ ' : ''}${e.title}\n${fmtHm(e.start)} - ${fmtHm(e.end)}',
        child: HoverBox(
          onTap: () => _detail(e),
          radius: 4,
          hoverColor: bg,
          child: Container(
            // 不到半小时的日程卡片很矮：单行、无上下内边距，避免文字溢出
            padding: h < 30 ? const EdgeInsets.fromLTRB(6, 0, 4, 0) : const EdgeInsets.fromLTRB(6, 3, 4, 2),
            alignment: h < 30 ? Alignment.centerLeft : Alignment.topLeft,
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.circular(4),
              border: Border(left: BorderSide(color: color, width: 3)),
            ),
            child: ClipRect(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${e.isRecurring ? '↻ ' : ''}${e.title}${h < 30 ? '  ${fmtHm(e.start)}' : ''}',
                    maxLines: h > 44 ? 2 : 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: h < 30 ? 11 : 12, height: h < 30 ? 1.1 : null, fontWeight: FontWeight.w600, color: color == Fs.primary ? Fs.primaryPressed : const Color(0xFF237B19))),
                if (h > 34)
                  Text('${fmtHm(e.start)} - ${fmtHm(e.end)}',
                      maxLines: 1, style: TextStyle(fontSize: 11, color: color.withValues(alpha: 0.85))),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------- 日程详情 ----------------

class _EventDetail extends StatelessWidget {
  final CosCalendarEvent event;
  const _EventDetail({required this.event});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final e = event;
    final canDelete = e.createdBy == s.me.userId;
    final myRsvp = e.attendees.where((a) => a.userId == s.me.userId).firstOrNull?.rsvp;
    String rsvpOf(String id) =>
        id == e.createdBy ? 'accepted' : (e.attendees.where((a) => a.userId == id).firstOrNull?.rsvp ?? 'pending');
    final sameDate = sameDay(e.start, e.end);
    return Dialog(
      child: SizedBox(
        width: 420,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 16, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(
                margin: const EdgeInsets.only(top: 6),
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  color: canDelete ? Fs.primary : const Color(0xFF2EA121),
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(child: Text(e.title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
              if (canDelete)
                FsIconButton(
                  icon: Icons.edit_outlined,
                  tooltip: '编辑日程',
                  onPressed: () => Navigator.pop(context, 'edit'),
                ),
              if (canDelete)
                FsIconButton(
                  icon: Icons.delete_outline_rounded,
                  tooltip: '删除日程',
                  onPressed: () async {
                    final ok = await confirmDialog(context, title: '删除日程', content: '确定删除「${e.title}」吗？', ok: '删除', danger: true);
                    if (!ok || !context.mounted) return;
                    try {
                      final scope = e.isRecurring ? await pickRecurrenceScope(context) : null;
                      if (e.isRecurring && scope == null) return;
                      await s.api.deleteEvent(e.eventId, scope: scope);
                      if (context.mounted) {
                        showToast(context, '日程已删除');
                        Navigator.pop(context, 'deleted');
                      }
                    } catch (err) {
                      if (!context.mounted) return;
                      if (err is CosApiException && err.code == 'EVENT_CONFLICT') {
                        showToast(context, '这个日程刚被别人改过，已刷新，请重新打开后再操作', error: true);
                        Navigator.pop(context, 'conflict');
                      } else {
                        showToast(context, describeError(err), error: true);
                      }
                    }
                  },
                ),
              FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: () => Navigator.pop(context)),
            ]),
            const SizedBox(height: 16),
            _row(Icons.schedule_rounded,
                sameDate
                    ? '${fmtDateCn(e.start)} ${weekdayCn(e.start)}  ${fmtHm(e.start)} - ${fmtHm(e.end)}'
                    : '${fmtDateCn(e.start)} ${fmtHm(e.start)} - ${fmtDateCn(e.end)} ${fmtHm(e.end)}'),
            if (e.recurrence != null)
              _row(Icons.repeat_rounded, '${RRule.tryParse(e.recurrence)?.describe() ?? '自定义重复'}${e.isException ? '（这一次单独改过）' : ''}'),
            if (e.location != null && e.location!.isNotEmpty) _row(Icons.place_outlined, e.location!),
            _row(Icons.person_outline_rounded, '组织者：${s.userName(e.createdBy)}'),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Icon(Icons.groups_outlined, size: 18, color: Fs.text3),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(
                      '${e.attendeeIds.length} 位参与者'
                      '${_count(e, 'accepted') > 0 ? ' · ${_count(e, 'accepted')} 人接受' : ''}'
                      '${_count(e, 'declined') > 0 ? ' · ${_count(e, 'declined')} 人拒绝' : ''}',
                      style: const TextStyle(fontSize: 14),
                    ),
                    const SizedBox(height: 8),
                    Wrap(spacing: 10, runSpacing: 8, children: [
                      for (final id in e.attendeeIds)
                        Tooltip(
                          message: _rsvpLabel(rsvpOf(id)),
                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                            Stack(clipBehavior: Clip.none, children: [
                              FsAvatar(name: s.userName(id), seed: id, size: 22),
                              Positioned(right: -3, bottom: -3, child: _rsvpBadge(rsvpOf(id))),
                            ]),
                            const SizedBox(width: 6),
                            Text(s.userName(id), style: const TextStyle(fontSize: 13, color: Fs.text2)),
                          ]),
                        ),
                    ]),
                  ]),
                ),
              ]),
            ),
            if (e.description != null && e.description!.isNotEmpty) _row(Icons.notes_rounded, e.description!),
            if (!canDelete && myRsvp != null) ...[
              const Divider(height: 24),
              Row(children: [
                const Text('是否参加？', style: TextStyle(fontSize: 14, color: Fs.text2)),
                const Spacer(),
                for (final (v, label) in const [('accepted', '接受'), ('tentative', '待定'), ('declined', '拒绝')]) ...[
                  const SizedBox(width: 6),
                  ChoiceChip(
                    label: Text(label),
                    selected: myRsvp == v,
                    showCheckmark: false,
                    visualDensity: VisualDensity.compact,
                    selectedColor: v == 'declined' ? const Color(0xFFFDE2E2) : Fs.primaryLight,
                    labelStyle: TextStyle(
                      fontSize: 13,
                      color: myRsvp == v ? (v == 'declined' ? Fs.red : Fs.primary) : Fs.text2,
                      fontWeight: myRsvp == v ? FontWeight.w600 : FontWeight.normal,
                    ),
                    onSelected: myRsvp == v
                        ? null
                        : (_) async {
                            try {
                              await s.api.rsvpEvent(e.eventId, v);
                              if (context.mounted) {
                                showToast(context, '已回复：$label');
                                Navigator.pop(context, 'rsvp');
                              }
                            } catch (err) {
                              if (context.mounted) showToast(context, describeError(err), error: true);
                            }
                          },
                  ),
                ],
              ]),
            ],
          ]),
        ),
      ),
    );
  }

  static int _count(CosCalendarEvent e, String v) =>
      e.attendeeIds.where((id) => id == e.createdBy ? v == 'accepted' : e.attendees.any((a) => a.userId == id && a.rsvp == v)).length;

  static String _rsvpLabel(String r) => switch (r) {
        'accepted' => '已接受',
        'declined' => '已拒绝',
        'tentative' => '待定',
        _ => '未回复',
      };

  static Widget _rsvpBadge(String r) {
    final (IconData? icon, Color color) = switch (r) {
      'accepted' => (Icons.check_rounded, const Color(0xFF2EA121)),
      'declined' => (Icons.close_rounded, Fs.red),
      'tentative' => (Icons.question_mark_rounded, const Color(0xFFFF8800)),
      _ => (null, Fs.textDisabled),
    };
    if (icon == null) return const SizedBox.shrink();
    return Container(
      width: 12,
      height: 12,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 1.5)),
      child: Icon(icon, size: 7, color: Colors.white),
    );
  }

  Widget _row(IconData icon, String text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, size: 18, color: Fs.text3),
          const SizedBox(width: 12),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 14, height: 1.4))),
        ]),
      );
}

// ---------------- 新建日程 ----------------

class EventEditor extends StatefulWidget {
  final DateTime? initialStart;
  final List<String> initialAttendees;

  /// 传入时为编辑模式。
  final CosCalendarEvent? event;
  const EventEditor({super.key, this.initialStart, this.initialAttendees = const [], this.event});
  @override
  State<EventEditor> createState() => _EventEditorState();
}

class _EventEditorState extends State<EventEditor> {
  final title = TextEditingController();
  final desc = TextEditingController();
  final location = TextEditingController();
  bool get editing => widget.event != null;
  late DateTime date;
  late DateTime endDate;
  bool allDay = false;
  late int startMin;
  late int endMin;
  List<String> attendees = [];
  String? recurrence;
  bool saving = false;
  String? error;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    final st = widget.initialStart ??
        DateTime(now.year, now.month, now.day, now.hour).add(Duration(minutes: now.minute < 30 ? 30 : 60));
    date = dayStart(st);
    endDate = date;
    startMin = st.hour * 60 + st.minute;
    endMin = (startMin + 60).clamp(30, 24 * 60 - 1);
    attendees = [...widget.initialAttendees];
    final e = widget.event;
    if (e != null) {
      final st = e.start.toLocal(), en = e.end.toLocal();
      recurrence = e.recurrence;
      title.text = e.title;
      desc.text = e.description ?? '';
      location.text = e.location ?? '';
      date = dayStart(st);
      startMin = st.hour * 60 + st.minute;
      endDate = dayStart(en);
      allDay = e.allDay;
      endMin = en.hour * 60 + en.minute;
      attendees = e.attendeeIds.where((id) => id != e.createdBy).toList();
    }
  }

  String _dur(int m) {
    if (m <= 0) return '';
    if (m < 60) return '$m 分钟';
    final h = m / 60;
    return '${h == h.roundToDouble() ? h.toInt() : h.toStringAsFixed(1)} 小时';
  }

  String _label(int m) => m >= 24 * 60 - 1 ? '23:59' : '${two(m ~/ 60)}:${two(m % 60)}';

  Future<void> _save() async {
    if (title.text.trim().isEmpty) {
      setState(() => error = '请填写日程主题');
      return;
    }
    if (!endDate.add(Duration(minutes: endMin)).isAfter(date.add(Duration(minutes: startMin)))) {
      setState(() => error = '结束时间要晚于开始时间');
      return;
    }
    final s = AppScope.read(context);
    final recurringEnabled = s.feature('calendar.recurrence');
    final scope = editing && widget.event!.isRecurring ? await pickRecurrenceScope(context) : null;
    if (!mounted || (editing && widget.event!.isRecurring && scope == null)) return;
    setState(() {
      saving = true;
      error = null;
    });
    try {
      if (editing) {
        // 只改这一次时不能改重复规则；规则没变时不发送，避免后端重算整个系列
        final ruleChanged = recurringEnabled && scope != 'this' && recurrence != widget.event!.recurrence;
        await s.api.updateEvent(
          widget.event!.eventId,
          scope: scope,
          recurrence: ruleChanged ? recurrence : null,
          clearRecurrence: ruleChanged && recurrence == null,
          title: title.text.trim(),
          start: date.add(Duration(minutes: startMin)),
          end: endDate.add(Duration(minutes: endMin)),
          allDay: allDay,
          attendeeIds: attendees,
          description: desc.text.trim(),
          location: location.text.trim(),
        );
      } else {
        await s.api.createEvent(
          recurrence: recurringEnabled ? recurrence : null,
          title: title.text.trim(),
          start: date.add(Duration(minutes: startMin)),
          end: endDate.add(Duration(minutes: endMin)),
          allDay: allDay,
          attendeeIds: attendees,
          description: desc.text.trim(),
          location: location.text.trim().isEmpty ? null : location.text.trim(),
        );
      }
      if (mounted) {
        showToast(context, editing ? '日程已更新' : '日程已创建');
        Navigator.pop(context, true);
      }
    } catch (e) {
      // 重复日程的主日程被别人改过：关掉编辑框并刷新，让用户在最新数据上重改
      if (e is CosApiException && e.code == 'EVENT_CONFLICT') {
        if (mounted) {
          showToast(context, '这个日程刚被别人改过，已刷新，请重新打开后再修改', error: true);
          Navigator.pop(context, true);
        }
        return;
      }
      if (mounted) {
        setState(() {
          saving = false;
          error = describeError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final slots = {for (var m = 0; m < 24 * 60; m += 30) m, 24 * 60 - 1, startMin, endMin}.toList()..sort();
    Widget timeSel(int value, ValueChanged<int> f, {int min = -1}) => SizedBox(
          width: 128,
          child: DropdownButtonFormField<int>(
            key: ValueKey('$value-$min'),
            initialValue: slots.contains(value) ? value : null,
            isDense: true,
            isExpanded: true,
            menuMaxHeight: 320,
            items: [
              for (final m in slots)
                if (m > min) DropdownMenuItem(value: m, child: Text(_label(m), style: const TextStyle(fontSize: 14))),
            ],
            onChanged: (v) => v == null ? null : f(v),
          ),
        );
    return Dialog(
      child: SizedBox(
        width: 520,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Text(editing ? '编辑日程' : '创建日程', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              const Spacer(),
              FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: () => Navigator.pop(context)),
            ]),
            if (s.feature('calendar.recurrence')) ...[
              const SizedBox(height: 12),
              RecurrencePicker(date: date, value: recurrence, onChanged: (v) => setState(() => recurrence = v)),
              if (editing && widget.event!.isRecurring)
                const Padding(
                  padding: EdgeInsets.only(top: 4),
                  child: Text('保存时选「仅此日程」不会修改重复规则。', style: TextStyle(fontSize: 12, color: Fs.text3)),
                ),
            ],
            const SizedBox(height: 16),
            TextField(
              controller: title,
              autofocus: true,
              style: const TextStyle(fontSize: 16),
              decoration: const InputDecoration(hintText: '添加主题'),
            ),
            const SizedBox(height: 16),
            Row(children: [
              const Icon(Icons.schedule_rounded, size: 18, color: Fs.text3),
              const SizedBox(width: 10),
              Expanded(
                child: DateField(
                  value: date,
                  withTime: false,
                  onChanged: (d) => setState(() {
                    if (d != null) { endDate = endDate.add(d.difference(date)); date = d; }
                  }),
                ),
              ),
            ]),
            const SizedBox(height: 10),
            Row(children: [
              const SizedBox(width: 28),
              timeSel(startMin, (v) => setState(() {
                    final dur = endMin - startMin;
                    startMin = v;
                    endMin = (v + (dur > 0 ? dur : 60)).clamp(0, 24 * 60 - 1);
                  })),
              const Padding(padding: EdgeInsets.symmetric(horizontal: 10), child: Text('至', style: TextStyle(color: Fs.text2))),
              timeSel(endMin, (v) => setState(() => endMin = v), min: sameDay(date, endDate) ? startMin : -1),
              const SizedBox(width: 10),
              Text(_dur(endMin - startMin), style: const TextStyle(fontSize: 12, color: Fs.text3)),
            ]),
            const SizedBox(height: 10),
            Row(children: [
              const Text('结束日期  '),
              Expanded(child: DateField(value: endDate, withTime: false,
                onChanged: (v) { if (v != null) setState(() => endDate = dayStart(v)); })),
              const Text('全天'),
              Switch(value: allDay, onChanged: (v) => setState(() {
                allDay = v;
                if (v) { startMin = 0; endMin = 0; if (!endDate.isAfter(date)) endDate = date.add(const Duration(days: 1)); }
              })),
            ]),
            const SizedBox(height: 12),
            Row(children: [
              const Icon(Icons.place_outlined, size: 18, color: Fs.text3),
              const SizedBox(width: 10),
              Expanded(
                child: TextField(controller: location, decoration: const InputDecoration(hintText: '添加地点（选填）')),
              ),
            ]),
            const SizedBox(height: 12),
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Padding(padding: EdgeInsets.only(top: 8), child: Icon(Icons.groups_outlined, size: 18, color: Fs.text3)),
              const SizedBox(width: 10),
              Expanded(
                child: Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                  Chip(
                    avatar: FsAvatar(name: s.me.name, seed: s.me.userId, size: 20),
                    label: Text('${s.me.name}（组织者）'),
                    visualDensity: VisualDensity.compact,
                  ),
                  for (final id in attendees)
                    Chip(
                      avatar: FsAvatar(name: s.userName(id), seed: id, size: 20),
                      label: Text(s.userName(id)),
                      visualDensity: VisualDensity.compact,
                      onDeleted: () => setState(() => attendees.remove(id)),
                    ),
                  TextButton.icon(
                    onPressed: () async {
                      final ids = await pickUsers(context,
                          users: s.users, title: '添加参与者', initial: attendees, exclude: {s.me.userId});
                      if (ids != null) setState(() => attendees = ids);
                    },
                    icon: const Icon(Icons.person_add_alt_outlined, size: 16),
                    label: const Text('添加参与者'),
                  ),
                ]),
              ),
            ]),
            const SizedBox(height: 12),
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Padding(padding: EdgeInsets.only(top: 10), child: Icon(Icons.notes_rounded, size: 18, color: Fs.text3)),
              const SizedBox(width: 10),
              Expanded(
                child: TextField(
                  controller: desc,
                  minLines: 2,
                  maxLines: 4,
                  decoration: const InputDecoration(hintText: '添加描述（选填）'),
                ),
              ),
            ]),
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(error!, style: const TextStyle(color: Fs.red, fontSize: 13)),
              ),
            const SizedBox(height: 20),
            Row(mainAxisAlignment: MainAxisAlignment.end, children: [
              OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
              const SizedBox(width: 10),
              FilledButton(
                onPressed: saving ? null : _save,
                child: Text(saving ? '保存中…' : (editing ? '保存' : '创建')),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}
