import type { LoadedCheckReport } from "../application/check-report-binding.js";
import type {
  AuditedArtifactRecord,
  AuditedRun,
} from "../input/yuurei-audit-run.js";
import {
  AUDIT_SCHEMA_VERSION,
  type AuditEvidenceReference,
  type AuditEvidenceSource,
  type AuditResult,
} from "./audit.js";
import { checkRunDescriptor } from "./validate-evaluation.js";
import { resolvePointer } from "./validate-trace-comparison.js";

const POINTER_PATTERN = /^$|^(?:\/(?:[^/~]|~0|~1)*)*$/;
const SOURCES: readonly AuditEvidenceSource[] = [
  "trace",
  "manifest",
  "patch",
  "result",
  "baselineManifest",
  "changes",
  "checkReport",
];
const FACT_STATES = [
  "verified",
  "inconsistent",
  "unverifiable",
  "not-recorded",
] as const;
const COMPLETENESS = ["complete", "partial", "unknown"] as const;
const REPORT_STATES = ["parsed", "invalid"] as const;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new Error(`invalid audit result: ${message}`);
}

function checkEvidence(evidence: AuditEvidenceReference, at: string): void {
  if (
    typeof evidence.source !== "string" ||
    !(SOURCES as readonly string[]).includes(evidence.source)
  )
    fail(`${at}.source must be a known audit document source`);
  if (
    typeof evidence.pointer !== "string" ||
    !POINTER_PATTERN.test(evidence.pointer)
  )
    fail(`${at}.pointer must be a JSON Pointer`);
  if (evidence.digest !== undefined && !SHA256_DIGEST.test(evidence.digest))
    fail(`${at}.digest must be a sha256 digest when present`);
  if (
    evidence.path !== undefined &&
    (typeof evidence.path !== "string" || evidence.path.length === 0)
  )
    fail(`${at}.path must be a non-empty string when present`);
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
      fail(`${at}.${rangeName} must be a non-empty range when present`);
  }
  if (
    evidence.elementId !== undefined &&
    (typeof evidence.elementId !== "string" || evidence.elementId.length === 0)
  )
    fail(`${at}.elementId must be a non-empty string when present`);
  if (evidence.note !== undefined && typeof evidence.note !== "string")
    fail(`${at}.note must be a string when present`);
}

/**
 * Enforces the claim-result invariants that schema/claim-result.v8.json
 * declares, at the audit boundary. Kept in sync with the schema by the
 * audit tests, which validate emitted results with ajv.
 */
export function assertValidAuditResult(result: AuditResult): void {
  if (result.schemaVersion !== AUDIT_SCHEMA_VERSION)
    fail(`schemaVersion must be ${AUDIT_SCHEMA_VERSION}`);
  if (
    result.source === undefined ||
    typeof result.source !== "object" ||
    result.source === null ||
    result.source.command !== "audit-run"
  )
    fail(`source.command must be 'audit-run'`);
  const inputs = result.inputs;
  if (inputs === undefined || typeof inputs !== "object" || inputs === null)
    fail("inputs must be an object");
  checkRunDescriptor(inputs.run, "inputs.run");
  if (!Array.isArray(inputs.checkReports))
    fail("inputs.checkReports must be an array");
  for (const [ri, entry] of (
    inputs.checkReports as Record<string, unknown>[]
  ).entries()) {
    const at = `inputs.checkReports[${ri}]`;
    if (entry.document !== "check-report")
      fail(`${at} must bind a check report`);
    if (entry.evaluatorId !== null && typeof entry.evaluatorId !== "string")
      fail(`${at}.evaluatorId must be a string or null`);
    if (!(REPORT_STATES as readonly string[]).includes(entry.state as string))
      fail(`${at}.state must be 'parsed' or 'invalid'`);
    if (
      !Number.isSafeInteger(entry.resultCount) ||
      (entry.resultCount as number) < 0
    )
      fail(`${at}.resultCount must be a non-negative integer`);
  }
  if (!Array.isArray(result.facts)) fail("facts must be an array");
  for (const [index, entry] of result.facts.entries()) {
    const at = `facts[${index}]`;
    if (typeof entry.id !== "string" || entry.id.length === 0)
      fail(`${at}.id must be a non-empty string`);
    if (
      entry.subject !== undefined &&
      (typeof entry.subject !== "string" || entry.subject.length === 0)
    )
      fail(`${at}.subject must be a non-empty string when present`);
    if (!(FACT_STATES as readonly string[]).includes(entry.state as string))
      fail(`${at}.state must be a known fact state`);
    if (
      !(COMPLETENESS as readonly string[]).includes(
        entry.completeness as string,
      )
    )
      fail(`${at}.completeness must be complete, partial, or unknown`);
    if (typeof entry.reason !== "string" || entry.reason.length === 0)
      fail(`${at}.reason must be a non-empty string`);
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0)
      fail(`${at}.evidence must contain at least one reference`);
    for (const [ei, evidence] of entry.evidence.entries())
      checkEvidence(evidence, `${at}.evidence[${ei}]`);
    const provenance = entry.provenance;
    if (
      provenance === undefined ||
      !Array.isArray(provenance.transform) ||
      provenance.transform.some((t: unknown) => typeof t !== "string")
    )
      fail(`${at}.provenance must carry transform`);
  }
}

function storedLineCount(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count === 0 && bytes.length > 0 ? 1 : count;
}

/** Evidence into a verified artifact's stored bytes (patch/result). */
function checkStoredByteEvidence(
  evidence: AuditEvidenceReference,
  entryIndex: number | null,
  digest: string | undefined,
  bytes: Buffer | null,
  parsedPaths: readonly string[] | null,
  at: string,
): void {
  if (entryIndex === null)
    fail(`${at} cites an artifact the run does not record`);
  const pointer = `/artifacts/${entryIndex}`;
  if (evidence.pointer !== pointer)
    fail(
      `${at} artifact evidence must point at the manifest entry ` +
        `(${pointer}), got '${evidence.pointer}'`,
    );
  // The digest is only meaningful (and only emitted) for verifiable
  // sha256-recorded bytes; a manifest digest in another algorithm is
  // unverifiable and simply not cited.
  const expectedDigest =
    digest !== undefined && SHA256_DIGEST.test(digest) ? digest : undefined;
  if (evidence.digest !== expectedDigest)
    fail(`${at} digest does not match the manifest's recorded digest`);
  if (
    evidence.lines === undefined &&
    evidence.bytes === undefined &&
    evidence.path === undefined
  )
    return;
  if (bytes === null) fail(`${at} cites artifact bytes that were not verified`);
  if (evidence.bytes !== undefined && evidence.bytes.end > bytes.length)
    fail(`${at}.bytes exceeds the stored artifact bytes`);
  if (evidence.lines !== undefined) {
    if (evidence.lines.start < 1) fail(`${at}.lines.start must be at least 1`);
    if (evidence.lines.end > storedLineCount(bytes))
      fail(`${at}.lines exceeds the stored artifact lines`);
  }
  if (
    evidence.path !== undefined &&
    parsedPaths !== null &&
    !parsedPaths.includes(evidence.path)
  )
    fail(
      `${at}.path names a file the patch does not record ` +
        `('${evidence.path}')`,
    );
}

/** Evidence into a verified supplemental JSON record's document. */
function checkRecordEvidence(
  evidence: AuditEvidenceReference,
  record: AuditedArtifactRecord,
  source: AuditEvidenceSource,
  at: string,
): void {
  if (record.document === null)
    fail(
      `${at} cites ${source} but the record has no verified parsed ` +
        "document",
    );
  const expectedDigest =
    record.digest !== null && SHA256_DIGEST.test(record.digest)
      ? record.digest
      : undefined;
  if (evidence.digest !== expectedDigest)
    fail(`${at} digest does not match the record's verified digest`);
  if (!resolvePointer(record.document, evidence.pointer).found)
    fail(`${at} pointer does not resolve in the ${source} document`);
}

function checkReportEvidence(
  evidence: AuditEvidenceReference,
  reports: readonly LoadedCheckReport[],
  at: string,
): void {
  // `elementId` names the supplying report by label; without it, the
  // pointer must resolve in at least one report document. A report whose
  // document did not parse has nothing to resolve against, so it may only be
  // cited as a whole (the empty pointer) by its label; a document that parsed
  // but failed validation is resolved like any other.
  const candidates =
    evidence.elementId === undefined
      ? reports
      : reports.filter((r) => r.label === evidence.elementId);
  const found = candidates.some((r) =>
    r.document === null
      ? evidence.pointer === ""
      : resolvePointer(r.document, evidence.pointer).found,
  );
  if (!found)
    fail(
      `${at} pointer '${evidence.pointer}' does not resolve in the ` +
        `checkReport document`,
    );
}

/** Resolution context for v8 evidence. */
export interface AuditDocs {
  readonly run: AuditedRun;
  readonly checkReports: readonly LoadedCheckReport[];
}

/**
 * Enforces the v8 evidence contract against the loaded inputs: trace and
 * manifest pointers resolve inside the run's documents; patch/result
 * evidence cites the artifact's manifest entry, repeats its recorded
 * digest, and keeps ranges inside the verified bytes; baselineManifest/
 * changes pointers resolve inside the verified record documents; check
 * report pointers resolve inside the supplied report documents.
 */
export function assertAuditEvidenceResolves(
  result: AuditResult,
  docs: AuditDocs,
): void {
  for (const [index, entry] of result.facts.entries()) {
    for (const [ei, evidence] of entry.evidence.entries()) {
      const at = `facts[${index}].evidence[${ei}]`;
      switch (evidence.source) {
        case "patch":
          checkStoredByteEvidence(
            evidence,
            docs.run.patchEntryIndex,
            docs.run.patchEntryIndex === null
              ? undefined
              : docs.run.entries[docs.run.patchEntryIndex].digest,
            docs.run.patchBytes,
            docs.run.patch?.files.map((f) => f.path) ?? null,
            at,
          );
          break;
        case "result":
          checkStoredByteEvidence(
            evidence,
            docs.run.resultEntryIndex,
            docs.run.resultEntryIndex === null
              ? undefined
              : docs.run.entries[docs.run.resultEntryIndex].digest,
            docs.run.resultBytes,
            null,
            at,
          );
          break;
        case "baselineManifest":
          checkRecordEvidence(
            evidence,
            docs.run.baselineManifest,
            "baselineManifest",
            at,
          );
          break;
        case "changes":
          checkRecordEvidence(evidence, docs.run.changes, "changes", at);
          break;
        case "trace":
          if (!resolvePointer(docs.run.trace.document, evidence.pointer).found)
            fail(`${at} pointer does not resolve in the trace document`);
          break;
        case "manifest":
          if (
            !resolvePointer(docs.run.manifestDocument, evidence.pointer).found
          )
            fail(`${at} pointer does not resolve in the manifest document`);
          break;
        case "checkReport":
          checkReportEvidence(evidence, docs.checkReports, at);
          break;
        default:
          fail(`${at}.source '${evidence.source}' is not a v8 evidence source`);
      }
    }
  }
}
