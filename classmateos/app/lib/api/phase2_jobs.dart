/// 迭代 5：异步任务（job）、多维表格导入导出（R-BT-07）、文档导出（R-DC-06）、
/// 工作台应用（R-WB-01）、报表时间范围（R-WB-02）。
library;

import '../api_client.dart';

String? _s(dynamic v) => v == null || v.toString().isEmpty ? null : v.toString();

// ---------------- 异步任务 ----------------

class CosJob {
  final String jobId;

  /// pending | running | done | failed
  final String status;
  final double progress;
  final String? fileKey;
  final String? fileName;
  final int succeeded;
  final int failed;
  final String? errorFileKey;
  final String? message;
  const CosJob(this.jobId, this.status, this.progress, this.fileKey, this.fileName, this.succeeded, this.failed, this.errorFileKey, this.message);

  bool get finished => status == 'done' || status == 'failed';
  bool get ok => status == 'done';

  factory CosJob.fromJson(Map<String, dynamic> j) {
    final r = j['result'] is Map ? (j['result'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
    return CosJob(
      j['job_id']?.toString() ?? '',
      j['status']?.toString() ?? 'pending',
      ((j['progress'] as num?)?.toDouble() ?? 0).clamp(0, 1).toDouble(),
      _s(r['file_key']),
      _s(r['file_name']),
      (r['succeeded'] as num?)?.toInt() ?? 0,
      (r['failed'] as num?)?.toInt() ?? 0,
      _s(r['error_file_key']),
      _s(j['message'] ?? r['message']),
    );
  }
}

// ---------------- 导入预览 ----------------

class CosImportPreview {
  final List<String> headers;
  final List<List<String>> rows;
  final int totalRows;

  /// 表头 → 推荐字段类型（一期类型编号）。
  final Map<String, int> suggestedTypes;
  const CosImportPreview(this.headers, this.rows, this.totalRows, this.suggestedTypes);
  factory CosImportPreview.fromJson(Map<String, dynamic> j) {
    final headers = [for (final h in (j['headers'] as List? ?? const [])) h.toString()];
    final rows = [
      for (final r in (j['rows'] as List? ?? const []))
        if (r is List) [for (final c in r) c?.toString() ?? ''],
    ];
    final types = <String, int>{};
    final st = j['suggested_types'];
    if (st is Map) {
      for (final e in st.entries) {
        if (e.value is num) types[e.key.toString()] = (e.value as num).toInt();
      }
    }
    return CosImportPreview(headers, rows, (j['total_rows'] as num?)?.toInt() ?? rows.length, types);
  }
}

// ---------------- 工作台 ----------------

class CosShortcut {
  final String id;

  /// table_view | wiki_space | doc（审批已取消，不用 approval_template）
  final String type;
  final String targetId;
  final String name;
  final String? icon;

  /// table_view 时的表 key（target_id 是视图 ID）。
  final String? tableKey;
  const CosShortcut(this.id, this.type, this.targetId, this.name, {this.icon, this.tableKey});
  factory CosShortcut.fromJson(Map<String, dynamic> j) => CosShortcut(
        j['id']?.toString() ?? '',
        j['type']?.toString() ?? '',
        j['target_id']?.toString() ?? '',
        j['name']?.toString() ?? '',
        icon: _s(j['icon']),
        tableKey: _s(j['table_key']),
      );
  Map<String, dynamic> toJson() => {
        if (id.isNotEmpty) 'id': id,
        'type': type,
        'target_id': targetId,
        'name': name,
        if (icon != null) 'icon': icon,
        if (tableKey != null) 'table_key': tableKey,
      };
}

class CosWorkbenchApps {
  /// 内置模块名（与前端 AppModule.name 对应，如 bitable、wiki）；后端决定顺序和是否显示。
  final List<String> builtin;
  final List<CosShortcut> shortcuts;
  const CosWorkbenchApps(this.builtin, this.shortcuts);
  factory CosWorkbenchApps.fromJson(Map<String, dynamic> j) => CosWorkbenchApps(
        [
          for (final b in (j['builtin'] as List? ?? const []))
            if (b is Map) b['key'].toString() else b.toString(),
        ],
        [for (final x in (j['shortcuts'] as List? ?? const [])) CosShortcut.fromJson((x as Map).cast<String, dynamic>())],
      );
}

/// 报表时间范围（R-WB-02）。
class CosReportRange {
  /// week | month | semester | custom
  final String range;
  final DateTime? start;
  final DateTime? end;
  const CosReportRange(this.range, [this.start, this.end]);
  static const week = CosReportRange('week');
  DateTime get _last => (end ?? start!).subtract(end == null ? Duration.zero : const Duration(days: 1));
  String get label => switch (range) {
        'week' => '本周',
        'month' => '本月',
        'semester' => '本学期',
        // end 是开区间（次日 0 点），显示时减一天
        _ => start == null ? '自定义' : '${start!.month}/${start!.day} – ${_last.month}/${_last.day}',
      };
}

extension Phase2JobsApi on CosApiClient {
  String _e(String id) => Uri.encodeComponent(id);

  Future<CosJob> getJob(String jobId) async => CosJob.fromJson(await request('GET', '/jobs/${_e(jobId)}'));

  // ---------- R-BT-07 导入导出 ----------

  Future<CosImportPreview> previewTableImport(String fileKey) async =>
      CosImportPreview.fromJson(await request('POST', '/tables/imports/preview', body: {'file_key': fileKey}));

  /// mode: append | upsert（按主字段更新）；mapping: 列名 → 字段名（不导入的列不放进来）。
  Future<String> startTableImport(String tableKey, {required String fileKey, required String mode, required Map<String, String> mapping}) async =>
      (await request('POST', '/tables/${_e(tableKey)}/imports', body: {'file_key': fileKey, 'mode': mode, 'mapping': mapping}))['job_id']
          ?.toString() ??
      '';

  Future<String> startTableExport(String tableKey, {String? viewId, required String format, List<String>? recordIds}) async =>
      (await request('POST', '/tables/${_e(tableKey)}/exports', body: {
        if (viewId != null) 'view_id': viewId,
        'format': format,
        if (recordIds != null && recordIds.isNotEmpty) 'record_ids': recordIds,
      }))['job_id']
          ?.toString() ??
      '';

  // ---------- R-DC-06 文档导出 ----------

  Future<String> startDocExport(String docId, String format) async =>
      (await request('POST', '/docs/${_e(docId)}/exports', body: {'format': format}))['job_id']?.toString() ?? '';

  // ---------- R-WB-01 工作台应用 ----------

  Future<CosWorkbenchApps> workbenchApps() async => CosWorkbenchApps.fromJson(await request('GET', '/workbench/apps'));

  /// 整体覆盖快捷方式列表（顺序即显示顺序）。
  Future<List<CosShortcut>> saveShortcuts(List<CosShortcut> list) async {
    final j = await request('PUT', '/workbench/shortcuts', body: {'shortcuts': [for (final s in list) s.toJson()]});
    return [for (final x in (j['shortcuts'] as List? ?? const [])) CosShortcut.fromJson((x as Map).cast<String, dynamic>())];
  }

  // ---------- R-WB-02 报表时间范围 ----------

  Future<Map<String, dynamic>> dashboardSummaryRange(CosReportRange r) => request('GET', '/dashboard/summary', query: {
        'range': r.range,
        if (r.range == 'custom' && r.start != null) 'start_at': r.start!.toUtc().toIso8601String(),
        if (r.range == 'custom' && r.end != null) 'end_at': r.end!.toUtc().toIso8601String(),
      });
}
