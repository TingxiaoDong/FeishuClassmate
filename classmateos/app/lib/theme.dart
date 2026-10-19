/// 飞书风格设计令牌（颜色 / 圆角 / 主题）。
library;

import 'package:flutter/material.dart';

class Fs {
  Fs._();
  // 品牌色
  static const primary = Color(0xFF3370FF);
  static const primaryHover = Color(0xFF4E83FD);
  static const primaryPressed = Color(0xFF245BDB);
  static const primaryLight = Color(0xFFE1EAFF);
  static const primaryBg = Color(0xFFF0F4FF);
  // 文本
  static const text1 = Color(0xFF1F2329);
  static const text2 = Color(0xFF646A73);
  static const text3 = Color(0xFF8F959E);
  static const textDisabled = Color(0xFFBBBFC4);
  // 线与背景
  static const line = Color(0xFFDEE0E3);
  static const lineLight = Color(0xFFEFF0F1);
  static const bg = Color(0xFFF5F6F7);
  static const bgNav = Color(0xFFEEF0F3);
  static const hover = Color(0xFFF2F3F5);
  static const selected = Color(0xFFE1EAFF);
  // 功能色
  static const red = Color(0xFFF54A45);
  static const green = Color(0xFF34C724);
  static const orange = Color(0xFFFF8800);
  static const yellow = Color(0xFFFFC60A);
  static const purple = Color(0xFF7F3BF5);
  static const cyan = Color(0xFF14C0FF);
  static const teal = Color(0xFF00B6C1);
  static const violet = Color(0xFFD136D1);

  // 气泡
  static const bubbleMine = Color(0xFFCCE0FF);
  static const bubbleOther = Color(0xFFF2F3F5);

  static const avatarColors = [primary, purple, teal, orange, Color(0xFF2EA121), red, cyan, violet];

  static const radius = 6.0;
  static const radiusL = 10.0;

  static List<BoxShadow> shadow = [
    BoxShadow(color: const Color(0xFF1F2329).withValues(alpha: 0.06), blurRadius: 8, offset: const Offset(0, 2)),
    BoxShadow(color: const Color(0xFF1F2329).withValues(alpha: 0.04), blurRadius: 2),
  ];
  static List<BoxShadow> shadowL = [
    BoxShadow(color: const Color(0xFF1F2329).withValues(alpha: 0.12), blurRadius: 24, offset: const Offset(0, 8)),
  ];
}

/// 标签配色（浅底 + 深字），对齐飞书多维表格选项色。
class TagColor {
  final Color bg;
  final Color fg;
  const TagColor(this.bg, this.fg);

  static const blue = TagColor(Color(0xFFD9E5FF), Color(0xFF245BDB));
  static const green = TagColor(Color(0xFFD9F5D6), Color(0xFF237B19));
  static const orange = TagColor(Color(0xFFFEEAD2), Color(0xFFB26206));
  static const red = TagColor(Color(0xFFFDE2E2), Color(0xFFD83931));
  static const purple = TagColor(Color(0xFFECE2FE), Color(0xFF6425D0));
  static const wathet = TagColor(Color(0xFFD9F3FD), Color(0xFF037EAA));
  static const yellow = TagColor(Color(0xFFFAF1D1), Color(0xFF8F6A00));
  static const carmine = TagColor(Color(0xFFFDDDEF), Color(0xFFC71077));
  static const turquoise = TagColor(Color(0xFFD5F6F2), Color(0xFF067A6B));
  static const gray = TagColor(Color(0xFFEFF0F1), Color(0xFF646A73));

  static const _palette = [blue, green, orange, purple, wathet, yellow, carmine, turquoise, red];

  static const _semantic = <String, TagColor>{
    '完成': green, '已完成': green, '可公开': green, '在库': green, '正常': green, '成功': green,
    '已接收': green, '已发表': green, '通过': green, 'done': green, 'accepted': green,
    '进行中': blue, '借出': blue, '审稿中': blue, '已投稿': blue, 'in_progress': blue,
    '逾期': red, '保密': red, '故障': red, '失败': red, '拒稿': red, '损坏': red, '丢失': red,
    '搁置': gray, '已取消': gray, '未设置': gray, '未知': gray, 'cancelled': gray,
    '规划中': orange, '未开始': orange, '待处理': orange, '维修中': orange, '撰写中': purple,
  };

  static TagColor of(String text) {
    final s = _semantic[text];
    if (s != null) return s;
    var h = 0;
    for (final c in text.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return _palette[h % _palette.length];
  }
}

ThemeData buildFsTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: Fs.primary).copyWith(
    primary: Fs.primary,
    onPrimary: Colors.white,
    surface: Colors.white,
    onSurface: Fs.text1,
    outline: Fs.line,
    outlineVariant: Fs.lineLight,
    error: Fs.red,
    surfaceContainerHighest: Fs.hover,
  );
  const fallback = ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'sans-serif'];
  final base = ThemeData(useMaterial3: true, colorScheme: scheme, fontFamilyFallback: fallback);
  final border = OutlineInputBorder(
    borderRadius: BorderRadius.circular(Fs.radius),
    borderSide: const BorderSide(color: Color(0xFFD0D3D6)),
  );
  return base.copyWith(
    scaffoldBackgroundColor: Colors.white,
    splashFactory: NoSplash.splashFactory,
    hoverColor: Fs.hover,
    dividerColor: Fs.line,
    dividerTheme: const DividerThemeData(color: Fs.line, thickness: 1, space: 1),
    textTheme: base.textTheme.apply(bodyColor: Fs.text1, displayColor: Fs.text1),
    iconTheme: const IconThemeData(color: Fs.text2, size: 20),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.white,
      foregroundColor: Fs.text1,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(color: Fs.text1, fontSize: 16, fontWeight: FontWeight.w600),
      shape: Border(bottom: BorderSide(color: Fs.line)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      isDense: true,
      filled: true,
      fillColor: Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      hintStyle: const TextStyle(color: Fs.text3, fontSize: 14),
      labelStyle: const TextStyle(color: Fs.text2, fontSize: 14),
      border: border,
      enabledBorder: border,
      focusedBorder: border.copyWith(borderSide: const BorderSide(color: Fs.primary, width: 1.2)),
      errorBorder: border.copyWith(borderSide: const BorderSide(color: Fs.red)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Fs.primary,
        minimumSize: const Size(64, 36),
        padding: const EdgeInsets.symmetric(horizontal: 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Fs.radius)),
        textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Fs.text1,
        minimumSize: const Size(64, 36),
        padding: const EdgeInsets.symmetric(horizontal: 14),
        side: const BorderSide(color: Color(0xFFD0D3D6)),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Fs.radius)),
        textStyle: const TextStyle(fontSize: 14),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: Fs.primary,
        minimumSize: const Size(48, 34),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Fs.radius)),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: Colors.white,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      titleTextStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: Fs.text1),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: Colors.white,
      surfaceTintColor: Colors.transparent,
      elevation: 6,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      textStyle: const TextStyle(fontSize: 14, color: Fs.text1),
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(color: const Color(0xE61F2329), borderRadius: BorderRadius.circular(6)),
      textStyle: const TextStyle(color: Colors.white, fontSize: 12),
      waitDuration: const Duration(milliseconds: 400),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: Fs.text1,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      width: 360,
    ),
    checkboxTheme: CheckboxThemeData(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(3)),
      side: const BorderSide(color: Color(0xFFBBBFC4), width: 1.2),
    ),
    chipTheme: base.chipTheme.copyWith(
      side: const BorderSide(color: Fs.line),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      labelStyle: const TextStyle(fontSize: 13, color: Fs.text1),
      selectedColor: Fs.primaryLight,
      checkmarkColor: Fs.primary,
    ),
    scrollbarTheme: ScrollbarThemeData(
      thickness: const WidgetStatePropertyAll(6),
      radius: const Radius.circular(3),
      thumbColor: WidgetStatePropertyAll(Fs.text1.withValues(alpha: 0.18)),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: Colors.white,
      indicatorColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      height: 60,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => TextStyle(
            fontSize: 11,
            color: s.contains(WidgetState.selected) ? Fs.primary : Fs.text2,
          )),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(
            size: 24,
            color: s.contains(WidgetState.selected) ? Fs.primary : Fs.text2,
          )),
    ),
  );
}
