import {
  InputTooLargeError,
  MAX_INPUT_BYTES,
  NotRegularFileError,
  readBounded,
} from "./bounded.js";
import { PflExportError } from "./pfl-export.js";

/**
 * Parser for the v0.7 task-evaluation spec (docs/v0.7-scope.md): the
 * versioned, explicit rubric a run is evaluated against. The spec binds to
 * the task content digest and — when declared — the seeded baseline
 * identity; criteria are evaluated only through the supported declarative
 * kinds, so a spec can never smuggle in executable instructions.
 */
export const TASK_SPEC_VERSION = 1;

/** The deterministic criterion kinds Gatefold evaluates. */
export type CriterionKind =
  | "file-added"
  | "file-modified"
  | "file-deleted"
  | "final-result-exact"
  | "final-result-contains"
  | "final-result-json-field";

/** A criterion whose verdict comes from an external check report. */
export const EXTERNAL_CHECK_KIND = "external-check" as const;

const CRITERION_KINDS: readonly string[] = [
  "file-added",
  "file-modified",
  "file-deleted",
  "final-result-exact",
  "final-result-contains",
  "final-result-json-field",
  EXTERNAL_CHECK_KIND,
];

const KINDS_REQUIRING_PATH: readonly string[] = [
  "file-added",
  "file-modified",
  "file-deleted",
];
const KINDS_REQUIRING_TEXT: readonly string[] = [
  "final-result-exact",
  "final-result-contains",
];

const MAX_CRITERIA = 1_000;
const MAX_SCALAR_CHARS = 4_096;
const MAX_EQUALS_DEPTH = 12;
const MAX_EQUALS_NODES = 10_000;

/** One declared criterion. */
export interface TaskCriterion {
  /** Position of the criterion in the spec's `criteria` array. */
  readonly index: number;
  /** Stable criterion identifier, unique within the spec. */
  readonly id: string;
  readonly kind: CriterionKind | typeof EXTERNAL_CHECK_KIND;
  /** Expected workspace-relative path for `file-*` criteria. */
  readonly path?: string;
  /** Expected text for `final-result-exact`/`final-result-contains`. */
  readonly text?: string;
  /** RFC 6901 pointer for `final-result-json-field`. */
  readonly pointer?: string;
  /** Expected value for `final-result-json-field`. */
  readonly equals?: unknown;
}

/** A validated task-evaluation spec. */
export interface TaskSpec {
  /** The file the spec was read from, sanitized for display. */
  readonly sourcePath: string;
  readonly specVersion: typeof TASK_SPEC_VERSION;
  readonly rubricId: string;
  /** The task content digest the run must record. */
  readonly taskDigest: string;
  /** The seeded baseline digest the run must record, when declared. */
  readonly baselineDigest?: string;
  readonly criteria: readonly TaskCriterion[];
  /** The raw parsed document — the evidence source `spec` pointers resolve against. */
  readonly document: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shapeError(field: string, expected: string): PflExportError {
  return new PflExportError(
    "invalid-shape",
    `task spec field ${field} must be ${expected}`,
  );
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
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

const POINTER_PATTERN = /^$|^(?:\/(?:[^/~]|~0|~1)*)*$/;

/**
 * Bounds one `equals` expectation to the same JSON envelope the other
 * readers enforce — depth and node ceilings plus bounded scalars — so
 * comparing it later (`jsonEquals` recurses) cannot run away on a deeply
 * nested spec value.
 */
function checkEqualsValue(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_EQUALS_NODES)
    throw shapeError(
      path,
      `nested JSON with at most ${MAX_EQUALS_NODES} nodes`,
    );
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > MAX_SCALAR_CHARS)
      throw shapeError(
        path,
        `a string of at most ${MAX_SCALAR_CHARS} characters`,
      );
    return;
  }
  if (depth > MAX_EQUALS_DEPTH)
    throw shapeError(
      path,
      `JSON nested no deeper than ${MAX_EQUALS_DEPTH} levels`,
    );
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      checkEqualsValue(item, `${path}[${index}]`, depth + 1, budget);
    return;
  }
  for (const [key, item] of Object.entries(value))
    checkEqualsValue(item, `${path}.${key}`, depth + 1, budget);
}

/** Validates a parsed JSON value against the task-spec contract. Pure: no I/O. */
export function parseTaskSpec(value: unknown, sourcePath: string): TaskSpec {
  if (!isRecord(value))
    throw new PflExportError(
      "invalid-shape",
      "task spec must contain an object at the top level",
    );
  const specVersion = value.specVersion;
  if (typeof specVersion !== "number" || !Number.isInteger(specVersion))
    throw shapeError("specVersion", "an integer");
  if (specVersion !== TASK_SPEC_VERSION)
    throw new PflExportError(
      "unsupported-version",
      `unsupported task spec specVersion: ${specVersion} (supported: ${TASK_SPEC_VERSION})`,
    );

  const task = value.task;
  if (!isRecord(task)) throw shapeError("task", "an object");
  const baseline = value.baseline;
  let baselineDigest: string | undefined;
  if (baseline !== undefined) {
    if (!isRecord(baseline)) throw shapeError("baseline", "an object");
    baselineDigest = requiredString(baseline, "digest", "baseline.digest");
  }

  const criteria = value.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0)
    throw shapeError("criteria", "a non-empty array");
  if (criteria.length > MAX_CRITERIA)
    throw shapeError("criteria", `an array with at most ${MAX_CRITERIA} items`);
  const seenIds = new Set<string>();
  const parsed = criteria.map((item, index): TaskCriterion => {
    const at = `criteria[${index}]`;
    if (!isRecord(item)) throw shapeError(at, "an object");
    const id = requiredString(item, "id", `${at}.id`);
    if (seenIds.has(id)) throw shapeError(`${at}.id`, "unique within the spec");
    seenIds.add(id);
    const kind = requiredString(item, "kind", `${at}.kind`);
    if (!CRITERION_KINDS.includes(kind))
      throw shapeError(
        `${at}.kind`,
        `one of ${CRITERION_KINDS.map((k) => `"${k}"`).join(", ")}`,
      );
    const criterion: {
      index: number;
      id: string;
      kind: TaskCriterion["kind"];
      path?: string;
      text?: string;
      pointer?: string;
      equals?: unknown;
    } = { index, id, kind: kind as TaskCriterion["kind"] };
    if (KINDS_REQUIRING_PATH.includes(kind)) {
      criterion.path = requiredString(item, "path", `${at}.path`);
      if (criterion.path.startsWith("/") || criterion.path.includes("\0"))
        throw shapeError(
          `${at}.path`,
          "a workspace-relative path (not absolute, no NUL)",
        );
    } else if (KINDS_REQUIRING_TEXT.includes(kind)) {
      criterion.text = requiredString(item, "text", `${at}.text`);
    } else if (kind === "final-result-json-field") {
      criterion.pointer = requiredString(item, "pointer", `${at}.pointer`);
      if (!POINTER_PATTERN.test(criterion.pointer))
        throw shapeError(`${at}.pointer`, "an RFC 6901 JSON Pointer");
      if (!("equals" in item))
        throw shapeError(`${at}.equals`, "a required key");
      checkEqualsValue(item.equals, `${at}.equals`, 0, { nodes: 0 });
      criterion.equals = item.equals;
    }
    return criterion;
  });

  return {
    sourcePath,
    specVersion: TASK_SPEC_VERSION,
    rubricId: requiredString(value, "rubricId", "rubricId"),
    taskDigest: requiredString(task, "digest", "task.digest"),
    ...(baselineDigest === undefined ? {} : { baselineDigest }),
    criteria: parsed,
    document: value,
  };
}

/** Reads and validates a task-evaluation spec JSON file. */
export async function readTaskSpec(path: string): Promise<TaskSpec> {
  let content: string;
  try {
    content = (await readBounded(path)).toString("utf8");
  } catch (error) {
    if (error instanceof InputTooLargeError)
      throw new PflExportError(
        "invalid-shape",
        `task spec exceeds the ${MAX_INPUT_BYTES}-byte limit: ${path}`,
      );
    if (error instanceof NotRegularFileError)
      throw new PflExportError(
        "unreadable-file",
        `task spec is not a regular file: ${path}`,
      );
    throw new PflExportError(
      "unreadable-file",
      `cannot read task spec: ${path}`,
    );
  }
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PflExportError(
      "invalid-json",
      `task spec is not valid JSON: ${path}`,
    );
  }
  return parseTaskSpec(value, path);
}
