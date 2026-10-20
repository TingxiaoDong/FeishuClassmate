// 联调测试报告 2026-10-20 · 问题 3：新建文档默认仅自己可见，文档顶栏要直接显示可见范围。
import 'package:classmateos_app/api/phase2_docs.dart';
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/theme.dart';
import 'package:classmateos_app/widgets/doc_editor.dart';
import 'package:classmateos_app/widgets/share_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'phase2_test.dart' show settle;

void main() {
  group('可见范围文字', () {
    const me = 'ou_me';
    test('链接分享关闭', () {
      expect(docVisibilityText(const CosSharing(ownerId: me), me), '仅自己可见');
      expect(docVisibilityText(const CosSharing(ownerId: me, members: [CosMember('user', me, 'editor')]), me), '仅自己可见');
      expect(docVisibilityText(const CosSharing(ownerId: me, members: [CosMember('user', 'ou_li', 'viewer')]), me), '仅 2 人可见');
      expect(docVisibilityText(const CosSharing(ownerId: 'ou_zhang', members: [CosMember('user', me, 'viewer')]), me), '仅 2 人可见',
          reason: '别人分享给我的文档不能显示「仅自己可见」');
      expect(docVisibilityText(const CosSharing(ownerId: me, members: [CosMember('department', 'd1', 'viewer')]), me), '仅指定成员可见');
    });

    test('组织内链接分享、知识库继承', () {
      expect(docVisibilityText(const CosSharing(ownerId: me, linkShare: 'org_view'), me), '组织内可阅读');
      expect(docVisibilityText(const CosSharing(ownerId: me, linkShare: 'org_edit'), me), '组织内可编辑');
      expect(docVisibilityText(const CosSharing(inheritedSpaceId: 's1', inheritedSpaceName: '实验室手册'), me), '跟随知识库「实验室手册」');
    });
  });

  group('文档顶栏（测试数据模式）', () {
    late MockBackend mock;
    late AppState state;

    Future<void> open(WidgetTester tester, String docId) async {
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
      });
      await tester.pumpWidget(MaterialApp(theme: buildFsTheme(), home: AppScope(state: state, child: Scaffold(body: DocEditor(docId: docId)))));
      await settle(tester);
    }

    testWidgets('自己的私有文档显示「仅自己可见」', (tester) async {
      await open(tester, 'doc_1');
      expect(find.byKey(const ValueKey('doc-visibility')), findsOneWidget);
      expect(find.text('仅自己可见'), findsOneWidget);
    });

    testWidgets('组织内可阅读的文档', (tester) async {
      await open(tester, 'doc_3');
      expect(find.text('组织内可阅读'), findsOneWidget);
    });

    testWidgets('新建的文档默认仅自己可见', (tester) async {
      late String id;
      await tester.runAsync(() async {
        final m = MockBackend();
        final api = CosApiClient(kMockBaseUrl, client: m.client);
        await api.login('admin', 'x');
        id = (await api.createDoc('新文档', '# 新文档')).docId;
        mock = m;
        state = AppState(api: api, me: await api.me(), onLogout: () {});
        await state.init(realtime: false);
      });
      tester.view.physicalSize = const Size(1500, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(theme: buildFsTheme(), home: AppScope(state: state, child: Scaffold(body: DocEditor(docId: id)))));
      await settle(tester);
      expect(find.text('仅自己可见'), findsOneWidget);
    });
  });
}
