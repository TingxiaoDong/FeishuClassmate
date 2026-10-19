/// 二期接口：功能开关、字段管理、视图、批量操作、通知中心、推送设备。
/// 契约见《二期功能需求文档》第 2、4、12 节。
library;

import '../api_client.dart';
import '../models.dart';

Map<String, dynamic>? _m(dynamic v) => v is Map ? v.cast<String, dynamic>() : null;
String? _s(dynamic v) => v == null || v.toString().isEmpty ? null : v.toString();

// ---------------- 功能开关 ----------------

class CosCapabilities {
  final Map<String, bool> features;

  /// 后端没有 /capabilities（404）时为 true：只开放一期功能 + table.create。
  final bool legacy;
  const CosCapabilities(this.features, {this.legacy = false});

  static const legacyDefaults = CosCapabilities({'table.create': true}, legacy: true);

  /// 缺失的 key 当作 false。
  bool has(String key) => features[key] == true;

  factory CosCapabilities.fromJson(Map<String, dynamic> j) => CosCapabilities({
        for (final e in (_m(j['features']) ?? const {}).entries)
          if (e.value is bool) e.key: e.value as bool,
      });
}

// ---------------- 视图 ----------------

const kFilterOperators = <String, String>{
  'is': '等于',
  'is_not': '不等于',
  'contains': '包含',
  'not_contains': '不包含',
  'is_empty': '为空',
  'is_not_empty': '不为空',
  'gt': '大于',
  'gte': '大于等于',
  'lt': '小于',
  'lte': '小于等于',
  'today': '是今天',
  'this_week': '在本周',
  'last_7_days': '在最近 7 天',
  'this_month': '在本月',
};

/// 不需要填值的运算符。
const kNoValueOperators = {'is_empty', 'is_not_empty', 'today', 'this_week', 'last_7_days', 'this_month'};

/// 某个字段类型可用的筛选运算符。
List<String> operatorsFor(int type) => switch (type) {
      2 => ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
      5 => ['is', 'gt', 'gte', 'lt', 'lte', 'today', 'this_week', 'last_7_days', 'this_month', 'is_empty', 'is_not_empty'],
      7 => ['is'],
      3 || 4 || 11 => ['is', 'is_not', 'is_empty', 'is_not_empty'],
      _ => ['contains', 'not_contains', 'is', 'is_not', 'is_empty', 'is_not_empty'],
    };

class CosFilterCondition {
  final String fieldName;
  final String operator;

  /// is / is_not 为 List（选项、人员 ID、文本）；gt 等为数字或日期毫秒；复选框为 bool。
  final dynamic value;
  const CosFilterCondition(this.fieldName, this.operator, [this.value]);

  CosFilterCondition copyWith({String? fieldName, String? operator, Object? value = _keep}) =>
      CosFilterCondition(fieldName ?? this.fieldName, operator ?? this.operator,
          identical(value, _keep) ? this.value : value);

  Map<String, dynamic> toJson() => {
        'field_name': fieldName,
        'operator': operator,
        if (!kNoValueOperators.contains(operator)) 'value': value,
      };
  factory CosFilterCondition.fromJson(Map<String, dynamic> j) =>
      CosFilterCondition(j['field_name']?.toString() ?? '', j['operator']?.toString() ?? 'is', j['value']);
}

const _keep = Object();

class CosSortSpec {
  final String fieldName;
  final bool desc;
  const CosSortSpec(this.fieldName, {this.desc = false});
  Map<String, dynamic> toJson() => {'field_name': fieldName, 'desc': desc};
  factory CosSortSpec.fromJson(Map<String, dynamic> j) =>
      CosSortSpec(j['field_name']?.toString() ?? '', desc: j['desc'] == true);
}

class CosViewConfig {
  final String conjunction; // and | or
  final List<CosFilterCondition> conditions;
  final List<CosSortSpec> sort;
  final List<CosSortSpec> group;
  final List<String> hiddenFields;
  final List<String> fieldOrder;
  final Map<String, double> fieldWidths;
  final String rowHeight; // compact | standard | loose
  final String? kanbanField;

  /// 后端返回而前端不认识的配置原样保留（calendar 等），保存时一起回传。
  final Map<String, dynamic> extra;

  const CosViewConfig({
    this.conjunction = 'and',
    this.conditions = const [],
    this.sort = const [],
    this.group = const [],
    this.hiddenFields = const [],
    this.fieldOrder = const [],
    this.fieldWidths = const {},
    this.rowHeight = 'standard',
    this.kanbanField,
    this.extra = const {},
  });

  CosViewConfig copyWith({
    String? conjunction,
    List<CosFilterCondition>? conditions,
    List<CosSortSpec>? sort,
    List<CosSortSpec>? group,
    List<String>? hiddenFields,
    List<String>? fieldOrder,
    Map<String, double>? fieldWidths,
    String? rowHeight,
    Object? kanbanField = _keep,
  }) =>
      CosViewConfig(
        conjunction: conjunction ?? this.conjunction,
        conditions: conditions ?? this.conditions,
        sort: sort ?? this.sort,
        group: group ?? this.group,
        hiddenFields: hiddenFields ?? this.hiddenFields,
        fieldOrder: fieldOrder ?? this.fieldOrder,
        fieldWidths: fieldWidths ?? this.fieldWidths,
        rowHeight: rowHeight ?? this.rowHeight,
        kanbanField: identical(kanbanField, _keep) ? this.kanbanField : kanbanField as String?,
        extra: extra,
      );

  Map<String, dynamic> toJson() => {
        ...extra,
        'filter': {'conjunction': conjunction, 'conditions': [for (final c in conditions) c.toJson()]},
        'sort': [for (final s in sort) s.toJson()],
        'group': [for (final g in group) g.toJson()],
        'hidden_fields': hiddenFields,
        'field_order': fieldOrder,
        'field_widths': fieldWidths,
        'row_height': rowHeight,
        if (kanbanField != null) 'kanban_field': kanbanField,
      };

  factory CosViewConfig.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const CosViewConfig();
    final f = _m(j['filter']) ?? const {};
    List<CosSortSpec> specs(dynamic v) =>
        [for (final e in (v as List? ?? const [])) if (e is Map) CosSortSpec.fromJson(e.cast<String, dynamic>())];
    const known = {'filter', 'sort', 'group', 'hidden_fields', 'field_order', 'field_widths', 'row_height', 'kanban_field'};
    return CosViewConfig(
      conjunction: f['conjunction'] == 'or' ? 'or' : 'and',
      conditions: [
        for (final e in (f['conditions'] as List? ?? const []))
          if (e is Map) CosFilterCondition.fromJson(e.cast<String, dynamic>()),
      ],
      sort: specs(j['sort']),
      group: specs(j['group']),
      hiddenFields: [for (final e in (j['hidden_fields'] as List? ?? const [])) e.toString()],
      fieldOrder: [for (final e in (j['field_order'] as List? ?? const [])) e.toString()],
      fieldWidths: {
        for (final e in (_m(j['field_widths']) ?? const {}).entries)
          if (e.value is num) e.key: (e.value as num).toDouble(),
      },
      rowHeight: (j['row_height'] as String?) ?? 'standard',
      kanbanField: _s(j['kanban_field']),
      extra: {for (final e in j.entries) if (!known.contains(e.key)) e.key: e.value},
    );
  }

  double get rowExtent => switch (rowHeight) { 'compact' => 32, 'loose' => 56, _ => 40 };

  /// 按视图的字段顺序排列表字段（视图里没有的字段按表默认顺序接在后面）。
  List<CosFieldMeta> orderedFields(List<CosFieldMeta> fields) {
    if (fieldOrder.isEmpty) return fields;
    final pos = {for (var i = 0; i < fieldOrder.length; i++) fieldOrder[i]: i};
    final indexed = [for (var i = 0; i < fields.length; i++) (i, fields[i])];
    indexed.sort((a, b) {
      final pa = pos[a.$2.fieldName], pb = pos[b.$2.fieldName];
      if (pa != null && pb != null) return pa.compareTo(pb);
      if (pa != null) return -1;
      if (pb != null) return 1;
      return a.$1.compareTo(b.$1);
    });
    return [for (final e in indexed) e.$2];
  }
}

class CosView {
  final String viewId;
  final String name;
  final String type; // grid | kanban | calendar | gantt | gallery
  final bool personal;
  final String? ownerId;
  final CosViewConfig config;
  final int version;
  final DateTime? updatedAt;

  /// 本地视图：后端未开放 table.views 时的占位视图，不保存。
  final bool local;

  const CosView({
    required this.viewId,
    required this.name,
    this.type = 'grid',
    this.personal = false,
    this.ownerId,
    this.config = const CosViewConfig(),
    this.version = 0,
    this.updatedAt,
    this.local = false,
  });

  CosView copyWith({String? name, CosViewConfig? config, int? version, bool? personal}) => CosView(
        viewId: viewId,
        name: name ?? this.name,
        type: type,
        personal: personal ?? this.personal,
        ownerId: ownerId,
        config: config ?? this.config,
        version: version ?? this.version,
        updatedAt: updatedAt,
        local: local,
      );

  factory CosView.fromJson(Map<String, dynamic> j) => CosView(
        viewId: j['view_id']?.toString() ?? '',
        name: j['name']?.toString() ?? '未命名视图',
        type: j['type']?.toString() ?? 'grid',
        personal: j['personal'] == true,
        ownerId: _s(j['owner_id']),
        config: CosViewConfig.fromJson(_m(j['config'])),
        version: (j['version'] as num?)?.toInt() ?? 0,
        updatedAt: j['updated_at'] == null ? null : DateTime.tryParse(j['updated_at'].toString()),
      );
}

// ---------------- 批量 / 记录列表 ----------------

class CosBatchResult {
  final List<dynamic> succeeded;
  final List<({String recordId, String message})> failed;
  const CosBatchResult(this.succeeded, this.failed);
  factory CosBatchResult.fromJson(Map<String, dynamic> j) => CosBatchResult(
        (j['succeeded'] as List?) ?? const [],
        [
          for (final e in (j['failed'] as List? ?? const []))
            if (e is Map) (recordId: e['record_id']?.toString() ?? '', message: e['message']?.toString() ?? '失败'),
        ],
      );
}

class CosRecordGroup {
  final List<String> path;
  final int count;
  const CosRecordGroup(this.path, this.count);
}

// ---------------- 通知 ----------------

class CosNotification {
  final String id;
  final String type;
  final String? actorId;
  final String title;
  final String summary;
  final Map<String, dynamic> target;
  bool read;
  final DateTime? createdAt;
  CosNotification({
    required this.id,
    required this.type,
    this.actorId,
    required this.title,
    this.summary = '',
    this.target = const {},
    this.read = false,
    this.createdAt,
  });

  bool get isMention => type.endsWith('.mention');

  factory CosNotification.fromJson(Map<String, dynamic> j) => CosNotification(
        id: j['notification_id']?.toString() ?? '',
        type: j['type']?.toString() ?? '',
        actorId: _s(j['actor_id']),
        title: j['title']?.toString() ?? '',
        summary: j['summary']?.toString() ?? '',
        target: _m(j['target']) ?? const {},
        read: j['read'] == true,
        createdAt: j['created_at'] == null ? null : DateTime.tryParse(j['created_at'].toString()),
      );
}

const kNotifyCategories = <String, String>{
  'message': '消息',
  'mention': '@我',
  'approval': '审批',
  'task': '任务',
  'calendar': '日程',
  'comment': '评论',
};

class CosNotificationSettings {
  bool enabled;
  final Map<String, bool> categories;
  bool dndEnabled;
  String dndStart;
  String dndEnd;
  bool muteMobileWhenDesktopOnline;
  bool showPreview;
  CosNotificationSettings({
    this.enabled = true,
    Map<String, bool>? categories,
    this.dndEnabled = false,
    this.dndStart = '23:00',
    this.dndEnd = '08:00',
    this.muteMobileWhenDesktopOnline = true,
    this.showPreview = true,
  }) : categories = {for (final k in kNotifyCategories.keys) k: categories?[k] ?? true};

  Map<String, dynamic> toJson() => {
        'enabled': enabled,
        'categories': categories,
        'dnd': {'enabled': dndEnabled, 'start': dndStart, 'end': dndEnd},
        'mute_mobile_when_desktop_online': muteMobileWhenDesktopOnline,
        'show_preview': showPreview,
      };

  factory CosNotificationSettings.fromJson(Map<String, dynamic> j) {
    final dnd = _m(j['dnd']) ?? const {};
    return CosNotificationSettings(
      enabled: j['enabled'] != false,
      categories: {
        for (final e in (_m(j['categories']) ?? const {}).entries)
          if (e.value is bool) e.key: e.value as bool,
      },
      dndEnabled: dnd['enabled'] == true,
      dndStart: dnd['start']?.toString() ?? '23:00',
      dndEnd: dnd['end']?.toString() ?? '08:00',
      muteMobileWhenDesktopOnline: j['mute_mobile_when_desktop_online'] != false,
      showPreview: j['show_preview'] != false,
    );
  }
}

class CosDevice {
  final String deviceId;
  final String platform;
  final String deviceToken;
  const CosDevice(this.deviceId, this.platform, this.deviceToken);
  factory CosDevice.fromJson(Map<String, dynamic> j) =>
      CosDevice(j['device_id']?.toString() ?? '', j['platform']?.toString() ?? '', j['device_token']?.toString() ?? '');
}

// ---------------- 请求 ----------------

extension Phase2Api on CosApiClient {
  Future<CosCapabilities> capabilities() async {
    try {
      return CosCapabilities.fromJson(await request('GET', '/capabilities'));
    } on CosApiException catch (e) {
      if (e.statusCode == 404 || e.statusCode == 405 || e.statusCode == 501) return CosCapabilities.legacyDefaults;
      rethrow;
    }
  }

  Future<CosTableMeta> getTable(String tableKey) async =>
      CosTableMeta.fromJson(await request('GET', '/tables/$tableKey'));

  // 字段（R-BT-02）：都返回整张表的最新定义。
  Future<CosTableMeta> createField(String tableKey, Map<String, dynamic> field,
          {String? afterField, int? baseVersion}) async =>
      CosTableMeta.fromJson(await request('POST', '/tables/$tableKey/fields', body: {
        ...field,
        if (afterField != null) 'after_field': afterField,
        if (baseVersion != null) 'base_version': baseVersion,
      }));

  Future<CosTableMeta> updateField(String tableKey, String fieldName, Map<String, dynamic> patch,
          {int? baseVersion}) async =>
      CosTableMeta.fromJson(await request('PATCH', '/tables/$tableKey/fields/$fieldName', body: {
        ...patch,
        if (baseVersion != null) 'base_version': baseVersion,
      }));

  Future<CosTableMeta> deleteField(String tableKey, String fieldName, {int? baseVersion}) async =>
      CosTableMeta.fromJson(await request('DELETE', '/tables/$tableKey/fields/$fieldName',
          query: {if (baseVersion != null) 'base_version': '$baseVersion'}));

  Future<CosTableMeta> reorderFields(String tableKey, List<String> fieldNames, {int? baseVersion}) async =>
      CosTableMeta.fromJson(await request('PUT', '/tables/$tableKey/fields/order', body: {
        'field_names': fieldNames,
        if (baseVersion != null) 'base_version': baseVersion,
      }));

  Future<({int affected, int willClear})> convertPreview(String tableKey, String fieldName, int type) async {
    final j = await request('POST', '/tables/$tableKey/fields/$fieldName/convert-preview', body: {'type': type});
    return (affected: (j['affected'] as num?)?.toInt() ?? 0, willClear: (j['will_clear'] as num?)?.toInt() ?? 0);
  }

  // 视图（R-BT-03）
  Future<List<CosView>> listViews(String tableKey) async {
    final j = await request('GET', '/tables/$tableKey/views');
    return [for (final e in (j['items'] as List? ?? const [])) if (e is Map) CosView.fromJson(e.cast<String, dynamic>())];
  }

  Future<CosView> createView(String tableKey,
          {required String name, required String type, bool personal = false, CosViewConfig? config}) async =>
      CosView.fromJson(await request('POST', '/tables/$tableKey/views', body: {
        'name': name,
        'type': type,
        'personal': personal,
        'config': (config ?? const CosViewConfig()).toJson(),
      }));

  Future<CosView> updateView(String tableKey, String viewId,
          {String? name, CosViewConfig? config, bool? personal, required int version}) async =>
      CosView.fromJson(await request('PATCH', '/tables/$tableKey/views/$viewId', body: {
        if (name != null) 'name': name,
        if (config != null) 'config': config.toJson(),
        if (personal != null) 'personal': personal,
        'version': version,
      }));

  Future<void> deleteView(String tableKey, String viewId) => request('DELETE', '/tables/$tableKey/views/$viewId');

  Future<void> reorderViews(String tableKey, List<String> viewIds) =>
      request('PUT', '/tables/$tableKey/views/order', body: {'view_ids': viewIds});

  /// 按视图取记录（后端按视图筛选、排序）；最多 [maxRecords] 条。
  Future<({List<CosRecord> items, int total, List<CosRecordGroup> groups})> listViewRecords(
    String tableKey,
    String viewId, {
    int maxRecords = 10000,
  }) async {
    final out = <CosRecord>[];
    var groups = <CosRecordGroup>[];
    String? token;
    var total = 0;
    while (out.length < maxRecords) {
      final j = await request('GET', '/tables/$tableKey/records', query: {
        'view_id': viewId,
        'page_size': '500',
        if (token != null) 'page_token': token,
      });
      final p = parsePage(j, CosRecord.fromJson);
      out.addAll(p.items);
      total = p.total ?? out.length;
      if (token == null) {
        groups = [
          for (final g in (j['groups'] as List? ?? const []))
            if (g is Map)
              CosRecordGroup([for (final v in (g['path'] as List? ?? const [])) v.toString()],
                  (g['count'] as num?)?.toInt() ?? 0),
        ];
      }
      if (!p.hasMore || p.pageToken == null) break;
      token = p.pageToken;
    }
    return (items: out, total: total, groups: groups);
  }

  // 批量（R-BT-06）
  Future<CosBatchResult> batchCreate(String tableKey, List<Map<String, dynamic>> fieldsList) async =>
      CosBatchResult.fromJson(await request('POST', '/tables/$tableKey/records/batch_create', body: {
        'records': [for (final f in fieldsList) {'fields': f}],
      }));

  Future<CosBatchResult> batchUpdate(String tableKey,
          {List<({String recordId, Map<String, dynamic> fields})>? records,
          List<String>? recordIds,
          Map<String, dynamic>? fields}) async =>
      CosBatchResult.fromJson(await request('POST', '/tables/$tableKey/records/batch_update', body: {
        if (records != null) 'records': [for (final r in records) {'record_id': r.recordId, 'fields': r.fields}],
        if (recordIds != null) 'record_ids': recordIds,
        if (fields != null) 'fields': fields,
      }));

  Future<CosBatchResult> batchDelete(String tableKey, List<String> recordIds) async =>
      CosBatchResult.fromJson(
          await request('POST', '/tables/$tableKey/records/batch_delete', body: {'record_ids': recordIds}));

  // 通知（R-NT-01 / 02）
  Future<CosPage<CosNotification>> listNotifications({String filter = 'all', String? pageToken}) async =>
      parsePage(
          await request('GET', '/notifications', query: {
            'filter': filter,
            'page_size': '50',
            if (pageToken != null) 'page_token': pageToken,
          }),
          CosNotification.fromJson);

  Future<int> notificationUnreadCount() async =>
      ((await request('GET', '/notifications/unread-count'))['count'] as num?)?.toInt() ?? 0;

  Future<void> markNotificationsRead({List<String>? ids, bool all = false}) =>
      request('POST', '/notifications/read', body: all ? {'all': true} : {'ids': ids ?? const []});

  Future<CosNotificationSettings> notificationSettings() async =>
      CosNotificationSettings.fromJson(await request('GET', '/users/me/notification-settings'));

  Future<CosNotificationSettings> saveNotificationSettings(CosNotificationSettings s) async =>
      CosNotificationSettings.fromJson(await request('PUT', '/users/me/notification-settings', body: s.toJson()));

  // 推送设备（一期已有）
  Future<CosDevice> registerDevice(String platform, String token) async =>
      CosDevice.fromJson(await request('POST', '/devices', body: {'platform': platform, 'device_token': token}));

  Future<void> unregisterDevice(String deviceId) => request('DELETE', '/devices/$deviceId');
}
