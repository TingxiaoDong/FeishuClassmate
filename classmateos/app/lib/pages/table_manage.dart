/// 多维表格：表管理（R-BT-09 权限、R-BT-10 重命名 / 复制 / 删除）与记录动态（评论 + 修改记录）。
library;

import 'package:flutter/material.dart';

import '../api/phase2_docs.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/doc_side_panels.dart';
import '../widgets/share_panel.dart';
import 'bitable_field.dart';
import 'table_import_export.dart';

const kTableVisibility = {'all': '组织内所有人可查看', 'members': '仅协作者可访问'};

/// 表的操作；返回值告诉侧边栏怎么刷新。
enum TableMenuResult { changed, deleted, copied }

/// 侧边栏表名旁的「…」菜单内容。
List<PopupMenuEntry<String>> tableMenuItems(AppState s, CosTableMeta t) {
  final p = t.permsFor(s.me);
  final manage = s.feature('table.manage');
  return [
    if (s.feature('table.permissions'))
      PopupMenuItem(value: 'perm', child: _mi(Icons.lock_outline_rounded, p.canManage ? '权限设置' : '查看协作者')),
    if (manage && p.canManage) ...[
      PopupMenuItem(value: 'rename', child: _mi(Icons.edit_outlined, '重命名与描述')),
    ],
    if (manage) PopupMenuItem(value: 'copy', child: _mi(Icons.copy_all_rounded, '创建副本')),
    if (s.feature('table.import') && p.canEdit) PopupMenuItem(value: 'import', child: _mi(Icons.upload_file_rounded, '导入数据')),
    if (manage && !t.builtin && (p.canDelete || p.canManage)) ...[
      const PopupMenuDivider(),
      PopupMenuItem(value: 'delete', child: _mi(Icons.delete_outline_rounded, '删除数据表', danger: true)),
    ],
  ];
}

Widget _mi(IconData i, String t, {bool danger = false}) => Row(children: [
      Icon(i, size: 18, color: danger ? Fs.red : Fs.text2),
      const SizedBox(width: 10),
      Text(t, style: TextStyle(color: danger ? Fs.red : null)),
    ]);

/// 执行菜单项；返回 (结果, 新表)。
Future<(TableMenuResult, CosTableMeta?)?> runTableAction(BuildContext context, CosTableMeta t, String action) async {
  final s = AppScope.read(context);
  final api = s.api;
  switch (action) {
    case 'import':
      return await showTableImport(context, t) ? (TableMenuResult.changed, t) : null;
    case 'perm':
      await showSharePanel(
        context,
        ShareConfig(
          title: '「${t.name}」的协作者',
          load: () => api.tablePermissions(t.key),
          save: (x) => api.saveTablePermissions(t.key, x),
          roles: kTableRoles,
          defaultRole: 'editor',
          linkOptions: kTableVisibility,
          linkTitle: '可见范围',
          canManage: t.permsFor(s.me).canManage,
        ),
      );
      return (TableMenuResult.changed, null);
    case 'rename':
      final r = await showScopedDialog<CosTableMeta>(context, (_) => _RenameTable(t));
      return r == null ? null : (TableMenuResult.changed, r);
    case 'copy':
      final r = await showScopedDialog<CosTableMeta>(context, (_) => _CopyTable(t));
      return r == null ? null : (TableMenuResult.copied, r);
    case 'delete':
      final ok = await showDialog<bool>(context: context, builder: (_) => _DeleteTable(t)) ?? false;
      if (!ok || !context.mounted) return null;
      try {
        await api.deleteTable(t.key);
        if (context.mounted) showToast(context, '已删除「${t.name}」');
        return (TableMenuResult.deleted, null);
      } catch (e) {
        if (context.mounted) showToast(context, describeError(e), error: true);
      }
  }
  return null;
}

/// 删除确认：要求输入表名（R-BT-10）。
class _DeleteTable extends StatefulWidget {
  final CosTableMeta t;
  const _DeleteTable(this.t);
  @override
  State<_DeleteTable> createState() => _DeleteTableState();
}

class _DeleteTableState extends State<_DeleteTable> {
  final ctl = TextEditingController();

  @override
  void dispose() {
    ctl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final match = ctl.text.trim() == widget.t.name;
    return AlertDialog(
      title: const Text('删除数据表'),
      content: SizedBox(
        width: 420,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('「${widget.t.name}」的所有字段、视图和记录都会被删除，无法恢复。', style: const TextStyle(fontSize: 14, height: 1.5)),
          const SizedBox(height: 14),
          Text.rich(TextSpan(children: [
            const TextSpan(text: '请输入表名 '),
            TextSpan(text: widget.t.name, style: const TextStyle(fontWeight: FontWeight.w600)),
            const TextSpan(text: ' 确认删除'),
          ]), style: const TextStyle(fontSize: 13, color: Fs.text2)),
          const SizedBox(height: 8),
          TextField(controller: ctl, autofocus: true, onChanged: (_) => setState(() {}), decoration: InputDecoration(hintText: widget.t.name)),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: Fs.red),
          onPressed: match ? () => Navigator.pop(context, true) : null,
          child: const Text('删除'),
        ),
      ],
    );
  }
}

/// 手机端：记录动态放在底部抽屉。
/// 记录动态面板：`record.comments` 或 `record.history` 任一打开就显示（代码审查 F2）。
bool hasRecordActivity(AppState s) => s.feature('record.comments') || s.feature('record.history');

/// 面板入口按钮的文字，按打开的开关显示。
String recordActivityLabel(AppState s) => switch ((s.feature('record.comments'), s.feature('record.history'))) {
      (true, true) => '评论与修改记录',
      (true, false) => '评论',
      _ => '修改记录',
    };

Future<void> showRecordActivitySheet(BuildContext context, CosTableMeta table, String recordId) {
  final s = AppScope.read(context);
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (ctx) => AppScope(
      state: s,
      child: SizedBox(height: MediaQuery.sizeOf(ctx).height * 0.75, child: RecordActivity(table: table, recordId: recordId)),
    ),
  );
}

class _RenameTable extends StatefulWidget {
  final CosTableMeta t;
  const _RenameTable(this.t);
  @override
  State<_RenameTable> createState() => _RenameTableState();
}

class _RenameTableState extends State<_RenameTable> {
  late final name = TextEditingController(text: widget.t.name);
  late final desc = TextEditingController(text: widget.t.description ?? '');
  String? nameError;
  bool saving = false;

  @override
  void dispose() {
    name.dispose();
    desc.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final n = name.text.trim();
    if (n.isEmpty) {
      setState(() => nameError = '请填写表名');
      return;
    }
    setState(() => saving = true);
    try {
      final r = await AppScope.read(context).api.updateTable(widget.t.key, name: n, description: desc.text.trim());
      if (mounted) Navigator.pop(context, r);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        saving = false;
        if (e is CosApiException && e.code == 'TABLE_NAME_EXISTS') {
          nameError = e.message;
        } else {
          showToast(context, describeError(e), error: true);
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('重命名与描述'),
        content: SizedBox(
          width: 420,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: name,
              autofocus: true,
              maxLength: 50,
              onChanged: (_) => setState(() => nameError = null),
              decoration: InputDecoration(labelText: '表名', errorText: nameError),
            ),
            const SizedBox(height: 4),
            TextField(controller: desc, maxLines: 3, maxLength: 200, decoration: const InputDecoration(labelText: '描述（选填）')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(onPressed: saving ? null : _save, child: const Text('保存')),
        ],
      );
}

class _CopyTable extends StatefulWidget {
  final CosTableMeta t;
  const _CopyTable(this.t);
  @override
  State<_CopyTable> createState() => _CopyTableState();
}

class _CopyTableState extends State<_CopyTable> {
  late final name = TextEditingController(text: '${widget.t.name} 副本');
  bool withRecords = false;
  String? nameError;
  bool saving = false;

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final n = name.text.trim();
    if (n.isEmpty) {
      setState(() => nameError = '请填写表名');
      return;
    }
    setState(() => saving = true);
    try {
      final r = await AppScope.read(context).api.copyTable(widget.t.key, name: n, withRecords: withRecords);
      if (mounted) Navigator.pop(context, r);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        saving = false;
        if (e is CosApiException && e.code == 'TABLE_NAME_EXISTS') {
          nameError = e.message;
        } else {
          showToast(context, describeError(e), error: true);
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('创建副本'),
        content: SizedBox(
          width: 420,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            TextField(
              controller: name,
              autofocus: true,
              maxLength: 50,
              onChanged: (_) => setState(() => nameError = null),
              decoration: InputDecoration(labelText: '新表名', errorText: nameError),
            ),
            CheckboxListTile(
              value: withRecords,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
              title: const Text('同时复制记录', style: TextStyle(fontSize: 14)),
              subtitle: const Text('不勾选时只复制字段和视图', style: TextStyle(fontSize: 12)),
              onChanged: (v) => setState(() => withRecords = v ?? false),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(onPressed: saving ? null : _save, child: const Text('创建')),
        ],
      );
}

// ---------------- 记录动态：评论 + 修改记录 ----------------

class RecordActivity extends StatefulWidget {
  final CosTableMeta table;
  final String recordId;
  const RecordActivity({super.key, required this.table, required this.recordId});
  @override
  State<RecordActivity> createState() => _RecordActivityState();
}

class _RecordActivityState extends State<RecordActivity> {
  /// 0 = 评论，1 = 修改记录；只开了其中一个开关时固定为那一个。
  int tab = 0;
  List<CosRecordComment>? comments;
  List<CosRecordHistory>? history;
  String? error;

  /// 评论页签和输入框只看 `record.comments`；修改记录页签只看 `record.history`（代码审查 F2）。
  bool get _hasComments => AppScope.read(context).feature('record.comments');
  bool get _hasHistory => AppScope.read(context).feature('record.history');

  @override
  void initState() {
    super.initState();
    if (!_hasComments) tab = 1;
    _load();
  }

  Future<void> _load() async {
    final api = AppScope.read(context).api;
    final wantComments = _hasComments, wantHistory = _hasHistory;
    try {
      final r = await Future.wait([
        wantComments ? api.recordComments(widget.table.key, widget.recordId) : Future.value(<CosRecordComment>[]),
        wantHistory ? api.recordHistory(widget.table.key, widget.recordId) : Future.value(<CosRecordHistory>[]),
      ]);
      if (!mounted) return;
      setState(() {
        comments = r[0] as List<CosRecordComment>;
        history = r[1] as List<CosRecordHistory>;
        error = null;
      });
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    Widget tabBtn(int i, String label, int? n) => HoverBox(
          onTap: () => setState(() => tab = i),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Container(
            padding: const EdgeInsets.only(bottom: 4),
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: tab == i ? Fs.primary : Colors.transparent, width: 2))),
            child: Text(n == null ? label : '$label $n',
                style: TextStyle(fontSize: 13, color: tab == i ? Fs.primary : Fs.text2, fontWeight: tab == i ? FontWeight.w500 : null)),
          ),
        );
    return Container(
      color: const Color(0xFFFAFBFC),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 6, 8, 0),
          child: Row(children: [
            if (s.feature('record.comments')) tabBtn(0, '评论', comments?.length),
            if (s.feature('record.history')) tabBtn(1, '修改记录', null),
            const Spacer(),
            FsIconButton(icon: Icons.refresh_rounded, size: 16, tooltip: '刷新', onPressed: _load),
          ]),
        ),
        const Divider(),
        Expanded(
          child: error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(error!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 12, color: Fs.red)),
                  ),
                )
              : (tab == 0 ? comments : history) == null
                  ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                  : tab == 0
                      ? _comments(s)
                      : _history(s),
        ),
        if (tab == 0 && s.feature('record.comments') && (widget.table.permsFor(s.me).canComment || widget.table.permissions == null))
          Container(
            padding: const EdgeInsets.all(10),
            decoration: const BoxDecoration(border: Border(top: BorderSide(color: Fs.lineLight))),
            child: CommentInput(
              hint: '写评论，@ 提及成员',
              onSend: (t) async {
                try {
                  final c = await s.api.addRecordComment(widget.table.key, widget.recordId, t);
                  if (mounted) setState(() => comments = [...?comments, c]);
                  return true;
                } catch (e) {
                  if (context.mounted) showToast(context, describeError(e), error: true);
                  return false;
                }
              },
            ),
          ),
      ]),
    );
  }

  Widget _comments(AppState s) {
    final list = comments!;
    if (list.isEmpty) {
      return const Center(child: Text('还没有评论', style: TextStyle(fontSize: 13, color: Fs.text3)));
    }
    return ListView.separated(
      padding: const EdgeInsets.all(14),
      itemCount: list.length,
      separatorBuilder: (_, _) => const SizedBox(height: 14),
      itemBuilder: (_, i) {
        final c = list[i];
        return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          FsAvatar(name: s.userName(c.userId), seed: c.userId, size: 26),
          const SizedBox(width: 8),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Text(s.userName(c.userId), style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                const SizedBox(width: 6),
                Text(fmtRelative(c.createdAt), style: const TextStyle(fontSize: 11, color: Fs.text3)),
                const Spacer(),
                // 本人或表管理者可以删除（对接说明 11.11）
                if (c.userId == s.me.userId || widget.table.permsFor(s.me).canManage)
                  FsIconButton(
                    key: ValueKey('rc_del_${c.commentId}'),
                    icon: Icons.delete_outline_rounded,
                    size: 15,
                    tooltip: '删除评论',
                    onPressed: () => _deleteComment(s, c),
                  ),
              ]),
              const SizedBox(height: 3),
              Text.rich(richTextSpan(c.content, style: const TextStyle(fontSize: 13, color: Fs.text1, height: 1.5))),
            ]),
          ),
        ]);
      },
    );
  }

  Future<void> _deleteComment(AppState s, CosRecordComment c) async {
    final ok = await confirmDialog(context, title: '删除评论', content: '删除后无法恢复。', ok: '删除', danger: true);
    if (!ok || !mounted) return;
    try {
      await s.api.deleteRecordComment(widget.table.key, widget.recordId, c.commentId);
      if (mounted) setState(() => comments = [...?comments?.where((x) => x.commentId != c.commentId)]);
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  String _val(CosFieldMeta? f, dynamic v) {
    if (isEmptyValue(v)) return '空';
    if (f?.type == 7) return v == true ? '已勾选' : '未勾选';
    if (f?.type == 5 && v is num) return fmtDate(DateTime.fromMillisecondsSinceEpoch(v.toInt()));
    final t = fieldText(v);
    return t.length > 60 ? '${t.substring(0, 60)}…' : t;
  }

  Widget _history(AppState s) {
    final list = history!;
    if (list.isEmpty) {
      return const Center(child: Text('暂无修改记录', style: TextStyle(fontSize: 13, color: Fs.text3)));
    }
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      itemCount: list.length,
      itemBuilder: (_, i) {
        final h = list[i];
        final last = i == list.length - 1;
        final verb = switch (h.action) { 'created' => '创建了记录', 'deleted' => '删除了记录', _ => '修改了 ${h.changes.length} 个字段' };
        return IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            SizedBox(
              width: 16,
              child: Column(children: [
                Container(
                  width: 9,
                  height: 9,
                  margin: const EdgeInsets.only(top: 5),
                  decoration: BoxDecoration(color: h.action == 'created' ? Fs.green : Fs.primary, shape: BoxShape.circle),
                ),
                if (!last) Expanded(child: Container(width: 1, color: Fs.line)),
              ]),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text.rich(TextSpan(children: [
                    TextSpan(text: s.operatorName(h.operatorId, viaBot: h.viaBot), style: const TextStyle(fontWeight: FontWeight.w500)),
                    TextSpan(text: ' $verb', style: const TextStyle(color: Fs.text2)),
                  ]), style: const TextStyle(fontSize: 13)),
                  Text(h.at == null ? '' : fmtDateTime(h.at!.toLocal()), style: const TextStyle(fontSize: 11, color: Fs.text3)),
                  if (h.action != 'created')
                    for (final c in h.changes)
                      Container(
                        margin: const EdgeInsets.only(top: 6),
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(6), border: Border.all(color: Fs.lineLight)),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(widget.table.field(c.fieldName)?.label ?? c.fieldName, style: const TextStyle(fontSize: 12, color: Fs.text3)),
                          const SizedBox(height: 2),
                          Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 6, children: [
                            Text(_val(widget.table.field(c.fieldName), c.before),
                                style: const TextStyle(fontSize: 12, color: Fs.text3, decoration: TextDecoration.lineThrough)),
                            const Icon(Icons.arrow_forward_rounded, size: 12, color: Fs.text3),
                            Text(_val(widget.table.field(c.fieldName), c.after), style: const TextStyle(fontSize: 12, color: Fs.text1)),
                          ]),
                        ]),
                      ),
                ]),
              ),
            ),
          ]),
        );
      },
    );
  }
}
