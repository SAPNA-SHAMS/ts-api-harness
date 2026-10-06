// Harness-owned. Idempotency-Key handling for unsafe, retryable requests.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { problem } from './problem.ts';

export const IdempotencyKey = z.string().min(8).max(200);

type StoredResponse = { fingerprint: string; status: number; body: string };

export class IdempotencyStore {
  readonly #entries = new Map<string, StoredResponse>();

  lookup(scope: string, key: string, fingerprint: string): StoredResponse | undefined {
    const hit = this.#entries.get(`${scope} ${key}`);
    if (hit === undefined) return undefined;
    if (hit.fingerprint !== fingerprint) {
      throw problem(409, 'idempotency-conflict', 'Idempotency key reused', `Idempotency-Key '${key}' was already used with a different request`);
    }
    return hit;
  }

  save(scope: string, key: string, value: StoredResponse): void {
    this.#entries.set(`${scope} ${key}`, value);
  }
}

export function fingerprint(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
