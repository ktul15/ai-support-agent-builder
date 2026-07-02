import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:asab_mobile/features/chat/bloc/chat_bloc.dart';
import 'package:asab_mobile/features/chat/bloc/chat_event.dart';
import 'package:asab_mobile/features/chat/bloc/chat_state.dart';
import 'package:asab_mobile/features/chat/data/chat_models.dart';
import 'package:asab_mobile/features/chat/data/chat_repository.dart';

/// Repository stub — yields a scripted sequence, ignoring the network.
class _FakeChatRepository extends ChatRepository {
  _FakeChatRepository(this._events) : super(Dio());
  final List<ChatStreamEvent> _events;

  @override
  Stream<ChatStreamEvent> streamAnswer(String question, {CancelToken? cancelToken}) async* {
    for (final e in _events) {
      yield e;
    }
  }
}

/// Emits one token then blocks until the CancelToken fires, then throws a Dio
/// cancel — exercising the bloc's cancel-on-leave path like the real repo.
class _HangingChatRepository extends ChatRepository {
  _HangingChatRepository() : super(Dio());

  @override
  Stream<ChatStreamEvent> streamAnswer(String question, {CancelToken? cancelToken}) async* {
    yield const TokenChunk('partial');
    await cancelToken?.whenCancel;
    throw DioException.requestCancelled(
      requestOptions: RequestOptions(path: '/chat'),
      reason: 'cancelled',
    );
  }
}

void main() {
  test('appends tokens then finalizes into a transcript message on done', () async {
    final bloc = ChatBloc(
      _FakeChatRepository([
        const TokenChunk('Hel'),
        const TokenChunk('lo'),
        const StreamDone(
          grounded: true,
          citations: [Citation(marker: 1, documentId: 'd', title: 'Doc', snippet: 's')],
        ),
      ]),
    );

    bloc.add(const SendMessage('hi'));
    final done = await bloc.stream.firstWhere((s) => s.status == ChatStatus.done);

    expect(done.messages.map((m) => m.role), [Role.user, Role.assistant]);
    expect(done.messages.first.text, 'hi');
    expect(done.messages.last.text, 'Hello');
    expect(done.messages.last.grounded, true);
    expect(done.citations, hasLength(1));
    expect(done.streamingAnswer, '');
    await bloc.close();
  });

  test('emits streaming states while tokens arrive', () async {
    final bloc = ChatBloc(
      _FakeChatRepository([
        const TokenChunk('a'),
        const StreamDone(grounded: false, citations: []),
      ]),
    );
    final seen = <String>[];
    final sub = bloc.stream.listen((s) {
      if (s.status == ChatStatus.streaming) seen.add(s.streamingAnswer);
    });

    bloc.add(const SendMessage('q'));
    await bloc.stream.firstWhere((s) => s.status == ChatStatus.done);
    expect(seen, contains('a'));
    await sub.cancel();
    await bloc.close();
  });

  test('an error frame moves to the error state', () async {
    final bloc = ChatBloc(_FakeChatRepository([const StreamErrorFrame('Generation failed.')]));
    bloc.add(const SendMessage('q'));
    final err = await bloc.stream.firstWhere((s) => s.status == ChatStatus.error);
    expect(err.error, 'Generation failed.');
    await bloc.close();
  });

  test('an explicit cancel finalizes the partial answer', () async {
    final bloc = ChatBloc(_HangingChatRepository());
    bloc.add(const SendMessage('q'));
    await bloc.stream.firstWhere((s) => s.streamingAnswer == 'partial');
    bloc.add(const CancelStream());
    final done = await bloc.stream.firstWhere((s) => s.status == ChatStatus.done);
    expect(done.messages.last.role, Role.assistant);
    expect(done.messages.last.text, 'partial');
    await bloc.close();
  });
}
