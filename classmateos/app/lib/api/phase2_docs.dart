/// 二期迭代 2 接口：云文档（分享权限、评论、历史版本、文件夹与空间）、知识库 Wiki、
/// 多维表格的表权限 / 表管理 / 记录评论与修改历史。
/// 契约见《二期功能需求文档》第 4（R-BT-09、R-BT-10）、5、6 节。
library;

import '../api_client.dart';
import '../models.dart';

Map<String, dynamic>? _m(dynamic v) => v is Map ? v.cast<String, dynamic>() : null;
String? _s(dynamic v) => v == null || v.toString().isEmpty ? null : v.toString();
DateTime? _t(dynamic v) => v == null ? null : DateTime.tryParse(v.toString());
int _i(dynamic v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
List<Map<String, dynamic>> _list(dynamic v) => [
      for (final e in (v is List ? v : const [])) if (e is Map) e.cast<String, dynamic>(),
    ];

// ---------------- 协作者与权限（R-DC-01、R-WK-01、R-BT-09 共用） ----------------

/// 角色的中文名。文档：viewer / commenter / editor / manager；
/// 知识空间：viewer / editor / admin；表：viewer / editor / manager。
const kRoleLabels = <String, String>{
  'viewer': '可阅读',
  'commenter': '可评论',
  'editor': '可编辑',
  'manager': '可管理',
  'admin': '管理员',
  'owner': '所有者',
};

const kDocRoles = ['viewer', 'commenter', 'editor', 'manager'];
const kSpaceRoles = ['viewer', 'editor', 'admin'];
const kTableRoles = ['viewer', 'editor', 'manager'];

class CosMember {
  final String memberType; // user | department | chat
  final String memberId;
  final String role;
  const CosMember(this.memberType, this.memberId, this.role);

  CosMember withRole(String r) => CosMember(memberType, memberId, r);

  factory CosMember.fromJson(Map<String, dynamic> j) => CosMember(
        j['member_type']?.toString() ?? 'user',
        j['member_id']?.toString() ?? '',
        j['role']?.toString() ?? 'viewer',
      );
  Map<String, dynamic> toJson() => {'member_type': memberType, 'member_id': memberId, 'role': role};

  @override
  bool operator ==(Object other) => other is CosMember && other.memberType == memberType && other.memberId == memberId && other.role == role;
  @override
  int get hashCode => Object.hash(memberType, memberId, role);
}

/// 文档权限 / 表权限 / 知识空间成员的统一结构。
class CosSharing {
  final String? ownerId;

  /// 文档：off | org_view | org_edit；表：all | members（可见范围）；知识空间：org | members。
  final String linkShare;
  final List<CosMember> members;

  /// 知识库页面：继承自哪个空间（有值时分享面板只显示继承说明 + 链接分享）。
  final String? inheritedSpaceId;
  final String? inheritedSpaceName;

  const CosSharing({this.ownerId, this.linkShare = 'off', this.members = const [], this.inheritedSpaceId, this.inheritedSpaceName});

  CosSharing copyWith({String? ownerId, String? linkShare, List<CosMember>? members}) => CosSharing(
        ownerId: ownerId ?? this.ownerId,
        linkShare: linkShare ?? this.linkShare,
        members: members ?? this.members,
        inheritedSpaceId: inheritedSpaceId,
        inheritedSpaceName: inheritedSpaceName,
      );

  factory CosSharing.fromJson(Map<String, dynamic> j, {String linkKey = 'link_share'}) {
    final inh = _m(j['inherited_from']);
    return CosSharing(
      ownerId: _s(j['owner_id']),
      linkShare: j[linkKey]?.toString() ?? (linkKey == 'visibility' ? 'members' : 'off'),
      members: [for (final e in _list(j['members'])) CosMember.fromJson(e)],
      inheritedSpaceId: _s(inh?['space_id']),
      inheritedSpaceName: _s(inh?['name']),
    );
  }
}

// ---------------- 评论（R-DC-02） ----------------

class CosMention {
  final String userId;
  final String name;
  final int offset;
  final int length;
  const CosMention(this.userId, this.name, this.offset, this.length);
  factory CosMention.fromJson(Map<String, dynamic> j) =>
      CosMention(j['user_id']?.toString() ?? '', j['name']?.toString() ?? '', _i(j['offset']), _i(j['length']));
  Map<String, dynamic> toJson() => {'user_id': userId, 'name': name, 'offset': offset, 'length': length};
}

/// 带 @ 的富文本（需求文档 2.4）。
class CosRichText {
  final String text;
  final List<CosMention> mentions;
  const CosRichText(this.text, [this.mentions = const []]);
  factory CosRichText.fromJson(dynamic j) {
    if (j is String) return CosRichText(j);
    final m = _m(j) ?? const {};
    return CosRichText(m['text']?.toString() ?? '', [for (final e in _list(m['mentions'])) CosMention.fromJson(e)]);
  }
  Map<String, dynamic> toJson() => {'text': text, 'mentions': [for (final m in mentions) m.toJson()]};

  /// 从输入框文字里按「@名字」识别提及（名字取自成员目录，长名字优先）。
  static CosRichText parse(String text, List<CosUser> users) {
    final out = <CosMention>[];
    final sorted = [...users]..sort((a, b) => b.name.length.compareTo(a.name.length));
    var i = 0;
    while (true) {
      i = text.indexOf('@', i);
      if (i < 0) break;
      CosUser? hit;
      for (final u in sorted) {
        if (u.name.isNotEmpty && text.startsWith(u.name, i + 1)) {
          hit = u;
          break;
        }
      }
      if (hit != null) {
        out.add(CosMention(hit.userId, hit.name, i, hit.name.length + 1));
        i += hit.name.length + 1;
      } else {
        i++;
      }
    }
    return CosRichText(text, out);
  }
}

class CosCommentReply {
  final String replyId;
  final String userId;
  final CosRichText content;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  const CosCommentReply({required this.replyId, required this.userId, required this.content, this.createdAt, this.updatedAt});
  factory CosCommentReply.fromJson(Map<String, dynamic> j) => CosCommentReply(
        replyId: j['reply_id']?.toString() ?? '',
        userId: j['user_id']?.toString() ?? '',
        content: CosRichText.fromJson(j['content']),
        createdAt: _t(j['created_at']),
        updatedAt: _t(j['updated_at']),
      );
}

class CosComment {
  final String commentId;
  final String docId;
  final String? quote;

  /// 锚点：后端格式为 Yjs RelativePosition；前端未接 Yjs 时额外带 offset / length（见待联调文档）。
  final Map<String, dynamic> anchor;
  final bool isWhole;
  final bool solved;
  final List<CosCommentReply> replies;
  final String createdBy;
  final DateTime? createdAt;

  /// 原文被删光时后端返回 true（或前端在正文里找不到 quote）。
  final bool quoteDeleted;

  const CosComment({
    required this.commentId,
    required this.docId,
    this.quote,
    this.anchor = const {},
    this.isWhole = false,
    this.solved = false,
    this.replies = const [],
    required this.createdBy,
    this.createdAt,
    this.quoteDeleted = false,
  });

  int? get offset => anchor['offset'] is num ? (anchor['offset'] as num).toInt() : null;

  factory CosComment.fromJson(Map<String, dynamic> j) => CosComment(
        commentId: j['comment_id']?.toString() ?? '',
        docId: j['doc_id']?.toString() ?? '',
        quote: _s(j['quote']),
        anchor: _m(j['anchor']) ?? const {},
        isWhole: j['is_whole'] == true,
        solved: j['solved'] == true,
        replies: [for (final e in _list(j['replies'])) CosCommentReply.fromJson(e)],
        createdBy: j['created_by']?.toString() ?? '',
        createdAt: _t(j['created_at']),
        quoteDeleted: j['quote_deleted'] == true,
      );
}

// ---------------- 历史版本（R-DC-03） ----------------

class CosDocVersion {
  final String versionId;
  final String? name;
  final String createdBy;
  final DateTime? createdAt;
  final int added;
  final int removed;
  /// 机器人代 createdBy 写的版本。
  final bool viaBot;
  const CosDocVersion({required this.versionId, this.name, required this.createdBy, this.createdAt, this.added = 0, this.removed = 0, this.viaBot = false});
  factory CosDocVersion.fromJson(Map<String, dynamic> j) => CosDocVersion(
        versionId: j['version_id']?.toString() ?? '',
        name: _s(j['name']),
        createdBy: j['created_by']?.toString() ?? '',
        createdAt: _t(j['created_at']),
        added: _i(j['added']),
        removed: _i(j['removed']),
        viaBot: j['via_bot'] == true,
      );
}

// ---------------- 文件夹（R-DC-05） ----------------

class CosFolder {
  final String folderId;
  final String name;
  final String? parentId;
  final DateTime? updatedAt;
  const CosFolder({required this.folderId, required this.name, this.parentId, this.updatedAt});
  factory CosFolder.fromJson(Map<String, dynamic> j) => CosFolder(
        folderId: j['folder_id']?.toString() ?? '',
        name: j['name']?.toString() ?? '',
        parentId: _s(j['parent_id']),
        updatedAt: _t(j['updated_at']),
      );
}

// ---------------- 知识库（R-WK-01 ~ 04） ----------------

class CosWikiSpace {
  final String spaceId;
  final String name;
  final String description;
  final String icon;
  final String color;
  final String visibility; // org | members
  final String myRole; // admin | editor | viewer
  final int pageCount;
  final DateTime? updatedAt;
  const CosWikiSpace({
    required this.spaceId,
    required this.name,
    this.description = '',
    this.icon = 'book',
    this.color = 'blue',
    this.visibility = 'org',
    this.myRole = 'viewer',
    this.pageCount = 0,
    this.updatedAt,
  });
  bool get canEdit => myRole == 'admin' || myRole == 'editor';
  bool get isAdmin => myRole == 'admin';
  factory CosWikiSpace.fromJson(Map<String, dynamic> j) => CosWikiSpace(
        spaceId: j['space_id']?.toString() ?? '',
        name: j['name']?.toString() ?? '',
        description: j['description']?.toString() ?? '',
        icon: j['icon']?.toString() ?? 'book',
        color: j['color']?.toString() ?? 'blue',
        visibility: j['visibility']?.toString() ?? 'org',
        myRole: j['my_role']?.toString() ?? 'viewer',
        pageCount: _i(j['page_count']),
        updatedAt: _t(j['updated_at']),
      );
}

class CosWikiNode {
  final String nodeId;
  final String spaceId;
  final String? parentId;
  final String title;
  final String objType; // doc | bitable_view
  final String objId;
  final bool hasChildren;
  final num order;
  final DateTime? updatedAt;
  final String? updatedBy;
  final bool starred;

  /// 最近访问 / 收藏列表里附带空间名。
  final String? spaceName;
  const CosWikiNode({
    required this.nodeId,
    required this.spaceId,
    this.parentId,
    required this.title,
    this.objType = 'doc',
    this.objId = '',
    this.hasChildren = false,
    this.order = 0,
    this.updatedAt,
    this.updatedBy,
    this.starred = false,
    this.spaceName,
  });
  CosWikiNode copyWith({String? title, bool? hasChildren, bool? starred, String? parentId, bool clearParent = false}) => CosWikiNode(
        nodeId: nodeId,
        spaceId: spaceId,
        parentId: clearParent ? null : (parentId ?? this.parentId),
        title: title ?? this.title,
        objType: objType,
        objId: objId,
        hasChildren: hasChildren ?? this.hasChildren,
        order: order,
        updatedAt: updatedAt,
        updatedBy: updatedBy,
        starred: starred ?? this.starred,
        spaceName: spaceName,
      );
  factory CosWikiNode.fromJson(Map<String, dynamic> j) => CosWikiNode(
        nodeId: j['node_id']?.toString() ?? '',
        spaceId: j['space_id']?.toString() ?? '',
        parentId: _s(j['parent_id']),
        title: j['title']?.toString() ?? '',
        objType: j['obj_type']?.toString() ?? 'doc',
        objId: j['obj_id']?.toString() ?? '',
        hasChildren: j['has_children'] == true,
        order: j['order'] is num ? j['order'] as num : 0,
        updatedAt: _t(j['updated_at']),
        updatedBy: _s(j['updated_by']),
        starred: j['starred'] == true,
        spaceName: _s(j['space_name']),
      );
}

class CosSearchHit {
  final String type;
  final String id;
  final String title;
  final String snippet;
  final Map<String, dynamic> raw;
  const CosSearchHit(this.type, this.id, this.title, this.snippet, this.raw);
  factory CosSearchHit.fromJson(Map<String, dynamic> j) => CosSearchHit(
        j['type']?.toString() ?? '',
        (j['id'] ?? j['node_id'] ?? '').toString(),
        j['title']?.toString() ?? '',
        (j['snippet'] ?? j['highlight'] ?? '').toString(),
        j,
      );
}

// ---------------- 记录评论与修改历史（R-BT-10） ----------------

class CosRecordComment {
  final String commentId;
  final String userId;
  final CosRichText content;
  final DateTime? createdAt;
  const CosRecordComment(this.commentId, this.userId, this.content, this.createdAt);
  factory CosRecordComment.fromJson(Map<String, dynamic> j) => CosRecordComment(
        j['comment_id']?.toString() ?? '',
        (j['user_id'] ?? j['created_by'] ?? '').toString(),
        CosRichText.fromJson(j['content']),
        _t(j['created_at']),
      );
}

class CosFieldChange {
  final String fieldName;
  final dynamic before;
  final dynamic after;
  const CosFieldChange(this.fieldName, this.before, this.after);
}

class CosRecordHistory {
  final String operatorId;
  final DateTime? at;
  final String? action; // created | updated | deleted（可选）
  final List<CosFieldChange> changes;
  /// 机器人代 operatorId 修改的。
  final bool viaBot;
  const CosRecordHistory(this.operatorId, this.at, this.changes, {this.action, this.viaBot = false});
  factory CosRecordHistory.fromJson(Map<String, dynamic> j) => CosRecordHistory(
        j['operator_id']?.toString() ?? '',
        _t(j['at']),
        [for (final c in _list(j['changes'])) CosFieldChange(c['field_name']?.toString() ?? '', c['before'], c['after'])],
        action: _s(j['action']),
        viaBot: j['via_bot'] == true,
      );
}

// ---------------- 请求 ----------------

String _q(String s) => Uri.encodeComponent(s);

extension Phase2DocsApi on CosApiClient {
  Future<List<T>> _items<T>(String path, T Function(Map<String, dynamic>) f, {Map<String, String>? query}) async {
    final out = <T>[];
    String? token;
    for (var i = 0; i < 20; i++) {
      final j = await request('GET', path, query: {...?query, if (token != null) 'page_token': token});
      final p = parsePage(j, f);
      out.addAll(p.items);
      if (!p.hasMore || p.pageToken == null) break;
      token = p.pageToken;
    }
    return out;
  }

  // ---- 文档列表、文件夹、收藏、回收站（R-DC-05） ----

  /// scope：recent | mine | shared | starred | trash；mine 时可带 folder_id 列文件夹内容。
  Future<List<CosDoc>> listDocsIn(String scope, {String? folderId, String? keyword}) => _items('/docs', CosDoc.fromJson, query: {
        'scope': scope,
        if (folderId != null) 'folder_id': folderId,
        if (keyword != null && keyword.isNotEmpty) 'keyword': keyword,
        'page_size': '200',
      });

  /// 列文件夹：不传 parent 是「我的空间」第一层。
  Future<List<CosFolder>> listFolders({String? parentId}) =>
      _items('/folders', CosFolder.fromJson, query: {if (parentId != null) 'parent_id': parentId});

  Future<CosFolder> createFolder(String name, {String? parentId}) async =>
      CosFolder.fromJson(await request('POST', '/folders', body: {'name': name, 'parent_id': parentId}));

  Future<CosFolder> updateFolder(String folderId, {String? name, String? parentId, bool toRoot = false}) async =>
      CosFolder.fromJson(await request('PATCH', '/folders/${_q(folderId)}', body: {
        if (name != null) 'name': name,
        if (parentId != null || toRoot) 'parent_id': parentId,
      }));

  Future<void> deleteFolder(String folderId) => request('DELETE', '/folders/${_q(folderId)}');

  /// 移动文档到文件夹（null = 我的空间根目录）。
  Future<CosDoc> moveDoc(String docId, String? folderId) async =>
      CosDoc.fromJson(await request('PATCH', '/docs/${_q(docId)}', body: {'folder_id': folderId}));

  Future<void> starDoc(String docId, bool star) => request(star ? 'POST' : 'DELETE', '/docs/${_q(docId)}/star');

  Future<void> restoreDoc(String docId) => request('POST', '/docs/${_q(docId)}/restore');

  Future<void> deleteDocForever(String docId) => request('DELETE', '/docs/${_q(docId)}', query: {'permanent': 'true'});

  /// 新建文档（可放进文件夹）。
  Future<CosDoc> createDocIn(String title, String markdown, {String? folderId}) async => CosDoc.fromJson(
      await request('POST', '/docs', body: {'title': title, 'markdown': markdown, if (folderId != null) 'folder_id': folderId}));

  // ---- 分享与权限（R-DC-01） ----

  Future<CosSharing> docPermissions(String docId) async =>
      CosSharing.fromJson(await request('GET', '/docs/${_q(docId)}/permissions'));

  Future<CosSharing> saveDocPermissions(String docId, CosSharing s) async =>
      CosSharing.fromJson(await request('PUT', '/docs/${_q(docId)}/permissions', body: {
        'link_share': s.linkShare,
        'members': [for (final m in s.members) m.toJson()],
      }));

  Future<void> transferDoc(String docId, String ownerId) =>
      request('POST', '/docs/${_q(docId)}/transfer', body: {'owner_id': ownerId});

  Future<void> requestDocAccess(String docId, {String role = 'editor', String note = ''}) =>
      request('POST', '/docs/${_q(docId)}/access-requests', body: {'role': role, 'note': note});

  Future<void> handleAccessRequest(String docId, String requestId, bool approve) =>
      request('POST', '/docs/${_q(docId)}/access-requests/${_q(requestId)}/${approve ? 'approve' : 'reject'}');

  // ---- 评论（R-DC-02） ----

  Future<List<CosComment>> listComments(String docId, {bool? solved}) => _items(
      '/docs/${_q(docId)}/comments', CosComment.fromJson, query: {if (solved != null) 'solved': '$solved'});

  Future<CosComment> createComment(String docId, CosRichText content,
          {String? quote, Map<String, dynamic>? anchor, bool whole = false}) async =>
      CosComment.fromJson(await request('POST', '/docs/${_q(docId)}/comments', body: {
        'is_whole': whole,
        if (quote != null) 'quote': quote,
        if (anchor != null) 'anchor': anchor,
        'content': content.toJson(),
      }));

  Future<CosCommentReply> replyComment(String docId, String commentId, CosRichText content) async =>
      CosCommentReply.fromJson(await request('POST', '/docs/${_q(docId)}/comments/${_q(commentId)}/replies',
          body: {'content': content.toJson()}));

  Future<void> editReply(String docId, String commentId, String replyId, CosRichText content) =>
      request('PATCH', '/docs/${_q(docId)}/comments/${_q(commentId)}/replies/${_q(replyId)}', body: {'content': content.toJson()});

  Future<void> deleteReply(String docId, String commentId, String replyId) =>
      request('DELETE', '/docs/${_q(docId)}/comments/${_q(commentId)}/replies/${_q(replyId)}');

  Future<void> solveComment(String docId, String commentId, bool solved) =>
      request('PATCH', '/docs/${_q(docId)}/comments/${_q(commentId)}', body: {'solved': solved});

  // ---- 历史版本（R-DC-03） ----

  Future<List<CosDocVersion>> listVersions(String docId) => _items('/docs/${_q(docId)}/versions', CosDocVersion.fromJson);

  Future<String> versionMarkdown(String docId, String versionId) async =>
      (await request('GET', '/docs/${_q(docId)}/versions/${_q(versionId)}'))['markdown']?.toString() ?? '';

  Future<void> renameVersion(String docId, String versionId, String name) =>
      request('PATCH', '/docs/${_q(docId)}/versions/${_q(versionId)}', body: {'name': name});

  Future<void> restoreVersion(String docId, String versionId) =>
      request('POST', '/docs/${_q(docId)}/versions/${_q(versionId)}/restore');

  // ---- 知识空间（R-WK-01） ----

  Future<List<CosWikiSpace>> listSpaces() => _items('/wiki/spaces', CosWikiSpace.fromJson);

  Future<CosWikiSpace> getSpace(String id) async => CosWikiSpace.fromJson(await request('GET', '/wiki/spaces/${_q(id)}'));

  Future<CosWikiSpace> createSpace(Map<String, dynamic> body) async =>
      CosWikiSpace.fromJson(await request('POST', '/wiki/spaces', body: body));

  Future<CosWikiSpace> updateSpace(String id, Map<String, dynamic> patch) async =>
      CosWikiSpace.fromJson(await request('PATCH', '/wiki/spaces/${_q(id)}', body: patch));

  Future<void> deleteSpace(String id) => request('DELETE', '/wiki/spaces/${_q(id)}');

  Future<CosSharing> spaceMembers(String id) async =>
      CosSharing.fromJson(await request('GET', '/wiki/spaces/${_q(id)}/members'), linkKey: 'visibility');

  Future<CosSharing> saveSpaceMembers(String id, CosSharing s) async =>
      CosSharing.fromJson(await request('PUT', '/wiki/spaces/${_q(id)}/members', body: {
        'visibility': s.linkShare,
        'members': [for (final m in s.members) m.toJson()],
      }), linkKey: 'visibility');

  // ---- 目录树（R-WK-02） ----

  Future<List<CosWikiNode>> listNodes(String spaceId, {String? parentId}) => _items(
      '/wiki/spaces/${_q(spaceId)}/nodes', CosWikiNode.fromJson, query: {if (parentId != null) 'parent_id': parentId});

  Future<CosWikiNode> createNode(String spaceId, {String? parentId, required String title, String objType = 'doc', String? afterNodeId}) async =>
      CosWikiNode.fromJson(await request('POST', '/wiki/spaces/${_q(spaceId)}/nodes', body: {
        'parent_id': parentId,
        'title': title,
        'obj_type': objType,
        if (afterNodeId != null) 'after_node_id': afterNodeId,
      }));

  Future<CosWikiNode> renameNode(String nodeId, String title) async =>
      CosWikiNode.fromJson(await request('PATCH', '/wiki/nodes/${_q(nodeId)}', body: {'title': title}));

  /// 移动：[afterNodeId] 为 null 时放到新父节点的第一个。
  Future<CosWikiNode> moveNode(String nodeId, {required String spaceId, String? parentId, String? afterNodeId}) async =>
      CosWikiNode.fromJson(await request('POST', '/wiki/nodes/${_q(nodeId)}/move', body: {
        'space_id': spaceId,
        'parent_id': parentId,
        'after_node_id': afterNodeId,
      }));

  Future<CosWikiNode> copyNode(String nodeId, {bool withChildren = false, String? title}) async =>
      CosWikiNode.fromJson(await request('POST', '/wiki/nodes/${_q(nodeId)}/copy', body: {
        'with_children': withChildren,
        if (title != null) 'title': title,
      }));

  Future<void> deleteNode(String nodeId) => request('DELETE', '/wiki/nodes/${_q(nodeId)}');

  Future<List<CosWikiNode>> nodeAncestors(String nodeId) => _items('/wiki/nodes/${_q(nodeId)}/ancestors', CosWikiNode.fromJson);

  Future<CosWikiNode> getNode(String nodeId) async => CosWikiNode.fromJson(await request('GET', '/wiki/nodes/${_q(nodeId)}'));

  Future<CosWikiNode> importDocToWiki(String spaceId, String docId, {String? parentId}) async =>
      CosWikiNode.fromJson(await request('POST', '/wiki/spaces/${_q(spaceId)}/import', body: {'doc_id': docId, 'parent_id': parentId}));

  // ---- 搜索、最近、收藏（R-WK-04） ----

  Future<List<CosSearchHit>> searchWiki(String q, {String? spaceId}) async {
    final j = await request('GET', '/search', query: {'scope': 'wiki', if (spaceId != null) 'space_id': spaceId, 'q': q});
    return [for (final e in _list(j['items'])) CosSearchHit.fromJson(e)];
  }

  Future<List<CosWikiNode>> wikiRecent() => _items('/wiki/recent', CosWikiNode.fromJson);
  Future<List<CosWikiNode>> wikiStarred() => _items('/wiki/starred', CosWikiNode.fromJson);
  Future<void> starNode(String nodeId, bool star) => request(star ? 'POST' : 'DELETE', '/wiki/nodes/${_q(nodeId)}/star');

  // ---- 表权限与表管理（R-BT-09、R-BT-10） ----

  /// 表权限：linkShare 字段承载可见范围 all | members。
  Future<CosSharing> tablePermissions(String key) async =>
      CosSharing.fromJson(await request('GET', '/tables/${_q(key)}/permissions'), linkKey: 'visibility');

  Future<CosSharing> saveTablePermissions(String key, CosSharing s) async =>
      CosSharing.fromJson(await request('PUT', '/tables/${_q(key)}/permissions', body: {
        'visibility': s.linkShare,
        'members': [for (final m in s.members) m.toJson()],
      }), linkKey: 'visibility');

  Future<CosTableMeta> updateTable(String key, {String? name, String? description, String? icon}) async =>
      CosTableMeta.fromJson(await request('PATCH', '/tables/${_q(key)}', body: {
        if (name != null) 'name': name,
        if (description != null) 'description': description,
        if (icon != null) 'icon': icon,
      }));

  Future<CosTableMeta> copyTable(String key, {required String name, bool withRecords = false}) async =>
      CosTableMeta.fromJson(await request('POST', '/tables/${_q(key)}/copy', body: {'name': name, 'with_records': withRecords}));

  Future<void> deleteTable(String key) => request('DELETE', '/tables/${_q(key)}');

  Future<List<CosRecordComment>> recordComments(String key, String recordId) =>
      _items('/tables/${_q(key)}/records/${_q(recordId)}/comments', CosRecordComment.fromJson);

  Future<CosRecordComment> addRecordComment(String key, String recordId, CosRichText content) async =>
      CosRecordComment.fromJson(
          await request('POST', '/tables/${_q(key)}/records/${_q(recordId)}/comments', body: {'content': content.toJson()}));

  /// 删除记录评论：本人或表管理者（对接说明 11.11）。
  Future<void> deleteRecordComment(String key, String recordId, String commentId) =>
      request('DELETE', '/tables/${_q(key)}/records/${_q(recordId)}/comments/${_q(commentId)}');

  Future<List<CosRecordHistory>> recordHistory(String key, String recordId) =>
      _items('/tables/${_q(key)}/records/${_q(recordId)}/history', CosRecordHistory.fromJson);
}
