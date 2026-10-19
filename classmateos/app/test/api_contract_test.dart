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
}
