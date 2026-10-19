/// 运行时环境变量（仅原生桌面 / 移动端；Web 端恒为 null）。
/// 用于：COS_BASE_URL（不重新编译即可换服务器）、COS_DEV_USER / COS_DEV_PASS /
/// COS_DEV_MODULE（开发调试自动登录并打开指定模块）。
library;

export 'dev_env_stub.dart' if (dart.library.io) 'dev_env_io.dart';
