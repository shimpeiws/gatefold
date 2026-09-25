import { CLAIM_SCHEMA_VERSION } from "../domain/claim.js";
import type { AnalysisResult } from "../domain/claim.js";
import { assertValidResult } from "../domain/validate.js";
import type { PflExport } from "../input/pfl-export.js";

export function analyze(_input: PflExport): AnalysisResult {
  const result: AnalysisResult = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    claims: [],
  };
  assertValidResult(result);
  return result;
}
