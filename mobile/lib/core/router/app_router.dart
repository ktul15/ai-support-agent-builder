import 'package:auto_route/auto_route.dart';
import 'package:injectable/injectable.dart';

import 'app_router.gr.dart';

/// App navigation. Injected so pages/blocs can request navigation via DI.
@lazySingleton
@AutoRouterConfig()
class AppRouter extends RootStackRouter {
  @override
  List<AutoRoute> get routes => [AutoRoute(page: HomeRoute.page, initial: true)];
}
