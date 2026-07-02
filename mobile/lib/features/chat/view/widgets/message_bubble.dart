import 'package:flutter/material.dart';

/// A chat bubble: user messages right-aligned/primary, assistant left/surface.
class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.text, required this.isUser});

  final String text;
  final bool isUser;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 12),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
        decoration: BoxDecoration(
          color: isUser ? scheme.primary : scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(16),
        ),
        child: SelectableText(
          text,
          style: TextStyle(color: isUser ? scheme.onPrimary : scheme.onSurface, height: 1.35),
        ),
      ),
    );
  }
}
