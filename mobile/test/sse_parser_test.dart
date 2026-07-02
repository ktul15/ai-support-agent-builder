import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:asab_mobile/core/network/sse_parser.dart';

void main() {
  test('parses a complete event/data frame', () {
    final r = parseSseFrames('event: token\ndata: {"text":"hi"}\n\n');
    expect(r.frames, hasLength(1));
    expect(r.frames.first.event, 'token');
    expect(r.frames.first.data, '{"text":"hi"}');
    expect(r.rest, '');
  });

  test('parses multiple frames and skips heartbeat comments', () {
    final r = parseSseFrames('event: token\ndata: a\n\n: ping\n\nevent: done\ndata: {}\n\n');
    expect(r.frames.map((f) => f.event), ['token', 'done']);
  });

  test('carries an incomplete trailing frame as rest', () {
    final r = parseSseFrames('event: token\ndata: a\n\nevent: tok');
    expect(r.frames, hasLength(1));
    expect(r.rest, 'event: tok');
  });

  test('defaults the event name to message when absent', () {
    final r = parseSseFrames('data: plain\n\n');
    expect(r.frames.first.event, 'message');
    expect(r.frames.first.data, 'plain');
  });

  // The repo's real pipeline: byte stream -> utf8.decoder -> parseSseFrames.
  // A multi-byte char split across two chunks must survive (no replacement char).
  test('utf8.decoder reassembles a multi-byte char split across chunks', () async {
    final bytes = utf8.encode('event: token\ndata: {"text":"café"}\n\n');
    final mid = bytes.length - 5; // lands inside the 2-byte é
    final chunks = Stream.fromIterable([bytes.sublist(0, mid), bytes.sublist(mid)]);

    var buffer = '';
    final frames = <SseFrame>[];
    await for (final text in chunks.cast<List<int>>().transform(utf8.decoder)) {
      buffer += text;
      final r = parseSseFrames(buffer);
      buffer = r.rest;
      frames.addAll(r.frames);
    }

    expect(frames, hasLength(1));
    expect((jsonDecode(frames.single.data) as Map<String, dynamic>)['text'], 'café');
  });
}
