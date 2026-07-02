import 'package:flutter/widgets.dart';

import 'app.dart';
import 'app_config.dart';
import 'core/di/injection.dart';
import 'features/auth/auth_repository.dart';

/// Shared startup: register the flavor config, wire DI, exchange the API key for
/// a session token (best-effort — the app still boots without one), run the app.
Future<void> bootstrap(AppConfig config) async {
  WidgetsFlutterBinding.ensureInitialized();
  getIt.registerSingleton<AppConfig>(config);
  configureDependencies();
  try {
    await getIt<AuthRepository>().signIn();
  } catch (_) {
    // Offline / bad key: boot anyway; chat requests will surface the error.
  }
  runApp(const App());
}
