import 'package:flutter/widgets.dart';

import 'app.dart';
import 'app_config.dart';
import 'core/di/injection.dart';

/// Shared startup: register the flavor config, wire DI, run the app.
Future<void> bootstrap(AppConfig config) async {
  WidgetsFlutterBinding.ensureInitialized();
  getIt.registerSingleton<AppConfig>(config);
  configureDependencies();
  runApp(const App());
}
