import { defineRoute, NoBody, NoParams, type Route } from '../lib/http.ts';
import { ListOrdersQuery, Order, OrderCreate, OrderIdParams, OrderPage, OrderUpdate } from './schema.ts';
import type { OrderStore } from './store.ts';

export function orderRoutes(store: OrderStore): Route[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/orders',
      status: 200,
      errors: [422],
      params: NoParams,
      query: ListOrdersQuery,
      body: NoBody,
      response: OrderPage,
      handler: async ({ query }) => store.list(query.cursor, query.limit),
    }),
    defineRoute({
      method: 'GET',
      path: '/v1/orders/:id',
      status: 200,
      errors: [404, 422],
      params: OrderIdParams,
      query: NoParams,
      body: NoBody,
      response: Order,
      handler: async ({ params }) => store.get(params.id),
    }),
    defineRoute({
      method: 'POST',
      path: '/v1/orders',
      status: 201,
      idempotent: true,
      errors: [409, 422],
      params: NoParams,
      query: NoParams,
      body: OrderCreate,
      response: Order,
      handler: async ({ body }) => store.create(body),
    }),
    defineRoute({
      method: 'PATCH',
      path: '/v1/orders/:id',
      status: 200,
      errors: [404, 409, 422],
      params: OrderIdParams,
      query: NoParams,
      body: OrderUpdate,
      response: Order,
      handler: async ({ params, body }) => store.update(params.id, body),
    }),
  ];
}
