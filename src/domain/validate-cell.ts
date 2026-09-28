import type { AuditedArtifactRecord } from "../input/yuurei-audit-run.js";
import {
  CELL_SCHEMA_VERSION,
  type CellEvidenceReference,
  type CellEvidenceSource,
  type CellReportResult,
} from "./cell.js";
import { resolvePointer } from "./validate-trace-comparison.js";

const POINTER_PATTERN = /^$|^(?:\/(?:[^/~]|~0|~1)*)*$/;
const SOURCES: readonly CellEvidenceSource[] = [
  "trace",
  "manifest",
  "export",
  "patch",
  "result",
  "baselineManifest",
  "changes",
  "evaluation",
  "beforeTrace",
  "beforeManifest",
  "beforeExport",
  "beforePatch",
  "beforeResult",
  "beforeBaselineManifest",
  "beforeChanges",
  "beforeEvaluation",
  "afterTrace",
  "afterManifest",
  "afterExport",
  "afterPatch",
  "afterResult",
  "afterBaselineManifest",
  "afterChanges",
  "afterEvaluation",
];
const LANES = [
  "association",
  "configuration",
  "execution",
  "audit",
  "evaluation",
  "comparison",
] as const;
const STATES = [
  "recorded",
  "verified",
  "inconsistent",
  "unverifiable",
  "not-recorded",
] as const;
const COMPLETENESS = ["complete", "partial", "unknown"] as const;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new Error(`invalid cell result: ${message}`);
}

function checkEvidence(evidence: CellEvidenceReference, at: string): void {
  if (typeof evidence.source !== "string" || !SOURCES.includes(evidence.source))
    fail(`${at}.source must be a known cell evidence source`);
  checkEvidenceFields(evidence, at);
}

/**
 * The shape checks every cell evidence reference carries — pointer
 * syntax, digest form, range sanity — independent of which document
 * family `source` names (the source enum differs between v9 and v10).
 */
export function checkEvidenceFields(
  evidence: CellEvidenceReference,
  at: string,
): void {
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
 * Enforces the claim-result invariants that schema/claim-result.v9.json
 * declares, at the report boundary. Kept in sync with the schema by the
 * cell tests, which validate emitted results with ajv.
 */
export function assertValidCellResult(result: CellReportResult): void {
  if (result.schemaVersion !== CELL_SCHEMA_VERSION)
    fail(`schemaVersion must be ${CELL_SCHEMA_VERSION}`);
  if (
    result.source === undefined ||
    typeof result.source !== "object" ||
    result.source === null ||
    (result.source.command !== "report-cell" &&
      result.source.command !== "compare-cells")
  )
    fail("source.command must be 'report-cell' or 'compare-cells'");
  const inputs = result.inputs;
  if (inputs === undefined || typeof inputs !== "object" || inputs === null)
    fail("inputs must be an object");
  if (result.source.command === "report-cell") {
    if (inputs.run === undefined) fail("inputs.run must be present");
    if (inputs.before !== undefined || inputs.after !== undefined)
      fail("report-cell inputs must not record before/after");
  } else {
    if (inputs.before === undefined || inputs.after === undefined)
      fail("compare-cells inputs must record before and after");
    if (inputs.run !== undefined)
      fail("compare-cells inputs must not record run");
  }
  for (const descriptor of [inputs.run, inputs.before, inputs.after].filter(
    (entry) => entry !== undefined,
  )) {
    if (
      typeof descriptor.runId !== "string" ||
      typeof descriptor.taskDigest !== "string" ||
      typeof descriptor.label !== "string" ||
      (descriptor.cellId !== null && typeof descriptor.cellId !== "string")
    )
      fail("run descriptors must record label, runId, taskDigest, cellId");
  }
  if (!Array.isArray(result.entries)) fail("entries must be an array");
  for (const [index, entry] of result.entries.entries()) {
    const at = `entries[${index}]`;
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      !(LANES as readonly string[]).includes(entry.lane as string)
    )
      fail(`${at} must carry a non-empty id in a known lane`);
    if (
      entry.subject !== undefined &&
      entry.subject !== "before" &&
      entry.subject !== "after"
    )
      fail(`${at}.subject must be 'before' or 'after' when present`);
    if (!(STATES as readonly string[]).includes(entry.state as string))
      fail(`${at}.state must be a known entry state`);
    if (
      !(COMPLETENESS as readonly string[]).includes(
        entry.completeness as string,
      )
    )
      fail(`${at}.completeness must be complete, partial, or unknown`);
    if (typeof entry.statement !== "string" || entry.statement.length === 0)
      fail(`${at}.statement must be a non-empty string`);
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

/** The per-side documents an entry's evidence resolves against. */
export interface CellSideDocs {
  readonly traceDocument: unknown;
  readonly manifestDocument: unknown;
  readonly patchEntryIndex: number | null;
  readonly patchEntryDigest: string | undefined;
  readonly patchBytes: Buffer | null;
  readonly patchPaths: readonly string[] | null;
  readonly resultEntryIndex: number | null;
  readonly resultEntryDigest: string | undefined;
  readonly resultBytes: Buffer | null;
  readonly baselineManifest: AuditedArtifactRecord;
  readonly changes: AuditedArtifactRecord;
  readonly exportRecord: AuditedArtifactRecord | null;
  /** The verified export's parsed JSON, for `export` pointer resolution. */
  readonly exportDocument: unknown;
}

export interface CellDocs {
  /** Index 0 is `run`/`before`; index 1 is `after` in a comparison. */
  readonly cells: readonly CellSideDocs[];
  /** The supplied evaluation document, or null. */
  readonly evaluation: unknown;
}

function sideOf(source: CellEvidenceSource): "none" | "before" | "after" {
  if (source.startsWith("before")) return "before";
  if (source.startsWith("after")) return "after";
  return "none";
}

function baseSource(source: CellEvidenceSource): string {
  const side = sideOf(source);
  if (side === "none") return source;
  const rest = source.slice(side.length);
  return rest[0]!.toLowerCase() + rest.slice(1);
}

function sideDocs(docs: CellDocs, source: CellEvidenceSource): CellSideDocs {
  const side = sideOf(source);
  const index = side === "after" ? 1 : 0;
  const doc = docs.cells[index];
  if (doc === undefined)
    fail(`no documents are bound for evidence source '${source}'`);
  return doc;
}

function storedLineCount(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count === 0 && bytes.length > 0 ? 1 : count;
}

/** Evidence into a verified artifact's stored bytes (patch/result). */
function checkStoredByteEvidence(
  evidence: CellEvidenceReference,
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
  evidence: CellEvidenceReference,
  record: AuditedArtifactRecord,
  source: string,
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

/**
 * Checks one evidence reference against one run's bound documents —
 * shared by the v9 (`assertCellEvidenceResolves`) and v10
 * (`assertCellsEvidenceResolves`) resolution passes. `base` is the
 * side-prefix-stripped source name; `evaluation` is the supplied
 * evaluation document or null.
 */
export function checkCellSideEvidence(
  evidence: CellEvidenceReference,
  base: string,
  side: CellSideDocs,
  evaluation: unknown,
  at: string,
): void {
  switch (base) {
    case "trace":
      if (!resolvePointer(side.traceDocument, evidence.pointer).found)
        fail(`${at} pointer does not resolve in the trace document`);
      break;
    case "manifest":
      if (!resolvePointer(side.manifestDocument, evidence.pointer).found)
        fail(`${at} pointer does not resolve in the manifest document`);
      break;
    case "export":
      if (side.exportRecord === null || side.exportDocument === null)
        fail(`${at} cites an export no verified document exists for`);
      else {
        const expectedDigest =
          side.exportRecord.digest !== null &&
          SHA256_DIGEST.test(side.exportRecord.digest)
            ? side.exportRecord.digest
            : undefined;
        if (evidence.digest !== expectedDigest)
          fail(`${at} digest does not match the export's verified digest`);
        if (!resolvePointer(side.exportDocument, evidence.pointer).found)
          fail(`${at} pointer does not resolve in the export document`);
      }
      break;
    case "patch":
      checkStoredByteEvidence(
        evidence,
        side.patchEntryIndex,
        side.patchEntryDigest,
        side.patchBytes,
        side.patchPaths,
        at,
      );
      break;
    case "result":
      checkStoredByteEvidence(
        evidence,
        side.resultEntryIndex,
        side.resultEntryDigest,
        side.resultBytes,
        null,
        at,
      );
      break;
    case "baselineManifest":
      checkRecordEvidence(
        evidence,
        side.baselineManifest,
        "baselineManifest",
        at,
      );
      break;
    case "changes":
      checkRecordEvidence(evidence, side.changes, "changes", at);
      break;
    case "evaluation":
      if (evaluation === null || evaluation === undefined)
        fail(`${at} cites an evaluation no document was supplied for`);
      else if (!resolvePointer(evaluation, evidence.pointer).found)
        fail(`${at} pointer does not resolve in the evaluation document`);
      break;
    default:
      fail(`${at}.source '${evidence.source}' is not a cell evidence source`);
  }
}

/**
 * Enforces the v9 evidence contract against the loaded inputs: trace and
 * manifest pointers resolve inside each side's documents; patch/result
 * evidence cites the artifact's manifest entry, repeats its recorded
 * digest, and keeps ranges inside verified bytes; supplemental-record and
 * export pointers resolve inside verified documents; evaluation pointers
 * resolve inside the supplied document.
 */
export function assertCellEvidenceResolves(
  result: CellReportResult,
  docs: CellDocs,
): void {
  for (const [index, entry] of result.entries.entries()) {
    for (const [ei, evidence] of entry.evidence.entries()) {
      const at = `entries[${index}].evidence[${ei}]`;
      const side = sideDocs(docs, evidence.source);
      checkCellSideEvidence(
        evidence,
        baseSource(evidence.source),
        side,
        docs.evaluation,
        at,
      );
    }
  }
}
