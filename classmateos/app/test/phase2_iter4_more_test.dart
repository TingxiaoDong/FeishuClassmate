import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/pages/message_more.dart';
import 'package:classmateos_app/theme.dart';

void main() {
  test('内部链接只识别当前服务器和专用协议', () {
    expect(parseInternalLink('https://other.test/app/docs/d', 'https://cos.test'), isNull);
    expect(parseInternalLink('mailto:a@b.test', 'https://cos.test'), isNull);
    expect(parseInternalLink('classmateos://tasks/t1', 'https://cos.test')!.target, {'type':'task','id':'t1'});
    expect(parseInternalLink('https://cos.test/app/tables/p/records/r', 'https://cos.test')!.tableKey, 'p');
  });
  test('Markdown 语法检测', () {
    expect(looksLikeMarkdown('**重点**'), isTrue);
    expect(looksLikeMarkdown('- 第一项\n- 第二项'), isTrue);
    expect(looksLikeMarkdown('```dart\nprint(1);\n```'), isTrue);
    expect(looksLikeMarkdown('明天开组会'), isFalse);
  });
  test('收藏新增去重、列表和取消', () async {
    final mock = MockBackend();
    final api = CosApiClient(kMockBaseUrl, client: mock.client);
    await api.login('admin','x');
    final id = mock.im.messages['oc_lab']!.first['message_id'] as String;
    await api.favoriteMessage(id, true);
    await api.favoriteMessage(id, true);
    expect((await api.listFavorites()).items.length, 1);
    await api.favoriteMessage(id, false);
    expect((await api.listFavorites()).items, isEmpty);
  });
  test('Pin 列表、幂等固定和取消', () async {
    final mock = MockBackend();
    final api = CosApiClient(kMockBaseUrl, client: mock.client);
    await api.login('admin','x');
    final id = (await api.listPins('oc_lab')).single.message.messageId;
    await api.pinMessage('oc_lab',id,true);
    expect((await api.listPins('oc_lab')).length, 1);
    await api.pinMessage('oc_lab',id,false);
    expect(await api.listPins('oc_lab'), isEmpty);
  });
  test('富文本正文往返保留 Markdown', () async {
    final mock = MockBackend();
    final api = CosApiClient(kMockBaseUrl, client: mock.client);
    await api.login('admin','x');
    final m = await api.sendMessage('oc_lab','post',{'markdown':'**重点**'});
    expect(m.msgType,'post');
    expect(m.content['markdown'],'**重点**');
  });
  testWidgets('固定条显示、点击打开固定消息列表', (tester) async {
    final mock = MockBackend();
    final api = CosApiClient(kMockBaseUrl, client: mock.client);
    late AppState s;
    await tester.runAsync(() async {
      final me = await api.login('admin','x');
      s = AppState(api:api,me:me,onLogout:(){});
      await s.init(realtime:false);
    });
    await tester.pumpWidget(MaterialApp(theme:buildFsTheme(),home:AppScope(state:s,child:Scaffold(body:PinBar(chat:s.chat('oc_lab')!,onJump:(_){})))));
    for(var i=0;i<6;i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds:30)));
      await tester.pump(const Duration(milliseconds:100));
    }
    expect(find.text('已固定 1 条消息'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('pin-bar')));
    await tester.pumpAndSettle();
    expect(find.text('固定消息 · 1'), findsOneWidget);
    expect(find.byTooltip('取消固定'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
