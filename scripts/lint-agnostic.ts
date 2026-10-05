// Model-agnosticism lint: provider names, model names and vendor tool-schema shapes must not
// appear in task files, the core engine, hooks, rules, validators, plugin tools or context.
// Only drivers/ (and the offline test provider) may know a vendor exists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFilesRec, REPO_ROOT } from '../src/core/util.ts';

const GUARDED = ['tasks', 'src/core', 'plugins', 'context'];
const LEAKS: [RegExp, string][] = [
  [/\b(claude|anthropic|openai|chatgpt|gpt-?\d[\w.-]*|sonnet|opus|haiku|gemini)\b/i, 'provider or model name'],
  [/\binput_schema\b|\btool_use\b|\btool_choice\b|\bfunction_call\b|"type":\s*"function"|\btool_calls\b/, 'vendor tool-schema shape'],
  [/\b(ANTHROPIC|OPENAI)_[A-Z_]+\b/, 'provider environment variable'],
];

export function findLeaks(): string[] {
  const out: string[] = [];
  for (const dir of GUARDED) {
    for (const rel of listFilesRec(join(REPO_ROOT, dir))) {
      const file = `${dir}/${rel}`;
      readFileSync(join(REPO_ROOT, file), 'utf8').split('\n').forEach((line, i) => {
        for (const [re, what] of LEAKS) {
          const m = re.exec(line);
          if (m !== null) out.push(`${file}:${i + 1}  ${what}: '${m[0]}'`);
        }
      });
    }
  }
  return out;
}

if (import.meta.main) {
  const leaks = findLeaks();
  for (const l of leaks) process.stdout.write(`model-agnostic  FAIL  ${l}\n`);
  process.stdout.write(leaks.length === 0 ? `model-agnostic  pass  ${GUARDED.join(', ')} name no provider\n` : `model-agnostic  FAIL  ${leaks.length} leaks\n`);
  process.exit(leaks.length === 0 ? 0 : 1);
}
