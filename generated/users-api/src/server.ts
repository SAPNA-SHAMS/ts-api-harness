// Harness-owned entry point.
import { buildApp } from './app.ts';

const port = Number(process.env['PORT'] ?? '3000');
buildApp().listen(port, () => {
  process.stdout.write(`listening on :${port}\n`);
});
