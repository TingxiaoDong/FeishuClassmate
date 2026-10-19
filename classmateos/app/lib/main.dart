/// ClassmateOS 四端 App（PLAN §2.1 Flutter 单代码库）。
/// P1 界面：登录 → 聊天（轮询刷新）/ 多维表 / 文档。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'api_client.dart';
import 'models.dart';

const kBaseUrl = String.fromEnvironment(
  'COS_BASE_URL',
  defaultValue: 'http://127.0.0.1:8080/api/v1',
);

void main() => runApp(const ClassmateApp());

class ClassmateApp extends StatelessWidget {
  const ClassmateApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'ClassmateOS',
        theme: ThemeData(colorSchemeSeed: const Color(0xFF4F6EF7), useMaterial3: true),
        home: const LoginPage(),
      );
}

// ---------------- 登录 ----------------

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final user = TextEditingController(text: 'admin');
  final pass = TextEditingController(text: 'admin');
  String? error;
  bool busy = false;

  Future<void> _login() async {
    setState(() {
      busy = true;
      error = null;
    });
    final api = CosApiClient(kBaseUrl);
    try {
      final me = await api.login(user.text.trim(), pass.text);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => HomePage(api: api, me: me)),
      );
    } catch (e) {
      setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 320),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('ClassmateOS', style: Theme.of(context).textTheme.headlineMedium),
                const SizedBox(height: 8),
                Text(kBaseUrl, style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 20),
                TextField(controller: user, decoration: const InputDecoration(labelText: '用户名')),
                const SizedBox(height: 10),
                TextField(
                  controller: pass,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: '密码'),
                  onSubmitted: (_) => _login(),
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
                  ),
                const SizedBox(height: 18),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: busy ? null : _login,
                    child: Text(busy ? '登录中…' : '登录'),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
}

// ---------------- 主框架 ----------------

class HomePage extends StatefulWidget {
  final CosApiClient api;
  final CosUser me;
  const HomePage({super.key, required this.api, required this.me});
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int tab = 0;
  @override
  Widget build(BuildContext context) {
    final pages = [
      ChatPage(api: widget.api, me: widget.me),
      TablesPage(api: widget.api),
      DocsPage(api: widget.api),
    ];
    return Scaffold(
      appBar: AppBar(title: Text('ClassmateOS — ${widget.me.name}')),
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: tab,
            onDestinationSelected: (i) => setState(() => tab = i),
            labelType: NavigationRailLabelType.all,
            destinations: const [
              NavigationRailDestination(icon: Icon(Icons.chat_bubble_outline), label: Text('聊天')),
              NavigationRailDestination(icon: Icon(Icons.grid_on), label: Text('多维表')),
              NavigationRailDestination(icon: Icon(Icons.description_outlined), label: Text('文档')),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(child: pages[tab]),
        ],
      ),
    );
  }
}

// ---------------- 聊天 ----------------

class ChatPage extends StatefulWidget {
  final CosApiClient api;
  final CosUser me;
  const ChatPage({super.key, required this.api, required this.me});
  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  List<CosChat> chats = [];
  CosChat? current;
  List<CosMessage> messages = [];
  final draft = TextEditingController();
  Timer? poller;

  @override
  void initState() {
    super.initState();
    _loadChats();
    poller = Timer.periodic(const Duration(seconds: 2), (_) => _loadMessages());
  }

  @override
  void dispose() {
    poller?.cancel();
    draft.dispose();
    super.dispose();
  }

  Future<void> _loadChats() async {
    try {
      final list = await widget.api.listChats();
      setState(() {
        chats = list;
        current ??= list.isNotEmpty ? list.first : null;
      });
      await _loadMessages();
    } catch (_) {/* 网络抖动，下拍再试 */}
  }

  Future<void> _loadMessages() async {
    final c = current;
    if (c == null) return;
    try {
      final list = await widget.api.listMessages(c.chatId);
      if (mounted) setState(() => messages = list.reversed.toList());
    } catch (_) {}
  }

  Future<void> _send() async {
    final c = current;
    if (c == null || draft.text.trim().isEmpty) return;
    final text = draft.text;
    draft.clear();
    await widget.api.sendText(c.chatId, text);
    await _loadMessages();
  }

  Future<void> _newChat() async {
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) {
        final ctrl = TextEditingController();
        return AlertDialog(
          title: const Text('新会话（拉上 demo）'),
          content: TextField(controller: ctrl, decoration: const InputDecoration(labelText: '会话名')),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('创建')),
          ],
        );
      },
    );
    if (name == null || name.isEmpty) return;
    await widget.api.createChat(name: name, memberIds: const ['ou_admin', 'ou_demo']);
    setState(() => current = null);
    await _loadChats();
  }

  @override
  Widget build(BuildContext context) => Row(
        children: [
          SizedBox(
            width: 220,
            child: Column(
              children: [
                ListTile(
                  title: const Text('会话'),
                  trailing: IconButton(icon: const Icon(Icons.add), onPressed: _newChat),
                ),
                Expanded(
                  child: ListView(
                    children: [
                      for (final c in chats)
                        ListTile(
                          selected: c.chatId == current?.chatId,
                          title: Text(c.name ?? c.chatId, overflow: TextOverflow.ellipsis),
                          onTap: () => setState(() {
                            current = c;
                            messages = [];
                          }),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: Column(
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      for (final m in messages)
                        Align(
                          alignment: m.senderId == widget.me.userId
                              ? Alignment.centerRight
                              : Alignment.centerLeft,
                          child: Card(
                            color: m.senderId == widget.me.userId
                                ? Theme.of(context).colorScheme.primaryContainer
                                : null,
                            child: Padding(
                              padding: const EdgeInsets.all(10),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(m.senderId,
                                      style: const TextStyle(fontSize: 11, color: Colors.grey)),
                                  Text(m.content['text']?.toString() ?? m.content.toString()),
                                ],
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(10),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: draft,
                          decoration: const InputDecoration(hintText: '输入消息，回车发送'),
                          onSubmitted: (_) => _send(),
                        ),
                      ),
                      IconButton(icon: const Icon(Icons.send), onPressed: _send),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      );
}

// ---------------- 多维表 ----------------

class TablesPage extends StatefulWidget {
  final CosApiClient api;
  const TablesPage({super.key, required this.api});
  @override
  State<TablesPage> createState() => _TablesPageState();
}

class _TablesPageState extends State<TablesPage> {
  List<CosTableMeta> tables = [];
  String? tableKey;
  List<CosRecord> records = [];

  @override
  void initState() {
    super.initState();
    widget.api.listTables().then((t) => setState(() => tables = t));
  }

  Future<void> _load(String key) async {
    setState(() => tableKey = key);
    final list = await widget.api.listRecords(key);
    setState(() => records = list);
  }

  @override
  Widget build(BuildContext context) {
    if (tableKey == null) {
      return GridView.count(
        crossAxisCount: 4,
        padding: const EdgeInsets.all(16),
        children: [
          for (final t in tables)
            Card(
              child: InkWell(
                onTap: () => _load(t.key),
                child: Center(child: Text(t.name)),
              ),
            ),
        ],
      );
    }
    final cols = <String>{for (final r in records) ...r.fields.keys}.toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.all(8),
          child: OutlinedButton.icon(
            onPressed: () => setState(() => tableKey = null),
            icon: const Icon(Icons.arrow_back),
            label: Text('返回（$tableKey）'),
          ),
        ),
        Expanded(
          child: cols.isEmpty
              ? const Center(child: Text('（空表，还没有记录）'))
              : SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: SingleChildScrollView(
                    child: DataTable(
                      columns: [for (final c in cols) DataColumn(label: Text(c))],
                rows: [
                  for (final r in records)
                    DataRow(cells: [
                      for (final c in cols)
                        DataCell(SizedBox(
                          width: 180,
                          child: Text(
                            r.fields[c] is Map || r.fields[c] is List
                                ? '${r.fields[c]}'
                                : '${r.fields[c] ?? ''}',
                            overflow: TextOverflow.ellipsis,
                          ),
                        )),
                    ]),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

// ---------------- 文档 ----------------

class DocsPage extends StatefulWidget {
  final CosApiClient api;
  const DocsPage({super.key, required this.api});
  @override
  State<DocsPage> createState() => _DocsPageState();
}

class _DocsPageState extends State<DocsPage> {
  List<Map<String, dynamic>> docs = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final data = await widget.api.rawGet('/docs');
    setState(() => docs = (data['items'] as List).cast<Map<String, dynamic>>());
  }

  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.all(12),
        children: [
          for (final d in docs)
            Card(
              child: ExpansionTile(
                title: Text(d['title']?.toString() ?? ''),
                subtitle: Text(d['doc_id']?.toString() ?? ''),
                children: [
                  FutureBuilder<Map<String, dynamic>>(
                    future: widget.api.rawGet('/docs/${d['doc_id']}'),
                    builder: (ctx, snap) => Padding(
                      padding: const EdgeInsets.all(12),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: SelectableText(
                          snap.data?['markdown']?.toString() ?? '加载中…',
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      );
}
