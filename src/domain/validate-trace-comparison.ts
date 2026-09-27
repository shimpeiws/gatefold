import { TRACE_COMPARISON_SCHEMA_VERSION } from "./trace-comparison.js";
import type { TraceComparisonResult } from "./trace-comparison.js";

const POINTER_PATTERN = /^$|^(?:\/(?:[^/~]|~0|~1)*)*$/;
const EVIDENCE_SOURCES = ["beforeTrace", "afterTrace"] as const;

function fail(message: string): never {
  throw new Error(`invalid trace comparison result: ${message}`);
}

/**
 * Enforces the claim-result invariants that schema/claim-result.v4.json
 * declares, at the comparison boundary. Kept in sync with the schema by the
 * comparison tests, which validate emitted results with ajv.
 */
export function assertValidTraceComparisonResult(
  result: TraceComparisonResult,
): void {
  if (result.schemaVersion !== TRACE_COMPARISON_SCHEMA_VERSION)
    fail(`schemaVersion must be ${TRACE_COMPARISON_SCHEMA_VERSION}`);
  const source = result.source;
  if (
    source === undefined ||
    typeof source !== "object" ||
    source === null ||
    source.command !== "compare-traces"
  )
    fail(`source.command must be 'compare-traces'`);
  const inputs = result.inputs;
  if (
    inputs === undefined ||
    typeof inputs !== "object" ||
    inputs === null ||
    inputs.beforeTrace?.document !== "yuurei-trace" ||
    inputs.afterTrace?.document !== "yuurei-trace"
  )
    fail("inputs must bind beforeTrace/afterTrace yuurei traces");
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
        fail(`${eat}.source must be 'beforeTrace' or 'afterTrace'`);
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

/**
 * Resolves one RFC 6901 JSON Pointer against a raw trace document. Returns
 * the value at the location — `undefined` only when the location exists and
 * holds no member (never the case for JSON documents), so a failed lookup is
 * reported through the `found` flag instead.
 */
function resolvePointer(
  document: unknown,
  pointer: string,
): { found: boolean } {
  let current = document;
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      if (
        !Object.prototype.hasOwnProperty.call(
          current as Record<string, unknown>,
          segment,
        )
      )
        return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true };
}

/**
 * Enforces the v0.5 evidence contract: every emitted pointer must resolve to
 * a location that exists in the named input trace. An absent field has no
 * pointer — its absence is cited through the parent object with a `note`.
 */
export function assertTraceEvidenceResolves(
  result: TraceComparisonResult,
  traces: { beforeTrace: unknown; afterTrace: unknown },
): void {
  for (const [index, claim] of result.claims.entries()) {
    for (const [ei, evidence] of claim.evidence.entries()) {
      const document =
        evidence.source === "beforeTrace"
          ? traces.beforeTrace
          : traces.afterTrace;
      if (!resolvePointer(document, evidence.pointer).found)
        fail(
          `claims[${index}].evidence[${ei}] pointer '${evidence.pointer}' ` +
            `does not resolve in the ${evidence.source} document`,
        );
    }
  }
}
