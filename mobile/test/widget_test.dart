import 'package:flutter_test/flutter_test.dart';

import 'package:asab_mobile/app.dart';
import 'package:asab_mobile/app_config.dart';
import 'package:asab_mobile/core/di/injection.dart';

void main() {
  setUp(() async {
    await getIt.reset();
    getIt.registerSingleton<AppConfig>(
      const AppConfig(flavor: Flavor.dev, apiBaseUrl: 'http://localhost:3000'),
    );
    configureDependencies();
  });

  testWidgets('boots to the home screen', (tester) async {
    await tester.pumpWidget(const App());
    await tester.pumpAndSettle();
    expect(find.text('Chat with Your Business'), findsOneWidget);
  });
}
