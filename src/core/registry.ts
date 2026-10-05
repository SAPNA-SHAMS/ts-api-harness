// Plugin discovery. Dropping a .ts file into a plugin folder, or listing a module in
// plugins/registry.json, registers it on the next run. The engine never names a plugin.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DriverDef, HookDef, RuleDef, ToolDef } from './sdk.ts';
import { loadConfig, REPO_ROOT, toPosix } from './util.ts';

export const PLUGIN_FOLDERS = ['plugins/tools', 'plugins/rules', 'plugins/validators', 'plugins/hooks', 'drivers'] as const;
export const REGISTRY_MANIFEST = 'plugins/registry.json';

export type Registry = {
  tools: Map<string, ToolDef>;
  rules: RuleDef[];
  hooks: HookDef[];
  drivers: Map<string, DriverDef>;
  loaded: { kind: string; id: string; file: string }[];
  errors: string[];
};

type AnyPlugin = ToolDef | RuleDef | HookDef | DriverDef;

function isPlugin(value: unknown): value is AnyPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'tool' || kind === 'rule' || kind === 'validator' || kind === 'hook' || kind === 'driver';
}

function pluginId(p: AnyPlugin): string {
  return p.kind === 'tool' ? p.name : p.id;
}

function discover(root: string): string[] {
  const files: string[] = [];
  for (const folder of PLUGIN_FOLDERS) {
    const dir = join(root, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.ts') || name.endsWith('.d.ts') || name.endsWith('.test.ts') || name.startsWith('_')) continue;
      files.push(join(dir, name));
    }
  }
  const manifest = join(root, REGISTRY_MANIFEST);
  if (existsSync(manifest)) {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const modules = typeof parsed === 'object' && parsed !== null ? (parsed as { modules?: unknown }).modules : undefined;
    if (Array.isArray(modules)) {
      for (const m of modules) if (typeof m === 'string') files.push(resolve(root, m));
    }
  }
  return [...new Set(files)];
}

const cache = new Map<string, Promise<Registry>>();

export function loadRegistry(root: string = REPO_ROOT): Promise<Registry> {
  const hit = cache.get(root);
  if (hit !== undefined) return hit;
  const pending = doLoad(root);
  cache.set(root, pending);
  return pending;
}

async function doLoad(root: string): Promise<Registry> {
  const disabled = new Set(loadConfig().disabledPlugins);
  const reg: Registry = { tools: new Map(), rules: [], hooks: [], drivers: new Map(), loaded: [], errors: [] };
  for (const file of discover(root)) {
    const rel = toPosix(file.startsWith(root) ? file.slice(root.length + 1) : file);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (err) {
      reg.errors.push(`${rel}: failed to load: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const exported = [mod['default'], ...Object.entries(mod).filter(([k]) => k !== 'default').map(([, v]) => v)];
    const plugins = exported.filter(isPlugin);
    if (plugins.length === 0) {
      reg.errors.push(`${rel}: exports no plugin (use defineTool/defineRule/defineValidator/defineHook/defineDriver)`);
      continue;
    }
    for (const p of new Set(plugins)) {
      const id = pluginId(p);
      if (disabled.has(id)) continue;
      reg.loaded.push({ kind: p.kind, id, file: rel });
      switch (p.kind) {
        case 'tool':
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p.name)) reg.errors.push(`${rel}: tool name '${p.name}' must match [a-zA-Z0-9_-]{1,64}`);
          else if (reg.tools.has(p.name)) reg.errors.push(`${rel}: duplicate tool '${p.name}'`);
          else reg.tools.set(p.name, p);
          break;
        case 'rule':
        case 'validator':
          if (reg.rules.some((r) => r.id === p.id)) reg.errors.push(`${rel}: duplicate rule '${p.id}'`);
          else reg.rules.push(p);
          break;
        case 'hook':
          reg.hooks.push(p);
          break;
        case 'driver':
          reg.drivers.set(p.id, p);
          break;
      }
    }
  }
  return reg;
}
