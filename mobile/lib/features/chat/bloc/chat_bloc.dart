import 'package:bloc_concurrency/bloc_concurrency.dart';
import 'package:dio/dio.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:injectable/injectable.dart';

import '../data/chat_models.dart';
import '../data/chat_repository.dart';
import 'chat_event.dart';
import 'chat_state.dart';

/// Drives one chat conversation: idle → streaming → (done | error). Consumes the
/// repository's SSE stream, appending tokens to the in-flight answer and
/// finalizing into a transcript message on `done`. A CancelToken aborts the
/// stream on an explicit cancel or when the bloc is closed (cancel-on-leave).
@injectable
class ChatBloc extends Bloc<ChatEvent, ChatState> {
  ChatBloc(this._repo) : super(const ChatState()) {
    // restartable: a new question supersedes an in-flight one — bloc cancels the
    // previous handler (no concurrent handlers clobbering shared state), and we
    // abort its HTTP stream via the shared CancelToken below.
    on<SendMessage>(_onSend, transformer: restartable());
    on<CancelStream>(_onCancel);
  }

  final ChatRepository _repo;
  CancelToken? _cancelToken;

  ChatState _finished(String answer, List<Citation> citations, bool grounded) => state.copyWith(
    status: ChatStatus.done,
    messages: [
      ...state.messages,
      ChatMessage(role: Role.assistant, text: answer, citations: citations, grounded: grounded),
    ],
    streamingAnswer: '',
    citations: citations,
    grounded: grounded,
  );

  Future<void> _onSend(SendMessage event, Emitter<ChatState> emit) async {
    _cancelToken?.cancel();
    final token = CancelToken();
    _cancelToken = token;

    emit(
      state.copyWith(
        status: ChatStatus.streaming,
        messages: [...state.messages, ChatMessage(role: Role.user, text: event.question)],
        streamingAnswer: '',
        citations: const [],
        error: null,
      ),
    );

    final buffer = StringBuffer();
    var citations = const <Citation>[];
    var grounded = false;
    var completed = false;

    try {
      await emit.forEach<ChatStreamEvent>(
        _repo.streamAnswer(event.question, cancelToken: token),
        onData: (ev) {
          switch (ev) {
            case TokenChunk(:final text):
              buffer.write(text);
              return state.copyWith(
                status: ChatStatus.streaming,
                streamingAnswer: buffer.toString(),
              );
            case StreamDone(grounded: final g, citations: final c):
              completed = true;
              grounded = g;
              citations = c;
              return _finished(buffer.toString(), c, g);
            case StreamErrorFrame(:final message):
              completed = true;
              return state.copyWith(
                status: ChatStatus.error,
                error: message,
                streamingAnswer: '',
              );
          }
        },
      );
      // Stream closed without an explicit done/error frame — finalize what we have.
      if (!completed) emit(_finished(buffer.toString(), citations, grounded));
    } on DioException catch (err) {
      // An intentional cancel is a graceful stop, not an error.
      if (CancelToken.isCancel(err)) {
        emit(_finished(buffer.toString(), citations, grounded));
      } else {
        emit(state.copyWith(status: ChatStatus.error, error: 'Connection error.', streamingAnswer: ''));
      }
    } catch (_) {
      emit(
        state.copyWith(status: ChatStatus.error, error: 'Something went wrong.', streamingAnswer: ''),
      );
    }
  }

  void _onCancel(CancelStream event, Emitter<ChatState> emit) {
    _cancelToken?.cancel();
  }

  @override
  Future<void> close() {
    _cancelToken?.cancel();
    return super.close();
  }
}
