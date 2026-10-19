import 'dart:convert';

import 'package:classmateos_app/api/phase2.dart';
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/pages/notification_center.dart';
import 'package:classmateos_app/pages/table_view.dart';
import 'package:classmateos_app/pages/view_engine.dart';
import 'package:classmateos_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

CosRecord rec(String id, Map<String, dynamic> f) => CosRecord(recordId: id, fields: f);

/// 记录每个请求，返回固定响应。
(CosApiClient, List<http.Request>) recorder(Map<String, dynamic> Function(http.Request) reply, {int status = 200}) {
  final reqs = <http.Request>[];
  final c = MockClient((r) async {
    reqs.add(r);
    return http.Response.bytes(utf8.encode(jsonEncode(reply(r))), status, headers: {'content-type': 'application/json'});
  });
  return (CosApiClient('http://x/api/v1', accessToken: 't', client: c), reqs);
}

Map<String, dynamic> body(http.Request r) => (jsonDecode(r.body) as Map).cast<String, dynamic>();

void main() {
  group('视图计算（与后端规则一致）', () {
    final rs = [
      rec('a', {'name': '甲', 'status': '进行中', 'n': 3, 'owner': [{'id': 'u1', 'name': '张'}]}),
      rec('b', {'name': '乙', 'status': '已完成', 'n': 1, 'owner': [{'id': 'u2', 'name': '李'}]}),
      rec('c', {'name': '丙', 'status': '进行中', 'n': null}),
      rec('d', {'name': '丁', 'status': null, 'n': 2, 'owner': [{'id': 'u1', 'name': '张'}]}),
    ];

    test('筛选：is / is_empty / gt / 人员 / 且或', () {
      List<String> ids(CosViewConfig c) => [for (final r in applyView(c, rs)) r.recordId];
      expect(ids(const CosViewConfig(conditions: [CosFilterCondition('status', 'is', ['进行中'])])), ['a', 'c']);
      expect(ids(const CosViewConfig(conditions: [CosFilterCondition('status', 'is_empty')])), ['d']);
      expect(ids(const CosViewConfig(conditions: [CosFilterCondition('n', 'gt', 1)])), ['a', 'd']);
      expect(ids(const CosViewConfig(conditions: [CosFilterCondition('owner', 'is', ['u1'])])), ['a', 'd']);
      expect(
          ids(const CosViewConfig(conjunction: 'or', conditions: [
            CosFilterCondition('status', 'is', ['已完成']),
            CosFilterCondition('n', 'is_empty'),
          ])),
          ['b', 'c']);
      // 没填值的条件不生效
      expect(ids(const CosViewConfig(conditions: [CosFilterCondition('status', 'is', [])])).length, 4);
    });

    test('排序：空值总在最后，降序也一样', () {
      List<String> ids(bool desc) =>
          [for (final r in applyView(CosViewConfig(sort: [CosSortSpec('n', desc: desc)]), rs)) r.recordId];
      expect(ids(false), ['b', 'd', 'a', 'c']);
      expect(ids(true), ['a', 'd', 'b', 'c']);
    });

    test('分组展开成行，折叠后组内不显示', () {
      const g = [CosSortSpec('status')];
      final sorted = applyView(const CosViewConfig(group: g), rs);
      final rows = buildGridRows(sorted, g, {});
      final headers = rows.whereType<GroupHeaderRow>().toList();
      expect(headers.map((h) => '${h.path.first}:${h.count}'), ['已完成:1', '进行中:2', ':1']);
      final folded = buildGridRows(sorted, g, {'进行中'});
      expect(folded.whereType<RecordRow>().length, 2);
    });

    test('视图配置往返不丢不认识的字段，列顺序合并新字段', () {
      final j = {
        'filter': {'conjunction': 'or', 'conditions': [{'field_name': 'status', 'operator': 'is', 'value': ['进行中']}]},
        'field_order': ['b', 'a'],
        'calendar': {'start_field': 's'},
        'row_height': 'compact',
      };
      final c = CosViewConfig.fromJson(j);
      expect(c.conjunction, 'or');
      expect(c.rowExtent, 32);
      expect(c.toJson()['calendar'], {'start_field': 's'});
      final fields = [for (final n in ['a', 'b', 'c']) CosFieldMeta(fieldName: n, type: 1)];
      expect(c.orderedFields(fields).map((f) => f.fieldName), ['b', 'a', 'c']);
    });
  });

  group('二期接口契约', () {
    test('capabilities 缺失的 key 当 false；接口 404 时只开放新建表', () async {
      final (api, _) = recorder((_) => {'features': {'table.views': true, 'x': 'y'}});
      final caps = await api.capabilities();
      expect(caps.has('table.views'), isTrue);
      expect(caps.has('notifications'), isFalse);
      final (old, _) = recorder((_) => {'message': 'not found'}, status: 404);
      final legacy = await old.capabilities();
      expect(legacy.legacy, isTrue);
      expect(legacy.has('table.create'), isTrue);
      expect(legacy.has('table.fields'), isFalse);
    });

    test('字段接口带 base_version / after_field，类型预估', () async {
      final (api, reqs) = recorder((r) => r.url.path.endsWith('convert-preview')
          ? {'affected': 12, 'will_clear': 3}
          : {'key': 'projects', 'version': 9, 'fields': []});
      await api.createField('projects', {'title': '预算', 'type': 2}, afterField: 'owner', baseVersion: 8);
      expect(reqs.last.method, 'POST');
      expect(reqs.last.url.path, '/api/v1/tables/projects/fields');
      expect(body(reqs.last), {'title': '预算', 'type': 2, 'after_field': 'owner', 'base_version': 8});
      await api.updateField('projects', 'status', {'option_renames': {'进行中': '开发中'}}, baseVersion: 9);
      expect(reqs.last.method, 'PATCH');
      expect(body(reqs.last)['base_version'], 9);
      await api.deleteField('projects', 'notes', baseVersion: 9);
      expect(reqs.last.method, 'DELETE');
      expect(reqs.last.url.queryParameters['base_version'], '9');
      await api.reorderFields('projects', ['name', 'status']);
      expect(reqs.last.method, 'PUT');
      expect(reqs.last.url.path, '/api/v1/tables/projects/fields/order');
      final p = await api.convertPreview('projects', 'notes', 2);
      expect((p.affected, p.willClear), (12, 3));
      expect(body(reqs.last), {'type': 2});
    });

    test('视图：PATCH 整体替换 config 并带 version；按 view_id 取记录和分组', () async {
      final (api, reqs) = recorder((r) => r.url.path.endsWith('/records')
          ? {
              'items': [{'record_id': 'r1', 'fields': {}}],
              'has_more': false,
              'total': 1,
              'groups': [{'path': ['进行中'], 'count': 1}],
            }
          : {'view_id': 'v1', 'name': '视图', 'version': 4, 'config': {}});
      await api.updateView('projects', 'v1',
          config: const CosViewConfig(sort: [CosSortSpec('due', desc: true)]), version: 3);
      final b = body(reqs.last);
      expect(b['version'], 3);
      expect(b['config']['sort'], [{'field_name': 'due', 'desc': true}]);
      expect(b['config']['filter'], {'conjunction': 'and', 'conditions': []});
      final r = await api.listViewRecords('projects', 'v1');
      expect(reqs.last.url.queryParameters['view_id'], 'v1');
      expect(r.groups.single.count, 1);
    });

    test('批量与通知接口的请求体', () async {
      final (api, reqs) = recorder((r) => r.url.path.endsWith('unread-count')
          ? {'count': 4}
          : {'succeeded': ['r1'], 'failed': [{'record_id': 'r2', 'message': '必填'}]});
      final res = await api.batchUpdate('t', recordIds: ['r1', 'r2'], fields: {'status': '已完成'});
      expect(body(reqs.last), {'record_ids': ['r1', 'r2'], 'fields': {'status': '已完成'}});
      expect(res.failed.single.message, '必填');
      await api.batchUpdate('t', records: [(recordId: 'r1', fields: {'n': 1})]);
      expect(body(reqs.last), {'records': [{'record_id': 'r1', 'fields': {'n': 1}}]});
      await api.batchDelete('t', ['r1']);
      expect(reqs.last.url.path, '/api/v1/tables/t/records/batch_delete');
      expect(await api.notificationUnreadCount(), 4);
      await api.markNotificationsRead(all: true);
      expect(body(reqs.last), {'all': true});
      await api.markNotificationsRead(ids: ['n1']);
      expect(body(reqs.last), {'ids': ['n1']});
      await api.registerDevice('ios', 'tok');
      expect(body(reqs.last), {'platform': 'ios', 'device_token': 'tok'});
    });

    test('通知设置往返', () {
      final s = CosNotificationSettings.fromJson({
        'enabled': true,
        'categories': {'task': false},
        'dnd': {'enabled': true, 'start': '22:30', 'end': '07:00'},
        'mute_mobile_when_desktop_online': false,
        'show_preview': false,
      });
      final j = s.toJson();
      expect(j['categories']['task'], isFalse);
      expect(j['categories']['message'], isTrue);
      expect(j['dnd'], {'enabled': true, 'start': '22:30', 'end': '07:00'});
      expect(j['mute_mobile_when_desktop_online'], isFalse);
    });
  });

  group('界面（测试数据模式）', () {
    late MockBackend mock;
    late AppState state;

    Future<void> boot(WidgetTester tester, Widget child) async {
      tester.view.physicalSize = const Size(1440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      mock = MockBackend();
      final api = CosApiClient(kMockBaseUrl, client: mock.client);
      await tester.runAsync(() async {
        final me = await api.login('admin', 'x');
        state = AppState(api: api, me: me, onLogout: () {});
        mock.onEvent = (e) => state.injectEvent(CosEvent.fromJson(e));
        _mocks[state] = mock;
        await state.init(realtime: false);
      });
      await tester.pumpWidget(MaterialApp(
        theme: buildFsTheme(),
        home: AppScope(state: state, child: Scaffold(body: child)),
      ));
      await settle(tester);
    }

    Future<CosTableMeta> projects() async =>
        (await state.api.listTables()).firstWhere((t) => t.key == 'projects');

    testWidgets('切换到分组视图：按负责人分组、只显示进行中', (tester) async {
      await bootTable(tester, boot, projects);
      expect(find.text('全部项目'), findsOneWidget);
      expect(find.text('12 条记录'), findsOneWidget);
      await tester.tap(find.text('进行中（按负责人）'));
      await settle(tester);
      expect(find.text('负责人：'), findsWidgets);
      expect(find.text('机械臂抓取'), findsOneWidget);
      expect(find.text('视觉定位 SLAM'), findsNothing); // 已完成，被筛掉
      expect(find.text('筛选 1'), findsOneWidget);
      expect(find.text('分组 1'), findsOneWidget);
    });

    testWidgets('别人改了记录：不刷新整页就更新单元格', (tester) async {
      await bootTable(tester, boot, projects);
      expect(find.text('机械臂抓取'), findsOneWidget);
      mock.simulateRemoteUpdate('projects', 'rec_p0', {'name': '机械臂抓取 v2'});
      await settle(tester);
      expect(find.text('机械臂抓取 v2'), findsOneWidget);
      expect(state.subscribedTopics, contains('table:projects'));
    });

    testWidgets('批量删除：勾选两条后删除', (tester) async {
      await bootTable(tester, boot, projects);
      final st = tester.state<TableViewState>(find.byType(TableView));
      st.toggleSelect('rec_p0', st.records);
      st.toggleSelect('rec_p1', st.records);
      await settle(tester);
      expect(find.text('已选 2 条'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, '删除'));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, '删除'));
      await settle(tester);
      expect(mock.records['projects']!.length, 10);
      expect(find.text('10 条记录'), findsOneWidget);
    });

    testWidgets('改排序自动保存到视图（带版本号）', (tester) async {
      await bootTable(tester, boot, projects);
      final st = tester.state<TableViewState>(find.byType(TableView));
      st.updateConfig(st.cfg.copyWith(sort: [const CosSortSpec('progress', desc: true)]));
      await settle(tester, extra: const Duration(seconds: 1));
      final v = mock.views['projects']!.first;
      expect(v['version'], 2);
      expect((v['config'] as Map)['sort'], [{'field_name': 'progress', 'desc': true}]);
    });

    testWidgets('后端没开放视图和字段管理时：入口隐藏，本地表格/看板照常可用', (tester) async {
      await bootTable(tester, boot, projects, before: (m) {
        m.features['table.views'] = false;
        m.features['table.fields'] = false;
      });
      expect(find.text('新建视图'), findsNothing);
      expect(find.text('字段管理'), findsNothing);
      expect(find.text('表格视图'), findsOneWidget);
      expect(find.text('看板视图'), findsOneWidget);
    });

    testWidgets('表头「+」新增单选字段：新列出现，选项和颜色发给后端', (tester) async {
      await bootTable(tester, boot, projects);
      await tester.tap(find.byTooltip('新增字段'));
      await settle(tester);
      await tester.enterText(find.widgetWithText(TextFormField, '字段名称'), '经费来源');
      await tester.tap(find.text('文本').last);
      await settle(tester);
      await tester.tap(find.text('单选').last);
      await settle(tester);
      await tester.enterText(find.widgetWithText(TextFormField, '选项名称').first, '纵向课题');
      await tester.tap(find.widgetWithText(FilledButton, '添加字段'));
      await settle(tester);
      final fields = (mock.tables['projects']!['fields'] as List).cast<Map>();
      final f = fields.last;
      expect(f['title'], '经费来源');
      expect(f['type'], 3);
      expect(f['options'], ['纵向课题']);
      expect((f['option_colors'] as Map)['纵向课题'], 'blue');
      final post = mock.requests.lastWhere((r) => r.method == 'POST' && r.url.path.endsWith('/fields'));
      expect(body(post)['base_version'], 1);
      expect(find.text('经费来源'), findsOneWidget);
    });

    testWidgets('通知中心：未读数、@我的筛选、全部已读', (tester) async {
      await boot(tester, const Center(child: NotificationBell()));
      expect(state.notifUnread, 3);
      await tester.tap(find.byType(NotificationBell));
      await settle(tester);
      expect(find.text('李同学 给你指派了任务「整理组会纪要」'), findsOneWidget);
      await tester.tap(find.text('@我的'));
      await settle(tester);
      expect(find.text('李同学 给你指派了任务「整理组会纪要」'), findsNothing);
      expect(find.text('张晓明 在《开题报告》中 @了你'), findsOneWidget);
      await tester.tap(find.text('全部标为已读'));
      await settle(tester);
      expect(state.notifUnread, 0);
      mock.pushNotification('task.assigned', '陈雨 给你指派了任务「采购清单」');
      await settle(tester);
      expect(state.notifUnread, 1);
    });
  });
}

/// MockClient 是真正的异步，pumpAndSettle 等不到；用 runAsync 让请求跑完再 pump。
Future<void> settle(WidgetTester tester, {Duration extra = Duration.zero}) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 200));
  }
  if (extra > Duration.zero) {
    await tester.pump(extra);
    for (var i = 0; i < 4; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
      await tester.pump(const Duration(milliseconds: 100));
    }
  }
}

Future<void> bootTable(
  WidgetTester tester,
  Future<void> Function(WidgetTester, Widget) boot,
  Future<CosTableMeta> Function() projects, {
  void Function(MockBackend)? before,
}) async {
  // 先起一个空壳拿到 mock，再挂表格页
  await boot(tester, const SizedBox());
  final ctx = tester.element(find.byType(SizedBox).first);
  final s = AppScope.read(ctx);
  if (before != null) {
    final mock = _mockOf(s);
    before(mock);
    await tester.runAsync(s.loadCapabilities);
  }
  late CosTableMeta meta;
  await tester.runAsync(() async => meta = await projects());
  await tester.pumpWidget(MaterialApp(
    theme: buildFsTheme(),
    home: AppScope(state: s, child: Scaffold(body: TableView(meta: meta))),
  ));
  await settle(tester);
}

final _mocks = Expando<MockBackend>();
MockBackend _mockOf(AppState s) => _mocks[s]!;
