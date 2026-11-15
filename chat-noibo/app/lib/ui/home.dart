import 'package:flutter/material.dart';

import '../api.dart';
import '../main.dart';
import '../store.dart';
import '../theme.dart';
import 'chat.dart';
import 'pickers.dart';
import 'widgets.dart';

const double kSplitBreakpoint = 760;

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _filter = TextEditingController();

  Future<void> _openConv(String id, bool split) async {
    final s = AppScope.read(context);
    s.open(id).catchError((e) {
      if (mounted) toast(context, '$e', error: true);
    });
    if (!split) {
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChatPage(convId: id)));
      s.close();
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final p = context.pal;
    final split = MediaQuery.sizeOf(context).width >= kSplitBreakpoint;
    final sidebar = _Sidebar(
      filter: _filter,
      selectedId: split ? s.activeId : null,
      onOpen: (id) => _openConv(id, split),
    );
    if (!split) return Scaffold(body: SafeArea(child: sidebar));
    return Scaffold(
      body: Row(children: [
        SizedBox(width: 340, child: sidebar),
        VerticalDivider(width: 1, color: p.border),
        Expanded(
          child: s.activeId == null
              ? Container(
                  color: p.canvas,
                  alignment: Alignment.center,
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Icon(Icons.forum_outlined, size: 56, color: p.textMuted),
                    const SizedBox(height: 12),
                    Text('Chọn một hội thoại để bắt đầu', style: TextStyle(color: p.textSecondary)),
                  ]),
                )
              : ChatPane(key: ValueKey(s.activeId), convId: s.activeId!, embedded: true),
        ),
      ]),
    );
  }
}

class _Sidebar extends StatefulWidget {
  final TextEditingController filter;
  final String? selectedId;
  final void Function(String id) onOpen;
  const _Sidebar({required this.filter, required this.selectedId, required this.onOpen});
  @override
  State<_Sidebar> createState() => _SidebarState();
}

class _SidebarState extends State<_Sidebar> {
  Future<void> _newChat() async {
    final s = AppScope.read(context);
    final u = await pickUser(context);
    if (u == null) return;
    try {
      final c = await s.openDm(u.id);
      if (c != null) widget.onOpen(c.id);
    } catch (e) {
      if (mounted) toast(context, '$e', error: true);
    }
  }

  Future<void> _newGroup() async {
    final s = AppScope.read(context);
    final r = await createGroupDialog(context);
    if (r == null) return;
    try {
      final c = await s.createGroup(r.$1, r.$2);
      if (c != null) widget.onOpen(c.id);
    } catch (e) {
      if (mounted) toast(context, '$e', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final p = context.pal;
    final q = widget.filter.text.trim().toLowerCase();
    final list = s.conversations.where((c) => q.isEmpty || c.name.toLowerCase().contains(q)).toList();
    return Container(
      color: p.sidebar,
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
          child: Row(children: [
            Stack(children: [
              Avatar(name: s.me!.displayName, size: 38),
              Positioned(
                right: 0,
                bottom: 0,
                child: Container(
                  width: 11,
                  height: 11,
                  decoration: BoxDecoration(
                    color: s.online ? p.online : p.textMuted,
                    shape: BoxShape.circle,
                    border: Border.all(color: p.sidebar, width: 2),
                  ),
                ),
              ),
            ]),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(s.me!.displayName,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, color: p.textPrimary)),
                Text(s.online ? s.me!.username : 'Đang kết nối lại…',
                    style: TextStyle(fontSize: 12, color: s.online ? p.textMuted : p.warning)),
              ]),
            ),
            IconButton(tooltip: 'Tin nhắn mới', onPressed: _newChat, icon: const Icon(Icons.edit_square)),
            PopupMenuButton<String>(
              tooltip: 'Tùy chọn',
              onSelected: (v) async {
                if (v == 'group') _newGroup();
                if (v == 'password') changePasswordDialog(context);
                if (v == 'logout') AppScope.read(context).logout();
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'group', child: ListTile(leading: Icon(Icons.group_add_outlined), title: Text('Tạo nhóm'))),
                PopupMenuItem(value: 'password', child: ListTile(leading: Icon(Icons.key_outlined), title: Text('Đổi mật khẩu'))),
                PopupMenuItem(value: 'logout', child: ListTile(leading: Icon(Icons.logout), title: Text('Đăng xuất'))),
              ],
            ),
          ]),
        ),
        if (s.me!.mustChangePassword)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Material(
              color: p.warning.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(8),
              child: ListTile(
                dense: true,
                leading: Icon(Icons.info_outline, color: p.warning),
                title: const Text('Hãy đổi mật khẩu được cấp ban đầu'),
                onTap: () => changePasswordDialog(context),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
          child: TextField(
            controller: widget.filter,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(hintText: 'Tìm hội thoại', prefixIcon: Icon(Icons.search, size: 20)),
          ),
        ),
        Divider(height: 1, color: p.border),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () => s.refreshConversations(),
            child: list.isEmpty
                ? ListView(children: [
                    const SizedBox(height: 80),
                    Center(child: Text('Chưa có hội thoại', style: TextStyle(color: p.textMuted))),
                  ])
                : ListView.builder(
                    itemCount: list.length,
                    itemBuilder: (_, i) => _ConvTile(
                      conv: list[i],
                      meId: s.me!.userId,
                      selected: list[i].id == widget.selectedId,
                      onTap: () => widget.onOpen(list[i].id),
                    ),
                  ),
          ),
        ),
      ]),
    );
  }
}

class _ConvTile extends StatelessWidget {
  final Conversation conv;
  final String meId;
  final bool selected;
  final VoidCallback onTap;
  const _ConvTile({required this.conv, required this.meId, required this.selected, required this.onTap});

  String _preview() {
    final m = conv.lastMessage;
    if (m == null) return conv.managed ? 'Nhóm công ty quản lý' : '';
    if (m.recalled) return 'Tin nhắn đã được thu hồi';
    final who = m.senderId == meId ? 'Bạn: ' : (conv.isGroup && m.kind != 'system' ? '${m.senderName.split(' ').last}: ' : '');
    if (m.kind == 'image') return '$who[Hình ảnh]';
    if (m.kind == 'file') return '$who[Tệp] ${m.file?.name ?? ''}';
    return '$who${m.text}';
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final unread = conv.unread;
    return Material(
      color: selected ? p.selected : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        hoverColor: p.hover,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(children: [
            Avatar(name: conv.name, group: conv.isGroup),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  if (conv.managed) ...[
                    Tooltip(message: 'Nhóm công ty quản lý', child: Icon(Icons.verified_user, size: 15, color: p.primary)),
                    const SizedBox(width: 4),
                  ],
                  Expanded(
                    child: Text(conv.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            color: p.textPrimary, fontWeight: unread > 0 ? FontWeight.w700 : FontWeight.w500, fontSize: 15)),
                  ),
                  if (conv.lastMsgAt > 0)
                    Text(fmtTime(conv.lastMsgAt), style: TextStyle(fontSize: 12, color: p.textMuted)),
                ]),
                const SizedBox(height: 3),
                Row(children: [
                  Expanded(
                    child: Text(_preview(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 13,
                            color: unread > 0 ? p.textPrimary : p.textMuted,
                            fontWeight: unread > 0 ? FontWeight.w600 : FontWeight.normal)),
                  ),
                  if (unread > 0)
                    Container(
                      margin: const EdgeInsets.only(left: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(color: p.danger, borderRadius: BorderRadius.circular(10)),
                      child: Text(unread > 99 ? '99+' : '$unread',
                          style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
                    ),
                ]),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Dùng cho bố cục điện thoại: hội thoại mở thành một trang riêng.
class ChatPage extends StatelessWidget {
  final String convId;
  const ChatPage({super.key, required this.convId});
  @override
  Widget build(BuildContext context) => Scaffold(body: SafeArea(child: ChatPane(convId: convId, embedded: false)));
}

String platformLabel() => switch (currentPlatform()) {
      'windows' => 'Windows',
      'android' => 'Android',
      'ios' => 'iPhone',
      _ => 'Trình duyệt',
    };
