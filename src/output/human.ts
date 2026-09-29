import type { AuditEvidenceReference, AuditResult } from "../domain/audit.js";
import type {
  CellEntry,
  CellEvidenceReference,
  CellReportResult,
  CellRunInputDescriptor,
} from "../domain/cell.js";
import type { CellsReportResult } from "../domain/cells.js";
import type { AnalysisResult } from "../domain/claim.js";
import type { ComparisonResult } from "../domain/comparison.js";
import type {
  EvaluationComparisonResult,
  EvaluationEvidenceReference,
  EvaluationResult,
} from "../domain/evaluation.js";
import type { RunComparisonResult } from "../domain/run-comparison.js";
import type { TraceComparisonResult } from "../domain/trace-comparison.js";
import { sanitizeText } from "../domain/sanitize.js";

export function formatHuman(
  result: AnalysisResult,
  minConfidence = 0,
  minConfidenceDisplay = String(minConfidence),
): string {
  if (result.claims.length === 0)
    return minConfidence > 0
      ? `No claims found at or above confidence ${minConfidenceDisplay}.`
      : "No claims found.";
  return result.claims
    .map((claim, index) => {
      const evidence = claim.evidence
        .map((entry) =>
          entry.elementId === undefined
            ? entry.pointer
            : `${entry.pointer} (${entry.elementId})`,
        )
        .join(", ");
      const version = claim.provenance.exportVersion
        ? ` · export ${claim.provenance.exportVersion}`
        : "";
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
        `   provenance: ${claim.provenance.sourceFile}${version} · ${claim.provenance.transform.join(" → ")}`,
      ]
        .map(sanitizeText)
        .join("\n");
    })
    .join("\n");
}

export function formatComparisonHuman(
  result: ComparisonResult,
  minConfidence = 0,
  minConfidenceDisplay = String(minConfidence),
): string {
  if (result.claims.length === 0)
    return minConfidence > 0
      ? `No claims found at or above confidence ${minConfidenceDisplay}.`
      : "No claims found.";
  const labels =
    `${result.inputs.before.label} → ` +
    `${result.inputs.after.label} ` +
    `(diff: ${result.inputs.diff.label})`;
  return result.claims
    .map((claim, index) => {
      const evidence = claim.evidence
        .map((entry) =>
          entry.elementId === undefined
            ? `${entry.source}:${entry.pointer}`
            : `${entry.source}:${entry.pointer} (${entry.elementId})`,
        )
        .join(", ");
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
        `   provenance: ${labels} · ${claim.provenance.transform.join(" → ")}`,
      ]
        .map(sanitizeText)
        .join("\n");
    })
    .join("\n");
}

export function formatTraceComparisonHuman(
  result: TraceComparisonResult,
  minConfidence = 0,
  minConfidenceDisplay = String(minConfidence),
): string {
  if (result.claims.length === 0)
    return minConfidence > 0
      ? `No claims found at or above confidence ${minConfidenceDisplay}.`
      : "No claims found.";
  const labels =
    `${result.inputs.beforeTrace.label} → ` +
    `${result.inputs.afterTrace.label}`;
  return result.claims
    .map((claim, index) => {
      const evidence = claim.evidence
        .map((entry) => {
          const detail = entry.elementId ?? entry.note;
          return detail === undefined
            ? `${entry.source}:${entry.pointer}`
            : `${entry.source}:${entry.pointer} (${detail})`;
        })
        .join(", ");
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
        `   provenance: ${labels} · ${claim.provenance.transform.join(" → ")}`,
      ]
        .map(sanitizeText)
        .join("\n");
    })
    .join("\n");
}

function formatEvaluationEvidence(
  evidence: readonly EvaluationEvidenceReference[],
): string {
  return evidence
    .map((entry) => {
      const path = entry.path === undefined ? "" : ` '${entry.path}'`;
      const range =
        entry.lines === undefined
          ? ""
          : ` lines ${entry.lines.start}-${entry.lines.end}`;
      const detail = entry.elementId ?? entry.note;
      const suffix = detail === undefined ? "" : ` (${detail})`;
      return `${entry.source}:${entry.pointer}${path}${range}${suffix}`;
    })
    .join(", ");
}

export function formatEvaluationHuman(
  result: EvaluationResult,
  minConfidence = 0,
  minConfidenceDisplay = String(minConfidence),
): string {
  if (result.evaluations.length === 0)
    return minConfidence > 0
      ? `No evaluations found at or above confidence ${minConfidenceDisplay}.`
      : "No evaluations found.";
  const labels =
    `${result.inputs.run.label} ` + `(spec: ${result.inputs.spec.label})`;
  return result.evaluations
    .map((entry, index) => {
      return [
        `${index + 1}. [${entry.verdict}] criterion '${entry.criterionId}' (${entry.kind}): ${entry.reason}`,
        `   confidence: ${entry.confidence.toFixed(2)}`,
        `   evidence: ${formatEvaluationEvidence(entry.evidence)}`,
        `   provenance: ${labels} · ${entry.provenance.transform.join(" → ")}`,
      ]
        .map(sanitizeText)
        .join("\n");
    })
    .join("\n");
}

export function formatEvaluationComparisonHuman(
  result: EvaluationComparisonResult,
  minConfidence = 0,
  minConfidenceDisplay = String(minConfidence),
): string {
  if (result.transitions.length === 0)
    return minConfidence > 0
      ? `No transitions found at or above confidence ${minConfidenceDisplay}.`
      : "No transitions found.";
  const labels =
    `${result.inputs.beforeRun.label} → ` +
    `${result.inputs.afterRun.label} ` +
    `(spec: ${result.inputs.spec.label})`;
  const lines = result.transitions.map((entry, index) => {
    return [
      `${index + 1}. criterion '${entry.criterionId}' (${entry.kind}): ${entry.before} → ${entry.after}${entry.changed ? "" : " (unchanged)"}`,
      `   ${entry.reason}`,
      `   confidence: ${entry.confidence.toFixed(2)}`,
      `   evidence: ${formatEvaluationEvidence(entry.evidence)}`,
      `   provenance: ${labels} · ${entry.provenance.transform.join(" → ")}`,
    ]
      .map(sanitizeText)
      .join("\n");
  });
  if (result.caveats.length === 0) return lines.join("\n");
  const caveatLines = result.caveats.map(
    (caveat) =>
      `   caveat ${sanitizeText(caveat.field)}: ${sanitizeText(caveat.text)}`,
  );
  return `${lines.join("\n")}\n\nCaveats (a transition does not establish which harness change caused it):\n${caveatLines.join("\n")}`;
}

export function formatRunComparisonHuman(
  result: RunComparisonResult,
  minConfidence = 0,
  minConfidenceDisplay = String(minConfidence),
): string {
  if (result.claims.length === 0)
    return minConfidence > 0
      ? `No claims found at or above confidence ${minConfidenceDisplay}.`
      : "No claims found.";
  const labels =
    `${result.inputs.beforeRun.label} → ` + `${result.inputs.afterRun.label}`;
  return result.claims
    .map((claim, index) => {
      const evidence = claim.evidence
        .map((entry) => {
          const path = entry.path === undefined ? "" : ` '${entry.path}'`;
          const range =
            entry.lines === undefined
              ? ""
              : ` lines ${entry.lines.start}-${entry.lines.end}`;
          const byteRange =
            entry.bytes === undefined
              ? ""
              : ` bytes ${entry.bytes.start}-${entry.bytes.end}`;
          const digest =
            entry.digest === undefined ? "" : ` digest ${entry.digest}`;
          const detail = entry.elementId ?? entry.note;
          const suffix = detail === undefined ? "" : ` (${detail})`;
          return `${entry.source}:${entry.pointer}${path}${range}${byteRange}${digest}${suffix}`;
        })
        .join(", ");
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
        `   provenance: ${labels} · ${claim.provenance.transform.join(" → ")}`,
      ]
        .map(sanitizeText)
        .join("\n");
    })
    .join("\n");
}

function formatAuditEvidence(
  evidence: readonly AuditEvidenceReference[],
): string {
  return evidence
    .map((entry) => {
      const path = entry.path === undefined ? "" : ` '${entry.path}'`;
      const range =
        entry.lines === undefined
          ? ""
          : ` lines ${entry.lines.start}-${entry.lines.end}`;
      const byteRange =
        entry.bytes === undefined
          ? ""
          : ` bytes ${entry.bytes.start}-${entry.bytes.end}`;
      const digest =
        entry.digest === undefined ? "" : ` digest ${entry.digest}`;
      const detail = entry.elementId ?? entry.note;
      const suffix = detail === undefined ? "" : ` (${detail})`;
      return `${entry.source}:${entry.pointer}${path}${range}${byteRange}${digest}${suffix}`;
    })
    .join(", ");
}

/**
 * Human output for `audit-run` (docs/v0.8-scope.md): a factual evidence
 * report. Deliberately free of Outcome/rubric vocabulary — every row is a
 * fact state plus a completeness, never a verdict or a score.
 */
export function formatAuditHuman(result: AuditResult): string {
  const lines: string[] = [`Audit of ${result.inputs.run.label}`];
  if (result.inputs.checkReports.length > 0)
    lines.push(
      `check reports: ${result.inputs.checkReports
        .map((r) => `${r.label} (${r.state})`)
        .join(", ")}`,
    );
  for (const entry of result.facts) {
    const subject = entry.subject === undefined ? "" : ` [${entry.subject}]`;
    lines.push(
      `${entry.id}${subject}: ${entry.state}; ${entry.completeness}`,
      `   ${entry.reason}`,
      `   evidence: ${formatAuditEvidence(entry.evidence)}`,
    );
  }
  return lines.map(sanitizeText).join("\n") + "\n";
}

function formatCellEvidence(
  evidence: readonly CellEvidenceReference[],
): string {
  return evidence
    .map((entry) => {
      const path = entry.path === undefined ? "" : ` '${entry.path}'`;
      const range =
        entry.lines === undefined
          ? ""
          : ` lines ${entry.lines.start}-${entry.lines.end}`;
      const byteRange =
        entry.bytes === undefined
          ? ""
          : ` bytes ${entry.bytes.start}-${entry.bytes.end}`;
      const digest =
        entry.digest === undefined ? "" : ` digest ${entry.digest}`;
      const detail = entry.elementId ?? entry.note;
      const suffix = detail === undefined ? "" : ` (${detail})`;
      return `${entry.source}:${entry.pointer}${path}${range}${byteRange}${digest}${suffix}`;
    })
    .join(", ");
}

function formatCellInput(descriptor: CellRunInputDescriptor): string {
  const cell = descriptor.cellId ?? "not recorded";
  // `?? null` so a legacy v9/v10 document that predates the optional field
  // reads as no-recorded-reason instead of printing `reason 'undefined'`.
  const reason = descriptor.observationReason ?? null;
  const observation =
    descriptor.observationStatus === null
      ? "absent"
      : reason === null
        ? descriptor.observationStatus
        : `${descriptor.observationStatus} (reason '${reason}')`;
  return (
    `${descriptor.label}: run ${descriptor.runId},` +
    ` cell ${cell}, observation ${observation}`
  );
}

/**
 * Human output for `report-cell`/`compare-cells` (docs/v0.9-scope.md): a
 * factual, lane-grouped evidence report. Deliberately free of verdict or
 * ranking vocabulary — every row is a record or check state plus a
 * completeness, never a score.
 */
export function formatCellHuman(result: CellReportResult): string {
  const lines: string[] = [];
  if (result.source.command === "report-cell") {
    const run = result.inputs.run;
    lines.push(`Cell report of ${run?.label ?? ""}`);
    if (run !== undefined) lines.push(`  ${formatCellInput(run)}`);
  } else {
    const before = result.inputs.before;
    const after = result.inputs.after;
    lines.push(
      `Cell comparison of ${before?.label ?? ""} → ${after?.label ?? ""}`,
    );
    if (before !== undefined)
      lines.push(`  before: ${formatCellInput(before)}`);
    if (after !== undefined) lines.push(`  after: ${formatCellInput(after)}`);
  }
  if (result.inputs.evaluation !== undefined)
    lines.push(
      `  evaluation: ${result.inputs.evaluation.label} (schema v${result.inputs.evaluation.schemaVersion})`,
    );
  for (const entry of result.entries) lines.push(...formatCellEntry(entry));
  return lines.map(sanitizeText).join("\n") + "\n";
}

function formatCellEntry(entry: CellEntry): string[] {
  const subject = entry.subject === undefined ? "" : ` [${entry.subject}]`;
  return [
    `${entry.id}${subject}: ${entry.state}; ${entry.completeness}`,
    `   ${entry.statement}`,
    `   evidence: ${formatCellEvidence(entry.evidence)}`,
  ];
}

/**
 * Human output for `report-cells` (docs/v0.10-scope.md): one header per
 * supplied run under its `run<N>` label, then every entry in contract
 * order — per-run lanes first, the set lane last. Same verdict-free
 * vocabulary as the v9 cell reports.
 */
export function formatCellsHuman(result: CellsReportResult): string {
  const lines: string[] = [
    `Cell set report of ${result.inputs.runs.length} supplied runs`,
  ];
  for (const run of result.inputs.runs)
    lines.push(`  ${run.name}: ${formatCellInput(run)}`);
  for (const entry of result.entries) lines.push(...formatCellEntry(entry));
  return lines.map(sanitizeText).join("\n") + "\n";
}
