/// ClassmateOS REST 客户端 —— 四端共用 API 层（PLAN §2.1 Flutter 单代码库）。
/// 依赖: package:http。Flutter 工程初始化后直接可用。

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

class CosApiException implements Exception {
  final int statusCode;
  final String message;
  const CosApiException(this.statusCode, this.message);
  @override
  String toString() => 'CosApiException($statusCode): $message';
}

class CosApiClient {
  final String baseUrl; // e.g. http://localhost:8080/api/v1
  String? accessToken;

  CosApiClient(this.baseUrl, {this.accessToken});

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (accessToken != null) 'Authorization': 'Bearer $accessToken',
      };

  Future<Map<String, dynamic>> _call(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
  }) async {
    var uri = Uri.parse('$baseUrl$path');
    if (query != null && query.isNotEmpty) {
      uri = uri.replace(queryParameters: {...uri.queryParameters, ...query});
    }
    final req = http.Request(method, uri)
      ..headers.addAll(_headers)
      ..body = jsonEncode(body ?? const {});
    final streamed = await req.send();
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode == 204) return const {};
    final data = res.body.isEmpty
        ? <String, dynamic>{}
        : (jsonDecode(res.body) as Map).cast<String, dynamic>();
    if (res.statusCode >= 400) {
      throw CosApiException(
        res.statusCode,
        data['message']?.toString() ?? 'HTTP ${res.statusCode}',
      );
    }
    return data;
  }

  // ---------------- auth ----------------

  /// 登录并缓存 access_token。
  Future<CosUser> login(String username, String password) async {
    final data = await _call('POST', '/auth/login',
        body: {'username': username, 'password': password});
    accessToken = data['access_token'] as String?;
    return CosUser.fromJson((data['user'] as Map).cast<String, dynamic>());
  }

  Future<CosUser> me() async => CosUser.fromJson(await _call('GET', '/users/me'));

  Future<List<CosUser>> listUsers({String? keyword}) async {
    final data = await _call('GET', '/users',
        query: keyword != null ? {'keyword': keyword} : null);
    return (data['items'] as List?)
            ?.map((e) => CosUser.fromJson((e as Map).cast<String, dynamic>()))
            .toList() ??
        const [];
  }

  // ---------------- IM ----------------

  Future<List<CosChat>> listChats() async {
    final data = await _call('GET', '/chats');
    return (data['items'] as List?)
            ?.map((e) => CosChat.fromJson((e as Map).cast<String, dynamic>()))
            .toList() ??
        const [];
  }

  Future<CosChat> createChat({String? name, required List<String> memberIds}) async {
    final data = await _call('POST', '/chats',
        body: {if (name != null) 'name': name, 'member_ids': memberIds});
    return CosChat.fromJson(data);
  }

  Future<List<CosMessage>> listMessages(String chatId,
      {String? beforeMessageId, int pageSize = 30}) async {
    final data = await _call('GET', '/chats/$chatId/messages', query: {
      if (beforeMessageId != null) 'before_message_id': beforeMessageId,
      'page_size': '$pageSize',
    });
    return (data['items'] as List?)
            ?.map((e) => CosMessage.fromJson((e as Map).cast<String, dynamic>()))
            .toList() ??
        const [];
  }

  Future<CosMessage> sendText(String chatId, String text) async {
    final data = await _call('POST', '/chats/$chatId/messages',
        body: {
          'msg_type': 'text',
          'content': {'text': text},
        });
    return CosMessage.fromJson(data);
  }

  /// 卡片交互回调（ask_user_question 回答）。
  Future<void> answerCard(String cardId, String action,
      {Map<String, dynamic>? formValues}) async {
    await _call('POST', '/cards/$cardId/actions', body: {
      'action': action,
      if (formValues != null) 'form_values': formValues,
    });
  }

  // ---------------- 表格引擎 ----------------

  Future<List<CosTableMeta>> listTables() async {
    final data = await _call('GET', '/tables');
    return (data['items'] as List?)
            ?.map((e) => CosTableMeta.fromJson((e as Map).cast<String, dynamic>()))
            .toList() ??
        const [];
  }

  Future<List<CosRecord>> listRecords(
    String tableKey, {
    String? filter,
    String? sort,
    int pageSize = 100,
    String? pageToken,
  }) async {
    final data = await _call('GET', '/tables/$tableKey/records', query: {
      if (filter != null) 'filter': filter,
      if (sort != null) 'sort': sort,
      'page_size': '$pageSize',
      if (pageToken != null) 'page_token': pageToken,
    });
    return (data['items'] as List?)
            ?.map((e) => CosRecord.fromJson((e as Map).cast<String, dynamic>()))
            .toList() ??
        const [];
  }

  Future<CosRecord> createRecord(String tableKey, Map<String, dynamic> fields) async {
    final data = await _call('POST', '/tables/$tableKey/records', body: {'fields': fields});
    return CosRecord.fromJson(data);
  }

  Future<CosRecord> updateRecord(
      String tableKey, String recordId, Map<String, dynamic> fields) async {
    final data =
        await _call('PATCH', '/tables/$tableKey/records/$recordId', body: {'fields': fields});
    return CosRecord.fromJson(data);
  }

  Future<void> deleteRecord(String tableKey, String recordId) async {
    await _call('DELETE', '/tables/$tableKey/records/$recordId');
  }

  /// 通用 GET（P1 期间文档/日历等端点的轻量入口，后续补类型化方法）。
  Future<Map<String, dynamic>> rawGet(String path) => _call('GET', path);
}
