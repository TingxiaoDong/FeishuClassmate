/// 测试数据模式：日历（含重复日程）的内存模拟。
/// 按《二期迭代3_前端接口需求与进度》第 3 节：服务端展开实例、scope=this|following|all。
/// 只用于自测界面；正式数据一律由后端展开，前端不自行展开。
library;

import '../services/rrule.dart';
import 'mock_docs.dart' show MockFail;

class MockCalendar {
  final String Function() me;
  final void Function(Map<String, dynamic>) emit;
  MockCalendar({required this.me, required this.emit}) {
    _seed();
  }

  int _seq = 800;
  String _id() => 'evt_${_seq++}';
  String _now() => DateTime.now().toUtc().toIso8601String();

  /// 系列 / 普通日程的主记录。
  final Map<String, Map<String, dynamic>> events = {};

  /// 例外：series_id → { original_start_ms → 覆盖字段（`cancelled: true` 表示删除这一次）}。
  final Map<String, Map<int, Map<String, dynamic>>> exceptions = {};

  void _seed() {
    final n = DateTime.now();
    final monday = DateTime(n.year, n.month, n.day - (n.weekday - 1));
    int at(DateTime d, int h, [int m = 0]) => DateTime(d.year, d.month, d.day, h, m).millisecondsSinceEpoch;
    void ev(String id, String title, int start, int minutes, {String by = 'ou_admin', String? rule, List<String> att = const [], String? loc}) {
      events[id] = {
        'event_id': id, 'title': title, 'start_ms': start, 'end_ms': start + minutes * 60000,
        'created_by': by, 'attendee_ids': [by, ...att],
        'attendees': [for (final u in [by, ...att]) {'user_id': u, 'rsvp': u == by ? 'accepted' : 'pending'}],
        'location': loc, 'recurrence': rule, 'all_day': false,
        'created_at': _now(), 'updated_at': _now(),
      };
    }

    // 组会：从三周前的周一开始，每周一 10:00
    ev('evt_group', '组会', at(monday.subtract(const Duration(days: 21)), 10), 90,
        rule: 'FREQ=WEEKLY;BYDAY=MO', att: ['ou_demo', 'ou_zhang', 'ou_chen'], loc: '会议室 A');
    ev('evt_standup', '早间站会', at(monday, 9, 30), 15, by: 'ou_demo', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=20', att: ['ou_admin']);
    ev('evt_review', '论文进度汇报', at(DateTime(n.year, n.month, 1), 15), 60, rule: 'FREQ=MONTHLY;BYDAY=-1FR', att: ['ou_demo']);
    ev('evt_1', '项目周会', at(monday.add(const Duration(days: 2)), 14), 60, by: 'ou_chen', att: ['ou_admin'], loc: '会议室 A');
  }

  bool _canEdit(Map<String, dynamic> e) => e['created_by'] == me();

  (String, int?) _split(String id) {
    if (events.containsKey(id)) return (id, null);
    final i = id.lastIndexOf('_');
    if (i > 0) {
      final series = id.substring(0, i);
      final ms = int.tryParse(id.substring(i + 1));
      if (ms != null && events.containsKey(series)) return (series, ms);
    }
    throw MockFail(404, 'NOT_FOUND', '日程不存在');
  }

  Map<String, dynamic> _instance(Map<String, dynamic> master, int origStart) {
    final dur = (master['end_ms'] as int) - (master['start_ms'] as int);
    final ex = exceptions[master['event_id']]?[origStart];
    final e = <String, dynamic>{
      ...master,
      'event_id': '${master['event_id']}_$origStart',
      'recurring_event_id': master['event_id'],
      'original_start_ms': origStart,
      'start_ms': origStart,
      'end_ms': origStart + dur,
      'is_exception': ex != null,
      ...?ex,
    };
    e.remove('cancelled');
    return e;
  }

  List<Map<String, dynamic>> _list(int from, int to) {
    final out = <Map<String, dynamic>>[];
    for (final e in events.values) {
      final rule = RRule.tryParse(e['recurrence'] as String?);
      if (rule == null) {
        if ((e['end_ms'] as int) > from && (e['start_ms'] as int) < to) out.add(e);
        continue;
      }
      final dur = (e['end_ms'] as int) - (e['start_ms'] as int);
      final starts = rule.expand(
        DateTime.fromMillisecondsSinceEpoch(e['start_ms'] as int),
        DateTime.fromMillisecondsSinceEpoch(from - dur),
        DateTime.fromMillisecondsSinceEpoch(to),
      );
      final ex = exceptions[e['event_id']] ?? const {};
      for (final s in starts) {
        final ms = s.millisecondsSinceEpoch;
        if (ex[ms]?['cancelled'] == true) continue;
        final inst = _instance(e, ms);
        if ((inst['end_ms'] as int) > from && (inst['start_ms'] as int) < to) out.add(inst);
      }
      // 例外被挪到别的时间、跨进窗口的情况
      for (final entry in ex.entries) {
        if (entry.value['cancelled'] == true || starts.any((s) => s.millisecondsSinceEpoch == entry.key)) continue;
        final inst = _instance(e, entry.key);
        if ((inst['end_ms'] as int) > from && (inst['start_ms'] as int) < to) out.add(inst);
      }
    }
    out.sort((a, b) => (a['start_ms'] as int).compareTo(b['start_ms'] as int));
    return out;
  }

  static const _fields = ['title', 'start_ms', 'end_ms', 'attendee_ids', 'description', 'location', 'all_day', 'color', 'reminders'];

  void _applyFields(Map<String, dynamic> target, Map<String, dynamic> body) {
    for (final k in _fields) {
      if (body.containsKey(k)) target[k] = body[k];
    }
    if (body.containsKey('attendee_ids')) {
      final ids = <String>{target['created_by'] as String, ...(body['attendee_ids'] as List).map((e) => e.toString())};
      final old = {for (final a in (target['attendees'] as List? ?? const [])) (a as Map)['user_id']: a['rsvp']};
      target['attendee_ids'] = ids.toList();
      target['attendees'] = [for (final u in ids) {'user_id': u, 'rsvp': old[u] ?? (u == target['created_by'] ? 'accepted' : 'pending')}];
    }
    target['updated_at'] = _now();
  }

  /// 系列截到 [origStart] 之前（UNTIL 取前一秒，COUNT 换成 UNTIL）。
  void _truncate(Map<String, dynamic> master, int origStart) {
    final r = RRule.tryParse(master['recurrence'] as String?);
    if (r == null) return;
    final until = DateTime.fromMillisecondsSinceEpoch(origStart - 1000);
    if (until.millisecondsSinceEpoch < (master['start_ms'] as int)) {
      events.remove(master['event_id']);
      exceptions.remove(master['event_id']);
      return;
    }
    master['recurrence'] = r.copyWith(clearEnd: true, until: until).toString();
    exceptions[master['event_id']]?.removeWhere((k, _) => k >= origStart);
  }

  void _changed(String id) => emit({'event_type': 'calendar.event_changed', 'event_id': id});

  (int, Object?)? handle(String m, List<String> seg, Map<String, String> q, Map<String, dynamic> body) {
    if (seg.length < 2 || seg[0] != 'calendar' || seg[1] != 'events') return null;
    if (seg.length == 2 && m == 'GET') {
      final from = int.tryParse(q['start_ms'] ?? q['from'] ?? '') ?? 0;
      final to = int.tryParse(q['end_ms'] ?? q['to'] ?? '') ?? DateTime(2100).millisecondsSinceEpoch;
      return (200, {'items': _list(from, to), 'has_more': false});
    }
    if (seg.length == 2 && m == 'POST') {
      final title = body['title']?.toString().trim() ?? '';
      if (title.isEmpty) throw MockFail(422, 'VALIDATION_ERROR', '请填写日程主题');
      final rule = body['recurrence'] as String?;
      if (rule != null && RRule.tryParse(rule) == null) throw MockFail(422, 'VALIDATION_ERROR', '重复规则格式不正确');
      final id = _id();
      final e = <String, dynamic>{'event_id': id, 'created_by': me(), 'created_at': _now(), 'recurrence': rule, 'attendee_ids': <String>[]};
      _applyFields(e, {'attendee_ids': const [], ...body});
      events[id] = e;
      _changed(id);
      return (201, e);
    }
    final (series, orig) = _split(seg[2]);
    final master = events[series]!;
    if (seg.length == 4 && seg[3] == 'rsvp' && m == 'POST') {
      for (final a in master['attendees'] as List) {
        if ((a as Map)['user_id'] == me()) a['rsvp'] = body['rsvp'];
      }
      _changed(series);
      return (200, orig == null ? master : _instance(master, orig));
    }
    if (seg.length != 3) return null;
    if (m == 'GET') return (200, orig == null ? master : _instance(master, orig));
    if (!_canEdit(master)) throw MockFail(403, 'FORBIDDEN', '只有组织者可以修改这个日程');
    final scope = q['scope'] ?? 'all';
    if (!const ['this', 'following', 'all'].contains(scope)) throw MockFail(422, 'VALIDATION_ERROR', 'scope 只能是 this / following / all');
    if (body.containsKey('recurrence') && body['recurrence'] != null && RRule.tryParse(body['recurrence'] as String?) == null) {
      throw MockFail(422, 'VALIDATION_ERROR', '重复规则格式不正确');
    }

    if (m == 'DELETE') {
      if (orig == null || scope == 'all') {
        events.remove(series);
        exceptions.remove(series);
      } else if (scope == 'this') {
        (exceptions[series] ??= {})[orig] = {'cancelled': true};
      } else {
        _truncate(master, orig);
      }
      _changed(series);
      return (204, null);
    }

    if (m == 'PATCH') {
      if (orig == null || master['recurrence'] == null) {
        if (body.containsKey('recurrence')) master['recurrence'] = body['recurrence'];
        _applyFields(master, body);
        _changed(series);
        return (200, master);
      }
      switch (scope) {
        case 'this':
          if (body.containsKey('recurrence')) throw MockFail(422, 'VALIDATION_ERROR', '只改这一次时不能修改重复规则');
          final ex = (exceptions[series] ??= {})[orig] ??= {};
          final tmp = _instance(master, orig);
          _applyFields(tmp, body);
          for (final k in [..._fields, 'attendees']) {
            if (body.containsKey(k) || (k == 'attendees' && body.containsKey('attendee_ids'))) ex[k] = tmp[k];
          }
          _changed(series);
          return (200, _instance(master, orig));
        case 'following':
          // 拆成两个系列：旧系列截止到这一次之前，新系列从这一次开始
          final dur = (master['end_ms'] as int) - (master['start_ms'] as int);
          final copy = <String, dynamic>{...master, 'event_id': _id(), 'start_ms': orig, 'end_ms': orig + dur};
          final oldRule = RRule.tryParse(master['recurrence'] as String?);
          if (oldRule?.count != null) {
            final done = oldRule!.expand(DateTime.fromMillisecondsSinceEpoch(master['start_ms'] as int),
                DateTime.fromMillisecondsSinceEpoch(master['start_ms'] as int), DateTime.fromMillisecondsSinceEpoch(orig)).length;
            copy['recurrence'] = oldRule.copyWith(clearEnd: true, count: (oldRule.count! - done).clamp(1, 999)).toString();
          }
          if (body.containsKey('recurrence')) copy['recurrence'] = body['recurrence'];
          _applyFields(copy, body);
          _truncate(master, orig);
          events[copy['event_id'] as String] = copy;
          _changed(series);
          return (200, copy);
        default: // all：时间按当前实例的偏移量整体平移
          final instStart = orig;
          final delta = body['start_ms'] is int ? (body['start_ms'] as int) - instStart : 0;
          final newDur = body['start_ms'] is int && body['end_ms'] is int
              ? (body['end_ms'] as int) - (body['start_ms'] as int)
              : (master['end_ms'] as int) - (master['start_ms'] as int);
          final patch = {...body}..remove('start_ms')..remove('end_ms');
          if (patch.containsKey('recurrence')) master['recurrence'] = patch.remove('recurrence');
          _applyFields(master, patch);
          master['start_ms'] = (master['start_ms'] as int) + delta;
          master['end_ms'] = (master['start_ms'] as int) + newDur;
          if (delta != 0) exceptions.remove(series); // 时间整体变化后，原有例外不再对应
          _changed(series);
          return (200, master);
      }
    }
    return null;
  }
}
