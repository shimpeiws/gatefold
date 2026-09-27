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
            : `${entry.pointer} (${sanitizeText(entry.elementId)})`,
        )
        .join(", ");
      const version = claim.provenance.exportVersion
        ? ` · export ${claim.provenance.exportVersion}`
        : "";
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
        `   provenance: ${sanitizeText(claim.provenance.sourceFile)}${version} · ${claim.provenance.transform.join(" → ")}`,
      ].join("\n");
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
    `${sanitizeText(result.inputs.before.label)} → ` +
    `${sanitizeText(result.inputs.after.label)} ` +
    `(diff: ${sanitizeText(result.inputs.diff.label)})`;
  return result.claims
    .map((claim, index) => {
      const evidence = claim.evidence
        .map((entry) =>
          entry.elementId === undefined
            ? `${entry.source}:${entry.pointer}`
            : `${entry.source}:${entry.pointer} (${sanitizeText(entry.elementId)})`,
        )
        .join(", ");
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
        `   provenance: ${labels} · ${claim.provenance.transform.join(" → ")}`,
      ].join("\n");
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
    `${sanitizeText(result.inputs.beforeTrace.label)} → ` +
    `${sanitizeText(result.inputs.afterTrace.label)}`;
  return result.claims
    .map((claim, index) => {
      const evidence = claim.evidence
        .map((entry) => {
          const detail = entry.elementId ?? entry.note;
          return detail === undefined
            ? `${entry.source}:${entry.pointer}`
            : `${entry.source}:${entry.pointer} (${sanitizeText(detail)})`;
        })
        .join(", ");
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
        `   provenance: ${labels} · ${claim.provenance.transform.join(" → ")}`,
      ].join("\n");
    })
    .join("\n");
}

function formatEvaluationEvidence(
  evidence: readonly EvaluationEvidenceReference[],
): string {
  return evidence
    .map((entry) => {
      const path =
        entry.path === undefined ? "" : ` '${sanitizeText(entry.path)}'`;
      const range =
        entry.lines === undefined
          ? ""
          : ` lines ${entry.lines.start}-${entry.lines.end}`;
      const detail = entry.elementId ?? entry.note;
      const suffix = detail === undefined ? "" : ` (${sanitizeText(detail)})`;
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
    `${sanitizeText(result.inputs.run.label)} ` +
    `(spec: ${sanitizeText(result.inputs.spec.label)})`;
  return result.evaluations
    .map((entry, index) => {
      return [
        `${index + 1}. [${entry.verdict}] criterion '${sanitizeText(entry.criterionId)}' (${entry.kind}): ${entry.reason}`,
        `   confidence: ${entry.confidence.toFixed(2)}`,
        `   evidence: ${formatEvaluationEvidence(entry.evidence)}`,
        `   provenance: ${labels} · ${entry.provenance.transform.join(" → ")}`,
      ].join("\n");
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
    `${sanitizeText(result.inputs.beforeRun.label)} → ` +
    `${sanitizeText(result.inputs.afterRun.label)} ` +
    `(spec: ${sanitizeText(result.inputs.spec.label)})`;
  const lines = result.transitions.map((entry, index) => {
    return [
      `${index + 1}. criterion '${sanitizeText(entry.criterionId)}' (${entry.kind}): ${entry.before} → ${entry.after}${entry.changed ? "" : " (unchanged)"}`,
      `   ${entry.reason}`,
      `   confidence: ${entry.confidence.toFixed(2)}`,
      `   evidence: ${formatEvaluationEvidence(entry.evidence)}`,
      `   provenance: ${labels} · ${entry.provenance.transform.join(" → ")}`,
    ].join("\n");
  });
  if (result.caveats.length === 0) return lines.join("\n");
  const caveatLines = result.caveats.map(
    (caveat) => `   caveat ${caveat.field}: ${caveat.text}`,
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
    `${sanitizeText(result.inputs.beforeRun.label)} → ` +
    `${sanitizeText(result.inputs.afterRun.label)}`;
  return result.claims
    .map((claim, index) => {
      const evidence = claim.evidence
        .map((entry) => {
          const path =
            entry.path === undefined ? "" : ` '${sanitizeText(entry.path)}'`;
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
          const suffix =
            detail === undefined ? "" : ` (${sanitizeText(detail)})`;
          return `${entry.source}:${entry.pointer}${path}${range}${byteRange}${digest}${suffix}`;
        })
        .join(", ");
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
        `   provenance: ${labels} · ${claim.provenance.transform.join(" → ")}`,
      ].join("\n");
    })
    .join("\n");
}
