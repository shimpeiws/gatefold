import { COMPARISON_SCHEMA_VERSION } from "./comparison.js";
import type { ComparisonResult } from "./comparison.js";

const POINTER_PATTERN = /^$|^(?:\/(?:[^/~]|~0|~1)*)*$/;
const EVIDENCE_SOURCES = ["before", "after", "diff"] as const;

function fail(message: string): never {
  throw new Error(`invalid comparison result: ${message}`);
}

/**
 * Enforces the claim-result invariants that schema/claim-result.v3.json
 * declares, at the comparison boundary. Kept in sync with the schema by the
 * comparison tests, which validate emitted results with ajv.
 */
export function assertValidComparisonResult(result: ComparisonResult): void {
  if (result.schemaVersion !== COMPARISON_SCHEMA_VERSION)
    fail(`schemaVersion must be ${COMPARISON_SCHEMA_VERSION}`);
  const source = result.source;
  if (
    source === undefined ||
    typeof source !== "object" ||
    source === null ||
    source.command !== "compare"
  )
    fail(`source.command must be 'compare'`);
  const inputs = result.inputs;
  if (
    inputs === undefined ||
    typeof inputs !== "object" ||
    inputs === null ||
    inputs.before?.command !== "export" ||
    inputs.after?.command !== "export" ||
    inputs.diff?.command !== "diff"
  )
    fail("inputs must bind before/after exports and the diff");
  if (!Array.isArray(result.claims)) fail("claims must be an array");
  for (const [index, claim] of result.claims.entries()) {
    const at = `claims[${index}]`;
    if (typeof claim.claim !== "string" || claim.claim.length === 0)
      fail(`${at}.claim must be a non-empty string`);
    if (typeof claim.ruleId !== "string" || claim.ruleId.length === 0)
      fail(`${at}.ruleId must be a non-empty string`);
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0)
      fail(`${at}.evidence must contain at least one reference`);
    for (const [ei, evidence] of claim.evidence.entries()) {
      const eat = `${at}.evidence[${ei}]`;
      if (
        typeof evidence.source !== "string" ||
        !(EVIDENCE_SOURCES as readonly string[]).includes(evidence.source)
      )
        fail(`${eat}.source must be 'before', 'after', or 'diff'`);
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
      !Array.isArray(provenance.transform) ||
      provenance.transform.some((t: unknown) => typeof t !== "string")
    )
      fail(`${at}.provenance must carry transform`);
    if (
      typeof claim.confidence !== "number" ||
      claim.confidence < 0 ||
      claim.confidence > 1
    )
      fail(`${at}.confidence must be a number in [0, 1]`);
  }
}
