// 和真实后端联调用的测试：只在设置了环境变量 COS_LIVE_URL 时运行，例如
//   COS_LIVE_URL=http://127.0.0.1:8090 flutter test test/live_backend_test.dart
// 后端请用内存模式启动（会写入测试数据）。平时跑 flutter test 时自动跳过。
@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:classmateos_app/api/phase2.dart';
import 'package:classmateos_app/api/phase2_admin.dart';
import 'package:classmateos_app/services/device_label.dart';
import 'package:classmateos_app/api/phase2_docs.dart';
import 'package:classmateos_app/api/phase2_im.dart';
import 'package:classmateos_app/api/phase2_jobs.dart';
import 'package:classmateos_app/api/phase2_tasks.dart';
import 'package:classmateos_app/api_client.dart';
import 'package:flutter_test/flutter_test.dart';

final _url = Platform.environment['COS_LIVE_URL'];
// 每次运行用不同后缀，后端不重启也能重复跑
final _run = DateTime.now().millisecondsSinceEpoch.toRadixString(36);

Future<CosApiClient> _login(String u, String p) async {
  final c = CosApiClient('${_url!}/api/v1');
  await c.login(u, p);
  return c;
}

void _dump(String tag, Object? j) {
  if (Platform.environment['COS_LIVE_DUMP'] == '1') {
    // ignore: avoid_print
    print('== $tag\n${const JsonEncoder.withIndent('  ').convert(j)}');
  }
}

void main() {
  if (_url == null) {
    test('真实后端联调（未设置 COS_LIVE_URL，跳过）', () {}, skip: true);
    return;
  }
  // flutter test 默认拦截真实网络请求，这里放开
  setUpAll(() => HttpOverrides.global = null);

  late CosApiClient admin, demo;
  setUpAll(() async {
    admin = await _login('admin', 'admin');
    demo = await _login('demo', 'demo');
  });

  test('开关与本人权限点', () async {
    final caps = await admin.capabilities();
    for (final k in ['table.fields', 'table.views', 'notifications', 'doc.permissions', 'doc.comments', 'doc.versions',
      'doc.presence', 'calendar.recurrence', 'task.subtasks', 'task.lists', 'message.thread', 'message.reaction',
      'message.forward', 'message.urgent', 'message.favorite', 'message.pin', 'search',
      // 2026-10-20 下午后端新打开的（代码审查 F4）
      'wiki', 'admin', 'org.departments', 'doc.folders', 'table.manage', 'table.permissions', 'record.comments',
      'record.history', 'auth.qr_login']) {
      expect(caps.has(k), isTrue, reason: k);
    }
    expect(caps.has('approval'), isFalse);
    final me = await admin.me();
    expect(me.permissions, contains('admin.members'));
    final dme = await demo.me();
    expect(dme.permissions, isNot(contains('admin.members')));
  });

  test('消息：已读、话题、回应、转发、加急、收藏、固定、富文本', () async {
    final chat = await admin.createChat(name: '联调群', memberIds: ['ou_demo']);
    final m = await admin.sendText(chat.chatId, '联调第一条');
    expect(m.memberCount, 1);
    expect(m.readCount, 0);
    await demo.markRead(chat.chatId);
    final after = (await admin.listMessages(chat.chatId)).items.firstWhere((x) => x.messageId == m.messageId);
    expect(after.readCount, 1);
    final ru = await admin.readUsers(m.messageId);
    expect(ru.read, ['ou_demo']);

    // 话题
    await demo.sendText(chat.chatId, '话题回复', threadRootId: m.messageId);
    final replies = await admin.allThreadReplies(m.messageId);
    expect(replies.length, 1);
    final root = (await admin.listMessages(chat.chatId)).items.firstWhere((x) => x.messageId == m.messageId);
    _dump('thread root', root.raw);
    expect(root.thread?.replyCount, 1);
    await admin.followThread(m.messageId, false);
    final tm = await admin.setThreadMode(chat.chatId, true);
    expect(tm.threadMode, isTrue);

    // 表情回应
    final r = await demo.addReaction(m.messageId, 'THUMBSUP');
    _dump('reaction', r?.raw);
    final withR = r ?? (await demo.listMessages(chat.chatId)).items.firstWhere((x) => x.messageId == m.messageId);
    expect(withR.reactions.single.count, 1);
    await demo.removeReaction(m.messageId, 'THUMBSUP');

    // 转发
    final other = await admin.createChat(name: '转发目标', memberIds: ['ou_demo']);
    final f1 = await admin.forwardMessages(messageIds: [m.messageId], chatIds: [other.chatId]);
    expect(f1.single.forwardedFrom?['message_id'], m.messageId);
    final f2 = await admin.forwardMessages(messageIds: [m.messageId], chatIds: [other.chatId], mode: 'merge');
    expect(f2.single.msgType, 'merge_forward');
    _dump('merge', f2.single.raw);

    // 加急
    await admin.urgentMessage(m.messageId, ['ou_demo']);
    final pend = await demo.pendingUrgents();
    expect(pend.single.messageId, m.messageId);
    expect(pend.single.fromUserId, 'ou_admin');
    await demo.ackUrgent(m.messageId);
    expect(await demo.pendingUrgents(), isEmpty);

    // 收藏
    await demo.request('POST', '/messages/${m.messageId}/favorite');
    final favs = await demo.request('GET', '/favorites');
    _dump('favorites', favs);

    // 固定
    await admin.request('POST', '/chats/${chat.chatId}/pins/${m.messageId}');
    final c2 = await admin.getChat(chat.chatId);
    expect(c2.pinnedMessageIds, contains(m.messageId));

    // 富文本
    final post = await admin.sendMessage(chat.chatId, 'post', {'markdown': '**加粗** 文本'});
    expect(post.msgType, 'post');
  });

  test('搜索与最近访问', () async {
    final d = await admin.createDoc('联调搜索文档', '内容 ABC123');
    await admin.getDoc(d.docId);
    final g = await admin.search('联调');
    _dump('search', [for (final x in g) {'type': x.type, 'total': x.total, 'items': x.items.map((i) => {'id': i.id, 'title': i.title, 'extra': i.extra}).toList()}]);
    expect(g.any((x) => x.type == 'doc' && x.items.isNotEmpty), isTrue);
    final rec = await admin.recentVisits();
    expect(rec.any((x) => x.type == 'doc' && x.id == d.docId), isTrue);
  });

  test('文档：权限、申请、评论、版本', () async {
    final d = await admin.createDoc('联调文档', '第一段');
    final p = await admin.docPermissions(d.docId);
    _dump('doc perms', await admin.request('GET', '/docs/${d.docId}/permissions'));
    final saved = await admin.saveDocPermissions(d.docId, p.copyWith(linkShare: 'off'));
    expect(saved.linkShare, 'off');
    await demo.requestDocAccess(d.docId, role: 'viewer', note: '想看');
    final n = await admin.listNotifications();
    final req = n.items.firstWhere((x) => x.type == 'doc.access_request');
    _dump('access_request target', req.target);
    await admin.handleAccessRequest(d.docId, req.target['request_id'].toString(), true);
    final dd = await demo.getDoc(d.docId);
    expect(dd.myRole, 'viewer');

    final c = await admin.createComment(d.docId, const CosRichText('看一下'), quote: '第一', anchor: {'offset': 0, 'length': 2});
    expect(c.replies.length, 1);
    final vs = await admin.listVersions(d.docId);
    expect(vs, isNotEmpty);
  });

  test('日程：重复规则与修改范围', () async {
    final start = DateTime.now().add(const Duration(days: 1));
    final e = await admin.createEvent(title: '联调周会$_run', start: start, end: start.add(const Duration(hours: 1)),
        attendeeIds: ['ou_demo'], recurrence: 'FREQ=WEEKLY;COUNT=3');
    final list = await admin.listEvents(start.subtract(const Duration(days: 1)), start.add(const Duration(days: 30)), expandRecurring: true);
    final inst = list.where((x) => x.title == '联调周会$_run').toList();
    _dump('instances', await admin.request('GET', '/calendar/events', query: {'start_ms': '${start.subtract(const Duration(days: 1)).millisecondsSinceEpoch}', 'end_ms': '${start.add(const Duration(days: 30)).millisecondsSinceEpoch}'}));
    expect(inst.length, 3);
    expect(inst.first.recurrence, isNotNull);
    await admin.updateEvent(inst[1].eventId, title: '联调周会$_run（改）', scope: 'this');
    await demo.rsvpEvent(e.eventId, 'accepted');
    await admin.deleteEvent(inst[2].eventId, scope: 'this');
    final list2 = await admin.listEvents(start.subtract(const Duration(days: 1)), start.add(const Duration(days: 30)), expandRecurring: true);
    expect(list2.where((x) => x.title.startsWith('联调周会$_run')).length, 2);
  });

  test('任务：子任务、关注、评论、动态、清单', () async {
    final t = await admin.createTask(title: '联调父任务', assigneeId: 'ou_demo');
    final s = await admin.createTask(title: '联调子任务', parentId: t.taskId);
    expect(s.parentId, t.taskId);
    final full = await admin.getTask(t.taskId);
    expect(full.subtaskCount, 1);
    await admin.followTask(t.taskId, 'ou_demo', true);
    expect((await admin.getTask(t.taskId)).followerIds, contains('ou_demo'));
    await demo.addTaskComment(t.taskId, const CosRichText('收到'), const []);
    final cm = await admin.taskComments(t.taskId);
    _dump('task comment', cm);
    await admin.updateTask(t.taskId, status: 'in_progress');
    final acts = await admin.taskActivities(t.taskId);
    _dump('activities', acts);
    expect(acts, isNotEmpty);

    final l = await admin.saveTaskList({'name': '联调清单'});
    final secs = await admin.taskSections(l.id);
    _dump('sections', secs);
    expect(secs.length, 3);
    await admin.putTaskInList(t.taskId, l.id, secs.first['section_id'].toString());
    final inList = await admin.tasksInList(l.id);
    expect(inList.single.taskId, t.taskId);
    _dump('task', await admin.request('GET', '/tasks/${t.taskId}'));
    final mem = await admin.taskListMembers(l.id);
    _dump('list members', await admin.request('GET', '/tasklists/${l.id}/members'));
    expect(mem.ownerId, 'ou_admin');
    await admin.deleteTask(t.taskId);
  });

  test('多维表格：字段、视图、批量、通知', () async {
    final tables = await admin.listTables();
    final t = tables.first;
    final views = await admin.listViews(t.key);
    expect(views, isNotEmpty);
    final nt = await admin.createField(t.key, {'title': '联调备注$_run', 'type': 1});
    expect(nt.fields.any((f) => f.title == '联调备注$_run'), isTrue);
    final unread = await demo.notificationUnreadCount();
    expect(unread, greaterThanOrEqualTo(0));
    final settings = await demo.notificationSettings();
    await demo.saveNotificationSettings(settings);
  });

  test('迭代5批次1：设备会话、强制改密、退出其他设备、校验与锁定', () async {
    final mine = await admin.mySessions();
    final current = mine.singleWhere((x) => x.current);
    expect(current.deviceName, localDeviceName());
    expect(current.platform, localPlatform());

    final uid = 'live_$_run';
    await admin.request('POST', '/users', body: {'user_id': uid, 'name': '联调$_run', 'password': 'init1234'});
    final first = CosApiClient('${_url!}/api/v1');
    final u = await first.login(uid, 'init1234');
    expect(u.mustChangePassword, isTrue);
    var required = 0;
    first.onPasswordChangeRequired = () => required++;
    await expectLater(first.listChats(), throwsA(isA<CosApiException>().having((e) => e.code, 'code', 'PASSWORD_CHANGE_REQUIRED')));
    expect(required, 1);
    await expectLater(first.changePassword('bad', 'Newpass123'), throwsA(isA<CosApiException>().having((e) => e.code, 'code', 'INVALID_PASSWORD')));
    await expectLater(first.changePassword('init1234', 'short'), throwsA(isA<CosApiException>().having((e) => e.code, 'code', 'WEAK_PASSWORD')));
    await first.changePassword('init1234', 'Newpass123');
    expect(await first.refresh(), isTrue);
    await first.listChats();

    final second = CosApiClient('${_url!}/api/v1');
    await second.login(uid, 'Newpass123');
    var lost = false;
    second.onAuthLost = () => lost = true;
    await first.logoutAllMine();
    await expectLater(second.listChats(), throwsA(isA<CosApiException>().having((e) => e.statusCode, 'status', 401)));
    expect(lost, isTrue);
    await first.listChats(); // 当前设备保留

    try {
      await admin.request('PUT', '/admin/security-settings', body: {'password_min_length': 2});
      fail('应返回 422');
    } on CosApiException catch (e) {
      expect(e.statusCode, 422);
      expect(e.friendly, isNot(contains('password_min_length')));
      expect(e.friendly, contains('密码最短长度'));
    }
    await admin.request('PUT', '/admin/security-settings', body: {'lock_after_failures': 2});
    try {
      for (var i = 0; i < 2; i++) {
        await expectLater(CosApiClient('${_url!}/api/v1').login(uid, 'wrong'), throwsA(isA<CosApiException>()));
      }
      await CosApiClient('${_url!}/api/v1').login(uid, 'Newpass123');
      fail('应被锁定');
    } on CosApiException catch (e) {
      expect(e.statusCode, 423);
      expect(e.friendly, contains('锁定'));
    } finally {
      await admin.request('PUT', '/admin/security-settings', body: {'lock_after_failures': 5});
    }
  });

  // ---------------- 代码审查 F4：后端新打开的开关 ----------------

  test('F4 文档：文件夹、收藏、回收站', () async {
    final f = await admin.createFolder('联调文件夹$_run');
    expect((await admin.listFolders()).any((x) => x.folderId == f.folderId), isTrue);
    final renamed = await admin.updateFolder(f.folderId, name: '联调文件夹改$_run');
    expect(renamed.name, '联调文件夹改$_run');

    final d = await admin.createDocIn('联调夹内文档$_run', '正文', folderId: f.folderId);
    _dump('doc in folder', await admin.request('GET', '/docs/${d.docId}'));
    expect((await admin.listDocsIn('mine', folderId: f.folderId)).any((x) => x.docId == d.docId), isTrue);
    expect((await admin.listDocsIn('mine')).any((x) => x.docId == d.docId), isFalse, reason: '不带 folder_id 只返回根目录');

    await admin.starDoc(d.docId, true);
    expect((await admin.listDocsIn('starred')).any((x) => x.docId == d.docId), isTrue);
    await admin.starDoc(d.docId, false);
    expect((await admin.listDocsIn('starred')).any((x) => x.docId == d.docId), isFalse);

    final moved = await admin.moveDoc(d.docId, null);
    expect(moved.folderId, isNull);
    expect((await admin.listDocsIn('mine', folderId: f.folderId)).any((x) => x.docId == d.docId), isFalse);

    await admin.deleteDoc(d.docId);
    final trash = await admin.listDocsIn('trash');
    expect(trash.any((x) => x.docId == d.docId), isTrue);
    await admin.restoreDoc(d.docId);
    expect((await admin.listDocsIn('trash')).any((x) => x.docId == d.docId), isFalse);
    expect((await admin.getDoc(d.docId)).docId, d.docId);

    await admin.deleteDoc(d.docId);
    await admin.deleteDocForever(d.docId);
    expect((await admin.listDocsIn('trash')).any((x) => x.docId == d.docId), isFalse);
    await admin.deleteFolder(f.folderId);
    expect((await admin.listFolders()).any((x) => x.folderId == f.folderId), isFalse);
  });

  test('F4 多维表格：表管理、表权限、记录评论与修改记录', () async {
    final t = await admin.createTable(name: '联调表$_run', primaryField: 'name', fields: [
      {'field_name': 'name', 'title': '名称', 'type': 1, 'required': true},
    ]);
    final r = await admin.createRecord(t.key, {'name': '第一条'});
    await admin.updateRecord(t.key, r.recordId, {'name': '第一条（改）'});

    final up = await admin.updateTable(t.key, name: '联调表改$_run', description: '联调描述');
    expect(up.name, '联调表改$_run');
    expect(up.description, '联调描述');

    final perm = await admin.tablePermissions(t.key);
    _dump('table perms', await admin.request('GET', '/tables/${t.key}/permissions'));
    final saved = await admin.saveTablePermissions(
        t.key, perm.copyWith(linkShare: 'members', members: [const CosMember('user', 'ou_demo', 'viewer')]));
    expect(saved.linkShare, 'members');
    expect(saved.members.any((m) => m.memberId == 'ou_demo'), isTrue);

    final c = await admin.addRecordComment(t.key, r.recordId, const CosRichText('联调评论'));
    expect(c.content.text, '联调评论');
    expect((await admin.recordComments(t.key, r.recordId)).any((x) => x.commentId == c.commentId), isTrue);
    final h = await admin.recordHistory(t.key, r.recordId);
    _dump('record history', await admin.request('GET', '/tables/${t.key}/records/${r.recordId}/history'));
    expect(h, isNotEmpty);
    expect(h.any((x) => x.changes.isNotEmpty), isTrue);

    final copy = await admin.copyTable(t.key, name: '联调表副本$_run', withRecords: true);
    expect(copy.key, isNot(t.key));
    expect((await admin.listRecords(copy.key)).items.length, 1);

    await admin.deleteTable(copy.key);
    await admin.deleteTable(t.key);
    final left = await admin.listTables();
    expect(left.any((x) => x.key == t.key || x.key == copy.key), isFalse);
  });

  test('F4 扫码登录：扫码 → 确认 → 桌面拿到会话；取消', () async {
    final desk = CosApiClient('${_url!}/api/v1');
    final ticket = await desk.createQrLogin('联调桌面');
    expect(ticket.content, 'classmateos://qr-login?qr_id=${ticket.qrId}');
    expect((await desk.pollQrLogin(ticket.qrId)).status, 'waiting');

    final scanned = await demo.scanQrLogin(ticket.qrId);
    expect(scanned.status, 'scanned');
    final p1 = await desk.pollQrLogin(ticket.qrId);
    expect(p1.status, 'scanned');
    _dump('qr scanned', p1.scannedBy);

    await demo.confirmQrLogin(ticket.qrId);
    final p2 = await desk.pollQrLogin(ticket.qrId);
    expect(p2.status, 'confirmed');
    expect(p2.session, isNotNull);
    final me = desk.adoptSession(p2.session!);
    expect(me.userId, 'ou_demo');
    expect((await desk.me()).userId, 'ou_demo');
    // 会话只交付一次
    await expectLater(desk.pollQrLogin(ticket.qrId), throwsA(isA<CosApiException>().having((e) => e.statusCode, 'status', 404)));

    final desk2 = CosApiClient('${_url!}/api/v1');
    final t2 = await desk2.createQrLogin('联调桌面2');
    await demo.scanQrLogin(t2.qrId);
    await demo.cancelQrLogin(t2.qrId);
    expect((await desk2.pollQrLogin(t2.qrId)).status, 'canceled');
  });

  test('F4 管理后台：成员、角色、日志、安全设置、无权限 403', () async {
    final (u, pwd) = await admin.adminSaveUser(null, {'username': 'lt$_run', 'name': '联调成员$_run'});
    expect(u.user.name, '联调成员$_run');
    expect(pwd, isNotNull);
    final found = await admin.adminListUsers(q: '联调成员$_run');
    expect(found.items.any((x) => x.user.userId == u.user.userId), isTrue);
    final dis = await admin.adminSetUserStatus(u.user.userId, true);
    expect(dis.status, 'disabled');
    await admin.adminSetUserStatus(u.user.userId, false);
    expect(await admin.adminResetPassword(u.user.userId), isNotEmpty);
    await admin.adminLogoutAll(u.user.userId);

    final role = await admin.saveRole(null, name: '联调角色$_run', permissions: ['admin.members']);
    final withMember = await admin.setRoleMembers(role.roleId, [u.user.userId]);
    expect(withMember.memberIds, contains(u.user.userId));
    expect((await admin.listRoles()).any((x) => x.roleId == role.roleId), isTrue);
    await admin.setRoleMembers(role.roleId, []);
    await admin.deleteRole(role.roleId);

    final logs = await admin.listAuditLogs();
    _dump('audit first', logs.items.isEmpty ? null : logs.items.first.action);
    expect(logs.items, isNotEmpty);

    final sec = await admin.securitySettings();
    final sec2 = await admin.saveSecuritySettings(sec);
    expect(sec2.passwordMinLength, sec.passwordMinLength);

    await expectLater(demo.adminListUsers(), throwsA(isA<CosApiException>().having((e) => e.statusCode, 'status', 403)));
  });

  test('F4 组织架构：部门增删改、成员、路径', () async {
    final root = await admin.createDepartment(name: '联调部门$_run');
    final child = await admin.createDepartment(name: '联调小组$_run', parentId: root.departmentId);
    expect(child.parentId, root.departmentId);
    expect((await admin.listDepartments(parentId: root.departmentId)).any((x) => x.departmentId == child.departmentId), isTrue);

    await admin.addDepartmentMembers(child.departmentId, ['ou_demo']);
    expect((await admin.departmentUsers(child.departmentId)).any((x) => x.userId == 'ou_demo'), isTrue);
    final path = await admin.departmentPath(child.departmentId);
    expect(path.map((d) => d.departmentId).toList(), containsAllInOrder([root.departmentId, child.departmentId]));
    expect((await admin.getDepartment(root.departmentId)).memberCount, 1, reason: '含下级部门');

    final renamed = await admin.updateDepartment(child.departmentId, name: '联调小组改$_run');
    expect(renamed.name, '联调小组改$_run');
    await admin.removeDepartmentMember(child.departmentId, 'ou_demo');
    expect((await admin.departmentUsers(child.departmentId)).any((x) => x.userId == 'ou_demo'), isFalse);
    await admin.deleteDepartment(child.departmentId);
    await admin.deleteDepartment(root.departmentId);
  });

  // ---------------- 对接说明 11.9～11.12：剩余几块 ----------------

  /// 轮询异步任务直到结束（最多 30 秒）。
  Future<CosJob> waitJob(CosApiClient c, String id) async {
    expect(id, isNotEmpty);
    for (var i = 0; i < 150; i++) {
      final j = await c.getJob(id);
      if (j.finished) return j;
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
    fail('任务 $id 30 秒内没有结束');
  }

  test('知识库：空间、页面树、移动、复制、收藏、搜索、最近、删除', () async {
    final sp = await admin.createSpace({'name': '联调空间$_run', 'description': '联调', 'visibility': 'org'});
    expect(sp.name, '联调空间$_run');
    expect((await admin.listSpaces()).any((x) => x.spaceId == sp.spaceId), isTrue);
    expect((await demo.listSpaces()).any((x) => x.spaceId == sp.spaceId), isTrue, reason: 'org 可见');

    final a = await admin.createNode(sp.spaceId, title: '联调页A$_run');
    final b = await admin.createNode(sp.spaceId, title: '联调页B$_run');
    final a1 = await admin.createNode(sp.spaceId, parentId: a.nodeId, title: '联调子页$_run');
    expect(a.objId, isNotEmpty, reason: '页面就是云文档');
    final top = await admin.listNodes(sp.spaceId);
    expect(top.map((n) => n.nodeId).toList(), [a.nodeId, b.nodeId], reason: '新建放到最后');
    expect(top.first.hasChildren, isTrue);
    expect((await admin.listNodes(sp.spaceId, parentId: a.nodeId)).single.nodeId, a1.nodeId);
    expect((await admin.nodeAncestors(a1.nodeId)).map((n) => n.nodeId), contains(a.nodeId));

    // 页面正文走云文档接口
    final doc = await admin.getDoc(a.objId);
    await admin.request('PATCH', '/docs/${doc.docId}', body: {'markdown': '联调关键词 qzx$_run'});

    final rn = await admin.renameNode(b.nodeId, '联调页B改$_run');
    expect(rn.title, '联调页B改$_run');
    await admin.moveNode(b.nodeId, spaceId: sp.spaceId, afterNodeId: null);
    expect((await admin.listNodes(sp.spaceId)).first.nodeId, b.nodeId, reason: 'after_node_id 为 null 放第一个');

    final cp = await admin.copyNode(a.nodeId, withChildren: true);
    expect(cp.nodeId, isNot(a.nodeId));
    expect(cp.hasChildren, isTrue);

    await admin.starNode(a.nodeId, true);
    expect((await admin.wikiStarred()).any((n) => n.nodeId == a.nodeId), isTrue);
    await admin.starNode(a.nodeId, false);
    expect((await admin.wikiStarred()).any((n) => n.nodeId == a.nodeId), isFalse);
    expect((await admin.wikiRecent()).any((n) => n.nodeId == a.nodeId), isTrue, reason: '打开过页面文档');

    final hits = await admin.searchWiki('qzx$_run', spaceId: sp.spaceId);
    _dump('wiki search', hits.map((h) => h.raw).toList());
    expect(hits.any((h) => h.id == doc.docId || h.raw['node_id'] == a.nodeId), isTrue);

    // 已有文档移入知识库
    final plain = await admin.createDocIn('联调移入$_run', '正文');
    final moved = await admin.importDocToWiki(sp.spaceId, plain.docId);
    expect(moved.objId, plain.docId);

    // 成员与可见范围：改成仅成员后 demo 看不到
    final mem = await admin.spaceMembers(sp.spaceId);
    await admin.saveSpaceMembers(sp.spaceId, mem.copyWith(linkShare: 'members'));
    expect((await demo.listSpaces()).any((x) => x.spaceId == sp.spaceId), isFalse);

    await admin.deleteNode(a.nodeId);
    expect((await admin.listNodes(sp.spaceId)).any((n) => n.nodeId == a.nodeId), isFalse);
    expect((await admin.listDocsIn('trash')).any((d) => d.docId == doc.docId), isTrue, reason: '删除页面进回收站');
    await admin.deleteSpace(sp.spaceId);
    expect((await admin.listSpaces()).any((x) => x.spaceId == sp.spaceId), isFalse);
  });

  test('表格导入导出：CSV 预览、追加 / 按主字段更新、导出', () async {
    final t = await admin.createTable(name: '联调导入$_run', primaryField: 'name', fields: [
      {'field_name': 'name', 'title': '名称', 'type': 1, 'required': true},
      {'field_name': 'qty', 'title': '数量', 'type': 2},
    ]);
    const csv = '\uFEFF名称,数量\n甲,1\n乙,2\n丙,abc\n';
    final f = await admin.uploadBytes('联调.csv', Uint8List.fromList(utf8.encode(csv)), contentType: 'text/csv');
    final p = await admin.previewTableImport(f.fileKey);
    expect(p.headers, ['名称', '数量']);
    expect(p.totalRows, 3);
    expect(p.rows.first, ['甲', '1']);
    _dump('suggested', p.suggestedTypes);

    final j1 = await waitJob(admin, await admin.startTableImport(t.key, fileKey: f.fileKey, mode: 'append', mapping: {'名称': 'name', '数量': 'qty'}));
    _dump('import job', {'status': j1.status, 'ok': j1.succeeded, 'failed': j1.failed, 'err': j1.errorFileKey, 'msg': j1.message});
    expect(j1.ok, isTrue);
    expect(j1.succeeded, 2);
    expect(j1.failed, 1, reason: '「abc」不是数字');
    expect(j1.errorFileKey, isNotNull);

    const csv2 = '名称,数量\n甲,10\n丁,4\n';
    final f2 = await admin.uploadBytes('联调2.csv', Uint8List.fromList(utf8.encode(csv2)), contentType: 'text/csv');
    final j2 = await waitJob(admin, await admin.startTableImport(t.key, fileKey: f2.fileKey, mode: 'upsert', mapping: {'名称': 'name', '数量': 'qty'}));
    expect(j2.ok, isTrue);
    final recs = (await admin.listRecords(t.key)).items;
    expect(recs.length, 3, reason: '甲更新、丁追加');
    expect(recs.firstWhere((r) => r.fields['name'] == '甲').fields['qty'], 10);

    for (final fmt in ['csv', 'xlsx']) {
      final ex = await waitJob(admin, await admin.startTableExport(t.key, format: fmt));
      expect(ex.ok, isTrue, reason: fmt);
      expect(ex.fileKey, isNotNull);
      expect(ex.fileName, endsWith('.$fmt'));
      expect(await admin.downloadUrl(ex.fileKey!), isNotEmpty);
    }
    // 别人的任务查不到
    await expectLater(demo.getJob(j1.jobId), throwsA(isA<CosApiException>().having((e) => e.statusCode, 'status', 404)));
    await admin.deleteTable(t.key);
  });

  test('文档导出：PDF 与 Word', () async {
    final d = await admin.createDocIn('联调导出$_run', '# 标题\n\n正文，**加粗**。\n\n- 一\n- 二\n');
    for (final fmt in ['pdf', 'docx']) {
      final j = await waitJob(admin, await admin.startDocExport(d.docId, fmt));
      _dump('doc export $fmt', {'status': j.status, 'file': j.fileName, 'msg': j.message});
      expect(j.ok, isTrue, reason: fmt);
      expect(j.fileName, endsWith('.$fmt'));
    }
    await admin.deleteDoc(d.docId);
    await admin.deleteDocForever(d.docId);
  });

  test('成员批量导入：模板、预览校验、导入', () async {
    expect(await admin.userImportTemplate(), isNotEmpty);
    final csv = '登录账号,姓名,邮箱,手机号,职务,部门,直属上级,角色\n'
        'imp$_run,联调导入$_run,,,硕士生,,,\n'
        ',缺账号$_run,,,,,,\n';
    final f = await admin.uploadBytes('成员.csv', Uint8List.fromList(utf8.encode(csv)), contentType: 'text/csv');
    final p = await admin.previewUserImport(f.fileKey);
    _dump('user preview', p);
    expect(p['total_rows'], 2);
    expect((p['errors'] as List).single['row'], 1, reason: '第二行缺登录账号；row 是 rows 的下标，从 0 起');
    final j = await waitJob(admin, await admin.startUserImport(f.fileKey));
    expect(j.ok, isTrue);
    expect(j.succeeded, 1);
    expect(j.fileKey, isNotNull, reason: '初始密码文件');
    final found = await admin.adminListUsers(q: '联调导入$_run');
    expect(found.items, hasLength(1));
    await expectLater(demo.previewUserImport(f.fileKey), throwsA(isA<CosApiException>().having((e) => e.statusCode, 'status', 403)));
  });

  test('工作台快捷方式与报表时间范围', () async {
    final apps = await admin.workbenchApps();
    expect(apps.builtin, isNotEmpty);
    final saved = await admin.saveShortcuts([
      const CosShortcut('', 'doc', 'doc_x', '联调快捷1'),
      const CosShortcut('', 'wiki_space', 'sp_x', '联调快捷2'),
    ]);
    expect(saved.map((s) => s.name), ['联调快捷1', '联调快捷2']);
    expect(saved.every((s) => s.id.isNotEmpty), isTrue);
    final kept = await admin.saveShortcuts([saved[1]]);
    expect(kept.single.id, saved[1].id, reason: '带旧 id 保留');
    expect((await demo.workbenchApps()).shortcuts.any((s) => s.id == saved[1].id), isFalse, reason: '快捷方式是个人的');
    await admin.saveShortcuts([]);

    for (final r in ['week', 'month', 'semester']) {
      final s = await admin.dashboardSummaryRange(CosReportRange(r));
      _dump('range $r', s['range']);
      expect((s['range'] as Map)['range'], r);
    }
    final now = DateTime.now();
    final day = DateTime(now.year, now.month, now.day);
    final c = await admin.dashboardSummaryRange(CosReportRange('custom', day.subtract(const Duration(days: 6)), day.add(const Duration(days: 1))));
    expect((c['range'] as Map)['range'], 'custom');
    await expectLater(admin.dashboardSummaryRange(CosReportRange('custom', day, day)),
        throwsA(isA<CosApiException>().having((e) => e.statusCode, 'status', 422)));
  });
}
