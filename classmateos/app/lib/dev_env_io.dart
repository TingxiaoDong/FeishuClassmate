import 'dart:io';

String? devEnv(String key) {
  final v = Platform.environment[key];
  return v == null || v.isEmpty ? null : v;
}
