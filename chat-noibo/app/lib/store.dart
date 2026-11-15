import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';

String currentPlatform() {
  if (kIsWeb) return 'web';
  switch (defaultTargetPlatform) {
    case TargetPlatform.windows:
      return 'windows';
    case TargetPlatform.android:
      return 'android';
    case TargetPlatform.iOS:
      return 'ios';
    default:
      return 'other';
  }
}

String newClientId() {
  final r = Random.secure();
  return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}

/// Trạng thái toàn ứng dụng.
///
/// Tin nhắn chỉ giữ trong bộ nhớ, không ghi ra đĩa: trên điện thoại cá nhân, thứ gì
/// không nằm trên máy thì không thể bị sao chép ra khỏi máy. Mỗi lần mở app sẽ tải lại
/// từ server (vài chục KB), đổi lại khi thiết bị bị thu hồi thì không còn dữ liệu nào sót.
class AppState extends ChangeNotifier {
  static const _storage = FlutterSecureStorage();
  final Api api = Api();

  Me? me;
  bool booting = true;
  String? notice; // thông báo hiển thị ở màn hình đăng nhập (vd: bị thu hồi)
  List<Conversation> conversations = [];
  final Map<String, List<Message>> messages = {};
  final Map<String, bool> hasMore = {};
  String? activeId;
  bool online = false;

  WebSocketChannel? _ws;
  StreamSubscription? _wsSub;
  Timer? _ping, _reconnect;
  int _backoff = 1;
  bool _disposed = false;

  Future<void> boot() async {
    try {
      final t = await _storage.read(key: 'token');
      if (t != null) {
        api.token = t;
        me = await api.me();
        await _afterLogin();
      }
    } on ApiError catch (e) {
      if (e.isAuth) await _wipe(e.message);
    } catch (_) {
      // mất mạng lúc khởi động: vẫn giữ token, thử lại khi người dùng thao tác
    }
    booting = false;
    notifyListeners();
  }

  Future<void> login(String username, String password) async {
    final (token, m) = await api.login(username, password, currentPlatform(), _deviceName());
    api.token = token;
    me = m;
    notice = null;
    await _storage.write(key: 'token', value: token);
    await _afterLogin();
    notifyListeners();
  }

  Future<void> reloadMe() async {
    final m = await guard(() => api.me());
    if (m != null) me = m;
    notifyListeners();
  }

  String _deviceName() => kIsWeb ? 'Trình duyệt' : defaultTargetPlatform.name;

  Future<void> logout() async {
    try {
      await api.logout();
    } catch (_) {}
    await _wipe(null);
  }

  /// Xóa sạch dữ liệu cục bộ: token, tin nhắn trong bộ nhớ, ngắt WebSocket.
  Future<void> _wipe(String? reason) async {
    _closeWs();
    _reconnect?.cancel();
    await _storage.deleteAll();
    api.token = null;
    me = null;
    conversations = [];
    messages.clear();
    hasMore.clear();
    activeId = null;
    notice = reason;
    if (!_disposed) notifyListeners();
  }

  Future<void> _afterLogin() async {
    await refreshConversations();
    _connectWs();
  }

  Future<T?> guard<T>(Future<T> Function() f) async {
    try {
      return await f();
    } on ApiError catch (e) {
      if (e.isAuth) await _wipe(e.message);
      rethrow;
    }
  }

  Future<void> refreshConversations() async {
    final list = await guard(() => api.conversations());
    if (list == null) return;
    conversations = list;
    notifyListeners();
  }

  Conversation? conv(String id) {
    for (final c in conversations) {
      if (c.id == id) return c;
    }
    return null;
  }

  Future<void> open(String id) async {
    activeId = id;
    notifyListeners();
    if (!messages.containsKey(id)) {
      final list = await guard(() => api.messages(id));
      messages[id] = list ?? [];
      hasMore[id] = (list?.length ?? 0) >= 50;
    } else {
      await _catchUp(id);
    }
    _markRead(id);
    notifyListeners();
  }

  void close() {
    activeId = null;
    notifyListeners();
  }

  Future<void> loadOlder(String id) async {
    final list = messages[id];
    if (list == null || list.isEmpty || hasMore[id] == false) return;
    final older = await guard(() => api.messages(id, before: list.first.seq));
    if (older == null) return;
    hasMore[id] = older.length >= 50;
    messages[id] = [...older, ...list];
    notifyListeners();
  }

  Future<void> _catchUp(String id) async {
    final list = messages[id];
    if (list == null || list.isEmpty) return;
    final newer = await guard(() => api.messages(id, after: list.last.seq, limit: 100));
    if (newer != null) newer.forEach(_upsert);
  }

  void _markRead(String id) {
    final c = conv(id);
    if (c == null || c.unread == 0) return;
    c.lastReadSeq = c.lastSeq;
    api.markRead(id, c.lastSeq).catchError((_) {});
  }

  Future<void> sendText(String convId, String text) async {
    final m = await guard(() => api.sendText(convId, text, newClientId()));
    if (m != null) _upsert(m);
  }

  Future<void> sendFile(String convId, String name, String mime, Uint8List bytes) async {
    final m = await guard(() => api.sendFile(convId, name, mime, bytes, newClientId()));
    if (m != null) _upsert(m);
  }

  Future<void> forward(Message m, String targetId) async {
    final out = await guard(() => api.forward(m.id, targetId));
    if (out != null) _upsert(out);
  }

  Future<void> recall(Message m) async {
    final out = await guard(() => api.recall(m.id));
    if (out != null) _upsert(out);
  }

  Future<Conversation?> openDm(String userId) async {
    final c = await guard(() => api.openDm(userId));
    if (c == null) return null;
    if (conv(c.id) == null) conversations = [c, ...conversations];
    notifyListeners();
    return c;
  }

  Future<Conversation?> createGroup(String name, List<String> ids) async {
    final c = await guard(() => api.createGroup(name, ids));
    await refreshConversations();
    return c;
  }

  void _upsert(Message m) {
    final list = messages[m.conversationId];
    if (list != null) {
      final i = list.indexWhere((x) => x.id == m.id);
      if (i >= 0) {
        list[i] = m;
      } else {
        list.add(m);
        list.sort((a, b) => a.seq.compareTo(b.seq));
      }
    }
    final c = conv(m.conversationId);
    if (c == null) {
      refreshConversations();
      return;
    }
    if (m.seq >= c.lastSeq) {
      c.lastSeq = m.seq;
      c.lastMessage = m;
      c.lastMsgAt = m.createdAt;
      if (m.senderId == me?.userId) c.lastReadSeq = m.seq;
      conversations.sort((a, b) => b.lastMsgAt.compareTo(a.lastMsgAt));
    } else if (c.lastMessage?.id == m.id) {
      c.lastMessage = m;
    }
    if (activeId == c.id && m.senderId != me?.userId) _markRead(c.id);
    notifyListeners();
  }

  // ---------------------------------------------------------------- WebSocket

  void _connectWs() {
    _closeWs();
    if (api.token == null) return;
    try {
      final ch = api.connectWs();
      _ws = ch;
      _wsSub = ch.stream.listen(_onWs, onDone: _onWsDown, onError: (_) => _onWsDown());
      _ping = Timer.periodic(const Duration(seconds: 25), (_) {
        try {
          _ws?.sink.add('ping');
        } catch (_) {}
      });
    } catch (_) {
      _onWsDown();
    }
  }

  void _onWs(dynamic data) {
    if (data == 'pong') return;
    final Map<String, dynamic> ev;
    try {
      ev = jsonDecode(data as String);
    } catch (_) {
      return;
    }
    switch (ev['type']) {
      case 'hello':
        final wasOffline = !online;
        online = true;
        _backoff = 1;
        if (wasOffline) {
          refreshConversations().catchError((_) {});
          if (activeId != null) _catchUp(activeId!).catchError((_) {});
        }
        notifyListeners();
      case 'message':
      case 'message_updated':
        _upsert(Message.fromJson(ev['message']));
      case 'conversation_changed':
        refreshConversations().catchError((_) {});
      case 'revoked':
        _wipe(ev['reason'] ?? 'Phiên đăng nhập đã bị thu hồi');
    }
  }

  void _onWsDown() {
    online = false;
    _ping?.cancel();
    if (!_disposed) notifyListeners();
    if (api.token == null || _disposed) return;
    _reconnect?.cancel();
    _reconnect = Timer(Duration(seconds: _backoff), () async {
      _backoff = min(_backoff * 2, 30);
      // Kiểm tra phiên trước khi nối lại: tài khoản bị khóa thì dọn dữ liệu.
      try {
        await api.me();
      } on ApiError catch (e) {
        if (e.isAuth) return _wipe(e.message);
      } catch (_) {}
      _connectWs();
    });
  }

  void _closeWs() {
    _ping?.cancel();
    _wsSub?.cancel();
    _wsSub = null;
    try {
      _ws?.sink.close();
    } catch (_) {}
    _ws = null;
  }

  @override
  void dispose() {
    _disposed = true;
    _closeWs();
    _reconnect?.cancel();
    super.dispose();
  }
}
