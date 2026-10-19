/// 新建数据表：对接 POST /tables，支持幂等重试与字段错误提示。
library;

import 'package:flutter/material.dart';
import '../api_client.dart';
import '../theme.dart';
import 'bitable_field.dart';

class _FieldDraft {
  final String key;
  final TextEditingController title;
  final options = TextEditingController();
  int type = 1;
  bool required;
  _FieldDraft(this.key, String name, {this.required = false})
    : title = TextEditingController(text: name);
  void dispose() {
    title.dispose();
    options.dispose();
  }
}

class CreateTableDialog extends StatefulWidget {
  final CosApiClient api;
  const CreateTableDialog({super.key, required this.api});
  @override
  State<CreateTableDialog> createState() => _CreateTableDialogState();
}

class _CreateTableDialogState extends State<CreateTableDialog> {
  final form = GlobalKey<FormState>();
  final name = TextEditingController();
  final description = TextEditingController();
  final fields = [_FieldDraft('name', '名称', required: true)];
  int serial = 0;
  bool busy = false;
  String? error;
  final Map<String, String> serverErrors = {};

  String? fieldError(String path) {
    final messages = serverErrors.entries
        .where((e) => e.key == path || e.key.startsWith('$path['))
        .map((e) => e.value);
    return messages.isEmpty ? null : messages.join('；');
  }

  // 一次表单会话复用同一请求 ID，网络重试不会重复建表。
  final requestId = 'table_${DateTime.now().microsecondsSinceEpoch}';

  @override
  void dispose() {
    name.dispose();
    description.dispose();
    for (final f in fields) {
      f.dispose();
    }
    super.dispose();
  }

  List<String> optionsOf(_FieldDraft f) => f.options.text
      .split(RegExp(r'[\n,，]'))
      .map((v) => v.trim())
      .where((v) => v.isNotEmpty)
      .toList();

  Future<void> submit() async {
    if (busy || !form.currentState!.validate()) return;
    setState(() {
      busy = true;
      error = null;
      serverErrors.clear();
    });
    try {
      final result = await widget.api.createTable(
        name: name.text.trim(),
        description: description.text.trim(),
        clientRequestId: requestId,
        primaryField: 'name',
        fields: [
          for (final f in fields)
            {
              'field_name': f.key,
              'title': f.title.text.trim(),
              'type': f.type,
              'required': f.required,
              if (f.type == 3 || f.type == 4) 'options': optionsOf(f),
            },
        ],
      );
      if (mounted) Navigator.pop(context, result);
    } catch (e) {
      if (mounted) {
        setState(() {
          if (e is CosApiException) {
            for (final item in e.errors) {
              serverErrors[item['field'].toString()] = item['message']
                  .toString();
            }
            if (e.code == 'TABLE_NAME_EXISTS') serverErrors['name'] = e.message;
          }
          error =
              e is CosApiException &&
                  (e.statusCode == 404 ||
                      e.statusCode == 405 ||
                      e.statusCode == 501)
              ? '当前后端尚未开放新建数据表接口，请完成接口适配后重试。填写内容已保留。'
              : describeError(e);
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !busy,
    child: AlertDialog(
      title: const Row(
        children: [
          Icon(Icons.add_chart_rounded, color: Fs.purple),
          SizedBox(width: 12),
          Text('新建数据表'),
        ],
      ),
      content: SizedBox(
        width: 620,
        child: SingleChildScrollView(
          child: Form(
            key: form,
            onChanged: () {
              if (serverErrors.isNotEmpty) setState(() => serverErrors.clear());
            },
            child: AbsorbPointer(
              absorbing: busy,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    '创建一张属于团队的数据表，按业务需要设置字段。',
                    style: TextStyle(color: Fs.text2, fontSize: 13),
                  ),
                  const SizedBox(height: 20),
                  TextFormField(
                    controller: name,
                    autofocus: true,
                    maxLength: 60,
                    decoration: InputDecoration(
                      errorText: fieldError('name'),
                      labelText: '数据表名称',
                      hintText: '例如：实验设备借用',
                    ),
                    validator: (v) =>
                        (v ?? '').trim().isEmpty ? '请输入数据表名称' : null,
                  ),
                  const SizedBox(height: 8),
                  TextFormField(
                    controller: description,
                    maxLength: 500,
                    minLines: 2,
                    maxLines: 3,
                    decoration: InputDecoration(
                      errorText: fieldError('description'),
                      labelText: '说明（选填）',
                      hintText: '这张表用来管理什么？',
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    '字段设置',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    '第一列为主字段（必填文本）；创建后即可添加记录。',
                    style: TextStyle(fontSize: 12, color: Fs.text3),
                  ),
                  for (final f in fields)
                    Padding(
                      key: ValueKey(f.key),
                      padding: const EdgeInsets.only(top: 12),
                      child: Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: Fs.bg,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Column(
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: TextFormField(
                                    controller: f.title,
                                    maxLength: 40,
                                    decoration: InputDecoration(
                                      errorText: fieldError(
                                        'fields[${fields.indexOf(f)}].title',
                                      ),
                                      labelText: f.key == 'name'
                                          ? '主字段名称'
                                          : '字段名称',
                                      counterText: '',
                                    ),
                                    validator: (v) {
                                      final text = (v ?? '').trim();
                                      if (text.isEmpty) return '请输入字段名称';
                                      if (fields
                                              .where(
                                                (x) =>
                                                    x.title.text
                                                        .trim()
                                                        .toLowerCase() ==
                                                    text.toLowerCase(),
                                              )
                                              .length >
                                          1) {
                                        return '字段名称不能重复';
                                      }
                                      return null;
                                    },
                                  ),
                                ),
                                const SizedBox(width: 10),
                                SizedBox(
                                  width: 108,
                                  child: DropdownButtonFormField<int>(
                                    initialValue: f.type,
                                    isExpanded: true,
                                    items: [
                                      for (final t in [
                                        1,
                                        2,
                                        3,
                                        4,
                                        5,
                                        7,
                                        11,
                                        15,
                                        17,
                                      ])
                                        DropdownMenuItem(
                                          value: t,
                                          child: Text(fieldTypeName(t)),
                                        ),
                                    ],
                                    onChanged: f.key == 'name'
                                        ? null
                                        : (v) => setState(() => f.type = v!),
                                  ),
                                ),
                                if (f.key != 'name')
                                  IconButton(
                                    tooltip: '删除字段',
                                    icon: const Icon(
                                      Icons.close_rounded,
                                      size: 18,
                                    ),
                                    onPressed: () => setState(() {
                                      fields.remove(f);
                                      f.dispose();
                                    }),
                                  ),
                              ],
                            ),
                            if (f.key != 'name')
                              CheckboxListTile(
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                title: const Text('必填'),
                                value: f.required,
                                onChanged: (v) =>
                                    setState(() => f.required = v!),
                              ),
                            if (f.type == 3 || f.type == 4)
                              TextFormField(
                                controller: f.options,
                                minLines: 2,
                                maxLines: 4,
                                decoration: InputDecoration(
                                  errorText: fieldError(
                                    'fields[${fields.indexOf(f)}].options',
                                  ),
                                  labelText: '选项',
                                  hintText: '每行一个，或用逗号分隔',
                                ),
                                validator: (_) {
                                  final opts = optionsOf(f);
                                  if (opts.isEmpty) return '至少填写一个选项';
                                  if (opts.length > 50 ||
                                      opts.any((o) => o.runes.length > 40)) {
                                    return '最多 50 个选项，每项最多 40 字';
                                  }
                                  if (opts.toSet().length != opts.length) {
                                    return '选项不能重复';
                                  }
                                  return null;
                                },
                              ),
                          ],
                        ),
                      ),
                    ),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: fields.length >= 30
                          ? null
                          : () => setState(
                              () => fields.add(
                                _FieldDraft('field_${++serial}', ''),
                              ),
                            ),
                      icon: const Icon(Icons.add_rounded),
                      label: Text('添加字段（${fields.length}/30）'),
                    ),
                  ),
                  if (error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        error!,
                        style: const TextStyle(color: Fs.red),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: busy ? null : () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        FilledButton.icon(
          onPressed: busy ? null : submit,
          icon: busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.add_rounded, size: 18),
          label: Text(busy ? '创建中…' : '创建数据表'),
        ),
      ],
    ),
  );
}
