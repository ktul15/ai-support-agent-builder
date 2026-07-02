# mobile (Flutter consumer app)

The customer-facing assistant: streaming chat, tappable citations, and the
distinct "I don't know" refusal state.

**Own toolchain** — Flutter (BLoC + injectable/get_it + auto_route + Dio),
pinned to Flutter 3.41.4 via **FVM** (`.fvmrc`). Not part of the Node workspaces.

## Commands (run from this directory)

- `fvm flutter pub get` — install packages.
- `fvm dart run build_runner build --delete-conflicting-outputs` — regenerate
  DI (`injection.config.dart`), routes (`*.gr.dart`), and freezed/json code after
  editing any `@injectable` / `@AutoRouterConfig` / `@RoutePage` / `@freezed` file.
- `fvm flutter analyze` — static analysis.
- `fvm flutter test` — widget/unit tests.
- Run a flavor: `fvm flutter run --target lib/main_dev.dart` (or `main_prod.dart`),
  optionally `--dart-define=API_BASE_URL=… --dart-define=API_KEY=…`.
  - Dev defaults to `http://10.0.2.2:3000` (Android emulator → host localhost).
    On the **iOS simulator** use `--dart-define=API_BASE_URL=http://localhost:3000`;
    on a physical device use the host machine's LAN IP.

## Structure (issue #34)

- `lib/app_config.dart` — per-flavor config (base URL, API key), injected.
- `lib/main_dev.dart` / `lib/main_prod.dart` — flavor entrypoints; `main.dart`
  defaults to dev.
- `lib/bootstrap.dart` — registers the config, wires DI, runs the app.
- `lib/core/di/` — injectable + get_it.
- `lib/core/network/api_client.dart` — a single Dio, base URL + an API-key
  interceptor (`x-api-key`); the server derives tenant + assistant from the key.
- `lib/core/router/` — auto_route.
- `lib/features/home/` — placeholder screen. Chat (ChatBloc + SSE), citation
  sheet, and refusal card arrive in #35–#38.
