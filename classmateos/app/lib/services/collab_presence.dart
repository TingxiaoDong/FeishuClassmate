/// 协同在线状态（R-DC-09）：通过协同 WS 的 awareness 消息（y-protocols 类型 1）
/// 广播自己的 { user_id, name, color, cursor }，并收集别人的状态。
/// 不解析 / 不发送 Yjs 文档更新（类型 0 忽略），所以不会改动正文。
///
/// 编码（lib0）：消息 = varUint(1) + varUint8Array(update)；
/// update = varUint(条数) + [varUint(clientID) + varUint(clock) + varString(JSON 或 "null")]。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../api_client.dart';

// ---------------- lib0 编解码 ----------------

void _writeVarUint(BytesBuilder b, int n) {
  while (n > 0x7f) {
    b.addByte(0x80 | (n & 0x7f));
    n >>= 7;
  }
  b.addByte(n & 0x7f);
}

void _writeVarBytes(BytesBuilder b, List<int> bytes) {
  _writeVarUint(b, bytes.length);
  b.add(bytes);
}

class _Reader {
  final Uint8List data;
  int pos = 0;
  _Reader(this.data);
  bool get done => pos >= data.length;
  int varUint() {
    var n = 0, shift = 0;
    while (true) {
      final r = data[pos++];
      n += (r & 0x7f) * pow(2, shift).toInt();
      shift += 7;
      if (r < 0x80) return n;
      if (shift > 49) throw const FormatException('varUint 过长');
    }
  }

  Uint8List varBytes() {
    final len = varUint();
    final out = Uint8List.sublistView(data, pos, pos + len);
    pos += len;
    return out;
  }

  String varString() => utf8.decode(varBytes());
}

/// 一条 awareness 状态。
class AwarenessEntry {
  final int clientId;
  final int clock;
  final Map<String, dynamic>? state;
  const AwarenessEntry(this.clientId, this.clock, this.state);
}

Uint8List encodeAwarenessMessage(List<AwarenessEntry> entries) {
  final u = BytesBuilder();
  _writeVarUint(u, entries.length);
  for (final e in entries) {
    _writeVarUint(u, e.clientId);
    _writeVarUint(u, e.clock);
    _writeVarBytes(u, utf8.encode(e.state == null ? 'null' : jsonEncode(e.state)));
  }
  final b = BytesBuilder();
  _writeVarUint(b, 1);
  _writeVarBytes(b, u.toBytes());
  return b.toBytes();
}

/// 解析一条 WS 二进制消息；不是 awareness 时返回 null。
List<AwarenessEntry>? decodeAwarenessMessage(Uint8List data) {
  try {
    final r = _Reader(data);
    if (r.varUint() != 1) return null;
    final u = _Reader(r.varBytes());
    final n = u.varUint();
    return [
      for (var i = 0; i < n; i++)
        () {
          final id = u.varUint(), clock = u.varUint();
          final s = jsonDecode(u.varString());
          return AwarenessEntry(id, clock, s is Map ? s.cast<String, dynamic>() : null);
        }(),
    ];
  } catch (_) {
    return null;
  }
}

// ---------------- 连接 ----------------

class PresencePeer {
  final int clientId;
  final String userId;
  final String name;
  final int? line;
  final DateTime seen;
  const PresencePeer(this.clientId, this.userId, this.name, this.line, this.seen);
}

class CollabPresence {
  final CosApiClient api;
  final String docId;
  final String userId;
  final String name;
  final String color;
  final void Function(List<PresencePeer> peers) onChanged;

  CollabPresence({required this.api, required this.docId, required this.userId, required this.name, required this.color, required this.onChanged});

  final int clientId = Random().nextInt(0x3fffffff);
  int _clock = 0;
  int? _line;
  WebSocketChannel? _ws;
  Timer? _renew, _retry;
  bool _closed = false;
  final Map<int, PresencePeer> _peers = {};
  final Map<int, int> _clocks = {};

  void start() => _connect();

  Future<void> _connect() async {
    if (_closed) return;
    try {
      await api.ensureFreshToken();
      final ch = WebSocketChannel.connect(api.wsUri('/docs/${Uri.encodeComponent(docId)}/collab'));
      _ws = ch;
      await ch.ready;
      _send();
      _renew?.cancel();
      _renew = Timer.periodic(const Duration(seconds: 15), (_) {
        _send();
        _expire();
      });
      ch.stream.listen((raw) {
        if (raw is! List<int>) return;
        final entries = decodeAwarenessMessage(Uint8List.fromList(raw));
        if (entries != null) _apply(entries);
      }, onDone: () {
        // 4409：正文被整体替换（保存 / 还原）；4410：权限变化。都重连。
        _scheduleRetry(ch.closeCode == 4404 || ch.closeCode == 4401 || ch.closeCode == 4403 ? null : 1);
      }, onError: (_) => _scheduleRetry(5), cancelOnError: true);
    } catch (_) {
      _scheduleRetry(10);
    }
  }

  void _scheduleRetry(int? seconds) {
    _renew?.cancel();
    if (_closed || seconds == null) return;
    _retry?.cancel();
    _retry = Timer(Duration(seconds: seconds), _connect);
  }

  void _apply(List<AwarenessEntry> entries) {
    var changed = false;
    for (final e in entries) {
      if (e.clientId == clientId) continue;
      if ((_clocks[e.clientId] ?? -1) > e.clock) continue;
      _clocks[e.clientId] = e.clock;
      final s = e.state;
      if (s == null || s['user_id'] == null) {
        changed |= _peers.remove(e.clientId) != null;
        continue;
      }
      final cursor = s['cursor'];
      _peers[e.clientId] = PresencePeer(e.clientId, s['user_id'].toString(), s['name']?.toString() ?? '',
          cursor is Map && cursor['line'] is num ? (cursor['line'] as num).toInt() : null, DateTime.now());
      changed = true;
    }
    if (changed) _emit();
  }

  void _expire() {
    final before = _peers.length;
    _peers.removeWhere((_, p) => DateTime.now().difference(p.seen).inSeconds > 35);
    if (_peers.length != before) _emit();
  }

  void _emit() {
    // 同一个人多个窗口只显示一次
    final byUser = <String, PresencePeer>{};
    for (final p in _peers.values) {
      if (p.userId == userId) continue;
      byUser[p.userId] = p;
    }
    onChanged(byUser.values.toList());
  }

  void _send([bool leave = false]) {
    _clock++;
    try {
      _ws?.sink.add(encodeAwarenessMessage([
        AwarenessEntry(clientId, _clock, leave
            ? null
            : {'user_id': userId, 'name': name, 'color': color, if (_line != null) 'cursor': {'line': _line}}),
      ]));
    } catch (_) {}
  }

  /// 光标所在行变化（只读用户传 null，只显示头像）。
  void setCursorLine(int? line) {
    if (line == _line) return;
    _line = line;
    _send();
  }

  void dispose() {
    _closed = true;
    _send(true);
    _renew?.cancel();
    _retry?.cancel();
    _ws?.sink.close();
  }
}
