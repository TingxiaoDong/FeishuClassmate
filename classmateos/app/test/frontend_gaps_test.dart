// 前端遗留项补齐（2026-10-20 晚）：表图标、组织架构同级排序、多选收藏、内部链接摘要、表格区域复制粘贴。
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/pages/admin_org.dart';
import 'package:classmateos_app/pages/message_more.dart';
import 'package:classmateos_app/pages/shell.dart';
import 'package:classmateos_app/pages/table_clipboard.dart';
import 'package:classmateos_app/pages/table_manage.dart';
import 'package:classmateos_app/pages/table_view.dart';
import 'package:classmateos_app/theme.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'phase2_test.dart' show settle;

CosFieldMeta _f(int type, {List<String>? options}) =>
    CosFieldMeta(fieldName: 'f', type: type, title: '字段', options: options);

void main() {
  group('复制粘贴格式转换', () {
    test('TSV 往返：带制表符、换行、引号的格子加引号', () {
      final rows = [
        ['a', 'b\tc'],
        ['多行\n文字', '有"引号"'],
      ];
      final tsv = toTsv(rows);
      expect(tsv, 'a\t"b\tc"\n"多行\n文字"\t"有""引号"""');
      expect(parseTsv(tsv), rows);
      expect(parseTsv('x\ty\r\n1\t2\r\n\r\n'), [
        ['x', 'y'],
        ['1', '2'],
      ], reason: 'Windows 换行、末尾空行');
    });

    test('按字段类型转换', () {
      final users = [const CosUser(userId: 'ou_demo', name: '李同学'), const CosUser(userId: 'ou_chen', name: '陈雨')];
      expect(parsePasteValue(_f(2), '1,234.5', users).value, 1234.5);
      expect(parsePasteValue(_f(2), 'abc', users).ok, isFalse);
      expect(parsePasteValue(_f(3, options: ['高', '低']), '高', users).value, '高');
      expect(parsePasteValue(_f(3, options: ['高', '低']), '中', users).error, contains('不是「字段」的选项'));
      expect(parsePasteValue(_f(4, options: ['A', 'B']), 'A、B', users).value, ['A', 'B']);
      expect(parsePasteValue(_f(7), '是', users).value, true);
      expect(parsePasteValue(_f(7), 'FALSE', users).value, false);
      expect(parsePasteValue(_f(11), '李同学，陈雨', users).value, [
        {'id': 'ou_demo', 'name': '李同学'},
        {'id': 'ou_chen', 'name': '陈雨'},
      ]);
      expect(parsePasteValue(_f(11), '路人甲', users).error, contains('路人甲'));
      expect(parsePasteValue(_f(1), '  ', users).value, isNull, reason: '空白 = 清空');
      expect(parsePasteValue(_f(17), 'x', users).ok, isFalse, reason: '附件不支持粘贴');
      final d = DateTime.fromMillisecondsSinceEpoch(parsePasteValue(_f(5), '2026年10月20日 14:30', users).value as int);
      expect([d.year, d.month, d.day, d.hour, d.minute], [2026, 10, 20, 14, 30]);
      expect(parsePasteDate('2026/2/30'), isNull);
      expect(cellCopyText(_f(5), DateTime(2026, 10, 20).millisecondsSinceEpoch), '2026-10-20');
    });

    test('内部链接正文摘要去掉 Markdown 符号', () {
      expect(plainSummary('# 标题\n\n- [ ] 第一项 **加粗**\n> 引用 [链接](http://x)\n![图](a.png)'), '标题 第一项 加粗 引用 链接');
      expect(plainSummary('一' * 100).length, 81);
      expect(plainSummary(null), '');
    });
  });

  group('界面（测试数据模式）', () {
    late MockBackend mock;
    late AppState state;
    final clipboard = <String?>[null];

    Future<void> boot(WidgetTester tester, Widget Function() child, {String? chat, Size size = const Size(1500, 900)}) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') clipboard[0] = (call.arguments as Map)['text'] as String?;
        if (call.method == 'Clipboard.getData') return {'text': clipboard[0]};
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      mock = MockBackend();
      final api = CosApiClient(kMockBaseUrl, client: mock.client);
      await tester.runAsync(() async {
        final me = await api.login('admin', 'x');
        state = AppState(api: api, me: me, onLogout: () {});
        mock.onEvent = (e) => state.injectEvent(CosEvent.fromJson(e));
        await state.init(realtime: false);
        if (chat != null) state.openChat(chat);
      });
      await tester.pumpWidget(MaterialApp(theme: buildFsTheme(), home: AppScope(state: state, child: Scaffold(body: child()))));
      await settle(tester);
    }

    testWidgets('修改表图标：只发 icon 改动，侧边栏按图标显示', (tester) async {
      late BuildContext ctx;
      await boot(tester, () => Builder(builder: (c) {
            ctx = c;
            return const SizedBox();
          }));
      late CosTableMeta t;
      await tester.runAsync(() async => t = (await state.api.listTables()).firstWhere((x) => x.key == 'equipment'));
      final done = runTableAction(ctx, t, 'rename');
      await settle(tester);
      expect(find.text('名称、图标与描述'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('table-icon-science')));
      await tester.pump();
      await tester.tap(find.text('保存'));
      await settle(tester);
      final r = await done;
      expect(r?.$2?.icon, 'science');
      expect(mock.tables['equipment']!['icon'], 'science');
      expect(tableIcon('science'), Icons.science_outlined);
      expect(tableIcon('没见过的图标'), Icons.table_chart_outlined);
    });

    testWidgets('组织架构：下移给同级重写 order；拖到两行之间换层级并插到指定位置', (tester) async {
      await boot(tester, () => const AdminOrgPane());
      List<String> order(String? parent) {
        final l = [for (final d in mock.admin.departments.values) if (d['parent_id'] == parent) d]
          ..sort((a, b) => (a['order'] as num).compareTo(b['order'] as num));
        return [for (final d in l) d['department_id'] as String];
      }

      expect(order(null), ['d_lab', 'd_admin']);
      await tester.tap(find.byKey(const ValueKey('dept-menu-d_lab')));
      await settle(tester);
      await tester.tap(find.text('下移'));
      await settle(tester);
      expect(order(null), ['d_admin', 'd_lab']);
      expect(mock.admin.departments['d_admin']!['order'], 0);
      expect(mock.admin.departments['d_lab']!['order'], 1);

      // 把「视觉组」（d_lab 的下级）拖到最上层第一个位置
      final from = tester.getCenter(find.byKey(const ValueKey('dept-d_vision')));
      final g = await tester.startGesture(from);
      await tester.pump(const Duration(milliseconds: 400));
      await g.moveBy(const Offset(0, -10));
      await tester.pump();
      await g.moveTo(tester.getCenter(find.byKey(const ValueKey('dept-gap-root/0'))));
      await tester.pump();
      await g.up();
      await settle(tester);
      expect(order(null), ['d_vision', 'd_admin', 'd_lab']);
      expect(mock.admin.departments['d_vision']!['parent_id'], isNull);
      expect(order('d_lab'), ['d_robot']);
    });

    testWidgets('消息多选后批量收藏', (tester) async {
      await boot(tester, () => const HomeShell(), chat: 'oc_lab');
      const t1 = '这周组会改到周四下午两点，大家注意一下';
      const t2 = '机械臂抓取实验的数据整理好了，成功率 87%，失败主要是滑落';
      await tester.tap(find.text(t1), buttons: kSecondaryButton);
      await settle(tester);
      await tester.tap(find.text('多选'));
      await settle(tester);
      await tester.tap(find.text(t2));
      await tester.pump();
      expect(find.text('已选 2 条'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('select-favorite')));
      await settle(tester);
      expect(mock.requests.where((r) => r.method == 'POST' && r.url.path.endsWith('/favorite')), hasLength(2));
      expect(find.text('已收藏 2 条'), findsOneWidget);
      expect(find.text('已选 2 条'), findsNothing, reason: '全部成功后退出多选');
    });

    testWidgets('内部链接卡片显示文档正文摘要', (tester) async {
      late String docId;
      await boot(tester, () => const SizedBox());
      await tester.runAsync(() async {
        docId = (await state.api.createDoc('标定流程', '# 标定流程\n\n1. 先把**相机**固定好\n2. 拍棋盘格')).docId;
      });
      final link = parseInternalLink('${state.api.origin}/app/docs/$docId', state.api.origin)!;
      await tester.pumpWidget(MaterialApp(
          theme: buildFsTheme(), home: AppScope(state: state, child: Scaffold(body: InternalLinkCard(link: link)))));
      await settle(tester);
      expect(find.text('标定流程'), findsOneWidget);
      expect(find.text('标定流程 先把 相机 固定好 拍棋盘格'), findsOneWidget);
    });

    testWidgets('表格：拖选区域 ⌘C 复制成 TSV，⌘V 粘贴（含不能转换的格子）后可撤销', (tester) async {
      late CosTableMeta meta;
      await boot(tester, () => const SizedBox());
      await tester.runAsync(() async => meta = (await state.api.listTables()).firstWhere((t) => t.key == 'projects'));
      await tester.pumpWidget(MaterialApp(
          theme: buildFsTheme(), home: AppScope(state: state, child: Scaffold(body: TableView(meta: meta)))));
      await settle(tester);

      Finder cell(String rec, String f) => find.byKey(ValueKey('cell-$rec-$f'));
      Future<void> drag(Finder a, Finder b) async {
        final g = await tester.startGesture(tester.getCenter(a), kind: PointerDeviceKind.mouse, buttons: kPrimaryMouseButton);
        await tester.pump();
        await g.moveTo(tester.getCenter(b));
        await tester.pump();
        await g.up();
        await tester.pump();
      }

      Future<void> cmd(LogicalKeyboardKey k) async {
        await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
        await tester.sendKeyEvent(k);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
        await settle(tester);
      }

      final recs = [for (final r in mock.records['projects']!) r['record_id'] as String];
      await drag(cell(recs[0], 'name'), cell(recs[1], 'status'));
      expect(find.byKey(const ValueKey('cell-range-hint')), findsOneWidget);
      expect(find.textContaining('已选 2 行 × 2 列'), findsOneWidget);
      await cmd(LogicalKeyboardKey.keyC);
      expect(clipboard[0], '机械臂抓取\t进行中\n四足机器人步态\t进行中');

      final old0 = mock.records['projects']![0]['fields']['name'];
      clipboard[0] = '新名称一\t已完成\n新名称二\t不存在的选项';
      await cmd(LogicalKeyboardKey.keyV);
      expect(find.text('有 1 个格子不能粘贴'), findsOneWidget);
      await tester.tap(find.text('粘贴其余格子'));
      await settle(tester);
      final batch = mock.requests.where((r) => r.url.path.endsWith('/records/batch_update')).toList();
      expect(batch, hasLength(1), reason: '一次批量写入');
      expect(mock.records['projects']![0]['fields']['name'], '新名称一');
      expect(mock.records['projects']![0]['fields']['status'], '已完成');
      expect(mock.records['projects']![1]['fields']['name'], '新名称二');
      expect(mock.records['projects']![1]['fields']['status'], '进行中', reason: '不能转换的格子不写');

      await cmd(LogicalKeyboardKey.keyZ);
      expect(mock.records['projects']![0]['fields']['name'], old0);
      expect(mock.records['projects']![0]['fields']['status'], '进行中');
    });
  });
}
