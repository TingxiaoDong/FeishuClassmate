/// 预授权独立界面（受限试用：为已有定时任务授权）。
/// 正式入口由工作台开关控制；能否操作始终以服务端协议、能力和 deliveryEnabled 为准。
library;

import 'package:flutter/material.dart';
import '../theme.dart';
import 'outbound_widgets.dart';
import 'outbound_errors.dart';
import 'outbound_models.dart';

class OutboundPageView extends StatefulWidget {
  final OutboundRepository repository;
  final Future<void> Function(BuildContext)? onCreate;
  const OutboundPageView({super.key, required this.repository, this.onCreate});
  @override
  State<OutboundPageView> createState() => _OutboundPageViewState();
}

class _OutboundPageViewState extends State<OutboundPageView> {
  final List<OutboundDraft> _tasks = [];
  OutboundCapabilities _caps = const OutboundCapabilities();
  bool _busy = false;
  String? _error, _cursor;
  String _query = '', _filter = 'all';
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final caps = await widget.repository.capabilities();
      final page = await widget.repository.tasks(cursor: more ? _cursor : null);
      if (!mounted) return;
      setState(() {
        _caps = caps;
        if (!more) _tasks.clear();
        _tasks.addAll(page.items);
        _cursor = page.nextCursor;
      });
    } catch (e) {
      if (mounted) setState(() => _error = describeOutboundError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _open(OutboundDraft task) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => OutboundReviewPage(
          repository: widget.repository,
          initial: task,
          capabilities: _caps,
        ),
      ),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final visible = _tasks
        .where(
          (t) =>
              (_filter == 'all' || t.status == _filter) &&
              '${t.name} ${t.taskId} ${t.principalLabel}'
                  .toLowerCase()
                  .contains(_query.toLowerCase()),
        )
        .toList();
    return Scaffold(
      backgroundColor: Fs.bg,
      appBar: AppBar(
        title: const Text('自动化授权管理'),
        actions: [
          IconButton(
            onPressed: _busy ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
            tooltip: '刷新',
          ),
          if (widget.onCreate != null)
            Padding(
              padding: const EdgeInsets.only(right: 20),
              child: FilledButton.icon(
                onPressed: _busy
                    ? null
                    : () async {
                        await widget.onCreate!(context);
                        if (mounted) await _load();
                      },
                icon: const Icon(Icons.add, size: 18),
                label: const Text('新建授权草稿'),
              ),
            ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1240),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              const Row(
                children: [
                  Text(
                    '发送授权',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
                  ),
                  SizedBox(width: 12),
                  OutboundBadge('受限试用', color: Fs.orange),
                ],
              ),
              const SizedBox(height: 8),
              const Text(
                '管理定时任务的持续发送范围，查看授权状态与实际投递结果。',
                style: TextStyle(color: Fs.text2, fontSize: 14),
              ),
              const SizedBox(height: 20),
              const OutboundNotice(
                '仅支持已有定时任务向固定群 / 用户发送指定文档的受保护链接。授权的是以后每次发送的范围；重新启用任务不会恢复已撤销的授权。',
              ),
              if (_caps.notes.isNotEmpty || _caps.unsupported.isNotEmpty)
                ExpansionTile(
                  initiallyExpanded: true,
                  tilePadding: const EdgeInsets.symmetric(horizontal: 12),
                  title: const Text(
                    '当前支持范围',
                    style: TextStyle(fontSize: 13, color: Fs.text2),
                  ),
                  children: [
                    for (final note in _caps.notes)
                      OutboundNotice(note, warning: true),
                    if (_caps.unsupported.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: Text(
                          '不支持（后端未开放，不是加载失败）：${_caps.unsupported.join('、')}',
                          key: const ValueKey('outbound-unsupported'),
                          style: const TextStyle(fontSize: 13, color: Fs.text2),
                        ),
                      ),
                  ],
                ),
              const SizedBox(height: 16),
              OutboundSection(
                title: '授权记录',
                description: '任务开关、授权有效性与实际投递状态分别展示。搜索与筛选仅作用于已加载记录。',
                children: [
                  Wrap(
                    spacing: 12,
                    runSpacing: 12,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      SizedBox(
                        width: 260,
                        child: TextField(
                          onChanged: (v) => setState(() => _query = v),
                          decoration: const InputDecoration(
                            hintText: '搜索任务名称、ID 或执行人',
                            prefixIcon: Icon(Icons.search, size: 18),
                          ),
                        ),
                      ),
                      for (final item in const {
                        'all': '全部',
                        'pending': '待授权',
                        'active': '有效',
                        'revoked': '已撤销',
                        'expired': '已过期',
                      }.entries)
                        ChoiceChip(
                          label: Text(item.value),
                          selected: _filter == item.key,
                          showCheckmark: false,
                          onSelected: (_) => setState(() => _filter = item.key),
                        ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  if (_error != null) OutboundNotice(_error!, warning: true),
                  if (_busy) const LinearProgressIndicator(minHeight: 2),
                  if (!_busy && _error == null && visible.isEmpty)
                    OutboundEmpty(
                      _tasks.isEmpty ? '暂无自动化任务' : '没有匹配的授权记录',
                      _tasks.isEmpty
                          ? '新建授权草稿，为已有定时任务设置发送范围。'
                          : '试试其他关键词或状态，或加载更多记录。',
                    ),
                  for (final task in visible) _taskRow(task),
                  if (_cursor != null)
                    Center(
                      child: TextButton(
                        onPressed: _busy ? null : () => _load(more: true),
                        child: const Text('加载更多'),
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _taskRow(OutboundDraft task) => Material(
    color: Colors.white,
    child: InkWell(
      onTap: () => _open(task),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 8),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: Fs.lineLight)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: Fs.primaryBg,
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Icon(Icons.schedule_outlined, color: Fs.primary),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 10,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        task.name,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      OutboundBadge(
                        outboundStatus(task.status),
                        color: task.status == 'active'
                            ? Fs.green
                            : task.status == 'pending'
                            ? Fs.orange
                            : Fs.text2,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '${task.principalLabel} · ${task.schedule} · ${task.timezone}',
                    style: const TextStyle(color: Fs.text2, fontSize: 13),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '收件人：${task.targets.map((t) => t.label).join('、')}   ·   ${task.resources.length} 项资料',
                    style: const TextStyle(color: Fs.text2, fontSize: 13),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      OutboundBadge(
                        '任务：${!task.enabledKnown
                            ? "未知"
                            : task.enabled
                            ? "启用"
                            : "停用"}',
                        color: Fs.text2,
                      ),
                      OutboundBadge(
                        '持续投递：${task.deliveryEnabled ? "已开放" : "未开放"}',
                        color: task.deliveryEnabled ? Fs.primary : Fs.text2,
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, size: 20, color: Fs.text3),
          ],
        ),
      ),
    ),
  );
}

class OutboundReviewPage extends StatefulWidget {
  final OutboundRepository repository;
  final OutboundDraft initial;
  final OutboundCapabilities capabilities;
  const OutboundReviewPage({
    super.key,
    required this.repository,
    required this.initial,
    required this.capabilities,
  });
  @override
  State<OutboundReviewPage> createState() => _OutboundReviewPageState();
}

class _OutboundReviewPageState extends State<OutboundReviewPage> {
  late OutboundDraft _draft = widget.initial;
  late OutboundCapabilities _caps = widget.capabilities;
  final Set<String> _selected = {};
  final List<OutboundRun> _runs = [];
  bool _busy = false, _confirmed = false, _fresh = false;
  String? _notice, _runError, _cursor;
  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _busy = true;
      _fresh = false;
      _confirmed = false;
      _selected.clear();
    });
    try {
      final caps = await widget.repository.capabilities();
      final latest = await widget.repository.latestDraft(_draft);
      if (!mounted) return;
      setState(() {
        _caps = caps;
        _draft = latest;
        _fresh = true;
      });
      await _loadRuns();
    } catch (e) {
      if (mounted) setState(() => _notice = describeOutboundError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadRuns({bool more = false}) async {
    try {
      final page = await widget.repository.runs(
        _draft.taskKind,
        _draft.taskId,
        cursor: more ? _cursor : null,
      );
      if (!mounted) return;
      setState(() {
        if (!more) _runs.clear();
        _runs.addAll(page.items);
        _cursor = page.nextCursor;
        _runError = null;
      });
    } catch (e) {
      if (mounted) setState(() => _runError = describeOutboundError(e));
    }
  }

  Future<void> _approve() async {
    final reviewed = _draft;
    final selected = Set<String>.of(_selected);
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final caps = await widget.repository.capabilities();
      final latest = await widget.repository.latestDraft(reviewed);
      if (!mounted) return;
      if (latest.draftId != reviewed.draftId ||
          latest.version != reviewed.version ||
          latest.digest != reviewed.digest ||
          latest.revision != reviewed.revision ||
          latest.principalId != reviewed.principalId ||
          latest.approverId != reviewed.approverId) {
        setState(() {
          _draft = latest;
          _caps = caps;
          _selected.clear();
          _confirmed = false;
          _notice =
              '配置已变化：${reviewed.revision} → ${latest.revision}。已刷新摘要，请重新逐项审阅；本次没有批准。';
        });
        return;
      }
      final block = latest.approvalBlock(caps, DateTime.now());
      if (block != null) {
        setState(() => _notice = block);
        return;
      }
      final result = await widget.repository.approve(
        reviewed,
        expectedRevision: reviewed.revision,
        expectedVersion: reviewed.version,
        expectedDigest: reviewed.digest,
        selectedTargetKeys: selected,
      );
      if (!mounted) return;
      setState(() {
        _draft = result;
        _confirmed = false;
        _selected.clear();
        _notice =
            result.status == 'active' &&
                result.enabled &&
                result.deliveryEnabled
            ? '后端已确认授权有效且任务启用。'
            : result.status == 'active'
            ? '授权已保存，但当前未开启持续投递；请查看任务开关及部署能力。'
            : '请求已返回，请以当前任务与授权状态为准。';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _notice = describeOutboundError(e);
        _fresh = false;
        _confirmed = false;
        _selected.clear();
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _revoke() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('撤销持续发送授权？'),
        content: const Text('尚未提交的发送应由后端阻止。已经发送的消息不能承诺撤回；重新启用任务也不会恢复这次授权。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('确认撤销'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final result = await widget.repository.revoke(_draft);
      if (mounted) {
        setState(() {
          _draft = result;
          _confirmed = false;
          _selected.clear();
          _notice = '授权状态：${outboundStatus(result.status)}';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _notice = describeOutboundError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _line(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 7),
    child: LayoutBuilder(
      builder: (context, c) => c.maxWidth < 480
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: const TextStyle(color: Fs.text3, fontSize: 12),
                ),
                const SizedBox(height: 4),
                SelectableText(
                  value,
                  style: const TextStyle(fontSize: 14, height: 1.5),
                ),
              ],
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 155,
                  child: Text(
                    label,
                    style: const TextStyle(
                      color: Fs.text2,
                      fontSize: 13,
                      height: 1.6,
                    ),
                  ),
                ),
                Expanded(
                  child: SelectableText(
                    value,
                    style: const TextStyle(fontSize: 14, height: 1.5),
                  ),
                ),
              ],
            ),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final d = _draft;
    final block = d.approvalBlock(_caps, DateTime.now());
    final canSubmit =
        _fresh &&
        !_busy &&
        block == null &&
        _confirmed &&
        d.targets.every((t) => _selected.contains(t.key));
    return Scaffold(
      backgroundColor: Fs.bg,
      appBar: AppBar(
        title: const Text('授权摘要与运行记录'),
        actions: [
          IconButton(
            onPressed: _busy ? null : _refresh,
            icon: const Icon(Icons.refresh),
            tooltip: '重新读取摘要',
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1040),
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              if (_busy) const LinearProgressIndicator(),
              if (_notice != null)
                Text(
                  _notice!,
                  key: const ValueKey('outbound-notice'),
                  style: const TextStyle(color: Fs.orange),
                ),
              OutboundSection(
                title: '任务与授权状态',
                children: [
                  _line('任务', '${d.name}（${d.taskKind}/${d.taskId}）'),
                  _line('触发条件 / 实际执行计划', '${d.schedule} · 时区 ${d.timezone}'),
                  if (d.taskSummary.isNotEmpty) _line('任务安全配置', d.taskSummary),
                  _line(
                    '执行身份',
                    '${d.principalLabel}（${d.principalId}）${d.serviceAccount ? " · 服务账号" : ""}',
                  ),
                  _line('本次批准人', d.approverId),
                  _line(
                    '任务开关',
                    !d.enabledKnown
                        ? '后端未提供'
                        : d.enabled
                        ? '启用'
                        : '停用',
                  ),
                  _line('持续投递', d.deliveryEnabled ? '后端已开放' : '未启用，授权有效不代表已发送'),
                  if (d.draftExpiresAt != null)
                    _line('草稿审批截止', d.draftExpiresAt!.toLocal().toString()),
                  _line('授权状态', outboundStatus(d.status)),
                  _line('安全版本', d.revision),
                  _line(
                    '授权编号 / 历史批准人',
                    '${d.grantId ?? "无"} / ${d.approvedBy ?? "无"}',
                  ),
                ],
              ),
              OutboundSection(
                title: '固定收件人',
                description: '逐项确认固定收件人（候选目标不默认勾选）',
                children: [
                  for (final target in d.targets)
                    CheckboxListTile(
                      controlAffinity: ListTileControlAffinity.leading,
                      value: _selected.contains(target.key),
                      title: Text(target.label),
                      subtitle: Text(
                        '${target.identity.isEmpty ? '' : '${target.identity}\n'}稳定 ID：${target.key}'
                        '${d.resultTarget?.key == target.key ? '\n这也是任务的最终结果投递群' : ''}',
                      ),
                      onChanged: _busy
                          ? null
                          : (v) => setState(() {
                              if (v == true) {
                                _selected.add(target.key);
                              } else {
                                _selected.remove(target.key);
                              }
                            }),
                    ),
                  _line(
                    '最终结果投递目标',
                    d.resultTarget == null
                        ? '无'
                        : '${d.resultTarget!.label}（${d.resultTarget!.key}），必须列入上面的授权目标，不是天然免授权',
                  ),
                ],
              ),
              OutboundSection(
                title: '资料与输出范围',
                children: [
                  for (final r in d.resources)
                    _line(
                      '资料 ${r.name.isEmpty ? '（名称不可见，仅凭 ID）' : r.name}',
                      '${r.kind}:${r.id}\n允许输出字段：${d.outputMode == 'protected_doc_link' ? '仅文档链接，不输出正文或字段' : r.fields.join('、')}',
                    ),
                  _line('输出模式', d.outputMode),
                  _line('受控模板', d.template),
                  _line('保密内容约束', d.confidentiality),
                ],
              ),
              OutboundSection(
                title: '额度与有效期',
                children: [
                  _line(
                    '额度',
                    '每次 ${d.perRun} 条 / 每日 ${d.perDay} 条${d.perTarget == null ? "" : " / 每目标每次 ${d.perTarget} 条"}',
                  ),
                  _line('每目标每日额度', d.perTargetPerDay?.toString() ?? '后端未提供此维度'),
                  _line('每日额度重置时区', d.quotaTimezone),
                  _line(
                    '有效期',
                    d.untilDisabled
                        ? '直到关闭任务（可随时撤销）'
                        : d.validUntil?.toIso8601String() ?? '未明确选择',
                  ),
                ],
              ),
              OutboundSection(
                title: '确认持续发送授权',
                children: [
                  const Text(
                    '受保护链接：收件人可能收到链接但没有阅读权限——发送链接不会自动授予文档访问权限，也不会公开文档。需要对方能读，请另行在文档里分享。',
                    key: ValueKey('outbound-link-permission'),
                  ),
                  const Text('这次授权的是以后每次发送的范围（目标、文档、额度、有效期），不是逐字批准未来的消息内容。'),
                  const Text('动态收件人本页面不开放。限定资料 AI 输出只有后端读取隔离真实接通后才可审批。'),
                  if (block != null)
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: Text(block, style: const TextStyle(color: Fs.red)),
                    ),
                  CheckboxListTile(
                    value: _confirmed,
                    onChanged: _busy
                        ? null
                        : (v) => setState(() => _confirmed = v == true),
                    title: const Text(
                      '我确认授权未来每次在上述范围内发送；仅发送指定文档的受保护链接，不附带 AI 正文，不改变文档访问权限。',
                    ),
                  ),
                  Wrap(
                    spacing: 12,
                    runSpacing: 8,
                    children: [
                      FilledButton(
                        key: const ValueKey('approve-outbound'),
                        onPressed: canSubmit ? _approve : null,
                        child: const Text('授权并启用'),
                      ),
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () => Navigator.maybePop(context),
                        child: const Text('取消'),
                      ),
                      if (d.canRevoke)
                        OutlinedButton(
                          onPressed: _busy ? null : _revoke,
                          child: const Text('撤销授权'),
                        ),
                    ],
                  ),
                ],
              ),
              OutboundSection(
                title: '运行与每目标投递结果',
                description: '以服务端回执为准，计算完成不代表投递成功。',
                children: [
                  if (_runError != null) Text('运行记录加载失败：$_runError'),
                  if (_runError == null && _runs.isEmpty)
                    const Text('暂无运行记录，不能据此判断发送成功'),
                  for (final run in _runs)
                    OutboundRunCard(
                      run: run,
                      onOpen: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => OutboundRunDetailPage(
                            repository: widget.repository,
                            runId: run.id,
                            initial: run,
                          ),
                        ),
                      ),
                    ),
                  if (_cursor != null)
                    TextButton(
                      onPressed: _busy ? null : () => _loadRuns(more: true),
                      child: const Text('更多运行记录'),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _reasonText(String? code) => code == null
    ? '无'
    : '${outboundErrorText[code] ?? outboundStatus(code)}（$code）';

String _time(DateTime? t) =>
    t == null ? '未知' : t.toLocal().toString().split('.').first;

class OutboundRunCard extends StatelessWidget {
  final OutboundRun run;
  final VoidCallback? onOpen;
  const OutboundRunCard({super.key, required this.run, this.onOpen});
  @override
  Widget build(BuildContext context) {
    // 有问题的目标排在前面，上线前必须一眼看到失败目标和原因。
    final ordered = [...run.deliveries]
      ..sort(
        (a, b) => (a.status == 'sent' ? 1 : 0) - (b.status == 'sent' ? 1 : 0),
      );
    return Card(
      elevation: 0,
      color: Colors.white,
      margin: const EdgeInsets.symmetric(vertical: 8),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: const BorderSide(color: Fs.line),
      ),
      child: InkWell(
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SelectableText('运行 ${run.id}'),
              Text(
                run.summary,
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
              if (run.startedAt != null) Text('开始：${_time(run.startedAt)}'),
              if (run.documentCreated) const Text('文档已创建；投递状态单独见下方，不代表已送达。'),
              for (final d in ordered)
                SelectableText(
                  '${d.target.label}（${d.target.key}）：${outboundStatus(d.status)}\n'
                  '原因：${_reasonText(d.reason)} / 消息 ID：${d.messageId ?? "无"}${_laterAttemptText(d.laterAttempt)}',
                ),
              if (onOpen != null)
                const Align(
                  alignment: Alignment.centerRight,
                  child: Text('查看运行详情 ›', style: TextStyle(color: Colors.blue)),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 单运行详情：重新向服务端读取，不使用列表里的本地副本判断结果。
class OutboundRunDetailPage extends StatefulWidget {
  final OutboundRepository repository;
  final String runId;
  final OutboundRun? initial;
  const OutboundRunDetailPage({
    super.key,
    required this.repository,
    required this.runId,
    this.initial,
  });
  @override
  State<OutboundRunDetailPage> createState() => _OutboundRunDetailPageState();
}

class _OutboundRunDetailPageState extends State<OutboundRunDetailPage> {
  OutboundRun? _run;
  String? _error;
  bool _busy = false;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant OutboundRunDetailPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.runId != widget.runId ||
        oldWidget.repository != widget.repository) {
      _run = null;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await widget.repository.runDetail(widget.runId);
      if (mounted) setState(() => _run = r);
    } catch (e) {
      if (mounted) setState(() => _error = describeOutboundError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = _run;
    return Scaffold(
      backgroundColor: Fs.bg,
      appBar: AppBar(
        title: const Text('运行详情'),
        actions: [
          IconButton(
            onPressed: _busy ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1040),
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              if (_busy) const LinearProgressIndicator(),
              if (_error != null)
                Text(
                  '运行详情加载失败：$_error（下面不显示旧数据，避免误判）',
                  style: const TextStyle(color: Fs.red),
                ),
              if (r != null && _error == null) ...[
                SelectableText('运行 ID：${r.id}'),
                Text(
                  r.summary,
                  key: const ValueKey('run-summary'),
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 16,
                  ),
                ),
                SelectableText('触发时刻：${r.occurrenceId ?? "未知"}'),
                Text(
                  '开始：${_time(r.startedAt)} / 结束：${r.finishedAt == null ? "未结束" : _time(r.finishedAt)}',
                ),
                SelectableText(
                  '授权编号：${r.grantId ?? "未知"}\n任务安全版本：${r.taskRevision ?? "未知"}',
                ),
                if (r.documentCreated) const Text('文档已创建，但是否送达以下面每个目标的回执为准。'),
                const Text(
                  '结果只来自服务端逐目标回执，不根据模型文字或本地操作推断成功。没有“强制发送”；失败重放由可信调度器处理，前端不直接发送。消息可能已保存但未实时推送，请刷新运行、会话及消息确认。',
                ),
                const Divider(),
                if (r.deliveries.isEmpty)
                  const Text(
                    '没有任何投递回执：无法确认是否发送，不能视为成功。',
                    key: ValueKey('run-no-delivery'),
                  ),
                for (final d in r.deliveries)
                  Card(
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                      side: const BorderSide(color: Fs.lineLight),
                    ),
                    color: d.status == 'sent' ? Colors.white : Fs.orangeLight,
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: SelectableText(
                        '${d.target.label}\n稳定 ID：${d.target.key}\n'
                        '状态：${outboundStatus(d.status)}\n'
                        '原因：${_reasonText(d.reason)}\n'
                        '消息 ID：${d.messageId ?? "无（不能据此断言未发送）"}\n'
                        '文档：${d.docId ?? "无"} / 用途：${d.purpose == 'final' ? '最终结果' : (d.purpose ?? '未知')}\n'
                        '逻辑消息：${d.logicalMessageId ?? "未知"}\n'
                        '更新时间：${_time(d.updatedAt)}${_laterAttemptText(d.laterAttempt)}',
                      ),
                    ),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

String _laterAttemptText(OutboundLaterAttempt? a) {
  if (a == null) return '';
  return '\n后续尝试（不改变本次运行状态）'
      '\n后续运行 ID：${a.runId.isEmpty ? "未知" : a.runId}'
      '\n后续状态：${outboundStatus(a.status)} / 原因：${_reasonText(a.code)}'
      '\n后续消息 ID：${a.messageId ?? "无"} / 时间：${_time(a.at)}';
}
