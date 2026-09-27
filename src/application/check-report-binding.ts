import type { CheckReport, CheckVerdict } from "../input/check-report.js";
import { PflExportError } from "../input/pfl-export.js";
import { readCheckReport } from "../input/check-report.js";
import type { EvaluatedRun } from "../input/yuurei-seeded-run.js";
import type { TaskSpec } from "../input/task-spec.js";
import type { CheckReportDescriptor } from "../domain/evaluation.js";

/** A check report that could not be read or validated into its format. */
export interface LoadedCheckReport {
  /** The CLI argument / file path, used as the descriptor label. */
  readonly label: string;
  /** The validated report; null when the document was rejected. */
  readonly report: CheckReport | null;
  /** The raw report document, for evidence pointer resolution. */
  readonly document: unknown;
  /** When non-null, why the report is `invalid`. */
  readonly error: string | null;
}

/**
 * Reads each supplied report path. An unreadable file is an input error and
 * propagates; a document that parses/validates badly is kept as an `invalid`
 * report — a rejected report can never imply a pass, so evaluation proceeds
 * and affected criteria become `unknown` (docs/v0.7-scope.md).
 */
export async function loadCheckReports(
  paths: readonly string[],
): Promise<LoadedCheckReport[]> {
  const loaded: LoadedCheckReport[] = [];
  for (const path of paths) {
    try {
      const report = await readCheckReport(path);
      loaded.push({
        label: path,
        report,
        document: report.document,
        error: null,
      });
    } catch (error) {
      if (
        error instanceof PflExportError &&
        (error.code === "invalid-json" ||
          error.code === "invalid-shape" ||
          error.code === "unsupported-version")
      ) {
        loaded.push({
          label: path,
          report: null,
          document: null,
          error: error.message,
        });
        continue;
      }
      throw error;
    }
  }
  return loaded;
}

/** The verdicts one bound report supplies, keyed by criterion id. */
export interface BoundVerdict {
  readonly verdict: CheckVerdict;
  /** Index of the supplying row in the report's `results` array. */
  readonly rowIndex: number;
  /** Rows seen for this criterion with disagreeing verdicts. */
  readonly conflict: boolean;
}

export interface BoundCheckReport {
  readonly descriptor: CheckReportDescriptor;
  readonly report: CheckReport | null;
  /** Verdicts per `external-check` criterion id; empty when rejected. */
  readonly verdicts: ReadonlyMap<string, BoundVerdict>;
}

/**
 * Binds one loaded report to a run and spec (docs/v0.7-scope.md): the
 * declared subject must match the run's task digest, its optional baseline
 * digest against the seed's requested baseline identity, and its optional
 * patch digest against the verified `patch.diff` manifest record. Only
 * `external-check` criterion rows are admitted —
 * rows naming any other criterion id are ignored. Duplicate rows with
 * identical verdicts collapse; conflicting duplicates keep the criterion
 * `unknown` with a conflict reason.
 */
export function bindCheckReport(
  loaded: LoadedCheckReport,
  run: EvaluatedRun,
  spec: TaskSpec,
): BoundCheckReport {
  const base: CheckReportDescriptor = {
    label: loaded.label,
    document: "check-report",
    evaluatorId: loaded.report?.evaluatorId ?? null,
    ...(loaded.report?.evaluatorVersion === undefined
      ? {}
      : { evaluatorVersion: loaded.report.evaluatorVersion }),
    state: "accepted",
    resultCount: loaded.report?.results.length ?? 0,
  };
  if (loaded.report === null)
    return {
      descriptor: {
        ...base,
        state: "invalid",
        error: loaded.error ?? "report could not be parsed",
      },
      report: null,
      verdicts: new Map(),
    };

  const report = loaded.report;
  const mismatch = (field: string): BoundCheckReport => ({
    descriptor: { ...base, state: "mismatched", error: field },
    report,
    verdicts: new Map(),
  });

  if (report.taskDigest !== run.trace.task.digest)
    return mismatch(
      `subject.taskDigest '${report.taskDigest}' does not match the run's task.digest '${run.trace.task.digest}'`,
    );
  const requestedDigest = run.trace.seed?.baseline.requestedDigest;
  if (
    report.baselineDigest !== undefined &&
    report.baselineDigest !== requestedDigest
  )
    return mismatch(
      `subject.baselineDigest '${report.baselineDigest}' does not match the run's requested baseline digest ` +
        `'${requestedDigest ?? "none"}'`,
    );
  if (report.patchDigest !== undefined) {
    const patchEntry =
      run.patchEntryIndex === null ? null : run.entries[run.patchEntryIndex];
    const patchVerified =
      patchEntry !== null &&
      (patchEntry.state === "verified" ||
        patchEntry.state === "verified-truncated");
    if (!patchVerified || patchEntry.digest !== report.patchDigest)
      return mismatch(
        `subject.patchDigest '${report.patchDigest}' does not match the run's verified patch.diff digest`,
      );
  }

  const externalIds = new Set(
    spec.criteria.filter((c) => c.kind === "external-check").map((c) => c.id),
  );
  const verdicts = new Map<string, BoundVerdict>();
  for (const row of report.results) {
    if (!externalIds.has(row.criterionId)) continue;
    const existing = verdicts.get(row.criterionId);
    if (existing === undefined) {
      verdicts.set(row.criterionId, {
        verdict: row.verdict,
        rowIndex: row.index,
        conflict: false,
      });
      continue;
    }
    // Identical duplicate rows collapse; conflicting duplicates keep the
    // criterion unknown and cite the conflict.
    if (existing.verdict !== row.verdict)
      verdicts.set(row.criterionId, {
        verdict: "unknown",
        rowIndex: existing.rowIndex,
        conflict: true,
      });
  }
  return { descriptor: base, report, verdicts };
}
