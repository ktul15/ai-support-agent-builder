/// Build flavor. Selected by the entrypoint (main_dev.dart / main_prod.dart).
enum Flavor { dev, prod }

/// Runtime configuration, supplied per flavor at bootstrap and injected via DI.
/// `apiBaseUrl` and `apiKey` can be overridden with --dart-define.
class AppConfig {
  const AppConfig({required this.flavor, required this.apiBaseUrl, this.apiKey = ''});

  final Flavor flavor;
  final String apiBaseUrl;

  /// Consumer API key (identifies tenant + assistant server-side). Empty until a
  /// key is provisioned; wired into requests in #35.
  final String apiKey;

  bool get isDev => flavor == Flavor.dev;
}
