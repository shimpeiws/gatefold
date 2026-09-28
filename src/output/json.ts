import type { AuditResult } from "../domain/audit.js";
import type { CellReportResult } from "../domain/cell.js";
import type { AnalysisResult } from "../domain/claim.js";
import type { ComparisonResult } from "../domain/comparison.js";
import type {
  EvaluationComparisonResult,
  EvaluationResult,
} from "../domain/evaluation.js";
import type { RunComparisonResult } from "../domain/run-comparison.js";
import type { TraceComparisonResult } from "../domain/trace-comparison.js";

export function formatJson(
  result:
    | AnalysisResult
    | ComparisonResult
    | TraceComparisonResult
    | RunComparisonResult
    | EvaluationResult
    | EvaluationComparisonResult
    | AuditResult
    | CellReportResult,
): string {
  return JSON.stringify(result, null, 2);
}
