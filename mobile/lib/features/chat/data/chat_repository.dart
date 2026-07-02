import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:injectable/injectable.dart';

import '../../../core/network/sse_parser.dart';
import 'chat_models.dart';

/// Streams a grounded answer from the chat SSE endpoint. Emits token chunks as
/// they arrive, then a terminal [StreamDone] (grounded + citations) or
/// [StreamErrorFrame]. Pass a [CancelToken] to abort (cancel-on-leave).
@lazySingleton
class ChatRepository {
  ChatRepository(this._dio);

  final Dio _dio;

  Stream<ChatStreamEvent> streamAnswer(String question, {CancelToken? cancelToken}) async* {
    final res = await _dio.post<ResponseBody>(
      '/chat',
      data: {'question': question},
      cancelToken: cancelToken,
      options: Options(
        responseType: ResponseType.stream,
        headers: {'accept': 'text/event-stream'},
        // The stream is long-lived; the base 60s receive timeout would abort it.
        receiveTimeout: Duration.zero,
      ),
    );

    var buffer = '';
    // utf8.decoder is stateful: it buffers a multi-byte code point split across
    // two socket chunks instead of emitting replacement chars — decoding each
    // raw chunk independently would corrupt any non-ASCII token on a boundary.
    await for (final text in res.data!.stream.cast<List<int>>().transform(utf8.decoder)) {
      buffer += text;
      final parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (final frame in parsed.frames) {
        ChatStreamEvent? event;
        try {
          switch (frame.event) {
            case 'token':
              final t = (jsonDecode(frame.data) as Map<String, dynamic>)['text'] as String?;
              if (t != null) event = TokenChunk(t);
            case 'done':
              final d = jsonDecode(frame.data) as Map<String, dynamic>;
              final citations = ((d['citations'] as List?) ?? const [])
                  .map((c) => Citation.fromJson(c as Map<String, dynamic>))
                  .toList();
              event = StreamDone(grounded: d['grounded'] as bool? ?? false, citations: citations);
            case 'error':
              event = const StreamErrorFrame('Generation failed.');
          }
        } catch (_) {
          continue; // skip a malformed frame; keep reading the stream
        }
        if (event == null) continue;
        yield event;
        // done/error are terminal — stop consuming so a stray later frame can't
        // overwrite the final state.
        if (event is StreamDone || event is StreamErrorFrame) return;
      }
    }
  }
}
