import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/pages/calendar_page.dart';
import 'package:classmateos_app/services/rrule.dart';
import 'package:classmateos_app/theme.dart';
import 'package:classmateos_app/widgets/recurrence_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 200));
  }
}

List<String> days(List<DateTime> l) => [for (final d in l) '${d.year}-${d.month}-${d.day}'];

void main() {
  group('RRULE 解析与生成', () {
    test('常用规则往返不变', () {
      for (final s in [
        'FREQ=DAILY',
        'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
        'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
        'FREQ=MONTHLY;BYMONTHDAY=31',
        'FREQ=MONTHLY;BYDAY=-1FR',
        'FREQ=MONTHLY;BYDAY=2TU;COUNT=6',
        'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
      ]) {
        expect(RRule.tryParse(s).toString(), s);
      }
    });

    test('不支持的规则返回 null（前端原样保留）', () {
      for (final s in ['FREQ=WEEKLY;BYSETPOS=1', 'FREQ=HOURLY', 'FREQ=DAILY;COUNT=3;UNTIL=20261231T000000Z', 'FREQ=WEEKLY;BYDAY=2MO', 'garbage']) {
        expect(RRule.tryParse(s), isNull, reason: s);
      }
    });

    test('UNTIL 是包含边界，用 UTC 写出', () {
      final r = RRule(freq: RFreq.daily, until: RRule.untilOfDay(DateTime(2026, 10, 23)));
      expect(r.toString(), startsWith('FREQ=DAILY;UNTIL='));
      expect(r.toString(), endsWith('Z'));
      final l = r.expand(DateTime(2026, 10, 20, 10), DateTime(2026, 10, 1), DateTime(2026, 12, 1));
      expect(days(l), ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
      expect(RRule.tryParse(r.toString())!.until, RRule.untilOfDay(DateTime(2026, 10, 23)));
    });

    test('中文描述', () {
      expect(RRule.tryParse('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')!.describe(), '每个工作日');
      expect(RRule.tryParse('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO')!.describe(), '每 2 周的周一、周三');
      expect(RRule.tryParse('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3')!.describe(), '每月的最后一个周五，共 3 次');
    });
  });

  group('RRULE 展开（模拟后端用）', () {
    test('每周一，翻到下个月仍正确', () {
      final l = RRule.tryParse('FREQ=WEEKLY;BYDAY=MO')!
          .expand(DateTime(2026, 10, 19, 10), DateTime(2026, 11, 1), DateTime(2026, 12, 1));
      expect(days(l), ['2026-11-2', '2026-11-9', '2026-11-16', '2026-11-23', '2026-11-30']);
      expect(l.every((d) => d.hour == 10), isTrue);
    });

    test('每月 31 日：没有 31 日的月份跳过', () {
      final l = RRule.tryParse('FREQ=MONTHLY;BYMONTHDAY=31')!
          .expand(DateTime(2026, 1, 31, 9), DateTime(2026, 1, 1), DateTime(2026, 8, 1));
      expect(days(l), ['2026-1-31', '2026-3-31', '2026-5-31', '2026-7-31']);
    });

    test('每月最后一个周五、第 5 个周一不存在时跳过', () {
      final last = RRule.tryParse('FREQ=MONTHLY;BYDAY=-1FR')!
          .expand(DateTime(2026, 10, 30, 15), DateTime(2026, 10, 1), DateTime(2027, 1, 1));
      expect(days(last), ['2026-10-30', '2026-11-27', '2026-12-25']);
      final fifth = RRule.tryParse('FREQ=MONTHLY;BYDAY=5MO')!
          .expand(DateTime(2026, 8, 31, 9), DateTime(2026, 8, 1), DateTime(2027, 1, 1));
      expect(days(fifth), ['2026-8-31', '2026-11-30']);
    });

    test('COUNT 从系列开头计数，窗口外的也算', () {
      final r = RRule.tryParse('FREQ=DAILY;COUNT=5')!;
      final l = r.expand(DateTime(2026, 10, 1, 8), DateTime(2026, 10, 4), DateTime(2026, 10, 30));
      expect(days(l), ['2026-10-4', '2026-10-5']);
    });

    test('2 月 29 日每年：只在闰年出现', () {
      final l = RRule.tryParse('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29')!
          .expand(DateTime(2028, 2, 29, 9), DateTime(2028, 1, 1), DateTime(2037, 1, 1));
      expect(days(l), ['2028-2-29', '2032-2-29', '2036-2-29']);
    });
  });

  group('模拟后端：重复日程的修改范围', () {
    late MockBackend mock;
    late CosApiClient api;
    setUp(() async {
      mock = MockBackend();
      api = CosApiClient(kMockBaseUrl, client: mock.client);
      await api.login('admin', 'x');
    });

    final from = DateTime(2026, 10, 1), to = DateTime(2026, 12, 31);

    Future<CosCalendarEvent> weekly() => api.createEvent(
          title: '组会测试', start: DateTime(2026, 10, 5, 10), end: DateTime(2026, 10, 5, 11), recurrence: 'FREQ=WEEKLY;BYDAY=MO');
    Future<List<CosCalendarEvent>> mine() async =>
        (await api.listEvents(from, to, expandRecurring: true)).where((e) => e.title.startsWith('组会测试')).toList();

    test('改其中一次只影响这一次', () async {
      await weekly();
      final l = await mine();
      expect(l.length, 13);
      expect(l.every((e) => e.recurringEventId != null && e.originalStartMs != null), isTrue);
      final third = l[2];
      await api.updateEvent(third.eventId, scope: 'this', start: DateTime(2026, 10, 19, 14), end: DateTime(2026, 10, 19, 15));
      final after = await mine();
      expect(after.length, 13);
      final moved = after.firstWhere((e) => e.isException);
      expect([moved.start.hour, moved.originalStartMs], [14, third.originalStartMs]);
      expect(after.where((e) => !e.isException).every((e) => e.start.hour == 10), isTrue);
      final last = mock.requests.lastWhere((r) => r.method == 'PATCH');
      expect(last.url.queryParameters['scope'], 'this');
      expect(last.body.contains('recurrence'), isFalse, reason: '只改这一次时不发送重复规则');
    });

    test('「此日程及之后」改时间：前面的不变', () async {
      await weekly();
      final l = await mine();
      await api.updateEvent(l[4].eventId, scope: 'following', start: DateTime(2026, 11, 2, 16), end: DateTime(2026, 11, 2, 17));
      final after = await mine();
      expect(after.length, 13);
      expect(after.take(4).every((e) => e.start.hour == 10), isTrue);
      expect(after.skip(4).every((e) => e.start.hour == 16), isTrue);
    });

    test('「所有日程」按当前实例的偏移整体平移；删除单次 / 之后', () async {
      await weekly();
      var l = await mine();
      await api.updateEvent(l[3].eventId, scope: 'all', start: DateTime(2026, 10, 26, 9), end: DateTime(2026, 10, 26, 10));
      l = await mine();
      expect(l.length, 13);
      expect(l.every((e) => e.start.hour == 9), isTrue);
      await api.deleteEvent(l[1].eventId, scope: 'this');
      expect((await mine()).length, 12);
      l = await mine();
      await api.deleteEvent(l[5].eventId, scope: 'following');
      expect((await mine()).length, 5);
    });

    test('取消重复：发 recurrence:null', () async {
      final e = await weekly();
      await api.updateEvent(e.eventId, scope: 'all', clearRecurrence: true);
      expect(mock.requests.last.body, contains('"recurrence":null'));
      expect((await mine()).length, 1);
    });
  });

  group('界面', () {
    testWidgets('自定义重复：每 2 周的周一、周三，重复 4 次', (tester) async {
      tester.view.physicalSize = const Size(1200, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      RRule? result;
      await tester.pumpWidget(MaterialApp(
        theme: buildFsTheme(),
        home: Builder(builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () async => result = await showDialog<RRule>(
              context: context,
              builder: (_) => CustomRecurrenceDialog(date: DateTime(2026, 10, 19, 10)),
            ),
            child: const Text('open'),
          ),
        )),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('rrule-interval')), '2');
      await tester.tap(find.text('三'));
      await tester.tap(find.text('重复'));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('rrule-dialog-count')));
      await tester.enterText(find.byKey(const ValueKey('rrule-dialog-count')), '4');
      await tester.pumpAndSettle();
      expect(find.textContaining('每 2 周的周一、周三，共 4 次'), findsOneWidget);
      expect(find.textContaining('10/19 周一、10/21 周三、11/2 周一、11/4 周三'), findsOneWidget);
      await tester.tap(find.text('确定'));
      await tester.pumpAndSettle();
      expect(result.toString(), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4');
    });

    testWidgets('日历周视图显示后端展开的重复实例，详情里有中文规则', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final mock = MockBackend();
      final api = CosApiClient(kMockBaseUrl, client: mock.client);
      late AppState state;
      await tester.runAsync(() async {
        final me = await api.login('admin', 'x');
        state = AppState(api: api, me: me, onLogout: () {});
        await state.init(realtime: false);
        state.module = AppModule.calendar;
      });
      await tester.pumpWidget(MaterialApp(theme: buildFsTheme(), home: AppScope(state: state, child: const Scaffold(body: CalendarPage()))));
      await settle(tester);
      final req = mock.requests.lastWhere((r) => r.url.path.endsWith('/calendar/events'));
      expect(req.url.queryParameters.keys, containsAll(['start_ms', 'end_ms']));
      final group = find.textContaining('组会');
      expect(group, findsWidgets);
      await tester.tap(group.first);
      await settle(tester);
      expect(find.textContaining('每周的周一'), findsWidgets);
    });
  });
}
