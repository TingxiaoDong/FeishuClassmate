/// 桌面 / Web 端扫码登录（R-LG-02）：显示二维码 → 每 2 秒查一次状态 → 手机确认后用返回的令牌直接登录。
/// 二维码 2 分钟过期，过期后点击刷新。后端没有这个接口（404）时提示改用账号登录。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../api/phase2_admin.dart';
import '../api_client.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';

class QrLoginPanel extends StatefulWidget {
  final CosApiClient api;
  final String deviceName;
  final void Function(CosApiClient api, CosUser me) onLoggedIn;
  final Duration pollEvery;
  const QrLoginPanel({super.key, required this.api, required this.onLoggedIn, this.deviceName = '桌面客户端', this.pollEvery = const Duration(seconds: 2)});
  @override
  State<QrLoginPanel> createState() => _QrLoginPanelState();
}

class _QrLoginPanelState extends State<QrLoginPanel> {
  CosQrTicket? ticket;
  String status = 'loading'; // loading | waiting | scanned | expired | canceled | error | unsupported
  String? scannedBy;
  String? error;
  Timer? _poll, _clock;
  bool _polling = false;

  @override
  void initState() {
    super.initState();
    _create();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _clock?.cancel();
    super.dispose();
  }

  Future<void> _create() async {
    _poll?.cancel();
    _clock?.cancel();
    setState(() {
      status = 'loading';
      error = null;
      scannedBy = null;
    });
    try {
      final t = await widget.api.createQrLogin(widget.deviceName);
      if (!mounted) return;
      setState(() {
        ticket = t;
        status = 'waiting';
      });
      _poll = Timer.periodic(widget.pollEvery, (_) => _check());
      // 本地也按 expires_at 判断过期，避免轮询失败时一直显示可扫
      _clock = Timer.periodic(const Duration(seconds: 1), (_) {
        if (ticket != null && DateTime.now().isAfter(ticket!.expiresAt) && (status == 'waiting' || status == 'scanned')) {
          _stop('expired');
        }
      });
    } on CosApiException catch (e) {
      if (!mounted) return;
      setState(() {
        status = e.statusCode == 404 || e.statusCode == 405 ? 'unsupported' : 'error';
        error = describeError(e);
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          status = 'error';
          error = describeError(e);
        });
      }
    }
  }

  void _stop(String s) {
    _poll?.cancel();
    _clock?.cancel();
    if (mounted) setState(() => status = s);
  }

  Future<void> _check() async {
    final t = ticket;
    if (t == null || _polling) return;
    _polling = true;
    try {
      final st = await widget.api.pollQrLogin(t.qrId);
      if (!mounted || ticket?.qrId != t.qrId) return;
      switch (st.status) {
        case 'scanned':
          setState(() {
            status = 'scanned';
            scannedBy = st.scannedBy;
          });
        case 'confirmed':
          _stop('confirmed');
          if (st.session == null) {
            setState(() {
              status = 'error';
              error = '服务器没有返回登录信息，请改用账号登录';
            });
            return;
          }
          final me = widget.api.adoptSession(st.session!);
          widget.onLoggedIn(widget.api, me);
        case 'expired' || 'canceled':
          _stop(st.status);
      }
    } on CosApiException catch (e) {
      if (e.statusCode == 404) _stop('expired');
    } catch (_) {
      // 网络抖动：下一轮再试
    } finally {
      _polling = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = ticket;
    final overlay = switch (status) {
      'expired' => ('二维码已过期', '点击刷新'),
      'canceled' => ('已在手机上取消', '点击刷新'),
      'error' => (error ?? '获取二维码失败', '点击重试'),
      _ => null,
    };
    Widget code;
    if (status == 'unsupported') {
      code = Container(
        width: 200,
        height: 200,
        alignment: Alignment.center,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: Fs.bg, borderRadius: BorderRadius.circular(12)),
        child: const Text('这个服务器还没有开放扫码登录，请使用账号密码登录', textAlign: TextAlign.center, style: TextStyle(color: Fs.text2)),
      );
    } else if (status == 'scanned') {
      code = SizedBox(
        width: 200,
        height: 200,
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          const Icon(Icons.phone_iphone_rounded, size: 56, color: Fs.primary),
          const SizedBox(height: 12),
          Text(scannedBy == null ? '扫描成功' : '$scannedBy 已扫码', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          const Text('请在手机上确认登录', style: TextStyle(color: Fs.text3)),
          TextButton(onPressed: _create, child: const Text('换个账号，重新扫码')),
        ]),
      );
    } else {
      code = Stack(alignment: Alignment.center, children: [
        Container(
          width: 200,
          height: 200,
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(color: Colors.white, border: Border.all(color: Fs.line), borderRadius: BorderRadius.circular(12)),
          child: t == null || status == 'loading'
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : QrImageView(key: const ValueKey('qr-code'), data: t.content, padding: EdgeInsets.zero, size: 184),
        ),
        if (overlay != null)
          InkWell(
            key: const ValueKey('qr-refresh'),
            onTap: _create,
            child: Container(
              width: 200,
              height: 200,
              decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.94), borderRadius: BorderRadius.circular(12)),
              padding: const EdgeInsets.all(14),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                Text(overlay.$1, textAlign: TextAlign.center, style: const TextStyle(fontSize: 14, color: Fs.text1)),
                const SizedBox(height: 10),
                const Icon(Icons.refresh_rounded, color: Fs.primary, size: 28),
                Text(overlay.$2, style: const TextStyle(color: Fs.primary)),
              ]),
            ),
          ),
      ]);
    }
    return Column(mainAxisSize: MainAxisSize.min, children: [
      code,
      const SizedBox(height: 14),
      const Text('打开手机上的 ClassmateOS，在「我的」→「扫一扫」中扫码登录',
          textAlign: TextAlign.center, style: TextStyle(fontSize: 13, color: Fs.text2)),
      if (t != null && status == 'waiting')
        TextButton.icon(
          // 手机相机不能用时（没给权限、模拟器），可以把登录码粘贴到「扫一扫」→「输入登录码」里
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: t.content));
            if (context.mounted) showToast(context, '已复制登录码，在手机「扫一扫」→「输入登录码」里粘贴即可');
          },
          icon: const Icon(Icons.copy_rounded, size: 15),
          label: const Text('复制登录码', style: TextStyle(fontSize: 12)),
        ),
    ]);
  }
}
