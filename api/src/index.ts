import { getConfig } from './config.js';
import { createApp } from './app.js';

// Validate env first — on misconfig, print only the readable message (no stack)
// and exit non-zero, so operators see the aggregated error, not framework noise.
try {
  const config = getConfig();
  const app = createApp();
  app.listen(config.PORT, () => {
    console.log(`asab-api listening on http://localhost:${config.PORT}`);
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
