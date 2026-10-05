# schemas: Zod first, types inferred
```ts
import { z } from 'zod';
import { PageQuery, pageOf } from '../lib/pagination.ts';

export const Widget = z.object({ id: z.uuid(), name: z.string().min(1), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type Widget = z.infer<typeof Widget>;
export const WidgetCreate = z.object({ name: z.string().min(1) }).strict();
export type WidgetCreate = z.infer<typeof WidgetCreate>;
export const WidgetUpdate = z.object({ name: z.string().min(1).optional() }).strict();
export type WidgetUpdate = z.infer<typeof WidgetUpdate>;
export const WidgetIdParams = z.object({ id: z.uuid() }).strict();
export const ListWidgetsQuery = PageQuery;
export const WidgetPage = pageOf(Widget);
```
Field types: string → z.string(), email → z.email(), integer → z.number().int(), number → z.number(),
boolean → z.boolean(), datetime → z.iso.datetime(). Optional fields add .optional().
