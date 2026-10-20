import 'dart:convert';

import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/pages/required_password_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(int code, Object body) =>
    http.Response(jsonEncode(body), code, headers: {'content-type': 'application/json; charset=utf-8'});

void main() {
  testWidgets('强制改密：原密码错误显示提示，改密成功后刷新令牌并进入应用', (tester) async {
    final calls = <String>[];
    final client = MockClient((req) async {
      calls.add('${req.method} ${req.url.path}');
      if (req.url.path.endsWith('/users/me/password')) {
        final b = jsonDecode(req.body) as Map;
        if (b['old_password'] != 'init1234') {
          return _json(400, {'code': 'INVALID_PASSWORD', 'message': '当前密码不正确'});
        }
        return http.Response('', 204);
      }
      if (req.url.path.endsWith('/auth/refresh')) {
        return _json(200, {
          'access_token': 'a2',
          'refresh_token': 'r2',
          'expires_in': 7200,
          'must_change_password': false,
          'user': {'user_id': 'u1', 'name': '新同学', 'must_change_password': false},
        });
      }
      return _json(404, {'message': 'not found'});
    });
    final api = CosApiClient('http://test/api/v1', client: client)
      ..accessToken = 'a1'
      ..refreshToken = 'r1'
      ..expiresAt = DateTime.now().add(const Duration(hours: 1));
    var done = 0, out = 0;
    await tester.pumpWidget(MaterialApp(
      home: RequiredPasswordPage(api: api, onCompleted: () => done++, onLogout: () => out++),
    ));
    expect(find.text('请先修改初始密码'), findsOneWidget);

    // 两次新密码不一致：前端直接拦下，不发请求
    await tester.enterText(find.byKey(const ValueKey('required-old')), 'init1234');
    await tester.enterText(find.byKey(const ValueKey('required-new')), 'Newpass123');
    await tester.enterText(find.byKey(const ValueKey('required-again')), 'Other123');
    await tester.tap(find.text('修改密码并进入'));
    await tester.pumpAndSettle();
    expect(find.textContaining('两次新密码一致'), findsOneWidget);
    expect(calls, isEmpty);

    // 原密码错误：显示后端提示，不进入应用
    await tester.enterText(find.byKey(const ValueKey('required-old')), 'wrong');
    await tester.enterText(find.byKey(const ValueKey('required-again')), 'Newpass123');
    await tester.tap(find.text('修改密码并进入'));
    await tester.pumpAndSettle();
    expect(find.text('当前密码不正确'), findsOneWidget);
    expect(done, 0);

    // 正确：改密 → 刷新令牌 → 进入应用
    await tester.enterText(find.byKey(const ValueKey('required-old')), 'init1234');
    await tester.tap(find.text('修改密码并进入'));
    await tester.pumpAndSettle();
    expect(done, 1);
    expect(api.accessToken, 'a2');
    expect(calls.where((c) => c.endsWith('/auth/refresh')).length, 1);
    expect(out, 0);
  });

  testWidgets('强制改密页可以退出登录', (tester) async {
    final api = CosApiClient('http://test/api/v1', client: MockClient((_) async => http.Response('', 204)));
    var out = 0;
    await tester.pumpWidget(MaterialApp(
      home: RequiredPasswordPage(api: api, onCompleted: () {}, onLogout: () => out++),
    ));
    await tester.tap(find.text('退出登录'));
    expect(out, 1);
  });
}
