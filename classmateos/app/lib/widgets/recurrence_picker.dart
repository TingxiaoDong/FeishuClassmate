import 'package:flutter/material.dart';

import '../services/rrule.dart';
import '../theme.dart';

/// 常用规则（不含结束条件）。未识别的服务端规则作为独立选项保留，不进行有损解析。
Map<String, String> recurrencePresets(DateTime date) {
  final day = kWeekdayCodes[date.weekday - 1];
  final nth = (date.day - 1) ~/ 7 + 1;
  final isLast = DateTime(date.year, date.month, date.day + 7).month != date.month;
  return {
    '': '不重复',
    'FREQ=DAILY': '每天',
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR': '每个工作日',
    'FREQ=WEEKLY;BYDAY=$day': '每周（周${kWeekdayNames[date.weekday - 1]}）',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=$day': '每两周（周${kWeekdayNames[date.weekday - 1]}）',
    'FREQ=MONTHLY;BYMONTHDAY=${date.day}': '每月 ${date.day} 日',
    if (nth <= 4) 'FREQ=MONTHLY;BYDAY=$nth$day': '每月第 $nth 个周${kWeekdayNames[date.weekday - 1]}',
    if (isLast) 'FREQ=MONTHLY;BYDAY=-1$day': '每月最后一个周${kWeekdayNames[date.weekday - 1]}',
    'FREQ=YEARLY;BYMONTH=${date.month};BYMONTHDAY=${date.day}': '每年 ${date.month} 月 ${date.day} 日',
  };
}

const _kCustom = '__custom__';
const _kKeep = '__keep__';

/// 日程编辑器里的「重复」：常用规则 / 自定义 + 结束条件。
class RecurrencePicker extends StatefulWidget {
  final DateTime date;
  final String? value;
  final ValueChanged<String?> onChanged;
  const RecurrencePicker({super.key, required this.date, required this.value, required this.onChanged});

  @override
  State<RecurrencePicker> createState() => _RecurrencePickerState();
}

class _RecurrencePickerState extends State<RecurrencePicker> {
  final countCtl = TextEditingController();

  @override
  void initState() {
    super.initState();
    final r = RRule.tryParse(widget.value);
    if (r?.count != null) countCtl.text = '${r!.count}';
  }

  @override
  void dispose() {
    countCtl.dispose();
    super.dispose();
  }

  void _emit(RRule? r) => widget.onChanged(r?.toString());

  Future<void> _custom(RRule? current) async {
    final r = await showDialog<RRule>(
      context: context,
      builder: (_) => CustomRecurrenceDialog(date: widget.date, initial: current),
    );
    if (r != null) {
      if (r.count != null) countCtl.text = '${r.count}';
      _emit(r);
    } else {
      setState(() {}); // 取消时让下拉框回到原值
    }
  }

  @override
  Widget build(BuildContext context) {
    final presets = recurrencePresets(widget.date);
    final rule = RRule.tryParse(widget.value);
    final unknown = widget.value != null && rule == null;
    final baseKey = rule?.withoutEnd.toString();
    final String selected;
    final items = <String, String>{...presets};
    if (widget.value == null) {
      selected = '';
    } else if (unknown) {
      selected = _kKeep;
      items[_kKeep] = '保留现有规则：${widget.value}';
    } else if (presets.containsKey(baseKey)) {
      selected = baseKey!;
    } else {
      selected = _kCustom;
    }
    items[_kCustom] = selected == _kCustom ? '自定义：${rule!.withoutEnd.describe()}' : '自定义…';

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      DropdownButtonFormField<String>(
        key: ValueKey('${widget.date.toIso8601String()}-${widget.value}-${items.length}'),
        initialValue: selected,
        isExpanded: true,
        decoration: const InputDecoration(labelText: '重复', prefixIcon: Icon(Icons.repeat)),
        items: [
          for (final e in items.entries)
            DropdownMenuItem(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis)),
        ],
        onChanged: (v) {
          if (v == null) return;
          if (v == _kCustom) {
            _custom(rule);
            return;
          }
          if (v == _kKeep) return;
          if (v == '') {
            _emit(null);
            return;
          }
          // 换常用规则时保留原来的结束条件
          final next = RRule.tryParse(v)!;
          _emit(rule == null ? next : RRule(
            freq: next.freq, interval: next.interval, byDay: next.byDay, byMonthDay: next.byMonthDay,
            byMonth: next.byMonth, count: rule.count, until: rule.until,
          ));
        },
      ),
      if (rule != null) ...[
        const SizedBox(height: 10),
        _EndRow(
          rule: rule,
          date: widget.date,
          countCtl: countCtl,
          onChanged: _emit,
        ),
      ],
      if (unknown)
        const Padding(
          padding: EdgeInsets.only(top: 6),
          child: Text('这条规则前端无法编辑，保存时会原样保留。', style: TextStyle(fontSize: 12, color: Fs.text3)),
        ),
    ]);
  }
}

class _EndRow extends StatelessWidget {
  final RRule rule;
  final DateTime date;
  final TextEditingController countCtl;
  final ValueChanged<RRule> onChanged;
  const _EndRow({required this.rule, required this.date, required this.countCtl, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final mode = rule.count != null ? 'count' : (rule.until != null ? 'until' : 'never');
    return Row(children: [
      const SizedBox(width: 12),
      const Text('结束', style: TextStyle(fontSize: 13, color: Fs.text2)),
      const SizedBox(width: 12),
      SizedBox(
        width: 120,
        child: DropdownButtonFormField<String>(
          key: ValueKey('end-$mode'),
          initialValue: mode,
          isDense: true,
          items: const [
            DropdownMenuItem(value: 'never', child: Text('永不')),
            DropdownMenuItem(value: 'until', child: Text('到某天')),
            DropdownMenuItem(value: 'count', child: Text('重复 N 次')),
          ],
          onChanged: (v) {
            switch (v) {
              case 'never':
                onChanged(rule.copyWith(clearEnd: true));
              case 'until':
                onChanged(rule.copyWith(clearEnd: true, until: RRule.untilOfDay(DateTime(date.year, date.month + 1, date.day))));
              case 'count':
                final n = int.tryParse(countCtl.text) ?? 10;
                countCtl.text = '$n';
                onChanged(rule.copyWith(clearEnd: true, count: n));
            }
          },
        ),
      ),
      const SizedBox(width: 12),
      if (mode == 'until')
        TextButton.icon(
          icon: const Icon(Icons.event_rounded, size: 16),
          label: Text('${rule.until!.year}-${rule.until!.month.toString().padLeft(2, '0')}-${rule.until!.day.toString().padLeft(2, '0')}（含）'),
          onPressed: () async {
            final d = await showDatePicker(
              context: context,
              initialDate: rule.until!.isBefore(date) ? date : rule.until!,
              firstDate: date,
              lastDate: DateTime(date.year + 10),
            );
            if (d != null) onChanged(rule.copyWith(clearEnd: true, until: RRule.untilOfDay(d)));
          },
        ),
      if (mode == 'count') ...[
        SizedBox(
          width: 72,
          child: TextField(
            key: const ValueKey('rrule-count'),
            controller: countCtl,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(isDense: true, suffixText: '次'),
            onChanged: (t) {
              final n = int.tryParse(t);
              if (n != null && n >= 1 && n <= 999) onChanged(rule.copyWith(clearEnd: true, count: n));
            },
          ),
        ),
      ],
    ]);
  }
}

/// 自定义重复规则：频率、间隔、星期、按日期 / 按第几个星期几、结束条件，带「接下来 5 次」预览。
class CustomRecurrenceDialog extends StatefulWidget {
  final DateTime date;
  final RRule? initial;
  const CustomRecurrenceDialog({super.key, required this.date, this.initial});

  @override
  State<CustomRecurrenceDialog> createState() => _CustomRecurrenceDialogState();
}

class _CustomRecurrenceDialogState extends State<CustomRecurrenceDialog> {
  late RFreq freq;
  late int interval;
  late Set<int> weekdays;
  late String monthMode; // day | nth | last
  String endMode = 'never';
  late DateTime untilDay;
  final intervalCtl = TextEditingController();
  final countCtl = TextEditingController(text: '10');

  int get _nth => (widget.date.day - 1) ~/ 7 + 1;
  bool get _isLast => DateTime(widget.date.year, widget.date.month, widget.date.day + 7).month != widget.date.month;

  @override
  void initState() {
    super.initState();
    final r = widget.initial;
    freq = r?.freq ?? RFreq.weekly;
    interval = r?.interval ?? 1;
    intervalCtl.text = '$interval';
    weekdays = {
      ...?r?.byDay.where((d) => d.ordinal == 0).map((d) => d.weekday),
    };
    if (weekdays.isEmpty) weekdays = {widget.date.weekday};
    monthMode = r != null && r.byDay.isNotEmpty ? (r.byDay.first.ordinal == -1 ? 'last' : 'nth') : 'day';
    untilDay = r?.until ?? DateTime(widget.date.year, widget.date.month + 3, widget.date.day);
    if (r?.count != null) {
      endMode = 'count';
      countCtl.text = '${r!.count}';
    } else if (r?.until != null) {
      endMode = 'until';
    }
  }

  @override
  void dispose() {
    intervalCtl.dispose();
    countCtl.dispose();
    super.dispose();
  }

  RRule? get _rule {
    final n = int.tryParse(intervalCtl.text);
    if (n == null || n < 1 || n > 99) return null;
    final count = endMode == 'count' ? int.tryParse(countCtl.text) : null;
    if (endMode == 'count' && (count == null || count < 1 || count > 999)) return null;
    final d = widget.date;
    final wd = d.weekday;
    return RRule(
      freq: freq,
      interval: n,
      byDay: switch (freq) {
        RFreq.weekly => [for (final w in (weekdays.toList()..sort())) RDay(w)],
        RFreq.monthly when monthMode == 'nth' => [RDay(wd, _nth)],
        RFreq.monthly when monthMode == 'last' => [RDay(wd, -1)],
        _ => const [],
      },
      byMonthDay: switch (freq) {
        RFreq.monthly when monthMode == 'day' => [d.day],
        RFreq.yearly => [d.day],
        _ => const [],
      },
      byMonth: freq == RFreq.yearly ? [d.month] : const [],
      count: count,
      until: endMode == 'until' ? RRule.untilOfDay(untilDay) : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final rule = _rule;
    final wd = kWeekdayNames[widget.date.weekday - 1];
    final preview = rule == null
        ? const <DateTime>[]
        : rule.expand(widget.date, widget.date, DateTime(widget.date.year + 30), limit: 5);
    String unit(RFreq f) => switch (f) { RFreq.daily => '天', RFreq.weekly => '周', RFreq.monthly => '个月', RFreq.yearly => '年' };
    return AlertDialog(
      title: const Text('自定义重复'),
      content: SizedBox(
        width: 420,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Text('每'),
            const SizedBox(width: 8),
            SizedBox(
              width: 56,
              child: TextField(
                key: const ValueKey('rrule-interval'),
                controller: intervalCtl,
                keyboardType: TextInputType.number,
                textAlign: TextAlign.center,
                decoration: const InputDecoration(isDense: true),
                onChanged: (_) => setState(() {}),
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(
              width: 100,
              child: DropdownButtonFormField<RFreq>(
                initialValue: freq,
                isDense: true,
                items: [for (final f in RFreq.values) DropdownMenuItem(value: f, child: Text(unit(f)))],
                onChanged: (v) => setState(() => freq = v ?? freq),
              ),
            ),
          ]),
          const SizedBox(height: 14),
          if (freq == RFreq.weekly)
            Wrap(spacing: 6, children: [
              for (var w = 1; w <= 7; w++)
                FilterChip(
                  label: Text(kWeekdayNames[w - 1]),
                  selected: weekdays.contains(w),
                  showCheckmark: false,
                  onSelected: (on) => setState(() {
                    if (on) {
                      weekdays.add(w);
                    } else if (weekdays.length > 1) {
                      weekdays.remove(w);
                    }
                  }),
                ),
            ]),
          if (freq == RFreq.monthly)
            DropdownButtonFormField<String>(
              initialValue: monthMode,
              isExpanded: true,
              items: [
                DropdownMenuItem(value: 'day', child: Text('按日期：每月 ${widget.date.day} 日')),
                if (_nth <= 4) DropdownMenuItem(value: 'nth', child: Text('按星期：第 $_nth 个周$wd')),
                if (_isLast) DropdownMenuItem(value: 'last', child: Text('按星期：最后一个周$wd')),
              ],
              onChanged: (v) => setState(() => monthMode = v ?? 'day'),
            ),
          if (freq == RFreq.monthly && monthMode == 'day' && widget.date.day > 28)
            const Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text('没有这一天的月份会跳过。', style: TextStyle(fontSize: 12, color: Fs.text3)),
            ),
          if (freq == RFreq.yearly) Text('每年 ${widget.date.month} 月 ${widget.date.day} 日'),
          const SizedBox(height: 16),
          const Text('结束', style: TextStyle(fontWeight: FontWeight.w600)),
          RadioGroup<String>(
            groupValue: endMode,
            onChanged: (v) => setState(() => endMode = v ?? endMode),
            child: Column(children: [
              const RadioListTile<String>(value: 'never', dense: true, contentPadding: EdgeInsets.zero, title: Text('永不')),
              RadioListTile<String>(
                value: 'until',
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Row(children: [
                  const Text('到某天'),
                  const SizedBox(width: 8),
                  TextButton(
                    onPressed: () async {
                      final d = await showDatePicker(
                        context: context,
                        initialDate: untilDay.isBefore(widget.date) ? widget.date : untilDay,
                        firstDate: widget.date,
                        lastDate: DateTime(widget.date.year + 10),
                      );
                      if (d != null) {
                        setState(() {
                          untilDay = d;
                          endMode = 'until';
                        });
                      }
                    },
                    child: Text('${untilDay.year}-${untilDay.month.toString().padLeft(2, '0')}-${untilDay.day.toString().padLeft(2, '0')}（含）'),
                  ),
                ]),
              ),
              RadioListTile<String>(
                value: 'count',
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Row(children: [
                  const Text('重复'),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 60,
                    child: TextField(
                      key: const ValueKey('rrule-dialog-count'),
                      controller: countCtl,
                      keyboardType: TextInputType.number,
                      textAlign: TextAlign.center,
                      decoration: const InputDecoration(isDense: true),
                      onTap: () => setState(() => endMode = 'count'),
                      onChanged: (_) => setState(() {}),
                    ),
                  ),
                  const SizedBox(width: 8),
                  const Text('次'),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: 8),
          if (rule == null)
            const Text('间隔请填 1–99，次数请填 1–999', style: TextStyle(fontSize: 12, color: Fs.red))
          else ...[
            Text(rule.describe(), style: const TextStyle(fontSize: 13, color: Fs.text2)),
            const SizedBox(height: 4),
            Text(
              '接下来：${preview.map((t) => '${t.month}/${t.day} 周${kWeekdayNames[t.weekday - 1]}').join('、')}${preview.length == 5 ? ' …' : ''}',
              style: const TextStyle(fontSize: 12, color: Fs.text3),
            ),
          ],
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: rule == null ? null : () => Navigator.pop(context, rule), child: const Text('确定')),
      ],
    );
  }
}

Future<String?> pickRecurrenceScope(BuildContext context, {bool allowFollowing = true}) => showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('影响哪些重复日程？'),
        children: [
          for (final item in [
            ('this', '仅此日程'),
            if (allowFollowing) ('following', '此日程及之后'),
            ('all', '所有日程'),
          ])
            SimpleDialogOption(
              key: ValueKey('scope-${item.$1}'),
              onPressed: () => Navigator.pop(context, item.$1),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(item.$2)),
            ),
          SimpleDialogOption(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        ],
      ),
    );
