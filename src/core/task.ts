// Task files describe the work, never the model. The loader rejects any task that names a
// registered driver, so provider names cannot leak into task definitions.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Behavior, ExpectedRoute, TaskInfo } from './sdk.ts';

const BehaviorSchema = z.enum(['create', 'get', 'list', 'update', 'delete']);

const FieldSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    type: z.enum(['string', 'email', 'integer', 'number', 'boolean', 'datetime']),
    required: z.boolean().default(true),
    unique: z.boolean().default(false),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

const TestMapSchema = z.array(z.object({ source: z.string(), tests: z.string() }).strict()).default([]);

const Greenfield = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    mode: z.literal('greenfield'),
    description: z.string(),
    apiVersion: z.string().regex(/^v\d+$/).default('v1'),
    resource: z.object({ name: z.string().regex(/^[a-z]+$/), singular: z.string().regex(/^[a-z]+$/), fields: z.array(FieldSchema).min(1) }).strict(),
    behaviors: z.array(BehaviorSchema).min(1),
    output: z.string().optional(),
    acceptance: z.array(z.string()).default([]),
    testMap: TestMapSchema,
  })
  .strict();

const Brownfield = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    mode: z.literal('brownfield'),
    description: z.string(),
    apiVersion: z.string().regex(/^v\d+$/).default('v1'),
    repo: z.string(),
    resource: z.object({ name: z.string().regex(/^[a-z]+$/) }).strict(),
    change: z
      .object({ summary: z.string(), adds: z.array(BehaviorSchema).default([]), allowBreaking: z.array(z.string()).default([]) })
      .strict(),
    scope: z.array(z.string()).default([]),
    acceptance: z.array(z.string()).default([]),
    testMap: TestMapSchema,
  })
  .strict();

export const TaskSchema = z.discriminatedUnion('mode', [Greenfield, Brownfield]);
export type Task = z.infer<typeof TaskSchema>;

export function routeFor(version: string, plural: string, behavior: Behavior): ExpectedRoute {
  const coll = `/${version}/${plural}`;
  const item = `${coll}/:id`;
  switch (behavior) {
    case 'create':
      return { method: 'POST', path: coll, behavior };
    case 'list':
      return { method: 'GET', path: coll, behavior };
    case 'get':
      return { method: 'GET', path: item, behavior };
    case 'update':
      return { method: 'PATCH', path: item, behavior };
    case 'delete':
      return { method: 'DELETE', path: item, behavior };
  }
}

export function loadTask(file: string, forbiddenWords: readonly string[]): { task: Task; info: TaskInfo; text: string } {
  const text = readFileSync(file, 'utf8');
  const lowered = text.toLowerCase();
  for (const word of forbiddenWords) {
    if (word.length > 0 && new RegExp(`\\b${word.toLowerCase()}\\b`).test(lowered)) {
      throw new Error(`task ${file} names '${word}': task files must describe the work, not the model`);
    }
  }
  const parsed = TaskSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`task ${file} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const task = parsed.data;
  const behaviors = task.mode === 'greenfield' ? task.behaviors : task.change.adds;
  const info: TaskInfo = {
    name: task.name,
    mode: task.mode,
    description: task.description,
    resource: task.resource.name,
    expectedRoutes: behaviors.map((b) => routeFor(task.apiVersion, task.resource.name, b)),
    allowBreaking: task.mode === 'brownfield' ? task.change.allowBreaking : [],
    raw: task,
  };
  return { task, info, text };
}

/** Where a shipped task lands in the repository. */
export function outputDir(task: Task): string {
  return task.mode === 'greenfield' ? (task.output ?? `generated/${task.name}`) : task.repo;
}
