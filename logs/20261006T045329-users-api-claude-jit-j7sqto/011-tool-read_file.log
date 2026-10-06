// Harness-owned. Opaque cursor pagination shared by every list route.
import { z } from 'zod';
import { problem } from './problem.ts';

export const PageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (id.length === 0 || encodeCursor(id) !== cursor) {
    throw problem(422, 'invalid-cursor', 'Invalid pagination cursor', `cursor: '${cursor}' is not a valid cursor`);
  }
  return id;
}

export function paginate<T extends { id: string }>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number,
): { data: T[]; nextCursor: string | null } {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  const found = after === undefined ? 0 : sorted.findIndex((item) => item.id > after);
  const from = found === -1 ? sorted.length : found;
  const data = sorted.slice(from, from + limit);
  const last = data[data.length - 1];
  const hasMore = from + limit < sorted.length;
  return { data, nextCursor: hasMore && last !== undefined ? encodeCursor(last.id) : null };
}
