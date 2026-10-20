/// 操作日志（R-AD-04）与安全设置（R-AD-05）。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/phase2_admin.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/job_dialog.dart';
import 'admin_page.dart' show AdminHeader, humanUsers;

// ---------------- 操作日志 ----------------

class AdminAuditPane extends StatefulWidget {
  const AdminAuditPane({super.key});
  @override
  State<AdminAuditPane> createState() => _AdminAuditPaneState();
}

class _AdminAuditPaneState extends State<AdminAuditPane> {
  final List<CosAuditLog> items = [];
  String range = '7d'; // today | 7d | 30d | custom
  DateTimeRange? custom;
  String? operatorId;
  String? action;
  String? pageToken;
  bool hasMore = false, loading = true;
  String? error;

  (DateTime?, DateTime?) get _window {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return switch (range) {
      'today' => (today, null),
      '7d' => (today.subtract(const Duration(days: 6)), null),
      '30d' => (today.subtract(const Duration(days: 29)), null),
      _ => (custom?.start, custom?.end.add(const Duration(days: 1))),
    };
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    final api = AppScope.read(context).api;
    final (from, to) = _window;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final p = await api.listAuditLogs(startAt: from, endAt: to, operatorId: operatorId, action: action, pageToken: more ? pageToken : null);
      if (!mounted) return;
      setState(() {
        if (!more) items.clear();
        items.addAll(p.items);
        pageToken = p.pageToken;
        hasMore = p.hasMore;
        loading = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  Future<void> _export() async {
    final api = AppScope.read(context).api;
    final (from, to) = _window;
    await runJobDialog(context,
        title: '导出操作日志', start: () => api.exportAuditLogs(startAt: from, endAt: to, operatorId: operatorId, action: action));
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final mobile = MediaQuery.sizeOf(context).width < 720;
    Widget chip(String key, String label) => Padding(
          padding: const EdgeInsets.only(right: 6),
          child: ChoiceChip(
            key: ValueKey('audit-range-$key'),
            label: Text(label),
            selected: range == key,
            showCheckmark: false,
            onSelected: (_) async {
              if (key == 'custom') {
                final now = DateTime.now();
                final r = await showDateRangePicker(
                  context: context,
                  firstDate: DateTime(now.year - 2),
                  lastDate: now,
                  initialDateRange: custom,
                );
                if (r == null) return;
                custom = r;
              }
              setState(() => range = key);
              _load();
            },
          ),
        );
    return Column(children: [
      AdminHeader(
        title: '操作日志',
        subtitle: '登录、成员与权限变更、删除、下载、分享等操作都会记录',
        actions: [
          if (!mobile)
            OutlinedButton.icon(
              key: const ValueKey('audit-export'),
              icon: const Icon(Icons.download_rounded, size: 16),
              label: const Text('导出 CSV'),
              onPressed: _export,
            ),
        ],
      ),
      Container(
        color: Colors.white,
        padding: const EdgeInsets.fromLTRB(24, 10, 20, 10),
        child: Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Row(mainAxisSize: MainAxisSize.min, children: [
            chip('today', '今天'),
            chip('7d', '近 7 天'),
            chip('30d', '近 30 天'),
            chip('custom', range == 'custom' && custom != null ? '${fmtDate(custom!.start)} ~ ${fmtDate(custom!.end)}' : '自定义'),
          ]),
          _Dropdown<String?>(
            value: operatorId,
            items: {null: '全部操作人', for (final u in humanUsers(s)) u.userId: u.name},
            onChanged: (v) {
              operatorId = v;
              _load();
            },
          ),
          _Dropdown<String?>(
            value: action,
            items: const {null: '全部操作', ...kAuditActions},
            onChanged: (v) {
              action = v;
              _load();
            },
          ),
        ]),
      ),
      const Divider(height: 1),
      Expanded(
        child: error != null
            ? EmptyState(icon: Icons.error_outline_rounded, title: error!, action: TextButton(onPressed: _load, child: const Text('重试')))
            : items.isEmpty && loading
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : items.isEmpty
                    ? const EmptyState(icon: Icons.receipt_long_outlined, title: '这段时间没有操作记录')
                    : LayoutBuilder(
                        builder: (context, c) => ListView.builder(
                          itemCount: items.length + 2,
                          itemBuilder: (context, i) {
                            final compact = c.maxWidth < 860;
                            if (i == 0) return compact ? const SizedBox.shrink() : const _AuditHeader();
                            if (i == items.length + 1) {
                              return hasMore
                                  ? Center(child: TextButton(onPressed: loading ? null : () => _load(more: true), child: Text(loading ? '加载中…' : '加载更多')))
                                  : const SizedBox(height: 24);
                            }
                            return _AuditRow(log: items[i - 1], compact: compact);
                          },
                        ),
                      ),
      ),
    ]);
  }
}

class _Dropdown<T> extends StatelessWidget {
  final T value;
  final Map<T, String> items;
  final ValueChanged<T> onChanged;
  const _Dropdown({super.key, required this.value, required this.items, required this.onChanged});
  @override
  Widget build(BuildContext context) => Container(
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(6)),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<T>(
            value: value,
            isDense: true,
            style: const TextStyle(fontSize: 13, color: Fs.text1),
            items: [for (final e in items.entries) DropdownMenuItem<T>(value: e.key, child: Text(e.value))],
            onChanged: (v) => onChanged(v as T),
          ),
        ),
      );
}

const _auditCols = [150.0, 110.0, 120.0, 180.0, 0.0, 120.0, 130.0]; // 0 = 自适应（详情）

class _AuditHeader extends StatelessWidget {
  const _AuditHeader();
  @override
  Widget build(BuildContext context) {
    const labels = ['时间', '操作人', '操作', '对象', '详情', 'IP', '设备'];
    return Container(
      color: Fs.bg,
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 9),
      child: Row(children: [
        for (var i = 0; i < labels.length; i++)
          _auditCols[i] == 0
              ? Expanded(child: Text(labels[i], style: const TextStyle(fontSize: 12, color: Fs.text3)))
              : SizedBox(width: _auditCols[i], child: Text(labels[i], style: const TextStyle(fontSize: 12, color: Fs.text3))),
      ]),
    );
  }
}

class _AuditRow extends StatelessWidget {
  final CosAuditLog log;
  final bool compact;
  const _AuditRow({required this.log, required this.compact});

  Color get _color => switch (log.action) {
        'auth.login_failed' || 'user.disable' || 'doc.delete' || 'table.delete' || 'record.delete' => Fs.red,
        'role.change' || 'security.update' || 'user.reset_password' || 'user.logout_all' => Fs.orange,
        _ => Fs.text1,
      };

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final op = log.operatorName ?? (log.operatorId == null ? '系统' : s.userName(log.operatorId!));
    final time = log.createdAt == null ? '' : fmtDateTime(log.createdAt!);
    final target = log.targetName ?? log.targetId ?? '—';
    if (compact) {
      return Container(
        decoration: const BoxDecoration(color: Colors.white, border: Border(bottom: BorderSide(color: Fs.lineLight))),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text(auditActionLabel(log.action), style: TextStyle(fontWeight: FontWeight.w600, color: _color)),
            const SizedBox(width: 8),
            Expanded(child: Text(op, style: const TextStyle(color: Fs.text2))),
            Text(time, style: const TextStyle(fontSize: 12, color: Fs.text3)),
          ]),
          if (target != '—' || log.detail != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text([if (target != '—') target, ?log.detail].join(' · '), style: const TextStyle(fontSize: 12, color: Fs.text2)),
            ),
          Text([?log.ip, ?log.device].join(' · '), style: const TextStyle(fontSize: 11, color: Fs.text3)),
        ]),
      );
    }
    Widget cell(int i, String t, {Color? color, bool select = false}) {
      final w = select
          ? SelectableText(t, maxLines: 1, style: TextStyle(fontSize: 13, color: color ?? Fs.text2))
          : Text(t, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: color ?? Fs.text2));
      return _auditCols[i] == 0 ? Expanded(child: Tooltip(message: t, child: w)) : SizedBox(width: _auditCols[i], child: w);
    }

    return Container(
      decoration: const BoxDecoration(color: Colors.white, border: Border(bottom: BorderSide(color: Fs.lineLight))),
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
      child: Row(children: [
        cell(0, time),
        cell(1, op, color: Fs.text1),
        cell(2, auditActionLabel(log.action), color: _color),
        cell(3, target),
        cell(4, log.detail ?? ''),
        cell(5, log.ip ?? '—', select: true),
        cell(6, log.device ?? '—'),
      ]),
    );
  }
}

// ---------------- 安全设置 ----------------

class AdminSecurityPane extends StatefulWidget {
  final bool readOnly;
  const AdminSecurityPane({super.key, this.readOnly = false});
  @override
  State<AdminSecurityPane> createState() => _AdminSecurityPaneState();
}

class _AdminSecurityPaneState extends State<AdminSecurityPane> {
  CosSecuritySettings? v;
  String? saved; // 上次保存的 JSON，用来判断有没有改动
  String? error;
  bool saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final x = await AppScope.read(context).api.securitySettings();
      if (mounted) {
        setState(() {
          v = x;
          saved = x.toJson().toString();
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  Future<void> _save() async {
    setState(() => saving = true);
    try {
      final x = await AppScope.read(context).api.saveSecuritySettings(v!);
      if (!mounted) return;
      setState(() {
        v = x;
        saved = x.toJson().toString();
      });
      showToast(context, '安全设置已保存，新规则对之后的登录和改密码生效');
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final x = v;
    final ro = widget.readOnly;
    if (error != null) return EmptyState(icon: Icons.error_outline_rounded, title: error!, action: TextButton(onPressed: _load, child: const Text('重试')));
    if (x == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    final dirty = x.toJson().toString() != saved;
    Widget section(String title, List<Widget> children) => Container(
          margin: const EdgeInsets.only(bottom: 14),
          decoration: BoxDecoration(color: Colors.white, border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(8)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 4), child: Text(title, style: const TextStyle(fontWeight: FontWeight.w600))),
            ...children,
          ]),
        );
    Widget number(String key, String label, int value, int min, int max, String unit, ValueChanged<int> set, {String? hint}) => ListTile(
          title: Text(label, style: const TextStyle(fontSize: 14)),
          subtitle: hint == null ? null : Text(hint, style: const TextStyle(fontSize: 12)),
          trailing: _NumberBox(key: ValueKey('sec-$key'), value: value, min: min, max: max, unit: unit, enabled: !ro, onChanged: (n) => setState(() => set(n))),
        );
    Widget toggle(String key, String label, bool value, ValueChanged<bool> set) => SwitchListTile(
          key: ValueKey('sec-$key'),
          title: Text(label, style: const TextStyle(fontSize: 14)),
          value: value,
          onChanged: ro ? null : (b) => setState(() => set(b)),
        );
    return Column(children: [
      AdminHeader(
        title: '安全设置',
        subtitle: '修改后对之后的登录、改密码生效，不会让已登录的人立即退出',
        actions: [
          if (!ro)
            FilledButton(
              key: const ValueKey('sec-save'),
              onPressed: saving || !dirty ? null : _save,
              child: const Text('保存'),
            ),
        ],
      ),
      Expanded(
        child: ListView(padding: const EdgeInsets.all(24), children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 720),
              child: Column(children: [
                section('密码规则', [
                  number('pwlen', '密码最短长度', x.passwordMinLength, 6, 32, '位', (n) => x.passwordMinLength = n),
                  toggle('pwmix', '必须同时包含字母和数字', x.passwordRequireLetterDigit, (b) => x.passwordRequireLetterDigit = b),
                  toggle('pwfirst', '首次登录强制修改密码', x.forceChangeOnFirstLogin, (b) => x.forceChangeOnFirstLogin = b),
                ]),
                section('会话', [
                  number('ttl', '登录令牌有效期', x.accessTokenTtlMinutes, 15, 1440, '分钟', (n) => x.accessTokenTtlMinutes = n,
                      hint: '到期后客户端会自动续期，不会打断使用'),
                  number('idle', '闲置多久自动退出', x.idleTimeoutMinutes, 0, 43200, '分钟', (n) => x.idleTimeoutMinutes = n, hint: '0 表示不自动退出'),
                ]),
                section('登录保护', [
                  number('fails', '连续登录失败几次后锁定', x.lockAfterFailures, 0, 20, '次', (n) => x.lockAfterFailures = n, hint: '0 表示不锁定'),
                  number('lockmin', '锁定时长', x.lockMinutes, 1, 1440, '分钟', (n) => x.lockMinutes = n),
                ]),
              ]),
            ),
          ),
        ]),
      ),
    ]);
  }
}

class _NumberBox extends StatefulWidget {
  final int value, min, max;
  final String unit;
  final bool enabled;
  final ValueChanged<int> onChanged;
  const _NumberBox({super.key, required this.value, required this.min, required this.max, required this.unit, required this.enabled, required this.onChanged});
  @override
  State<_NumberBox> createState() => _NumberBoxState();
}

class _NumberBoxState extends State<_NumberBox> {
  late final c = TextEditingController(text: '${widget.value}');
  String? err;

  @override
  void didUpdateWidget(covariant _NumberBox old) {
    super.didUpdateWidget(old);
    if (int.tryParse(c.text) != widget.value && err == null) c.text = '${widget.value}';
  }

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
        width: 160,
        child: Row(children: [
          Expanded(
            child: TextField(
              controller: c,
              enabled: widget.enabled,
              textAlign: TextAlign.right,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: InputDecoration(isDense: true, errorText: err, errorStyle: const TextStyle(fontSize: 10)),
              onChanged: (t) {
                final n = int.tryParse(t);
                setState(() => err = n == null || n < widget.min || n > widget.max ? '${widget.min}～${widget.max}' : null);
                if (err == null) widget.onChanged(n!);
              },
            ),
          ),
          const SizedBox(width: 6),
          SizedBox(width: 30, child: Text(widget.unit, style: const TextStyle(color: Fs.text3))),
        ]),
      );
}
