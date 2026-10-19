import 'dart:convert';

import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('会话列表使用后端未读数和最后一条消息', () {
    final chat = CosChat.fromJson({
      'chat_id': 'oc_1',
      'chat_type': 'group',
      'name': '实验室',
      'member_ids': ['ou_admin', 'ou_demo'],
      'unread_count': 3,
      'pinned': true,
      'last_message': {
        'message_id': 'om_1',
        'chat_id': 'oc_1',
        'sender_id': 'ou_demo',
        'msg_type': 'text',
        'content': {'text': '你好'},
      },
    });
    expect(chat.unreadCount, 3);
    expect(chat.pinned, isTrue);
    expect(chat.lastMessage?.text, '你好');
  });

  test('字段、文档和日程的新字段可以解析', () {
    final table = CosTableMeta.fromJson({
      'key': 'projects',
      'fields': [
        {'field_name': 'owner_open_id', 'title': '负责人', 'type': 11, 'required': true},
      ],
    });
    expect(table.fields.single.label, '负责人');

    final doc = CosDoc.fromJson({'doc_id': 'd1', 'title': '周报', 'created_by': 'ou_admin', 'can_edit': false});
    expect(doc.canEdit, isFalse);

    final event = CosCalendarEvent.fromJson({
      'event_id': 'e1',
      'title': '组会',
      'start_ms': 1000,
      'end_ms': 2000,
      'location': '会议室',
      'attendees': [
        {'user_id': 'ou_demo', 'rsvp': 'accepted'},
      ],
    });
    expect(event.location, '会议室');
    expect(event.attendees.single.rsvp, 'accepted');
  });

  test('任务 PATCH 用 null 清空负责人和截止时间', () async {
    late Map<String, dynamic> body;
    final client = MockClient((req) async {
      body = jsonDecode(req.body) as Map<String, dynamic>;
      return http.Response(
        jsonEncode({'task_id': 't1', 'title': '任务', 'status': 'pending', 'created_by': 'ou_admin'}),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final api = CosApiClient('http://example.test/api/v1', accessToken: 'token', client: client)
      ..expiresAt = DateTime.now().add(const Duration(hours: 1));
    await api.updateTask('t1', clearDue: true, clearAssignee: true);
    expect(body.containsKey('due_ms'), isTrue);
    expect(body['due_ms'], isNull);
    expect(body.containsKey('assignee_id'), isTrue);
    expect(body['assignee_id'], isNull);
  });

  test('新建数据表按约定提交 POST /tables', () async {
    late http.Request request;
    final client = MockClient((req) async {
      request = req;
      return http.Response(jsonEncode({'key': 'tbl_equipment', 'name': '设备借用', 'primary_field': 'name', 'fields': [
        {'field_name': 'name', 'title': '名称', 'type': 1, 'required': true},
      ]}), 201, headers: {'content-type': 'application/json'});
    });
    final api = CosApiClient('http://example.test/api/v1', accessToken: 'token', client: client)
      ..expiresAt = DateTime.now().add(const Duration(hours: 1));
    final table = await api.createTable(name: '设备借用', primaryField: 'name', clientRequestId: 'req_1', fields: [
      {'field_name': 'name', 'title': '名称', 'type': 1, 'required': true},
    ]);
    final body = jsonDecode(request.body) as Map<String, dynamic>;
    expect(request.method, 'POST');
    expect(request.url.path, '/api/v1/tables');
    expect(body['client_request_id'], 'req_1');
    expect(table.key, 'tbl_equipment');
  });

  test('新建数据表 422 错误保留字段路径', () async {
    final client = MockClient((_) async => http.Response(jsonEncode({
          'message': '字段校验失败',
          'code': 'VALIDATION_FAILED',
          'errors': [{'field': 'fields[1].options[0]', 'message': '选项不能为空'}],
        }), 422, headers: {'content-type': 'application/json'}));
    final api = CosApiClient('http://example.test/api/v1', accessToken: 'token', client: client)
      ..expiresAt = DateTime.now().add(const Duration(hours: 1));
    await expectLater(
      api.createTable(name: '表', primaryField: 'name', fields: const []),
      throwsA(isA<CosApiException>().having((e) => e.errors.single['field'], 'field', 'fields[1].options[0]')),
    );
  });

  test('解析自定义数据表标记', () {
    final t = CosTableMeta.fromJson({'key': 'tbl_x', 'name': '设备', 'builtin': false, 'created_by': 'ou_admin'});
    expect(t.builtin, isFalse);
    expect(t.createdBy, 'ou_admin');
    expect(CosTableMeta.fromJson({'key': 'projects', 'name': '项目'}).builtin, isTrue);
  });
}
