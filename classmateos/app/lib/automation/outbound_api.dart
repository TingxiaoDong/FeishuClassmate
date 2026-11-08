/// 对齐 routes-automation-authorization.ts 当前实际路由。
/// 此层不伪造任务摘要、不调用尚不存在的运行接口、不代表发送已上线。
library;

import '../api_client.dart';

/// 测试环境开关：`--dart-define=COS_AUTOMATION_AUTH_PREVIEW=true`。只决定入口是否可见。
const kOutboundPreview = bool.fromEnvironment('COS_AUTOMATION_AUTH_PREVIEW');

/// 正式入口：未通过三端验收前服务端不下发 automation.authorization，入口保持关闭。
/// 入口可见不等于可操作：审批、投递仍由 /automation/capabilities 与 deliveryEnabled 决定，前端不硬编码。
bool outboundEntryVisible(
  bool serverFeature, {
  bool preview = kOutboundPreview,
}) => serverFeature || preview;

class AutomationCapabilities {
  final Map<String, dynamic> json;
  AutomationCapabilities.fromJson(this.json);
  bool get recognized => json['protocolVersion'] == '2026-10-21.1';
  bool has(String key) => recognized && json[key] == true;
  bool get drafts => has('drafts');
  bool get draftDetail => has('draftDetail');
  bool get approval => has('approval');
  bool get approveEnablesTask => has('approveEnablesTask');
  bool get runQuery => has('runQuery');
  bool get fixedTargetDelivery => has('fixedTargetDelivery');
  bool get protectedDocLinkDraft => has('protectedDocLinkDraft');
  bool get protectedDocLink => has('protectedDocLink');
  bool get schedule =>
      recognized &&
      json['taskKinds'] is Map &&
      json['taskKinds']['trigger'] is Map &&
      json['taskKinds']['trigger']['schedule'] == true;
}

class AutomationRecord {
  final Map<String, dynamic> json;
  AutomationRecord(Map<String, dynamic> value)
    : json = Map.unmodifiable(value) {
    if (value['draftId'] is! String ||
        (value['draftId'] as String).isEmpty ||
        value['version'] is! int ||
        (value['version'] as int) < 1 ||
        value['draftDigest'] is! String ||
        value['spec'] is! Map) {
      throw const FormatException('授权响应缺少草稿、版本或摘要');
    }
  }
  String get draftId => json['draftId'] as String;
  String get digest => json['draftDigest'] as String;
  int get version => json['version'] as int;
  String get status =>
      (json['effectiveStatus'] ?? json['status'] ?? 'unknown').toString();
  bool get deliveryEnabled => json['deliveryEnabled'] == true;
  bool get sendingReady => status == 'active' && deliveryEnabled;
  DateTime? get draftExpiresAt =>
      DateTime.tryParse(json['draftExpiresAt']?.toString() ?? '');
}

class AutomationRecordPage {
  final List<AutomationRecord> items;
  final String? nextCursor;
  AutomationRecordPage(Map<String, dynamic> json)
    : items = (json['items'] as List)
          .map((v) => AutomationRecord(Map<String, dynamic>.from(v as Map)))
          .toList(),
      nextCursor = json['page_token'] as String?;
}

class OutboundApi {
  final CosApiClient api;
  const OutboundApi(this.api);
  Future<AutomationCapabilities> capabilities() async =>
      AutomationCapabilities.fromJson(
        await api.request('GET', '/automation/capabilities'),
      );
  Future<AutomationRecordPage> drafts({
    String? cursor,
    int pageSize = 50,
  }) async {
    if (pageSize < 1 || pageSize > 100) {
      throw ArgumentError.value(pageSize, 'pageSize');
    }
    return AutomationRecordPage(
      await api.request(
        'GET',
        '/automation/drafts',
        query: {
          'page_size': '$pageSize',
          if (cursor != null) 'page_token': cursor,
        },
      ),
    );
  }

  Future<AutomationRecord> detail(String draftId) async => AutomationRecord(
    await api.request(
      'GET',
      '/automation/drafts/${Uri.encodeComponent(draftId)}',
    ),
  );

  Future<Map<String, dynamic>> runs(
    String taskKind,
    String taskId, {
    String? cursor,
  }) => api.request(
    'GET',
    '/automation/runs',
    query: {
      'taskKind': taskKind,
      'taskId': taskId,
      'page_size': '50',
      if (cursor != null) 'page_token': cursor,
    },
  );

  /// 当前用户自己的已有自动化任务（受限试用：只为已有定时任务授权）。
  Future<List<Map<String, dynamic>>> triggers() async {
    final r = await api.request('GET', '/agent/triggers');
    return [
      for (final v in (r['items'] as List? ?? []))
        if (v is Map) Map<String, dynamic>.from(v),
    ];
  }

  Future<Map<String, dynamic>> runDetail(String runId) =>
      api.request('GET', '/automation/runs/${Uri.encodeComponent(runId)}');

  /// 当前服务端只支持已有 trigger 的受保护文档链接草稿。
  /// 执行身份和 taskRevision 必须由后端计算，不能从 UI 传入。
  Future<AutomationRecord> createDocLinkDraft({
    required String taskId,
    required List<({String type, String id})> targets,
    required List<String> docIds,
    required int perRun,
    required int perDay,
    required int perTargetPerRun,
    required int perTargetPerDay,
    required DateTime expiresAt,
  }) async {
    if (taskId.isEmpty ||
        targets.isEmpty ||
        docIds.isEmpty ||
        targets.any(
          (t) => !{'chat', 'user'}.contains(t.type) || t.id.isEmpty,
        ) ||
        docIds.any((id) => id.isEmpty)) {
      throw ArgumentError('任务、固定目标和资料不能为空');
    }
    if (targets.length > 100 ||
        docIds.length > 100 ||
        targets.map((t) => '${t.type}:${t.id}').toSet().length !=
            targets.length ||
        docIds.toSet().length != docIds.length ||
        perRun < 1 ||
        perRun > 1000 ||
        perDay < 1 ||
        perDay > 10000 ||
        perTargetPerRun < 1 ||
        perTargetPerDay < 1 ||
        perRun > perDay ||
        perTargetPerRun > perRun ||
        perTargetPerDay > perDay ||
        perTargetPerRun > perTargetPerDay ||
        !expiresAt.isAfter(DateTime.now())) {
      throw ArgumentError('目标/文档重复、额度上下限不一致或有效期已过');
    }
    return AutomationRecord(
      await api.request(
        'POST',
        '/automation/drafts',
        body: {
          'taskKind': 'trigger',
          'taskId': taskId,
          'recipients': {
            'kind': 'fixed',
            'targets': [
              for (final t in targets) {'type': t.type, 'id': t.id},
            ],
          },
          'resources': [
            for (final id in docIds) {'type': 'doc', 'resourceId': id},
          ],
          'output': {'mode': 'protected_doc_link', 'docIds': docIds},
          'limits': {
            'perRun': perRun,
            'perDay': perDay,
            'perTargetPerRun': perTargetPerRun,
            'perTargetPerDay': perTargetPerDay,
            'timezone': 'Asia/Shanghai',
          },
          'expiresAt': expiresAt.toUtc().toIso8601String(),
        },
      ),
    );
  }

  Future<AutomationRecord> approve(
    AutomationRecord reviewed, {
    bool enableTask = false,
  }) async {
    final expiry = reviewed.draftExpiresAt;
    if (reviewed.status != 'pending' ||
        expiry == null ||
        !expiry.isAfter(DateTime.now())) {
      throw const CosApiException(409, '草稿已过期或不再待审批，请刷新', code: 'DRAFT_STALE');
    }
    return AutomationRecord(
      await api.request(
        'POST',
        '/automation/drafts/${Uri.encodeComponent(reviewed.draftId)}/approve',
        body: {
          'expectedVersion': reviewed.version,
          'expectedDigest': reviewed.digest,
          if (enableTask) 'enableTask': true,
        },
      ),
    );
  }

  Future<AutomationRecord> revoke(AutomationRecord reviewed) async =>
      AutomationRecord(
        await api.request(
          'POST',
          '/automation/drafts/${Uri.encodeComponent(reviewed.draftId)}/revoke',
          body: {'expectedVersion': reviewed.version},
        ),
      );
}
