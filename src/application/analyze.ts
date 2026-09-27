import { CLAIM_SCHEMA_VERSION } from "../domain/claim.js";
import type { AnalysisResult } from "../domain/claim.js";
import { assertValidResult } from "../domain/validate.js";
import { PflExportError } from "../input/pfl-export.js";
import type { PflDocument } from "../input/pfl-export.js";
import { DIFF_RULES } from "./diff-rules.js";
import { EXPORT_RULES } from "./export-rules.js";
import { MAX_EMITTED_CLAIMS, MAX_EVIDENCE_REFERENCES } from "./limits.js";
import { RULES } from "./rules.js";

export function analyze(input: PflDocument): AnalysisResult {
  const claims =
    input.command === "report"
      ? RULES.flatMap((rule) => rule.evaluate(input))
      : input.command === "export"
        ? EXPORT_RULES.flatMap((rule) => rule.evaluate(input))
        : DIFF_RULES.flatMap((rule) => rule.evaluate(input));
  if (claims.length > MAX_EMITTED_CLAIMS)
    throw new PflExportError(
      "invalid-shape",
      `analysis would emit ${claims.length} claims, exceeding the ${MAX_EMITTED_CLAIMS} claim ceiling`,
    );
  const evidenceCount = claims.reduce(
    (total, claim) => total + claim.evidence.length,
    0,
  );
  if (evidenceCount > MAX_EVIDENCE_REFERENCES)
    throw new PflExportError(
      "invalid-shape",
      `analysis would cite ${evidenceCount} evidence references, exceeding the ${MAX_EVIDENCE_REFERENCES} reference ceiling`,
    );
  const result: AnalysisResult = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    source: { pflVersion: input.pflVersion, command: input.command },
    claims,
  };
  assertValidResult(result);
  return result;
}
