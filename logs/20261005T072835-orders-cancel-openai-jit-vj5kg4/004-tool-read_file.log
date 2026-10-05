import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import { problem } from '../lib/problem.ts';
import type { Order, OrderCreate, OrderUpdate } from './schema.ts';

export class OrderStore {
  readonly #orders = new Map<string, Order>();

  list(cursor: string | undefined, limit: number): { data: Order[]; nextCursor: string | null } {
    return paginate([...this.#orders.values()], cursor, limit);
  }

  get(id: string): Order {
    const order = this.#orders.get(id);
    if (order === undefined) throw problem(404, 'not-found', 'Order not found', `No order with id '${id}'`);
    return order;
  }

  create(input: OrderCreate): Order {
    const now = new Date().toISOString();
    const order: Order = { id: randomUUID(), ...input, status: 'pending', createdAt: now, updatedAt: now };
    this.#orders.set(order.id, order);
    return order;
  }

  update(id: string, patch: OrderUpdate): Order {
    const current = this.get(id);
    if (current.status === 'shipped' && patch.quantity !== undefined) {
      throw problem(409, 'order-shipped', 'Order already shipped', `Order '${id}' has shipped and cannot change quantity`);
    }
    const next: Order = {
      ...current,
      status: patch.status ?? current.status,
      quantity: patch.quantity ?? current.quantity,
      updatedAt: new Date().toISOString(),
    };
    this.#orders.set(id, next);
    return next;
  }
}
