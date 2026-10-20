// 前端遗留项补齐第二批（2026-10-20 晚）：文档粘贴截图 / 文件上传、子窗口借用主窗口令牌。
// 摄像头扫码、新窗口本身依赖真机和原生多窗口，这里只测能在测试环境里跑的部分。
import 'dart:convert';

import 'package:classmateos_app/api/phase2_admin.dart' show parseQrLogin;
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/services/doc_paste.dart';
import 'package:classmateos_app/theme.dart';
import 'package:classmateos_app/widgets/doc_editor.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'phase2_test.dart' show settle;

final _png = Uint8List.fromList([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]);

void _stubClipboard({List<String> files = const [], String? text, Uint8List? image}) {
  DocClipboard.files = () async => files;
  DocClipboard.text = () async => text;
  DocClipboard.image = () async => image;
  DocClipboard.readPath = (p) async => (name: p.split('/').last, bytes: Uint8List.fromList(utf8.encode('file:$p')));
}

void main() {
  final orig = (DocClipboard.files, DocClipboard.text, DocClipboard.image, DocClipboard.readPath);
  tearDown(() {
    DocClipboard.files = orig.$1;
    DocClipboard.text = orig.$2;
    DocClipboard.image = orig.$3;
    DocClipboard.readPath = orig.$4;
  });

  group('剪贴板读取', () {
    test('复制的文件优先，其次文字，最后截图', () async {
      _stubClipboard(files: ['/tmp/a.pdf', '/tmp/b.png'], text: '文字', image: _png);
      var c = await DocClipboard.read();
      expect(c.files.map((f) => f.name), ['a.pdf', 'b.png']);

      _stubClipboard(text: '从 Word 复制的文字', image: _png);
      c = await DocClipboard.read();
      expect(c.text, '从 Word 复制的文字', reason: '有文字时不当截图上传');
      expect(c.files, isEmpty);

      _stubClipboard(image: _png);
      c = await DocClipboard.read();
      expect(c.files.single.name, matches(RegExp(r'^截图_\d{8}_\d{6}\.png$')));
      expect(c.files.single.bytes, _png);

      _stubClipboard();
      expect((await DocClipboard.read()).isEmpty, isTrue);
    });

    test('插件出错按「没有」处理，读不了的文件跳过', () async {
      _stubClipboard(files: ['/tmp/x'], text: '兜底文字');
      DocClipboard.files = () async => throw PlatformException(code: 'unsupported');
      expect((await DocClipboard.read()).text, '兜底文字');

      _stubClipboard(files: ['/tmp/folder'], text: '兜底文字');
      DocClipboard.readPath = (_) async => throw const FileSystemLikeError();
      expect((await DocClipboard.read()).text, '兜底文字');
    });

    test('截图文件名', () {
      expect(DocClipboard.screenshotName(DateTime(2026, 10, 20, 9, 5, 3)), '截图_20261020_090503.png');
    });
  });

  group('文档编辑器 ⌘V', () {
    late MockBackend mock;

    Future<TextEditingController> boot(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      mock = MockBackend();
      final api = CosApiClient(kMockBaseUrl, client: mock.client);
      late AppState state;
      await tester.runAsync(() async {
        final me = await api.login('admin', 'x');
        state = AppState(api: api, me: me, onLogout: () {});
        await state.init(realtime: false);
      });
      await tester.pumpWidget(MaterialApp(
        theme: buildFsTheme(),
        home: AppScope(state: state, child: const Scaffold(body: DocEditor(docId: 'doc_1'))),
      ));
      await settle(tester);
      final body = find.byWidgetPredicate((w) => w is TextField && (w.minLines ?? 0) >= 20);
      expect(body, findsOneWidget, reason: '文档所有者打开时是编辑状态');
      await tester.tap(body);
      await tester.pump();
      final ctl = tester.widget<TextField>(body).controller!;
      ctl.selection = TextSelection.collapsed(offset: ctl.text.length);
      return ctl;
    }

    Future<void> pasteKey(WidgetTester tester) async {
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await settle(tester);
    }

    testWidgets('粘贴截图：上传后在光标处插入图片', (tester) async {
      final ctl = await boot(tester);
      _stubClipboard(image: _png);
      await pasteKey(tester);
      final uploads = mock.requests.where((r) => r.url.path.contains('mock-upload')).toList();
      expect(uploads, hasLength(1));
      expect(uploads.single.bodyBytes, _png);
      expect(ctl.text, matches(RegExp(r'!\[截图_\d{8}_\d{6}\.png\]\([^)]+\)')));
      expect(ctl.text, isNot(contains('uploading://')), reason: '占位已替换成真正的地址');
    });

    testWidgets('粘贴复制的文件：图片插图、其他作为附件', (tester) async {
      final ctl = await boot(tester);
      _stubClipboard(files: ['/tmp/实验数据.xlsx', '/tmp/照片.jpg']);
      await pasteKey(tester);
      expect(mock.requests.where((r) => r.url.path.contains('mock-upload')), hasLength(2));
      expect(ctl.text, contains('[📎 实验数据.xlsx]('));
      expect(ctl.text, contains('![照片.jpg]('));
    });

    testWidgets('粘贴文字：照常插入，不上传', (tester) async {
      final ctl = await boot(tester);
      final before = ctl.text;
      _stubClipboard(text: '新加的一段', image: _png);
      await pasteKey(tester);
      expect(ctl.text, '$before新加的一段');
      expect(mock.requests.where((r) => r.url.path.contains('mock-upload')), isEmpty);
    });
  });

  group('子窗口令牌', () {
    test('401 时向主窗口借新令牌并重放；借不到才算登录失效', () async {
      var lost = 0;
      final seen = <String?>[];
      final client = MockClient((req) async {
        final auth = req.headers['authorization'];
        seen.add(auth);
        if (auth == 'Bearer new') {
          return http.Response.bytes(utf8.encode(jsonEncode({'user_id': 'ou_admin', 'name': '王老师'})), 200,
              headers: {'content-type': 'application/json; charset=utf-8'});
        }
        return http.Response.bytes(utf8.encode(jsonEncode({'code': 'UNAUTHORIZED', 'message': '登录已过期'})), 401,
            headers: {'content-type': 'application/json; charset=utf-8'});
      });
      final api = CosApiClient('http://x/api/v1', client: client)
        ..accessToken = 'old'
        ..borrowAccessToken = (() async => 'new')
        ..onAuthLost = (() => lost++);
      final me = await api.me();
      expect(me.name, '王老师');
      expect(seen, ['Bearer old', 'Bearer new']);
      expect(api.accessToken, 'new');
      expect(lost, 0);

      final api2 = CosApiClient('http://x/api/v1', client: client)
        ..accessToken = 'old'
        ..borrowAccessToken = (() async => 'old') // 主窗口也没有新令牌
        ..onAuthLost = (() => lost++);
      await expectLater(api2.me(), throwsA(isA<CosApiException>()));
      expect(lost, 1);
    });
  });

  test('扫码内容只认 ClassmateOS 登录码', () {
    expect(parseQrLogin('classmateos://qr-login?qr_id=qr_123'), isNotNull);
    expect(parseQrLogin('https://example.com'), isNull);
  });
}

class FileSystemLikeError implements Exception {
  const FileSystemLikeError();
}
