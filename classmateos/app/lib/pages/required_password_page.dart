import 'package:flutter/material.dart';
import '../api/phase2_admin.dart';
import '../api_client.dart';

/// 不构造 AppState，不请求业务接口，也不连接 WS。
class RequiredPasswordPage extends StatefulWidget {
  final CosApiClient api;
  final VoidCallback onCompleted, onLogout;
  const RequiredPasswordPage({super.key, required this.api, required this.onCompleted, required this.onLogout});
  @override
  State<RequiredPasswordPage> createState() => _RequiredPasswordPageState();
}

class _RequiredPasswordPageState extends State<RequiredPasswordPage> {
  final old = TextEditingController(), password = TextEditingController(), again = TextEditingController();
  String? error;
  bool busy = false;
  bool changed = false;
  @override
  void dispose() { old.dispose(); password.dispose(); again.dispose(); super.dispose(); }
  Future<void> save() async {
    if (!changed && (old.text.isEmpty || password.text.isEmpty || password.text != again.text)) {
      setState(() => error = '请填写当前密码，并确保两次新密码一致');
      return;
    }
    setState(() { busy = true; error = null; });
    try {
      if (!changed) {
        await widget.api.changePassword(old.text, password.text);
        changed = true;
        old.clear(); password.clear(); again.clear();
      }
      // 刷新取得清除标记后的会话；网络失败时只重试刷新，不重复改密。
      if (!await widget.api.refresh()) throw const CosApiException(0, '无法刷新登录状态');
      if (mounted) widget.onCompleted();
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
  @override
  Widget build(BuildContext context) => PopScope(canPop: false, child: Scaffold(
    body: Center(child: SingleChildScrollView(padding: const EdgeInsets.all(24), child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 420), child: Card(child: Padding(
        padding: const EdgeInsets.all(28), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Icon(Icons.lock_reset, size: 48),
          const SizedBox(height: 16),
          Text(changed ? '密码已修改' : '请先修改初始密码', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          const Text('为保护实验室账号，修改密码后才能进入应用。密码规则由服务器校验。'),
          if (!changed) ...[
            const SizedBox(height: 20),
            TextField(key: const ValueKey('required-old'), controller: old, obscureText: true, decoration: const InputDecoration(labelText: '当前密码')),
            TextField(key: const ValueKey('required-new'), controller: password, obscureText: true, decoration: const InputDecoration(labelText: '新密码')),
            TextField(key: const ValueKey('required-again'), controller: again, obscureText: true, decoration: const InputDecoration(labelText: '确认新密码')),
          ],
          if (error != null) Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          const SizedBox(height: 20),
          FilledButton(onPressed: busy ? null : save, child: Text(busy ? '处理中…' : changed ? '重试进入应用' : '修改密码并进入')),
          TextButton(onPressed: busy ? null : widget.onLogout, child: const Text('退出登录')),
        ]),
      ))),
    )),
  ));
}
