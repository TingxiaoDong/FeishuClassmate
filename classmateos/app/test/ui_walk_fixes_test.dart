import 'package:classmateos_app/api/phase2_docs.dart';
import 'package:classmateos_app/pages/wiki_page.dart';
import 'package:classmateos_app/pages/wiki_tree.dart';
// 连真实后端逐页点（2026-10-20 晚）发现的问题的回归测试。
import 'package:classmateos_app/api/phase2_im.dart';
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/pages/messages_page.dart';
import 'package:classmateos_app/pages/shell.dart';
import 'package:classmateos_app/theme.dart';
import 'package:classmateos_app/widgets/doc_editor.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> settle(WidgetTester tester, [int n = 8]) async {
  for (var i = 0; i < n; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 200));
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  late MockBackend mock;
  late AppState state;

  Future<void> boot(WidgetTester tester, Size size) async {
    tester.view.physicalSize = size;
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
    await tester.pumpWidget(MaterialApp(theme: buildFsTheme(), home: AppScope(state: state, child: const HomeShell())));
    await settle(tester);
  }

  testWidgets('手机：在会话页里被加急也能看到横幅，「查看」打开被加急的会话', (tester) async {
    await boot(tester, const Size(400, 800));
    state.go(AppModule.messages);
    await settle(tester);
    // 进入「具身智能实验室」群
    state.openChat('oc_lab');
    await settle(tester);
    expect(find.byType(ChatView), findsOneWidget);
    // 李同学在单聊里加急了一条消息
    final mid = mock.im.messages['oc_demo']!.first['message_id'] as String;
    mock.im.urgentFrom('ou_demo', mid, ['ou_admin']);
    await settle(tester);
    expect(find.textContaining('李同学 加急了一条消息'), findsWidgets, reason: '推入的会话页顶部也要有横幅');
    await tester.tap(find.text('查看').first);
    await settle(tester, 12);
    final chat = tester.widget<ChatView>(find.byType(ChatView));
    expect(chat.chatId, 'oc_demo', reason: '回到首页后推入被加急的会话');
    expect(state.currentChatId, 'oc_demo');
    // 返回会话列表后不再算「正在看」
    Navigator.of(tester.element(find.byType(ChatView))).pop();
    await settle(tester);
    expect(state.currentChatId, isNull);
    expect(find.byType(ChatView), findsNothing);
  });

  testWidgets('手机：点会话列表打开会话，返回后清掉「正在看」', (tester) async {
    await boot(tester, const Size(400, 800));
    state.go(AppModule.messages);
    await settle(tester);
    await tester.tap(find.text('李同学').first);
    await settle(tester);
    expect(tester.widget<ChatView>(find.byType(ChatView)).chatId, 'oc_demo');
    Navigator.of(tester.element(find.byType(ChatView))).pop();
    await settle(tester);
    expect(state.currentChatId, isNull);
    expect(find.byType(ChatView), findsNothing);
  });

  testWidgets('自己的消息加了表情后，正文和读屏文字都还在', (tester) async {
    await boot(tester, const Size(1400, 900));
    final sem = tester.ensureSemantics();
    state.openChat('oc_demo');
    await settle(tester);
    final mine = mock.im.messages['oc_demo']!.lastWhere((m) => m['sender_id'] == 'ou_admin');
    final text = (mine['content'] as Map)['text'] as String;
    await tester.runAsync(() async {
      mock.currentUser = 'ou_demo';
      await state.api.addReaction(mine['message_id'] as String, 'THUMBSUP');
      mock.currentUser = 'ou_admin';
    });
    await settle(tester);
    expect(find.textContaining('👍 1'), findsOneWidget);
    expect(find.descendant(of: find.byType(ChatView), matching: find.text(text)), findsOneWidget, reason: '正文还在');
    expect(find.bySemanticsLabel(RegExp(RegExp.escape(text))), findsWidgets, reason: '读屏能读到正文');
    sem.dispose();
  });

  testWidgets('手机：云文档里点开一篇，地址变成这篇文档，返回后回到 /docs', (tester) async {
    await boot(tester, const Size(400, 800));
    state.go(AppModule.docs);
    await settle(tester);
    expect(state.currentPath, '/docs');
    final title = mock.docs.docs['doc_1']!['title'] as String;
    await tester.tap(find.text(title).first);
    await settle(tester, 10);
    expect(state.currentPath, '/docs/doc_1');
    Navigator.of(tester.element(find.byType(DocEditor))).pop();
    await settle(tester);
    expect(state.currentPath, '/docs');
  });
  for (final width in [400.0, 1400.0]) {
    testWidgets('知识库：宽度 $width 新建页面写入并打开编辑器', (tester) async {
      await boot(tester, Size(width, 900));
      late CosWikiSpace space;
      await tester.runAsync(() async {
        space = await state.api.createSpace({'name': '新建回归空间'});
      });
      await tester.pumpWidget(MaterialApp(theme: buildFsTheme(), home: AppScope(
        state: state,
        child: Scaffold(body: SpaceView(space: space, onBack: () {},
          onSpaceChanged: (_) {}, onSpaceDeleted: () {})),
      )));
      await settle(tester);
      expect(find.byType(WikiTree), width < 860 ? findsNothing : findsOneWidget);
      final button = find.widgetWithText(FilledButton, '新建页面');
      expect(button, findsOneWidget);
      await tester.tap(button);
      await settle(tester, 15);
      expect(tester.takeException(), isNull);
      expect(find.byType(DocEditor), findsOneWidget);
      await tester.runAsync(() async {
        final nodes = await state.api.listNodes(space.spaceId);
        expect(nodes, hasLength(1));
        expect(nodes.single.title, '未命名页面');
      });
      await tester.pumpWidget(const SizedBox.shrink());
      state.dispose();
    });
  }

}
