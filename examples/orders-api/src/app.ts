import type { Server } from 'node:http';
import { createApp } from './lib/http.ts';
import { orderRoutes } from './orders/routes.ts';
import { OrderStore } from './orders/store.ts';

export function buildApp(): Server {
  return createApp([...orderRoutes(new OrderStore())]);
}
