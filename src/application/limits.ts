/**
 * Output amplification ceilings shared by the single-document and compare
 * paths (docs/v0.3-scope.md, docs/v0.4-scope.md). Emission stops are enforced
 * after rule evaluation: input ceilings already bound how many claims rules
 * can produce, so the check exists to reject, not to stream-truncate.
 */
export const MAX_EMITTED_CLAIMS = 50_000;
export const MAX_EVIDENCE_REFERENCES = 100_000;
