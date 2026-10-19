/// 登录页（飞书风格：左侧品牌区 + 右侧登录卡片）。
library;

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../models.dart';
import '../theme.dart';

class AppLogo extends StatelessWidget {
  final double size;
  const AppLogo({super.key, this.size = 40});
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(size * 0.26),
          gradient: const LinearGradient(
            colors: [Color(0xFF00D6B9), Color(0xFF3370FF), Color(0xFF7F3BF5)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
        ),
        child: Icon(Icons.auto_awesome_mosaic_rounded, color: Colors.white, size: size * 0.58),
      );
}

class LoginPage extends StatefulWidget {
  final String initialBaseUrl;
  final String? initialUser;
  final void Function(CosApiClient api, CosUser me) onLoggedIn;
  const LoginPage({super.key, required this.initialBaseUrl, required this.onLoggedIn, this.initialUser});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  late final user = TextEditingController(text: widget.initialUser ?? 'admin');
  final pass = TextEditingController(text: 'admin');
  late final server = TextEditingController(text: widget.initialBaseUrl);
  String? error;
  bool busy = false;
  bool showPass = false;
  bool showServer = false;

  Future<void> _login() async {
    if (user.text.trim().isEmpty || pass.text.isEmpty) {
      setState(() => error = '请输入用户名和密码');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    var base = server.text.trim();
    if (base.endsWith('/')) base = base.substring(0, base.length - 1);
    final api = CosApiClient(base);
    try {
      final me = await api.login(user.text.trim(), pass.text);
      if (!mounted) return;
      widget.onLoggedIn(api, me);
    } catch (e) {
      setState(() => error = describeError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 900;
    return Scaffold(
      backgroundColor: const Color(0xFFF2F5FA),
      body: Row(
        children: [
          if (wide) const Expanded(flex: 5, child: _BrandPanel()),
          Expanded(
            flex: 6,
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: _card(context),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _card(BuildContext context) => Container(
        width: 400,
        padding: const EdgeInsets.fromLTRB(36, 40, 36, 28),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          boxShadow: Fs.shadowL,
        ),
        child: AutofillGroup(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Row(children: [
                AppLogo(size: 36),
                SizedBox(width: 10),
                Text('ClassmateOS', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
              ]),
              const SizedBox(height: 28),
              const Text('账号登录', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              const Text('使用实验室账号登录协作平台', style: TextStyle(color: Fs.text3, fontSize: 14)),
              const SizedBox(height: 28),
              TextField(
                controller: user,
                autofillHints: const [AutofillHints.username],
                textInputAction: TextInputAction.next,
                style: const TextStyle(fontSize: 15),
                decoration: const InputDecoration(
                  hintText: '用户名或用户 ID',
                  prefixIcon: Icon(Icons.person_outline_rounded, size: 20),
                  contentPadding: EdgeInsets.symmetric(vertical: 13),
                ),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: pass,
                obscureText: !showPass,
                autofillHints: const [AutofillHints.password],
                style: const TextStyle(fontSize: 15),
                onSubmitted: (_) => _login(),
                decoration: InputDecoration(
                  hintText: '密码',
                  prefixIcon: const Icon(Icons.lock_outline_rounded, size: 20),
                  contentPadding: const EdgeInsets.symmetric(vertical: 13),
                  suffixIcon: IconButton(
                    tooltip: showPass ? '隐藏密码' : '显示密码',
                    icon: Icon(showPass ? Icons.visibility_outlined : Icons.visibility_off_outlined, size: 19),
                    onPressed: () => setState(() => showPass = !showPass),
                  ),
                ),
              ),
              AnimatedSize(
                duration: const Duration(milliseconds: 160),
                child: showServer
                    ? Padding(
                        padding: const EdgeInsets.only(top: 14),
                        child: TextField(
                          controller: server,
                          style: const TextStyle(fontSize: 13),
                          decoration: const InputDecoration(
                            labelText: '服务器地址',
                            prefixIcon: Icon(Icons.dns_outlined, size: 18),
                          ),
                        ),
                      )
                    : const SizedBox(width: double.infinity),
              ),
              if (error != null)
                Container(
                  margin: const EdgeInsets.only(top: 14),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFDE2E2),
                    borderRadius: BorderRadius.circular(Fs.radius),
                  ),
                  child: Row(children: [
                    const Icon(Icons.error_rounded, color: Fs.red, size: 16),
                    const SizedBox(width: 8),
                    Expanded(child: Text(error!, style: const TextStyle(color: Color(0xFFD83931), fontSize: 13))),
                  ]),
                ),
              const SizedBox(height: 24),
              SizedBox(
                height: 44,
                child: FilledButton(
                  onPressed: busy ? null : _login,
                  child: busy
                      ? const SizedBox(
                          width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('登录', style: TextStyle(fontSize: 16)),
                ),
              ),
              const SizedBox(height: 18),
              Row(
                children: [
                  const Expanded(
                    child: Text('开发账号 admin / admin',
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: Fs.text3, fontSize: 12)),
                  ),
                  TextButton.icon(
                    onPressed: () => setState(() => showServer = !showServer),
                    icon: Icon(showServer ? Icons.expand_less_rounded : Icons.settings_outlined, size: 16),
                    label: Text(showServer ? '收起' : '服务器设置', style: const TextStyle(fontSize: 13)),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
}

class _BrandPanel extends StatelessWidget {
  const _BrandPanel();

  @override
  Widget build(BuildContext context) {
    const features = [
      (Icons.chat_bubble_rounded, '即时消息', '单聊群聊、机器人卡片，消息实时送达'),
      (Icons.grid_view_rounded, '多维表格', '实验室 23 张数据表，表格与看板两种视图'),
      (Icons.description_rounded, '云文档', 'Markdown 编写，讲解稿与研究报告集中管理'),
      (Icons.event_note_rounded, '日历与任务', '会议排期、帮扶提醒，一处安排'),
    ];
    return Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          colors: [Color(0xFF2B5FE8), Color(0xFF3370FF), Color(0xFF5B8CFF)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Stack(
        children: [
          Positioned(right: -80, top: -60, child: _bubble(260, 0.10)),
          Positioned(left: -60, bottom: -40, child: _bubble(220, 0.08)),
          Positioned(right: 60, bottom: 120, child: _bubble(90, 0.12)),
          Padding(
            padding: const EdgeInsets.fromLTRB(56, 64, 48, 48),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Container(
                    padding: const EdgeInsets.all(3),
                    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
                    child: const AppLogo(size: 36),
                  ),
                  const SizedBox(width: 12),
                  const Text('ClassmateOS',
                      style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700)),
                ]),
                const Spacer(),
                const Text('飞书同学的\n四端协作平台',
                    style: TextStyle(color: Colors.white, fontSize: 36, fontWeight: FontWeight.w700, height: 1.3)),
                const SizedBox(height: 14),
                Text('消息、表格、文档、日程一站式协同，手机与电脑同步',
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.85), fontSize: 15)),
                const SizedBox(height: 40),
                for (final f in features)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 18),
                    child: Row(children: [
                      Container(
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.16),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Icon(f.$1, color: Colors.white, size: 20),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(f.$2,
                                style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 2),
                            Text(f.$3,
                                style: TextStyle(color: Colors.white.withValues(alpha: 0.75), fontSize: 13)),
                          ],
                        ),
                      ),
                    ]),
                  ),
                const Spacer(),
                Text('© 2026 FeishuClassmate Lab',
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.6), fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _bubble(double size, double alpha) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(shape: BoxShape.circle, color: Colors.white.withValues(alpha: alpha)),
      );
}
