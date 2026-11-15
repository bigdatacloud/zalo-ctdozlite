import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'api.dart';

enum CallPhase { idle, outgoing, incoming, connecting, active }

/// Thông tin cuộc gọi do máy chủ trả về.
class CallInfo {
  final String id, conversationId, callerId, callerName, calleeId, calleeName, callerDevice, state;
  final String? calleeDevice, endReason;
  CallInfo.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        conversationId = j['conversation_id'],
        callerId = j['caller_id'],
        callerName = j['caller_name'] ?? '',
        calleeId = j['callee_id'],
        calleeName = j['callee_name'] ?? '',
        callerDevice = j['caller_device'] ?? '',
        calleeDevice = j['callee_device'],
        state = j['state'],
        endReason = j['end_reason'];
}

/// Điều khiển cuộc gọi thoại 1-1 (WebRTC).
///
/// Người gọi: lấy micro -> POST /api/calls -> phát tiếng chờ -> khi người nhận nghe (sự kiện
/// "accepted") thì tạo offer. Người nhận: đổ chuông -> bấm Nghe: lấy micro, POST accept, chờ
/// offer rồi trả answer. Ứng viên ICE đến trước khi có remote description được giữ lại.
class CallController extends ChangeNotifier {
  final Api api;
  final String Function() myUserId;
  final String Function() myDeviceId;
  CallController(this.api, this.myUserId, this.myDeviceId);

  CallPhase phase = CallPhase.idle;
  CallInfo? call;
  bool muted = false;
  bool speaker = false;
  DateTime? connectedAt;
  /// Thông báo ngắn sau khi cuộc gọi kết thúc (giao diện hiện rồi xóa).
  String? notice;
  /// Có TURN hay chỉ STUN (để báo người dùng khi kết nối thất bại).
  bool _turn = false;

  RTCPeerConnection? _pc;
  MediaStream? _local;
  final List<RTCIceCandidate> _pendingIce = [];
  bool _remoteSet = false;
  Timer? _ringTimeout;
  Timer? _ticker;
  Timer? _heartbeat;
  final AudioPlayer _tone = AudioPlayer();
  /// Trên web phải gắn luồng âm thanh của bên kia vào một phần tử phát; native tự phát.
  final RTCVideoRenderer remoteRenderer = RTCVideoRenderer();
  bool _rendererReady = false;

  bool get isCaller => call != null && call!.callerId == myUserId();
  String get peerName => call == null ? '' : (isCaller ? call!.calleeName : call!.callerName);
  Duration get elapsed => connectedAt == null ? Duration.zero : DateTime.now().difference(connectedAt!);

  // ------------------------------------------------------------------ Gọi đi
  Future<void> start(String conversationId) async {
    if (phase != CallPhase.idle) throw ApiError(409, 'busy', 'Bạn đang trong một cuộc gọi khác');
    await _ensureMic();
    try {
      final d = await api.startCall(conversationId);
      call = CallInfo.fromJson(d);
      phase = CallPhase.outgoing;
      notifyListeners();
      _startHeartbeat();
      _playTone('sounds/ringback.wav');
      _ringTimeout = Timer(const Duration(seconds: 45), () => end('timeout'));
    } on ApiError catch (e) {
      await _cleanup();
      if (e.status == 409) {
        notice = 'Người nhận đang bận';
        notifyListeners();
        return;
      }
      rethrow;
    }
  }

  // ------------------------------------------------------------------ Nghe / từ chối
  Future<void> accept() async {
    final k = call;
    if (k == null || phase != CallPhase.incoming) return;
    _stopTone();
    try {
      await _ensureMic();
      await _createPc();
      phase = CallPhase.connecting;
      notifyListeners();
      await api.acceptCall(k.id);
      _startHeartbeat();
    } on ApiError catch (e) {
      notice = e.message;
      await _cleanup();
    } catch (e) {
      notice = 'Không mở được micro: $e';
      await end('failed');
    }
  }

  Future<void> decline() => end('reject');

  Future<void> hangup() => end(phase == CallPhase.outgoing ? 'cancel' : 'hangup');

  Future<void> end(String reason) async {
    final k = call;
    await _cleanup();
    if (k != null) {
      try {
        await api.endCall(k.id, reason);
      } catch (_) {}
    }
  }

  void toggleMute() {
    muted = !muted;
    for (final t in _local?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      t.enabled = !muted;
    }
    notifyListeners();
  }

  Future<void> toggleSpeaker() async {
    speaker = !speaker;
    try {
      await Helper.setSpeakerphoneOn(speaker);
    } catch (_) {}
    notifyListeners();
  }

  /// Mở app từ thông báo "Cuộc gọi đến": hỏi máy chủ xem cuộc gọi còn đổ chuông không.
  Future<void> checkActive() async {
    if (phase != CallPhase.idle) return;
    try {
      final d = await api.activeCall();
      if (d != null) onEvent({'event': 'ringing', 'call': d});
    } catch (_) {}
  }

  // ------------------------------------------------------------------ Sự kiện từ máy chủ
  Future<void> onEvent(Map<String, dynamic> ev) async {
    final k = ev['call'] == null ? null : CallInfo.fromJson(Map<String, dynamic>.from(ev['call']));
    switch (ev['event']) {
      case 'ringing':
        if (k == null || k.state != 'ringing') return;
        if (k.calleeId == myUserId() && phase == CallPhase.idle) {
          call = k;
          phase = CallPhase.incoming;
          notifyListeners();
          _playTone('sounds/ring.wav');
        }
      case 'accepted':
        if (k == null || call?.id != k.id) return;
        call = k;
        if (!isCaller && k.calleeDevice != myDeviceId()) {
          // Đã nghe ở thiết bị khác của mình: tắt chuông.
          notice = 'Đã nghe máy ở thiết bị khác';
          await _cleanup();
          return;
        }
        if (isCaller && k.callerDevice == myDeviceId()) {
          _ringTimeout?.cancel();
          _stopTone();
          phase = CallPhase.connecting;
          notifyListeners();
          await _createPc();
          final offer = await _pc!.createOffer({'offerToReceiveAudio': true});
          await _pc!.setLocalDescription(offer);
          await api.callSignal(k.id, 'offer', offer.toMap());
        }
      case 'signal':
        if (call?.id != ev['call_id'] || ev['to_device'] != myDeviceId() || _pc == null) return;
        final data = Map<String, dynamic>.from(ev['data'] ?? {});
        switch (ev['kind']) {
          case 'offer':
            await _pc!.setRemoteDescription(RTCSessionDescription(data['sdp'], data['type']));
            await _flushIce();
            final answer = await _pc!.createAnswer({'offerToReceiveAudio': true});
            await _pc!.setLocalDescription(answer);
            await api.callSignal(call!.id, 'answer', answer.toMap());
          case 'answer':
            await _pc!.setRemoteDescription(RTCSessionDescription(data['sdp'], data['type']));
            await _flushIce();
          case 'ice':
            final c = RTCIceCandidate(data['candidate'], data['sdpMid'], (data['sdpMLineIndex'] as num?)?.toInt());
            if (_remoteSet) {
              await _pc!.addCandidate(c);
            } else {
              _pendingIce.add(c);
            }
        }
      case 'ended':
        if (k == null || call?.id != k.id) return;
        if (phase != CallPhase.idle) {
          notice = switch (k.endReason) {
            'reject' => '${k.calleeName} đã từ chối',
            'timeout' => 'Không có người nghe máy',
            'cancel' => isCaller ? null : 'Cuộc gọi nhỡ từ ${k.callerName}',
            'failed' => 'Không kết nối được cuộc gọi',
            'busy' => 'Người nhận đang bận',
            'dropped' => 'Cuộc gọi bị ngắt do mất kết nối',
            _ => 'Cuộc gọi đã kết thúc',
          };
        }
        await _cleanup();
    }
  }

  // ------------------------------------------------------------------ WebRTC
  Future<void> _ensureMic() async {
    _local ??= await navigator.mediaDevices.getUserMedia({'audio': true, 'video': false});
  }

  Future<void> _createPc() async {
    final ice = await api.iceServers();
    _turn = ice['turn'] == true;
    final pc = await createPeerConnection({'iceServers': ice['iceServers'], 'sdpSemantics': 'unified-plan'});
    _pc = pc;
    _remoteSet = false;
    for (final t in _local!.getTracks()) {
      await pc.addTrack(t, _local!);
    }
    pc.onIceCandidate = (c) {
      final k = call;
      if (k != null && c.candidate != null) api.callSignal(k.id, 'ice', c.toMap()).catchError((_) {});
    };
    pc.onTrack = (e) async {
      if (kIsWeb && e.streams.isNotEmpty) {
        if (!_rendererReady) {
          await remoteRenderer.initialize();
          _rendererReady = true;
        }
        remoteRenderer.srcObject = e.streams.first;
        notifyListeners();
      }
    };
    pc.onConnectionState = (s) {
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected && phase != CallPhase.active) {
        phase = CallPhase.active;
        connectedAt = DateTime.now();
        _ticker = Timer.periodic(const Duration(seconds: 1), (_) => notifyListeners());
        notifyListeners();
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        notice = _turn ? 'Mất kết nối cuộc gọi' : 'Không kết nối được (mạng chặn kết nối trực tiếp, cần cấu hình TURN)';
        end('failed');
      }
    };
  }

  /// Báo máy chủ "còn trong cuộc gọi" mỗi 15 giây; máy tắt đột ngột thì máy chủ tự kết thúc sau 45 giây.
  void _startHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(const Duration(seconds: 15), (_) async {
      final k = call;
      if (k == null) return;
      try {
        final d = await api.callHeartbeat(k.id);
        if (d['state'] == 'ended' && call?.id == k.id) await onEvent({'event': 'ended', 'call': d});
      } catch (_) {}
    });
  }

  Future<void> _flushIce() async {
    _remoteSet = true;
    for (final c in _pendingIce) {
      await _pc?.addCandidate(c);
    }
    _pendingIce.clear();
  }

  void _playTone(String asset) {
    _tone.setReleaseMode(ReleaseMode.loop);
    _tone.play(AssetSource(asset)).catchError((_) {});
  }

  void _stopTone() {
    _tone.stop().catchError((_) {});
  }

  Future<void> _cleanup() async {
    _ringTimeout?.cancel();
    _ticker?.cancel();
    _heartbeat?.cancel();
    _stopTone();
    try {
      await _pc?.close();
    } catch (_) {}
    _pc = null;
    for (final t in _local?.getTracks() ?? <MediaStreamTrack>[]) {
      try {
        await t.stop();
      } catch (_) {}
    }
    try {
      await _local?.dispose();
    } catch (_) {}
    _local = null;
    if (_rendererReady) remoteRenderer.srcObject = null;
    _pendingIce.clear();
    _remoteSet = false;
    phase = CallPhase.idle;
    call = null;
    muted = false;
    speaker = false;
    connectedAt = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _cleanup();
    _tone.dispose();
    if (_rendererReady) remoteRenderer.dispose();
    super.dispose();
  }
}
