import type { AnalysisResult } from "../domain/claim.js";

export function formatHuman(result: AnalysisResult): string {
  if (result.claims.length === 0) return "No claims found.";
  return result.claims
    .map((claim, index) => `${index + 1}. ${claim.claim}`)
    .join("\n");
}
