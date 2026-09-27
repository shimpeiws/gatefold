import type { AnalysisResult } from "../domain/claim.js";
import type { ComparisonResult } from "../domain/comparison.js";
import type { TraceComparisonResult } from "../domain/trace-comparison.js";

export function formatJson(
  result: AnalysisResult | ComparisonResult | TraceComparisonResult,
): string {
  return JSON.stringify(result, null, 2);
}
