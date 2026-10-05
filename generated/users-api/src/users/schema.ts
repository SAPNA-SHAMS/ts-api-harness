import { z } from 'zod';
import { PageQuery, pageOf } from '../lib/pagination.ts';

export const User = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  email: z.email(),
  age: z.number().int().min(0).max(150).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof User>;

export const UserCreate = z
  .object({
    name: z.string().min(1).max(120),
    email: z.email(),
    age: z.number().int().min(0).max(150).optional(),
  })
  .strict();
export type UserCreate = z.infer<typeof UserCreate>;

export const UserUpdate = z
  .object({
    name: z.string().min(1).max(120).optional(),
    email: z.email().optional(),
    age: z.number().int().min(0).max(150).optional(),
  })
  .strict();
export type UserUpdate = z.infer<typeof UserUpdate>;

export const UserIdParams = z.object({ id: z.uuid() }).strict();
export const ListUsersQuery = PageQuery;
export const UserPage = pageOf(User);
