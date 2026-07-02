/// A cited source anchored to a document location (matches the API `done` event).
class Citation {
  const Citation({
    required this.marker,
    required this.documentId,
    required this.title,
    this.page,
    this.section,
    required this.snippet,
  });

  final int marker;
  final String documentId;
  final String title;
  final int? page;
  final String? section;
  final String snippet;

  factory Citation.fromJson(Map<String, dynamic> json) => Citation(
    marker: (json['marker'] as num).toInt(),
    documentId: json['document_id'] as String? ?? '',
    title: json['title'] as String? ?? '',
    page: (json['page'] as num?)?.toInt(),
    section: json['section'] as String?,
    snippet: json['snippet'] as String? ?? '',
  );
}

/// One frame off the chat SSE stream. Sealed so the bloc must handle every case.
sealed class ChatStreamEvent {
  const ChatStreamEvent();
}

class TokenChunk extends ChatStreamEvent {
  const TokenChunk(this.text);
  final String text;
}

class StreamDone extends ChatStreamEvent {
  const StreamDone({required this.grounded, required this.citations});
  final bool grounded;
  final List<Citation> citations;
}

class StreamErrorFrame extends ChatStreamEvent {
  const StreamErrorFrame(this.message);
  final String message;
}

enum Role { user, assistant }

/// The canonical refusal string. MUST stay in sync with the API's
/// REFUSAL_MESSAGE (invariant #3) — both gates emit exactly this, so an exact
/// match is a reliable "I don't know" signal.
const String kRefusalMessage =
    "I don't have enough information in the provided sources to answer that.";

/// A completed turn in the transcript.
class ChatMessage {
  const ChatMessage({
    required this.role,
    required this.text,
    this.citations = const [],
    this.grounded,
  });

  final Role role;
  final String text;
  final List<Citation> citations;
  final bool? grounded;

  /// True when the assistant emitted the canonical "I don't know" — renders as
  /// the refusal card (and, being ungrounded, never carries citations).
  bool get isRefusal => role == Role.assistant && text.trim() == kRefusalMessage;
}
