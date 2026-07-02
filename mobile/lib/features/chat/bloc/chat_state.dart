import 'package:flutter/foundation.dart';

import '../data/chat_models.dart';

/// idle → streaming → (done | error). Drives the chat UI (#36).
enum ChatStatus { idle, streaming, done, error }

@immutable
class ChatState {
  const ChatState({
    this.status = ChatStatus.idle,
    this.messages = const [],
    this.streamingAnswer = '',
    this.citations = const [],
    this.grounded,
    this.error,
  });

  final ChatStatus status;

  /// Completed turns (user + assistant).
  final List<ChatMessage> messages;

  /// The assistant answer currently being streamed (empty when not streaming).
  final String streamingAnswer;

  /// Citations from the last completed answer.
  final List<Citation> citations;
  final bool? grounded;
  final String? error;

  bool get isStreaming => status == ChatStatus.streaming;

  ChatState copyWith({
    ChatStatus? status,
    List<ChatMessage>? messages,
    String? streamingAnswer,
    List<Citation>? citations,
    bool? grounded,
    String? error,
  }) => ChatState(
    status: status ?? this.status,
    messages: messages ?? this.messages,
    streamingAnswer: streamingAnswer ?? this.streamingAnswer,
    citations: citations ?? this.citations,
    grounded: grounded ?? this.grounded,
    error: error ?? this.error,
  );
}
