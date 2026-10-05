import { z } from 'zod';
import { PageQuery, pageOf } from '../lib/pagination.ts';

export const OrderStatus = z.enum(['pending', 'shipped']);

export const Order = z.object({
  id: z.uuid(),
  item: z.string().min(1).max(200),
  quantity: z.number().int().min(1),
  status: OrderStatus,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Order = z.infer<typeof Order>;

export const OrderCreate = z
  .object({
    item: z.string().min(1).max(200),
    quantity: z.number().int().min(1),
  })
  .strict();
export type OrderCreate = z.infer<typeof OrderCreate>;

export const OrderUpdate = z
  .object({
    status: OrderStatus.optional(),
    quantity: z.number().int().min(1).optional(),
  })
  .strict();
export type OrderUpdate = z.infer<typeof OrderUpdate>;

export const OrderIdParams = z.object({ id: z.uuid() }).strict();
export const ListOrdersQuery = PageQuery;
export const OrderPage = pageOf(Order);
