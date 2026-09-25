import { CLAIM_SCHEMA_VERSION } from "./claim.js";
import type { AnalysisResult } from "./claim.js";

const POINTER_PATTERN = /^$|^(?:\/(?:[^/~]|~0|~1)*)*$/;

const OPTIONAL_PROVENANCE_STRINGS = [
  "exportVersion",
  "classifierVersion",
  "interpretationOrigin",
  "observedSnapshotId",
  "resolvedSnapshotId",
  "runtimeName",
] as const;

function fail(message: string): never {
  throw new Error(`invalid analysis result: ${message}`);
}

/**
 * Enforces the claim-result invariants that schema/claim-result.v1.json
 * declares, at the analysis boundary. Kept in sync with the schema by
 * test/schema.test.ts, which runs every committed example through both.
 */
export function assertValidResult(result: AnalysisResult): void {
  if (result.schemaVersion !== CLAIM_SCHEMA_VERSION)
    fail(`schemaVersion must be ${CLAIM_SCHEMA_VERSION}`);
  if (!Array.isArray(result.claims)) fail("claims must be an array");
  for (const [index, claim] of result.claims.entries()) {
    const at = `claims[${index}]`;
    if (typeof claim.claim !== "string" || claim.claim.length === 0)
      fail(`${at}.claim must be a non-empty string`);
    if (
      claim.ruleId !== undefined &&
      (typeof claim.ruleId !== "string" || claim.ruleId.length === 0)
    )
      fail(`${at}.ruleId must be a non-empty string when present`);
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0)
      fail(`${at}.evidence must contain at least one reference`);
    for (const [ei, evidence] of claim.evidence.entries()) {
      const eat = `${at}.evidence[${ei}]`;
      if (
        typeof evidence.pointer !== "string" ||
        !POINTER_PATTERN.test(evidence.pointer)
      )
        fail(`${eat}.pointer must be a JSON Pointer`);
      if (
        evidence.elementId !== undefined &&
        (typeof evidence.elementId !== "string" ||
          evidence.elementId.length === 0)
      )
        fail(`${eat}.elementId must be a non-empty string when present`);
      if (evidence.note !== undefined && typeof evidence.note !== "string")
        fail(`${eat}.note must be a string when present`);
    }
    const provenance = claim.provenance;
    if (
      provenance === undefined ||
      typeof provenance.sourceFile !== "string" ||
      provenance.sourceFile.length === 0 ||
      !Array.isArray(provenance.transform) ||
      provenance.transform.some((t: unknown) => typeof t !== "string") ||
      OPTIONAL_PROVENANCE_STRINGS.some(
        (field) =>
          provenance[field] !== undefined &&
          typeof provenance[field] !== "string",
      )
    )
      fail(`${at}.provenance must carry sourceFile and transform`);
    if (
      typeof claim.confidence !== "number" ||
      claim.confidence < 0 ||
      claim.confidence > 1
    )
      fail(`${at}.confidence must be a number in [0, 1]`);
  }
}
