import 'dart:async';
import 'package:flutter/material.dart';
import '../api_client.dart';
import '../app_state.dart';

/// 平台仅确认急停事件已发出，不能把 HTTP 成功显示成真机已停稳。
class RobotCard extends StatefulWidget {
  const RobotCard({super.key});
  @override
  State<RobotCard> createState() => _RobotCardState();
}

class _RobotCardState extends State<RobotCard> {
  Timer? _timer;
  Map<String, dynamic>? _status;
  String? _error;
  bool _loading = false;
  bool _stopping = false;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 20), (_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    if (_loading || !mounted) return;
    setState(() => _loading = true);
    try {
      final result = await AppScope.read(context).api.request('GET', '/robots/temi/status');
      if (mounted) setState(() { _status = result; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = describeError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _stop() async {
    if (_stopping) return;
    setState(() => _stopping = true);
    try {
      await AppScope.read(context).api.request('POST', '/robots/temi/estop');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('急停指令已发出，请确认机器人停稳；仍在移动时请按机器人屏幕上的停止键。'),
      ));
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('急停发送失败：${describeError(e)}。请按机器人屏幕上的停止键。'),
        ));
      }
    } finally {
      if (mounted) setState(() => _stopping = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _status;
    final online = _error == null && s?['online'] == true && s?['stale'] != true;
    final action = s?['current_action'];
    final label = action is Map ? action['label']?.toString() : null;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Wrap(spacing: 12, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            const Text('Temi 机器人', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            Text(_error != null ? '状态获取失败' : s == null ? '正在获取状态' : online ? '在线' : '离线 / 状态过期'),
            if (s?['mock'] == true) const Chip(label: Text('模拟模式 · 非真机')),
            IconButton(onPressed: _loading ? null : _load, tooltip: '刷新机器人状态', icon: const Icon(Icons.refresh)),
            FilledButton.icon(
              key: const ValueKey('robot-estop'),
              onPressed: _stopping ? null : _stop,
              style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700),
              icon: const Icon(Icons.stop_circle_outlined),
              label: Text(_stopping ? '发送中…' : '立即急停'),
            ),
          ]),
          if (_error != null) Text(_error!)
          else if (s != null) Text('电量：${s['battery'] ?? '未知'}${s['battery'] == null ? '' : '%'}  ·  位置：${s['location'] ?? '未知'}  ·  ${label ?? (s['is_moving'] == true ? '移动中' : '暂无动作')}'),
          const SizedBox(height: 6),
          const Text('离线或状态过期时，上面可能是最后一次上报。急停无需二次确认，请同时观察机器人。', style: TextStyle(fontSize: 12)),
        ]),
      ),
    );
  }
}
