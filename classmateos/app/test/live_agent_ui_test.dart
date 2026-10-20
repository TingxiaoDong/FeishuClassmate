// AI 助手界面实操（AGENT_PLAN M5）：真实后端 + 真实 Bot 网关，按同学的操作顺序点一遍。
// 只在设置了 COS_LIVE_URL 时运行，例如
//   COS_LIVE_URL=http://127.0.0.1:8080 COS_LIVE_BOT_TOKEN=dev-bot-token \
//     flutter test test/live_agent_ui_test.dart
// 需要先启动：pnpm classmateos（内存模式）和 pnpm classmate gateway。
// 没填大模型 Key 时，助手会回复「连不上大模型」的说明——这也算通过（界面链路是通的）；
// 设 COS_LIVE_EXPECT_ANSWER=1 时要求助手给出真正的回答。
@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/widgets/agent_sidebar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

final _url = Platform.environment['COS_LIVE_URL'];
final _botToken = Platform.environment['COS_LIVE_BOT_TOKEN'] ?? 'dev-bot-token';
final _expectAnswer = Platform.environment['COS_LIVE_EXPECT_ANSWER'] == '1';

Future<Map<String, dynamic>> _http(String method, String path, {Map<String, String> headers = const {}, Object? body}) async {
  final c = HttpClient();
  try {
    final r = await c.openUrl(method, Uri.parse('${_url!}/api/v1$path'));
    r.headers.contentType = ContentType.json;
    headers.forEach(r.headers.set);
    if (body != null) r.write(jsonEncode(body));
    final res = await r.close();
    final text = await res.transform(utf8.decoder).join();
    return {'status': res.statusCode, 'body': text.isEmpty ? null : jsonDecode(text)};
  } finally {
    c.close();
  }
}

/// 真实网络要在 runAsync 里等；每 200ms 刷一帧，直到 [done] 为真。
Future<bool> _waitFor(WidgetTester t, bool Function() done, {int seconds = 60}) async {
  for (var i = 0; i < seconds * 5; i++) {
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await t.pump();
    if (done()) return true;
  }
  return false;
}

void main() {
  if (_url == null) {
    test('AI 助手界面实操（未设置 COS_LIVE_URL，跳过）', () {}, skip: true);
    return;
  }
  setUpAll(() {
    HttpOverrides.global = null;
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('文档页 → AI 助手侧栏 → 提问 → 回复 / 结果卡片 → 工作台指标', (t) async {
    t.view.physicalSize = const Size(1400, 900);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);

    late AppState s;
    late String docId;
    await t.runAsync(() async {
      final api = CosApiClient('${_url!}/api/v1');
      final me = await api.login('demo', 'demo');
      s = AppState(api: api, me: me, onLogout: () {});
      await s.init();
      final d = await _http('POST', '/docs', headers: {'authorization': 'Bearer ${api.accessToken}'}, body: {'title': '实操周报'});
      docId = (d['body'] as Map)['doc_id'] as String;
    });
    expect(s.feature('agent.sidebar'), isTrue, reason: '平台应打开 agent.sidebar');

    // 1. 文档工具栏上的「AI 助手」按钮
    await t.pumpWidget(MaterialApp(
      home: AppScope(
        state: s,
        child: Scaffold(
          appBar: AppBar(title: const Text('实操周报'), actions: [
            AgentSidebarButton(contextOf: () => AgentContext(kind: 'doc', id: docId, title: '实操周报', selection: '本周完成了数据清洗')),
          ]),
          body: const SingleChildScrollView(child: AgentMetricsCard()),
        ),
      ),
    ));
    expect(find.byTooltip('AI 助手'), findsOneWidget);

    // 2. 打开侧栏：显示当前文档和选中字数
    await t.tap(find.byTooltip('AI 助手'));
    for (var i = 0; i < 10; i++) {
      await t.pump(const Duration(milliseconds: 50)); // 等侧栏滑入动画走完
    }
    expect(find.text('当前文档：实操周报'), findsOneWidget);
    expect(find.textContaining('已选中'), findsOneWidget);

    // 3. 点快捷问题 → 消息带上下文发出 → 等机器人回复出现在侧栏
    await t.tap(find.text('总结这篇文档'));
    await t.pump();
    bool hasBotReply() => find.byWidgetPredicate((w) => w is SelectableText && w.data != '总结这篇文档').evaluate().isNotEmpty;
    expect(await _waitFor(t, () => find.text('总结这篇文档').evaluate().isNotEmpty && hasBotReply(), seconds: 90), isTrue, reason: '90 秒内侧栏没有出现机器人回复');
    final reply = (find.byWidgetPredicate((w) => w is SelectableText && w.data != '总结这篇文档').evaluate().last.widget as SelectableText).data!;
    // ignore: avoid_print
    print('助手回复：$reply');
    expect(find.text('助手正在处理…'), findsNothing);
    if (_expectAnswer) expect(reply, isNot(contains('连不上大模型')));

    // 平台上这条消息确实带着侧栏上下文
    String? chatId;
    await t.runAsync(() async {
      final chats = await s.api.listChats();
      final p2p = chats.where((c) => c.chatType == 'p2p');
      for (final c in p2p) {
        final ms = (await s.api.listMessages(c.chatId)).items;
        final mine = ms.where((m) =>
            m.senderId == s.me.userId && m.content['agent_context'] is Map && (m.content['agent_context'] as Map)['id'] == docId);
        if (mine.isNotEmpty) {
          chatId = c.chatId;
          expect((mine.first.content['agent_context'] as Map)['selection'], '本周完成了数据清洗');
        }
      }
    });
    expect(chatId, isNotNull, reason: '没找到带 agent_context 的消息');

    // 4. 结果卡片：机器人发来带对象链接的回复 → 侧栏出卡片 → 点对象跳到文档
    await t.runAsync(() => _http('POST', '/bot/messages', headers: {'x-bot-token': _botToken}, body: {
          'receive_id': chatId,
          'receive_id_type': 'chat_id',
          'msg_type': 'text',
          'content': {
            'text': '纪要已建好',
            'agent_result': {
              'links': [{'link': 'cos://doc/$docId', 'summary': '实操周报（已追加总结）'}],
              'steps': [{'label': '读取文档', 'ok': true}, {'label': '追加总结', 'ok': true}],
            },
          },
        }));
    expect(await _waitFor(t, () => find.text('实操周报（已追加总结）').evaluate().isNotEmpty, seconds: 15), isTrue, reason: '结果卡片没出现');
    expect(find.text('这次处理了 1 个对象'), findsOneWidget);
    expect(find.text('2 步全部完成'), findsOneWidget);
    await t.tap(find.text('实操周报（已追加总结）'));
    for (var i = 0; i < 10; i++) {
      await t.pump(const Duration(milliseconds: 50)); // 等侧栏滑出动画走完
    }
    expect(s.module, AppModule.docs, reason: '点结果卡片应切到文档模块');
    expect(find.text('当前文档：实操周报'), findsNothing, reason: '点开对象后侧栏应关闭');

    // 5. 工作台「AI 助手」指标卡片（真实接口）
    expect(await _waitFor(t, () => find.text('AI 助手').evaluate().isNotEmpty && find.textContaining('指标加载失败').evaluate().isEmpty, seconds: 10), isTrue);
    expect(find.textContaining('指标加载失败'), findsNothing);

    // 收尾：卸载界面、断开实时连接，让残留的计时器走完
    await t.pumpWidget(const SizedBox());
    s.dispose();
    await t.pump(const Duration(minutes: 2));
  });
}
