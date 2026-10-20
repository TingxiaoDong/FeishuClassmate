// 《代码审查_前端_2026-10-20》F1～F3 的回归测试。
import 'dart:convert';

import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/pages/table_manage.dart';
import 'package:classmateos_app/services/token_store.dart';
import 'package:classmateos_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

// ---------------- F1：会话列表增量更新 ----------------

class _ImFake {
  int listChats = 0;
  int markRead = 0;
  final chats = <Map<String, dynamic>>[
    {'chat_id': 'oc_a', 'chat_type': 'group', 'name': '群 A', 'member_ids': ['ou_me', 'ou_x'], 'unread_count': 0, 'updated_at': '2026-10-20T01:00:00Z'},
    {'chat_id': 'oc_b', 'chat_type': 'group', 'name': '群 B', 'member_ids': ['ou_me', 'ou_x'], 'unread_count': 2, 'updated_at': '2026-10-20T02:00:00Z'},
  ];

  late final client = MockClient((r) async {
    final p = r.url.path.replaceFirst('/api/v1', '');
    Object body = {};
    if (r.method == 'GET' && p == '/chats') {
      listChats++;
      body = {'items': chats, 'has_more': false};
    } else if (r.method == 'GET' && p == '/users') {
      body = {'items': [{'user_id': 'ou_me', 'name': '我'}, {'user_id': 'ou_x', 'name': '小明'}], 'has_more': false};
    } else if (r.method == 'POST' && p.endsWith('/read')) {
      markRead++;
    } else if (p == '/capabilities') {
      body = {'features': {'message.thread': true}};
    }
    return http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});
  });
}

CosEvent _msg(int i, String chatId, {String sender = 'ou_x', String? threadRoot}) => CosEvent.fromJson({
      'event_id': 'evt_$chatId$i',
      'event_type': 'message.receive',
      'message': {
        'message_id': 'om_$chatId$i',
        'chat_id': chatId,
        'sender_id': sender,
        'msg_type': 'text',
        'content': {'text': '第 $i 条'},
        'created_at': DateTime.utc(2026, 10, 20, 3, 0, i).toIso8601String(),
        if (threadRoot != null) 'thread_root_id': threadRoot,
      },
    });

Future<(AppState, _ImFake)> _bootIm() async {
  final f = _ImFake();
  final api = CosApiClient('http://x/api/v1', accessToken: 't', client: f.client);
  final s = AppState(api: api, me: const CosUser(userId: 'ou_me', name: '我'), onLogout: () {});
  await s.init(realtime: false);
  f.listChats = 0; // 只统计 init 之后的调用
  return (s, f);
}

Future<void> _wait() => Future<void>.delayed(AppState.chatsRefreshDebounce + const Duration(milliseconds: 150));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('F1 会话列表增量更新', () {
    test('连续 50 条 message.receive 不全量拉会话列表；未读、最后一条、排序正确', () async {
      final (s, f) = await _bootIm();
      expect(s.chats.first.chatId, 'oc_b');
      for (var i = 1; i <= 50; i++) {
        s.injectEvent(_msg(i, 'oc_a'));
      }
      await _wait();
      expect(f.listChats, lessThanOrEqualTo(1));
      expect(f.listChats, 0);
      expect(s.unread['oc_a'], 50);
      expect(s.chat('oc_a')!.unreadCount, 50);
      expect(s.lastMessage['oc_a']!.messageId, 'om_oc_a50');
      expect(s.chats.first.chatId, 'oc_a', reason: '有新消息的会话排到最前');
      expect(s.unread['oc_b'], 2);
    });

    test('自己发的、正在看的会话不计未读；正在看时自动标已读', () async {
      final (s, f) = await _bootIm();
      s.injectEvent(_msg(1, 'oc_a', sender: 'ou_me'));
      expect(s.unread['oc_a'], 0);
      s.openChat('oc_a');
      await _wait();
      final before = f.markRead;
      s.injectEvent(_msg(2, 'oc_a'));
      await _wait();
      expect(s.unread['oc_a'], 0);
      expect(f.markRead, before + 1);
      expect(f.listChats, 0);
    });

    test('本地没有的会话（新会话）、话题回复：合并成一次全量刷新', () async {
      final (s, f) = await _bootIm();
      for (var i = 1; i <= 10; i++) {
        s.injectEvent(_msg(i, 'oc_new'));
        s.injectEvent(_msg(i, 'oc_a', threadRoot: 'om_root'));
      }
      await _wait();
      expect(f.listChats, 1);
      expect(s.unread['oc_a'], 0, reason: '话题回复不计主会话未读');
    });

    test('message.read：自己已读清零，别人已读不刷新列表', () async {
      final (s, f) = await _bootIm();
      s.injectEvent(CosEvent.fromJson({
        'event_id': 'r1', 'event_type': 'message.read',
        'read': {'chat_id': 'oc_b', 'user_id': 'ou_x', 'message_id': 'm'}, 'chat_id': 'oc_b', 'user_id': 'ou_x',
      }));
      expect(s.unread['oc_b'], 2);
      s.injectEvent(CosEvent.fromJson({
        'event_id': 'r2', 'event_type': 'message.read',
        'read': {'chat_id': 'oc_b', 'user_id': 'ou_me', 'message_id': 'm'}, 'chat_id': 'oc_b', 'user_id': 'ou_me',
      }));
      expect(s.unread['oc_b'], 0);
      await _wait();
      expect(f.listChats, 0);
    });

    test('chat.updated 本地覆盖；chat.created / member_added 连续多次只刷新一次', () async {
      final (s, f) = await _bootIm();
      s.injectEvent(CosEvent.fromJson({
        'event_id': 'c1', 'event_type': 'chat.updated',
        'chat': {'chat_id': 'oc_a', 'name': '改名后', 'member_ids': ['ou_me', 'ou_x'], 'pinned_message_ids': ['om_1']},
      }));
      expect(s.chat('oc_a')!.name, '改名后');
      expect(s.chat('oc_a')!.pinnedMessageIds, ['om_1']);
      for (var i = 0; i < 5; i++) {
        s.injectEvent(CosEvent.fromJson({'event_id': 'c2$i', 'event_type': i.isEven ? 'chat.created' : 'chat.member_added', 'chat': {'chat_id': 'oc_n$i'}}));
      }
      await _wait();
      expect(f.listChats, 1);
    });
  });

  // ---------------- F2：record.history 开关 ----------------

  group('F2 记录动态面板按开关显示', () {
    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 6; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
        await tester.pump(const Duration(milliseconds: 200));
      }
    }

    Future<AppState> boot(WidgetTester tester, {required bool comments, required bool history}) async {
      final mock = MockBackend();
      mock.features['record.comments'] = comments;
      mock.features['record.history'] = history;
      final api = CosApiClient(kMockBaseUrl, client: mock.client);
      late AppState state;
      late CosTableMeta table;
      late String recordId;
      await tester.runAsync(() async {
        final me = await api.login('admin', 'x');
        state = AppState(api: api, me: me, onLogout: () {});
        await state.init(realtime: false);
        table = (await api.listTables()).first;
        recordId = (await api.listRecords(table.key)).items.first.recordId;
      });
      await tester.pumpWidget(MaterialApp(
        theme: buildFsTheme(),
        home: AppScope(
          state: state,
          child: Scaffold(body: SizedBox(width: 360, height: 600, child: RecordActivity(table: table, recordId: recordId))),
        ),
      ));
      await settle(tester);
      return state;
    }

    testWidgets('两个都开：两个页签、评论输入框', (tester) async {
      final s = await boot(tester, comments: true, history: true);
      expect(hasRecordActivity(s), isTrue);
      expect(recordActivityLabel(s), '评论与修改记录');
      expect(find.textContaining('评论'), findsWidgets);
      expect(find.text('修改记录'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('只开 record.history：只有修改记录，没有评论页签和输入框', (tester) async {
      final s = await boot(tester, comments: false, history: true);
      expect(hasRecordActivity(s), isTrue);
      expect(recordActivityLabel(s), '修改记录');
      expect(find.text('修改记录'), findsOneWidget);
      expect(find.textContaining('评论'), findsNothing);
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('只开 record.comments：只有评论页签', (tester) async {
      final s = await boot(tester, comments: true, history: false);
      expect(recordActivityLabel(s), '评论');
      expect(find.text('修改记录'), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('都关：面板入口隐藏', (tester) async {
      final s = await boot(tester, comments: false, history: false);
      expect(hasRecordActivity(s), isFalse);
    });
  });

  // ---------------- F3：refresh token 存储 ----------------

  group('F3 refresh token 存储', () {
    test('旧版明文迁移到安全存储，之后删除明文', () async {
      SharedPreferences.setMockInitialValues({TokenStore.prefsKey: 'old_rt'});
      final kv = _MemKv();
      final store = TokenStore(secure: kv, useSecure: true);
      expect(await store.read(), 'old_rt');
      expect(kv.m[TokenStore.secureKey], 'old_rt');
      expect((await SharedPreferences.getInstance()).getString(TokenStore.prefsKey), isNull);
      expect(await store.read(), 'old_rt');
    });

    test('写入只进安全存储；清除两边都删', () async {
      SharedPreferences.setMockInitialValues({});
      final kv = _MemKv();
      final store = TokenStore(secure: kv, useSecure: true);
      await store.write('rt2');
      expect(kv.m[TokenStore.secureKey], 'rt2');
      expect((await SharedPreferences.getInstance()).getString(TokenStore.prefsKey), isNull);
      await store.clear();
      expect(await store.read(), isNull);
    });

    test('安全存储不可用时退回本地保存，不影响自动登录', () async {
      SharedPreferences.setMockInitialValues({});
      final store = TokenStore(secure: _MemKv(broken: true), useSecure: true);
      await store.write('rt3');
      expect(await store.read(), 'rt3');
    });

    test('Web / Windows / Linux：维持 SharedPreferences', () async {
      SharedPreferences.setMockInitialValues({});
      final store = TokenStore(useSecure: false);
      expect(store.secure, isNull);
      await store.write('rt4');
      expect((await SharedPreferences.getInstance()).getString(TokenStore.prefsKey), 'rt4');
    });
  });
}

class _MemKv implements SecureKv {
  final bool broken;
  final m = <String, String>{};
  _MemKv({this.broken = false});
  void _check() {
    if (broken) throw Exception('keychain unavailable');
  }

  @override
  Future<String?> read(String key) async {
    _check();
    return m[key];
  }

  @override
  Future<void> write(String key, String value) async {
    _check();
    m[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _check();
    m.remove(key);
  }
}
