import type { AnalysisResult } from "../domain/claim.js";
import type { ComparisonResult } from "../domain/comparison.js";

export function formatJson(result: AnalysisResult | ComparisonResult): string {
  return JSON.stringify(result, null, 2);
}
