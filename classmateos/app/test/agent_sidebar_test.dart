// AI 助手侧栏 / 结果卡片的离线界面测试（不连后端）。
// 回归：侧栏是挂在 Navigator 覆盖层上的弹层，不在 AppScope 子树里，曾经一打开就报错。
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/widgets/agent_sidebar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _frames(WidgetTester t, [int n = 10]) async {
  for (var i = 0; i < n; i++) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  late AppState s;
  setUp(() {
    s = AppState(api: CosApiClient('http://127.0.0.1:9/api/v1'), me: CosUser.fromJson({'user_id': 'u1', 'name': '甲'}), onLogout: () {});
  });

  Widget host(Widget child) => MaterialApp(home: AppScope(state: s, child: Scaffold(body: Center(child: child))));

  testWidgets('从页面打开侧栏：能拿到 AppState，显示当前对象和选中字数', (t) async {
    t.view.physicalSize = const Size(1400, 900);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(host(Builder(
      builder: (ctx) => TextButton(
        onPressed: () => showAgentSidebar(ctx, const AgentContext(kind: 'table', id: 'tbl_1', title: '设备表', selection: '两行')),
        child: const Text('打开'),
      ),
    )));
    await t.tap(find.text('打开'));
    await _frames(t);
    expect(t.takeException(), isNull);
    expect(find.text('当前多维表格：设备表'), findsOneWidget);
    expect(find.text('已选中 2 字'), findsOneWidget);
    expect(find.text('总结这张表的数据'), findsOneWidget);
    await t.tap(find.byTooltip('关闭'));
    await _frames(t);
    expect(find.text('当前多维表格：设备表'), findsNothing);
  });

  testWidgets('结果卡片：显示对象和步骤，点对象切到对应模块', (t) async {
    final m = CosMessage.fromJson({
      'message_id': 'm1',
      'chat_id': 'c1',
      'sender_id': 'bot',
      'msg_type': 'text',
      'content': {
        'text': '好了',
        'agent_result': {
          'links': [
            {'link': 'cos://table/tbl_9', 'summary': '新建的设备表'},
          ],
          'steps': [
            {'label': '建表', 'ok': true},
            {'label': '发通知', 'ok': false},
          ],
        },
      },
      'create_time': DateTime.now().toIso8601String(),
    });
    await t.pumpWidget(host(SizedBox(width: 360, child: AgentResultCard.maybe(m))));
    expect(t.takeException(), isNull);
    expect(find.text('这次处理了 1 个对象'), findsOneWidget);
    expect(find.text('1 步没完成'), findsOneWidget);
    await t.tap(find.text('查看步骤'));
    await _frames(t);
    expect(find.text('发通知'), findsOneWidget);
    await t.tap(find.text('新建的设备表'));
    await _frames(t);
    expect(s.module, AppModule.bitable);
  });

  testWidgets('没有 agent_result 或链接不是 cos:// 时不出卡片', (t) async {
    final plain = CosMessage.fromJson({'message_id': 'm2', 'chat_id': 'c1', 'sender_id': 'bot', 'msg_type': 'text', 'content': {'text': 'hi'}});
    await t.pumpWidget(host(AgentResultCard.maybe(plain)));
    expect(find.byType(AgentResultCard), findsNothing);
    expect(AgentResultCard.targetOf({'link': 'https://x/y'}), isNull);
    expect(AgentResultCard.targetOf({'link': 'cos://doc/d1'}), {'type': 'doc', 'id': 'd1'});
  });
}
