import 'package:chat_noibo/main.dart';
import 'package:chat_noibo/store.dart';
import 'package:chat_noibo/ui/login.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('chưa đăng nhập thì hiện màn hình đăng nhập', (tester) async {
    final state = AppState()..booting = false;
    await tester.pumpWidget(AppScope(state: state, child: const ChatApp()));
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.text('Chat Nội Bộ'), findsOneWidget);
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pump();
    expect(find.text('Nhập mã nhân viên và mật khẩu'), findsOneWidget);
  });
}
