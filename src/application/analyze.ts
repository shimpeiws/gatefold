import { CLAIM_SCHEMA_VERSION } from "../domain/claim.js";
import type { AnalysisResult } from "../domain/claim.js";
import { assertValidResult } from "../domain/validate.js";
import type { PflExport } from "../input/pfl-export.js";
import { RULES } from "./rules.js";

export function analyze(input: PflExport): AnalysisResult {
  const result: AnalysisResult = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    claims: RULES.flatMap((rule) => rule.evaluate(input)),
  };
  assertValidResult(result);
  return result;
}
