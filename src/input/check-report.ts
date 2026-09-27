import { InputTooLargeError, MAX_INPUT_BYTES, readBounded } from "./bounded.js";
import { PflExportError } from "./pfl-export.js";

/**
 * Parser for the v0.7 external check report (docs/v0.7-scope.md): a
 * structured result document produced by an independent evaluator or test
 * runner. Gatefold never executes tests and never accepts the agent's own
 * stdout/stderr or final-answer claims as a check result — only this
 * explicit, subject-bound format counts as an attested test result.
 */
export const CHECK_REPORT_VERSION = 1;

/** A verdict an external evaluator may report for one criterion. */
export type CheckVerdict = "pass" | "fail" | "unknown";

const CHECK_VERDICTS: readonly string[] = ["pass", "fail", "unknown"];

const MAX_RESULTS = 10_000;
const MAX_SCALAR_CHARS = 4_096;

/** One per-criterion verdict row. */
export interface CheckResultRow {
  /** Position of the row in the report's `results` array. */
  readonly index: number;
  readonly criterionId: string;
  readonly verdict: CheckVerdict;
  /** Optional test-suite provenance (for example the spec file run). */
  readonly suite?: string;
  /** Optional free-text note, quoted never interpreted. */
  readonly note?: string;
}

/** A validated external check report. */
export interface CheckReport {
  /** The file the report was read from, sanitized for display. */
  readonly sourcePath: string;
  readonly reportVersion: typeof CHECK_REPORT_VERSION;
  /** Identity of the evaluator/test runner that produced the report. */
  readonly evaluatorId: string;
  readonly evaluatorVersion?: string;
  /** The task content digest the report asserts it evaluated. */
  readonly taskDigest: string;
  /** The baseline identity the report asserts, when declared. */
  readonly baselineDigest?: string;
  /** The verified output artifact digest the report asserts, when declared. */
  readonly patchDigest?: string;
  readonly results: readonly CheckResultRow[];
  /** The raw parsed document — `checkReport` evidence pointers resolve against it. */
  readonly document: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shapeError(field: string, expected: string): PflExportError {
  return new PflExportError(
    "invalid-shape",
    `check report field ${field} must be ${expected}`,
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

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_SCALAR_CHARS)
    throw shapeError(
      path,
      `a string of at most ${MAX_SCALAR_CHARS} characters when present`,
    );
  return value;
}

/**
 * Validates a parsed JSON value against the check-report contract. Pure:
 * no I/O; subject binding against a concrete run happens at evaluation.
 */
export function parseCheckReport(
  value: unknown,
  sourcePath: string,
): CheckReport {
  if (!isRecord(value))
    throw new PflExportError(
      "invalid-shape",
      "check report must contain an object at the top level",
    );
  const reportVersion = value.reportVersion;
  if (typeof reportVersion !== "number" || !Number.isInteger(reportVersion))
    throw shapeError("reportVersion", "an integer");
  if (reportVersion !== CHECK_REPORT_VERSION)
    throw new PflExportError(
      "unsupported-version",
      `unsupported check report reportVersion: ${reportVersion} (supported: ${CHECK_REPORT_VERSION})`,
    );

  const evaluator = value.evaluator;
  if (!isRecord(evaluator)) throw shapeError("evaluator", "an object");
  const subject = value.subject;
  if (!isRecord(subject)) throw shapeError("subject", "an object");
  const results = value.results;
  if (!Array.isArray(results)) throw shapeError("results", "an array");
  if (results.length > MAX_RESULTS)
    throw shapeError("results", `an array with at most ${MAX_RESULTS} items`);
  const rows = results.map((item, index): CheckResultRow => {
    const at = `results[${index}]`;
    if (!isRecord(item)) throw shapeError(at, "an object");
    const verdict = requiredString(item, "verdict", `${at}.verdict`);
    if (!CHECK_VERDICTS.includes(verdict))
      throw shapeError(
        `${at}.verdict`,
        `one of ${CHECK_VERDICTS.map((v) => `"${v}"`).join(", ")}`,
      );
    const suite = optionalString(item, "suite", `${at}.suite`);
    const note = optionalString(item, "note", `${at}.note`);
    return {
      index,
      criterionId: requiredString(item, "criterionId", `${at}.criterionId`),
      verdict: verdict as CheckVerdict,
      ...(suite === undefined ? {} : { suite }),
      ...(note === undefined ? {} : { note }),
    };
  });

  const evaluatorVersion = optionalString(
    evaluator,
    "version",
    "evaluator.version",
  );
  const baselineDigest = optionalString(
    subject,
    "baselineDigest",
    "subject.baselineDigest",
  );
  const patchDigest = optionalString(
    subject,
    "patchDigest",
    "subject.patchDigest",
  );
  return {
    sourcePath,
    reportVersion: CHECK_REPORT_VERSION,
    evaluatorId: requiredString(evaluator, "id", "evaluator.id"),
    ...(evaluatorVersion === undefined ? {} : { evaluatorVersion }),
    taskDigest: requiredString(subject, "taskDigest", "subject.taskDigest"),
    ...(baselineDigest === undefined ? {} : { baselineDigest }),
    ...(patchDigest === undefined ? {} : { patchDigest }),
    results: rows,
    document: value,
  };
}

/** Reads and validates one external check-report JSON file. */
export async function readCheckReport(path: string): Promise<CheckReport> {
  let content: string;
  try {
    content = (await readBounded(path)).toString("utf8");
  } catch (error) {
    if (error instanceof InputTooLargeError)
      throw new PflExportError(
        "invalid-shape",
        `check report exceeds the ${MAX_INPUT_BYTES}-byte limit: ${path}`,
      );
    throw new PflExportError(
      "unreadable-file",
      `cannot read check report: ${path}`,
    );
  }
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PflExportError(
      "invalid-json",
      `check report is not valid JSON: ${path}`,
    );
  }
  try {
    return parseCheckReport(value, path);
  } catch (error) {
    // The document parsed, so its evidence citations still resolve: keep it on
    // the rejection rather than discarding the only parsed copy
    // (docs/v0.8-scope.md — a rejected report is cited as a whole).
    if (error instanceof PflExportError)
      throw new PflExportError(error.code, error.message, value);
    throw error;
  }
}
