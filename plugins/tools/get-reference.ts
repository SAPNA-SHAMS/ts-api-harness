// JIT context fetcher: one conventions topic at a time instead of a front-loaded style guide.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '../../src/core/sdk.ts';

export default defineTool({
  name: 'get_reference',
  description: 'One conventions topic with an example; no topic lists topics.',
  parameters: { type: 'object', properties: { topic: { type: 'string' } }, additionalProperties: false },
  run(args, ctx) {
    const dir = join(ctx.repoRoot, 'context', 'reference');
    const topics = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
    const topic = typeof args['topic'] === 'string' ? args['topic'] : undefined;
    if (topic === undefined) return { status: 'ok', summary: `topics: ${topics.join(', ')}` };
    if (topic === 'standards') {
      const text = readFileSync(join(ctx.repoRoot, 'context', 'standards.md'), 'utf8');
      return { status: 'ok', summary: 'reference standards', compact: text };
    }
    const file = join(dir, `${topic}.md`);
    if (!existsSync(file)) return { status: 'error', summary: `unknown topic '${topic}'; topics: ${topics.join(', ')}, standards` };
    return { status: 'ok', summary: `reference ${topic}`, compact: readFileSync(file, 'utf8') };
  },
});
