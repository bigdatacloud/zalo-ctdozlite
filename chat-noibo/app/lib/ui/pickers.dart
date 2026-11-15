import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../main.dart';
import '../theme.dart';
import 'widgets.dart';

Future<UserLite?> pickUser(BuildContext context) => showDialog<UserLite>(
      context: context,
      builder: (_) => const _UserPicker(multi: false),
    ).then((v) => v);

/// Trả về (tên nhóm, danh sách id thành viên).
Future<(String, List<String>)?> createGroupDialog(BuildContext context) =>
    showDialog<(String, List<String>)>(context: context, builder: (_) => const _UserPicker(multi: true));

class _UserPicker extends StatefulWidget {
  final bool multi;
  const _UserPicker({required this.multi});
  @override
  State<_UserPicker> createState() => _UserPickerState();
}

class _UserPickerState extends State<_UserPicker> {
  final _q = TextEditingController();
  final _name = TextEditingController();
  final Map<String, UserLite> _picked = {};
  List<UserLite>? _users;
  String? _err;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final s = AppScope.read(context);
    try {
      final list = await s.api.users(_q.text.trim());
      if (mounted) setState(() => _users = list.where((u) => u.id != s.me?.userId).toList());
    } catch (e) {
      if (mounted) setState(() => _err = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return AlertDialog(
      title: Text(widget.multi ? 'Tạo nhóm' : 'Tin nhắn mới'),
      contentPadding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      content: SizedBox(
        width: 420,
        height: 460,
        child: Column(children: [
          if (widget.multi) ...[
            TextField(controller: _name, decoration: const InputDecoration(labelText: 'Tên nhóm')),
            const SizedBox(height: 6),
            Text('Nhóm do nhân viên tạo không được gửi tệp. Cần nhóm gửi tệp, hãy đề nghị IT tạo nhóm công ty.',
                style: TextStyle(fontSize: 12, color: p.textMuted)),
            const SizedBox(height: 10),
          ],
          TextField(
            controller: _q,
            autofocus: !widget.multi,
            onChanged: (_) {
              _debounce?.cancel();
              _debounce = Timer(const Duration(milliseconds: 250), _load);
            },
            decoration: const InputDecoration(hintText: 'Tìm theo tên, mã nhân viên, bộ phận', prefixIcon: Icon(Icons.search, size: 20)),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: _err != null
                ? Center(child: Text(_err!, style: TextStyle(color: p.danger)))
                : _users == null
                    ? const Center(child: CircularProgressIndicator())
                    : ListView(
                        children: [
                          for (final u in _users!)
                            ListTile(
                              leading: Avatar(name: u.displayName, size: 36),
                              title: Text(u.displayName),
                              subtitle: Text([u.username, if (u.department.isNotEmpty) u.department].join(' · ')),
                              trailing: widget.multi
                                  ? Checkbox(value: _picked.containsKey(u.id), onChanged: (_) => _toggle(u))
                                  : null,
                              onTap: () => widget.multi ? _toggle(u) : Navigator.pop(context, u),
                            ),
                        ],
                      ),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Hủy')),
        if (widget.multi)
          FilledButton(
            onPressed: _name.text.trim().isEmpty || _picked.isEmpty
                ? null
                : () => Navigator.pop(context, (_name.text.trim(), _picked.keys.toList())),
            child: Text('Tạo (${_picked.length})'),
          ),
      ],
    );
  }

  void _toggle(UserLite u) => setState(() => _picked.containsKey(u.id) ? _picked.remove(u.id) : _picked[u.id] = u);
}

/// Chọn nơi chuyển tiếp. Lọc trước theo chính sách để người dùng không phải thử-sai;
/// server vẫn kiểm tra lại.
Future<Conversation?> pickForwardTarget(BuildContext context, {required Conversation source, required Message message}) {
  final s = AppScope.read(context);
  final hasFile = message.file != null;
  final targets = s.conversations.where((c) {
    if (c.id == source.id) return false;
    if (source.managed && !c.managed) return false;
    if (hasFile && !c.policy.canUpload) return false;
    return true;
  }).toList();
  return showDialog<Conversation>(
    context: context,
    builder: (ctx) {
      final p = ctx.pal;
      return AlertDialog(
        title: const Text('Chuyển tiếp tới'),
        content: SizedBox(
          width: 400,
          height: 400,
          child: Column(children: [
            if (source.managed || hasFile)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  source.managed
                      ? 'Tin từ nhóm công ty chỉ được chuyển sang nhóm công ty khác.'
                      : 'Tin có tệp chỉ được chuyển tới nơi được phép gửi tệp.',
                  style: TextStyle(fontSize: 12, color: p.textMuted),
                ),
              ),
            Expanded(
              child: targets.isEmpty
                  ? Center(child: Text('Không có nơi nào được phép chuyển tới', style: TextStyle(color: p.textMuted)))
                  : ListView(children: [
                      for (final c in targets)
                        ListTile(
                          leading: Avatar(name: c.name, group: c.isGroup, size: 36),
                          title: Text(c.name),
                          subtitle: c.managed ? const Text('Nhóm công ty') : null,
                          onTap: () => Navigator.pop(ctx, c),
                        ),
                    ]),
            ),
          ]),
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Hủy'))],
      );
    },
  );
}

Future<void> showMembers(BuildContext context, Conversation conv) async {
  final s = AppScope.read(context);
  await showDialog(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text('Thành viên · ${conv.name}'),
      content: SizedBox(
        width: 400,
        height: 420,
        child: FutureBuilder<List<Map<String, dynamic>>>(
          future: s.api.conversationMembers(conv.id),
          builder: (_, snap) {
            if (snap.hasError) return Center(child: Text('${snap.error}'));
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            return ListView(children: [
              for (final m in snap.data!)
                ListTile(
                  leading: Avatar(name: m['display_name'] ?? '', size: 34),
                  title: Text(m['display_name'] ?? ''),
                  subtitle: Text([m['department'] ?? '', if (m['role'] != 'member') m['role'] == 'owner' ? 'Trưởng nhóm' : 'Phó nhóm']
                      .where((x) => x.isNotEmpty)
                      .join(' · ')),
                ),
            ]);
          },
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Đóng'))],
    ),
  );
}

Future<void> changePasswordDialog(BuildContext context) async {
  final s = AppScope.read(context);
  final oldC = TextEditingController(), newC = TextEditingController(), againC = TextEditingController();
  String? err;
  await showDialog(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, set) => AlertDialog(
        title: const Text('Đổi mật khẩu'),
        content: SizedBox(
          width: 360,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: oldC, obscureText: true, decoration: const InputDecoration(labelText: 'Mật khẩu hiện tại')),
            const SizedBox(height: 10),
            TextField(controller: newC, obscureText: true, decoration: const InputDecoration(labelText: 'Mật khẩu mới (ít nhất 8 ký tự)')),
            const SizedBox(height: 10),
            TextField(controller: againC, obscureText: true, decoration: const InputDecoration(labelText: 'Nhập lại mật khẩu mới')),
            if (err != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(err!, style: TextStyle(color: ctx.pal.danger))),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Hủy')),
          FilledButton(
            onPressed: () async {
              if (newC.text != againC.text) return set(() => err = 'Hai mật khẩu mới không khớp');
              try {
                await s.api.changePassword(oldC.text, newC.text);
                await s.reloadMe();
                if (ctx.mounted) Navigator.pop(ctx);
                if (context.mounted) toast(context, 'Đã đổi mật khẩu');
              } catch (e) {
                set(() => err = '$e');
              }
            },
            child: const Text('Lưu'),
          ),
        ],
      ),
    ),
  );
}
