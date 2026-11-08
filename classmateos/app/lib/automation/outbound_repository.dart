/// 当前有限协议的适配器。未知摘要/权限保持缺失，禁止推断可审批。
library;

import '../api_client.dart';
import 'outbound_api.dart';
import 'outbound_models.dart';
import 'outbound_errors.dart';
import 'dart:convert';

Map<String, dynamic> _map(dynamic v) =>
    v is Map ? Map<String, dynamic>.from(v) : {};
String _str(dynamic v) => v is String ? v : '';
int _int(dynamic v) => v is int ? v : 0;

class HttpOutboundRepository extends OutboundRepository {
  final OutboundApi api;
  final String actorId;
  HttpOutboundRepository(this.api, {required this.actorId});

  OutboundDraft decode(AutomationRecord record) {
    final j = record.json, s = _map(j['spec']);
    final recipients = _map(s['recipients']);
    final task = _map(j['task']), principal = _map(j['principal']);
    final permissions = _map(j['permissions']);
    final displayTargets = (j['targets'] as List? ?? []).map(_map).toList();
    final displayResources = (j['resources'] as List? ?? []).map(_map).toList();
    final reasons = (permissions['approveBlockedReasons'] as List? ?? []);
    String resourceName(dynamic value) {
      final r = _map(value);
      final matches = displayResources.where(
        (x) => x['type'] == r['type'] && x['resourceId'] == r['resourceId'],
      );
      // 无权查看或不存在时后端返回 null：保持为空，界面明确显示“仅 ID”。
      return matches.isEmpty ? '' : _str(matches.first['displayName']);
    }

    final output = _map(s['output']), limits = _map(s['limits']);
    final targets = <OutboundTarget>[];
    for (final value in (recipients['targets'] as List? ?? [])) {
      final t = _map(value);
      final type = switch (t['type']) {
        'chat' => 'chat_id',
        'user' => 'user_id',
        _ => 'unknown',
      };
      final matches = displayTargets.where(
        (x) => x['type'] == t['type'] && x['id'] == t['id'],
      );
      final display = matches.isEmpty ? <String, dynamic>{} : matches.first;
      targets.add(
        OutboundTarget(
          type,
          _str(t['id']),
          _str(display['displayName']),
          [
            if (display['exists'] == false) '目标已不存在',
            if (t['type'] == 'chat')
              '群类型：${display['chatType'] ?? "未知"} / 成员数：${display['memberCount'] ?? "未知"}',
            if (t['type'] == 'user')
              '${display['department'] ?? ""} ${display['title'] ?? ""} / 账号${display['active'] == true ? "有效" : "状态未知或失效"}',
          ].join('；'),
        ),
      );
    }
    final mode = _str(output['mode']);
    final resultChatId = _str(task['resultChatId']);
    final resultMatches = targets.where(
      (t) => t.type == 'chat_id' && t.id == resultChatId,
    );
    return OutboundDraft(
      draftId: record.draftId,
      digest: record.digest,
      version: record.version,
      taskKind: _str(s['taskKind']),
      taskId: _str(s['taskId']),
      revision: _str(s['taskRevision']),
      name: _str(task['name']).isEmpty ? _str(s['taskId']) : _str(task['name']),
      principalId: _str(s['principalId']),
      principalLabel: _str(principal['name']).isEmpty
          ? '执行账号'
          : _str(principal['name']),
      approverId: actorId,
      // 不用旧任务接口拼接未经摘要绑定的安全配置。
      schedule: _str(task['cron']),
      timezone: _str(task['scheduleTimezone']),
      enabled: task['enabled'] == true || j['taskEnabled'] == true,
      enabledKnown: task['enabled'] is bool || j['taskEnabled'] is bool,
      canApprove:
          permissions['canApprove'] == true &&
          task['revisionMatches'] == true &&
          task['event'] == 'schedule',
      canRevoke: permissions['canRevoke'] == true,
      approvalReason: reasons.isNotEmpty
          ? reasons.map((r) => outboundErrorText[r] ?? r.toString()).join('；')
          : null,
      serviceAccount:
          principal['accountType'] != null &&
          principal['accountType'] != 'user',
      taskSummary: task.isEmpty
          ? ''
          : '任务指令：${task['prompt'] ?? "无"}\n条件：${task['condition'] ?? "无"}\n事件：${task['event'] ?? "未知"}\n过滤：${jsonEncode(task['filter'])}\n冷却秒数：${task['cooldownSec'] ?? "未知"}',
      resultTarget: resultChatId.isEmpty
          ? null
          : resultMatches.isNotEmpty
          ? resultMatches.first
          : OutboundTarget('chat_id', resultChatId, '', '结果投递群（未列入授权目标）'),
      outputMode: mode,
      template: mode == 'protected_doc_link' ? '保留访问控制的文档链接（无正文）' : '',
      confidentiality: '消息授权不扩大文档访问权限；禁止附带正文及敏感摘要',
      status: record.status,
      quotaTimezone: _str(limits['timezone']),
      targets: targets,
      dynamicRecipients: recipients['kind'] != 'fixed',
      resources: [
        for (final value in (s['resources'] as List? ?? []))
          OutboundResource(
            _str(_map(value)['type']),
            _str(_map(value)['resourceId']),
            resourceName(value),
            [for (final f in (_map(value)['fields'] as List? ?? [])) _str(f)],
          ),
      ],
      perRun: _int(limits['perRun']),
      perDay: _int(limits['perDay']),
      perTarget: _int(limits['perTargetPerRun']),
      perTargetPerDay: _int(limits['perTargetPerDay']),
      grantId: j['grantId'] as String?,
      approvedBy: j['approvedBy'] as String?,
      validUntil: DateTime.tryParse(_str(s['expiresAt'])),
      draftExpiresAt: record.draftExpiresAt,
      deliveryEnabled: record.deliveryEnabled,
    );
  }

  @override
  Future<OutboundCapabilities> capabilities() async {
    final c = await api.capabilities();
    return OutboundCapabilities(
      approval: c.approval && c.draftDetail && c.approveEnablesTask,
      fixedTargets: c.fixedTargetDelivery && c.schedule,
      outputModes: {if (c.protectedDocLink) 'protected_doc_link'},
      recognized: c.recognized,
      runQuery: c.runQuery,
      notes: capabilityNotes(c),
      unsupported: unsupportedFeatures(c),
    );
  }

  @override
  Future<OutboundPage<OutboundDraft>> tasks({String? cursor}) async {
    final p = await api.drafts(cursor: cursor);
    return OutboundPage(p.items.map(decode).toList(), nextCursor: p.nextCursor);
  }

  Future<AutomationRecord> _find(
    bool Function(AutomationRecord) matches,
  ) async {
    String? cursor;
    final seen = <String>{};
    do {
      final p = await api.drafts(cursor: cursor);
      for (final r in p.items) {
        if (matches(r)) return r;
      }
      cursor = p.nextCursor;
      if (cursor != null && !seen.add(cursor)) throw StateError('分页游标重复，请刷新');
    } while (cursor != null);
    throw const CosApiException(404, '草稿已不存在或不可见，请刷新', code: 'NOT_FOUND');
  }

  @override
  Future<OutboundDraft> latest(String taskKind, String taskId) async => decode(
    await _find((r) {
      final s = _map(r.json['spec']);
      return s['taskKind'] == taskKind && s['taskId'] == taskId;
    }),
  );

  @override
  Future<OutboundDraft> latestDraft(OutboundDraft reviewed) async =>
      decode(await api.detail(reviewed.draftId));

  @override
  Future<OutboundDraft> approve(
    OutboundDraft reviewed, {
    required String expectedRevision,
    required int expectedVersion,
    required String expectedDigest,
    required Set<String> selectedTargetKeys,
  }) async {
    final r = await api.detail(reviewed.draftId);
    final d = decode(r);
    if (d.revision != expectedRevision ||
        d.version != expectedVersion ||
        d.digest != expectedDigest) {
      throw const CosApiException(409, '配置已变化，请重新审阅', code: 'DRAFT_STALE');
    }
    final block = d.approvalBlock(await capabilities(), DateTime.now());
    if (block != null) throw StateError(block);
    if (selectedTargetKeys.length != d.targets.length ||
        !d.targets.every((t) => selectedTargetKeys.contains(t.key))) {
      throw StateError('必须逐项确认全部固定目标');
    }
    await api.approve(r, enableTask: !d.enabled);
    return decode(await api.detail(r.draftId));
  }

  @override
  Future<OutboundDraft> revoke(OutboundDraft reviewed) async {
    final r = await api.detail(reviewed.draftId);
    if (r.version != reviewed.version || r.digest != reviewed.digest) {
      throw const CosApiException(409, '草稿已变化，请刷新后重新确认撤销', code: 'DRAFT_STALE');
    }
    if (_map(r.json['permissions'])['canRevoke'] != true) {
      throw const CosApiException(403, '没有撤销权限', code: 'PERMISSION_DENIED');
    }
    await api.revoke(r);
    return decode(await api.detail(r.draftId));
  }

  @override
  Future<OutboundPage<OutboundRun>> runs(
    String taskKind,
    String taskId, {
    String? cursor,
  }) async {
    if (!(await api.capabilities()).runQuery) {
      throw UnsupportedError('当前协议不支持运行结果查询');
    }
    final page = await api.runs(taskKind, taskId, cursor: cursor);
    return OutboundPage([
      for (final value in page['items'] as List) decodeRun(_map(value)),
    ], nextCursor: page['page_token'] as String?);
  }

  @override
  Future<OutboundRun> runDetail(String runId) async {
    if (!(await api.capabilities()).runQuery) {
      throw UnsupportedError('当前协议不支持运行结果查询');
    }
    return decodeRun(await api.runDetail(runId));
  }

  OutboundRun decodeRun(Map<String, dynamic> j) {
    String? opt(dynamic v) => v is String && v.isNotEmpty ? v : null;
    final deliveries = <OutboundDelivery>[];
    for (final value in (j['deliveries'] as List? ?? [])) {
      final d = _map(value), t = _map(d['target']);
      final later = _map(d['laterAttempt']);
      deliveries.add(
        OutboundDelivery(
          OutboundTarget(
            switch (t['type']) {
              'chat' => 'chat_id',
              'user' => 'user_id',
              _ => 'unknown',
            },
            _str(t['id']),
            _str(t['displayName']),
            '',
          ),
          // 未知状态原样保留，不归为成功。
          _str(d['status']).isEmpty ? 'unknown' : _str(d['status']),
          reason: opt(d['code']),
          messageId: opt(d['messageId']),
          logicalMessageId: opt(d['logicalMessageId']),
          docId: opt(d['docId']),
          purpose: opt(d['purpose']),
          updatedAt: DateTime.tryParse(_str(d['updatedAt'])),
          retryable: d['retryable'] == true,
          laterAttempt: later.isEmpty
              ? null
              : OutboundLaterAttempt(
                  runId: _str(later['runId']),
                  status: opt(later['status']) ?? 'unknown',
                  code: opt(later['code']),
                  messageId: opt(later['messageId']),
                  at: DateTime.tryParse(_str(later['at'])),
                ),
        ),
      );
    }
    return OutboundRun(
      _str(j['runId']),
      _str(j['status']).isEmpty ? 'unknown' : _str(j['status']),
      deliveries,
      documentCreated: j['documentCreated'] == true,
      grantId: opt(j['grantId']),
      taskRevision: opt(j['taskRevision']),
      occurrenceId: opt(j['occurrenceId']),
      startedAt: DateTime.tryParse(_str(j['startedAt'])),
      finishedAt: DateTime.tryParse(_str(j['finishedAt'])),
    );
  }
}

/// 按能力逐项给出“为什么这项操作关着”，不笼统说后端缺接口。
List<String> capabilityNotes(AutomationCapabilities c) {
  if (!c.recognized) {
    return [
      '后端协议版本（${c.json['protocolVersion'] ?? '未返回'}）前端无法识别，已关闭全部授权操作；这不代表后端缺少接口，请升级前端或与后端核对版本。',
    ];
  }
  return [
    if (!c.drafts || !c.protectedDocLinkDraft) '后端未开放文档链接草稿，暂不能新建草稿。',
    if (!c.approval || !c.draftDetail || !c.approveEnablesTask)
      '后端审批能力不完整（审批 / 草稿详情 / 授权并启用），暂不能审批。',
    if (!c.fixedTargetDelivery || !c.schedule || !c.protectedDocLink)
      '服务端未配置自动化调度器（或未开放定时固定目标投递），批准后也不会自动发送，因此暂不开放审批。已有授权可查看、可撤销。',
    if (!c.runQuery) '后端未开放运行记录查询，运行结果暂不可见（不是“没运行过”）。',
  ];
}

/// 后端明确报告不支持的能力，界面标“不支持”，不显示为加载中或普通失败。
List<String> unsupportedFeatures(AutomationCapabilities c) {
  if (!c.recognized) return const [];
  final j = c.json;
  final trigger = j['taskKinds'] is Map
      ? _map(j['taskKinds'])['trigger']
      : null;
  return [
    if (trigger is! Map || trigger['events'] != true) '事件触发任务',
    if (j['scheduler'] != true) '独立 scheduler 任务',
    if (j['dynamicRecipients'] != true) '动态收件人（负责人 / 借用人规则）',
    if (j['controlledTemplate'] != true) '受控通知模板',
    if (j['aiText'] != true || j['restrictedRead'] != true) '限定资料的 AI 正文',
    if (j['draftEditing'] != true) '编辑草稿 / 安全差异对比',
    if (j['migration'] != true) '旧任务集中补授权',
    if (j['serviceAccounts'] != true) '服务账号任务（管理员审批）',
  ];
}
