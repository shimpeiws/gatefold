import type { YuureiRun } from "../input/yuurei-run.js";
import {
  RUN_COMPARISON_SCHEMA_VERSION,
  type RunComparisonResult,
  type RunEvidenceSource,
} from "./run-comparison.js";
import { resolvePointer } from "./validate-trace-comparison.js";

const POINTER_PATTERN = /^$|^(?:\/(?:[^/~]|~0|~1)*)*$/;
const EVIDENCE_SOURCES: readonly RunEvidenceSource[] = [
  "beforeTrace",
  "afterTrace",
  "beforeManifest",
  "afterManifest",
  "beforePatch",
  "afterPatch",
];
const PATCH_SOURCES = new Set<RunEvidenceSource>(["beforePatch", "afterPatch"]);
const ARTIFACT_STATES = [
  "verified",
  "verified-truncated",
  "digest-mismatch",
  "missing",
  "unverified",
] as const;
const PATCH_STATES = [...ARTIFACT_STATES, "malformed", "not-recorded"] as const;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new Error(`invalid run comparison result: ${message}`);
}

/**
 * Enforces the claim-result invariants that schema/claim-result.v5.json
 * declares, at the comparison boundary. Kept in sync with the schema by the
 * comparison tests, which validate emitted results with ajv.
 */
export function assertValidRunComparisonResult(
  result: RunComparisonResult,
): void {
  if (result.schemaVersion !== RUN_COMPARISON_SCHEMA_VERSION)
    fail(`schemaVersion must be ${RUN_COMPARISON_SCHEMA_VERSION}`);
  const source = result.source;
  if (
    source === undefined ||
    typeof source !== "object" ||
    source === null ||
    source.command !== "compare-runs"
  )
    fail(`source.command must be 'compare-runs'`);
  const inputs = result.inputs;
  if (inputs === undefined || typeof inputs !== "object" || inputs === null)
    fail("inputs must be an object");
  for (const role of ["beforeRun", "afterRun"] as const) {
    const input = inputs[role];
    if (
      input?.document !== "yuurei-run" ||
      input.trace?.document !== "yuurei-trace"
    )
      fail(`inputs.${role} must bind a yuurei run directory`);
    if (!(PATCH_STATES as readonly string[]).includes(input.patchState))
      fail(`inputs.${role}.patchState must be a known patch state`);
    if (!Array.isArray(input.artifacts))
      fail(`inputs.${role}.artifacts must be an array`);
    for (const [ai, entry] of input.artifacts.entries()) {
      const eat = `inputs.${role}.artifacts[${ai}]`;
      if (
        typeof entry.path !== "string" ||
        typeof entry.kind !== "string" ||
        typeof entry.digest !== "string" ||
        !(ARTIFACT_STATES as readonly string[]).includes(entry.state)
      )
        fail(`${eat} must carry path, kind, digest, and a known state`);
      if (entry.truncated !== undefined && entry.truncated !== true)
        fail(`${eat}.truncated must be true when present`);
      if (
        entry.bytes !== undefined &&
        (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
      )
        fail(`${eat}.bytes must be a non-negative integer when present`);
    }
  }
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
        fail(`${eat}.source must be a known run document source`);
      if (
        typeof evidence.pointer !== "string" ||
        !POINTER_PATTERN.test(evidence.pointer)
      )
        fail(`${eat}.pointer must be a JSON Pointer`);
      if (evidence.digest !== undefined && !SHA256_DIGEST.test(evidence.digest))
        fail(`${eat}.digest must be a sha256 digest when present`);
      if (
        evidence.path !== undefined &&
        (typeof evidence.path !== "string" || evidence.path.length === 0)
      )
        fail(`${eat}.path must be a non-empty string when present`);
      for (const rangeName of ["lines", "bytes"] as const) {
        const range = evidence[rangeName];
        if (range === undefined) continue;
        if (
          typeof range !== "object" ||
          range === null ||
          !Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start
        )
          fail(`${eat}.${rangeName} must be a non-empty range when present`);
      }
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

/** Counts the lines a stored patch occupies (LF-terminated records). */
function patchLineCount(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count === 0 && bytes.length > 0 ? 1 : count;
}

/**
 * Enforces the v0.6 evidence contract against the loaded runs: trace and
 * manifest pointers resolve inside the named document; patch evidence cites
 * the run's `patch.diff` manifest entry by pointer, repeats its recorded
 * digest, and keeps `lines`/`bytes` ranges inside the verified stored bytes
 * and `path` on a file the parsed patch actually records.
 */
export function assertRunEvidenceResolves(
  result: RunComparisonResult,
  runs: { beforeRun: YuureiRun; afterRun: YuureiRun },
): void {
  for (const [index, claim] of result.claims.entries()) {
    for (const [ei, evidence] of claim.evidence.entries()) {
      const run = evidence.source.startsWith("before")
        ? runs.beforeRun
        : runs.afterRun;
      const at = `claims[${index}].evidence[${ei}]`;
      if (PATCH_SOURCES.has(evidence.source)) {
        const entryIndex = run.patchEntryIndex;
        if (entryIndex === null)
          fail(`${at} cites a patch the run does not record`);
        const pointer = `/artifacts/${entryIndex}`;
        if (evidence.pointer !== pointer)
          fail(
            `${at} patch evidence must point at the patch manifest entry ` +
              `(${pointer}), got '${evidence.pointer}'`,
          );
        const entry = run.entries[entryIndex];
        if (evidence.digest !== entry.digest)
          fail(`${at} digest does not match the manifest's recorded digest`);
        if (
          evidence.lines !== undefined ||
          evidence.bytes !== undefined ||
          evidence.path !== undefined
        ) {
          if (run.patch === null || run.patchBytes === null)
            fail(`${at} cites patch content that was not interpreted`);
          if (evidence.bytes !== undefined) {
            if (evidence.bytes.end > run.patchBytes.length)
              fail(`${at}.bytes exceeds the stored patch bytes`);
          }
          if (evidence.lines !== undefined) {
            if (evidence.lines.start < 1)
              fail(`${at}.lines.start must be at least 1`);
            if (evidence.lines.end > patchLineCount(run.patchBytes))
              fail(`${at}.lines exceeds the stored patch lines`);
          }
          if (
            evidence.path !== undefined &&
            !run.patch.files.some((file) => file.path === evidence.path)
          )
            fail(
              `${at}.path names a file the patch does not record ` +
                `('${evidence.path}')`,
            );
        }
        continue;
      }
      const document = evidence.source.endsWith("Trace")
        ? run.trace.document
        : run.manifestDocument;
      if (!resolvePointer(document, evidence.pointer).found)
        fail(
          `${at} pointer '${evidence.pointer}' does not resolve in the ` +
            `${evidence.source} document`,
        );
    }
  }
}
