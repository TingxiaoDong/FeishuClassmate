/// 迭代 4 后半：收藏（R-IM-06）、Pin 消息（R-IM-06）、内部链接卡片和外部链接预览（R-IM-07）、
/// 输入框 Markdown 快捷语法的判断。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../api/phase2_docs.dart';
import '../api/phase2_tasks.dart';
import '../api_client.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'chat_extras.dart';

// ---------------- 接口 ----------------

/// 一条收藏（GET /favorites）。
class CosFavorite {
  final String favoriteId;
  final CosMessage message;
  final String? chatName;
  final DateTime? createdAt;
  const CosFavorite(this.favoriteId, this.message, this.chatName, this.createdAt);
  factory CosFavorite.fromJson(Map<String, dynamic> j) => CosFavorite(
        j['favorite_id']?.toString() ?? '',
        CosMessage.fromJson((j['message'] as Map? ?? const {}).cast<String, dynamic>()),
        j['chat_name']?.toString(),
        DateTime.tryParse(j['created_at']?.toString() ?? ''),
      );
}

/// 一条固定消息（GET /chats/:id/pins）。
class CosPin {
  final CosMessage message;
  final String pinnedBy;
  final DateTime? pinnedAt;
  const CosPin(this.message, this.pinnedBy, this.pinnedAt);
  factory CosPin.fromJson(Map<String, dynamic> j) => CosPin(
        CosMessage.fromJson((j['message'] as Map? ?? const {}).cast<String, dynamic>()),
        j['pinned_by']?.toString() ?? '',
        DateTime.tryParse(j['pinned_at']?.toString() ?? ''),
      );
}

/// 群里最多固定 10 条（超出后端返回 409 PIN_LIMIT）。
const kMaxPins = 10;

extension Phase2ImMoreApi on CosApiClient {
  String _e(String id) => Uri.encodeComponent(id);

  Future<void> favoriteMessage(String messageId, bool on) =>
      request(on ? 'POST' : 'DELETE', '/messages/${_e(messageId)}/favorite');

  Future<CosPage<CosFavorite>> listFavorites({String? pageToken, int pageSize = 30}) async {
    final j = await request('GET', '/favorites', query: {'page_size': '$pageSize', if (pageToken != null) 'page_token': pageToken});
    return CosPage(
      [for (final x in (j['items'] as List? ?? const [])) CosFavorite.fromJson((x as Map).cast<String, dynamic>())],
      hasMore: j['has_more'] == true,
      pageToken: j['page_token']?.toString(),
    );
  }

  Future<List<CosPin>> listPins(String chatId) async {
    final j = await request('GET', '/chats/${_e(chatId)}/pins');
    return [for (final x in (j['items'] as List? ?? const [])) CosPin.fromJson((x as Map).cast<String, dynamic>())];
  }

  Future<void> pinMessage(String chatId, String messageId, bool on) =>
      request(on ? 'POST' : 'DELETE', '/chats/${_e(chatId)}/pins/${_e(messageId)}');
}

// ---------------- 内部链接 ----------------

/// 识别出来的 ClassmateOS 内部链接。
class InternalLink {
  final String type; // doc | wiki | record | task
  final String id;
  final String? tableKey;
  final String url;
  const InternalLink(this.type, this.id, this.url, {this.tableKey});

  Map<String, dynamic> get target => switch (type) {
        'wiki' => {'type': 'wiki_node', 'id': id},
        'record' => {'type': 'record', 'id': id, 'table_key': tableKey},
        _ => {'type': type, 'id': id},
      };

  IconData get icon => switch (type) {
        'doc' => Icons.description_outlined,
        'wiki' => Icons.menu_book_outlined,
        'record' => Icons.grid_view_outlined,
        _ => Icons.task_alt_outlined,
      };

  String get typeLabel => switch (type) {
        'doc' => '云文档',
        'wiki' => '知识库',
        'record' => '多维表格记录',
        _ => '任务',
      };
}

/// 内部链接格式（补充约定，后端生成分享链接时用同样的格式）：
/// `{origin}/app/docs/{doc_id}`、`/app/wiki/{node_id}`、`/app/tables/{table_key}/records/{record_id}`、`/app/tasks/{task_id}`。
/// 同时认 `classmateos://` 开头的写法。只认当前服务器的地址，别的网站一律当外部链接。
InternalLink? parseInternalLink(String url, String origin) {
  final u = Uri.tryParse(url);
  if (u == null) return null;
  final ok = u.scheme == 'classmateos' || ((u.scheme == 'http' || u.scheme == 'https') && u.origin == origin);
  if (!ok) return null;
  var seg = u.pathSegments.where((s) => s.isNotEmpty).toList();
  if (u.scheme == 'classmateos' && u.host.isNotEmpty) seg = [u.host, ...seg];
  if (seg.isNotEmpty && seg.first == 'app') seg = seg.sublist(1);
  if (seg.length == 2 && seg[0] == 'docs') return InternalLink('doc', seg[1], url);
  if (seg.length == 2 && seg[0] == 'wiki') return InternalLink('wiki', seg[1], url);
  if (seg.length == 2 && seg[0] == 'tasks') return InternalLink('task', seg[1], url);
  if (seg.length == 4 && seg[0] == 'tables' && seg[2] == 'records') return InternalLink('record', seg[3], url, tableKey: seg[1]);
  return null;
}

final _urlRe = RegExp(r'(https?|classmateos)://[^\s，。）)\]]+');

/// 消息文字里的全部链接（去重，保持顺序）。
List<String> extractUrls(String text) => {for (final m in _urlRe.allMatches(text)) m.group(0)!}.toList();

/// 内部链接卡片：取标题，点击在应用内打开；没权限或已删除时显示提示。
class InternalLinkCard extends StatefulWidget {
  final InternalLink link;
  const InternalLinkCard({super.key, required this.link});
  @override
  State<InternalLinkCard> createState() => _InternalLinkCardState();
}

/// 卡片标题缓存（同一个链接在会话里出现多次时不重复请求）。
final Map<String, Future<String>> _titleCache = {};

class _InternalLinkCardState extends State<InternalLinkCard> {
  late final Future<String> title = _titleCache.putIfAbsent('${AppScope.read(context).api.origin}:${AppScope.read(context).me.userId}:${widget.link.url}', _load);

  Future<String> _load() async {
    final api = AppScope.read(context).api;
    final l = widget.link;
    switch (l.type) {
      case 'doc':
        return (await api.getDoc(l.id)).title;
      case 'wiki':
        return (await api.getNode(l.id)).title;
      case 'task':
        return (await api.getTask(l.id)).title;
      default:
        final j = await api.request('GET', '/tables/${Uri.encodeComponent(l.tableKey ?? '')}/records/${Uri.encodeComponent(l.id)}');
        final f = (j['fields'] as Map?) ?? const {};
        return (f['name'] ?? f['title'] ?? f.values.whereType<String>().firstOrNull ?? '记录').toString();
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = widget.link;
    return FutureBuilder<String>(
      future: title,
      builder: (context, snap) {
        final err = snap.error;
        final denied = err is CosApiException && (err.statusCode == 403 || err.statusCode == 404);
        final t = snap.data ?? (snap.hasError ? (denied ? '没有权限查看，或已被删除' : '加载失败') : '加载中…');
        return _LinkCardFrame(
          key: ValueKey('link-card-${l.type}-${l.id}'),
          icon: l.icon,
          title: t,
          subtitle: l.typeLabel,
          dim: snap.hasError,
          onTap: denied ? null : () => AppScope.read(context).openTarget(l.target),
        );
      },
    );
  }
}

/// 外部链接预览：`content.link_previews: [{url, title, description}]`，由后端抓取。
class ExternalLinkCard extends StatelessWidget {
  final Map<String, dynamic> preview;
  const ExternalLinkCard({super.key, required this.preview});
  @override
  Widget build(BuildContext context) {
    final url = preview['url']?.toString() ?? '';
    final host = Uri.tryParse(url)?.host ?? '';
    final title = preview['title']?.toString() ?? '';
    return _LinkCardFrame(
      icon: Icons.language_rounded,
      title: title.isEmpty ? url : title,
      subtitle: [preview['description']?.toString() ?? '', host].where((x) => x.isNotEmpty).join(' · '),
      onTap: url.isEmpty ? null : () => openExternal(context, url),
    );
  }
}

class _LinkCardFrame extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final bool dim;
  final VoidCallback? onTap;
  const _LinkCardFrame({super.key, required this.icon, required this.title, required this.subtitle, this.dim = false, this.onTap});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Material(
          color: Colors.white,
          shape: RoundedRectangleBorder(side: const BorderSide(color: Fs.line), borderRadius: BorderRadius.circular(8)),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 320),
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(color: Fs.primaryLight, borderRadius: BorderRadius.circular(8)),
                    child: Icon(icon, size: 18, color: dim ? Fs.text3 : Fs.primary),
                  ),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                      Text(title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500, color: dim ? Fs.text3 : Fs.text1)),
                      if (subtitle.isNotEmpty)
                        Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Fs.text3)),
                    ]),
                  ),
                ]),
              ),
            ),
          ),
        ),
      );
}

/// 一条消息下方的链接卡片：内部链接逐个出卡片（最多 3 个），外部链接用后端给的 `link_previews`。
class MessageLinkCards extends StatelessWidget {
  final CosMessage message;
  const MessageLinkCards({super.key, required this.message});
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final text = message.msgType == 'post' ? (message.content['markdown'] ?? message.content['text'] ?? '').toString() : message.text;
    final internal = [for (final u in extractUrls(text)) ?parseInternalLink(u, s.api.origin)].take(3).toList();
    final previews = [
      for (final p in (message.content['link_previews'] as List? ?? const []))
        if (p is Map && parseInternalLink(p['url']?.toString() ?? '', s.api.origin) == null) p.cast<String, dynamic>(),
    ].take(3).toList();
    if (internal.isEmpty && previews.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      for (final l in internal) InternalLinkCard(link: l),
      for (final p in previews) ExternalLinkCard(preview: p),
    ]);
  }
}

// ---------------- Markdown 快捷语法 ----------------

final _mdRe = RegExp(r'(\*\*[^*\n]+\*\*)|(^|\n)\s*([-*] |\d+\. |> |#{1,3} )|```|(^|[^`])`[^`\n]+`');

/// 输入框里写了 Markdown 快捷语法（加粗、列表、引用、标题、代码）时发成 `post {markdown}`，否则发普通文本。
bool looksLikeMarkdown(String text) => _mdRe.hasMatch(text);

// ---------------- Pin 条与列表 ----------------

/// 会话顶部「已固定 N 条消息」条；点开是列表，可跳到消息、取消固定。
class PinBar extends StatefulWidget {
  final CosChat chat;
  final void Function(CosMessage m) onJump;
  const PinBar({super.key, required this.chat, required this.onJump});
  @override
  State<PinBar> createState() => PinBarState();
}

class PinBarState extends State<PinBar> {
  List<CosPin> pins = [];
  late final AppState _s = AppScope.read(context);
  StreamSubscription<CosEvent>? _sub;

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    reload();
    _sub = _s.eventStream.listen((e) {
      if (!mounted) return;
      final cid = e.chat?['chat_id'] ?? e.raw['chat_id'];
      if ((e.eventType == 'chat.updated' || e.eventType == 'chat.pins_changed') && cid == widget.chat.chatId) reload();
    });
  }

  Future<void> reload() async {
    try {
      final l = await _s.api.listPins(widget.chat.chatId);
      if (mounted) setState(() => pins = l);
    } catch (_) {
      // 没有 Pin 接口时不显示
    }
  }

  @override
  Widget build(BuildContext context) {
    if (pins.isEmpty) return const SizedBox.shrink();
    final s = AppScope.of(context);
    final first = pins.first.message;
    return Material(
      color: const Color(0xFFF5F8FF),
      child: InkWell(
        key: const ValueKey('pin-bar'),
        onTap: _openList,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Fs.lineLight))),
          child: Row(children: [
            Transform.rotate(angle: 0.6, child: const Icon(Icons.push_pin_rounded, size: 15, color: Fs.primary)),
            const SizedBox(width: 8),
            Text('已固定 ${pins.length} 条消息', style: const TextStyle(fontSize: 13, color: Fs.primary, fontWeight: FontWeight.w500)),
            const SizedBox(width: 10),
            Expanded(
              child: Text('${s.userName(first.senderId)}：${messagePreview(s, first)}',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5, color: Fs.text2)),
            ),
            const Icon(Icons.chevron_right_rounded, size: 18, color: Fs.text3),
          ]),
        ),
      ),
    );
  }

  Future<void> _openList() async {
    final s = _s;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AppScope(
        state: s,
        child: StatefulBuilder(
          builder: (ctx, setLocal) => AlertDialog(
            title: Text('固定消息 · ${pins.length}'),
            content: SizedBox(
              width: 460,
              child: ListView(shrinkWrap: true, children: [
                for (final p in pins)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: FsAvatar(name: s.userName(p.message.senderId), seed: p.message.senderId, size: 32),
                    title: Text(messagePreview(s, p.message), maxLines: 2, overflow: TextOverflow.ellipsis),
                    subtitle: Text('${s.userName(p.pinnedBy)} 固定', style: const TextStyle(fontSize: 12)),
                    onTap: () {
                      Navigator.pop(ctx);
                      widget.onJump(p.message);
                    },
                    trailing: IconButton(
                      tooltip: '取消固定',
                      icon: const Icon(Icons.close_rounded, size: 18),
                      onPressed: () async {
                        try {
                          await s.api.pinMessage(widget.chat.chatId, p.message.messageId, false);
                          await reload();
                          setLocal(() {});
                          if (pins.isEmpty && ctx.mounted) Navigator.pop(ctx);
                        } catch (e) {
                          if (ctx.mounted) showToast(ctx, describeError(e), error: true);
                        }
                      },
                    ),
                  ),
              ]),
            ),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭'))],
          ),
        ),
      ),
    );
  }
}

// ---------------- 收藏列表 ----------------

Future<void> showFavorites(BuildContext context) {
  final s = AppScope.read(context);
  return showDialog<void>(context: context, builder: (_) => AppScope(state: s, child: const _FavoritesDialog()));
}

class _FavoritesDialog extends StatefulWidget {
  const _FavoritesDialog();
  @override
  State<_FavoritesDialog> createState() => _FavoritesDialogState();
}

class _FavoritesDialogState extends State<_FavoritesDialog> {
  final List<CosFavorite> items = [];
  String? token;
  bool hasMore = false, loading = true;
  String? error;
  late final AppState _s = AppScope.read(context);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    setState(() => loading = true);
    try {
      final p = await _s.api.listFavorites(pageToken: more ? token : null);
      if (!mounted) return;
      setState(() {
        if (!more) items.clear();
        items.addAll(p.items);
        token = p.pageToken;
        hasMore = p.hasMore && (p.pageToken ?? '').isNotEmpty;
        loading = false;
        error = null;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = describeError(e);
        });
      }
    }
  }

  Future<void> _remove(CosFavorite f) async {
    try {
      await _s.api.favoriteMessage(f.message.messageId, false);
      if (mounted) setState(() => items.remove(f));
    } catch (e) {
      if (mounted) showToast(context, describeError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return AlertDialog(
      title: const Text('我的收藏'),
      content: SizedBox(
        width: 520,
        height: 480,
        child: error != null
            ? EmptyState(icon: Icons.error_outline_rounded, title: '加载失败', subtitle: error)
            : items.isEmpty && !loading
                ? const EmptyState(icon: Icons.star_outline_rounded, title: '还没有收藏', subtitle: '在消息上右键或悬停，选「收藏」')
                : ListView(children: [
                    for (final f in items)
                      ListTile(
                        key: ValueKey('fav-${f.message.messageId}'),
                        contentPadding: EdgeInsets.zero,
                        leading: FsAvatar(name: s.userName(f.message.senderId), seed: f.message.senderId, size: 32),
                        title: Text(messagePreview(s, f.message), maxLines: 2, overflow: TextOverflow.ellipsis),
                        subtitle: Text(
                          [s.userName(f.message.senderId), if (f.chatName != null) f.chatName!, fmtRelative(f.createdAt)].join(' · '),
                          style: const TextStyle(fontSize: 12),
                        ),
                        onTap: () {
                          Navigator.pop(context);
                          s.openTarget({'type': 'message', 'id': f.message.chatId, 'message_id': f.message.messageId});
                        },
                        trailing: IconButton(tooltip: '取消收藏', icon: const Icon(Icons.star_rounded, color: Fs.orange), onPressed: () => _remove(f)),
                      ),
                    if (loading) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator(strokeWidth: 2))),
                    if (hasMore && !loading) Center(child: TextButton(onPressed: () => _load(more: true), child: const Text('加载更多'))),
                  ]),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
    );
  }
}
