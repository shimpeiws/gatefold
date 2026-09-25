import type { AnalysisResult } from "../domain/claim.js";
import type { PflExport } from "../input/pfl-export.js";

export function analyze(_input: PflExport): AnalysisResult {
  return { claims: [] };
}
