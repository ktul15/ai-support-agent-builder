import '../data/chat_models.dart';

sealed class ChatEvent {
  const ChatEvent();
}

/// User submitted a question.
class SendMessage extends ChatEvent {
  const SendMessage(this.question);
  final String question;
}

/// Abort the in-flight stream (e.g. leaving the screen).
class CancelStream extends ChatEvent {
  const CancelStream();
}

// Internal events fed from the repository stream subscription.
class StreamTokenReceived extends ChatEvent {
  const StreamTokenReceived(this.text);
  final String text;
}

class StreamCompleted extends ChatEvent {
  const StreamCompleted({required this.grounded, required this.citations});
  final bool grounded;
  final List<Citation> citations;
}

class StreamFailed extends ChatEvent {
  const StreamFailed(this.message);
  final String message;
}
