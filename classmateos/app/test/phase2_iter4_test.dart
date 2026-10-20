import 'dart:convert';

import 'package:classmateos_app/api/phase2_im.dart';
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/pages/global_search.dart';
import 'package:classmateos_app/pages/messages_page.dart';
import 'package:classmateos_app/pages/shell.dart';
import 'package:classmateos_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

(CosApiClient, List<http.Request>) recorder(Object? Function(http.Request) reply) {
  final reqs = <http.Request>[];
  final c = MockClient((r) async {
    reqs.add(r);
    return http.Response.bytes(utf8.encode(jsonEncode(reply(r) ?? {})), 200, headers: {'content-type': 'application/json'});
  });
  return (CosApiClient('http://x/api/v1', accessToken: 't', client: c), reqs);
}

Map<String, dynamic> body(http.Request r) => (jsonDecode(r.body) as Map).cast<String, dynamic>();

Future<void> settle(WidgetTester tester, [int n = 8]) async {
  for (var i = 0; i < n; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 200));
  }
}

const _msg = {'message_id': 'om_1', 'chat_id': 'oc_1', 'sender_id': 'ou_admin', 'msg_type': 'text', 'content': {'text': 'hi'}};

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('迭代 4 消息接口契约', () {
    test('消息新字段解析；旧后端缺字段时取默认值', () {
      final m = CosMessage.fromJson({
        ..._msg,
        'read_count': 2,
        'member_count': 3,
        'thread_root_id': 'om_0',
        'also_send_to_chat': true,
        'thread': {'reply_count': 4, 'participants': ['ou_demo'], 'followed': true, 'last_reply_at': '2026-10-20T01:00:00Z'},
        'reactions': [{'emoji': 'THUMBSUP', 'count': 2, 'user_ids': ['ou_demo', 'ou_admin'], 'reacted_by_me': true}],
        'forwarded_from': {'chat_name': '实验室', 'sender_id': 'ou_demo'},
        'urgent': {'user_ids': ['ou_demo', 'ou_chen'], 'ack_user_ids': ['ou_demo']},
      });
      expect([m.readCount, m.memberCount, m.threadRootId, m.alsoSendToChat], [2, 3, 'om_0', true]);
      expect([m.thread!.replyCount, m.thread!.followed], [4, true]);
      expect([m.reactions.single.emoji, m.reactions.single.count, m.reactions.single.reactedByMe], ['THUMBSUP', 2, true]);
      expect(m.urgentUnacked, 1, reason: 'ou_chen 还没确认');
      final old = CosMessage.fromJson(_msg);
      expect([old.readCount, old.thread, old.reactions.length, old.threadRootId], [null, null, 0, null]);
    });

    test('话题：发送带 thread_root_id / also_send_to_chat，回复列表、关注、话题模式', () async {
      final (api, reqs) = recorder((r) => r.url.path.endsWith('/thread') ? {'items': [_msg], 'has_more': false} : _msg);
      await api.sendText('oc_1', '回复', threadRootId: 'om_0', alsoSendToChat: true);
      expect(body(reqs.last)['thread_root_id'], 'om_0');
      expect(body(reqs.last)['also_send_to_chat'], true);
      await api.sendText('oc_1', '普通');
      expect(body(reqs.last).containsKey('thread_root_id'), isFalse, reason: '普通消息不带话题字段');
      expect((await api.allThreadReplies('om_0')).length, 1);
      expect(reqs.last.url.path, '/api/v1/messages/om_0/thread');
      await api.followThread('om_0', false);
      expect([reqs.last.method, reqs.last.url.path], ['DELETE', '/api/v1/messages/om_0/thread/follow']);
      await api.setThreadMode('oc_1', true);
      expect([reqs.last.method, body(reqs.last)], ['PATCH', {'thread_mode': true}]);
    });

    test('话题回复分页：游标重复时报错，不死循环', () async {
      final (api, _) = recorder((r) => {'items': [_msg], 'has_more': true, 'page_token': 'p1'});
      await expectLater(api.allThreadReplies('om_0'), throwsStateError);
    });

    test('表情、已读名单、转发、加急的请求格式', () async {
      final (api, reqs) = recorder((r) {
        if (r.url.path.endsWith('/read-users')) return {'read': ['ou_demo'], 'unread': ['ou_chen']};
        if (r.url.path.endsWith('/forward')) return {'items': [_msg]};
        if (r.url.path.endsWith('/pending')) return {'items': [{'message_id': 'om_1', 'chat_id': 'oc_1', 'from_user_id': 'ou_demo'}]};
        return _msg;
      });
      await api.addReaction('om_1', 'THUMBSUP');
      expect([reqs.last.method, reqs.last.url.path, body(reqs.last)], ['POST', '/api/v1/messages/om_1/reactions', {'emoji': 'THUMBSUP'}]);
      await api.removeReaction('om_1', 'THUMBSUP');
      expect([reqs.last.method, reqs.last.url.path], ['DELETE', '/api/v1/messages/om_1/reactions/THUMBSUP']);
      final ru = await api.readUsers('om_1');
      expect([ru.read, ru.unread], [['ou_demo'], ['ou_chen']]);
      await api.forwardMessages(messageIds: ['om_1', 'om_2'], chatIds: ['oc_2'], mode: 'merge', note: ' 看看 ');
      final f = body(reqs.last);
      expect([f['message_ids'], f['chat_ids'], f['mode'], f['note']], [['om_1', 'om_2'], ['oc_2'], 'merge', '看看']);
      expect(f['client_request_id'], isNotEmpty);
      await api.urgentMessage('om_1', ['ou_chen']);
      expect(body(reqs.last), {'user_ids': ['ou_chen'], 'type': 'app'});
      await api.ackUrgent('om_1');
      expect(reqs.last.url.path, '/api/v1/messages/om_1/urgent/ack');
      expect((await api.pendingUrgents()).single.fromUserId, 'ou_demo');
    });

    test('全局搜索：参数、分组解析、跳转目标', () async {
      final (api, reqs) = recorder((r) => {
            'groups': [
              {'type': 'message', 'total': 5, 'page_token': '3', 'items': [{'id': 'om_9', 'title': '<em>标定</em>', 'extra': {'chat_id': 'oc_1'}}]},
              {'type': 'event', 'items': [{'id': 'ev_1', 'title': '组会', 'extra': {'start_ms': 1}}]},
            ],
          });
      final g = await api.search('标定', types: ['message'], pageSize: 20, filters: {'chat_id': 'oc_1', 'sender_id': 'ou_demo'});
      final q = reqs.last.url.queryParameters;
      expect([q['q'], q['types'], q['page_size'], q['chat_id'], q['sender_id']], ['标定', 'message', '20', 'oc_1', 'ou_demo']);
      expect([g[0].total, g[0].hasMore, g[1].total], [5, true, 1]);
      expect(g[0].items.single.target, {'type': 'message', 'id': 'oc_1', 'message_id': 'om_9'});
      expect(g[1].items.single.target, {'type': 'calendar', 'id': 'ev_1', 'start_ms': 1});
    });

    test('高亮只认 <em>，其他标签原样当文字', () {
      final spans = highlightSpans('找<em>标定</em>流程<b>x</b>');
      expect(spans.map((s) => s.text).toList(), ['找', '标定', '流程<b>x</b>']);
      expect(spans[1].style?.color, Fs.primary);
      expect(stripEm('<em>a</em>b'), 'ab');
    });

    test('最近搜索最多 20 条，重复的提到最前', () async {
      for (var i = 0; i < 25; i++) {
        await saveRecentSearch('词$i');
      }
      final l = await saveRecentSearch('词10');
      expect(l.length, kMaxRecentSearches);
      expect(l.first, '词10');
      expect(l.where((x) => x == '词10').length, 1);
    });

    test('模拟后端分词：连续中文按两字切', () {
      expect(MockBackend.searchTerms('标定流程'), ['标定', '流程']);
      expect(MockBackend.searchTerms('ICRA 投稿'), ['icra', '投稿']);
      expect(MockBackend.searchTerms('抓取实验'), ['抓取', '实验']);
    });
  });

  group('消息与搜索界面（测试数据模式）', () {
    late MockBackend mock;
    late AppState state;

    Future<void> boot(WidgetTester tester, {Set<String> off = const {}, String? chat}) async {
      tester.view.physicalSize = const Size(1500, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      mock = MockBackend();
      for (final k in off) {
        mock.features[k] = false;
      }
      final api = CosApiClient(kMockBaseUrl, client: mock.client);
      await tester.runAsync(() async {
        final me = await api.login('admin', 'x');
        state = AppState(api: api, me: me, onLogout: () {});
        mock.onEvent = (e) => state.injectEvent(CosEvent.fromJson(e));
        await state.init(realtime: false);
        if (chat != null) state.openChat(chat);
      });
      await tester.pumpWidget(MaterialApp(theme: buildFsTheme(), home: AppScope(state: state, child: const HomeShell())));
      await settle(tester);
    }

    testWidgets('表情回应显示在气泡下，点一下取消自己的', (tester) async {
      await boot(tester, chat: 'oc_lab');
      expect(find.textContaining('👍 2'), findsOneWidget);
      // 王老师加一个 👍
      await tester.runAsync(() => state.api.addReaction(mock.im.messages['oc_lab']!.first['message_id'] as String, 'THUMBSUP'));
      await settle(tester);
      expect(find.textContaining('👍 3'), findsOneWidget);
      await tester.tap(find.textContaining('👍 3'));
      await settle(tester);
      expect(find.textContaining('👍 2'), findsOneWidget);
      expect(mock.requests.any((r) => r.method == 'DELETE' && r.url.path.contains('/reactions/THUMBSUP')), isTrue);
    });

    testWidgets('话题：主会话只显示摘要，点开右侧面板回复，不进主会话', (tester) async {
      await boot(tester, chat: 'oc_lab');
      expect(find.text('滑落那部分可以试试加触觉反馈'), findsNothing, reason: '话题回复不出现在主会话');
      expect(find.textContaining('2 条回复'), findsOneWidget);
      await tester.tap(find.textContaining('2 条回复'));
      await settle(tester);
      expect(find.text('滑落那部分可以试试加触觉反馈'), findsOneWidget);
      final input = find.descendant(of: find.byType(ThreadView), matching: find.byType(TextField));
      await tester.enterText(input.last, '我来接触觉手套');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await settle(tester);
      final sent = mock.im.messages['oc_lab']!.where((m) => (m['content'] as Map)['text'] == '我来接触觉手套').toList();
      expect(sent, hasLength(1));
      expect(sent.single['thread_root_id'], isNotNull);
      expect(find.textContaining('3 条回复'), findsWidgets, reason: '话题摘要跟着更新');
    });

    testWidgets('已读回执：别人读了之后从后端重新取计数', (tester) async {
      await boot(tester, chat: 'oc_lab');
      // 王老师最后一条「好的，标定流程…」：3 个其他成员都只读到倒数第二条
      expect(find.byTooltip('0 人已读，3 人未读'), findsOneWidget);
      mock.im.readBy('ou_demo', 'oc_lab');
      await settle(tester, 10);
      expect(find.byTooltip('1 人已读，2 人未读'), findsOneWidget);
      mock.im.readBy('ou_zhang', 'oc_lab');
      mock.im.readBy('ou_chen', 'oc_lab');
      await settle(tester, 10);
      expect(find.byTooltip('全部已读'), findsWidgets);
    });

    testWidgets('被加急：顶部红色横幅，点「知道了」确认并消失', (tester) async {
      await boot(tester);
      final mid = mock.im.messages['oc_demo']!.first['message_id'] as String;
      mock.im.urgentFrom('ou_demo', mid, ['ou_admin']);
      await settle(tester);
      expect(find.textContaining('李同学 加急了一条消息'), findsOneWidget);
      await tester.tap(find.text('知道了'));
      await settle(tester);
      expect(find.textContaining('加急了一条消息'), findsNothing);
      expect(mock.requests.any((r) => r.url.path.endsWith('/messages/$mid/urgent/ack')), isTrue);
    });

    testWidgets('⌘K 打开全局搜索：分组、高亮、回车跳到消息', (tester) async {
      await boot(tester);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await settle(tester, 3);
      expect(find.byType(GlobalSearchPanel), findsOneWidget);
      expect(find.text('最近访问'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('global-search-input')), '触觉');
      await tester.pump(const Duration(milliseconds: 350));
      await settle(tester);
      expect(find.text('消息'), findsWidgets);
      final hits = find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().contains('触觉'));
      expect(hits, findsWidgets);
      // 回车打开第一条（消息「…触觉反馈」所在会话）
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await settle(tester);
      expect(find.byType(GlobalSearchPanel), findsNothing);
      expect(state.module, AppModule.messages);
      expect(state.currentChatId, 'oc_lab');
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getStringList('cos_recent_searches'), ['触觉']);
      await tester.pump(const Duration(seconds: 4)); // 等高亮消失
    });

    testWidgets('搜索按类型筛选：只看云文档时带 types=doc', (tester) async {
      await boot(tester);
      await tester.runAsync(() async {});
      await tester.tap(find.byTooltip('搜索（⌘K / Ctrl+K）'));
      await settle(tester, 3);
      await tester.tap(find.byKey(const ValueKey('search-tab-doc')));
      await tester.enterText(find.byKey(const ValueKey('global-search-input')), '组会');
      await tester.pump(const Duration(milliseconds: 350));
      await settle(tester);
      final r = mock.requests.lastWhere((r) => r.url.path.endsWith('/search'));
      expect(r.url.queryParameters['types'], 'doc');
      expect(r.url.queryParameters['page_size'], '20');
    });

    testWidgets('开关关闭时：没有搜索按钮、没有表情条，一期消息照常', (tester) async {
      await boot(tester, off: {'search', 'message.reaction', 'message.thread', 'message.urgent', 'message.forward'}, chat: 'oc_lab');
      expect(find.byTooltip('搜索（⌘K / Ctrl+K）'), findsNothing);
      expect(find.text('这周组会改到周四下午两点，大家注意一下'), findsOneWidget);
      expect(find.textContaining('👍'), findsNothing);
      expect(find.textContaining('条回复'), findsNothing);
    });
  });
}

