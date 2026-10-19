import 'package:flutter/material.dart';

/// 未识别的服务端规则作为独立选项保留，不进行有损解析。
Map<String, String> recurrencePresets(DateTime date) {
  const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  final day = days[date.weekday - 1];
  return {
    '': '不重复',
    'FREQ=DAILY': '每天',
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR': '每个工作日',
    'FREQ=WEEKLY;BYDAY=$day': '每周',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=$day': '每两周',
    'FREQ=MONTHLY;BYMONTHDAY=${date.day}': '每月 ${date.day} 日',
    'FREQ=MONTHLY;BYDAY=${(date.day - 1) ~/ 7 + 1}$day':
        '每月第 ${(date.day - 1) ~/ 7 + 1} 个同星期日',
    'FREQ=YEARLY;BYMONTH=${date.month};BYMONTHDAY=${date.day}':
        '每年 ${date.month} 月 ${date.day} 日',
  };
}

class RecurrencePicker extends StatelessWidget {
  final DateTime date;
  final String? value;
  final ValueChanged<String?> onChanged;
  const RecurrencePicker({
    super.key,
    required this.date,
    required this.value,
    required this.onChanged,
  });
  @override
  Widget build(BuildContext context) {
    final options = recurrencePresets(date);
    if (value != null && !options.containsKey(value)) {
      options[value!] = '保留现有自定义规则：$value';
    }
    return DropdownButtonFormField<String>(
      key: ValueKey('${date.toIso8601String()}-$value'),
      initialValue: value ?? '',
      isExpanded: true,
      decoration: const InputDecoration(
        labelText: '重复',
        prefixIcon: Icon(Icons.repeat),
      ),
      items: options.entries
          .map(
            (e) => DropdownMenuItem(
              value: e.key,
              child: Text(e.value, overflow: TextOverflow.ellipsis),
            ),
          )
          .toList(),
      onChanged: (v) => onChanged(v == '' ? null : v),
    );
  }
}

Future<String?> pickRecurrenceScope(BuildContext context) => showDialog<String>(
  context: context,
  builder: (context) => SimpleDialog(
    title: const Text('影响哪些重复日程？'),
    children: [
      for (final item in const [
        ('this', '仅此日程'),
        ('following', '此日程及之后'),
        ('all', '所有日程'),
      ])
        SimpleDialogOption(
          onPressed: () => Navigator.pop(context, item.$1),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(item.$2),
          ),
        ),
      SimpleDialogOption(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
    ],
  ),
);
