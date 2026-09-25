import type { AnalysisResult } from "../domain/claim.js";

function escapeControls(text: string): string {
  return text.replace(
    /[\x00-\x1F\x7F-\x9F]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function formatHuman(result: AnalysisResult, minConfidence = 0): string {
  if (result.claims.length === 0)
    return minConfidence > 0
      ? `No claims found at or above confidence ${minConfidence.toFixed(2)}.`
      : "No claims found.";
  return result.claims
    .map((claim, index) => {
      const evidence = claim.evidence.map((entry) => entry.pointer).join(", ");
      const version = claim.provenance.exportVersion
        ? ` · export ${claim.provenance.exportVersion}`
        : "";
      return [
        `${index + 1}. ${claim.claim}`,
        `   confidence: ${claim.confidence.toFixed(2)}`,
        `   evidence: ${evidence}`,
        `   provenance: ${escapeControls(claim.provenance.sourceFile)}${version} · ${claim.provenance.transform.join(" → ")}`,
      ].join("\n");
    })
    .join("\n");
}
