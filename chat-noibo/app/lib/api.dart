import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

/// Địa chỉ máy chủ, gắn cứng lúc build: flutter build windows --dart-define=API_BASE=https://chat.congty.vn
const String kApiBase = String.fromEnvironment('API_BASE', defaultValue: 'http://127.0.0.1:8787');

class ApiError implements Exception {
  final int status;
  final String code;
  final String message;
  ApiError(this.status, this.code, this.message);
  bool get isAuth => status == 401;
  @override
  String toString() => message;
}

class Me {
  final String userId, username, displayName, role, deviceId, platform;
  final bool trusted, mustChangePassword;
  final String kind, organization;
  Me.fromJson(Map<String, dynamic> j)
      : userId = j['user_id'],
        username = j['username'],
        displayName = j['display_name'],
        role = j['role'],
        deviceId = j['device_id'],
        platform = j['platform'],
        trusted = j['trusted'] == true,
        mustChangePassword = j['must_change_password'] == true,
        kind = j['kind'] ?? 'internal',
        organization = j['organization'] ?? '';
  bool get isAdmin => role == 'admin';
  bool get isExternal => kind == 'external';
}

class Policy {
  final bool canUpload, canForwardOut, canCopy, needsApproval, canApprove;
  /// 'allow' | 'view' | 'deny'
  final String fileAccess;
  Policy.fromJson(Map<String, dynamic> j)
      : canUpload = j['can_upload'] == true,
        canForwardOut = j['can_forward_out'] == true,
        canCopy = j['can_copy'] == true,
        needsApproval = j['needs_approval'] == true,
        canApprove = j['can_approve'] == true,
        fileAccess = j['file_access'] ?? 'view';
}

class FileRef {
  final String id, name, mime;
  final int size;
  FileRef.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        name = j['name'] ?? 'tệp',
        mime = j['mime'] ?? 'application/octet-stream',
        size = (j['size'] ?? 0) as int;
  bool get isImage => mime.startsWith('image/');
  bool get isText => mime.startsWith('text/') || mime == 'application/json';
}

/// Tệp gửi ra bên ngoài đang chờ (hoặc đã được) duyệt.
class Approval {
  final String id, conversationId, conversationName, organization, senderId, senderName, caption, status, reason;
  final String? decidedByName;
  final FileRef file;
  final int createdAt;
  Approval.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        conversationId = j['conversation_id'],
        conversationName = j['conversation_name'] ?? '',
        organization = j['organization'] ?? '',
        senderId = j['sender_id'],
        senderName = j['sender_name'] ?? '',
        caption = j['caption'] ?? '',
        status = j['status'],
        reason = j['reason'] ?? '',
        decidedByName = j['decided_by_name'],
        file = FileRef.fromJson(j['file']),
        createdAt = j['created_at'];
  bool get isPending => status == 'pending';
}

class Message {
  final String id, conversationId, senderId, senderName, kind, text;
  final int seq, createdAt;
  final FileRef? file;
  final bool forwarded, recalled, senderExternal;
  final String senderOrg;
  final String? clientId;
  Message.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        conversationId = j['conversation_id'],
        seq = j['seq'],
        senderId = j['sender_id'],
        senderName = j['sender_name'] ?? '',
        senderExternal = j['sender_external'] == true,
        senderOrg = j['sender_org'] ?? '',
        kind = j['kind'],
        text = j['text'] ?? '',
        file = j['file'] == null ? null : FileRef.fromJson(j['file']),
        forwarded = j['forwarded'] == true,
        recalled = j['recalled'] == true,
        clientId = j['client_id'],
        createdAt = j['created_at'];
}

class Conversation {
  final String id, kind, name;
  final String? peerId;
  final bool managed, external;
  final String organization;
  final String myRole;
  int lastSeq, lastReadSeq, lastMsgAt;
  Message? lastMessage;
  final Policy policy;
  Conversation.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        kind = j['kind'],
        name = j['name'] ?? '',
        peerId = j['peer_id'],
        managed = j['managed'] == true,
        external = j['external'] == true,
        organization = j['organization'] ?? '',
        myRole = j['my_role'] ?? 'member',
        lastSeq = j['last_seq'] ?? 0,
        lastReadSeq = j['last_read_seq'] ?? 0,
        lastMsgAt = j['last_msg_at'] ?? 0,
        lastMessage = j['last_message'] == null ? null : Message.fromJson(j['last_message']),
        policy = Policy.fromJson(j['policy'] ?? const {});
  int get unread => (lastSeq - lastReadSeq).clamp(0, 1 << 30);
  bool get isGroup => kind == 'group';
}

class UserLite {
  final String id, username, displayName, department;
  UserLite.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        username = j['username'] ?? '',
        displayName = j['display_name'] ?? '',
        department = j['department'] ?? '';
}

class FileBlob {
  final Uint8List bytes;
  final String access;
  FileBlob(this.bytes, this.access);
}

class Api {
  final String base;
  String? token;
  final http.Client _http = http.Client();
  Api({this.base = kApiBase, this.token});

  Map<String, String> _headers([Map<String, String>? extra]) => {
        if (token != null) 'authorization': 'Bearer $token',
        ...?extra,
      };

  Future<Map<String, dynamic>> _send(String method, String path, {Object? body, Map<String, String>? query}) async {
    final uri = Uri.parse('$base$path').replace(queryParameters: query);
    final req = http.Request(method, uri)..headers.addAll(_headers());
    if (body != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    final res = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 30)));
    return _decode(res);
  }

  Map<String, dynamic> _decode(http.Response res) {
    Map<String, dynamic> data = {};
    try {
      data = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {}
    if (res.statusCode >= 400) {
      throw ApiError(res.statusCode, data['error'] ?? 'http_${res.statusCode}', data['message'] ?? 'Lỗi ${res.statusCode}');
    }
    return data;
  }

  Future<(String, Me)> login(String username, String password, String platform, String deviceName) async {
    final d = await _send('POST', '/api/auth/login',
        body: {'username': username, 'password': password, 'platform': platform, 'device_name': deviceName});
    return (d['token'] as String, Me.fromJson(d['me']));
  }

  Future<void> logout() => _send('POST', '/api/auth/logout');
  Future<Me> me() async => Me.fromJson((await _send('GET', '/api/me'))['me']);
  Future<void> changePassword(String oldP, String newP) =>
      _send('POST', '/api/auth/password', body: {'old_password': oldP, 'new_password': newP});

  Future<List<Conversation>> conversations() async =>
      ((await _send('GET', '/api/conversations'))['conversations'] as List).map((e) => Conversation.fromJson(e)).toList();

  Future<Conversation> openDm(String userId) async =>
      Conversation.fromJson((await _send('POST', '/api/conversations/dm', body: {'user_id': userId}))['conversation']);

  Future<Conversation> createGroup(String name, List<String> memberIds) async => Conversation.fromJson(
      (await _send('POST', '/api/conversations/group', body: {'name': name, 'member_ids': memberIds}))['conversation']);

  Future<List<UserLite>> users([String q = '']) async =>
      ((await _send('GET', '/api/users', query: {'q': q}))['users'] as List).map((e) => UserLite.fromJson(e)).toList();

  Future<List<Message>> messages(String convId, {int? before, int? after, int limit = 50}) async {
    final q = <String, String>{'limit': '$limit'};
    if (before != null) q['before'] = '$before';
    if (after != null) q['after'] = '$after';
    final d = await _send('GET', '/api/conversations/$convId/messages', query: q);
    return (d['messages'] as List).map((e) => Message.fromJson(e)).toList();
  }

  Future<Message> sendText(String convId, String text, String clientId) async => Message.fromJson(
      (await _send('POST', '/api/conversations/$convId/messages', body: {'text': text, 'client_id': clientId}))['message']);

  /// Trả về tin nhắn đã gửi, hoặc yêu cầu duyệt nếu tệp phải chờ trước khi ra ngoài.
  Future<(Message?, Approval?)> sendFile(String convId, String name, String mime, Uint8List bytes, String clientId) async {
    final uri = Uri.parse('$base/api/conversations/$convId/files').replace(queryParameters: {'client_id': clientId});
    final res = await _http
        .post(uri, headers: _headers({'content-type': mime, 'x-file-name': Uri.encodeComponent(name)}), body: bytes)
        .timeout(const Duration(minutes: 5));
    final d = _decode(res);
    if (d['pending'] != null) return (null, Approval.fromJson(d['pending']));
    return (Message.fromJson(d['message']), null);
  }

  Future<List<Approval>> pending(String convId) async =>
      ((await _send('GET', '/api/conversations/$convId/pending'))['approvals'] as List).map((e) => Approval.fromJson(e)).toList();
  Future<List<Approval>> approvals() async =>
      ((await _send('GET', '/api/approvals'))['approvals'] as List).map((e) => Approval.fromJson(e)).toList();
  Future<void> approve(String id) => _send('POST', '/api/approvals/$id/approve');
  Future<void> reject(String id, String reason) => _send('POST', '/api/approvals/$id/reject', body: {'reason': reason});
  Future<void> cancelApproval(String id) => _send('POST', '/api/approvals/$id/cancel');
  Future<Uint8List> approvalFile(String id) async {
    final res = await _http.get(Uri.parse('$base/api/approvals/$id/file'), headers: _headers()).timeout(const Duration(minutes: 5));
    if (res.statusCode >= 400) _decode(res);
    return res.bodyBytes;
  }

  Future<List<Map<String, dynamic>>> conversationMembers(String convId) async =>
      ((await _send('GET', '/api/conversations/$convId'))['members'] as List).cast<Map<String, dynamic>>();

  Future<void> markRead(String convId, int seq) => _send('POST', '/api/conversations/$convId/read', body: {'seq': seq});
  Future<Message> forward(String msgId, String targetConvId) async => Message.fromJson(
      (await _send('POST', '/api/messages/$msgId/forward', body: {'conversation_id': targetConvId}))['message']);
  Future<Message> recall(String msgId) async =>
      Message.fromJson((await _send('POST', '/api/messages/$msgId/recall'))['message']);

  Future<FileBlob> file(String fileId, {bool save = false}) async {
    final uri = Uri.parse('$base/api/files/$fileId').replace(queryParameters: save ? {'purpose': 'save'} : null);
    final res = await _http.get(uri, headers: _headers()).timeout(const Duration(minutes: 5));
    if (res.statusCode >= 400) _decode(res);
    return FileBlob(res.bodyBytes, res.headers['x-file-access'] ?? 'view');
  }

  WebSocketChannel connectWs() {
    final ws = base.replaceFirst(RegExp(r'^http'), 'ws');
    return WebSocketChannel.connect(Uri.parse('$ws/api/ws?token=${Uri.encodeComponent(token ?? '')}'));
  }
}
