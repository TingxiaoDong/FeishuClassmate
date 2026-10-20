/// 「我的」页（R-LG-03）：个人资料、通知设置、登录设备、收藏、修改密码、服务器设置、退出。
/// 手机端是底部第 5 个标签；桌面端从头像菜单「个人设置」进入。
/// 扫码登录的手机确认页（R-LG-02）也在这里。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/phase2_admin.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'message_more.dart' show showFavorites;
import 'notification_center.dart';

/// 摄像头扫码的接入点：iOS / Android 在 main() 里赋值为 [scanQrWithCamera]，返回扫到的文字；
/// 为 null 时（电脑、网页版）「扫一扫」改为粘贴二维码内容。
Future<String?> Function(BuildContext context)? qrScanner;

class MePage extends StatelessWidget {
  const MePage({super.key});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final me = s.me;
    final mobile = MediaQuery.sizeOf(context).width < 720;
    Widget group(List<Widget> children) => Container(
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: Fs.line)),
          child: Column(children: [
            for (var i = 0; i < children.length; i++) ...[
              if (i > 0) const Divider(height: 1, indent: 48),
              children[i],
            ],
          ]),
        );
    Widget item(IconData icon, String title, VoidCallback onTap, {String? trailing, Color? color, Key? key, Color iconColor = Fs.text2}) =>
        ListTile(
          key: key,
          leading: Icon(icon, size: 20, color: color ?? iconColor),
          title: Text(title, style: TextStyle(fontSize: 14, color: color ?? Fs.text1)),
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            if (trailing != null)
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 200),
                child: Text(trailing, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, color: Fs.text3)),
              ),
            if (color == null) const Icon(Icons.chevron_right_rounded, size: 18, color: Fs.text3),
          ]),
          onTap: onTap,
        );

    return Container(
      color: Fs.bg,
      child: ListView(
        padding: EdgeInsets.symmetric(horizontal: mobile ? 12 : 24, vertical: mobile ? 12 : 28),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                if (!mobile)
                  const Padding(
                    padding: EdgeInsets.only(bottom: 16),
                    child: Text('个人设置', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
                  ),
                _ProfileCard(),
                const SizedBox(height: 12),
                group([
                  item(Icons.edit_note_rounded, '个性签名', () => _editText(context, '个性签名', me.statusText ?? '', (v) => s.api.updateMyProfile(statusText: v)),
                      trailing: me.statusText ?? '未设置', key: const ValueKey('me-status')),
                  item(Icons.phone_outlined, '电话', () => _editText(context, '电话', me.phone ?? '', (v) => s.api.updateMyProfile(phone: v), phone: true),
                      trailing: me.phone ?? '未设置'),
                ]),
                group([
                  if (mobile && s.feature('notifications'))
                    item(Icons.notifications_none_rounded, '通知中心', () => openNotificationCenter(context),
                        trailing: s.notifUnread > 0 ? '${s.notifUnread} 条未读' : null),
                  if (s.feature('notifications')) item(Icons.notifications_active_outlined, '通知设置', () => showNotificationSettings(context)),
                  if (s.feature('message.favorite')) item(Icons.star_outline_rounded, '我的收藏', () => showFavorites(context)),
                  if (s.feature('auth.qr_login'))
                    item(Icons.qr_code_scanner_rounded, '扫一扫', () => scanToLogin(context), key: const ValueKey('me-scan')),
                ]),
                group([
                  if (s.feature('auth.sessions'))
                    item(Icons.devices_other_rounded, '登录设备', () => pushScoped(context, const LoginDevicesPage()), key: const ValueKey('me-devices')),
                  if (s.feature('auth.password'))
                    item(Icons.lock_outline_rounded, '修改密码', () => showChangePassword(context), key: const ValueKey('me-password')),
                  item(Icons.dns_outlined, '服务器设置', () => _serverSettings(context), trailing: s.api.origin),
                  if (s.canAdmin) item(Icons.admin_panel_settings_outlined, '管理后台', () => s.go(AppModule.admin)),
                ]),
                group([
                  item(Icons.logout_rounded, '退出登录', () async {
                    if (await confirmDialog(context, title: '退出登录', content: '确定要退出当前账号吗？', ok: '退出')) s.logout();
                  }, color: Fs.red),
                  if (s.feature('auth.sessions'))
                    item(Icons.phonelink_erase_rounded, '退出所有设备', () async {
                      final ok = await confirmDialog(context,
                          title: '退出所有设备', content: '所有电脑、手机和浏览器上的登录都会失效，包括这台设备。', ok: '全部退出', danger: true);
                      if (!ok || !context.mounted) return;
                      try {
                        await s.api.logoutAllMine();
                        s.logout();
                      } catch (e) {
                        if (context.mounted) showToast(context, describeError(e), error: true);
                      }
                    }, color: Fs.red, key: const ValueKey('me-logout-all')),
                ]),
              ]),
            ),
          ),
        ],
      ),
    );
  }

  static Future<void> _editText(BuildContext context, String title, String initial, Future<dynamic> Function(String) save,
      {bool phone = false}) async {
    final s = AppScope.read(context);
    final c = TextEditingController(text: initial);
    final v = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('修改$title'),
        content: SizedBox(
          width: 360,
          child: TextField(
            controller: c,
            autofocus: true,
            maxLength: phone ? 20 : 60,
            keyboardType: phone ? TextInputType.phone : TextInputType.text,
            decoration: InputDecoration(hintText: phone ? '手机号或座机' : '例如：在实验室 / 开会中'),
            onSubmitted: (v) => Navigator.pop(ctx, v),
          ),
        ),
        actions: [
          OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('保存')),
        ],
      ),
    );
    c.dispose();
    if (v == null || v.trim() == initial) return;
    try {
      final u = await save(v.trim());
      s.setMe(u);
      if (context.mounted) showToast(context, '已保存');
    } catch (e) {
      if (context.mounted) showToast(context, describeError(e), error: true);
    }
  }

  static Future<void> _serverSettings(BuildContext context) async {
    final s = AppScope.read(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('服务器设置'),
        content: SizedBox(
          width: 400,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('当前服务器', style: TextStyle(fontSize: 12, color: Fs.text3)),
            const SizedBox(height: 4),
            SelectableText(s.api.baseUrl, style: const TextStyle(fontSize: 14)),
            const SizedBox(height: 14),
            const Text('切换服务器需要先退出登录，然后在登录页的「服务器设置」里填写新地址。',
                style: TextStyle(fontSize: 13, color: Fs.text2, height: 1.5)),
          ]),
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: s.api.baseUrl));
              Navigator.pop(ctx);
              showToast(context, '已复制服务器地址');
            },
            child: const Text('复制地址'),
          ),
          OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('退出并切换')),
        ],
      ),
    );
    if (ok == true) s.logout();
  }
}

class _ProfileCard extends StatefulWidget {
  @override
  State<_ProfileCard> createState() => _ProfileCardState();
}

class _ProfileCardState extends State<_ProfileCard> {
  bool uploading = false;

  Future<void> _changeAvatar() async {
    final s = AppScope.read(context);
    setState(() => uploading = true);
    try {
      final f = await s.pickAndUpload(imageOnly: true);
      if (f == null) return;
      if (f.size > 5 * 1024 * 1024) throw const CosApiException(0, '头像图片不能超过 5 MB');
      s.setMe(await s.api.updateMyProfile(avatarFileKey: f.fileKey));
      if (mounted) showToast(context, '头像已更新');
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    } finally {
      if (mounted) setState(() => uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final me = s.me;
    final sub = [me.department, me.title].whereType<String>().where((e) => e.isNotEmpty).join(' · ');
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(colors: [Color(0xFFE8F0FF), Color(0xFFF5F8FF)]),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Fs.line),
      ),
      child: Row(children: [
        Tooltip(
          message: '更换头像',
          child: InkWell(
            key: const ValueKey('me-avatar'),
            customBorder: const CircleBorder(),
            onTap: uploading ? null : _changeAvatar,
            child: Stack(clipBehavior: Clip.none, children: [
              FsAvatar(name: me.name, seed: me.userId, size: 64, url: me.avatarUrl),
              Positioned(
                right: -2,
                bottom: -2,
                child: Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(color: Colors.white, shape: BoxShape.circle, border: Border.all(color: Fs.line)),
                  child: uploading
                      ? const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.5))
                      : const Icon(Icons.photo_camera_outlined, size: 12, color: Fs.text2),
                ),
              ),
            ]),
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text(me.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600))),
              if (me.isAdmin) ...[const SizedBox(width: 8), const FsTag('管理员', color: TagColor.blue)],
            ]),
            if (sub.isNotEmpty) ...[const SizedBox(height: 4), Text(sub, style: const TextStyle(fontSize: 13, color: Fs.text2))],
            const SizedBox(height: 4),
            Text(me.email ?? me.userId, style: const TextStyle(fontSize: 12, color: Fs.text3)),
          ]),
        ),
      ]),
    );
  }
}

// ---------------- 修改密码 ----------------

Future<void> showChangePassword(BuildContext context) => showScopedDialog<void>(context, (_) => const _ChangePasswordDialog());

class _ChangePasswordDialog extends StatefulWidget {
  const _ChangePasswordDialog();
  @override
  State<_ChangePasswordDialog> createState() => _ChangePasswordDialogState();
}

class _ChangePasswordDialogState extends State<_ChangePasswordDialog> {
  final oldC = TextEditingController(), newC = TextEditingController(), againC = TextEditingController();
  String? oldErr, newErr, againErr, error;
  bool saving = false, show = false;

  @override
  void dispose() {
    oldC.dispose();
    newC.dispose();
    againC.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      oldErr = oldC.text.isEmpty ? '请输入原密码' : null;
      newErr = newC.text.length < 6 ? '新密码至少 6 位' : (newC.text == oldC.text ? '新密码不能和原密码相同' : null);
      againErr = againC.text != newC.text ? '两次输入的新密码不一致' : null;
      error = null;
    });
    if (oldErr != null || newErr != null || againErr != null) return;
    setState(() => saving = true);
    try {
      await AppScope.read(context).api.changePassword(oldC.text, newC.text);
      if (!mounted) return;
      Navigator.pop(context);
      showToast(context, '密码已修改，其他设备需要重新登录');
    } on CosApiException catch (e) {
      setState(() {
        saving = false;
        // 后端的密码规则以错误码区分：原密码错误 / 新密码不符合规则
        if (e.code == 'INVALID_PASSWORD') {
          oldErr = e.message;
        } else if (e.code == 'WEAK_PASSWORD') {
          newErr = e.message;
        } else {
          error = e.friendly;
        }
      });
    } catch (e) {
      setState(() {
        saving = false;
        error = describeError(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    InputDecoration deco(String label, String? err) => InputDecoration(
          labelText: label,
          errorText: err,
          suffixIcon: IconButton(
            icon: Icon(show ? Icons.visibility_off_outlined : Icons.visibility_outlined, size: 18),
            onPressed: () => setState(() => show = !show),
          ),
        );
    return AlertDialog(
      title: const Text('修改密码'),
      content: SizedBox(
        width: 380,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(key: const ValueKey('pw-old'), controller: oldC, obscureText: !show, decoration: deco('原密码', oldErr), autofocus: true),
          const SizedBox(height: 10),
          TextField(key: const ValueKey('pw-new'), controller: newC, obscureText: !show, decoration: deco('新密码', newErr)),
          const SizedBox(height: 10),
          TextField(
            key: const ValueKey('pw-again'),
            controller: againC,
            obscureText: !show,
            decoration: deco('再次输入新密码', againErr),
            onSubmitted: (_) => _save(),
          ),
          const SizedBox(height: 8),
          const Align(
            alignment: Alignment.centerLeft,
            child: Text('密码规则以管理员的安全设置为准，修改后其他设备会退出登录。', style: TextStyle(fontSize: 12, color: Fs.text3)),
          ),
          if (error != null) ...[
            const SizedBox(height: 8),
            Text(error!, style: const TextStyle(color: Fs.red, fontSize: 13)),
          ],
        ]),
      ),
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          key: const ValueKey('pw-save'),
          onPressed: saving ? null : _save,
          child: saving ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('确认修改'),
        ),
      ],
    );
  }
}

// ---------------- 登录设备 ----------------

class LoginDevicesPage extends StatefulWidget {
  const LoginDevicesPage({super.key});
  @override
  State<LoginDevicesPage> createState() => _LoginDevicesPageState();
}

class _LoginDevicesPageState extends State<LoginDevicesPage> {
  List<CosLoginSession>? items;
  String? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final l = await AppScope.read(context).api.mySessions();
      if (mounted) setState(() => items = l);
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  static IconData _icon(String? p) => switch (p) {
        'ios' || 'android' => Icons.smartphone_rounded,
        'web' => Icons.public_rounded,
        'windows' || 'macos' || 'linux' => Icons.laptop_mac_rounded,
        _ => Icons.devices_other_rounded,
      };

  Future<void> _revoke(CosLoginSession x) async {
    final ok = await confirmDialog(context, title: '下线设备', content: '「${x.deviceName}」会退出登录，需要重新输入密码。', ok: '下线', danger: true);
    if (!ok || !mounted) return;
    try {
      await AppScope.read(context).api.revokeSession(x.sessionId);
      setState(() => items!.removeWhere((e) => e.sessionId == x.sessionId));
      if (mounted) showToast(context, '已下线');
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = items;
    return Scaffold(
      appBar: AppBar(title: const Text('登录设备')),
      backgroundColor: Fs.bg,
      body: error != null
          ? EmptyState(icon: Icons.error_outline_rounded, title: error!)
          : l == null
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : ListView(padding: const EdgeInsets.all(16), children: [
                  const Padding(
                    padding: EdgeInsets.only(bottom: 10, left: 4),
                    child: Text('以下设备登录过你的账号。看到不认识的设备，下线后请尽快修改密码。', style: TextStyle(fontSize: 13, color: Fs.text3)),
                  ),
                  for (final x in l)
                    Card(
                      elevation: 0,
                      margin: const EdgeInsets.only(bottom: 8),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: const BorderSide(color: Fs.line)),
                      child: ListTile(
                        leading: Icon(_icon(x.platform), color: Fs.primary),
                        title: Row(children: [
                          Flexible(child: Text(x.deviceName, overflow: TextOverflow.ellipsis)),
                          if (x.current) ...[const SizedBox(width: 8), const FsTag('本机', color: TagColor.green)],
                        ]),
                        subtitle: Text(
                          [if (x.lastActiveAt != null) '最近活跃 ${fmtRelative(x.lastActiveAt)}', if (x.ip != null) 'IP ${x.ip}'].join(' · '),
                          style: const TextStyle(fontSize: 12),
                        ),
                        trailing: x.current
                            ? null
                            : TextButton(
                                key: ValueKey('revoke-${x.sessionId}'),
                                style: TextButton.styleFrom(foregroundColor: Fs.red),
                                onPressed: () => _revoke(x),
                                child: const Text('下线'),
                              ),
                      ),
                    ),
                ]),
    );
  }
}

// ---------------- 扫码登录（手机确认） ----------------

/// 手动输入（粘贴）登录码：电脑端、网页版，或手机没有相机权限时用。
Future<String?> askLoginCode(BuildContext context, {bool noCamera = false}) async {
  final c = TextEditingController();
  final v = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(noCamera ? '扫一扫' : '输入登录码'),
      content: SizedBox(
        width: 380,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(
              noCamera
                  ? '这台设备还不能用摄像头扫码。可以把二维码下方的「复制登录码」内容粘贴到这里。'
                  : '在电脑登录页的二维码下方点「复制登录码」，把内容粘贴到这里。',
              style: const TextStyle(fontSize: 13, color: Fs.text2, height: 1.5)),
          const SizedBox(height: 10),
          TextField(
            key: const ValueKey('qr-paste'),
            controller: c,
            autofocus: true,
            decoration: const InputDecoration(hintText: 'classmateos://qr-login?…'),
          ),
        ]),
      ),
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('下一步')),
      ],
    ),
  );
  c.dispose();
  return v;
}

/// 「扫一扫」：手机上用摄像头扫码，其他设备粘贴二维码内容；识别出登录二维码后进入确认页。
Future<void> scanToLogin(BuildContext context) async {
  final String? content = qrScanner != null ? await qrScanner!(context) : await askLoginCode(context, noCamera: true);
  if (content == null || content.trim().isEmpty || !context.mounted) return;
  final id = parseQrLogin(content);
  if (id == null) {
    showToast(context, '这不是 ClassmateOS 的登录二维码', error: true);
    return;
  }
  await pushScoped(context, QrConfirmPage(qrId: id));
}

class QrConfirmPage extends StatefulWidget {
  final String qrId;
  const QrConfirmPage({super.key, required this.qrId});
  @override
  State<QrConfirmPage> createState() => _QrConfirmPageState();
}

class _QrConfirmPageState extends State<QrConfirmPage> {
  String? device;
  String? error;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    _scan();
  }

  Future<void> _scan() async {
    try {
      final st = await AppScope.read(context).api.scanQrLogin(widget.qrId);
      if (mounted) setState(() => device = st.deviceName ?? '桌面客户端');
    } catch (e) {
      if (mounted) setState(() => error = describeError(e));
    }
  }

  Future<void> _act(bool confirm) async {
    final api = AppScope.read(context).api;
    setState(() => busy = true);
    try {
      confirm ? await api.confirmQrLogin(widget.qrId) : await api.cancelQrLogin(widget.qrId);
      if (!mounted) return;
      Navigator.pop(context);
      showToast(context, confirm ? '已确认登录' : '已取消登录');
    } catch (e) {
      if (mounted) {
        setState(() {
          busy = false;
          error = describeError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('登录确认')),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Icon(error != null ? Icons.error_outline_rounded : Icons.laptop_mac_rounded, size: 72, color: error != null ? Fs.red : Fs.primary),
              const SizedBox(height: 20),
              if (error != null)
                Text(error!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 15, color: Fs.red))
              else if (device == null)
                const CircularProgressIndicator(strokeWidth: 2)
              else ...[
                Text('确认登录 $device？', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                const Text('请确认是你本人在操作，不要替别人扫码。', style: TextStyle(color: Fs.text3)),
                const SizedBox(height: 28),
                SizedBox(
                  width: 260,
                  child: FilledButton(
                    key: const ValueKey('qr-confirm'),
                    onPressed: busy ? null : () => _act(true),
                    child: const Text('确认登录'),
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  width: 260,
                  child: OutlinedButton(onPressed: busy ? null : () => _act(false), child: const Text('取消登录')),
                ),
              ],
            ]),
          ),
        ),
      );
}
