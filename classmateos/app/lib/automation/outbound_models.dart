/// 前端领域模型，不是已冻结的 HTTP 协议。禁止在此存放运行凭证。
library;

class OutboundTarget {
  final String type, id, name, identity;
  const OutboundTarget(this.type, this.id, this.name, this.identity);
  String get key => '$type:$id';

  /// 名称缺失（不存在或无权查看）时明确只显示稳定 ID，不能凭名称批准。
  bool get nameKnown => name.isNotEmpty && name != id;
  String get label => nameKnown ? name : '名称不可见（仅凭稳定 ID：$id）';
}

class OutboundResource {
  final String kind, id, name;
  final List<String> fields;
  const OutboundResource(this.kind, this.id, this.name, this.fields);
}

class OutboundCapabilities {
  final bool approval, fixedTargets, readIsolation;
  final Set<String> outputModes;
  const OutboundCapabilities({
    this.approval = false,
    this.fixedTargets = false,
    this.readIsolation = false,
    this.outputModes = const {},
    this.recognized = true,
    this.runQuery = true,
    this.notes = const [],
    this.unsupported = const [],
  });

  /// 已识别协议、能查运行记录；notes 是按能力逐项关闭时给用户的原因。
  final bool recognized, runQuery;
  final List<String> notes;
  final List<String> unsupported;
  bool supports(String mode) =>
      outputModes.contains(mode) && (mode != 'scoped_ai' || readIsolation);
}

class OutboundDraft {
  final String taskKind, taskId, revision, name, principalId, principalLabel;
  final String approverId,
      schedule,
      timezone,
      outputMode,
      template,
      confidentiality;
  final String status, quotaTimezone;
  final bool enabled, canApprove, serviceAccount, dynamicRecipients;
  final bool canRevoke;
  final String? approvalReason;
  final String taskSummary;
  final List<OutboundTarget> targets;
  final List<OutboundResource> resources;
  final OutboundTarget? resultTarget;
  final int perRun, perDay;
  final int? perTarget, perTargetPerDay;
  final String draftId, digest;
  final int version;
  final String? grantId, approvedBy;
  final DateTime? validUntil;
  final bool untilDisabled, enabledKnown, deliveryEnabled;
  final DateTime? draftExpiresAt;
  const OutboundDraft({
    required this.draftId,
    required this.digest,
    required this.version,
    required this.taskKind,
    required this.taskId,
    required this.revision,
    required this.name,
    required this.principalId,
    required this.principalLabel,
    required this.approverId,
    required this.schedule,
    required this.timezone,
    required this.outputMode,
    required this.template,
    required this.confidentiality,
    required this.status,
    required this.quotaTimezone,
    required this.enabled,
    required this.canApprove,
    required this.targets,
    required this.resources,
    required this.perRun,
    required this.perDay,
    this.canRevoke = false,
    this.approvalReason,
    this.taskSummary = '',
    this.perTarget,
    this.perTargetPerDay,
    this.resultTarget,
    this.serviceAccount = false,
    this.dynamicRecipients = false,
    this.grantId,
    this.approvedBy,
    this.validUntil,
    this.untilDisabled = false,
    this.enabledKnown = true,
    this.deliveryEnabled = false,
    this.draftExpiresAt,
  });

  String? approvalBlock(OutboundCapabilities caps, DateTime now) {
    if (status != 'pending') return '此草稿不再待审批，请创建新草稿';
    if (draftExpiresAt != null && !draftExpiresAt!.isAfter(now)) {
      return '草稿已过期，请重新创建';
    }
    if (!caps.approval || !caps.fixedTargets) return '后端审批能力尚未开放';
    if (approvalReason != null) return approvalReason;
    if (!enabledKnown) return '任务启用状态未知，请刷新详情';
    if (!canApprove) return serviceAccount ? '需有权限的管理员审批' : '你没有此任务的审批权限';
    if (dynamicRecipients) return '动态收件人待支持，需迁移为固定目标';
    if (!caps.supports(outputMode)) return '此输出模式尚未支持或资料读取隔离未接通';
    if (draftId.isEmpty ||
        digest.isEmpty ||
        version < 1 ||
        revision.isEmpty ||
        principalId.isEmpty ||
        approverId.isEmpty ||
        schedule.isEmpty ||
        timezone.isEmpty ||
        quotaTimezone.isEmpty ||
        template.isEmpty ||
        confidentiality.isEmpty) {
      return '关键授权摘要不完整';
    }
    if (targets.isEmpty ||
        targets.any(
          (t) => t.id.isEmpty || !{'chat_id', 'user_id'}.contains(t.type),
        ) ||
        targets.map((t) => t.key).toSet().length != targets.length) {
      return '固定目标缺失或无效';
    }
    if (resultTarget != null &&
        !targets.any((t) => t.key == resultTarget!.key)) {
      return '结果投递目标必须包含在授权范围内';
    }
    if (resources.isEmpty ||
        resources.any(
          (r) =>
              r.id.isEmpty ||
              (outputMode == 'protected_doc_link'
                  ? r.kind != 'doc'
                  : r.fields.isEmpty),
        )) {
      return '请明确资料及允许输出字段';
    }
    if (perRun <= 0 ||
        perDay <= 0 ||
        (perTarget != null && perTarget! <= 0) ||
        (perTargetPerDay != null && perTargetPerDay! <= 0)) {
      return '额度必须大于零';
    }
    if (perRun > perDay ||
        perRun > 1000 ||
        perDay > 10000 ||
        (perTarget != null && perTarget! > perRun) ||
        (perTargetPerDay != null && perTargetPerDay! > perDay) ||
        (perTarget != null &&
            perTargetPerDay != null &&
            perTarget! > perTargetPerDay!)) {
      return '额度上下限不一致';
    }
    if (untilDisabled == (validUntil != null)) return '必须明确选择一种有效期';
    if (validUntil != null && !validUntil!.isAfter(now)) return '授权有效期已过';
    return null;
  }
}

/// 后续运行的回执，仅供参考，不能覆盖本运行结果。
class OutboundLaterAttempt {
  final String runId, status;
  final String? code, messageId;
  final DateTime? at;
  const OutboundLaterAttempt({
    required this.runId,
    required this.status,
    this.code,
    this.messageId,
    this.at,
  });
}

class OutboundDelivery {
  final OutboundTarget target;
  final String status;
  final String? reason, messageId, logicalMessageId, docId, purpose;
  final DateTime? updatedAt;
  final bool retryable;
  final OutboundLaterAttempt? laterAttempt;
  const OutboundDelivery(
    this.target,
    this.status, {
    this.reason,
    this.messageId,
    this.logicalMessageId,
    this.docId,
    this.purpose,
    this.updatedAt,
    this.retryable = false,
    this.laterAttempt,
  });
}

class OutboundRun {
  final String id, status;
  final bool documentCreated;
  final List<OutboundDelivery> deliveries;
  final String? grantId, taskRevision, occurrenceId;
  final DateTime? startedAt, finishedAt;
  const OutboundRun(
    this.id,
    this.status,
    this.deliveries, {
    this.documentCreated = false,
    this.grantId,
    this.taskRevision,
    this.occurrenceId,
    this.startedAt,
    this.finishedAt,
  });

  int get sentCount => deliveries.where((d) => d.status == 'sent').length;
  int get problemCount => deliveries.where((d) => d.status != 'sent').length;

  /// 运行级说明：只看服务端逐目标回执。没有回执就不是成功。
  String get summary {
    if (status == 'running') return '运行中（尚未结束，结果以结束后的回执为准）';
    if (deliveries.isEmpty) return '没有任何投递回执：无法确认是否发送，不能视为成功';
    final base = outboundStatus(status);
    return '$base（成功 $sentCount / 共 ${deliveries.length} 个目标）';
  }
}

String outboundStatus(String status) =>
    const {
      'active': '授权有效',
      'pending': '待授权',
      'revoked': '已撤销',
      'expired': '已过期',
      'draft_expired': '草稿审批时效已过',
      'revision_changed': '配置已变化，需重新授权',
      'principal_invalid': '执行账号失效',
      'permission_denied': '权限失效',
      'target_out_of_scope': '目标越界',
      'output_policy_mismatch': '内容模式不符',
      'quota_exceeded': '额度超限',
      'invalid_credential': '运行凭证无效',
      'sent': '发送成功',
      'blocked': '投递受阻',
      'failed': '失败',
      'all_sent': '全部发送成功',
      'succeeded': '全部发送成功',
      'running': '运行中',
      'partial': '部分目标发送成功',
      'unsupported': '不支持',
    }[status] ??
    '未知状态（$status）';

class OutboundPage<T> {
  final List<T> items;
  final String? nextCursor;
  const OutboundPage(this.items, {this.nextCursor});
}

/// 实现方须使用真实登录会话；不允许传入调度器凭证。
/// HTTP 路由、序列化、错误码等待后端冻结，禁止猜测端点。
abstract class OutboundRepository {
  Future<OutboundCapabilities> capabilities();
  Future<OutboundPage<OutboundDraft>> tasks({String? cursor});
  Future<OutboundDraft> latest(String taskKind, String taskId);
  Future<OutboundDraft> latestDraft(OutboundDraft reviewed) =>
      latest(reviewed.taskKind, reviewed.taskId);
  Future<OutboundDraft> approve(
    OutboundDraft reviewed, {
    required String expectedRevision,
    required int expectedVersion,
    required String expectedDigest,
    required Set<String> selectedTargetKeys,
  });
  Future<OutboundDraft> revoke(OutboundDraft reviewed);
  Future<OutboundPage<OutboundRun>> runs(
    String taskKind,
    String taskId, {
    String? cursor,
  });

  /// 单运行详情；实现方未接入时明确报“不支持”，不显示成空成功。
  Future<OutboundRun> runDetail(String runId) =>
      throw UnsupportedError('当前未接入运行详情查询');
}
