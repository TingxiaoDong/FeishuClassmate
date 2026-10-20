import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:classmateos_app/api_client.dart';
import 'package:classmateos_app/api/phase2_admin.dart';
import 'package:classmateos_app/api/phase2_jobs.dart';
import 'package:classmateos_app/app_state.dart';
import 'package:classmateos_app/mock/mock_backend.dart';
import 'package:classmateos_app/services/app_links.dart';

void main() {
  late MockBackend mock;
  late CosApiClient api;
  setUp(() async {
    mock = MockBackend();
    api = CosApiClient(kMockBaseUrl, client: mock.client);
    await api.login('admin', 'mock');
  });
  test('分享链接中文及特殊字符往返', () {
    final path = appPathFor(AppModule.bitable, {'type':'record','table_key':'项目 A','id':'r/1','view_id':'v 1'});
    final link = parseAppPath(path)!;
    expect(link.target!['table_key'], '项目 A');
    expect(link.target!['id'], 'r/1');
    expect(link.target!['view_id'], 'v 1');
    expect(parseAppPath('/wiki/spaces/s1')!.target!['type'], 'wiki_space');
    expect(parseAppPath('/not-a-module'), isNull);
  });
  test('个人资料修改', () async {
    final u = await api.updateMyProfile(statusText:'做实验中', phone:'123456');
    expect(u.statusText, '做实验中');
    expect(u.phone, '123456');
  });
  test('修改密码后旧密码不可登录', () async {
    await api.changePassword('mock', 'NewPass123');
    await expectLater(api.login('admin','mock'), throwsA(isA<CosApiException>()));
    expect((await api.login('admin','NewPass123')).userId,'ou_admin');
  });
  test('禁用成员拒绝登录', () async {
    await api.adminSetUserStatus('ou_demo', true);
    await expectLater(api.login('demo','mock'), throwsA(isA<CosApiException>()));
  });
  test('部门创建改名删除', () async {
    final d = await api.createDepartment(name:'测试组');
    expect((await api.updateDepartment(d.departmentId,name:'新名称')).name,'新名称');
    await api.deleteDepartment(d.departmentId);
    await expectLater(api.getDepartment(d.departmentId), throwsA(isA<CosApiException>()));
  });
  test('角色权限保存', () async {
    final r = await api.saveRole(null,name:'测试角色',permissions:['admin.audit']);
    expect((await api.listRoles()).any((x)=>x.roleId==r.roleId), isTrue);
    await api.deleteRole(r.roleId);
  });
  test('安全设置往返', () async {
    final settings = await api.securitySettings();
    settings.passwordMinLength = 12;
    expect((await api.saveSecuritySettings(settings)).passwordMinLength,12);
  });
  test('二维码扫描确认登录', () async {
    final ticket = await api.createQrLogin('测试电脑');
    expect(parseQrLogin(ticket.content), ticket.qrId);
    expect((await api.pollQrLogin(ticket.qrId)).status,'waiting');
    await api.scanQrLogin(ticket.qrId);
    expect((await api.pollQrLogin(ticket.qrId)).status,'scanned');
    await api.confirmQrLogin(ticket.qrId);
    final confirmed = await api.pollQrLogin(ticket.qrId);
    expect(confirmed.status,'confirmed');
    expect(api.adoptSession(confirmed.session!).userId,'ou_admin');
  });
  test('二维码取消', () async {
    final t = await api.createQrLogin('测试电脑');
    await api.scanQrLogin(t.qrId);
    await api.cancelQrLogin(t.qrId);
    expect((await api.pollQrLogin(t.qrId)).status,'canceled');
  });
  test('工作台快捷方式往返', () async {
    final result = await api.saveShortcuts([const CosShortcut('', 'doc', 'd1', '我的文档')]);
    expect(result.single.name,'我的文档');
    expect((await api.workbenchApps()).shortcuts.single.targetId,'d1');
  });
  test('日志导出任务完成', () async {
    final id = await api.exportAuditLogs();
    CosJob j = await api.getJob(id);
    for(var i=0;i<5 && !j.finished;i++) { j = await api.getJob(id); }
    expect(j.ok,isTrue);
    expect(j.fileKey,isNotNull);
  });
  test('CSV 上传预览', () async {
    final f = await api.uploadBytes('样例.csv',Uint8List.fromList(utf8.encode('名称,数量\n试剂,2\n器材,3')));
    final p = await api.previewTableImport(f.fileKey);
    expect(p.headers,['名称','数量']);
    expect(p.totalRows,2);
  });
  test('报表按时间范围返回与真实后端一致的结构', () async {
    for (final r in const [CosReportRange.week, CosReportRange('month'), CosReportRange('semester')]) {
      final d = await api.dashboardSummaryRange(r);
      expect(d['failures'], isA<List>());
      expect(d['projects_kpi'], isA<Map>());
      expect(d['tool_usage'], isA<Map>());
      expect(d['tool_success'], isA<Map>());
      expect((d['equipment'] as Map)['by_state'], isA<Map>());
      expect((d['submissions'] as Map)['by_status'], isA<Map>());
    }
  });
  test('跨模块目标保留供地址栏刷新', () async {
    final s = AppState(api:api,me:await api.login('admin','mock'),onLogout:(){});
    await s.init(realtime:false);
    s.openTarget({'type':'doc','id':'test-doc'});
    expect(s.currentPath,'/docs/test-doc');
    s.go(AppModule.workbench);
    expect(s.currentPath,'/workbench');
  });
}
