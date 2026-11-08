/// 自动化授权专用错误提示。只按服务端错误码映射；未知码不美化成成功。
library;

import '../api_client.dart';

const outboundErrorText = {
  'AUTHORIZATION_REQUIRED': '尚未授权，未向目标发送。',
  'GRANT_EXPIRED': '授权已过期，需要重新创建并审批。',
  'GRANT_REVOKED': '授权已撤销；重新启用任务不会恢复它。',
  'TASK_REVISION_CHANGED': '任务安全配置已变化，旧授权失效，请刷新后重新审阅。',
  'DRAFT_STALE': '页面内容已过期或草稿已被处理，本次没有批准，请刷新后重新审阅。',
  'PRINCIPAL_INVALID': '执行身份已失效或与任务不一致。',
  'PERMISSION_DENIED': '你没有这个任务、目标或资料的授权资格。',
  'TARGET_OUT_OF_SCOPE': '目标不在授权范围内（结果投递群也需要列入目标）。',
  'CONTENT_MODE_NOT_ALLOWED': '输出内容模式不在授权范围内。',
  'QUOTA_EXCEEDED': '已超过授权额度，本次未发送。',
  'RUN_CREDENTIAL_INVALID': '运行凭证无效或已过期，本次未发送。',
  'TASK_DISABLED': '任务已停用，请明确选择授权并启用。',
  'DRAFT_EXPIRED': '草稿审批时效已过，请重新创建。',
  'REAL_USER_REQUIRED': '请由真实登录用户审阅并批准，机器人不能代批。',
  'TASK_NOT_FOUND': '任务不存在或已删除。',
  'RUN_BUSY': '这次触发正在处理中，请稍后刷新。',
  'SCHEDULER_NOT_CONFIGURED': '调度器未配置，当前不会自动投递。',
  'SCHEDULER_UNAUTHORIZED': '调度器身份无效。',
  'UNSUPPORTED_CAPABILITY': '后端暂不支持这项能力（如独立 scheduler、模板、动态目标或表格资料）。',
  'IDEMPOTENCY_CONFLICT': '同一条逻辑消息被用于不同内容，已拒绝。',
  'NOT_FOUND': '任务或授权不存在，或你无权查看。',
  'CURSOR_NOT_FOUND': '列表已变化，请刷新后重新加载。',
};

String describeOutboundError(Object e) {
  if (e is CosApiException && e.errors.isEmpty) {
    final text = outboundErrorText[e.code];
    if (text != null) return '$text（${e.code}）';
  }
  if (e is UnsupportedError) return e.message ?? '后端尚未提供此能力';
  if (e is StateError) return e.message;
  if (e is ArgumentError) return '${e.message}';
  return describeError(e);
}
