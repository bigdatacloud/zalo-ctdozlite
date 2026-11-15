import 'package:flutter/material.dart';

/// Bảng màu kế thừa từ ctdozlite (src/gui/theme.rs): nền xám-xanh kiểu Zalo PC ở chế độ sáng,
/// Atom One Dark ở chế độ tối.
class Palette extends ThemeExtension<Palette> {
  final Color sidebar, canvas, hover, selected, input, border;
  final Color textPrimary, textSecondary, textMuted, primary, danger, warning, online, external;
  final Color bubbleOut, bubbleOutText, bubbleIn, bubbleInText, bubbleInBorder, meta;
  const Palette({
    required this.sidebar,
    required this.canvas,
    required this.hover,
    required this.selected,
    required this.input,
    required this.border,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.primary,
    required this.danger,
    required this.warning,
    required this.online,
    required this.external,
    required this.bubbleOut,
    required this.bubbleOutText,
    required this.bubbleIn,
    required this.bubbleInText,
    required this.bubbleInBorder,
    required this.meta,
  });

  static const light = Palette(
    sidebar: Color(0xFFFFFFFF),
    canvas: Color(0xFFEBF0F7),
    hover: Color(0xFFF1F5F9),
    selected: Color(0xFFE5F1FF),
    input: Color(0xFFF8FAFC),
    border: Color(0xFFE2E8F0),
    textPrimary: Color(0xFF0F172A),
    textSecondary: Color(0xFF475569),
    textMuted: Color(0xFF64748B),
    primary: Color(0xFF0068FF),
    danger: Color(0xFFDC2626),
    warning: Color(0xFFB45309),
    online: Color(0xFF16A34A),
    external: Color(0xFF9333EA),
    bubbleOut: Color(0xFFDBEBFF),
    bubbleOutText: Color(0xFF0F172A),
    bubbleIn: Color(0xFFFFFFFF),
    bubbleInText: Color(0xFF0F172A),
    bubbleInBorder: Color(0xFFE2E8F0),
    meta: Color(0xFF64748B),
  );

  static const dark = Palette(
    sidebar: Color(0xFF21252B),
    canvas: Color(0xFF282C34),
    hover: Color(0xFF323842),
    selected: Color(0xFF3A3F4B),
    input: Color(0xFF1D1F23),
    border: Color(0xFF343942),
    textPrimary: Color(0xFFD7DAE0),
    textSecondary: Color(0xFFABB2BF),
    textMuted: Color(0xFF8E96A5),
    primary: Color(0xFF528BFF),
    danger: Color(0xFFE06C75),
    warning: Color(0xFFE5C07B),
    online: Color(0xFF98C379),
    external: Color(0xFFC678DD),
    bubbleOut: Color(0xFF25374D),
    bubbleOutText: Color(0xFFEBF0F6),
    bubbleIn: Color(0xFF323842),
    bubbleInText: Color(0xFFD7DAE0),
    bubbleInBorder: Color(0xFF3E4451),
    meta: Color(0xFF9AABC0),
  );

  @override
  Palette copyWith() => this;
  @override
  Palette lerp(Palette? other, double t) => t < 0.5 ? this : (other ?? this);
}

ThemeData buildTheme(Brightness b) {
  final p = b == Brightness.light ? Palette.light : Palette.dark;
  final base = ThemeData(
    brightness: b,
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: p.primary, brightness: b, primary: p.primary, surface: p.sidebar),
    scaffoldBackgroundColor: p.sidebar,
    dividerColor: p.border,
    extensions: [p],
  );
  return base.copyWith(
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.input,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide(color: p.border)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide(color: p.border)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide(color: p.primary, width: 1.5)),
    ),
  );
}

extension PaletteX on BuildContext {
  Palette get pal => Theme.of(this).extension<Palette>()!;
}
