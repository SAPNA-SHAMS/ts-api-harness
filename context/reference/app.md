# app: wire routes into the server
```ts
import type { Server } from 'node:http';
import { createApp } from './lib/http.ts';
import { widgetRoutes } from './widgets/routes.ts';
import { WidgetStore } from './widgets/store.ts';

export function buildApp(): Server {
  return createApp([...widgetRoutes(new WidgetStore())]);
}
```
