class SseFrame {
  const SseFrame(this.event, this.data);
  final String event;
  final String data;
}

class SseParseResult {
  const SseParseResult(this.frames, this.rest);
  final List<SseFrame> frames;

  /// Leftover partial text — prepend it to the next chunk.
  final String rest;
}

final _eventRe = RegExp(r'(?:^|\n)event: (.*)');
final _dataRe = RegExp(r'(?:^|\n)data: (.*)');

/// Incrementally parse SSE frames from a growing [buffer] (frames end in a blank
/// line). Complete frames are returned; the trailing partial is the `rest`.
/// Heartbeat comment lines (starting `:`) are skipped.
SseParseResult parseSseFrames(String buffer) {
  final frames = <SseFrame>[];
  var buf = buffer;
  while (true) {
    final idx = buf.indexOf('\n\n');
    if (idx == -1) break;
    final raw = buf.substring(0, idx);
    buf = buf.substring(idx + 2);
    if (raw.startsWith(':')) continue;
    final event = _eventRe.firstMatch(raw)?.group(1) ?? 'message';
    final data = _dataRe.firstMatch(raw)?.group(1) ?? '';
    frames.add(SseFrame(event, data));
  }
  return SseParseResult(frames, buf);
}
