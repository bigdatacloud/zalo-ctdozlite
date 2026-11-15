import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../call.dart';
import '../main.dart';
import '../theme.dart';
import 'widgets.dart';

/// Lớp phủ cuộc gọi, nằm trên mọi màn hình (đặt trong MaterialApp.builder).
class CallLayer extends StatefulWidget {
  final Widget child;
  const CallLayer({super.key, required this.child});
  @override
  State<CallLayer> createState() => _CallLayerState();
}

class _CallLayerState extends State<CallLayer> {
  CallController? _calls;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final c = AppScope.read(context).calls;
    if (_calls != c) {
      _calls?.removeListener(_changed);
      _calls = c..addListener(_changed);
    }
  }

  @override
  void dispose() {
    _calls?.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    final c = _calls!;
    final n = c.notice;
    if (n != null) {
      c.notice = null;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final m = ScaffoldMessenger.maybeOf(context);
        m?.showSnackBar(SnackBar(content: Text(n), behavior: SnackBarBehavior.floating));
      });
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final c = _calls!;
    return Stack(children: [
      widget.child,
      if (c.phase != CallPhase.idle) Positioned.fill(child: _CallScreen(c: c)),
    ]);
  }
}

class _CallScreen extends StatelessWidget {
  final CallController c;
  const _CallScreen({required this.c});

  String _status() => switch (c.phase) {
        CallPhase.outgoing => 'Đang gọi…',
        CallPhase.incoming => 'Cuộc gọi thoại đến',
        CallPhase.connecting => 'Đang kết nối…',
        CallPhase.active => _fmt(c.elapsed),
        CallPhase.idle => '',
      };

  static String _fmt(Duration d) {
    String two(int x) => x.toString().padLeft(2, '0');
    return d.inHours > 0 ? '${d.inHours}:${two(d.inMinutes % 60)}:${two(d.inSeconds % 60)}' : '${two(d.inMinutes)}:${two(d.inSeconds % 60)}';
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final mobile = !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS);
    return Material(
      color: const Color(0xFF0F172A),
      child: SafeArea(
        child: Column(children: [
          // Trình duyệt cần một phần tử phát âm thanh của bên kia; kích thước 0 nên không thấy.
          if (kIsWeb) SizedBox(width: 1, height: 1, child: RTCVideoView(c.remoteRenderer)),
          const Spacer(flex: 2),
          Avatar(name: c.peerName, size: 112),
          const SizedBox(height: 20),
          Text(c.peerName, style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Text(_status(), key: const Key('call-status'), style: TextStyle(color: Colors.white.withValues(alpha: 0.75), fontSize: 16)),
          const Spacer(flex: 3),
          if (c.phase == CallPhase.incoming)
            Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
              _RoundButton(icon: Icons.call_end, color: p.danger, label: 'Từ chối', onTap: c.decline, keyName: 'call-decline'),
              _RoundButton(icon: Icons.call, color: p.online, label: 'Nghe', onTap: c.accept, keyName: 'call-accept'),
            ])
          else
            Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
              _RoundButton(
                icon: c.muted ? Icons.mic_off : Icons.mic,
                color: c.muted ? Colors.white : Colors.white24,
                iconColor: c.muted ? const Color(0xFF0F172A) : Colors.white,
                label: c.muted ? 'Bật mic' : 'Tắt mic',
                onTap: c.toggleMute,
              ),
              if (mobile)
                _RoundButton(
                  icon: c.speaker ? Icons.volume_up : Icons.hearing,
                  color: c.speaker ? Colors.white : Colors.white24,
                  iconColor: c.speaker ? const Color(0xFF0F172A) : Colors.white,
                  label: c.speaker ? 'Loa ngoài' : 'Loa trong',
                  onTap: c.toggleSpeaker,
                ),
              _RoundButton(icon: Icons.call_end, color: p.danger, label: 'Kết thúc', onTap: c.hangup, keyName: 'call-hangup'),
            ]),
          const SizedBox(height: 48),
        ]),
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  final IconData icon;
  final Color color;
  final Color iconColor;
  final String label;
  final VoidCallback onTap;
  final String? keyName;
  const _RoundButton({required this.icon, required this.color, required this.label, required this.onTap, this.iconColor = Colors.white, this.keyName});

  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, children: [
        Material(
          color: color,
          shape: const CircleBorder(),
          child: InkWell(
            key: keyName == null ? null : Key(keyName!),
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: SizedBox(width: 68, height: 68, child: Icon(icon, color: iconColor, size: 30)),
          ),
        ),
        const SizedBox(height: 8),
        Text(label, style: const TextStyle(color: Colors.white70, fontSize: 13)),
      ]);
}
