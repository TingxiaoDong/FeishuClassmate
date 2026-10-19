/// 通用组件：头像、标签、搜索框、悬停项、空状态、选人弹窗、格式化工具。
library;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models.dart';
import '../theme.dart';

// ---------------- 格式化 ----------------

const _weekCn = ['一', '二', '三', '四', '五', '六', '日'];
String weekdayCn(DateTime d) => '周${_weekCn[d.weekday - 1]}';
String two(int n) => n.toString().padLeft(2, '0');
String fmtHm(DateTime d) => '${two(d.hour)}:${two(d.minute)}';
String fmtDate(DateTime d) => '${d.year}-${two(d.month)}-${two(d.day)}';
String fmtDateCn(DateTime d) => '${d.month}月${d.day}日';
String fmtDateTime(DateTime d) => '${fmtDate(d)} ${fmtHm(d)}';
bool sameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;
DateTime dayStart(DateTime d) => DateTime(d.year, d.month, d.day);

/// 会话列表 / 文档列表的相对时间（今天 HH:mm、昨天、周X、MM-dd、yyyy-MM-dd）。
String fmtRelative(DateTime? d) {
  if (d == null) return '';
  final l = d.toLocal();
  final now = DateTime.now();
  final days = dayStart(now).difference(dayStart(l)).inDays;
  if (days == 0) return fmtHm(l);
  if (days == 1) return '昨天';
  if (days < 7 && days > 0) return weekdayCn(l);
  if (l.year == now.year) return '${two(l.month)}-${two(l.day)}';
  return fmtDate(l);
}

/// 消息流里的时间分隔（今天 HH:mm / 昨天 HH:mm / M月d日 HH:mm）。
String fmtMessageTime(DateTime d) {
  final l = d.toLocal();
  final now = DateTime.now();
  final days = dayStart(now).difference(dayStart(l)).inDays;
  if (days == 0) return fmtHm(l);
  if (days == 1) return '昨天 ${fmtHm(l)}';
  if (l.year == now.year) return '${fmtDateCn(l)} ${fmtHm(l)}';
  return '${l.year}年${fmtDateCn(l)} ${fmtHm(l)}';
}

String fmtSize(int bytes) {
  if (bytes <= 0) return '-';
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  if (bytes < 1024 * 1024 * 1024) return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  return '${(bytes / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
}

String fmtNumber(num v) => v == v.roundToDouble() ? v.toInt().toString() : v.toStringAsFixed(2);

String greeting() {
  final h = DateTime.now().hour;
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

// ---------------- 头像 ----------------

class FsAvatar extends StatelessWidget {
  final String name;
  final String? seed;
  final double size;
  final bool isBot;
  final bool isGroup;
  final IconData? icon;
  final Color? color;
  const FsAvatar({
    super.key,
    required this.name,
    this.seed,
    this.size = 36,
    this.isBot = false,
    this.isGroup = false,
    this.icon,
    this.color,
  });

  static Color colorFor(String s) {
    var h = 0;
    for (final c in s.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return Fs.avatarColors[h % Fs.avatarColors.length];
  }

  @override
  Widget build(BuildContext context) {
    final bg = color ?? (isBot ? Fs.primary : colorFor(seed ?? name));
    final ic = icon ?? (isBot ? Icons.smart_toy_rounded : (isGroup ? Icons.groups_rounded : null));
    final trimmed = name.trim();
    final label = trimmed.isEmpty
        ? '?'
        : (RegExp(r'^[A-Za-z]').hasMatch(trimmed)
            ? trimmed.substring(0, trimmed.length >= 2 ? 2 : 1).toUpperCase()
            : trimmed.characters.last);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: isGroup || isBot ? BoxShape.rectangle : BoxShape.circle,
        borderRadius: isGroup || isBot ? BorderRadius.circular(size * 0.28) : null,
        gradient: isBot
            ? const LinearGradient(
                colors: [Color(0xFF4E83FD), Color(0xFF7F3BF5)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              )
            : null,
        color: isBot ? null : bg,
      ),
      child: ic != null
          ? Icon(ic, color: Colors.white, size: size * 0.56)
          : Text(
              label,
              style: TextStyle(
                color: Colors.white,
                fontSize: size * (label.length > 1 ? 0.36 : 0.42),
                fontWeight: FontWeight.w600,
                height: 1,
              ),
            ),
    );
  }
}

// ---------------- 标签 ----------------

class FsTag extends StatelessWidget {
  final String text;
  final TagColor? color;
  final double fontSize;
  const FsTag(this.text, {super.key, this.color, this.fontSize = 12});

  @override
  Widget build(BuildContext context) {
    final c = color ?? TagColor.of(text);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(color: c.bg, borderRadius: BorderRadius.circular(4)),
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: c.fg, fontSize: fontSize, fontWeight: FontWeight.w500, height: 1.4),
      ),
    );
  }
}

// ---------------- 搜索框 ----------------

class FsSearchField extends StatelessWidget {
  final String hint;
  final ValueChanged<String>? onChanged;
  final TextEditingController? controller;
  final double height;
  const FsSearchField({super.key, this.hint = '搜索', this.onChanged, this.controller, this.height = 32});

  @override
  Widget build(BuildContext context) => SizedBox(
        height: height,
        child: TextField(
          controller: controller,
          onChanged: onChanged,
          style: const TextStyle(fontSize: 13),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: const TextStyle(fontSize: 13, color: Fs.text3),
            prefixIcon: const Icon(Icons.search_rounded, size: 18, color: Fs.text3),
            prefixIconConstraints: const BoxConstraints(minWidth: 34),
            contentPadding: EdgeInsets.zero,
            fillColor: Fs.hover,
            border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Fs.radius), borderSide: BorderSide.none),
            enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Fs.radius), borderSide: BorderSide.none),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(Fs.radius),
              borderSide: const BorderSide(color: Fs.primary),
            ),
          ),
        ),
      );
}

// ---------------- 悬停可点击块 ----------------

class HoverBox extends StatefulWidget {
  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onSecondaryTap;
  final bool selected;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry margin;
  final double radius;
  final Color? hoverColor;
  final Color? selectedColor;
  const HoverBox({
    super.key,
    required this.child,
    this.onTap,
    this.onSecondaryTap,
    this.selected = false,
    this.padding = EdgeInsets.zero,
    this.margin = EdgeInsets.zero,
    this.radius = Fs.radius,
    this.hoverColor,
    this.selectedColor,
  });

  @override
  State<HoverBox> createState() => _HoverBoxState();
}

class _HoverBoxState extends State<HoverBox> {
  bool hover = false;
  @override
  Widget build(BuildContext context) {
    final bg = widget.selected
        ? (widget.selectedColor ?? Fs.selected)
        : (hover && widget.onTap != null ? (widget.hoverColor ?? Fs.hover) : Colors.transparent);
    return MouseRegion(
      cursor: widget.onTap != null ? SystemMouseCursors.click : MouseCursor.defer,
      onEnter: (_) => setState(() => hover = true),
      onExit: (_) => setState(() => hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        onSecondaryTap: widget.onSecondaryTap,
        onLongPress: widget.onSecondaryTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 90),
          margin: widget.margin,
          padding: widget.padding,
          decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(widget.radius)),
          child: widget.child,
        ),
      ),
    );
  }
}

/// 只在悬停时显示子组件（行内操作按钮）。
class HoverReveal extends StatefulWidget {
  final Widget Function(BuildContext context, bool hover) builder;
  const HoverReveal({super.key, required this.builder});
  @override
  State<HoverReveal> createState() => _HoverRevealState();
}

class _HoverRevealState extends State<HoverReveal> {
  bool hover = false;
  @override
  Widget build(BuildContext context) => MouseRegion(
        onEnter: (_) => setState(() => hover = true),
        onExit: (_) => setState(() => hover = false),
        child: widget.builder(context, hover),
      );
}

// ---------------- 面板 / 空状态 ----------------

class PaneHeader extends StatelessWidget {
  final String title;
  final Widget? leading;
  final List<Widget> actions;
  final Widget? subtitle;
  final double height;
  const PaneHeader({
    super.key,
    required this.title,
    this.leading,
    this.actions = const [],
    this.subtitle,
    this.height = 56,
  });

  @override
  Widget build(BuildContext context) => Container(
        height: height,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.line))),
        child: Row(
          children: [
            if (leading != null) ...[leading!, const SizedBox(width: 10)],
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  if (subtitle != null)
                    DefaultTextStyle(
                        style: const TextStyle(fontSize: 12, color: Fs.text3), child: subtitle!),
                ],
              ),
            ),
            ...actions,
          ],
        ),
      );
}

class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? action;
  const EmptyState({super.key, required this.icon, required this.title, this.subtitle, this.action});

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 88,
                height: 88,
                decoration: const BoxDecoration(color: Fs.primaryBg, shape: BoxShape.circle),
                child: Icon(icon, size: 40, color: Fs.primary.withValues(alpha: 0.65)),
              ),
              const SizedBox(height: 16),
              Text(title, style: const TextStyle(fontSize: 15, color: Fs.text1, fontWeight: FontWeight.w500)),
              if (subtitle != null) ...[
                const SizedBox(height: 6),
                Text(subtitle!,
                    textAlign: TextAlign.center, style: const TextStyle(fontSize: 13, color: Fs.text3)),
              ],
              if (action != null) ...[const SizedBox(height: 16), action!],
            ],
          ),
        ),
      );
}

class FsIconButton extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final double size;
  final Color? color;
  const FsIconButton(
      {super.key, required this.icon, required this.tooltip, this.onPressed, this.size = 20, this.color});

  @override
  Widget build(BuildContext context) => Tooltip(
        message: tooltip,
        child: HoverBox(
          onTap: onPressed,
          padding: const EdgeInsets.all(6),
          child: Icon(icon, size: size, color: color ?? (onPressed == null ? Fs.textDisabled : Fs.text2)),
        ),
      );
}

// ---------------- 提示 / 确认 ----------------

void showToast(BuildContext context, String msg, {bool error = false}) {
  final m = ScaffoldMessenger.maybeOf(context);
  if (m == null) return;
  m.hideCurrentSnackBar();
  m.showSnackBar(SnackBar(
    duration: Duration(milliseconds: error ? 3500 : 1800),
    content: Row(
      children: [
        Icon(error ? Icons.error_rounded : Icons.check_circle_rounded,
            color: error ? Fs.red : Fs.green, size: 18),
        const SizedBox(width: 8),
        Expanded(child: Text(msg, style: const TextStyle(fontSize: 13))),
      ],
    ),
  ));
}

Future<bool> confirmDialog(BuildContext context,
    {required String title, required String content, String ok = '确定', bool danger = false}) async {
  final r = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(content, style: const TextStyle(color: Fs.text2, fontSize: 14)),
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: Fs.red) : null,
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(ok),
        ),
      ],
    ),
  );
  return r ?? false;
}

Future<void> openExternal(BuildContext context, String url) async {
  final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) showToast(context, '无法打开链接', error: true);
}

// ---------------- 文件图标 ----------------

class FileTypeIcon extends StatelessWidget {
  final String fileName;
  final double size;
  const FileTypeIcon(this.fileName, {super.key, this.size = 36});

  static (IconData, Color, String) infoOf(String name) {
    final ext = name.contains('.') ? name.split('.').last.toLowerCase() : '';
    switch (ext) {
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'webp':
      case 'bmp':
      case 'heic':
        return (Icons.image_rounded, const Color(0xFF14C0FF), '图片');
      case 'pdf':
        return (Icons.picture_as_pdf_rounded, const Color(0xFFF54A45), 'PDF');
      case 'doc':
      case 'docx':
      case 'md':
      case 'txt':
        return (Icons.description_rounded, Fs.primary, '文档');
      case 'xls':
      case 'xlsx':
      case 'csv':
        return (Icons.table_chart_rounded, const Color(0xFF2EA121), '表格');
      case 'ppt':
      case 'pptx':
      case 'key':
        return (Icons.slideshow_rounded, Fs.orange, '演示');
      case 'zip':
      case 'rar':
      case '7z':
      case 'tar':
      case 'gz':
        return (Icons.folder_zip_rounded, const Color(0xFF8F6A00), '压缩包');
      case 'mp4':
      case 'mov':
      case 'avi':
      case 'mkv':
        return (Icons.movie_rounded, Fs.purple, '视频');
      case 'mp3':
      case 'wav':
      case 'm4a':
        return (Icons.audiotrack_rounded, Fs.violet, '音频');
      case 'py':
      case 'ts':
      case 'js':
      case 'dart':
      case 'json':
      case 'yaml':
        return (Icons.code_rounded, Fs.teal, '代码');
      default:
        return (Icons.insert_drive_file_rounded, Fs.text3, '文件');
    }
  }

  static bool isImage(String name) => infoOf(name).$3 == '图片';

  @override
  Widget build(BuildContext context) {
    final (icon, color, _) = infoOf(fileName);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(size * 0.22),
      ),
      child: Icon(icon, color: color, size: size * 0.58),
    );
  }
}

// ---------------- 选人弹窗 ----------------

/// 返回选中的 user_id 列表；取消返回 null。
Future<List<String>?> pickUsers(
  BuildContext context, {
  required List<CosUser> users,
  String title = '选择成员',
  bool multiple = true,
  List<String> initial = const [],
  Set<String> exclude = const {},
  bool askGroupName = false,
  ValueChanged<String>? onGroupName,
}) {
  return showDialog<List<String>>(
    context: context,
    builder: (_) => _UserPickerDialog(
      users: users.where((u) => !exclude.contains(u.userId)).toList(),
      title: title,
      multiple: multiple,
      initial: initial,
      askGroupName: askGroupName,
      onGroupName: onGroupName,
    ),
  );
}

class _UserPickerDialog extends StatefulWidget {
  final List<CosUser> users;
  final String title;
  final bool multiple;
  final List<String> initial;
  final bool askGroupName;
  final ValueChanged<String>? onGroupName;
  const _UserPickerDialog({
    required this.users,
    required this.title,
    required this.multiple,
    required this.initial,
    required this.askGroupName,
    this.onGroupName,
  });
  @override
  State<_UserPickerDialog> createState() => _UserPickerDialogState();
}

class _UserPickerDialogState extends State<_UserPickerDialog> {
  late final Set<String> picked = {...widget.initial};
  String keyword = '';
  final groupName = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final list = widget.users
        .where((u) => keyword.isEmpty || u.name.contains(keyword) || u.userId.contains(keyword))
        .toList();
    return Dialog(
      child: SizedBox(
        width: 460,
        height: 520,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 12, 8),
              child: Row(children: [
                Expanded(
                    child: Text(widget.title,
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600))),
                FsIconButton(icon: Icons.close_rounded, tooltip: '关闭', onPressed: () => Navigator.pop(context)),
              ]),
            ),
            if (widget.askGroupName)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
                child: TextField(
                  controller: groupName,
                  decoration: const InputDecoration(hintText: '群名称（选填）'),
                ),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: FsSearchField(hint: '搜索成员', onChanged: (v) => setState(() => keyword = v.trim())),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: list.isEmpty
                  ? const Center(child: Text('没有匹配的成员', style: TextStyle(color: Fs.text3)))
                  : ListView(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      children: [
                        for (final u in list)
                          HoverBox(
                            selected: !widget.multiple && picked.contains(u.userId),
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                            onTap: () => setState(() {
                              if (widget.multiple) {
                                picked.contains(u.userId) ? picked.remove(u.userId) : picked.add(u.userId);
                              } else {
                                picked
                                  ..clear()
                                  ..add(u.userId);
                              }
                            }),
                            child: Row(children: [
                              if (widget.multiple)
                                Padding(
                                  padding: const EdgeInsets.only(right: 8),
                                  child: Icon(
                                    picked.contains(u.userId)
                                        ? Icons.check_box_rounded
                                        : Icons.check_box_outline_blank_rounded,
                                    color: picked.contains(u.userId) ? Fs.primary : Fs.textDisabled,
                                    size: 20,
                                  ),
                                ),
                              FsAvatar(name: u.name, seed: u.userId, size: 32),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(u.name, style: const TextStyle(fontSize: 14)),
                                    Text(u.email ?? u.userId,
                                        style: const TextStyle(fontSize: 12, color: Fs.text3)),
                                  ],
                                ),
                              ),
                              if (u.role == 'admin') const FsTag('管理员', color: TagColor.blue),
                            ]),
                          ),
                      ],
                    ),
            ),
            Container(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
              decoration: const BoxDecoration(border: Border(top: BorderSide(color: Fs.lineLight))),
              child: Row(children: [
                Text('已选 ${picked.length} 人', style: const TextStyle(color: Fs.text2, fontSize: 13)),
                const Spacer(),
                OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
                const SizedBox(width: 10),
                FilledButton(
                  onPressed: picked.isEmpty && !widget.multiple
                      ? null
                      : () {
                          widget.onGroupName?.call(groupName.text.trim());
                          Navigator.pop(context, picked.toList());
                        },
                  child: const Text('确定'),
                ),
              ]),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------- 日期时间选择 ----------------

Future<DateTime?> pickDateTime(BuildContext context, {DateTime? initial, bool withTime = true}) async {
  final init = initial ?? DateTime.now();
  final d = await showDatePicker(
    context: context,
    initialDate: init,
    firstDate: DateTime(2000),
    lastDate: DateTime(2100),
  );
  if (d == null || !context.mounted) return null;
  if (!withTime) return DateTime(d.year, d.month, d.day);
  final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(init));
  return DateTime(d.year, d.month, d.day, t?.hour ?? 0, t?.minute ?? 0);
}

/// 表单里的日期输入框外观。
class DateField extends StatelessWidget {
  final DateTime? value;
  final String hint;
  final bool withTime;
  final ValueChanged<DateTime?> onChanged;
  final bool enabled;
  const DateField({
    super.key,
    required this.value,
    required this.onChanged,
    this.hint = '选择日期',
    this.withTime = true,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) => InkWell(
        borderRadius: BorderRadius.circular(Fs.radius),
        onTap: !enabled
            ? null
            : () async {
                final d = await pickDateTime(context, initial: value, withTime: withTime);
                if (d != null) onChanged(d);
              },
        child: InputDecorator(
          decoration: InputDecoration(
            enabled: enabled,
            suffixIcon: value != null && enabled
                ? IconButton(
                    icon: const Icon(Icons.close_rounded, size: 16),
                    onPressed: () => onChanged(null),
                  )
                : const Icon(Icons.calendar_today_outlined, size: 16),
          ),
          child: Text(
            value == null ? hint : (withTime ? fmtDateTime(value!) : fmtDate(value!)),
            style: TextStyle(fontSize: 14, color: value == null ? Fs.text3 : Fs.text1),
          ),
        ),
      );
}
