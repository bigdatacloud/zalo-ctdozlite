import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../main.dart';
import '../theme.dart';
import 'pickers.dart';
import 'widgets.dart';

/// Bộ nhớ đệm ảnh trong RAM (không ghi đĩa), giới hạn số lượng.
class _ImageCache {
  static final Map<String, Future<FileBlob>> _m = {};
  static Future<FileBlob> get(Api api, String id) {
    if (_m.length > 200) _m.remove(_m.keys.first);
    return _m.putIfAbsent(id, () => api.file(id));
  }
}

class ChatPane extends StatefulWidget {
  final String convId;
  final bool embedded;
  const ChatPane({super.key, required this.convId, required this.embedded});
  @override
  State<ChatPane> createState() => _ChatPaneState();
}

class _ChatPaneState extends State<ChatPane> {
  final _text = TextEditingController();
  final _focus = FocusNode();
  final _scroll = ScrollController();
  bool _sending = false;
  bool _loadingOlder = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() async {
      if (_loadingOlder) return;
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 300) {
        _loadingOlder = true;
        await AppScope.read(context).loadOlder(widget.convId).catchError((_) {});
        _loadingOlder = false;
      }
    });
    _focus.onKeyEvent = (node, e) {
      // Desktop: Enter gửi, Shift+Enter xuống dòng.
      if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.enter && !HardwareKeyboard.instance.isShiftPressed) {
        _send();
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    };
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final t = _text.text.trim();
    if (t.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await AppScope.read(context).sendText(widget.convId, t);
      _text.clear();
    } catch (e) {
      if (mounted) toast(context, '$e', error: true);
    } finally {
      if (mounted) setState(() => _sending = false);
      _focus.requestFocus();
    }
  }

  Future<void> _attach() async {
    final s = AppScope.read(context);
    final f = await FilePicker.pickFile();
    if (f == null) return;
    setState(() => _sending = true);
    try {
      final bytes = await f.readAsBytes();
      await s.sendFile(widget.convId, f.name, _mimeOf(f.name), bytes);
    } catch (e) {
      if (mounted) toast(context, '$e', error: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _onAction(String action, Message m, Conversation c) async {
    final s = AppScope.read(context);
    try {
      switch (action) {
        case 'copy':
          await Clipboard.setData(ClipboardData(text: m.text));
          if (mounted) toast(context, 'Đã sao chép');
        case 'forward':
          final target = await pickForwardTarget(context, source: c, message: m);
          if (target == null) return;
          await s.forward(m, target.id);
          if (mounted) toast(context, 'Đã chuyển tiếp tới ${target.name}');
        case 'recall':
          await s.recall(m);
      }
    } catch (e) {
      if (mounted) toast(context, '$e', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final p = context.pal;
    final c = s.conv(widget.convId);
    if (c == null) return Container(color: p.canvas);
    final msgs = s.messages[widget.convId];
    final me = s.me!;
    final today = DateTime.now();
    final wm = '${me.displayName} · ${me.username} · ${today.day}/${today.month}/${today.year}';

    return Column(children: [
      _Header(conv: c, embedded: widget.embedded),
      Divider(height: 1, color: p.border),
      Expanded(
        child: Container(
          color: p.canvas,
          child: Watermark(
            label: wm,
            child: msgs == null
                ? const Center(child: CircularProgressIndicator())
                : ListView.builder(
                    controller: _scroll,
                    reverse: true,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                    itemCount: msgs.length,
                    itemBuilder: (_, i) {
                      final m = msgs[msgs.length - 1 - i];
                      final prev = i + 1 < msgs.length ? msgs[msgs.length - 2 - i] : null;
                      final showName = c.isGroup && m.senderId != me.userId && (prev == null || prev.senderId != m.senderId || prev.kind == 'system');
                      return _Bubble(
                        key: ValueKey(m.id),
                        msg: m,
                        mine: m.senderId == me.userId,
                        showName: showName,
                        policy: c.policy,
                        onAction: (a) => _onAction(a, m, c),
                      );
                    },
                  ),
          ),
        ),
      ),
      Divider(height: 1, color: p.border),
      _Composer(
        controller: _text,
        focus: _focus,
        sending: _sending,
        conv: c,
        onSend: _send,
        onAttach: _attach,
      ),
    ]);
  }
}

class _Header extends StatelessWidget {
  final Conversation conv;
  final bool embedded;
  const _Header({required this.conv, required this.embedded});

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final pol = conv.policy;
    final chips = <Widget>[
      if (conv.external)
        _chip(context, Icons.public, 'Có người bên ngoài · ${conv.organization}', p.external)
      else if (conv.managed)
        _chip(context, Icons.verified_user, 'Nhóm công ty', p.primary),
      _chip(context, pol.canUpload ? Icons.attach_file : Icons.block, pol.canUpload ? 'Được gửi tệp' : 'Cấm gửi tệp',
          pol.canUpload ? p.online : p.textMuted),
      if (!pol.canForwardOut) _chip(context, Icons.forward_to_inbox, 'Cấm chuyển tiếp', p.warning),
      if (!pol.canCopy) _chip(context, Icons.content_copy, 'Cấm sao chép', p.warning),
    ];
    return Container(
      color: p.sidebar,
      padding: EdgeInsets.fromLTRB(embedded ? 16 : 4, 10, 12, 10),
      child: Row(children: [
        if (!embedded) const BackButton(),
        Avatar(name: conv.name, group: conv.isGroup, size: 40),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(conv.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16, color: p.textPrimary)),
            const SizedBox(height: 4),
            Wrap(spacing: 6, runSpacing: 4, children: chips),
          ]),
        ),
        if (conv.isGroup)
          IconButton(
            tooltip: 'Thành viên',
            icon: const Icon(Icons.people_alt_outlined),
            onPressed: () => showMembers(context, conv),
          ),
      ]),
    );
  }

  Widget _chip(BuildContext context, IconData icon, String label, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 12, color: color),
          const SizedBox(width: 3),
          Text(label, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600)),
        ]),
      );
}

class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focus;
  final bool sending;
  final Conversation conv;
  final VoidCallback onSend, onAttach;
  const _Composer({
    required this.controller,
    required this.focus,
    required this.sending,
    required this.conv,
    required this.onSend,
    required this.onAttach,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final canUpload = conv.policy.canUpload;
    return Container(
      color: p.sidebar,
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Tooltip(
          message: canUpload
              ? 'Gửi tệp hoặc ảnh'
              : conv.isGroup
                  ? 'Chỉ nhóm do công ty quản lý mới được gửi tệp'
                  : 'Không được gửi tệp trong tin nhắn cá nhân',
          child: IconButton(
            key: const Key('attach'),
            onPressed: canUpload && !sending ? onAttach : null,
            icon: Icon(canUpload ? Icons.attach_file : Icons.attach_file_outlined),
          ),
        ),
        Expanded(
          child: TextField(
            key: const Key('composer'),
            controller: controller,
            focusNode: focus,
            minLines: 1,
            maxLines: 6,
            textInputAction: TextInputAction.newline,
            decoration: InputDecoration(hintText: 'Nhập tin nhắn tới ${conv.name}'),
          ),
        ),
        const SizedBox(width: 6),
        IconButton.filled(
          key: const Key('send'),
          onPressed: sending ? null : onSend,
          icon: sending
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.send_rounded),
        ),
      ]),
    );
  }
}

class _Bubble extends StatelessWidget {
  final Message msg;
  final bool mine, showName;
  final Policy policy;
  final void Function(String action) onAction;
  const _Bubble({super.key, required this.msg, required this.mine, required this.showName, required this.policy, required this.onAction});

  Future<void> _menu(BuildContext context, Offset pos) async {
    if (msg.recalled || msg.kind == 'system') return;
    final canRecall = mine && DateTime.now().millisecondsSinceEpoch - msg.createdAt < 24 * 3600 * 1000;
    final items = <PopupMenuEntry<String>>[
      if (policy.canCopy && msg.text.isNotEmpty)
        const PopupMenuItem(value: 'copy', child: ListTile(dense: true, leading: Icon(Icons.copy), title: Text('Sao chép'))),
      PopupMenuItem(
        value: 'forward',
        enabled: policy.canForwardOut,
        child: ListTile(
          dense: true,
          leading: const Icon(Icons.shortcut),
          title: const Text('Chuyển tiếp'),
          subtitle: policy.canForwardOut ? null : const Text('Nhóm này cấm chuyển tiếp'),
        ),
      ),
      if (canRecall)
        const PopupMenuItem(value: 'recall', child: ListTile(dense: true, leading: Icon(Icons.undo), title: Text('Thu hồi'))),
    ];
    final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final v = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(pos & const Size(1, 1), Offset.zero & overlay.size),
      items: items,
    );
    if (v != null) onAction(v);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    if (msg.kind == 'system') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(color: p.sidebar.withValues(alpha: 0.7), borderRadius: BorderRadius.circular(10)),
            child: Text(msg.text, style: TextStyle(fontSize: 12, color: p.textMuted)),
          ),
        ),
      );
    }
    final bg = mine ? p.bubbleOut : p.bubbleIn;
    final fg = mine ? p.bubbleOutText : p.bubbleInText;
    final maxW = (MediaQuery.sizeOf(context).width * 0.72).clamp(200.0, 560.0);

    Widget body;
    if (msg.recalled) {
      body = Text('Tin nhắn đã được thu hồi', style: TextStyle(color: p.textMuted, fontStyle: FontStyle.italic));
    } else if (msg.file != null && msg.file!.isImage) {
      body = _ImageThumb(file: msg.file!, policy: policy);
    } else if (msg.file != null) {
      body = _FileCard(file: msg.file!, policy: policy, fg: fg);
    } else {
      body = policy.canCopy
          ? SelectableText(msg.text, style: TextStyle(color: fg, fontSize: 15, height: 1.35))
          : Text(msg.text, style: TextStyle(color: fg, fontSize: 15, height: 1.35));
    }

    return Padding(
      padding: EdgeInsets.only(top: showName ? 10 : 3),
      child: Column(
        crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          if (showName)
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 2),
              child: Text.rich(TextSpan(children: [
                TextSpan(text: msg.senderName),
                if (msg.senderExternal) TextSpan(text: '  ${msg.senderOrg}', style: TextStyle(color: p.external)),
              ]), style: TextStyle(fontSize: 12, color: p.textMuted, fontWeight: FontWeight.w600)),
            ),
          GestureDetector(
            onSecondaryTapDown: (d) => _menu(context, d.globalPosition),
            onLongPressStart: (d) => _menu(context, d.globalPosition),
            child: Container(
              constraints: BoxConstraints(maxWidth: maxW),
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
              decoration: BoxDecoration(
                color: bg,
                borderRadius: BorderRadius.circular(12),
                border: mine ? null : Border.all(color: p.bubbleInBorder),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                if (msg.forwarded && !msg.recalled)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(Icons.shortcut, size: 13, color: p.meta),
                      const SizedBox(width: 3),
                      Text('Đã chuyển tiếp', style: TextStyle(fontSize: 11, color: p.meta, fontStyle: FontStyle.italic)),
                    ]),
                  ),
                body,
                if (msg.text.isNotEmpty && msg.file != null && !msg.recalled)
                  Padding(padding: const EdgeInsets.only(top: 6), child: Text(msg.text, style: TextStyle(color: fg))),
                const SizedBox(height: 3),
                Text(fmtClock(msg.createdAt), style: TextStyle(fontSize: 11, color: p.meta)),
              ]),
            ),
          ),
        ],
      ),
    );
  }
}

class _ImageThumb extends StatelessWidget {
  final FileRef file;
  final Policy policy;
  const _ImageThumb({required this.file, required this.policy});

  @override
  Widget build(BuildContext context) {
    final s = AppScope.read(context);
    if (policy.fileAccess == 'deny') return _denied(context);
    return FutureBuilder<FileBlob>(
      future: _ImageCache.get(s.api, file.id),
      builder: (context, snap) {
        if (snap.hasError) return _denied(context, '${snap.error}');
        if (!snap.hasData) return const SizedBox(width: 220, height: 160, child: Center(child: CircularProgressIndicator()));
        return GestureDetector(
          onTap: () => openImageViewer(context, file, snap.data!.bytes, policy),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 300, maxWidth: 360),
              child: Image.memory(snap.data!.bytes, fit: BoxFit.cover, gaplessPlayback: true),
            ),
          ),
        );
      },
    );
  }

  Widget _denied(BuildContext context, [String? why]) {
    final p = context.pal;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(Icons.image_not_supported_outlined, color: p.textMuted),
      const SizedBox(width: 8),
      Flexible(child: Text(why ?? 'Thiết bị này không được mở ảnh', style: TextStyle(color: p.textMuted))),
    ]);
  }
}

class _FileCard extends StatelessWidget {
  final FileRef file;
  final Policy policy;
  final Color fg;
  const _FileCard({required this.file, required this.policy, required this.fg});

  Future<void> _open(BuildContext context) async {
    final s = AppScope.read(context);
    try {
      if (file.isText) {
        final blob = await s.api.file(file.id);
        if (!context.mounted) return;
        await showDialog(
          context: context,
          builder: (_) => AlertDialog(
            title: Text(file.name),
            content: SizedBox(
              width: 640,
              height: 420,
              child: Watermark(
                label: '${s.me!.displayName} · ${s.me!.username}',
                child: SingleChildScrollView(
                  child: policy.canCopy
                      ? SelectableText(utf8.decode(blob.bytes, allowMalformed: true))
                      : Text(utf8.decode(blob.bytes, allowMalformed: true)),
                ),
              ),
            ),
            actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Đóng'))],
          ),
        );
      } else if (policy.fileAccess == 'allow') {
        await _save(context);
      } else {
        toast(context, 'Tệp này chỉ được xem trong ứng dụng. Bản hiện tại xem được ảnh và văn bản; '
            'loại tệp khác cần mở trên máy được cấp quyền lưu.');
      }
    } catch (e) {
      if (context.mounted) toast(context, '$e', error: true);
    }
  }

  Future<void> _save(BuildContext context) async {
    final s = AppScope.read(context);
    final blob = await s.api.file(file.id, save: true);
    final path = await FilePicker.saveFile(fileName: file.name, bytes: blob.bytes, mimeType: file.mime);
    if (context.mounted && path != null) toast(context, 'Đã lưu tệp');
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return InkWell(
      onTap: () => _open(context),
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(color: p.canvas.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(8)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.description_outlined, size: 34, color: p.primary),
          const SizedBox(width: 10),
          Flexible(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(file.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: fg, fontWeight: FontWeight.w600)),
              Text(
                '${fmtSize(file.size)} · ${switch (policy.fileAccess) {
                  'allow' => 'Bấm để lưu',
                  'view' => 'Chỉ xem',
                  _ => 'Bị chặn trên thiết bị này',
                }}',
                style: TextStyle(fontSize: 12, color: p.meta),
              ),
            ]),
          ),
          if (policy.fileAccess == 'allow' && file.isText)
            IconButton(tooltip: 'Lưu về máy', onPressed: () => _save(context), icon: const Icon(Icons.download)),
        ]),
      ),
    );
  }
}

void openImageViewer(BuildContext context, FileRef file, Uint8List bytes, Policy policy) {
  final s = AppScope.read(context);
  showDialog(
    context: context,
    barrierColor: Colors.black87,
    builder: (ctx) => Dialog.fullscreen(
      backgroundColor: Colors.black,
      child: Stack(children: [
        Positioned.fill(
          child: Watermark(
            label: '${s.me!.displayName} · ${s.me!.username}',
            child: InteractiveViewer(maxScale: 6, child: Center(child: Image.memory(bytes))),
          ),
        ),
        Positioned(
          top: 8,
          right: 8,
          child: Row(children: [
            if (policy.fileAccess == 'allow')
              IconButton(
                color: Colors.white,
                tooltip: 'Lưu về máy',
                icon: const Icon(Icons.download),
                onPressed: () async {
                  try {
                    final blob = await s.api.file(file.id, save: true);
                    await FilePicker.saveFile(fileName: file.name, bytes: blob.bytes, mimeType: file.mime);
                  } catch (e) {
                    if (ctx.mounted) toast(ctx, '$e', error: true);
                  }
                },
              ),
            IconButton(color: Colors.white, tooltip: 'Đóng', icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
          ]),
        ),
      ]),
    ),
  );
}

String _mimeOf(String name) {
  final ext = name.split('.').last.toLowerCase();
  return const {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'heic': 'image/heic',
        'txt': 'text/plain',
        'csv': 'text/csv',
        'json': 'application/json',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'zip': 'application/zip',
        'dwg': 'application/acad',
      }[ext] ??
      'application/octet-stream';
}
