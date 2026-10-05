import { defineRoute, NoBody, NoParams, type Route } from '../lib/http.ts';
import { ListUsersQuery, User, UserCreate, UserIdParams, UserPage, UserUpdate } from './schema.ts';
import type { UserStore } from './store.ts';

export function userRoutes(store: UserStore): Route[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/users',
      status: 201,
      idempotent: true,
      errors: [409, 422],
      params: NoParams,
      query: NoParams,
      body: UserCreate,
      response: User,
      handler: async ({ body }) => store.create(body),
    }),
    defineRoute({
      method: 'GET',
      path: '/v1/users/:id',
      status: 200,
      errors: [404, 422],
      params: UserIdParams,
      query: NoParams,
      body: NoBody,
      response: User,
      handler: async ({ params }) => store.get(params.id),
    }),
    defineRoute({
      method: 'GET',
      path: '/v1/users',
      status: 200,
      errors: [422],
      params: NoParams,
      query: ListUsersQuery,
      body: NoBody,
      response: UserPage,
      handler: async ({ query }) => store.list(query.cursor, query.limit),
    }),
    defineRoute({
      method: 'PATCH',
      path: '/v1/users/:id',
      status: 200,
      errors: [404, 409, 422],
      params: UserIdParams,
      query: NoParams,
      body: UserUpdate,
      response: User,
      handler: async ({ params, body }) => store.update(params.id, body),
    }),
    defineRoute({
      method: 'DELETE',
      path: '/v1/users/:id',
      status: 204,
      errors: [404, 422],
      params: UserIdParams,
      query: NoParams,
      body: NoBody,
      response: NoBody,
      handler: async ({ params }) => {
        store.remove(params.id);
      },
    }),
  ];
}
