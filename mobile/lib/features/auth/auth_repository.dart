import 'package:dio/dio.dart';
import 'package:injectable/injectable.dart';

import '../../app_config.dart';
import '../../core/network/session.dart';

/// Consumer sign-in: exchange the API key for a short-lived assistant-scoped JWT
/// (POST /auth/api-key) and cache it in the [SessionStore]. The long-lived key
/// travels only here; every other request carries the Bearer token.
@lazySingleton
class AuthRepository {
  AuthRepository(this._dio, this._config, this._session);

  final Dio _dio;
  final AppConfig _config;
  final SessionStore _session;

  /// Returns true if a token is available afterwards. No-op (false) when no key
  /// is configured yet.
  Future<bool> signIn() async {
    if (_config.apiKey.isEmpty) return false;
    final res = await _dio.post<Map<String, dynamic>>(
      '/auth/api-key',
      data: {'apiKey': _config.apiKey},
    );
    final token = res.data?['token'] as String?;
    if (token != null && token.isNotEmpty) {
      _session.token = token;
      return true;
    }
    return false;
  }
}
