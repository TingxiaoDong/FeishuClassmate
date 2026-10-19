import 'dart:convert';

import 'package:classmateos_app/api/phase2_docs.dart';
import 'package:classmateos_app/api/phase2_tasks.dart';
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/models.dart';
import 'package:classmateos_app/pages/tasks_page.dart';
import 'package:classmateos_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

(CosApiClient, List<http.Request>) recorder(Object? Function(http.Request) reply) {
  final reqs = <http.Request>[];
  final c = MockClient((r) async {
    reqs.add(r);
    return http.Response.bytes(utf8.encode(jsonEncode(reply(r) ?? {})), 200, headers: {'content-type': 'application/json'});
  });
  return (CosApiClient('http://x/api/v1', accessToken: 't', client: c), reqs);
}

Map<String, dynamic> body(http.Request r) => (jsonDecode(r.body) as Map).cast<String, dynamic>();

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 200));
  }
}

const _task = {'task_id': 't1', 'title': 'x', 'status': 'pending', 'created_by': 'ou_admin'};

void main() {
  group('迭代 3 任务接口契约', () {
    test('任务新字段解析；旧后端缺字段时取默认值', () {
      final t = CosTask.fromJson({
        ..._task,
        'parent_id': 'p1',
        'subtask_count': 5,
        'subtask_done_count': 2,
        'depth': 3,
        'follower_ids': ['ou_demo'],
        'permissions': {'can_edit': false, 'can_comment': true},
        'tasklists': [{'list_id': 'tl_1', 'section_id': 'sec_1', 'name': '项目'}],
      });
      expect([t.parentId, t.subtaskCount, t.subtaskDoneCount, t.depth], ['p1', 5, 2, 3]);
      expect(t.followerIds, ['ou_demo']);
      expect(t.can('can_edit', true), isFalse);
      expect(t.sectionIn('tl_1'), 'sec_1');
      final old = CosTask.fromJson(_task);
      expect([old.depth, old.subtaskCount, old.followerIds.length, old.tasklists.length], [1, 0, 0, 0]);
      expect(old.can('can_edit', true), isTrue, reason: '没有 permissions 时走前端兜底规则');
    });

    test('子任务：创建带 parent_id，排序发 task_ids，列表参数', () async {
      final (api, reqs) = recorder((r) => r.method == 'GET' ? {'items': [_task], 'has_more': false} : _task);
      await api.createTask(title: '子', parentId: 't1');
      expect(body(reqs.last)['parent_id'], 't1');
      await api.subtasks('t1');
      expect(reqs.last.url.path, '/api/v1/tasks/t1/subtasks');
      await api.orderSubtasks('t1', ['a', 'b']);
      expect([reqs.last.method, reqs.last.url.path, body(reqs.last)], ['POST', '/api/v1/tasks/t1/subtasks/order', {'task_ids': ['a', 'b']}]);
      await api.listTasks(followerId: 'me', includeSubtasks: true);
      expect(reqs.last.url.queryParameters, {'follower_id': 'me', 'include_subtasks': 'true'});
      await api.getTask('t1');
      expect(reqs.last.url.path, '/api/v1/tasks/t1');
    });

    test('关注人、评论（富文本 + 附件）、动态', () async {
      final (api, reqs) = recorder((r) => r.method == 'GET' ? {'items': [], 'has_more': false} : {});
      await api.followTask('t1', 'ou_demo', true);
      expect([reqs.last.method, reqs.last.url.path], ['POST', '/api/v1/tasks/t1/followers/ou_demo']);
      await api.followTask('t1', 'ou_demo', false);
      expect(reqs.last.method, 'DELETE');
      await api.addTaskComment('t1', const CosRichText('@张 看', [CosMention('ou_zhang', '张', 0, 2)]),
          [{'file_key': 'f1', 'name': 'a.png', 'size': 3}]);
      final b = body(reqs.last);
      expect((b['content'] as Map)['mentions'], [{'user_id': 'ou_zhang', 'name': '张', 'offset': 0, 'length': 2}]);
      expect(b['attachments'], [{'file_key': 'f1', 'name': 'a.png', 'size': 3}]);
      await api.deleteTaskComment('t1', 'c1');
      expect([reqs.last.method, reqs.last.url.path], ['DELETE', '/api/v1/tasks/t1/comments/c1']);
      await api.taskActivities('t1');
      expect(reqs.last.url.path, '/api/v1/tasks/t1/activities');
    });

    test('分页：按 page_token 取完；游标重复时报错而不是死循环', () async {
      var n = 0;
      final (api, reqs) = recorder((r) => ++n == 1
          ? {'items': [_task], 'has_more': true, 'page_token': 'p2'}
          : {'items': [_task], 'has_more': false});
      expect((await api.subtasks('t1')).length, 2);
      expect(reqs.last.url.queryParameters['page_token'], 'p2');
      final (bad, _) = recorder((_) => {'items': [], 'has_more': true, 'page_token': 'same'});
      expect(() => bad.subtasks('t1'), throwsStateError);
    });

    test('清单：加入 / 移动 / 移出、分组、成员', () async {
      final (api, reqs) = recorder((r) => r.method == 'GET' ? {'items': [], 'has_more': false} : {'list_id': 'tl_1', 'name': 'n', 'members': []});
      await api.putTaskInList('t1', 'tl_1', 'sec_2');
      expect([reqs.last.url.path, body(reqs.last)], ['/api/v1/tasks/t1/tasklists', {'list_id': 'tl_1', 'section_id': 'sec_2'}]);
      await api.putTaskInList('t1', 'tl_1', null);
      expect(body(reqs.last), containsPair('section_id', null), reason: '移到未分组时显式发 null');
      await api.removeTaskFromList('t1', 'tl_1');
      expect([reqs.last.method, reqs.last.url.path], ['DELETE', '/api/v1/tasks/t1/tasklists/tl_1']);
      await api.saveTaskSection('tl_1', '实验中', sectionId: 'sec_2');
      expect([reqs.last.method, reqs.last.url.path], ['PATCH', '/api/v1/tasklists/tl_1/sections/sec_2']);
      await api.saveTaskListMembers('tl_1', const CosSharing(members: [CosMember('user', 'ou_demo', 'editor')]));
      expect(body(reqs.last), {'members': [{'member_type': 'user', 'member_id': 'ou_demo', 'role': 'editor'}]});
    });
  });

  group('任务界面（测试数据模式）', () {
    late MockBackend mock;
    late AppState state;

    Future<void> boot(WidgetTester tester, {bool tasksOff = false, Size size = const Size(1500, 900)}) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      mock = MockBackend();
      if (tasksOff) {
        for (final k in ['task.subtasks', 'task.followers', 'task.comments', 'task.lists']) {
          mock.features[k] = false;
        }
      }
      final api = CosApiClient(kMockBaseUrl, client: mock.client);
      await tester.runAsync(() async {
        final me = await api.login('admin', 'x');
        state = AppState(api: api, me: me, onLogout: () {});
        mock.onEvent = (e) => state.injectEvent(CosEvent.fromJson(e));
        await state.init(realtime: false);
        state.module = AppModule.tasks;
      });
      await tester.pumpWidget(MaterialApp(theme: buildFsTheme(), home: AppScope(state: state, child: const Scaffold(body: TasksPage()))));
      await settle(tester);
    }

    testWidgets('开关关闭时：没有「我关注的」和任务清单', (tester) async {
      await boot(tester, tasksOff: true);
      expect(find.text('我负责的'), findsWidgets);
      expect(find.text('我关注的'), findsNothing);
      expect(find.text('任务清单'), findsNothing);
    });

    testWidgets('左栏「我关注的」+ 清单；打开任务详情显示子任务、关注人、评论', (tester) async {
      await boot(tester);
      expect(find.text('机械臂抓取项目'), findsOneWidget);
      await tester.tap(find.text('我关注的').first);
      await settle(tester);
      expect(find.text('四足机器人楼梯步态仿真'), findsOneWidget);
      expect(find.text('整理机械臂抓取实验数据'), findsOneWidget);
      expect(find.text('1/3'), findsOneWidget, reason: '父任务卡片显示子任务进度');
      await tester.tap(find.text('整理机械臂抓取实验数据'));
      await settle(tester);
      expect(find.text('计算成功率和失败类型'), findsOneWidget);
      expect(find.text('评论 2'), findsOneWidget);
      expect(find.text('所属清单'), findsOneWidget);
      // 加子任务
      await tester.enterText(find.widgetWithText(TextField, '添加子任务，回车保存'), '写实验小结');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await settle(tester);
      expect(mock.taskApi.tasks.values.where((t) => t['parent_id'] == 'task_1').length, 4);
      expect(find.text('写实验小结'), findsOneWidget);
      // 发评论（带 @）
      await tester.ensureVisible(find.byTooltip('发送'));
      await tester.pump();
      await tester.enterText(find.widgetWithText(TextField, '发表评论，输入 @姓名 提及成员'), '@张晓明 图做好了吗');
      await tester.tap(find.byTooltip('发送'));
      await settle(tester);
      final c = mock.taskApi.comments['task_1']!.last;
      expect(((c['content'] as Map)['mentions'] as List).single['user_id'], 'ou_zhang');
      // 动态
      await tester.ensureVisible(find.text('动态'));
      await tester.pump();
      await tester.tap(find.text('动态'));
      await settle(tester);
      expect(find.textContaining('把状态从「待开始」改为「进行中」'), findsOneWidget);
    });

    testWidgets('任务清单：分组列表、看板视图、新建分组', (tester) async {
      await boot(tester);
      await tester.tap(find.text('机械臂抓取项目'));
      await settle(tester);
      expect(find.text('实验中'), findsOneWidget);
      expect(find.text('写论文'), findsOneWidget);
      expect(find.text('投稿 ICRA：补充消融实验'), findsOneWidget);
      await tester.tap(find.text('看板'));
      await settle(tester);
      expect(find.text('整理机械臂抓取实验数据'), findsOneWidget);
      // 在「待开始」分组快速添加任务
      await tester.enterText(find.widgetWithText(TextField, '添加任务，回车保存').first, '采购夹爪备件');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await settle(tester);
      final added = mock.taskApi.tasks.values.firstWhere((t) => t['title'] == '采购夹爪备件');
      expect(mock.taskApi.placement[added['task_id']], {'tl_rlhf': 'sec_1'});
      expect(find.text('采购夹爪备件'), findsOneWidget);
    });

    testWidgets('模拟后端：把任务移到另一个分组、删除分组后回到未分组', (tester) async {
      await boot(tester);
      await tester.runAsync(() async {
        await state.api.putTaskInList('task_4', 'tl_rlhf', 'sec_2');
        expect(mock.taskApi.placement['task_4'], {'tl_rlhf': 'sec_2'});
        await state.api.deleteTaskSection('tl_rlhf', 'sec_2');
        final t = await state.api.getTask('task_4');
        expect(t.sectionIn('tl_rlhf'), isNull);
        expect(t.tasklists.single.listId, 'tl_rlhf');
      });
    });

    testWidgets('窄屏：顶部菜单进入清单，返回按钮回到列表', (tester) async {
      await boot(tester, size: const Size(420, 860));
      await tester.tap(find.byTooltip('任务清单'));
      await settle(tester);
      await tester.tap(find.text('机械臂抓取项目').last);
      await settle(tester);
      expect(find.text('实验中'), findsOneWidget);
      await tester.tap(find.byTooltip('返回'));
      await settle(tester);
      expect(find.text('我负责的'), findsOneWidget);
    });
  });
}
