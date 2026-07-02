import 'app_config.dart';
import 'bootstrap.dart';

void main() => bootstrap(
  const AppConfig(
    flavor: Flavor.prod,
    apiBaseUrl: String.fromEnvironment('API_BASE_URL', defaultValue: 'https://api.chatwithyourbusiness.app'),
    apiKey: String.fromEnvironment('API_KEY'),
  ),
);
