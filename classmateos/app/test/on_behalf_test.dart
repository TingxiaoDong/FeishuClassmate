// 联调测试报告 2026-10-20 · 问题 2：AI 代发消息（content.sent_on_behalf_of）前端要显示「谁让发的」。
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/pages/chat_extras.dart';
import 'package:classmateos_app/pages/shell.dart';
import 'package:classmateos_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'phase2_test.dart' show settle;

CosMessage _msg(Map<String, dynamic> content) => CosMessage.fromJson({
      'message_id': 'om_1',
      'chat_id': 'oc_1',
      'sender_id': 'bot',
      'msg_type': 'text',
      'content': content,
    });

void main() {
  group('模型解析', () {
    test('有代发标记时解析出代发人', () {
      final o = _msg({'text': 'hi', 'sent_on_behalf_of': {'user_id': 'ou_zhang', 'name': '张晓明'}}).onBehalfOf;
      expect(o?.userId, 'ou_zhang');
      expect(o?.name, '张晓明');
    });

    test('没有标记、标记格式不对时为 null（旧后端兼容）', () {
      expect(_msg({'text': 'hi'}).onBehalfOf, isNull);
      expect(_msg({'text': 'hi', 'sent_on_behalf_of': 'ou_zhang'}).onBehalfOf, isNull);
      expect(_msg({'text': 'hi', 'sent_on_behalf_of': {'name': '张晓明'}}).onBehalfOf, isNull);
    });
  });

  group('界面（测试数据模式）', () {
    late MockBackend mock;
    late AppState state;

    Future<void> boot(WidgetTester tester) async {
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
        state.openChat('oc_lab');
      });
      await tester.pumpWidget(MaterialApp(theme: buildFsTheme(), home: AppScope(state: state, child: const Scaffold(body: HomeShell()))));
      await settle(tester);
    }

    testWidgets('群里显示「某某 通过 AI 助手发送」，代不同的人发的连续消息不合并', (tester) async {
      await boot(tester);
      await tester.runAsync(() async {
        mock.im.send('oc_lab', 'bot', 'text', {'text': '提醒：周四组会带上实验数据', 'sent_on_behalf_of': {'user_id': 'ou_zhang', 'name': '张三'}});
        mock.im.send('oc_lab', 'bot', 'text', {'text': '提醒：别忘了交周报', 'sent_on_behalf_of': {'user_id': 'ou_chen', 'name': '陈雨'}});
        mock.im.send('oc_lab', 'bot', 'text', {'text': '我是自己让 AI 发的', 'sent_on_behalf_of': {'user_id': state.me.userId, 'name': state.me.name}});
      });
      await settle(tester);
      expect(find.text('提醒：周四组会带上实验数据'), findsOneWidget);
      expect(find.text('张三 通过 AI 助手发送'), findsOneWidget);
      expect(find.text('陈雨 通过 AI 助手发送'), findsOneWidget, reason: '紧跟着的第二条代发人不同，不能被合并掉头部');
      expect(find.text('你 通过 AI 助手发送'), findsOneWidget);
      // 会话列表预览带上代发人
      final last = state.lastMessage['oc_lab']!;
      expect(onBehalfLabel(state, last.onBehalfOf!), '你 通过 AI 助手发送');
      expect(find.textContaining('（代你）：我是自己让 AI 发的'), findsWidgets);
    });

    testWidgets('机器人自己发的消息不显示代发标记', (tester) async {
      await boot(tester);
      await tester.runAsync(() async {
        mock.im.send('oc_lab', 'bot', 'text', {'text': '每日提醒：记得打卡'});
      });
      await settle(tester);
      expect(find.text('每日提醒：记得打卡'), findsOneWidget);
      expect(find.textContaining('通过 AI 助手发送'), findsNothing);
    });
  });
}
