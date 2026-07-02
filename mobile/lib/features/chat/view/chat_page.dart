import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/injection.dart';
import '../bloc/chat_bloc.dart';
import '../bloc/chat_event.dart';
import '../bloc/chat_state.dart';
import '../data/chat_models.dart';
import 'widgets/message_bubble.dart';
import 'widgets/typing_indicator.dart';

@RoutePage()
class ChatPage extends StatelessWidget {
  const ChatPage({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => getIt<ChatBloc>(),
      child: const _ChatView(),
    );
  }
}

class _ChatView extends StatefulWidget {
  const _ChatView();

  @override
  State<_ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<_ChatView> {
  final _input = TextEditingController();
  final _scroll = ScrollController();

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    context.read<ChatBloc>().add(SendMessage(text));
    _input.clear();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      // Only follow the stream if the user is already near the bottom — don't
      // yank them down while they've scrolled up to re-read earlier answers.
      final pos = _scroll.position;
      if (pos.maxScrollExtent - pos.pixels > 80) return;
      _scroll.animateTo(
        pos.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Chat with Your Business')),
      body: Column(
        children: [
          Expanded(
            child: BlocConsumer<ChatBloc, ChatState>(
              listenWhen: (prev, next) =>
                  next.streamingAnswer != prev.streamingAnswer ||
                  next.messages.length != prev.messages.length ||
                  (next.status == ChatStatus.error &&
                      prev.status != ChatStatus.error),
              listener: (context, state) {
                _scrollToBottom();
                if (state.status == ChatStatus.error && state.error != null) {
                  ScaffoldMessenger.of(context)
                    ..hideCurrentSnackBar()
                    ..showSnackBar(SnackBar(content: Text(state.error!)));
                }
              },
              builder: (context, state) {
                final streaming = state.isStreaming;
                if (state.messages.isEmpty && !streaming) {
                  return const Center(
                    child: Padding(
                      padding: EdgeInsets.all(32),
                      child: Text(
                        'Ask a question about the business.',
                        textAlign: TextAlign.center,
                      ),
                    ),
                  );
                }
                final itemCount = state.messages.length + (streaming ? 1 : 0);
                return ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  itemCount: itemCount,
                  itemBuilder: (context, i) {
                    if (i < state.messages.length) {
                      final m = state.messages[i];
                      return MessageBubble(
                        text: m.text,
                        isUser: m.role == Role.user,
                      );
                    }
                    // The in-flight assistant turn: dots until the first token,
                    // then the answer revealed token-by-token.
                    if (state.streamingAnswer.isEmpty) {
                      return const Padding(
                        padding: EdgeInsets.fromLTRB(20, 12, 20, 12),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: TypingIndicator(),
                        ),
                      );
                    }
                    return MessageBubble(
                      text: state.streamingAnswer,
                      isUser: false,
                    );
                  },
                );
              },
            ),
          ),
          BlocBuilder<ChatBloc, ChatState>(
            buildWhen: (a, b) => a.isStreaming != b.isStreaming,
            builder: (context, state) => _InputBar(
              controller: _input,
              isStreaming: state.isStreaming,
              onSend: _send,
              onStop: () => context.read<ChatBloc>().add(const CancelStream()),
            ),
          ),
        ],
      ),
    );
  }
}

class _InputBar extends StatelessWidget {
  const _InputBar({
    required this.controller,
    required this.isStreaming,
    required this.onSend,
    required this.onStop,
  });

  final TextEditingController controller;
  final bool isStreaming;
  final VoidCallback onSend;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: controller,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) {
                  if (!isStreaming) onSend();
                },
                decoration: InputDecoration(
                  hintText: 'Type a question…',
                  filled: true,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 10,
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            IconButton.filled(
              onPressed: isStreaming ? onStop : onSend,
              icon: Icon(isStreaming ? Icons.stop : Icons.arrow_upward),
              tooltip: isStreaming ? 'Stop' : 'Send',
            ),
          ],
        ),
      ),
    );
  }
}
