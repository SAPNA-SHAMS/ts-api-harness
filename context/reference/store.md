# store: in-memory, problem-throwing
```ts
import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import { problem } from '../lib/problem.ts';
import type { Widget, WidgetCreate, WidgetUpdate } from './schema.ts';

export class WidgetStore {
  readonly #items = new Map<string, Widget>();
  list(cursor: string | undefined, limit: number): { data: Widget[]; nextCursor: string | null } {
    return paginate([...this.#items.values()], cursor, limit);
  }
  get(id: string): Widget {
    const w = this.#items.get(id);
    if (w === undefined) throw problem(404, 'not-found', 'Widget not found', `No widget with id '${id}'`);
    return w;
  }
}
```
Never use `!`; use `=== undefined` checks (noUncheckedIndexedAccess is on).
