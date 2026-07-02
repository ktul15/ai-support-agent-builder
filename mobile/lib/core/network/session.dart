import 'package:dio/dio.dart';
import 'package:injectable/injectable.dart';

/// Holds the current consumer JWT (obtained by exchanging the API key). In
/// memory for now; #34 note tracks moving the key/token to secure storage.
@lazySingleton
class SessionStore {
  String? token;
  bool get hasToken => token != null && token!.isNotEmpty;
}

/// Attaches `Authorization: Bearer <jwt>` to every request except the token
/// exchange itself (which has no token yet and mustn't carry a stale one).
class AuthInterceptor extends Interceptor {
  AuthInterceptor(this._session);

  final SessionStore _session;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (!options.path.startsWith('/auth/') && _session.hasToken) {
      options.headers['authorization'] = 'Bearer ${_session.token}';
    }
    handler.next(options);
  }
}
