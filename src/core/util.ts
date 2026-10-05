import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ConfigSchema = z.object({
  maxTurns: z.number().int().min(1).default(40),
  protectedBranches: z.array(z.string()).default(['main', 'master']),
  branchPrefix: z.string().default('harness/'),
  compaction: z
    .object({ keepRecentToolResults: z.number().int().min(0).default(2), elideArgsOverChars: z.number().int().min(20).default(200) })
    .default({ keepRecentToolResults: 2, elideArgsOverChars: 200 }),
  readFileMaxLines: z.number().int().min(10).default(120),
  disabledPlugins: z.array(z.string()).default([]),
});
export type HarnessConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): HarnessConfig {
  const file = join(REPO_ROOT, 'harness.config.json');
  const raw: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return ConfigSchema.parse(raw);
}

/** Deterministic token estimate used for both baseline and actual so the ratio is apples to apples. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeText(file: string, text: string): void {
  ensureDir(dirname(file));
  writeFileSync(file, text);
}

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'runs']);

/** Workspace-relative posix paths of every file under root. */
export function listFilesRec(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) visit(abs);
      else out.push(toPosix(relative(root, abs)));
    }
  };
  visit(root);
  return out;
}

/** Minimal glob: `**` any depth, `*` within a segment. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if ('.+?^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

export function hashFiles(root: string, rels: readonly string[]): string {
  const h = createHash('sha256');
  for (const rel of [...rels].sort()) {
    h.update(rel);
    h.update(readFileSync(join(root, rel)));
  }
  return h.digest('hex');
}

export function hashDir(dir: string): string {
  return hashFiles(dir, listFilesRec(dir));
}

export function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

export function truncateLines(text: string, max: number): string {
  const lines = text.split('\n');
  return lines.length <= max ? text : `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more lines`;
}
