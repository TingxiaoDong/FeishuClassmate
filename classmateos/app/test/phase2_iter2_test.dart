import 'dart:convert';

import 'package:classmateos_app/api/phase2_docs.dart';
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/pages/docs_page.dart';
import 'package:classmateos_app/pages/wiki_page.dart';
import 'package:classmateos_app/services/collab_presence.dart';
import 'package:classmateos_app/services/line_diff.dart';
import 'package:classmateos_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

(CosApiClient, List<http.Request>) recorder(Object? Function(http.Request) reply) {
  final reqs = <http.Request>[];
  final c = MockClient((r) async {
    reqs.add(r);
    final v = reply(r);
    return http.Response.bytes(utf8.encode(jsonEncode(v ?? {})), 200, headers: {'content-type': 'application/json'});
  });
  return (CosApiClient('http://x/api/v1', accessToken: 't', client: c), reqs);
}

Map<String, dynamic> body(http.Request r) => (jsonDecode(r.body) as Map).cast<String, dynamic>();

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 200));
  }
}

void main() {
  group('迭代 2 工具函数', () {
    test('提及解析：按成员名匹配 @，偏移量正确', () {
      const users = [CosUser(userId: 'ou_zhang', name: '张晓明'), CosUser(userId: 'ou_li', name: '李同学')];
      final t = CosRichText.parse('请 @张晓明 和 @李同学 看一下', users);
      expect(t.mentions.map((m) => m.userId), ['ou_zhang', 'ou_li']);
      expect(t.text.substring(t.mentions[0].offset, t.mentions[0].offset + t.mentions[0].length), '@张晓明');
    });

    test('行级对比：增删行统计', () {
      final d = diffLines('a\nb\nc', 'a\nc\nd');
      final st = diffStat(d);
      expect(st.added, 1);
      expect(st.removed, 1);
    });

    test('awareness 编解码往返（lib0 格式）', () {
      final bytes = encodeAwarenessMessage([
        const AwarenessEntry(42, 3, {'user_id': 'ou_admin', 'name': '王老师', 'cursor': {'line': 5}}),
      ]);
      final m = decodeAwarenessMessage(bytes);
      expect(m, isNotNull);
      expect(m!.single.clientId, 42);
      expect(m.single.clock, 3);
      expect(m.single.state!['user_id'], 'ou_admin');
      // 离线（state = null）
      final off = decodeAwarenessMessage(encodeAwarenessMessage([const AwarenessEntry(42, 4, null)]))!;
      expect(off.single.state, isNull);
    });
  });

  group('迭代 2 接口契约', () {
    test('文档评论：引用 + 锚点 + 提及', () async {
      final (api, reqs) = recorder((_) => {'comment_id': 'c1', 'replies': []});
      await api.createComment('doc_1', const CosRichText('@张 看看', [CosMention('ou_zhang', '张', 0, 2)]),
          quote: '成功率', anchor: {'offset': 3, 'length': 3});
      expect(reqs.single.url.path, '/api/v1/docs/doc_1/comments');
      final b = body(reqs.single);
      expect(b['quote'], '成功率');
      expect(b['anchor'], {'offset': 3, 'length': 3});
      expect((b['content'] as Map)['mentions'], [{'user_id': 'ou_zhang', 'name': '张', 'offset': 0, 'length': 2}]);
    });

    test('知识库移动节点：space_id + parent_id + after_node_id', () async {
      final (api, reqs) = recorder((_) => {'node_id': 'n1', 'space_id': 's2', 'title': 'x'});
      await api.moveNode('n1', spaceId: 's2', parentId: null, afterNodeId: 'n9');
      expect(reqs.single.method, 'POST');
      expect(reqs.single.url.path, '/api/v1/wiki/nodes/n1/move');
      expect(body(reqs.single), {'space_id': 's2', 'parent_id': null, 'after_node_id': 'n9'});
    });

    test('表权限：visibility + members', () async {
      final (api, reqs) = recorder((_) => {'visibility': 'members', 'members': []});
      await api.saveTablePermissions(
          'projects', const CosSharing(linkShare: 'members', members: [CosMember('user', 'ou_demo', 'editor')]));
      expect(reqs.single.method, 'PUT');
      final b = body(reqs.single);
      expect(b['visibility'], 'members');
      expect((b['members'] as List).single, containsPair('role', 'editor'));
    });

    test('知识库搜索：scope=wiki + space_id', () async {
      final (api, reqs) = recorder((_) => {'items': []});
      await api.searchWiki('标定', spaceId: 'wks_lab');
      expect(reqs.single.url.queryParameters, {'scope': 'wiki', 'space_id': 'wks_lab', 'q': '标定'});
    });
  });

  group('界面（测试数据模式）', () {
    late MockBackend mock;
    late AppState state;

    Future<void> boot(WidgetTester tester, Widget child, {AppModule module = AppModule.docs}) async {
      tester.view.physicalSize = const Size(1500, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      mock = MockBackend();
      final api = CosApiClient(kMockBaseUrl, client: mock.client);
      await tester.runAsync(() async {
        final me = await api.login('admin', 'x');
        state = AppState(api: api, me: me, onLogout: () {});
        mock.onEvent = (e) => state.injectEvent(CosEvent.fromJson(e));
        await state.init(realtime: false);
        state.module = module;
      });
      await tester.pumpWidget(MaterialApp(
        theme: buildFsTheme(),
        home: AppScope(state: state, child: Scaffold(body: child)),
      ));
      await settle(tester);
    }

    testWidgets('云文档：左栏分类、收藏列表、回收站恢复', (tester) async {
      await boot(tester, const DocsPage());
      expect(find.text('我的空间'), findsWidgets);
      await tester.tap(find.text('收藏').first);
      await settle(tester);
      expect(find.text('论文阅读笔记：Diffusion Policy'), findsWidgets);
      await tester.tap(find.text('回收站').first);
      await settle(tester);
      expect(find.text('旧版器材清单'), findsWidgets);
      await tester.tap(find.byTooltip('恢复'));
      await settle(tester);
      expect(mock.docs.docs['doc_4']!['deleted_at'], isNull);
    });

    testWidgets('打开文档：评论数角标、分享按钮', (tester) async {
      await boot(tester, const DocsPage());
      // 主页（最近访问）里就有组会纪要
      await tester.tap(find.text('组会纪要 10-17').first);
      await settle(tester);
      expect(find.widgetWithText(FilledButton, '分享'), findsOneWidget);
      expect(find.byTooltip('评论'), findsOneWidget);
      expect(find.byTooltip('历史记录'), findsOneWidget);
    });

    testWidgets('知识库：空间卡片 → 目录树 → 打开页面显示面包屑', (tester) async {
      await boot(tester, const WikiPage(), module: AppModule.wiki);
      expect(find.text('全部知识空间 · 3'), findsOneWidget);
      expect(find.text('新人指南'), findsWidgets);
      await tester.tap(find.text('实验室技术沉淀：设备、流程、论文'));
      await settle(tester);
      expect(find.text('设备手册'), findsOneWidget);
      expect(find.text('机械臂标定流程'), findsNothing); // 子页面懒加载，未展开
      await tester.tap(find.text('设备手册'));
      await settle(tester);
      // 面包屑：空间名 > 页面
      expect(find.text('Lab 知识库'), findsWidgets);
      expect(find.text('设备手册'), findsWidgets);
      await tester.tap(find.byIcon(Icons.chevron_right_rounded).first);
      await settle(tester);
      expect(find.text('机械臂标定流程'), findsOneWidget);
    });

    testWidgets('知识库：成员角色为 viewer 时空间不可编辑', (tester) async {
      await boot(tester, const WikiPage(), module: AppModule.wiki);
      mock.docs.spaceMembers['wks_new']!['members'] = [
        {'member_type': 'user', 'member_id': 'ou_admin', 'role': 'viewer'},
      ];
      await tester.runAsync(() async {
        final sp = await state.api.getSpace('wks_new');
        expect(sp.myRole, 'viewer');
        expect(sp.canEdit, isFalse);
      });
    });

    testWidgets('表管理与记录动态：改名、复制、评论、修改记录（模拟后端）', (tester) async {
      await boot(tester, const SizedBox());
      await tester.runAsync(() async {
        final api = state.api;
        final r = await api.updateTable('projects', name: '项目总表', description: '全部项目');
        expect(r.name, '项目总表');
        final copy = await api.copyTable('projects', name: '项目总表 副本');
        expect(copy.key, isNot('projects'));
        await api.deleteTable(copy.key);
        expect((await api.listTables()).any((t) => t.key == copy.key), isFalse);
        await api.updateRecord('projects', 'rec_p0', {'progress': 95});
        final h = await api.recordHistory('projects', 'rec_p0');
        expect(h.first.changes.any((c) => c.fieldName == 'progress'), isTrue);
        await api.addRecordComment('projects', 'rec_p0', const CosRichText('进度已更新'));
        expect((await api.recordComments('projects', 'rec_p0')).last.content.text, '进度已更新');
      });
    });

    testWidgets('通知跳到知识库页面：自动打开对应空间', (tester) async {
      await boot(tester, const WikiPage(), module: AppModule.wiki);
      final nodeId = mock.docs.nodes.values.firstWhere((n) => n['title'] == 'RealSense 相机')['node_id'] as String;
      state.openTarget({'type': 'wiki', 'id': nodeId});
      await settle(tester);
      expect(find.text('RealSense 相机'), findsWidgets);
      expect(find.text('设备手册'), findsWidgets); // 祖先展开 + 面包屑
    });
  });
}
