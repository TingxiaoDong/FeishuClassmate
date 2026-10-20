/// 本机的设备名和平台，登录时发给后端（「登录设备」列表显示用，迭代 5 批次 1）。
library;

export 'device_label_stub.dart' if (dart.library.io) 'device_label_io.dart';
