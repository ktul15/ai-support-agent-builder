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
import 'package:asab_mobile/core/router/app_router.dart' as _i66;
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
    gh.lazySingleton<_i66.AppRouter>(() => _i66.AppRouter());
    gh.lazySingleton<_i361.Dio>(() => networkModule.dio(gh<_i527.AppConfig>()));
    return this;
  }
}

class _$NetworkModule extends _i636.NetworkModule {}
