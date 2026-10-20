/// ClassmateOS REST 客户端 —— 四端共用 API 层。
/// 对齐《后端对接说明》：令牌刷新与轮换、会话 / 消息分页、已读、卡片、群管理、
/// 云盘文件、表格分页、文档并发保护、日程修改与回复、任务指派与删除。
library;

import 'services/device_label.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'models.dart';

class CosApiException implements Exception {
  final int statusCode;
  final String message;

  /// 机器可读错误码（如 CHAT_NOT_MEMBER、CARD_ANSWERED、DOC_CONFLICT）。
  final String? code;

  /// 422 字段校验失败时的明细（field → message）。
  final List<Map<String, dynamic>> errors;

  /// 完整响应体（409 卡片已回答带 answer，文档冲突带 doc）。
  final Map<String, dynamic> data;

  const CosApiException(this.statusCode, this.message,
      {this.code, this.errors = const [], this.data = const {}});

  static final _cjk = RegExp(r'[\u4e00-\u9fff]');

  /// 给界面展示用的中文说明。
  String get friendly {
    final cn = _cjk.hasMatch(message);
    if (statusCode == 0) return '连不上服务器，请检查网络或服务地址';
    if (statusCode == 401) {
      if (message == 'invalid credentials') return '用户名或密码错误';
      if (code == 'SESSION_IDLE_TIMEOUT') return '长时间没有操作，请重新登录';
      return '登录已过期，请重新登录';
    }
    // 423 账号锁定：后端的中文提示里带了剩余分钟数，原样展示
    if (statusCode == 423) return cn ? message : '登录失败次数过多，账号已锁定，请稍后再试';
    if (code == 'PASSWORD_CHANGE_REQUIRED') return '请先修改初始密码';
    if (code == 'ACCOUNT_DISABLED') return '账号已被禁用，请联系管理员';
    if (errors.isNotEmpty) {
      // 后端的中文提示多数已经写明了是哪一项（如「密码最短长度必须是…」），这时不再拼英文字段名
      return errors.map((e) {
        final msg = e['message']?.toString() ?? '';
        final label = _fieldLabel(e['field']);
        final known = label.isNotEmpty && !label.startsWith('${e['field']}');
        return known || !_cjk.hasMatch(msg) ? '$label$msg' : msg;
      }).join('；');
    }
    if (statusCode == 403) return cn ? message : '没有权限执行这个操作';
    if (statusCode == 404) return cn ? message : '内容不存在或已被删除';
    if (statusCode == 413) return cn ? message : '文件太大，无法上传';
    return message;
  }

  static String _fieldLabel(dynamic f) {
    final s = f?.toString() ?? '';
    const names = {
      'title': '标题',
      'name': '名称',
      'content.text': '内容',
      'member_ids': '成员',
      'attendee_ids': '参与人',
      'start_ms': '开始时间',
      'end_ms': '结束时间',
      'due_ms': '截止时间',
      'assignee_id': '负责人',
      'status': '状态',
      'markdown': '正文',
      'password': '密码',
      'user_id': '账号',
      'file_name': '文件名',
    };
    final n = names[s];
    if (n != null) return '$n：';
    return s.isEmpty ? '' : '$s：';
  }

  @override
  String toString() => friendly;
}

/// 把任意异常转成可读中文。
String describeError(Object e) {
  if (e is CosApiException) return e.friendly;
  final s = e.toString();
  if (s.contains('SocketException') || s.contains('ClientException') || s.contains('Connection')) {
    return '连不上服务器，请检查网络或服务地址';
  }
  return s;
}

/// 登录 / 刷新得到的会话。
class CosSession {
  final String accessToken;
  final String refreshToken;
  final DateTime expiresAt;
  final CosUser user;
  const CosSession(this.accessToken, this.refreshToken, this.expiresAt, this.user);
}

/// 创建默认 HTTP 客户端；模拟模式（COS_MOCK）在 main() 里替换成 MockBackendClient。
http.Client Function() cosHttpClientFactory = http.Client.new;

class CosApiClient {
  final String baseUrl; // e.g. http://localhost:8080/api/v1
  String? accessToken;
  String? refreshToken;
  DateTime? expiresAt;
  final http.Client _http;

  /// 当前登录的设备会话（迭代 5 批次 1）。
  String? sessionId;

  /// 后端要求先改密（403 PASSWORD_CHANGE_REQUIRED）时回调。
  void Function()? onPasswordChangeRequired;

  /// 令牌更新（登录 / 刷新轮换）后回调，用于持久化。
  void Function(CosSession session)? onSession;

  /// 刷新失败（refresh_token 过期或被吊销）后回调，应回到登录页。
  void Function()? onAuthLost;

  Future<bool>? _refreshing;

  /// [client] 可注入（测试用 MockClient）；缺省用默认 http.Client。
  CosApiClient(this.baseUrl, {this.accessToken, this.refreshToken, http.Client? client})
      : _http = client ?? cosHttpClientFactory();

  /// 服务端源（scheme://host:port），用于拼接预签名的相对地址。
  String get origin => Uri.parse(baseUrl).origin;

  /// 绝对化服务端返回的地址（签名直传 / 直取、头像）。
  String absolute(String url) => url.startsWith('http') ? url : '$origin$url';

  /// 把 http(s) 基址换成 ws(s)，拼上路径、token 与额外参数。
  Uri wsUri(String path, {Map<String, String>? query}) {
    final base = Uri.parse('$baseUrl$path');
    return base.replace(
      scheme: base.scheme == 'https' ? 'wss' : 'ws',
      queryParameters: {
        ...base.queryParameters,
        ...?query,
        if (accessToken != null) 'token': accessToken!,
      },
    );
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (accessToken != null) 'Authorization': 'Bearer $accessToken',
      };

  static final _rand = Random();

  /// 前端生成的幂等键（发送消息重试时复用）。
  static String newClientMsgId() =>
      'c_${DateTime.now().millisecondsSinceEpoch}_${_rand.nextInt(1 << 30).toRadixString(36)}';

  // ---------------- 底层请求 ----------------

  Future<Map<String, dynamic>> _call(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
    bool auth = true,
  }) async {
    if (auth) await ensureFreshToken();
    try {
      return await _send(method, path, body: body, query: query);
    } on CosApiException catch (e) {
      // 令牌失效：先刷新一次再重放；刷新失败才回登录页
      if (auth && e.statusCode == 401 && refreshToken != null) {
        if (await refresh()) return _send(method, path, body: body, query: query);
        onAuthLost?.call();
      }
      if (auth && e.statusCode == 403 && e.code == 'PASSWORD_CHANGE_REQUIRED') onPasswordChangeRequired?.call();
      rethrow;
    }
  }

  /// 二期接口（lib/api/phase2_api.dart）共用的请求入口：自动带令牌、401 刷新重放。
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
  }) =>
      _call(method, path, body: body, query: query);

  /// 不带令牌的请求（扫码登录的二维码创建、轮询）。
  Future<Map<String, dynamic>> requestPublic(String method, String path, {Map<String, dynamic>? body}) =>
      _call(method, path, body: body, auth: false);

  /// 扫码登录确认后，用后端返回的令牌建立会话（结构同 /auth/login 的返回）。
  CosUser adoptSession(Map<String, dynamic> data) => _applySession(data).user;

  /// 二期分页列表的解析。
  CosPage<T> parsePage<T>(Map<String, dynamic> data, T Function(Map<String, dynamic>) f) => _page(data, f);

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
  }) async {
    var uri = Uri.parse('$baseUrl$path');
    if (query != null && query.isNotEmpty) {
      uri = uri.replace(queryParameters: {...uri.queryParameters, ...query});
    }
    final req = http.Request(method, uri)..headers.addAll(_headers);
    // GET 不带 body（浏览器端 XHR 会忽略，原生端某些代理会拒绝）。
    if (method != 'GET') req.body = jsonEncode(body ?? const {});
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req));
    } catch (e) {
      throw CosApiException(0, e.toString());
    }
    if (res.statusCode == 204) return const {};
    Map<String, dynamic> data;
    try {
      final decoded = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
      data = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    } on FormatException {
      data = {'message': res.body};
    }
    if (res.statusCode >= 400) {
      throw CosApiException(
        res.statusCode,
        data['message']?.toString() ?? 'HTTP ${res.statusCode}',
        code: data['code']?.toString(),
        errors: (data['errors'] as List?)?.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() ??
            const [],
        data: data,
      );
    }
    return data;
  }

  List<T> _items<T>(Map<String, dynamic> data, T Function(Map<String, dynamic>) f) =>
      (data['items'] as List?)?.map((e) => f((e as Map).cast<String, dynamic>())).toList() ?? <T>[];

  CosPage<T> _page<T>(Map<String, dynamic> data, T Function(Map<String, dynamic>) f) => CosPage(
        _items(data, f),
        hasMore: data['has_more'] == true,
        pageToken: data['page_token']?.toString(),
        total: (data['total'] as num?)?.toInt(),
      );

  /// 按 page_token 循环拉完所有页。
  Future<List<T>> _all<T>(
    String path,
    T Function(Map<String, dynamic>) f, {
    Map<String, String> query = const {},
    int maxPages = 50,
  }) async {
    final out = <T>[];
    String? token;
    for (var i = 0; i < maxPages; i++) {
      final data = await _call('GET', path, query: {...query, if (token != null) 'page_token': token});
      final p = _page(data, f);
      out.addAll(p.items);
      if (!p.hasMore || p.pageToken == null) break;
      token = p.pageToken;
    }
    return out;
  }

  // ---------------- 认证 ----------------

  CosSession _applySession(Map<String, dynamic> data) {
    accessToken = data['access_token'] as String?;
    refreshToken = data['refresh_token'] as String? ?? refreshToken;
    final sec = (data['expires_in'] as num?)?.toInt() ?? 7200;
    expiresAt = DateTime.now().add(Duration(seconds: sec));
    sessionId = data['session_id']?.toString() ?? sessionId;
    final uj = (data['user'] as Map).cast<String, dynamic>();
    // must_change_password 顶层和 user 里都可能有，任一为 true 即须改密
    if (data['must_change_password'] == true) uj['must_change_password'] = true;
    final s = CosSession(
      accessToken ?? '',
      refreshToken ?? '',
      expiresAt!,
      CosUser.fromJson(uj),
    );
    onSession?.call(s);
    return s;
  }

  /// 登录并缓存令牌。
  Future<CosUser> login(String username, String password) async {
    // 带上设备名和平台，「登录设备」列表里才不会显示「未知设备」
    final data = await _call('POST', '/auth/login',
        body: {'username': username, 'password': password, 'device_name': localDeviceName(), 'platform': localPlatform()},
        auth: false);
    return _applySession(data).user;
  }

  /// 用保存的 refresh_token 恢复登录（自动登录）。失败抛 401。
  Future<CosUser> resume(String refresh) async {
    final data = await _send('POST', '/auth/refresh', body: {'refresh_token': refresh});
    return _applySession(data).user;
  }

  /// 刷新令牌（并发调用共享同一次请求；refresh_token 每用一次即轮换）。
  Future<bool> refresh() {
    final rt = refreshToken;
    if (rt == null) return Future.value(false);
    return _refreshing ??= () async {
      try {
        final data = await _send('POST', '/auth/refresh', body: {'refresh_token': rt});
        _applySession(data);
        return true;
      } catch (_) {
        return false;
      } finally {
        _refreshing = null;
      }
    }();
  }

  /// 过期前 5 分钟内主动刷新。
  Future<void> ensureFreshToken() async {
    final exp = expiresAt;
    if (exp == null || refreshToken == null) return;
    if (exp.difference(DateTime.now()) < const Duration(minutes: 5)) {
      if (!await refresh()) onAuthLost?.call();
    }
  }

  /// 吊销 refresh_token；失败不影响退出。
  Future<void> logout() async {
    final rt = refreshToken;
    accessToken = null;
    refreshToken = null;
    if (rt == null) return;
    try {
      await _send('POST', '/auth/logout', body: {'refresh_token': rt});
    } catch (_) {}
  }

  // ---------------- 用户 ----------------

  Future<CosUser> me() async => CosUser.fromJson(await _call('GET', '/users/me'));

  Future<List<CosUser>> listUsers({String? keyword}) =>
      _all('/users', CosUser.fromJson, query: {if (keyword != null) 'keyword': keyword, 'page_size': '500'});

  /// 修改自己的资料：普通成员只能改头像、签名、电话。
  Future<CosUser> updateMe({String? avatarUrl, String? statusText, String? phone}) async =>
      CosUser.fromJson(await _call('PATCH', '/users/me', body: {
        if (avatarUrl != null) 'avatar_url': avatarUrl.isEmpty ? null : avatarUrl,
        if (statusText != null) 'status_text': statusText.isEmpty ? null : statusText,
        if (phone != null) 'phone': phone.isEmpty ? null : phone,
      }));

  /// 管理员：添加成员。
  Future<CosUser> adminCreateUser(Map<String, dynamic> body) async =>
      CosUser.fromJson(await _call('POST', '/users', body: body));

  /// 管理员：修改成员资料 / 重置密码 / 禁用。
  Future<CosUser> adminUpdateUser(String userId, Map<String, dynamic> body) async =>
      CosUser.fromJson(await _call('PATCH', '/users/${Uri.encodeComponent(userId)}', body: body));

  // ---------------- 会话 ----------------

  Future<List<CosChat>> listChats() => _all('/chats', CosChat.fromJson, query: {'page_size': '200'});

  Future<CosChat> getChat(String chatId) async => CosChat.fromJson(await _call('GET', '/chats/$chatId'));

  /// 创建会话。单聊（p2p）对同一个人去重，已存在时返回原会话。
  Future<CosChat> createChat({
    String chatType = 'group',
    String? name,
    required List<String> memberIds,
    String? description,
  }) async {
    final data = await _call('POST', '/chats', body: {
      'chat_type': chatType,
      if (name != null && name.isNotEmpty) 'name': name,
      'member_ids': memberIds,
      if (description != null && description.isNotEmpty) 'description': description,
    });
    return CosChat.fromJson(data);
  }

  Future<CosChat> updateChat(String chatId, {String? name, String? description}) async =>
      CosChat.fromJson(await _call('PATCH', '/chats/$chatId', body: {
        if (name != null) 'name': name,
        if (description != null) 'description': description.isEmpty ? null : description,
      }));

  Future<CosChat> addMembers(String chatId, List<String> userIds) async =>
      CosChat.fromJson(await _call('POST', '/chats/$chatId/members', body: {'member_ids': userIds}));

  /// 移除成员；userId 是自己表示退群。
  Future<void> removeMember(String chatId, String userId) async =>
      _call('DELETE', '/chats/$chatId/members/${Uri.encodeComponent(userId)}');

  Future<CosChat> updateChatSettings(String chatId, {bool? pinned, bool? muted}) async =>
      CosChat.fromJson(await _call('PATCH', '/chats/$chatId/settings', body: {
        if (pinned != null) 'pinned': pinned,
        if (muted != null) 'muted': muted,
      }));

  // ---------------- 消息 ----------------

  /// 默认与 [beforeMessageId] 时最新在前；[afterMessageId] 时按时间正序。
  Future<CosPage<CosMessage>> listMessages(
    String chatId, {
    String? beforeMessageId,
    String? afterMessageId,
    int pageSize = 50,
  }) async {
    final data = await _call('GET', '/chats/$chatId/messages', query: {
      if (beforeMessageId != null) 'before_message_id': beforeMessageId,
      if (afterMessageId != null) 'after_message_id': afterMessageId,
      'page_size': '$pageSize',
    });
    return _page(data, CosMessage.fromJson);
  }

  Future<CosMessage> sendMessage(
    String chatId,
    String msgType,
    Map<String, dynamic> content, {
    String? clientMsgId,
    String? replyToMessageId,
    String? threadRootId,
    bool alsoSendToChat = false,
  }) async {
    final data = await _call('POST', '/chats/$chatId/messages', body: {
      'msg_type': msgType,
      'content': content,
      'client_msg_id': clientMsgId ?? newClientMsgId(),
      if (replyToMessageId != null) 'reply_to_message_id': replyToMessageId,
      if (threadRootId != null) 'thread_root_id': threadRootId,
      if (threadRootId != null && alsoSendToChat) 'also_send_to_chat': true,
    });
    return CosMessage.fromJson(data);
  }

  Future<CosMessage> sendText(String chatId, String text,
          {List<Map<String, String>> mentions = const [], String? replyToMessageId, String? threadRootId, bool alsoSendToChat = false}) =>
      sendMessage(chatId, 'text', {'text': text, if (mentions.isNotEmpty) 'mentions': mentions},
          replyToMessageId: replyToMessageId, threadRootId: threadRootId, alsoSendToChat: alsoSendToChat);

  /// 标记已读；[messageId] 为空表示读到最新一条。
  Future<void> markRead(String chatId, {String? messageId}) async =>
      _call('POST', '/chats/$chatId/read', body: {if (messageId != null) 'message_id': messageId});

  Future<CosMessage> recallMessage(String messageId) async =>
      CosMessage.fromJson(await _call('POST', '/messages/$messageId/recall'));

  Future<CosMessage> editMessage(String messageId, String text) async =>
      CosMessage.fromJson(await _call('PATCH', '/messages/$messageId', body: {
        'content': {'text': text}
      }));

  Future<CosPage<CosMessageHit>> searchMessages(String keyword, {String? chatId, int pageSize = 20, String? pageToken}) async {
    final data = await _call('GET', '/messages/search', query: {
      'keyword': keyword,
      if (chatId != null) 'chat_id': chatId,
      'page_size': '$pageSize',
      if (pageToken != null) 'page_token': pageToken,
    });
    return _page(data, CosMessageHit.fromJson);
  }

  /// 卡片交互回调（ask_user_question 回答）。已回答返回 409（code CARD_ANSWERED，data 带 answer）。
  Future<void> answerCard(String cardId, String action, {Map<String, dynamic>? formValues}) async {
    await _call('POST', '/cards/$cardId/actions', body: {
      'action': action,
      if (formValues != null) 'form_values': formValues,
    });
  }

  // ---------------- 文件（预签名直传） ----------------

  /// 上传字节，返回文件引用（可直接作为 file / image 消息 content）。
  /// [ref] 二期：把文件绑定到对象（如 {type: doc, id: doc_xxx}），能看这个对象的人就能看文件。
  Future<CosFileRef> uploadBytes(String fileName, Uint8List bytes, {String? contentType, Map<String, String>? ref}) async {
    final grant = await _call('POST', '/files/upload-url', body: {
      'file_name': fileName,
      'size': bytes.length,
      if (contentType != null) 'content_type': contentType,
      if (ref != null) 'ref': ref,
    });
    final uploadUrl = grant['upload_url'] as String;
    final http.Response res;
    try {
      res = await _http.put(
        Uri.parse(absolute(uploadUrl)),
        headers: {'Content-Type': 'application/octet-stream'},
        body: bytes,
      );
    } catch (e) {
      throw CosApiException(0, e.toString());
    }
    if (res.statusCode >= 400) {
      String msg = '上传失败（HTTP ${res.statusCode}）';
      try {
        final m = jsonDecode(utf8.decode(res.bodyBytes));
        if (m is Map && m['message'] != null) msg = m['message'].toString();
      } catch (_) {}
      throw CosApiException(res.statusCode, msg);
    }
    return CosFileRef(
      fileKey: grant['file_key'] as String,
      fileName: fileName,
      size: bytes.length,
      contentType: contentType,
    );
  }

  /// 换取带签名的绝对下载地址；[attachment] 为 true 时强制下载而不是在浏览器里预览。
  Future<String> downloadUrl(String fileKey, {bool attachment = false}) async {
    final data = await _call('GET', '/files/${Uri.encodeComponent(fileKey)}/download-url',
        query: {if (attachment) 'disposition': 'attachment'});
    return absolute(data['download_url'] as String);
  }

  /// 云盘文件列表。scope：all | mine | shared；kind：image | doc | pdf | sheet | slide | other。
  Future<CosPage<CosDriveFile>> listFiles({
    String scope = 'all',
    String? kind,
    String? keyword,
    int pageSize = 100,
    String? pageToken,
  }) async {
    final data = await _call('GET', '/files', query: {
      'scope': scope,
      if (kind != null) 'kind': kind,
      if (keyword != null && keyword.isNotEmpty) 'keyword': keyword,
      'page_size': '$pageSize',
      if (pageToken != null) 'page_token': pageToken,
    });
    return _page(data, CosDriveFile.fromJson);
  }

  /// 空间用量（字节）。
  Future<({int used, int quota})> fileUsage() async {
    final data = await _call('GET', '/files/usage');
    return (used: (data['used'] as num?)?.toInt() ?? 0, quota: (data['quota'] as num?)?.toInt() ?? 0);
  }

  Future<CosDriveFile> addToDrive(String fileKey) async =>
      CosDriveFile.fromJson(await _call('POST', '/files/${Uri.encodeComponent(fileKey)}/drive'));

  /// 删除：会话 / 表格里还引用着就只移出云盘。
  Future<void> deleteFile(String fileKey) async => _call('DELETE', '/files/${Uri.encodeComponent(fileKey)}');

  // ---------------- 表格引擎 ----------------

  Future<List<CosTableMeta>> listTables() async => _items(await _call('GET', '/tables'), CosTableMeta.fromJson);

  /// 新建数据表；201 为新建成功，200 为幂等重试命中。
  Future<CosTableMeta> createTable({
    required String name,
    String? description,
    required String primaryField,
    required List<Map<String, dynamic>> fields,
    String? clientRequestId,
  }) async {
    final data = await _call('POST', '/tables', body: {
      'name': name,
      if (description != null && description.isNotEmpty) 'description': description,
      'primary_field': primaryField,
      'fields': fields,
      if (clientRequestId != null) 'client_request_id': clientRequestId,
    });
    return CosTableMeta.fromJson(data);
  }

  Future<CosPage<CosRecord>> listRecords(
    String tableKey, {
    String? filter,
    String? sort,
    String? keyword,
    int pageSize = 500,
    String? pageToken,
  }) async {
    final data = await _call('GET', '/tables/$tableKey/records', query: {
      if (filter != null) 'filter': filter,
      if (sort != null) 'sort': sort,
      if (keyword != null && keyword.isNotEmpty) 'keyword': keyword,
      'page_size': '$pageSize',
      if (pageToken != null) 'page_token': pageToken,
    });
    return _page(data, CosRecord.fromJson);
  }

  /// 拉取全部记录（按 page_token 翻页，最多 [maxRecords] 条）。
  Future<({List<CosRecord> items, int total})> listAllRecords(String tableKey,
      {String? keyword, int maxRecords = 10000}) async {
    final out = <CosRecord>[];
    String? token;
    int total = 0;
    while (out.length < maxRecords) {
      final p = await listRecords(tableKey, keyword: keyword, pageToken: token);
      out.addAll(p.items);
      total = p.total ?? out.length;
      if (!p.hasMore || p.pageToken == null) break;
      token = p.pageToken;
    }
    return (items: out, total: total);
  }

  Future<CosRecord> createRecord(String tableKey, Map<String, dynamic> fields) async =>
      CosRecord.fromJson(await _call('POST', '/tables/$tableKey/records', body: {'fields': fields}));

  Future<CosRecord> updateRecord(String tableKey, String recordId, Map<String, dynamic> fields) async =>
      CosRecord.fromJson(await _call('PATCH', '/tables/$tableKey/records/$recordId', body: {'fields': fields}));

  Future<void> deleteRecord(String tableKey, String recordId) async =>
      _call('DELETE', '/tables/$tableKey/records/$recordId');

  // ---------------- 日历 ----------------

  Future<List<CosCalendarEvent>> listEvents(DateTime from, DateTime to, {String? userId, bool expandRecurring = false}) async {
    final data = await _call('GET', '/calendar/events', query: {
      (expandRecurring ? 'start_ms' : 'from'): '${from.millisecondsSinceEpoch}',
      (expandRecurring ? 'end_ms' : 'to'): '${to.millisecondsSinceEpoch}',
      if (userId != null) 'user_id': userId,
    });
    return _items(data, CosCalendarEvent.fromJson);
  }

  Map<String, dynamic> _eventBody({
    String? title,
    DateTime? start,
    DateTime? end,
    List<String>? attendeeIds,
    String? description,
    String? location,
    bool? allDay,
    String? color,
    List<int>? reminders,
    String? recurrence,
    bool clearRecurrence = false,
  }) =>
      {
        if (recurrence != null || clearRecurrence) 'recurrence': recurrence,
        if (title != null) 'title': title,
        if (start != null) 'start_ms': start.millisecondsSinceEpoch,
        if (end != null) 'end_ms': end.millisecondsSinceEpoch,
        if (attendeeIds != null) 'attendee_ids': attendeeIds,
        if (description != null) 'description': description.isEmpty ? null : description,
        if (location != null) 'location': location.isEmpty ? null : location,
        if (allDay != null) 'all_day': allDay,
        if (color != null) 'color': color.isEmpty ? null : color,
        if (reminders != null) 'reminders': reminders,
      };

  Future<CosCalendarEvent> createEvent({
    required String title,
    required DateTime start,
    required DateTime end,
    List<String> attendeeIds = const [],
    String? description,
    String? location,
    bool allDay = false,
    String? color,
    List<int>? reminders,
    String? recurrence,
    bool clearRecurrence = false,
    String? scope,
  }) async =>
      CosCalendarEvent.fromJson(await _call('POST', '/calendar/events',
          body: _eventBody(
            title: title,
            start: start,
            end: end,
            attendeeIds: attendeeIds,
            description: description,
            location: location,
            allDay: allDay,
            color: color,
            reminders: reminders,
            recurrence: recurrence, clearRecurrence: clearRecurrence,
          )));

  /// 修改日程（仅创建者）。传入的字段才会修改；空字符串表示清空。
  Future<CosCalendarEvent> updateEvent(
    String eventId, {
    String? title,
    DateTime? start,
    DateTime? end,
    List<String>? attendeeIds,
    String? description,
    String? location,
    bool? allDay,
    String? color,
    List<int>? reminders,
    String? recurrence,
    bool clearRecurrence = false,
    String? scope,
  }) async =>
      CosCalendarEvent.fromJson(await _call('PATCH', '/calendar/events/$eventId',
          query: {if (scope != null) 'scope': scope},
          body: _eventBody(
            title: title,
            start: start,
            end: end,
            attendeeIds: attendeeIds,
            description: description,
            location: location,
            allDay: allDay,
            color: color,
            reminders: reminders,
            recurrence: recurrence, clearRecurrence: clearRecurrence,
          )));

  /// 回复邀请：accepted | declined | tentative。
  Future<CosCalendarEvent> rsvpEvent(String eventId, String rsvp) async =>
      CosCalendarEvent.fromJson(await _call('POST', '/calendar/events/$eventId/rsvp', body: {'rsvp': rsvp}));

  Future<void> deleteEvent(String eventId, {String? scope}) async => _call('DELETE', '/calendar/events/$eventId', query: {if (scope != null) 'scope': scope});

  // ---------------- 任务 ----------------

  /// [assigneeId] / [createdBy] 可传 `me`。
  Future<List<CosTask>> listTasks({String? assigneeId, String? createdBy, String? status, String? followerId, bool includeSubtasks = false}) async {
    final data = await _call('GET', '/tasks', query: {
      if (assigneeId != null) 'assignee_id': assigneeId,
      if (createdBy != null) 'created_by': createdBy,
      if (followerId != null) 'follower_id': followerId,
      if (includeSubtasks) 'include_subtasks': 'true',
      if (status != null) 'status': status,
    });
    return _items(data, CosTask.fromJson);
  }

  Future<CosTask> createTask({
    required String title,
    String? parentId,
    String? assigneeId,
    DateTime? due,
    String? description,
    String? priority,
  }) async =>
      CosTask.fromJson(await _call('POST', '/tasks', body: {
        'title': title,
        if (parentId != null) 'parent_id': parentId,
        if (assigneeId != null) 'assignee_id': assigneeId,
        if (due != null) 'due_ms': due.millisecondsSinceEpoch,
        if (description != null && description.isNotEmpty) 'description': description,
        if (priority != null) 'priority': priority,
      }));

  /// 修改任务。[clearDue] / [clearAssignee] 为 true 时清空对应字段。
  Future<CosTask> updateTask(
    String taskId, {
    String? title,
    String? status,
    DateTime? due,
    bool clearDue = false,
    String? assigneeId,
    bool clearAssignee = false,
    String? description,
    String? priority,
  }) async =>
      CosTask.fromJson(await _call('PATCH', '/tasks/$taskId', body: {
        if (title != null) 'title': title,
        if (status != null) 'status': status,
        if (clearDue) 'due_ms': null else if (due != null) 'due_ms': due.millisecondsSinceEpoch,
        if (clearAssignee) 'assignee_id': null else if (assigneeId != null) 'assignee_id': assigneeId,
        if (description != null) 'description': description.isEmpty ? null : description,
        if (priority != null) 'priority': priority,
      }));

  Future<void> deleteTask(String taskId) async => _call('DELETE', '/tasks/$taskId');

  // ---------------- 文档 ----------------

  /// scope：all | mine | shared。按 updated_at 倒序。
  Future<List<CosDoc>> listDocs({String scope = 'all', String? keyword}) =>
      _all('/docs', CosDoc.fromJson, query: {
        'scope': scope,
        if (keyword != null && keyword.isNotEmpty) 'keyword': keyword,
        'page_size': '200',
      });

  Future<CosDoc> getDoc(String docId) async => CosDoc.fromJson(await _call('GET', '/docs/$docId'));

  Future<CosDoc> createDoc(String title, String markdown) async =>
      CosDoc.fromJson(await _call('POST', '/docs', body: {'title': title, 'markdown': markdown}));

  /// 修改文档。带 [baseUpdatedAt] 时做并发保护：被他人改过返回 409（code DOC_CONFLICT，data.doc 为最新）。
  Future<CosDoc> updateDoc(String docId, {String? title, String? markdown, String? baseUpdatedAt}) async =>
      CosDoc.fromJson(await _call('PATCH', '/docs/$docId', body: {
        if (title != null) 'title': title,
        if (markdown != null) 'markdown': markdown,
        if (baseUpdatedAt != null) 'base_updated_at': baseUpdatedAt,
      }));

  Future<void> deleteDoc(String docId) async => _call('DELETE', '/docs/$docId');

  // ---------------- 报表 ----------------

  Future<Map<String, dynamic>> dashboardSummary() => _call('GET', '/dashboard/summary');

  /// 通用 GET（轻量入口）。
  Future<Map<String, dynamic>> rawGet(String path) => _call('GET', path);
}
