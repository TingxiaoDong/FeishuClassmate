/// refresh token 的保存位置（代码审查 F3）。
///
/// - iOS / Android / macOS：存系统钥匙串 / Keystore（flutter_secure_storage）。
///   旧版本存在 SharedPreferences 里的 `cos_refresh` 首次读取时迁移过去，然后删除明文。
///   钥匙串不可用（如 macOS 未签名、系统拒绝访问）时退回 SharedPreferences，保证还能自动登录。
/// - Web / Windows / Linux：维持原来的 SharedPreferences。
library;

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 安全存储的最小接口，便于测试替换。
abstract class SecureKv {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class _FlutterSecureKv implements SecureKv {
  static const _s = FlutterSecureStorage(
    // 传统钥匙串：不需要 keychain-access-groups 签名配置，沙盒内可用
    mOptions: MacOsOptions(usesDataProtectionKeychain: false, accountName: 'classmateos'),
    iOptions: IOSOptions(accountName: 'classmateos', accessibility: KeychainAccessibility.first_unlock_this_device),
  );
  @override
  Future<String?> read(String key) => _s.read(key: key);
  @override
  Future<void> write(String key, String value) => _s.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _s.delete(key: key);
}

/// 当前平台是否应使用安全存储。
bool get secureTokenPlatform =>
    !kIsWeb &&
    (defaultTargetPlatform == TargetPlatform.iOS ||
        defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.macOS);

class TokenStore {
  static const prefsKey = 'cos_refresh';
  static const secureKey = 'cos_refresh_token';

  /// null 表示不用安全存储（Web / Windows / Linux）。
  final SecureKv? secure;

  TokenStore({SecureKv? secure, bool? useSecure})
      : secure = (useSecure ?? secureTokenPlatform) ? (secure ?? _FlutterSecureKv()) : null;

  static final TokenStore instance = TokenStore();

  /// 读取 refresh token；发现旧的明文值时迁移到安全存储并删除明文。
  Future<String?> read() async {
    final prefs = await SharedPreferences.getInstance();
    final legacy = prefs.getString(prefsKey);
    final sec = secure;
    if (sec == null) return legacy;
    String? v;
    try {
      v = await sec.read(secureKey);
    } catch (e) {
      debugPrint('TokenStore: 钥匙串读取失败，使用旧值：$e');
      return legacy;
    }
    if (legacy != null) {
      // 旧版本留下的明文：以它为准迁移（它一定比钥匙串里的新，因为写入成功时会删掉明文）
      try {
        await sec.write(secureKey, legacy);
        await prefs.remove(prefsKey);
        return legacy;
      } catch (e) {
        debugPrint('TokenStore: 迁移到钥匙串失败，保留旧值：$e');
        return legacy;
      }
    }
    return v;
  }

  Future<void> write(String token) async {
    final prefs = await SharedPreferences.getInstance();
    final sec = secure;
    if (sec != null) {
      try {
        await sec.write(secureKey, token);
        await prefs.remove(prefsKey);
        return;
      } catch (e) {
        debugPrint('TokenStore: 钥匙串写入失败，退回本地保存：$e');
      }
    }
    await prefs.setString(prefsKey, token);
  }

  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(prefsKey);
    try {
      await secure?.delete(secureKey);
    } catch (_) {}
  }
}
