import type { AnalysisResult } from "../domain/claim.js";
import type { ComparisonResult } from "../domain/comparison.js";
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
