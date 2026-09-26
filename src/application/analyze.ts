import { CLAIM_SCHEMA_VERSION } from "../domain/claim.js";
import type { AnalysisResult } from "../domain/claim.js";
import { assertValidResult } from "../domain/validate.js";
import type { PflDocument } from "../input/pfl-export.js";
import { EXPORT_RULES } from "./export-rules.js";
import { RULES } from "./rules.js";

export function analyze(input: PflDocument): AnalysisResult {
  const claims =
    input.command === "report"
      ? RULES.flatMap((rule) => rule.evaluate(input))
      : EXPORT_RULES.flatMap((rule) => rule.evaluate(input));
  const result: AnalysisResult = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    source: { pflVersion: input.pflVersion, command: input.command },
    claims,
  };
  assertValidResult(result);
  return result;
}
