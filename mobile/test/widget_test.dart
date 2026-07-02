import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:asab_mobile/app.dart';
import 'package:asab_mobile/app_config.dart';
import 'package:asab_mobile/core/di/injection.dart';
import 'package:asab_mobile/features/chat/data/chat_models.dart';
import 'package:asab_mobile/features/chat/data/chat_repository.dart';
import 'package:asab_mobile/features/chat/view/widgets/typing_indicator.dart';

/// Feeds the bloc from a controllable stream so the UI can be driven step by step.
class _StreamRepo extends ChatRepository {
  _StreamRepo(this._stream) : super(Dio());
  final Stream<ChatStreamEvent> _stream;

  @override
  Stream<ChatStreamEvent> streamAnswer(String question, {CancelToken? cancelToken}) => _stream;
}

Future<void> _bootDi() async {
  await getIt.reset();
  getIt.registerSingleton<AppConfig>(
    const AppConfig(flavor: Flavor.dev, apiBaseUrl: 'http://localhost:3000'),
  );
  configureDependencies();
}

void main() {
  testWidgets('renders the chat screen with an empty-state prompt and input', (tester) async {
    await _bootDi();
    await tester.pumpWidget(const App());
    await tester.pumpAndSettle();

    expect(find.text('Chat with Your Business'), findsOneWidget);
    expect(find.text('Ask a question about the business.'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('typing indicator then token-by-token reveal on send', (tester) async {
    await _bootDi();
    final controller = StreamController<ChatStreamEvent>();
    getIt.unregister<ChatRepository>();
    getIt.registerFactory<ChatRepository>(() => _StreamRepo(controller.stream));

    await tester.pumpWidget(const App());
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'hi');
    await tester.tap(find.byTooltip('Send'));
    await tester.pump(); // process SendMessage
    await tester.pump(); // streaming state (no tokens yet)
    expect(find.byType(TypingIndicator), findsOneWidget);

    controller.add(const TokenChunk('Hel'));
    await tester.pump();
    controller.add(const TokenChunk('lo'));
    await tester.pump();
    expect(find.text('Hello'), findsOneWidget);
    expect(find.byType(TypingIndicator), findsNothing);

    controller.add(const StreamDone(grounded: true, citations: []));
    await controller.close();
    await tester.pump();
    expect(find.text('Hello'), findsOneWidget); // finalized message
  });
}
