/// 实验室任务扩展；补充约定见二期迭代3接口文档。
library;
import '../api_client.dart';
import '../models.dart';
import 'phase2_docs.dart';

class CosTaskList {
  final String id, name, description;
  final String? projectId;
  final Map<String, dynamic> permissions;
  CosTaskList.fromJson(Map<String, dynamic> j)
      : id = j['list_id'] as String, name = j['name'] as String? ?? '',
        description = j['description'] as String? ?? '', projectId = j['project_record_id'] as String?,
        permissions = (j['permissions'] as Map? ?? {}).cast<String, dynamic>();
  bool can(String key) => permissions[key] == true;
}

extension Phase2TasksApi on CosApiClient {
  Future<List<Map<String, dynamic>>> taskItems(String path, {Map<String, String>? query}) async {
    final result = <Map<String, dynamic>>[];
    final seen = <String>{};
    String? token;
    do {
      final j = await request('GET', path, query: {...?query, if (token != null) 'page_token': token});
      result.addAll([for (final x in (j['items'] as List? ?? [])) (x as Map).cast<String, dynamic>()]);
      if (j['has_more'] != true) break;
      token = (j['page_token'] ?? j['next_page_token']) as String?;
      if (token == null || !seen.add(token)) throw StateError('分页游标缺失或重复，请刷新后重试');
    } while (true);
    return result;
  }
  Future<CosTask> getTask(String id) async => CosTask.fromJson(await request('GET', '/tasks/${Uri.encodeComponent(id)}'));
  Future<List<CosTask>> subtasks(String id) async => (await taskItems('/tasks/$id/subtasks')).map(CosTask.fromJson).toList();
  Future<void> orderSubtasks(String id, List<String> ids) async => request('POST', '/tasks/$id/subtasks/order', body: {'task_ids': ids});
  Future<void> followTask(String id, String user, bool follow) async => request(follow ? 'POST' : 'DELETE', '/tasks/$id/followers/$user');
  Future<List<Map<String, dynamic>>> taskComments(String id) => taskItems('/tasks/$id/comments');
  Future<List<Map<String, dynamic>>> taskActivities(String id) => taskItems('/tasks/$id/activities');
  Future<void> addTaskComment(String id, CosRichText text, List<Map<String, dynamic>> attachments) async => request('POST', '/tasks/$id/comments', body: {'content': text.toJson(), 'attachments': attachments});
  Future<void> deleteTaskComment(String id, String comment) async => request('DELETE', '/tasks/$id/comments/$comment');
  Future<List<CosTaskList>> taskLists({String? projectId}) async => (await taskItems('/tasklists', query: {if (projectId != null) 'project_record_id': projectId})).map(CosTaskList.fromJson).toList();
  Future<CosTaskList> saveTaskList(Map<String, dynamic> body, {String? id}) async => CosTaskList.fromJson(await request(id == null ? 'POST' : 'PATCH', id == null ? '/tasklists' : '/tasklists/$id', body: body));
  Future<void> deleteTaskList(String id) async => request('DELETE', '/tasklists/$id');
  Future<List<Map<String, dynamic>>> taskSections(String id) => taskItems('/tasklists/$id/sections');
  Future<void> saveTaskSection(String id, String name, {String? sectionId}) async => request(sectionId == null ? 'POST' : 'PATCH', '/tasklists/$id/sections${sectionId == null ? '' : '/$sectionId'}', body: {'name': name});
  Future<void> deleteTaskSection(String id, String section) async => request('DELETE', '/tasklists/$id/sections/$section');
  Future<List<CosTask>> tasksInList(String id) async => (await taskItems('/tasklists/$id/tasks')).map(CosTask.fromJson).toList();
  Future<void> putTaskInList(String task, String list, String? section) async => request('POST', '/tasks/$task/tasklists', body: {'list_id': list, 'section_id': section});
  Future<void> removeTaskFromList(String task, String list) async => request('DELETE', '/tasks/$task/tasklists/$list');
  Future<CosSharing> taskListMembers(String id) async => CosSharing.fromJson(await request('GET', '/tasklists/$id/members'));
  Future<CosSharing> saveTaskListMembers(String id, CosSharing sharing) async => CosSharing.fromJson(await request('PUT', '/tasklists/$id/members', body: {'members': sharing.members.map((e) => e.toJson()).toList()}));
}
