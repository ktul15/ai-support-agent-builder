import 'package:dio/dio.dart';
import 'package:injectable/injectable.dart';

import '../../app_config.dart';
import 'session.dart';

/// DI module: a single configured Dio. Base URL from [AppConfig]; auth is a
/// short-lived JWT (from exchanging the API key) attached by [AuthInterceptor].
@module
abstract class NetworkModule {
  @lazySingleton
  Dio dio(AppConfig config, SessionStore session) => Dio(
    BaseOptions(
      baseUrl: config.apiBaseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 60),
      headers: {'accept': 'application/json'},
    ),
  )..interceptors.add(AuthInterceptor(session));
}
