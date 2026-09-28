import type { CellEvidenceSource } from "./cell.js";
import {
  CELLS_MAX_RUNS,
  CELLS_SCHEMA_VERSION,
  type CellsReportResult,
} from "./cells.js";
import {
  checkCellSideEvidence,
  checkEvidenceFields,
  type CellSideDocs,
} from "./validate-cell.js";

/**
 * A v10 evidence source: `run<N>` + one of the per-run base document
 * names. `N` is 1-based and must not exceed the supplied run count.
 * `run<N>Evaluation` does not exist — `report-cells` takes no supplied
 * evaluation.
 */
const RUN_SOURCE_PATTERN =
  /^run([1-9][0-9]*)(Trace|Manifest|Export|Patch|Result|BaselineManifest|Changes)$/;
const RUN_SUBJECT_PATTERN = /^run([1-9][0-9]*)$/;
const LANES = [
  "association",
  "configuration",
  "execution",
  "audit",
  "set",
] as const;
const STATES = [
  "recorded",
  "verified",
  "inconsistent",
  "unverifiable",
  "not-recorded",
] as const;
const COMPLETENESS = ["complete", "partial", "unknown"] as const;

function fail(message: string): never {
  throw new Error(`invalid cells result: ${message}`);
}

/** Decodes `run<N>` in a source or subject to its 1-based index. */
function runIndexOf(value: string): number | null {
  const match = RUN_SUBJECT_PATTERN.exec(value);
  return match === null ? null : Number(match[1]);
}

/**
 * Enforces the claim-result invariants that schema/claim-result.v10.json
 * declares, at the report boundary. Kept in sync with the schema by the
 * cell tests, which validate emitted results with ajv.
 */
export function assertValidCellsResult(result: CellsReportResult): void {
  if (result.schemaVersion !== CELLS_SCHEMA_VERSION)
    fail(`schemaVersion must be ${CELLS_SCHEMA_VERSION}`);
  if (
    result.source === undefined ||
    typeof result.source !== "object" ||
    result.source === null ||
    result.source.command !== "report-cells"
  )
    fail("source.command must be 'report-cells'");
  const inputs = result.inputs;
  if (inputs === undefined || typeof inputs !== "object" || inputs === null)
    fail("inputs must be an object");
  if (!Array.isArray(inputs.runs)) fail("inputs.runs must be an array");
  if (inputs.runs.length < 2) fail("inputs.runs must name at least two runs");
  if (inputs.runs.length > CELLS_MAX_RUNS)
    fail(`inputs.runs must name at most ${CELLS_MAX_RUNS} runs`);
  for (const [index, descriptor] of inputs.runs.entries()) {
    const at = `inputs.runs[${index}]`;
    if (descriptor.name !== `run${index + 1}`)
      fail(`${at}.name must be 'run${index + 1}'`);
    if (
      typeof descriptor.runId !== "string" ||
      typeof descriptor.taskDigest !== "string" ||
      typeof descriptor.label !== "string" ||
      (descriptor.cellId !== null && typeof descriptor.cellId !== "string")
    )
      fail(`${at} must record label, runId, taskDigest, cellId`);
  }
  if (!Array.isArray(result.entries)) fail("entries must be an array");
  for (const [index, entry] of result.entries.entries()) {
    const at = `entries[${index}]`;
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      !(LANES as readonly string[]).includes(entry.lane as string)
    )
      fail(`${at} must carry a non-empty id in a known v10 lane`);
    if (entry.subject !== undefined) {
      const runIndex =
        typeof entry.subject === "string" ? runIndexOf(entry.subject) : null;
      if (runIndex === null || runIndex > inputs.runs.length)
        fail(`${at}.subject must be 'run<N>' within the supplied runs`);
      if (entry.lane === "set")
        fail(`${at} in the set lane must not carry a subject`);
    }
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
    for (const [ei, evidence] of entry.evidence.entries()) {
      const eat = `${at}.evidence[${ei}]`;
      if (typeof evidence.source !== "string")
        fail(`${eat}.source must be a known run-indexed evidence source`);
      const match = RUN_SOURCE_PATTERN.exec(evidence.source as string);
      if (match === null)
        fail(`${eat}.source must be a known run-indexed evidence source`);
      if (Number(match[1]) > inputs.runs.length)
        fail(`${eat}.source names a run beyond the supplied set`);
      checkEvidenceFields(evidence, eat);
    }
    const provenance = entry.provenance;
    if (
      provenance === undefined ||
      !Array.isArray(provenance.transform) ||
      provenance.transform.some((t: unknown) => typeof t !== "string")
    )
      fail(`${at}.provenance must carry transform`);
  }
}

/**
 * Enforces the v10 evidence contract against the loaded inputs: every
 * `run<N>*` reference resolves inside run N's documents under the same
 * per-source rules v9 applies (`checkCellSideEvidence`).
 */
export function assertCellsEvidenceResolves(
  result: CellsReportResult,
  cells: readonly CellSideDocs[],
): void {
  for (const [index, entry] of result.entries.entries()) {
    for (const [ei, evidence] of entry.evidence.entries()) {
      const at = `entries[${index}].evidence[${ei}]`;
      const match = RUN_SOURCE_PATTERN.exec(
        evidence.source as CellEvidenceSource & string,
      );
      if (match === null)
        fail(`${at}.source '${evidence.source}' is not a v10 evidence source`);
      const side = cells[Number(match[1]) - 1];
      if (side === undefined)
        fail(`no documents are bound for evidence source '${evidence.source}'`);
      const base = match[2][0]!.toLowerCase() + match[2].slice(1);
      checkCellSideEvidence(evidence, base, side, null, at);
    }
  }
}
