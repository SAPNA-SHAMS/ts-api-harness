// Pre-write hook (brownfield): tests that existed before the run may grow but never shrink.
// Removing test cases or assertions to get to green is blocked.
import { defineHook } from '../../src/core/sdk.ts';

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;
const TESTS = /\btest\(|\bit\(/g;
const ASSERTS = /\bassert(\.\w+)?\(/g;

export default defineHook({
  id: 'protect-existing-tests',
  phase: 'pre',
  tools: ['write_file', 'edit_file'],
  run({ tool, args, ctx }) {
    const path = typeof args['path'] === 'string' ? args['path'] : '';
    const before = ctx.initialText(path);
    if (!path.startsWith('test/') || before === undefined) return { decision: 'pass' };
    let after: string;
    if (tool === 'write_file') after = typeof args['content'] === 'string' ? args['content'] : '';
    else {
      const current = ctx.readText(path) ?? '';
      const find = typeof args['find'] === 'string' ? args['find'] : '';
      const replace = typeof args['replace'] === 'string' ? args['replace'] : '';
      after = find.length > 0 ? current.replace(find, () => replace) : current;
    }
    if (count(after, TESTS) < count(before, TESTS) || count(after, ASSERTS) < count(before, ASSERTS)) {
      return { decision: 'block', feedback: `BLOCKED protect-existing-tests: ${path} existed before this change; tests and assertions may be added, not removed` };
    }
    return { decision: 'pass' };
  },
});
