/// 迭代 5：「我的」页（R-LG-03）、管理后台（R-AD-01～05）、扫码登录（R-LG-02）的接口封装。
/// 契约见《二期迭代5_前端接口需求与进度》；需求文档没写清的地方按那份文档第 3 节的补充约定。
library;

import '../api_client.dart';
import '../models.dart';

String? _s(dynamic v) => v == null || v.toString().isEmpty ? null : v.toString();
DateTime? _t(dynamic v) {
  if (v == null) return null;
  if (v is num) return DateTime.fromMillisecondsSinceEpoch(v.toInt());
  return DateTime.tryParse(v.toString())?.toLocal();
}

List<String> _ids(dynamic v) => [for (final x in (v as List? ?? const [])) x.toString()];

// ---------------- 权限点 ----------------

/// 权限点 → 中文名（R-AD-03）。审批已取消，不列 approval.manage。
const kPermissionPoints = <String, String>{
  'admin.members': '管理成员',
  'admin.departments': '管理组织架构',
  'admin.roles': '管理角色',
  'admin.audit': '查看操作日志',
  'admin.security': '安全设置',
  'table.create': '新建数据表',
  'wiki.create': '新建知识空间',
  'doc.template': '管理文档模板',
};

const kAdminPermissions = ['admin.members', 'admin.departments', 'admin.roles', 'admin.audit', 'admin.security'];

// ---------------- 登录设备 ----------------

class CosLoginSession {
  final String sessionId;
  final String deviceName;
  final String? platform;
  final String? ip;
  final DateTime? lastActiveAt;
  final DateTime? createdAt;
  final bool current;
  const CosLoginSession(this.sessionId, this.deviceName, this.platform, this.ip, this.lastActiveAt, this.createdAt, this.current);
  factory CosLoginSession.fromJson(Map<String, dynamic> j) => CosLoginSession(
        j['session_id']?.toString() ?? '',
        _s(j['device_name']) ?? '未知设备',
        _s(j['platform']),
        _s(j['ip']),
        _t(j['last_active_at']),
        _t(j['created_at']),
        j['current'] == true,
      );
}

// ---------------- 成员（管理视角） ----------------

class CosAdminUser {
  final CosUser user;
  final String? username;

  /// active | disabled
  final String status;
  final DateTime? lastLoginAt;
  final List<String> departmentIds;
  final String? primaryDepartmentId;
  final String? leaderId;
  final List<String> roleIds;
  const CosAdminUser(this.user, this.username, this.status, this.lastLoginAt, this.departmentIds, this.primaryDepartmentId,
      this.leaderId, this.roleIds);
  bool get disabled => status == 'disabled';
  factory CosAdminUser.fromJson(Map<String, dynamic> j) => CosAdminUser(
        CosUser.fromJson(j),
        _s(j['username']),
        _s(j['status']) ?? 'active',
        _t(j['last_login_at']),
        _ids(j['department_ids']),
        _s(j['primary_department_id']),
        _s(j['leader_id']),
        _ids(j['role_ids']),
      );
}

// ---------------- 部门 ----------------

class CosDepartment {
  final String departmentId;
  final String name;
  final String? parentId;
  final String? leaderId;
  final int memberCount;
  final bool hasChildren;
  final int order;
  const CosDepartment(this.departmentId, this.name, this.parentId, this.leaderId, this.memberCount, this.hasChildren, this.order);
  factory CosDepartment.fromJson(Map<String, dynamic> j) => CosDepartment(
        j['department_id']?.toString() ?? '',
        j['name']?.toString() ?? '',
        _s(j['parent_id']),
        _s(j['leader_id']),
        (j['member_count'] as num?)?.toInt() ?? 0,
        j['has_children'] == true,
        (j['order'] as num?)?.toInt() ?? 0,
      );
}

// ---------------- 角色 ----------------

class CosRole {
  final String roleId;
  final String name;
  final String? description;

  /// super_admin | admin | member；自定义角色为 null。
  final String? builtin;
  final List<String> permissions;
  final List<String> memberIds;
  const CosRole(this.roleId, this.name, this.description, this.builtin, this.permissions, this.memberIds);
  bool get isBuiltin => builtin != null;
  factory CosRole.fromJson(Map<String, dynamic> j) => CosRole(
        j['role_id']?.toString() ?? '',
        j['name']?.toString() ?? '',
        _s(j['description']),
        _s(j['builtin']),
        _ids(j['permissions']),
        _ids(j['member_ids']),
      );
}

// ---------------- 操作日志 ----------------

/// 操作类型 → 中文（不认识的原样显示）。
const kAuditActions = <String, String>{
  'auth.login': '登录',
  'auth.logout': '登出',
  'auth.login_failed': '登录失败',
  'auth.qr_login': '扫码登录',
  'user.create': '添加成员',
  'user.update': '修改成员',
  'user.disable': '禁用成员',
  'user.enable': '启用成员',
  'user.reset_password': '重置密码',
  'user.logout_all': '强制下线',
  'user.import': '批量导入成员',
  'department.change': '组织架构变更',
  'role.change': '角色权限变更',
  'doc.delete': '删除文档',
  'doc.share': '分享权限变更',
  'table.delete': '删除数据表',
  'record.delete': '删除记录',
  'file.download': '下载文件',
  'security.update': '安全设置变更',
};

String auditActionLabel(String a) => kAuditActions[a] ?? a;

class CosAuditLog {
  final String logId;
  final DateTime? createdAt;
  final String? operatorId;
  final String? operatorName;
  final String action;
  final String? targetType;
  final String? targetId;
  final String? targetName;
  final String? detail;
  final String? ip;
  final String? device;
  const CosAuditLog(this.logId, this.createdAt, this.operatorId, this.operatorName, this.action, this.targetType, this.targetId,
      this.targetName, this.detail, this.ip, this.device);
  factory CosAuditLog.fromJson(Map<String, dynamic> j) => CosAuditLog(
        j['log_id']?.toString() ?? '',
        _t(j['created_at']),
        _s(j['operator_id']),
        _s(j['operator_name']),
        j['action']?.toString() ?? '',
        _s(j['target_type']),
        _s(j['target_id']),
        _s(j['target_name']),
        _s(j['detail']),
        _s(j['ip']),
        _s(j['device']),
      );
}

// ---------------- 安全设置 ----------------

class CosSecuritySettings {
  int passwordMinLength;
  bool passwordRequireLetterDigit;
  bool forceChangeOnFirstLogin;
  int accessTokenTtlMinutes;
  int idleTimeoutMinutes; // 0 = 不自动退出
  int lockAfterFailures; // 0 = 不锁定
  int lockMinutes;
  CosSecuritySettings({
    this.passwordMinLength = 8,
    this.passwordRequireLetterDigit = true,
    this.forceChangeOnFirstLogin = true,
    this.accessTokenTtlMinutes = 120,
    this.idleTimeoutMinutes = 0,
    this.lockAfterFailures = 5,
    this.lockMinutes = 15,
  });
  factory CosSecuritySettings.fromJson(Map<String, dynamic> j) {
    int n(String k, int d) => (j[k] as num?)?.toInt() ?? d;
    return CosSecuritySettings(
      passwordMinLength: n('password_min_length', 8),
      passwordRequireLetterDigit: j['password_require_letter_digit'] != false,
      forceChangeOnFirstLogin: j['force_change_on_first_login'] != false,
      accessTokenTtlMinutes: n('access_token_ttl_minutes', 120),
      idleTimeoutMinutes: n('idle_timeout_minutes', 0),
      lockAfterFailures: n('lock_after_failures', 5),
      lockMinutes: n('lock_minutes', 15),
    );
  }
  Map<String, dynamic> toJson() => {
        'password_min_length': passwordMinLength,
        'password_require_letter_digit': passwordRequireLetterDigit,
        'force_change_on_first_login': forceChangeOnFirstLogin,
        'access_token_ttl_minutes': accessTokenTtlMinutes,
        'idle_timeout_minutes': idleTimeoutMinutes,
        'lock_after_failures': lockAfterFailures,
        'lock_minutes': lockMinutes,
      };
}

// ---------------- 扫码登录 ----------------

class CosQrTicket {
  final String qrId;
  final String content;
  final DateTime expiresAt;
  const CosQrTicket(this.qrId, this.content, this.expiresAt);
  factory CosQrTicket.fromJson(Map<String, dynamic> j) => CosQrTicket(
        j['qr_id']?.toString() ?? '',
        j['qr_content']?.toString() ?? '',
        _t(j['expires_at']) ?? DateTime.now().add(const Duration(minutes: 2)),
      );
}

/// waiting | scanned | confirmed | expired | canceled；confirmed 时 [session] 是 /auth/login 同结构的令牌。
class CosQrState {
  final String status;
  final String? scannedBy;
  final String? deviceName;
  final Map<String, dynamic>? session;
  const CosQrState(this.status, this.scannedBy, this.deviceName, this.session);
  factory CosQrState.fromJson(Map<String, dynamic> j) => CosQrState(
        j['status']?.toString() ?? 'waiting',
        _s(j['scanned_by_name']),
        _s(j['device_name']),
        j['session'] is Map ? (j['session'] as Map).cast<String, dynamic>() : null,
      );
}

/// 二维码内容约定：`classmateos://qr-login?qr_id=xxx&server=<API 基础地址>`。
/// 返回 qr_id；不是登录二维码时返回 null。
String? parseQrLogin(String content) {
  final u = Uri.tryParse(content.trim());
  if (u == null || u.scheme != 'classmateos' || u.host != 'qr-login') return null;
  final id = u.queryParameters['qr_id'];
  return id == null || id.isEmpty ? null : id;
}

// ---------------- 接口 ----------------

extension Phase2AdminApi on CosApiClient {
  String _e(String id) => Uri.encodeComponent(id);

  // ---------- R-LG-03 我的 ----------

  /// 修改资料：签名、电话、头像（上传后的 file_key）。
  Future<CosUser> updateMyProfile({String? statusText, String? phone, String? avatarFileKey}) async =>
      CosUser.fromJson(await request('PATCH', '/users/me', body: {
        if (statusText != null) 'status_text': statusText,
        if (phone != null) 'phone': phone,
        if (avatarFileKey != null) 'avatar_file_key': avatarFileKey,
      }));

  Future<void> changePassword(String oldPassword, String newPassword) =>
      request('POST', '/users/me/password', body: {'old_password': oldPassword, 'new_password': newPassword});

  Future<List<CosLoginSession>> mySessions() async {
    final j = await request('GET', '/users/me/sessions');
    return [for (final x in (j['items'] as List? ?? const [])) CosLoginSession.fromJson((x as Map).cast<String, dynamic>())];
  }

  Future<void> revokeSession(String sessionId) => request('DELETE', '/users/me/sessions/${_e(sessionId)}');

  /// 退出其他设备，保留当前设备；全部退出还需调用 logout。
  Future<void> logoutAllMine() => request('POST', '/users/me/logout-all');

  // ---------- R-AD-01 成员管理 ----------

  Future<CosPage<CosAdminUser>> adminListUsers({String? q, String? departmentId, String? status, String? pageToken, int pageSize = 50}) async {
    final j = await request('GET', '/users', query: {
      'page_size': '$pageSize',
      'include': 'admin',
      if (q != null && q.isNotEmpty) 'q': q,
      if (departmentId != null) 'department_id': departmentId,
      if (status != null) 'status': status,
      if (pageToken != null) 'page_token': pageToken,
    });
    return parsePage(j, CosAdminUser.fromJson);
  }

  /// 新建（userId 为 null）或修改成员。新建时后端生成初始密码，放在 `initial_password` 里返回一次。
  Future<(CosAdminUser, String?)> adminSaveUser(String? userId, Map<String, dynamic> body) async {
    final j = userId == null ? await request('POST', '/users', body: body) : await request('PATCH', '/users/${_e(userId)}', body: body);
    return (CosAdminUser.fromJson(j), _s(j['initial_password']));
  }

  Future<CosAdminUser> adminSetUserStatus(String userId, bool disabled) async =>
      CosAdminUser.fromJson(await request('PATCH', '/users/${_e(userId)}', body: {'status': disabled ? 'disabled' : 'active'}));

  /// 重置密码，返回一次性新密码（只显示一次）。
  Future<String> adminResetPassword(String userId) async =>
      (await request('POST', '/users/${_e(userId)}/reset-password'))['password']?.toString() ?? '';

  Future<void> adminLogoutAll(String userId) => request('POST', '/users/${_e(userId)}/logout-all');

  /// 成员导入模板（后端生成 xlsx，返回 file_key）。
  Future<String> userImportTemplate() async => (await request('GET', '/users/import/template'))['file_key']?.toString() ?? '';

  /// 预览导入：每行附带校验结果。
  Future<Map<String, dynamic>> previewUserImport(String fileKey) => request('POST', '/users/import/preview', body: {'file_key': fileKey});

  Future<String> startUserImport(String fileKey) async =>
      (await request('POST', '/users/import', body: {'file_key': fileKey}))['job_id']?.toString() ?? '';

  // ---------- R-AD-02 组织架构 ----------

  Future<List<CosDepartment>> listDepartments({String? parentId}) async {
    final j = await request('GET', '/departments', query: {'parent_id': parentId ?? 'root', 'page_size': '200'});
    return [for (final x in (j['items'] as List? ?? const [])) CosDepartment.fromJson((x as Map).cast<String, dynamic>())]
      ..sort((a, b) => a.order.compareTo(b.order));
  }

  Future<CosDepartment> getDepartment(String id) async => CosDepartment.fromJson(await request('GET', '/departments/${_e(id)}'));

  Future<CosDepartment> createDepartment({required String name, String? parentId, String? leaderId}) async =>
      CosDepartment.fromJson(await request('POST', '/departments', body: {
        'name': name,
        'parent_id': parentId,
        if (leaderId != null) 'leader_id': leaderId,
      }));

  /// 改名、换负责人、移动（parent_id + order）。leaderId 传空字符串表示清空。
  Future<CosDepartment> updateDepartment(String id, {String? name, String? leaderId, Object? parentId = _keep, int? order}) async =>
      CosDepartment.fromJson(await request('PATCH', '/departments/${_e(id)}', body: {
        if (name != null) 'name': name,
        if (leaderId != null) 'leader_id': leaderId.isEmpty ? null : leaderId,
        if (!identical(parentId, _keep)) 'parent_id': parentId,
        if (order != null) 'order': order,
      }));

  Future<void> deleteDepartment(String id) => request('DELETE', '/departments/${_e(id)}');

  Future<void> addDepartmentMembers(String id, List<String> userIds) =>
      request('POST', '/departments/${_e(id)}/members', body: {'user_ids': userIds});

  Future<void> removeDepartmentMember(String id, String userId) =>
      request('DELETE', '/departments/${_e(id)}/members/${_e(userId)}');

  /// 某个部门的直属成员（通讯录浏览用，普通成员可调）。
  Future<List<CosUser>> departmentUsers(String id) async {
    final j = await request('GET', '/users', query: {'department_id': id, 'page_size': '200'});
    return [for (final x in (j['items'] as List? ?? const [])) CosUser.fromJson((x as Map).cast<String, dynamic>())];
  }

  /// 部门路径（从根到本部门），用于名片显示。
  Future<List<CosDepartment>> departmentPath(String id) async {
    final j = await request('GET', '/departments/${_e(id)}/path');
    return [for (final x in (j['items'] as List? ?? const [])) CosDepartment.fromJson((x as Map).cast<String, dynamic>())];
  }

  // ---------- R-AD-03 角色 ----------

  Future<List<CosRole>> listRoles() async {
    final j = await request('GET', '/roles');
    return [for (final x in (j['items'] as List? ?? const [])) CosRole.fromJson((x as Map).cast<String, dynamic>())];
  }

  Future<CosRole> saveRole(String? roleId, {String? name, String? description, List<String>? permissions}) async {
    final body = {
      if (name != null) 'name': name,
      if (description != null) 'description': description,
      if (permissions != null) 'permissions': permissions,
    };
    return CosRole.fromJson(roleId == null
        ? await request('POST', '/roles', body: body)
        : await request('PATCH', '/roles/${_e(roleId)}', body: body));
  }

  Future<void> deleteRole(String roleId) => request('DELETE', '/roles/${_e(roleId)}');

  Future<CosRole> setRoleMembers(String roleId, List<String> userIds) async =>
      CosRole.fromJson(await request('PUT', '/roles/${_e(roleId)}/members', body: {'user_ids': userIds}));

  // ---------- R-AD-04 操作日志 ----------

  Future<CosPage<CosAuditLog>> listAuditLogs({DateTime? startAt, DateTime? endAt, String? operatorId, String? action, String? pageToken}) async {
    final j = await request('GET', '/audit-logs', query: {
      'page_size': '50',
      if (startAt != null) 'start_at': startAt.toUtc().toIso8601String(),
      if (endAt != null) 'end_at': endAt.toUtc().toIso8601String(),
      if (operatorId != null) 'operator_id': operatorId,
      if (action != null) 'action': action,
      if (pageToken != null) 'page_token': pageToken,
    });
    return parsePage(j, CosAuditLog.fromJson);
  }

  Future<String> exportAuditLogs({DateTime? startAt, DateTime? endAt, String? operatorId, String? action}) async =>
      (await request('POST', '/audit-logs/exports', body: {
        'format': 'csv',
        if (startAt != null) 'start_at': startAt.toUtc().toIso8601String(),
        if (endAt != null) 'end_at': endAt.toUtc().toIso8601String(),
        if (operatorId != null) 'operator_id': operatorId,
        if (action != null) 'action': action,
      }))['job_id']?.toString() ?? '';

  // ---------- R-AD-05 安全设置 ----------

  Future<CosSecuritySettings> securitySettings() async => CosSecuritySettings.fromJson(await request('GET', '/admin/security-settings'));

  Future<CosSecuritySettings> saveSecuritySettings(CosSecuritySettings s) async =>
      CosSecuritySettings.fromJson(await request('PUT', '/admin/security-settings', body: s.toJson()));

  // ---------- R-LG-02 扫码登录 ----------

  /// 桌面 / Web：创建二维码（不需要登录）。
  Future<CosQrTicket> createQrLogin(String deviceName) async =>
      CosQrTicket.fromJson(await requestPublic('POST', '/auth/qr', body: {'device_name': deviceName}));

  /// 桌面 / Web：轮询状态（不需要登录）。
  Future<CosQrState> pollQrLogin(String qrId) async => CosQrState.fromJson(await requestPublic('GET', '/auth/qr/${_e(qrId)}'));

  /// 手机：扫到后告诉后端（桌面显示「已扫码，请在手机上确认」），返回要登录的设备名。
  Future<CosQrState> scanQrLogin(String qrId) async => CosQrState.fromJson(await request('POST', '/auth/qr/${_e(qrId)}/scan'));

  Future<void> confirmQrLogin(String qrId) => request('POST', '/auth/qr/${_e(qrId)}/confirm');

  Future<void> cancelQrLogin(String qrId) => request('POST', '/auth/qr/${_e(qrId)}/cancel');
}

const _keep = Object();
