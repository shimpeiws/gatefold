import { sanitizeText } from "../domain/sanitize.js";
import {
  InputTooLargeError,
  MAX_INPUT_BYTES,
  NotRegularFileError,
  readBounded,
} from "./bounded.js";
import { PflExportError } from "./pfl-export.js";

/**
 * The supplied evaluation context for a cell report (docs/v0.9-scope.md):
 * a gatefold v6 `evaluate-run` or v7 `compare-evaluations` result
 * document the caller passes explicitly. It is labelled context, never
 * evidence about this run until its recorded `run` inputs bind to the
 * loaded trace (run id and task digest). The raw document is kept so
 * evidence pointers resolve against it.
 */
export type SuppliedEvaluationState = "parsed" | "invalid";

export interface SuppliedEvaluationVerdict {
  readonly criterionId: string;
  readonly kind: string;
  /** v6 `evaluations[i].verdict`; absent on v7 transitions. */
  readonly verdict?: "pass" | "fail" | "unknown";
  /** v7 `transitions[i]` sides; absent on v6 evaluations. */
  readonly before?: "pass" | "fail" | "unknown";
  readonly after?: "pass" | "fail" | "unknown";
  readonly reason: string;
  /** Array index inside the source document, for evidence pointers. */
  readonly index: number;
}

export interface SuppliedEvaluation {
  readonly label: string;
  readonly document: unknown;
  readonly state: SuppliedEvaluationState;
  /** Why `state` is `invalid`. */
  readonly error: string | null;
  readonly schemaVersion: 6 | 7 | null;
  /** Identities used to bind the document to a loaded cell. */
  readonly run: { readonly runId: string; readonly taskDigest: string } | null;
  readonly beforeRun: {
    readonly runId: string;
    readonly taskDigest: string;
  } | null;
  readonly afterRun: {
    readonly runId: string;
    readonly taskDigest: string;
  } | null;
  readonly verdicts: readonly SuppliedEvaluationVerdict[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const VERDICTS = ["pass", "fail", "unknown"] as const;

/** Whether `value` is one conforming evidence reference. */
function isEvidenceArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.source === "string" &&
        typeof item.pointer === "string",
    )
  );
}

/** Whether `value` is one conforming `provenance` record. */
function isProvenance(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.transform) &&
    value.transform.length > 0 &&
    value.transform.every((item) => typeof item === "string")
  );
}

function traceBinding(
  value: unknown,
): { runId: string; taskDigest: string } | null {
  if (!isRecord(value)) return null;
  const trace = value.trace;
  if (!isRecord(trace)) return null;
  if (typeof trace.runId !== "string" || typeof trace.taskDigest !== "string")
    return null;
  return { runId: trace.runId, taskDigest: trace.taskDigest };
}

function invalid(
  error: string,
  document: unknown,
  label: string,
): SuppliedEvaluation {
  return {
    label: sanitizeText(label),
    document,
    state: "invalid",
    error,
    schemaVersion: null,
    run: null,
    beforeRun: null,
    afterRun: null,
    verdicts: [],
  };
}

/**
 * Reads one supplied evaluation document. An unreadable, oversized, or
 * non-JSON file is an input error; a well-formed JSON document that is
 * not a gatefold v6/v7 result (or whose required records are malformed)
 * is returned `invalid` so the report can state that instead of hiding
 * it.
 */
export async function readCellEvaluation(
  path: string,
): Promise<SuppliedEvaluation> {
  let content: string;
  try {
    content = (await readBounded(path)).toString("utf8");
  } catch (error) {
    if (error instanceof InputTooLargeError)
      throw new PflExportError(
        "invalid-shape",
        `evaluation document exceeds the ${MAX_INPUT_BYTES}-byte limit: ${path}`,
      );
    if (error instanceof NotRegularFileError)
      throw new PflExportError(
        "unreadable-file",
        `evaluation document is not a regular file: ${path}`,
      );
    throw new PflExportError(
      "unreadable-file",
      `cannot read evaluation document: ${path}`,
    );
  }
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PflExportError(
      "invalid-json",
      `evaluation document is not valid JSON: ${path}`,
    );
  }
  if (!isRecord(value))
    return invalid("the document is not a JSON object", value, path);
  const source = value.source;
  const command = isRecord(source) ? source.command : undefined;
  if (value.schemaVersion === 6 && command === "evaluate-run") {
    if (!isRecord(value.inputs))
      return invalid("inputs is not an object", value, path);
    const run = traceBinding(value.inputs.run);
    if (run === null)
      return invalid("inputs.run does not record a bound trace", value, path);
    if (!isRecord(value.context))
      return invalid(
        "context is not an object; a gatefold v6 result records the run context",
        value,
        path,
      );
    if (!Array.isArray(value.evaluations))
      return invalid("evaluations is not an array", value, path);
    const verdicts: SuppliedEvaluationVerdict[] = [];
    for (const [index, item] of value.evaluations.entries()) {
      if (
        !isRecord(item) ||
        typeof item.criterionId !== "string" ||
        typeof item.kind !== "string" ||
        typeof item.verdict !== "string" ||
        !(VERDICTS as readonly string[]).includes(item.verdict) ||
        typeof item.reason !== "string"
      )
        return invalid(
          `evaluations[${index}] is not a complete criterion evaluation: ` +
            "criterionId, kind, verdict, reason, confidence, evidence and " +
            "provenance are all required",
          value,
          path,
        );
      if (
        typeof item.confidence !== "number" ||
        !isEvidenceArray(item.evidence) ||
        !isProvenance(item.provenance)
      )
        return invalid(
          `evaluations[${index}] is not a complete criterion evaluation: ` +
            "confidence, a non-empty evidence list and provenance are required",
          value,
          path,
        );
      verdicts.push({
        criterionId: item.criterionId,
        kind: item.kind,
        verdict: item.verdict as "pass" | "fail" | "unknown",
        reason: item.reason,
        index,
      });
    }
    return {
      label: sanitizeText(path),
      document: value,
      state: "parsed",
      error: null,
      schemaVersion: 6,
      run,
      beforeRun: null,
      afterRun: null,
      verdicts,
    };
  }
  if (value.schemaVersion === 7 && command === "compare-evaluations") {
    if (!isRecord(value.inputs))
      return invalid("inputs is not an object", value, path);
    const beforeRun = traceBinding(value.inputs.beforeRun);
    const afterRun = traceBinding(value.inputs.afterRun);
    if (beforeRun === null || afterRun === null)
      return invalid(
        "inputs.beforeRun/afterRun do not record bound traces",
        value,
        path,
      );
    if (!isRecord(value.context))
      return invalid(
        "context is not an object; a gatefold v7 result records the run context",
        value,
        path,
      );
    if (!Array.isArray(value.caveats))
      return invalid("caveats is not an array", value, path);
    if (!Array.isArray(value.transitions))
      return invalid("transitions is not an array", value, path);
    const verdicts: SuppliedEvaluationVerdict[] = [];
    for (const [index, item] of value.transitions.entries()) {
      if (
        !isRecord(item) ||
        typeof item.criterionId !== "string" ||
        typeof item.kind !== "string" ||
        typeof item.reason !== "string" ||
        !(VERDICTS as readonly string[]).includes(item.before as string) ||
        !(VERDICTS as readonly string[]).includes(item.after as string)
      )
        return invalid(
          `transitions[${index}] is not a complete criterion transition: ` +
            "criterionId, kind, before, after, changed, reason, confidence, " +
            "evidence and provenance are all required",
          value,
          path,
        );
      if (
        typeof item.changed !== "boolean" ||
        typeof item.confidence !== "number" ||
        !isEvidenceArray(item.evidence) ||
        !isProvenance(item.provenance)
      )
        return invalid(
          `transitions[${index}] is not a complete criterion transition: ` +
            "changed, confidence, a non-empty evidence list and provenance " +
            "are required",
          value,
          path,
        );
      verdicts.push({
        criterionId: item.criterionId,
        kind: item.kind,
        before: item.before as "pass" | "fail" | "unknown",
        after: item.after as "pass" | "fail" | "unknown",
        reason: item.reason,
        index,
      });
    }
    return {
      label: sanitizeText(path),
      document: value,
      state: "parsed",
      error: null,
      schemaVersion: 7,
      run: null,
      beforeRun,
      afterRun,
      verdicts,
    };
  }
  return invalid(
    "the document is not a gatefold v6 evaluate-run or v7 compare-evaluations result",
    value,
    path,
  );
}
