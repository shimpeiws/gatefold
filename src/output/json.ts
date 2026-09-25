import type { AnalysisResult } from "../domain/claim.js";

export function formatJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2);
}
