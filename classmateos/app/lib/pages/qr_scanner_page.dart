/// 「扫一扫」摄像头扫码（R-AU-QR 补充）：只在 iOS / Android 启用（main() 里给 [qrScanner] 赋值）。
/// 扫到 ClassmateOS 登录二维码就返回内容；没有相机权限或相机打不开时可以改用登录码。
library;

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../api/phase2_admin.dart' show parseQrLogin;
import 'me_page.dart' show askLoginCode;

/// 打开扫码页，返回扫到（或手动输入）的二维码内容；取消返回 null。
Future<String?> scanQrWithCamera(BuildContext context) =>
    Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const QrScannerPage(), fullscreenDialog: true));

class QrScannerPage extends StatefulWidget {
  const QrScannerPage({super.key});
  @override
  State<QrScannerPage> createState() => _QrScannerPageState();
}

class _QrScannerPageState extends State<QrScannerPage> {
  final ctl = MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates);
  bool done = false;
  String? hint;

  @override
  void dispose() {
    ctl.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture c) {
    if (done) return;
    for (final b in c.barcodes) {
      final v = b.rawValue;
      if (v == null || v.isEmpty) continue;
      if (parseQrLogin(v) != null) {
        done = true;
        Navigator.of(context).pop(v);
        return;
      }
      setState(() => hint = '这不是 ClassmateOS 的登录二维码，请扫电脑登录页上的二维码');
    }
  }

  Future<void> _manual() async {
    final v = await askLoginCode(context);
    if (v != null && v.trim().isNotEmpty && mounted && !done) {
      done = true;
      Navigator.of(context).pop(v);
    }
  }

  Widget _error(BuildContext context, MobileScannerException e) {
    final denied = e.errorCode == MobileScannerErrorCode.permissionDenied;
    return Container(
      color: Colors.black,
      padding: const EdgeInsets.all(32),
      alignment: Alignment.center,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.no_photography_outlined, color: Colors.white70, size: 48),
        const SizedBox(height: 16),
        Text(
          denied ? '没有相机权限。请到系统设置里允许 ClassmateOS 使用相机，或者改用登录码。' : '相机打不开：${e.errorDetails?.message ?? e.errorCode.name}',
          textAlign: TextAlign.center,
          style: const TextStyle(color: Colors.white, fontSize: 15, height: 1.6),
        ),
        const SizedBox(height: 20),
        FilledButton(onPressed: _manual, child: const Text('输入登录码')),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text('扫一扫'),
        actions: [
          ValueListenableBuilder(
            valueListenable: ctl,
            builder: (_, st, _) => st.isRunning && st.torchState != TorchState.unavailable
                ? IconButton(
                    tooltip: '手电筒',
                    onPressed: ctl.toggleTorch,
                    icon: Icon(st.torchState == TorchState.on ? Icons.flashlight_off_rounded : Icons.flashlight_on_rounded),
                  )
                : const SizedBox.shrink(),
          ),
        ],
      ),
      body: Stack(children: [
        Positioned.fill(child: MobileScanner(controller: ctl, onDetect: _onDetect, errorBuilder: _error)),
        // 取景框
        Center(
          child: IgnorePointer(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(border: Border.all(color: Colors.white, width: 2), borderRadius: BorderRadius.circular(16)),
            ),
          ),
        ),
        Positioned(
          left: 24,
          right: 24,
          bottom: 40,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(
              hint ?? '对准电脑登录页上的二维码',
              textAlign: TextAlign.center,
              style: TextStyle(color: hint == null ? Colors.white : const Color(0xFFFFC069), fontSize: 14),
            ),
            const SizedBox(height: 12),
            TextButton(
              onPressed: _manual,
              style: TextButton.styleFrom(foregroundColor: Colors.white),
              child: const Text('扫不了？输入登录码'),
            ),
          ]),
        ),
      ]),
    );
  }
}
