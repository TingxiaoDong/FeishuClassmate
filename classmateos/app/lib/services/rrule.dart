/// RFC 5545 RRULE 的前端子集：解析、生成、中文描述、展开。
///
/// 支持 FREQ=DAILY|WEEKLY|MONTHLY|YEARLY、INTERVAL、BYDAY（含序数，如 2MO、-1FR）、
/// BYMONTHDAY、BYMONTH、COUNT、UNTIL。超出这个子集的规则 [RRule.tryParse] 返回 null，
/// 前端原样保留，不做有损改写。
///
/// 正式数据由后端展开；[expand] 只用于测试数据模式和编辑器里的「接下来几次」预览。
/// 按本地时区的「墙上时间」展开（每天 10:00 跨夏令时仍是 10:00）。
library;

const kWeekdayCodes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const kWeekdayNames = ['一', '二', '三', '四', '五', '六', '日'];

class RDay {
  /// 1 = 周一 … 7 = 周日（与 DateTime.weekday 一致）。
  final int weekday;

  /// 序数：0 表示不限；1..5 表示第几个；-1 表示最后一个。
  final int ordinal;
  const RDay(this.weekday, [this.ordinal = 0]);

  @override
  String toString() => '${ordinal == 0 ? '' : ordinal}${kWeekdayCodes[weekday - 1]}';

  @override
  bool operator ==(Object other) => other is RDay && other.weekday == weekday && other.ordinal == ordinal;
  @override
  int get hashCode => weekday * 31 + ordinal;
}

enum RFreq { daily, weekly, monthly, yearly }

class RRule {
  final RFreq freq;
  final int interval;
  final List<RDay> byDay;
  final List<int> byMonthDay;
  final List<int> byMonth;
  final int? count;

  /// 截止时间（包含）。
  final DateTime? until;

  const RRule({
    required this.freq,
    this.interval = 1,
    this.byDay = const [],
    this.byMonthDay = const [],
    this.byMonth = const [],
    this.count,
    this.until,
  });

  RRule copyWith({
    RFreq? freq,
    int? interval,
    List<RDay>? byDay,
    List<int>? byMonthDay,
    List<int>? byMonth,
    int? count,
    DateTime? until,
    bool clearEnd = false,
  }) =>
      RRule(
        freq: freq ?? this.freq,
        interval: interval ?? this.interval,
        byDay: byDay ?? this.byDay,
        byMonthDay: byMonthDay ?? this.byMonthDay,
        byMonth: byMonth ?? this.byMonth,
        count: clearEnd ? count : (count ?? this.count),
        until: clearEnd ? until : (until ?? this.until),
      );

  /// 去掉结束条件后的规则（用于和常用选项比较）。
  RRule get withoutEnd => RRule(freq: freq, interval: interval, byDay: byDay, byMonthDay: byMonthDay, byMonth: byMonth);

  static RRule? tryParse(String? s) {
    if (s == null) return null;
    var text = s.trim();
    if (text.toUpperCase().startsWith('RRULE:')) text = text.substring(6);
    if (text.isEmpty) return null;
    RFreq? freq;
    var interval = 1;
    final byDay = <RDay>[];
    final byMonthDay = <int>[];
    final byMonth = <int>[];
    int? count;
    DateTime? until;
    for (final part in text.split(';')) {
      if (part.isEmpty) continue;
      final kv = part.split('=');
      if (kv.length != 2) return null;
      final k = kv[0].toUpperCase(), v = kv[1].toUpperCase();
      switch (k) {
        case 'FREQ':
          freq = switch (v) {
            'DAILY' => RFreq.daily,
            'WEEKLY' => RFreq.weekly,
            'MONTHLY' => RFreq.monthly,
            'YEARLY' => RFreq.yearly,
            _ => null,
          };
          if (freq == null) return null;
        case 'INTERVAL':
          final n = int.tryParse(v);
          if (n == null || n < 1) return null;
          interval = n;
        case 'BYDAY':
          for (final d in v.split(',')) {
            final m = RegExp(r'^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$').firstMatch(d);
            if (m == null) return null;
            final ord = m.group(1) == null ? 0 : int.parse(m.group(1)!.replaceFirst('+', ''));
            if (ord < -1 || ord > 5) return null; // 只支持「最后一个」这种负序数
            byDay.add(RDay(kWeekdayCodes.indexOf(m.group(2)!) + 1, ord));
          }
        case 'BYMONTHDAY':
          for (final d in v.split(',')) {
            final n = int.tryParse(d);
            if (n == null || n < 1 || n > 31) return null;
            byMonthDay.add(n);
          }
        case 'BYMONTH':
          for (final d in v.split(',')) {
            final n = int.tryParse(d);
            if (n == null || n < 1 || n > 12) return null;
            byMonth.add(n);
          }
        case 'COUNT':
          count = int.tryParse(v);
          if (count == null || count < 1) return null;
        case 'UNTIL':
          until = _parseUntil(v);
          if (until == null) return null;
        case 'WKST':
          if (v != 'MO') return null;
        default:
          return null; // BYSETPOS、BYHOUR 等不支持，原样保留
      }
    }
    if (freq == null) return null;
    if (count != null && until != null) return null; // RFC 5545：二者互斥
    // 序数星期只在按月 / 按年时有意义
    if (byDay.any((d) => d.ordinal != 0) && freq != RFreq.monthly) return null;
    return RRule(freq: freq, interval: interval, byDay: byDay, byMonthDay: byMonthDay, byMonth: byMonth, count: count, until: until);
  }

  static DateTime? _parseUntil(String v) {
    final m = RegExp(r'^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$').firstMatch(v);
    if (m == null) return null;
    final y = int.parse(m.group(1)!), mo = int.parse(m.group(2)!), d = int.parse(m.group(3)!);
    if (m.group(4) == null) return DateTime(y, mo, d, 23, 59, 59); // 只有日期：当天结束（本地）
    final h = int.parse(m.group(4)!), mi = int.parse(m.group(5)!), s = int.parse(m.group(6)!);
    return m.group(7) == 'Z' ? DateTime.utc(y, mo, d, h, mi, s).toLocal() : DateTime(y, mo, d, h, mi, s);
  }

  static String _two(int n) => n.toString().padLeft(2, '0');

  @override
  String toString() {
    final parts = <String>['FREQ=${freq.name.toUpperCase()}'];
    if (interval > 1) parts.add('INTERVAL=$interval');
    if (byMonth.isNotEmpty) parts.add('BYMONTH=${byMonth.join(',')}');
    if (byMonthDay.isNotEmpty) parts.add('BYMONTHDAY=${byMonthDay.join(',')}');
    if (byDay.isNotEmpty) parts.add('BYDAY=${byDay.join(',')}');
    if (count != null) parts.add('COUNT=$count');
    if (until != null) {
      final u = until!.toUtc();
      parts.add('UNTIL=${u.year}${_two(u.month)}${_two(u.day)}T${_two(u.hour)}${_two(u.minute)}${_two(u.second)}Z');
    }
    return parts.join(';');
  }

  /// 截止日期 → 当天 23:59:59（本地），转成 UTC 写进 UNTIL，包含这一天。
  static DateTime untilOfDay(DateTime day) => DateTime(day.year, day.month, day.day, 23, 59, 59);

  /// 中文描述，如「每 2 周的周一、周三，共 10 次」。
  String describe() {
    String days(List<RDay> ds) => (ds.toList()..sort((a, b) => a.weekday.compareTo(b.weekday)))
        .map((d) => '周${kWeekdayNames[d.weekday - 1]}')
        .join('、');
    String ord(int o) => o == -1 ? '最后一个' : '第 $o 个';
    final base = switch (freq) {
      RFreq.daily => interval == 1 ? '每天' : '每 $interval 天',
      RFreq.weekly => () {
          final unit = interval == 1 ? '每周' : '每 $interval 周';
          final ds = byDay.where((d) => d.ordinal == 0).toList();
          if (ds.length == 5 && ds.every((d) => d.weekday <= 5) && interval == 1) return '每个工作日';
          return ds.isEmpty ? unit : '$unit的${days(ds)}';
        }(),
      RFreq.monthly => () {
          final unit = interval == 1 ? '每月' : '每 $interval 个月';
          if (byMonthDay.isNotEmpty) return '$unit的 ${byMonthDay.join('、')} 日';
          if (byDay.isNotEmpty) {
            return '$unit的${byDay.map((d) => '${ord(d.ordinal == 0 ? 1 : d.ordinal)}周${kWeekdayNames[d.weekday - 1]}').join('、')}';
          }
          return unit;
        }(),
      RFreq.yearly => () {
          final unit = interval == 1 ? '每年' : '每 $interval 年';
          if (byMonth.isNotEmpty && byMonthDay.isNotEmpty) return '$unit的 ${byMonth.first} 月 ${byMonthDay.first} 日';
          return unit;
        }(),
    };
    if (count != null) return '$base，共 $count 次';
    if (until != null) return '$base，到 ${until!.year} 年 ${until!.month} 月 ${until!.day} 日为止';
    return base;
  }

  /// 展开 [dtstart] 开始的重复系列，返回落在 [from, to) 内的实例开始时间（本地时间）。
  /// [limit] 防止规则写错时死循环。
  List<DateTime> expand(DateTime dtstart, DateTime from, DateTime to, {int limit = 2000}) {
    final start = dtstart.toLocal();
    final out = <DateTime>[];
    var produced = 0;
    var guard = 0;
    DateTime at(int y, int m, int d) => DateTime(y, m, d, start.hour, start.minute, start.second);
    bool valid(int y, int m, int d) {
      final t = DateTime(y, m, d);
      return t.year == y && t.month == m && t.day == d;
    }

    // 返回 false 表示结束
    bool emit(DateTime t) {
      if (t.isBefore(start)) return true;
      if (until != null && t.isAfter(until!)) return false;
      if (count != null && produced >= count!) return false;
      produced++;
      if (!t.isBefore(to)) return false;
      if (!t.isBefore(from)) out.add(t);
      return out.length < limit;
    }

    for (var k = 0; guard++ < 100000; k += interval) {
      List<DateTime> cands;
      switch (freq) {
        case RFreq.daily:
          cands = [at(start.year, start.month, start.day + k)];
        case RFreq.weekly:
          final monday = DateTime(start.year, start.month, start.day - (start.weekday - 1) + 7 * k);
          final wds = byDay.isEmpty ? [start.weekday] : (byDay.map((d) => d.weekday).toSet().toList()..sort());
          cands = [for (final w in wds) at(monday.year, monday.month, monday.day + w - 1)];
        case RFreq.monthly:
          final mm = DateTime(start.year, start.month + k);
          cands = [];
          if (byDay.isNotEmpty) {
            for (final d in byDay) {
              final o = d.ordinal == 0 ? 1 : d.ordinal;
              final day = _nthWeekday(mm.year, mm.month, d.weekday, o);
              if (day != null) cands.add(at(mm.year, mm.month, day));
            }
          } else {
            for (final d in (byMonthDay.isEmpty ? [start.day] : byMonthDay)) {
              if (valid(mm.year, mm.month, d)) cands.add(at(mm.year, mm.month, d)); // 不存在的日期跳过该月
            }
          }
          cands.sort();
        case RFreq.yearly:
          final y = start.year + k;
          cands = [];
          for (final m in (byMonth.isEmpty ? [start.month] : byMonth)) {
            for (final d in (byMonthDay.isEmpty ? [start.day] : byMonthDay)) {
              if (valid(y, m, d)) cands.add(at(y, m, d));
            }
          }
          cands.sort();
      }
      for (final c in cands) {
        if (!emit(c)) return out;
      }
      // 没有结束条件时，越过窗口就停
      if (cands.isNotEmpty && !cands.last.isBefore(to)) return out;
      if (freq == RFreq.yearly && start.year + k > to.year + 1) return out;
    }
    return out;
  }

  static int? _nthWeekday(int y, int m, int weekday, int ordinal) {
    if (ordinal == -1) {
      final last = DateTime(y, m + 1, 0);
      return last.day - ((last.weekday - weekday + 7) % 7);
    }
    final first = DateTime(y, m, 1);
    final d = 1 + (weekday - first.weekday + 7) % 7 + 7 * (ordinal - 1);
    return DateTime(y, m, d).month == m ? d : null;
  }
}
