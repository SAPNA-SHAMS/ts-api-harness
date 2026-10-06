// JIT context fetcher. With no topic it returns the one-page conventions sheet, pinned for the run
// so the model never needs to fetch it twice; topics give fuller examples on demand.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '../../src/core/sdk.ts';

export default defineTool({
  name: 'get_reference',
  description: 'No topic: the full conventions sheet (pinned). With topic: a fuller example.',
  parameters: { type: 'object', properties: { topic: { type: 'string' } }, additionalProperties: false },
  run(args, ctx) {
    const dir = join(ctx.repoRoot, 'context', 'reference');
    const topics = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
    const topic = typeof args['topic'] === 'string' ? args['topic'] : undefined;
    if (topic === undefined || topic === 'conventions') {
      const sheet = readFileSync(join(ctx.repoRoot, 'context', 'conventions.md'), 'utf8');
      return { status: 'ok', summary: 'conventions sheet', compact: `${sheet}\nTopics with fuller examples: ${topics.join(', ')}, standards`, pin: true };
    }
    if (topic === 'standards') {
      const text = readFileSync(join(ctx.repoRoot, 'context', 'standards.md'), 'utf8');
      return { status: 'ok', summary: 'reference standards', compact: text };
    }
    const file = join(dir, `${topic}.md`);
    if (!existsSync(file)) return { status: 'error', summary: `unknown topic '${topic}'; topics: ${topics.join(', ')}, standards` };
    return { status: 'ok', summary: `reference ${topic}`, compact: readFileSync(file, 'utf8') };
  },
});
