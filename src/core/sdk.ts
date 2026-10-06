// The plugin contract. Plugins (tools, rules, ORM validators, hooks, drivers) import from
// here and are discovered from their folders; nothing in src/core names a plugin.
import type ts from 'typescript';

// ---------------------------------------------------------------- model-neutral types

/** A JSON Schema object describing tool arguments. Drivers translate it to their wire format. */
export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolSpec = { name: string; description: string; parameters: JsonSchema };
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type ToolResultMsg = { callId: string; name: string; content: string };

export type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResultMsg[] };

export type ModelRequest = { system: string; messages: Message[]; tools: ToolSpec[]; maxOutputTokens: number };

export type ModelResponse = {
  text: string;
  toolCalls: ToolCall[];
  stop: 'tools' | 'end' | 'length';
  usage: { inputTokens: number; outputTokens: number };
  /** Opaque label for reports only (e.g. the model id the driver used). Never read by the engine. */
  model?: string;
};

/** The only thing the engine knows about a model provider. */
export interface ModelDriver {
  readonly id: string;
  run(request: ModelRequest): Promise<ModelResponse>;
}

export type DriverDef = {
  kind: 'driver';
  id: string;
  /** Build a driver from environment variables; throw with a clear message if keys are missing. */
  create: (env: NodeJS.ProcessEnv) => ModelDriver;
};

// ---------------------------------------------------------------- tasks

export type FieldType = 'string' | 'email' | 'integer' | 'number' | 'boolean' | 'datetime';
export type Behavior = 'create' | 'get' | 'list' | 'update' | 'delete';
export type ExpectedRoute = { method: string; path: string; behavior: Behavior };

export type TaskInfo = {
  name: string;
  mode: 'greenfield' | 'brownfield';
  description: string;
  resource: string;
  /** Routes the task says must exist after the change (greenfield: all; brownfield: additions). */
  expectedRoutes: ExpectedRoute[];
  allowBreaking: string[];
  raw: unknown;
};

// ---------------------------------------------------------------- tools

export type ToolStatus = 'ok' | 'pass' | 'fail' | 'red' | 'green' | 'blocked' | 'error' | 'unproven' | 'refused';

export type ToolOutput = {
  status: ToolStatus;
  /** One line. Survives compaction. */
  summary: string;
  /** What the model sees in JIT mode. Defaults to summary. */
  compact?: string;
  /** Full output. Written to disk; sent to the model only in baseline mode. */
  raw?: string;
  /** Keep the compact form verbatim for the whole run (small, always-needed context such as the task). */
  pin?: boolean;
};

export type ToolContext = {
  workspace: string;
  task: TaskInfo;
  mode: 'jit' | 'baseline';
  /** Workspace-relative paths of every file (excluding node_modules). */
  listFiles: () => string[];
  readText: (rel: string) => string | undefined;
  /** Files as they were when the run started (brownfield diffing). */
  initialText: (rel: string) => string | undefined;
  runStandards: (opts?: { fastOnly?: boolean }) => Promise<StandardsReport>;
  repoRoot: string;
};

export type ToolDef = {
  kind: 'tool';
  name: string;
  description: string;
  parameters: JsonSchema;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput> | ToolOutput;
};

// ---------------------------------------------------------------- standards rules / validators

export type SourceInfo = {
  rel: string;
  text: string;
  sf: ts.SourceFile;
  /** Harness-owned library code (src/lib/**). */
  isLib: boolean;
  isTest: boolean;
  line: (pos: number) => number;
};

export type RouteInfo = {
  file: SourceInfo;
  line: number;
  method: string;
  path: string;
  status: number | undefined;
  idempotent: boolean;
  errors: number[];
  /** Source text of each boundary schema expression, or undefined when absent. */
  schemas: { params?: string; query?: string; body?: string; response?: string };
  /** Field names of the body/response object schemas when statically resolvable. */
  bodyFields: { name: string; optional: boolean }[] | undefined;
  responseFields: string[] | undefined;
  handler: ts.Node | undefined;
  node: ts.ObjectLiteralExpression;
};

export type Finding = { file: string; line: number; message: string };

export type TscResult = { ran: boolean; errors: Finding[]; reason?: string; log: string };

export type CheckContext = {
  root: string;
  ts: typeof ts;
  files: SourceInfo[];
  src: SourceInfo[];
  tests: SourceInfo[];
  routes: RouteInfo[];
  tsconfig: Record<string, unknown> | undefined;
  /** Text of the `const <name> = ...` initializer anywhere in src, for resolving schema identifiers. */
  resolveConst: (name: string) => string | undefined;
  /** Field names of a z.object schema (by identifier or inline expression). */
  objectFields: (expr: string) => { name: string; optional: boolean }[] | undefined;
  tsc: () => Promise<TscResult>;
  task: TaskInfo | undefined;
  readText: (rel: string) => string | undefined;
};

export type RuleStatus = 'pass' | 'fail' | 'unproven' | 'n/a';

export type RuleResult = {
  status: RuleStatus;
  passed: number;
  total: number;
  /** e.g. "handlers", "error paths", "routes". */
  unit: string;
  /** Files this rule looked at; each gets its own pass/fail line. */
  files: string[];
  findings: Finding[];
  note?: string;
};

export type RuleDef = {
  kind: 'rule' | 'validator';
  id: string;
  description: string;
  /** Slow rules (e.g. a compiler run) are skipped by per-write hooks and only run at gates. */
  slow?: boolean;
  run: (ctx: CheckContext) => Promise<RuleResult> | RuleResult;
};

export type RuleOutcome = RuleResult & { id: string; kind: 'rule' | 'validator'; description: string };

export type StandardsReport = {
  root: string;
  rules: RuleOutcome[];
  verdict: { status: 'pass' | 'fail' | 'unproven'; percent: number; passing: number; applicable: number };
};

/** Builds a RuleResult from findings: status is fail when any finding exists, n/a when nothing was checked. */
export function ruleResult(r: { unit: string; total: number; files: string[]; findings: Finding[]; note?: string; failedUnits?: number }): RuleResult {
  const failedUnits = r.failedUnits ?? r.findings.length;
  const passed = Math.max(0, r.total - failedUnits);
  const status: RuleStatus = r.findings.length > 0 ? 'fail' : r.total === 0 ? 'n/a' : 'pass';
  return { status, passed, total: r.total, unit: r.unit, files: r.files, findings: r.findings, ...(r.note === undefined ? {} : { note: r.note }) };
}

// ---------------------------------------------------------------- hooks

export type HookEvent = {
  phase: 'pre' | 'post';
  tool: string;
  args: Record<string, unknown>;
  /** Present on post hooks. */
  output?: ToolOutput;
  ctx: ToolContext;
};

export type HookDecision = { decision: 'pass' | 'block' | 'record'; feedback?: string };

export type HookDef = {
  kind: 'hook';
  id: string;
  phase: 'pre' | 'post';
  /** Tool names this hook watches, or '*'. */
  tools: string[] | '*';
  run: (event: HookEvent) => Promise<HookDecision> | HookDecision;
};

// ---------------------------------------------------------------- define helpers

export const defineTool = (t: Omit<ToolDef, 'kind'>): ToolDef => ({ kind: 'tool', ...t });
export const defineRule = (r: Omit<RuleDef, 'kind'>): RuleDef => ({ kind: 'rule', ...r });
export const defineValidator = (r: Omit<RuleDef, 'kind'>): RuleDef => ({ kind: 'validator', ...r });
export const defineHook = (h: Omit<HookDef, 'kind'>): HookDef => ({ kind: 'hook', ...h });
export const defineDriver = (d: Omit<DriverDef, 'kind'>): DriverDef => ({ kind: 'driver', ...d });

/** Helper for rules/validators: walk every node of a source file. */
export function walk(node: ts.Node, visit: (n: ts.Node) => void, tsApi: typeof ts): void {
  visit(node);
  tsApi.forEachChild(node, (child) => walk(child, visit, tsApi));
}
