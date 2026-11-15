import 'package:flutter/material.dart';

import '../api.dart';
import '../main.dart';
import '../theme.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _user = TextEditingController();
  final _pass = TextEditingController();
  bool _busy = false;
  String? _err;

  Future<void> _submit() async {
    if (_user.text.trim().isEmpty || _pass.text.isEmpty) {
      setState(() => _err = 'Nhập mã nhân viên và mật khẩu');
      return;
    }
    setState(() {
      _busy = true;
      _err = null;
    });
    try {
      await AppScope.read(context).login(_user.text.trim(), _pass.text);
    } on ApiError catch (e) {
      setState(() => _err = e.message);
    } catch (_) {
      setState(() => _err = 'Không kết nối được máy chủ');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final notice = AppScope.of(context).notice;
    return Scaffold(
      backgroundColor: p.canvas,
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 380),
            child: Container(
              padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
              decoration: BoxDecoration(
                color: p.sidebar,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.border),
              ),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(Icons.forum_rounded, size: 44, color: p.primary),
                    const SizedBox(height: 12),
                    Text('Chat Nội Bộ',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: p.textPrimary)),
                    const SizedBox(height: 4),
                    Text('Đăng nhập bằng tài khoản công ty cấp',
                        textAlign: TextAlign.center, style: TextStyle(color: p.textMuted)),
                    const SizedBox(height: 24),
                    if (notice != null) ...[
                      _Banner(text: notice, color: p.warning),
                      const SizedBox(height: 12),
                    ],
                    TextField(
                      key: const Key('login-username'),
                      controller: _user,
                      autofillHints: const [AutofillHints.username],
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(labelText: 'Mã nhân viên', prefixIcon: Icon(Icons.badge_outlined)),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('login-password'),
                      controller: _pass,
                      obscureText: true,
                      autofillHints: const [AutofillHints.password],
                      onSubmitted: (_) => _submit(),
                      decoration: const InputDecoration(labelText: 'Mật khẩu', prefixIcon: Icon(Icons.lock_outline)),
                    ),
                    if (_err != null) ...[
                      const SizedBox(height: 12),
                      Text(_err!, style: TextStyle(color: p.danger)),
                    ],
                    const SizedBox(height: 20),
                    FilledButton(
                      key: const Key('login-submit'),
                      onPressed: _busy ? null : _submit,
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(44)),
                      child: _busy
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('Đăng nhập'),
                    ),
                    const SizedBox(height: 16),
                    Text('Quên mật khẩu? Liên hệ bộ phận IT để được cấp lại.',
                        textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: p.textMuted)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  final String text;
  final Color color;
  const _Banner({required this.text, required this.color});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: color.withValues(alpha: 0.4)),
        ),
        child: Text(text, style: TextStyle(color: context.pal.textPrimary)),
      );
}
