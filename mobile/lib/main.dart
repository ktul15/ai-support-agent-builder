// Default entrypoint (dev flavor). For an explicit flavor build/run, target
// lib/main_dev.dart or lib/main_prod.dart with --target.
import 'main_dev.dart' as dev;

void main() => dev.main();
