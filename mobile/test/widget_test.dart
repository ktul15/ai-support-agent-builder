import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:asab_mobile/app.dart';
import 'package:asab_mobile/app_config.dart';
import 'package:asab_mobile/core/di/injection.dart';
import 'package:asab_mobile/features/chat/data/chat_models.dart';
import 'package:asab_mobile/features/chat/data/chat_repository.dart';
import 'package:asab_mobile/features/chat/view/widgets/citation_chips.dart';
import 'package:asab_mobile/features/chat/view/widgets/refusal_card.dart';
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
  // Guards against const drift: the refusal card keys off an exact match, so if
  // this literal diverges from the API's REFUSAL_MESSAGE every refusal silently
  // regresses to a plain bubble. Asserted independently of the const itself.
  test('kRefusalMessage matches the API contract string', () {
    expect(
      kRefusalMessage,
      "I don't have enough information in the provided sources to answer that.",
    );
  });

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

  testWidgets('tapping a citation chip opens the source bottom-sheet', (tester) async {
    await _bootDi();
    final controller = StreamController<ChatStreamEvent>();
    getIt.unregister<ChatRepository>();
    getIt.registerFactory<ChatRepository>(() => _StreamRepo(controller.stream));

    await tester.pumpWidget(const App());
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'refunds?');
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();
    controller.add(const TokenChunk('See the policy.'));
    await tester.pump();
    controller.add(
      const StreamDone(
        grounded: true,
        citations: [
          Citation(
            marker: 1,
            documentId: 'd1',
            title: 'Refund Policy',
            page: 3,
            snippet: 'Refunds within 30 days.',
          ),
          // No page/section and no title — exercises the 'Source' label + the
          // empty-title chip guard.
          Citation(marker: 2, documentId: 'd2', title: '', snippet: 'Any time.'),
        ],
      ),
    );
    await controller.close();
    await tester.pumpAndSettle();

    expect(find.textContaining('[1]'), findsOneWidget);
    expect(find.textContaining('[2]'), findsOneWidget);

    // First source: title + page + the grounding snippet, then Open document.
    await tester.tap(find.textContaining('[1]'));
    await tester.pumpAndSettle();
    expect(find.text('Refunds within 30 days.'), findsOneWidget);
    expect(find.text('Page 3'), findsOneWidget);

    await tester.tap(find.text('Open document'));
    await tester.pumpAndSettle();
    expect(find.text('Full document view is coming soon.'), findsOneWidget);

    // Second source: no page/section -> 'Source' label.
    await tester.tap(find.textContaining('[2]'));
    await tester.pumpAndSettle();
    expect(find.text('Any time.'), findsOneWidget);
    expect(find.text('Source'), findsOneWidget);
  });

  testWidgets('a refusal renders the refusal card, not a bubble or citations', (tester) async {
    await _bootDi();
    final controller = StreamController<ChatStreamEvent>();
    getIt.unregister<ChatRepository>();
    getIt.registerFactory<ChatRepository>(() => _StreamRepo(controller.stream));

    await tester.pumpWidget(const App());
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'weather?');
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();
    controller.add(const TokenChunk(kRefusalMessage)); // the API streams this
    await tester.pump();
    controller.add(const StreamDone(grounded: false, citations: []));
    await controller.close();
    await tester.pumpAndSettle();

    expect(find.byType(RefusalCard), findsOneWidget);
    expect(find.textContaining("couldn't find that"), findsOneWidget);
    expect(find.byType(CitationChips), findsNothing); // no fake citations
    expect(find.text(kRefusalMessage), findsNothing); // raw string not shown
  });
}
