import 'package:get_it/get_it.dart';
import 'package:injectable/injectable.dart';

import '../../app_config.dart';
import 'injection.config.dart';

final GetIt getIt = GetIt.instance;

/// Wires the injectable graph. The per-flavor [AppConfig] is registered by
/// bootstrap() BEFORE this runs (Dio depends on it). The assert turns a
/// forgotten registration into a loud failure at startup instead of a delayed
/// throw on the first network call.
@InjectableInit()
void configureDependencies() {
  assert(
    getIt.isRegistered<AppConfig>(),
    'AppConfig must be registered before configureDependencies() — call bootstrap().',
  );
  getIt.init();
}
