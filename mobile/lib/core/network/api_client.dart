import 'package:dio/dio.dart';
import 'package:injectable/injectable.dart';

import '../../app_config.dart';

/// Attaches the consumer API key to every request. The server derives the tenant
/// + assistant FROM the key — the client never sends them in the body.
///
/// PROVISIONAL (#35): the API today only accepts `Authorization: Bearer`. The
/// consumer-auth scheme — raw key per request under `x-api-key` vs. exchanging
/// the key for a short-lived JWT — is decided in #35; align this header then.
class ApiKeyInterceptor extends Interceptor {
  ApiKeyInterceptor(this._apiKey);

  final String _apiKey;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (_apiKey.isNotEmpty) {
      options.headers['x-api-key'] = _apiKey;
    }
    handler.next(options);
  }
}

/// DI module: a single configured Dio, base URL + auth from [AppConfig].
@module
abstract class NetworkModule {
  @lazySingleton
  Dio dio(AppConfig config) => Dio(
    BaseOptions(
      baseUrl: config.apiBaseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 60),
      headers: {'accept': 'application/json'},
    ),
  )..interceptors.add(ApiKeyInterceptor(config.apiKey));
}
