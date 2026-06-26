import { createApp } from './app.js';

// Minimal boot. Typed/validated config (zod) lands in issue #3.
const port = Number(process.env.PORT ?? 3000);

const app = createApp();
app.listen(port, () => {
  console.log(`asab-api listening on http://localhost:${port}`);
});
