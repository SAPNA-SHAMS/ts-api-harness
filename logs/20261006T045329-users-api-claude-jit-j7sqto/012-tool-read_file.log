// Harness-owned. RFC 7807 problem details: the only shape a non-2xx response may take.
import type { ServerResponse } from 'node:http';
import { z } from 'zod';

export const PROBLEM_BASE = 'https://api.sf/problems/';

export const ProblemSchema = z.object({
  type: z.url(),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string().min(1),
});
export type Problem = z.infer<typeof ProblemSchema>;

export class HttpProblem extends Error {
  readonly status: number;
  readonly slug: string;
  readonly title: string;
  readonly detail: string;

  constructor(status: number, slug: string, title: string, detail: string) {
    super(`${status} ${title}: ${detail}`);
    this.status = status;
    this.slug = slug;
    this.title = title;
    this.detail = detail;
  }
}

/** Build a problem to throw from a handler: `throw problem(404, 'not-found', 'User not found', detail)`. */
export function problem(status: number, slug: string, title: string, detail: string): HttpProblem {
  return new HttpProblem(status, slug, title, detail);
}

export function sendProblem(res: ServerResponse, p: HttpProblem, instance: string): void {
  const body: Problem = ProblemSchema.parse({
    type: `${PROBLEM_BASE}${p.slug}`,
    title: p.title,
    status: p.status,
    detail: p.detail,
    instance,
  });
  res.writeHead(p.status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify(body));
}
