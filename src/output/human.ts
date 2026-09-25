import type { AnalysisResult } from "../domain/claim.js";

export function formatHuman(result: AnalysisResult, minConfidence = 0): string {
  if (result.claims.length === 0)
    return minConfidence > 0
      ? `No claims found at or above confidence ${minConfidence.toFixed(2)}.`
      : "No claims found.";
  return result.claims
    .map((claim, index) => {
      const evidence = claim.evidence.map((entry) => entry.pointer).join(", ");
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
      ].join("\n");
    })
    .join("\n");
}
