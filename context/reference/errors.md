# errors: RFC 7807 only
```ts
import { problem } from '../lib/problem.ts';
throw problem(404, 'not-found', 'Widget not found', `No widget with id '${id}'`);
throw problem(409, 'conflict', 'Widget already exists', `A widget named '${name}' already exists`);
```
422 for invalid params/query/body, malformed JSON, bad cursors and missing Idempotency-Key is raised
by src/lib. 409 for a reused Idempotency-Key with a different body is raised by src/lib.
The response is `application/problem+json` with type, title, status, detail and instance.
