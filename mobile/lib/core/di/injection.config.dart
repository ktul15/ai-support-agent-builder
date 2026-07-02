// GENERATED CODE - DO NOT MODIFY BY HAND
// dart format width=80

// **************************************************************************
// InjectableConfigGenerator
// **************************************************************************

// ignore_for_file: type=lint
// coverage:ignore-file

// ignore_for_file: no_leading_underscores_for_library_prefixes
import 'package:asab_mobile/app_config.dart' as _i527;
import 'package:asab_mobile/core/network/api_client.dart' as _i636;
import 'package:asab_mobile/core/network/session.dart' as _i827;
import 'package:asab_mobile/core/router/app_router.dart' as _i66;
import 'package:asab_mobile/features/auth/auth_repository.dart' as _i587;
import 'package:asab_mobile/features/chat/bloc/chat_bloc.dart' as _i78;
import 'package:asab_mobile/features/chat/data/chat_repository.dart' as _i900;
import 'package:dio/dio.dart' as _i361;
import 'package:get_it/get_it.dart' as _i174;
import 'package:injectable/injectable.dart' as _i526;

extension GetItInjectableX on _i174.GetIt {
  // initializes the registration of main-scope dependencies inside of GetIt
  _i174.GetIt init({
    String? environment,
    _i526.EnvironmentFilter? environmentFilter,
  }) {
    final gh = _i526.GetItHelper(this, environment, environmentFilter);
    final networkModule = _$NetworkModule();
    gh.lazySingleton<_i827.SessionStore>(() => _i827.SessionStore());
    gh.lazySingleton<_i66.AppRouter>(() => _i66.AppRouter());
    gh.lazySingleton<_i361.Dio>(
      () => networkModule.dio(gh<_i527.AppConfig>(), gh<_i827.SessionStore>()),
    );
    gh.lazySingleton<_i900.ChatRepository>(
      () => _i900.ChatRepository(gh<_i361.Dio>()),
    );
    gh.factory<_i78.ChatBloc>(() => _i78.ChatBloc(gh<_i900.ChatRepository>()));
    gh.lazySingleton<_i587.AuthRepository>(
      () => _i587.AuthRepository(
        gh<_i361.Dio>(),
        gh<_i527.AppConfig>(),
        gh<_i827.SessionStore>(),
      ),
    );
    return this;
  }
}

class _$NetworkModule extends _i636.NetworkModule {}
