import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'api.dart';

/// Cấu hình Firebase gắn lúc build (không cần google-services.json / GoogleService-Info.plist):
///   --dart-define=FCM_PROJECT_ID=... --dart-define=FCM_SENDER_ID=... --dart-define=FCM_API_KEY=...
///   --dart-define=FCM_APP_ID_ANDROID=1:...:android:... --dart-define=FCM_APP_ID_IOS=1:...:ios:...
/// Thiếu cấu hình thì thông báo đẩy tắt, ứng dụng vẫn chạy bình thường.
const _projectId = String.fromEnvironment('FCM_PROJECT_ID');
const _senderId = String.fromEnvironment('FCM_SENDER_ID');
const _apiKey = String.fromEnvironment('FCM_API_KEY');
const _appIdAndroid = String.fromEnvironment('FCM_APP_ID_ANDROID');
const _appIdIos = String.fromEnvironment('FCM_APP_ID_IOS');

class Push {
  Push._();
  static final Push instance = Push._();

  bool _ready = false;
  StreamSubscription<String>? _refresh;
  StreamSubscription<RemoteMessage>? _opened;

  /// Bấm vào thông báo -> id hội thoại cần mở.
  final StreamController<String> openRequests = StreamController.broadcast();
  /// Thông báo được bấm trước khi màn hình chính kịp lắng nghe (mở app từ trạng thái tắt).
  String? pendingOpen;

  bool get _mobile => !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS);

  String get _appId => defaultTargetPlatform == TargetPlatform.iOS ? _appIdIos : _appIdAndroid;

  bool get configured => _mobile && _projectId.isNotEmpty && _senderId.isNotEmpty && _apiKey.isNotEmpty && _appId.isNotEmpty;

  Future<void> _init() async {
    if (_ready || !configured) return;
    await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: _apiKey,
        appId: _appId,
        messagingSenderId: _senderId,
        projectId: _projectId,
        iosBundleId: 'vn.noibo.chatNoibo',
      ),
    );
    _ready = true;
  }

  /// Gọi sau khi đăng nhập: xin quyền, lấy mã thiết bị, gửi lên máy chủ.
  Future<void> register(Api api) async {
    if (!configured) return;
    try {
      await _init();
      final fm = FirebaseMessaging.instance;
      final perm = await fm.requestPermission(alert: true, badge: true, sound: true);
      if (perm.authorizationStatus == AuthorizationStatus.denied) return;
      // Đang mở app thì tin đã đến qua WebSocket, không hiện thêm thông báo hệ thống.
      await fm.setForegroundNotificationPresentationOptions(alert: false, badge: false, sound: false);
      final token = await fm.getToken();
      if (token != null) await api.registerPushToken(token);
      _refresh?.cancel();
      _refresh = fm.onTokenRefresh.listen((t) => api.registerPushToken(t).catchError((_) {}));
      _opened?.cancel();
      _opened = FirebaseMessaging.onMessageOpenedApp.listen(_handleOpen);
      final initial = await fm.getInitialMessage();
      if (initial != null) _handleOpen(initial);
    } catch (e) {
      // iOS giả lập không có APNs, máy không có dịch vụ Google...: bỏ qua, app vẫn chạy.
      debugPrint('Không bật được thông báo đẩy: $e');
    }
  }

  void _handleOpen(RemoteMessage m) {
    final id = m.data['conversation_id'];
    if (id is! String || id.isEmpty) return;
    if (openRequests.hasListener) {
      openRequests.add(id);
    } else {
      pendingOpen = id;
    }
  }

  /// Đăng xuất / bị thu hồi: xóa mã để máy không nhận thông báo của tài khoản cũ.
  Future<void> unregister() async {
    _refresh?.cancel();
    _opened?.cancel();
    if (!_ready) return;
    try {
      await FirebaseMessaging.instance.deleteToken();
    } catch (_) {}
  }
}

/// Windows: nháy biểu tượng trên thanh tác vụ khi có tin mới mà cửa sổ không ở phía trước.
class DesktopAttention {
  static const _ch = MethodChannel('chat_noibo/window');
  static Future<void> flash() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.windows) return;
    try {
      await _ch.invokeMethod('flash');
    } catch (_) {}
  }
}
