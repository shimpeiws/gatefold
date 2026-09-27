import { sanitizeText } from "../domain/sanitize.js";
import {
  InputTooLargeError,
  MAX_INPUT_BYTES,
  readBounded,
  readBoundedStdin,
} from "./bounded.js";
import { PflExportError, STDIN_SOURCE } from "./pfl-export.js";

/** The only accepted trace compatibility token (docs/yuurei-trace-contract.md). */
export const TRACE_SCHEMA_VERSION = "0.3";

export interface YuureiTraceRuntime {
  readonly id: string;
  readonly version: string | null;
}

export type YuureiTraceResolvedReason =
  | "observed"
  | "unobserved"
  | "parse_failed";

export interface YuureiTraceModel {
  readonly requested: string;
  readonly resolved: string | null;
  readonly resolvedReason?: YuureiTraceResolvedReason;
}

export interface YuureiTraceProfile {
  readonly name: string;
  readonly digest: string;
}

export interface YuureiTraceTask {
  readonly source: string;
  readonly digest: string;
}

export interface YuureiTraceIsolation {
  readonly strategy: string;
  readonly verified: boolean;
}

export interface YuureiTraceExecution {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly timedOut: boolean;
}

export interface YuureiTraceCost {
  readonly amount: number;
  readonly currency: string;
}

export interface YuureiTraceArtifact {
  readonly path: string;
  readonly kind: string;
}

export interface YuureiTraceRequestedCell {
  readonly digest: string;
  readonly inputsVersion: number;
}

export interface YuureiTraceExecutionOptions {
  readonly timeoutMs: number | null;
  readonly runtime: Readonly<Record<string, unknown>>;
}

export interface YuureiTraceDefinition {
  readonly run: string | null;
  readonly cliOverrides: readonly string[];
}

/**
 * Seeded-workspace baseline identity (docs/yuurei-seeded-run-contract.md):
 * the digest the run was asked to materialize and the digest actually
 * materialized. Shipped yuurei records both; they are identical on any
 * successfully seeded run.
 */
export interface YuureiSeedBaseline {
  readonly requestedDigest: string;
  readonly materializedDigest: string;
  readonly files: number;
  readonly bytes: number;
}

/**
 * Recorded change-set counts. Absent when change collection did not
 * complete — absence never means "no changes".
 */
export interface YuureiSeedChanges {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
}

/**
 * Seeded-workspace provenance (docs/yuurei-seeded-run-contract.md): the
 * identity of the tree materialized into the cell before execution. A trace
 * carrying `seed` is a seeded run; one without it is a legacy
 * empty-workspace run.
 */
export interface YuureiTraceSeed {
  readonly policy: string;
  readonly source: string;
  readonly head: string;
  readonly baseline: YuureiSeedBaseline;
  readonly changes?: YuureiSeedChanges;
}

export type YuureiPatchBase = "empty" | "seeded";
export type YuureiPatchState = "complete" | "partial" | "absent";

/**
 * The durable patch-completeness record
 * (docs/yuurei-seeded-run-contract.md): which workspace the patch diffs
 * against and whether the stored record describes every recorded change.
 * A verified digest proves stored bytes match the manifest; only
 * `state: "complete"` certifies the patch covers the full change set.
 * Absent on traces written before the record shipped — completeness is
 * then inferred from the manifest's `truncated` flag and `patch:`
 * diagnostics.
 */
export interface YuureiTracePatch {
  readonly base: YuureiPatchBase;
  readonly state: YuureiPatchState;
}

/**
 * A validated yuurei `trace.json` document. Optional fields keep their
 * absent-vs-null distinction: absent optional fields are `undefined`
 * (unknown), while fields the trace records as `null` stay `null`
 * (unobserved). `document` is the raw parsed object — the evidence source
 * that claim pointers resolve against; consumers must not mutate it.
 */
export interface YuureiTrace {
  readonly sourcePath: string;
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runtime: YuureiTraceRuntime;
  readonly model: YuureiTraceModel;
  readonly profile: YuureiTraceProfile;
  readonly task: YuureiTraceTask;
  readonly isolation: YuureiTraceIsolation;
  readonly execution: YuureiTraceExecution;
  readonly usage: Readonly<Record<string, number | null>>;
  readonly cost: YuureiTraceCost | null;
  readonly artifacts: readonly YuureiTraceArtifact[];
  readonly yuureiVersion?: string;
  readonly requestedCell?: YuureiTraceRequestedCell;
  readonly executionOptions?: YuureiTraceExecutionOptions;
  readonly definition?: YuureiTraceDefinition;
  readonly seed?: YuureiTraceSeed;
  readonly patch?: YuureiTracePatch;
  readonly diagnostics: readonly string[];
  readonly document: unknown;
}

/** Resource ceilings for untrusted traces (docs/yuurei-trace-contract.md). */
const MAX_ARTIFACTS = 10_000;
const MAX_DIAGNOSTICS = 10_000;
const MAX_USAGE_KEYS = 1_000;
const MAX_CLI_OVERRIDES = 1_000;
const MAX_RUNTIME_OPTION_KEYS = 1_000;
const MAX_RUNTIME_OPTION_DEPTH = 12;
const MAX_RUNTIME_OPTION_NODES = 10_000;
/** Ceiling for any scalar string carried by a trace. */
const MAX_SCALAR_CHARS = 4_096;

const RESOLVED_REASONS = ["observed", "unobserved", "parse_failed"] as const;
const PATCH_BASES = ["empty", "seeded"] as const;
const PATCH_STATES = ["complete", "partial", "absent"] as const;
/** The only `seed.policy` the shipped seeded workspace accepts. */
const SEED_POLICY = "git-tracked-files";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shapeError(field: string, expected: string): PflExportError {
  return new PflExportError(
    "invalid-shape",
    `yuurei trace field ${field} must be ${expected}`,
  );
}

/** Required non-empty string capped at MAX_SCALAR_CHARS. */
function stringField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0)
    throw shapeError(path, "a non-empty string");
  if (value.length > MAX_SCALAR_CHARS)
    throw shapeError(
      path,
      `a string of at most ${MAX_SCALAR_CHARS} characters`,
    );
  return value;
}

/**
 * Required string that may be empty. Provenance fields (a task source, a
 * profile name) describe where content came from and carry no identity.
 */
function boundedStringField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): string {
  const value = record[key];
  if (typeof value !== "string") throw shapeError(path, "a string");
  if (value.length > MAX_SCALAR_CHARS)
    throw shapeError(
      path,
      `a string of at most ${MAX_SCALAR_CHARS} characters`,
    );
  return value;
}

/** Required key whose value is a bounded string or explicit null. */
function nullableStringField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): string | null {
  if (!(key in record))
    throw shapeError(path, "a required key (its value may be null)");
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") throw shapeError(path, "a string or null");
  if (value.length > MAX_SCALAR_CHARS)
    throw shapeError(
      path,
      `a string of at most ${MAX_SCALAR_CHARS} characters`,
    );
  return value;
}

/** Required key whose value is a number or explicit null. */
function nullableNumberField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): number | null {
  if (!(key in record))
    throw shapeError(path, "a required key (its value may be null)");
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number") throw shapeError(path, "a number or null");
  if (!Number.isFinite(value))
    throw shapeError(path, "a finite number or null");
  return value;
}

/** Required key whose value is a safe integer or explicit null. */
function nullableIntField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): number | null {
  const value = nullableNumberField(record, key, path);
  if (value !== null && !Number.isSafeInteger(value))
    throw shapeError(path, "an integer or null");
  return value;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw shapeError(path, "a boolean");
  return value;
}

function intField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw shapeError(path, "an integer");
  return value;
}

function requiredRecord(
  record: Record<string, unknown>,
  key: string,
  path = key,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw shapeError(path, "an object");
  return value;
}

/**
 * Walks the adapter-owned `execution_options.runtime` record: bounded safe
 * JSON (string, number, boolean, null, arrays, string-keyed objects) within
 * the depth and node ceilings. Pure validation — the record is carried
 * verbatim, never turned into prose.
 */
function checkRuntimeOptions(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_RUNTIME_OPTION_NODES)
    throw shapeError(
      path,
      `a runtime option tree with at most ${MAX_RUNTIME_OPTION_NODES} nodes`,
    );
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw shapeError(path, "a finite number");
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_SCALAR_CHARS)
      throw shapeError(
        path,
        `a string of at most ${MAX_SCALAR_CHARS} characters`,
      );
    return;
  }
  if (Array.isArray(value)) {
    if (depth > MAX_RUNTIME_OPTION_DEPTH)
      throw shapeError(
        path,
        `a runtime option tree nested no deeper than ${MAX_RUNTIME_OPTION_DEPTH} levels`,
      );
    for (const [index, item] of value.entries())
      checkRuntimeOptions(item, `${path}[${index}]`, depth + 1, budget);
    return;
  }
  if (isRecord(value)) {
    if (depth > MAX_RUNTIME_OPTION_DEPTH)
      throw shapeError(
        path,
        `a runtime option tree nested no deeper than ${MAX_RUNTIME_OPTION_DEPTH} levels`,
      );
    for (const [key, item] of Object.entries(value)) {
      if (key.length > MAX_SCALAR_CHARS)
        throw shapeError(
          `${path}.${key.slice(0, 32)}…`,
          `a key of at most ${MAX_SCALAR_CHARS} characters`,
        );
      checkRuntimeOptions(item, `${path}.${key}`, depth + 1, budget);
    }
    return;
  }
  throw shapeError(
    path,
    "safe JSON (string, number, boolean, null, array, or object)",
  );
}

function parseUsage(value: unknown): Readonly<Record<string, number | null>> {
  if (!isRecord(value)) throw shapeError("usage", "an object");
  const keys = Object.keys(value);
  if (keys.length > MAX_USAGE_KEYS)
    throw shapeError("usage", `an object with at most ${MAX_USAGE_KEYS} keys`);
  const usage = Object.create(null) as Record<string, number | null>;
  for (const key of keys) {
    if (key.length > MAX_SCALAR_CHARS)
      throw shapeError(
        `usage.${key.slice(0, 32)}…`,
        `a key of at most ${MAX_SCALAR_CHARS} characters`,
      );
    const entry = value[key];
    if (entry !== null && typeof entry !== "number")
      throw shapeError(`usage.${key}`, "a number or null");
    if (typeof entry === "number" && !Number.isFinite(entry))
      throw shapeError(`usage.${key}`, "a finite number or null");
    usage[key] = entry;
  }
  return usage;
}

function parseCost(value: unknown): YuureiTraceCost | null {
  if (value === null) return null;
  if (!isRecord(value)) throw shapeError("cost", "an object or null");
  const amount = value.amount;
  if (typeof amount !== "number") throw shapeError("cost.amount", "a number");
  if (!Number.isFinite(amount))
    throw shapeError("cost.amount", "a finite number");
  return {
    amount,
    currency: stringField(value, "currency", "cost.currency"),
  };
}

function parseArtifacts(value: unknown): readonly YuureiTraceArtifact[] {
  if (!Array.isArray(value)) throw shapeError("artifacts", "an array");
  if (value.length > MAX_ARTIFACTS)
    throw shapeError(
      "artifacts",
      `an array with at most ${MAX_ARTIFACTS} items`,
    );
  return value.map((item, index) => {
    const at = `artifacts[${index}]`;
    if (!isRecord(item)) throw shapeError(at, "an object");
    return {
      path: boundedStringField(item, "path", `${at}.path`),
      kind: boundedStringField(item, "kind", `${at}.kind`),
    };
  });
}

function parseRequestedCell(
  value: unknown,
): YuureiTraceRequestedCell | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw shapeError("requested_cell", "an object");
  return {
    digest: stringField(value, "digest", "requested_cell.digest"),
    inputsVersion: intField(
      value,
      "inputs_version",
      "requested_cell.inputs_version",
    ),
  };
}

function parseExecutionOptions(
  value: unknown,
): YuureiTraceExecutionOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw shapeError("execution_options", "an object");
  const timeoutMs = nullableIntField(
    value,
    "timeout_ms",
    "execution_options.timeout_ms",
  );
  const runtime = requiredRecord(value, "runtime", "execution_options.runtime");
  const runtimeKeys = Object.keys(runtime);
  if (runtimeKeys.length > MAX_RUNTIME_OPTION_KEYS)
    throw shapeError(
      "execution_options.runtime",
      `an object with at most ${MAX_RUNTIME_OPTION_KEYS} keys`,
    );
  checkRuntimeOptions(runtime, "execution_options.runtime", 1, { nodes: 0 });
  return { timeoutMs, runtime };
}

function parseDefinition(value: unknown): YuureiTraceDefinition | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw shapeError("definition", "an object");
  const overrides = value.cli_overrides;
  if (!Array.isArray(overrides))
    throw shapeError("definition.cli_overrides", "an array");
  if (overrides.length > MAX_CLI_OVERRIDES)
    throw shapeError(
      "definition.cli_overrides",
      `an array with at most ${MAX_CLI_OVERRIDES} items`,
    );
  for (const [index, entry] of overrides.entries()) {
    const at = `definition.cli_overrides[${index}]`;
    if (typeof entry !== "string" || entry.length === 0)
      throw shapeError(at, "a non-empty string");
    if (entry.length > MAX_SCALAR_CHARS)
      throw shapeError(
        at,
        `a string of at most ${MAX_SCALAR_CHARS} characters`,
      );
  }
  return {
    run: nullableStringField(value, "run", "definition.run"),
    cliOverrides: overrides as string[],
  };
}

function parseSeedChanges(
  value: Record<string, unknown>,
): YuureiSeedChanges | undefined {
  if (value.changes === undefined) return undefined;
  if (!isRecord(value.changes)) throw shapeError("seed.changes", "an object");
  return {
    added: nonNegativeIntField(value.changes, "added", "seed.changes.added"),
    modified: nonNegativeIntField(
      value.changes,
      "modified",
      "seed.changes.modified",
    ),
    deleted: nonNegativeIntField(
      value.changes,
      "deleted",
      "seed.changes.deleted",
    ),
  };
}

function parseSeed(value: unknown): YuureiTraceSeed | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw shapeError("seed", "an object");
  const policy = stringField(value, "policy", "seed.policy");
  if (policy !== SEED_POLICY)
    throw shapeError("seed.policy", `"${SEED_POLICY}"`);
  const baseline = requiredRecord(value, "baseline", "seed.baseline");
  const changes = parseSeedChanges(value);
  return {
    policy,
    source: stringField(value, "source", "seed.source"),
    head: stringField(value, "head", "seed.head"),
    baseline: {
      requestedDigest: stringField(
        baseline,
        "requested_digest",
        "seed.baseline.requested_digest",
      ),
      materializedDigest: stringField(
        baseline,
        "materialized_digest",
        "seed.baseline.materialized_digest",
      ),
      files: nonNegativeIntField(baseline, "files", "seed.baseline.files"),
      bytes: nonNegativeIntField(baseline, "bytes", "seed.baseline.bytes"),
    },
    ...(changes === undefined ? {} : { changes }),
  };
}

function nonNegativeIntField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): number {
  const value = intField(record, key, path);
  if (value < 0) throw shapeError(path, "a non-negative integer");
  return value;
}

function parseTracePatch(value: unknown): YuureiTracePatch | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw shapeError("patch", "an object");
  const base = value.base;
  if (
    typeof base !== "string" ||
    !(PATCH_BASES as readonly string[]).includes(base)
  )
    throw shapeError(
      "patch.base",
      `one of ${PATCH_BASES.map((s) => `"${s}"`).join(", ")}`,
    );
  const state = value.state;
  if (
    typeof state !== "string" ||
    !(PATCH_STATES as readonly string[]).includes(state)
  )
    throw shapeError(
      "patch.state",
      `one of ${PATCH_STATES.map((s) => `"${s}"`).join(", ")}`,
    );
  return {
    base: base as YuureiPatchBase,
    state: state as YuureiPatchState,
  };
}

function parseDiagnostics(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw shapeError("diagnostics", "an array");
  if (value.length > MAX_DIAGNOSTICS)
    throw shapeError(
      "diagnostics",
      `an array with at most ${MAX_DIAGNOSTICS} items`,
    );
  return value.map((item, index) => {
    const at = `diagnostics[${index}]`;
    if (typeof item !== "string") throw shapeError(at, "a string");
    if (item.length > MAX_SCALAR_CHARS)
      throw shapeError(
        at,
        `a string of at most ${MAX_SCALAR_CHARS} characters`,
      );
    return item;
  });
}

/**
 * Validates a parsed JSON value against the yuurei trace contract
 * (docs/yuurei-trace-contract.md). Pure: no I/O. The returned trace keeps the
 * raw document as `document` so claim evidence can resolve against it.
 */
export function parseYuureiTrace(
  value: unknown,
  sourcePath: string,
): YuureiTrace {
  if (!isRecord(value))
    throw new PflExportError(
      "invalid-shape",
      "yuurei trace must contain an object at the top level",
    );
  // A document of a different supported kind passed where a trace is expected
  // (for example a pfl export) is a kind mismatch, not a bad token. The check
  // reads the pfl envelope — a pfl command or `pflVersion`, with no trace
  // `schema_version` — so a trace carrying one of those names as an unknown
  // additive field is still accepted: the trace contract ignores unknown
  // fields.
  const command = value.command;
  const isPflCommand =
    command === "report" || command === "export" || command === "diff";
  if (
    !("schema_version" in value) &&
    (isPflCommand || typeof value.pflVersion === "string")
  )
    throw new PflExportError(
      "mismatched-inputs",
      isPflCommand
        ? `expected a yuurei trace document but got a pfl ${command} document`
        : "expected a yuurei trace document but got a pfl document",
    );
  const schemaVersion = value.schema_version;
  if (typeof schemaVersion !== "string" || schemaVersion.length === 0)
    throw shapeError("schema_version", "a non-empty string");
  // The token is a compatibility class compared for equality only — never
  // ordered — so any other token is rejected rather than guessed at.
  if (schemaVersion !== TRACE_SCHEMA_VERSION)
    throw new PflExportError(
      "unsupported-version",
      `unsupported trace schema_version: ${schemaVersion} (supported: ${TRACE_SCHEMA_VERSION})`,
    );

  const runtime = requiredRecord(value, "runtime");
  const model = requiredRecord(value, "model");
  const resolvedReason = model.resolved_reason;
  if (
    resolvedReason !== undefined &&
    (typeof resolvedReason !== "string" ||
      !(RESOLVED_REASONS as readonly string[]).includes(resolvedReason))
  )
    throw shapeError(
      "model.resolved_reason",
      `one of ${RESOLVED_REASONS.map((r) => `"${r}"`).join(", ")}`,
    );
  const profile = requiredRecord(value, "profile");
  const task = requiredRecord(value, "task");
  const isolation = requiredRecord(value, "isolation");
  const execution = requiredRecord(value, "execution");
  if (!("cost" in value))
    throw shapeError("cost", "a required key (its value may be null)");

  const yuureiVersion = value.yuurei_version;
  if (
    yuureiVersion !== undefined &&
    (typeof yuureiVersion !== "string" ||
      yuureiVersion.length === 0 ||
      yuureiVersion.length > MAX_SCALAR_CHARS)
  )
    throw shapeError(
      "yuurei_version",
      `a non-empty string of at most ${MAX_SCALAR_CHARS} characters`,
    );

  return {
    sourcePath: sanitizeText(sourcePath),
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId: stringField(value, "run_id", "run_id"),
    startedAt: stringField(value, "started_at", "started_at"),
    finishedAt: stringField(value, "finished_at", "finished_at"),
    runtime: {
      id: stringField(runtime, "id", "runtime.id"),
      version: nullableStringField(runtime, "version", "runtime.version"),
    },
    model: {
      requested: stringField(model, "requested", "model.requested"),
      resolved: nullableStringField(model, "resolved", "model.resolved"),
      ...(resolvedReason === undefined
        ? {}
        : { resolvedReason: resolvedReason as YuureiTraceResolvedReason }),
    },
    profile: {
      name: boundedStringField(profile, "name", "profile.name"),
      digest: stringField(profile, "digest", "profile.digest"),
    },
    task: {
      source: boundedStringField(task, "source", "task.source"),
      digest: stringField(task, "digest", "task.digest"),
    },
    isolation: {
      strategy: stringField(isolation, "strategy", "isolation.strategy"),
      verified: booleanField(isolation, "verified", "isolation.verified"),
    },
    execution: {
      exitCode: nullableNumberField(
        execution,
        "exit_code",
        "execution.exit_code",
      ),
      signal: nullableStringField(execution, "signal", "execution.signal"),
      durationMs: nullableNumberField(
        execution,
        "duration_ms",
        "execution.duration_ms",
      ),
      timedOut: booleanField(execution, "timed_out", "execution.timed_out"),
    },
    usage: parseUsage(value.usage),
    cost: parseCost(value.cost),
    artifacts: parseArtifacts(value.artifacts),
    ...(yuureiVersion === undefined ? {} : { yuureiVersion }),
    ...(value.requested_cell === undefined
      ? {}
      : { requestedCell: parseRequestedCell(value.requested_cell) }),
    ...(value.execution_options === undefined
      ? {}
      : { executionOptions: parseExecutionOptions(value.execution_options) }),
    ...(value.definition === undefined
      ? {}
      : { definition: parseDefinition(value.definition) }),
    ...(value.seed === undefined ? {} : { seed: parseSeed(value.seed) }),
    ...(value.patch === undefined
      ? {}
      : { patch: parseTracePatch(value.patch) }),
    diagnostics: parseDiagnostics(value.diagnostics),
    document: value,
  };
}

function parseTraceContent(
  content: string,
  invalidJsonMessage: string,
  sourcePath: string,
): YuureiTrace {
  // A leading UTF-8 BOM (U+FEFF) is part of the transport encoding, not the
  // document: strip exactly one. A BOM anywhere else stays invalid JSON.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PflExportError("invalid-json", invalidJsonMessage);
  }

  return parseYuureiTrace(value, sourcePath);
}

export async function readYuureiTrace(path: string): Promise<YuureiTrace> {
  let content: string;
  try {
    content = (await readBounded(path)).toString("utf8");
  } catch (error) {
    if (error instanceof InputTooLargeError)
      throw new PflExportError(
        "invalid-shape",
        `input file exceeds the ${MAX_INPUT_BYTES}-byte limit: ${path}`,
      );
    throw new PflExportError(
      "unreadable-file",
      `cannot read input file: ${path}`,
    );
  }

  return parseTraceContent(
    content,
    `input file is not valid JSON: ${path}`,
    path,
  );
}

export async function readYuureiTraceStdin(
  stream: AsyncIterable<Buffer | string> = process.stdin,
): Promise<YuureiTrace> {
  let content: string;
  try {
    content = (await readBoundedStdin(stream)).toString("utf8");
  } catch (error) {
    if (error instanceof InputTooLargeError)
      throw new PflExportError(
        "invalid-shape",
        `standard input exceeds the ${MAX_INPUT_BYTES}-byte limit`,
      );
    throw new PflExportError("unreadable-file", "cannot read standard input");
  }

  return parseTraceContent(
    content,
    "standard input is not valid JSON",
    STDIN_SOURCE,
  );
}
