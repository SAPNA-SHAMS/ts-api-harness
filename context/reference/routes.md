# routes: defineRoute
```ts
import { defineRoute, NoBody, NoParams, type Route } from '../lib/http.ts';
import { ListWidgetsQuery, Widget, WidgetCreate, WidgetIdParams, WidgetPage, WidgetUpdate } from './schema.ts';
import type { WidgetStore } from './store.ts';

export function widgetRoutes(store: WidgetStore): Route[] {
  return [
    defineRoute({ method: 'GET', path: '/v1/widgets', status: 200, errors: [422],
      params: NoParams, query: ListWidgetsQuery, body: NoBody, response: WidgetPage,
      handler: async ({ query }) => store.list(query.cursor, query.limit) }),
    defineRoute({ method: 'POST', path: '/v1/widgets', status: 201, idempotent: true, errors: [409, 422],
      params: NoParams, query: NoParams, body: WidgetCreate, response: Widget,
      handler: async ({ body }) => store.create(body) }),
    defineRoute({ method: 'DELETE', path: '/v1/widgets/:id', status: 204, errors: [404, 422],
      params: WidgetIdParams, query: NoParams, body: NoBody, response: NoBody,
      handler: async ({ params }) => { store.remove(params.id); } }),
  ];
}
```
GET item and PATCH follow the same shape (status 200, errors [404, 422] / [404, 409, 422]).
