import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import { problem } from '../lib/problem.ts';
import type { User, UserCreate, UserUpdate } from './schema.ts';

export class UserStore {
  readonly #items = new Map<string, User>();

  list(cursor: string | undefined, limit: number): { data: User[]; nextCursor: string | null } {
    return paginate([...this.#items.values()], cursor, limit);
  }

  get(id: string): User {
    const item = this.#items.get(id);
    if (item === undefined) throw problem(404, 'not-found', 'User not found', `No user with id '${id}'`);
    return item;
  }

  create(input: UserCreate): User {
    this.#assertUnique(input, undefined);
    const now = new Date().toISOString();
    const item: User = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    this.#items.set(item.id, item);
    return item;
  }

  update(id: string, patch: UserUpdate): User {
    const current = this.get(id);
    this.#assertUnique(patch, id);
    const next: User = {
      ...current,
      name: patch.name ?? current.name,
      email: patch.email ?? current.email,
      age: patch.age ?? current.age,
      updatedAt: new Date().toISOString(),
    };
    this.#items.set(id, next);
    return next;
  }

  remove(id: string): void {
    this.get(id);
    this.#items.delete(id);
  }

  #assertUnique(input: { email?: string | undefined }, selfId: string | undefined): void {
    for (const existing of this.#items.values()) {
      if (existing.id === selfId) continue;
      if (input.email !== undefined && String(existing.email).toLowerCase() === String(input.email).toLowerCase()) {
        throw problem(409, 'conflict', 'User already exists', `A user with email '${String(input.email)}' already exists`);
      }
    }
  }
}
