import 'dart:io';

/// 平台：macos | windows | linux | ios | android（后端约定的取值）。
String localPlatform() {
  if (Platform.isMacOS) return 'macos';
  if (Platform.isWindows) return 'windows';
  if (Platform.isLinux) return 'linux';
  if (Platform.isIOS) return 'ios';
  if (Platform.isAndroid) return 'android';
  return 'unknown';
}

/// 设备名：电脑用主机名（去掉 .local），手机用平台名。
String localDeviceName() {
  const names = {'macos': 'Mac', 'windows': 'Windows 电脑', 'linux': 'Linux 电脑', 'ios': 'iPhone', 'android': 'Android 手机'};
  final p = localPlatform();
  if (p == 'ios' || p == 'android') return names[p]!;
  try {
    final h = Platform.localHostname.replaceAll(RegExp(r'\.local$'), '').trim();
    if (h.isNotEmpty) return h;
  } catch (_) {}
  return names[p] ?? '桌面客户端';
}
