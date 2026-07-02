import 'app_config.dart';
import 'bootstrap.dart';

/// Dev flavor. On the Android emulator, 10.0.2.2 reaches the host's localhost.
void main() => bootstrap(
  const AppConfig(
    flavor: Flavor.dev,
    apiBaseUrl: String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000'),
    apiKey: String.fromEnvironment('API_KEY'),
  ),
);
