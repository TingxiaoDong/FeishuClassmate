import 'dart:convert';

import 'package:classmateos_app/api_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('重复日程字段及影响范围请求符合迭代 3 契约', () async {
    final reqs = <http.Request>[];
    final api = CosApiClient('http://x/api/v1', accessToken: 't', client: MockClient((r) async {
      reqs.add(r);
      final body = r.method == 'GET' ? {'items': [{'event_id': 'e_1', 'title': '组会', 'start_ms': 1, 'end_ms': 2, 'created_by': 'ou_admin', 'recurrence': 'FREQ=WEEKLY;BYDAY=MO', 'recurring_event_id': 'series', 'original_start_ms': 1, 'is_exception': true}]} : {'event_id': 'e_1', 'title': '组会', 'start_ms': 1, 'end_ms': 2, 'created_by': 'ou_admin'};
      return http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});
    }));
    final e = (await api.listEvents(DateTime.fromMillisecondsSinceEpoch(10), DateTime.fromMillisecondsSinceEpoch(20), expandRecurring: true)).single;
    expect(reqs.single.url.queryParameters, {'start_ms': '10', 'end_ms': '20'});
    expect(e.isRecurring && e.isException, isTrue);
    await api.updateEvent('e_1', scope: 'following', clearRecurrence: true);
    expect(reqs.last.url.queryParameters['scope'], 'following');
    expect(jsonDecode(reqs.last.body), containsPair('recurrence', null));
    await api.deleteEvent('e_1', scope: 'this');
    expect(reqs.last.url.queryParameters['scope'], 'this');
  });
}
