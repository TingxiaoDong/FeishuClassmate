/// 受限试用：为已有定时任务创建“受保护文档链接”授权草稿。
/// 不创建任务、不批准、不启用；执行身份与安全版本由后端计算。
library;

import 'package:flutter/material.dart';
import '../theme.dart';
import 'outbound_widgets.dart';
import 'outbound_errors.dart';
import 'outbound_api.dart';

/// 已有任务能否在本版本授权；不能时给出原因（标“不支持”，不是失败）。
String? triggerUnsupportedReason(Map<String, dynamic> t) {
  if (t['event'] != 'schedule') return '不支持：事件触发任务（第一阶段只支持定时任务）';
  if (t['cron'] is! String || (t['cron'] as String).isEmpty) {
    return '不支持：没有定时计划';
  }
  final c = t['condition'];
  if (c is String && c.trim().isNotEmpty) {
    return '不支持：带触发条件的定时任务（可信调度器第一阶段不执行条件判断）';
  }
  return null;
}

class OutboundCreatePage extends StatefulWidget {
  final OutboundApi api;
  const OutboundCreatePage({super.key, required this.api});
  @override
  State<OutboundCreatePage> createState() => _OutboundCreatePageState();
}

class _OutboundCreatePageState extends State<OutboundCreatePage> {
  final _form = GlobalKey<FormState>();
  final _chats = TextEditingController();
  final _users = TextEditingController(), _docs = TextEditingController();
  final _limits = List.generate(4, (_) => TextEditingController());
  List<Map<String, dynamic>> _tasks = [];
  String? _taskId, _loadError;
  DateTime? _expiry;
  bool _busy = false, _loading = true;
  String? _error;

  List<String> _ids(TextEditingController c) =>
      c.text.split(RegExp(r'[,，\s]+')).where((s) => s.isNotEmpty).toList();

  Map<String, dynamic>? get _task {
    for (final t in _tasks) {
      if (t['trigger_id'] == _taskId) return t;
    }
    return null;
  }

  String? get _resultChat {
    final c = _task?['chat_id'];
    return c is String && c.isNotEmpty ? c : null;
  }

  @override
  void initState() {
    super.initState();
    _loadTasks();
  }

  Future<void> _loadTasks() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final items = await widget.api.triggers();
      if (mounted) setState(() => _tasks = items);
    } catch (e) {
      if (mounted) setState(() => _loadError = describeOutboundError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    for (final c in [_chats, _users, _docs, ..._limits]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _date() async {
    final now = DateTime.now();
    final day = await showDatePicker(
      context: context,
      firstDate: now,
      lastDate: now.add(const Duration(days: 3660)),
    );
    if (day == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: const TimeOfDay(hour: 18, minute: 0),
    );
    if (time == null || !mounted) return;
    setState(
      () => _expiry = DateTime(
        day.year,
        day.month,
        day.day,
        time.hour,
        time.minute,
      ),
    );
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final task = _task;
    if (task == null) {
      setState(() => _error = '请先选择一个已有的定时任务');
      return;
    }
    final unsupported = triggerUnsupportedReason(task);
    if (unsupported != null) {
      setState(() => _error = unsupported);
      return;
    }
    if (_expiry == null || !_expiry!.isAfter(DateTime.now())) {
      setState(() => _error = '请明确选择未来的截止时间');
      return;
    }
    final chats = <String>{
      if (_resultChat != null) _resultChat!,
      ..._ids(_chats),
    };
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final caps = await widget.api.capabilities();
      if (!caps.drafts || !caps.protectedDocLinkDraft) {
        throw StateError(
          caps.recognized ? '后端未开放文档链接草稿' : '后端协议版本前端无法识别，已关闭新建草稿',
        );
      }
      await widget.api.createDocLinkDraft(
        taskId: task['trigger_id'] as String,
        targets: [
          for (final id in chats) (type: 'chat', id: id),
          for (final id in _ids(_users)) (type: 'user', id: id),
        ],
        docIds: _ids(_docs),
        perRun: int.parse(_limits[0].text),
        perDay: int.parse(_limits[1].text),
        perTargetPerRun: int.parse(_limits[2].text),
        perTargetPerDay: int.parse(_limits[3].text),
        expiresAt: _expiry!,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('待审批草稿已创建；未批准、未启用发送，请在列表里打开审阅')),
      );
      Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() => _error = describeOutboundError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _field(
    String label,
    TextEditingController c, {
    bool required = false,
    bool number = false,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: TextFormField(
      controller: c,
      enabled: !_busy,
      keyboardType: number ? TextInputType.number : TextInputType.text,
      decoration: InputDecoration(labelText: label),
      validator: (v) {
        if (required && (v == null || v.trim().isEmpty)) return '此项必填';
        if (number && (int.tryParse(v ?? '') == null || int.parse(v!) < 1)) {
          return '请输入正整数';
        }
        return null;
      },
    ),
  );

  Widget _taskTile(Map<String, dynamic> t) {
    final reason = triggerUnsupportedReason(t);
    final id = t['trigger_id']?.toString() ?? '';
    final selected = _taskId == id;
    return ListTile(
      key: ValueKey('task-$id'),
      enabled: !_busy && reason == null,
      selected: selected,
      selectedTileColor: Fs.primaryBg,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      leading: Icon(
        selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
      ),
      onTap: () => setState(() => _taskId = id),
      title: Text('${t['name'] ?? '未命名'}（$id）'),
      subtitle: Text(
        '${t['event'] == 'schedule' ? '定时：${t['cron']} · Asia/Shanghai' : '事件：${t['event']}'}'
        ' · ${t['enabled'] == true ? '启用' : '停用'}'
        '${t['chat_id'] == null ? '' : ' · 结果群 ${t['chat_id']}'}'
        '${reason == null ? '' : '\n$reason'}',
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Fs.bg,
    appBar: AppBar(title: const Text('新建授权草稿')),
    body: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 960),
        child: Form(
          key: _form,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              const OutboundNotice(
                '受限试用：只能为你已有的定时任务授权发送“指定文档的受保护链接”，不在这里新建任务，也不支持一句话建周报。此操作只创建草稿，不授权、不启用任务；停用的任务批准时可选择“授权并启用”。',
              ),
              const SizedBox(height: 8),
              OutboundSection(
                title: '1. 选择已有任务',
                description: '仅为已有定时任务创建授权，选择后不会自动启用。',
                children: [
                  if (_loading) const LinearProgressIndicator(),
                  if (_loadError != null)
                    Text(
                      '任务列表加载失败：$_loadError',
                      style: const TextStyle(color: Fs.red),
                    ),
                  if (!_loading && _loadError == null && _tasks.isEmpty)
                    const Text('你还没有自动化任务。请先由管理流程预建定时任务。'),
                  for (final t in _tasks) _taskTile(t),
                ],
              ),
              OutboundSection(
                title: '2. 固定收件人与文档',
                children: [
                  const Text(
                    '试用阶段按稳定 ID 填写，不接受人名 / 群名作为授权依据；名称搜索选择器尚未提供。审阅页会显示对应名称，名称不可见时只显示 ID。多项以空格或逗号分隔。',
                  ),
                  if (_resultChat != null)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Text(
                        '任务的结果投递群 $_resultChat 已自动列入授权目标（必须授权，不能去掉）。',
                        key: const ValueKey('result-chat-locked'),
                      ),
                    ),
                  _field('其他固定群 ID', _chats),
                  _field('固定用户 ID', _users),
                  _field('文档 ID（只发受保护链接，不含正文）', _docs, required: true),
                ],
              ),
              OutboundSection(
                title: '3. 额度与有效期',
                children: [
                  for (var i = 0; i < 4; i++)
                    _field(
                      [
                        '每次总额度（≤1000）',
                        '每日总额度（≤10000）',
                        '每目标每次额度',
                        '每目标每日额度',
                      ][i],
                      _limits[i],
                      required: true,
                      number: true,
                    ),
                  const Text(
                    '每日额度重置时区：Asia/Shanghai。收件人可能收到链接但没有阅读权限：本授权不会改变或公开文档权限。',
                  ),
                  TextButton(
                    onPressed: _busy ? null : _date,
                    child: Text(
                      _expiry == null ? '选择授权截止日期与时间（必选）' : '截止：$_expiry（本机时区）',
                    ),
                  ),
                  const Text('“直到关闭任务”、自由 AI 正文、动态目标及服务账号模式尚未开放。'),
                ],
              ),
              if (_error != null)
                Text(_error!, style: const TextStyle(color: Fs.red)),
              if (_busy) const LinearProgressIndicator(),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: _busy || _loading ? null : _save,
                  child: const Text('创建待审批草稿'),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
