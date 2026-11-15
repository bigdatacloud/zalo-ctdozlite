import 'package:flutter/material.dart';

import 'store.dart';
import 'theme.dart';
import 'ui/home.dart';
import 'ui/login.dart';
import 'ui/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final state = AppState()..boot();
  runApp(AppScope(state: state, child: const ChatApp()));
}

class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);
  static AppState of(BuildContext c) => c.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
  static AppState read(BuildContext c) => c.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}

class ChatApp extends StatelessWidget {
  const ChatApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Chat Nội Bộ',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const PrivacyShield(child: _Gate()),
    );
  }
}

class _Gate extends StatelessWidget {
  const _Gate();
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    if (s.booting) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (s.me == null) return const LoginScreen();
    return const HomeScreen();
  }
}
