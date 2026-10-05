import type { Server } from 'node:http';
import { createApp } from './lib/http.ts';
import { userRoutes } from './users/routes.ts';
import { UserStore } from './users/store.ts';

export function buildApp(): Server {
  return createApp([...userRoutes(new UserStore())]);
}
