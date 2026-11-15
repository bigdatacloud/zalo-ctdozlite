import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../theme.dart';

class Avatar extends StatelessWidget {
  final String name;
  final bool group;
  final double size;
  const Avatar({super.key, required this.name, this.group = false, this.size = 44});

  static const _colors = [
    Color(0xFF0068FF),
    Color(0xFF16A34A),
    Color(0xFFDB2777),
    Color(0xFF9333EA),
    Color(0xFFEA580C),
    Color(0xFF0891B2),
    Color(0xFF65A30D),
  ];

  String get _initials {
    final parts = name.trim().split(RegExp(r'\s+')).where((x) => x.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.characters.first.toUpperCase();
    return (parts[parts.length - 2].characters.first + parts.last.characters.first).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final c = _colors[name.hashCode.abs() % _colors.length];
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c, shape: BoxShape.circle),
      child: group
          ? Icon(Icons.groups_rounded, color: Colors.white, size: size * 0.55)
          : Text(_initials, style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: size * 0.36)),
    );
  }
}

/// Hình mờ lặp chéo tên + mã nhân viên + ngày lên vùng chat.
/// Không chặn được việc chụp màn hình bằng điện thoại khác, nhưng ảnh chụp sẽ mang
/// danh tính người làm lộ — đó là lớp răn đe duy nhất khả thi cho kênh rò rỉ này.
class Watermark extends StatelessWidget {
  final String label;
  final Widget child;
  const Watermark({super.key, required this.label, required this.child});
  @override
  Widget build(BuildContext context) {
    final color = context.pal.textPrimary.withValues(alpha: 0.06);
    return Stack(children: [
      child,
      Positioned.fill(
        child: IgnorePointer(child: CustomPaint(painter: _WatermarkPainter(label, color))),
      ),
    ]);
  }
}

class _WatermarkPainter extends CustomPainter {
  final String label;
  final Color color;
  _WatermarkPainter(this.label, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final tp = TextPainter(
      text: TextSpan(text: label, style: TextStyle(color: color, fontSize: 14, fontWeight: FontWeight.w600)),
      textDirection: TextDirection.ltr,
    )..layout();
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    canvas.rotate(-math.pi / 9);
    final stepX = tp.width + 80, stepY = 90.0;
    for (double y = -size.width; y < size.height + size.width; y += stepY) {
      final shift = ((y / stepY).round() % 2) * stepX / 2;
      for (double x = -size.width; x < size.width * 2; x += stepX) {
        tp.paint(canvas, Offset(x + shift, y));
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_WatermarkPainter old) => old.label != label || old.color != color;
}

/// Che nội dung khi ứng dụng chuyển xuống nền, để ảnh xem trước trong trình chuyển ứng dụng
/// (iOS/Android) không lộ tin nhắn. Trên Android còn có FLAG_SECURE ở tầng native.
class PrivacyShield extends StatefulWidget {
  final Widget child;
  const PrivacyShield({super.key, required this.child});
  @override
  State<PrivacyShield> createState() => _PrivacyShieldState();
}

class _PrivacyShieldState extends State<PrivacyShield> with WidgetsBindingObserver {
  bool _hidden = false;
  bool get _mobile => !kIsWeb && (defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.android);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (!_mobile) return;
    setState(() => _hidden = s != AppLifecycleState.resumed);
  }

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      widget.child,
      if (_hidden)
        Positioned.fill(
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 30, sigmaY: 30),
            child: Container(color: context.pal.canvas.withValues(alpha: 0.9)),
          ),
        ),
    ]);
  }
}

String fmtTime(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  final n = DateTime.now();
  String two(int x) => x.toString().padLeft(2, '0');
  if (d.year == n.year && d.month == n.month && d.day == n.day) return '${two(d.hour)}:${two(d.minute)}';
  return '${two(d.day)}/${two(d.month)}';
}

String fmtClock(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

String fmtSize(int b) {
  if (b < 1024) return '$b B';
  if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(0)} KB';
  return '${(b / 1048576).toStringAsFixed(1)} MB';
}

void toast(BuildContext context, String msg, {bool error = false}) {
  final p = context.pal;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
    content: Text(msg),
    backgroundColor: error ? p.danger : null,
    behavior: SnackBarBehavior.floating,
    width: MediaQuery.sizeOf(context).width > 520 ? 420 : null,
  ));
}
