import type { AuditEvidenceSource, AuditFact } from "../domain/audit.js";
import { compareBytes } from "../domain/byte-order.js";
import {
  CELL_SCHEMA_VERSION,
  type CellCommand,
  type CellEntry,
  type CellCompleteness,
  type CellEntryState,
  type CellEvidenceReference,
  type CellEvidenceSource,
  type CellLane,
  type CellReportResult,
  type CellRunInputDescriptor,
  type CellsRunName,
} from "../domain/cell.js";
import type { CellsCommand } from "../domain/cells.js";
import { sanitizeText } from "../domain/sanitize.js";
import {
  assertCellEvidenceResolves,
  assertValidCellResult,
  type CellSideDocs,
} from "../domain/validate-cell.js";
import type { SuppliedEvaluation } from "../input/cell-evaluation.js";
import { PflExportError } from "../input/pfl-export.js";
import {
  OBSERVATION_EXPORT_PATH,
  type CellObservation,
  type CellRun,
} from "../input/yuurei-cell.js";
import type { AuditedArtifactRecord } from "../input/yuurei-audit-run.js";
import { auditRun } from "./audit-run.js";
import { byFinding, byRelation } from "./cell-diff.js";
import { MAX_EMITTED_CLAIMS, MAX_EVIDENCE_REFERENCES } from "./limits.js";

/**
 * The emit context for one entry: which supplied run it describes
 * (`"before"`/`"after"` in a v9 comparison, `run1`…`runN` in a v10
 * set report; undefined for single-cell results and for set/comparison
 * entries) — the label prefixes every evidence source name so pointers
 * stay bound to the run they cite.
 */
export interface CellCtx {
  readonly cell: CellRun;
  readonly subject?: "before" | "after" | CellsRunName;
  readonly command: CellCommand | CellsCommand;
}

/** The subset of emit context entry formatting needs. */
export interface CellEmitCtx {
  readonly subject?: "before" | "after" | CellsRunName;
  readonly command: CellCommand | CellsCommand;
}

type BaseSource =
  | "trace"
  | "manifest"
  | "export"
  | "patch"
  | "result"
  | "baselineManifest"
  | "changes"
  | "evaluation";

const LANE_ORDER: Record<CellLane, number> = {
  association: 0,
  configuration: 1,
  execution: 2,
  audit: 3,
  evaluation: 4,
  comparison: 5,
  set: 6,
};

/**
 * The base-document order inside one run's evidence. v9's `before*`/
 * `after*` source names carry this same order with the side prefix
 * stripped; v10's `run<N>*` names sort by run index first, then base.
 */
const BASE_SOURCE_ORDER: Record<string, number> = {
  trace: 0,
  manifest: 1,
  export: 2,
  patch: 3,
  result: 4,
  baselineManifest: 5,
  changes: 6,
  evaluation: 7,
};

/**
 * Decodes an evidence source into its ordering key: `[run index, base
 * order]`. `before*`/`after*` and bare v9 names keep rank 0 — the two
 * sides tie on base order and resolve by pointer, exactly as the v9
 * fixed table sorted them. `run<N>*` names rank by the run's position.
 */
function sourceOrderKey(source: CellEvidenceSource): [number, number] {
  const run = /^run([1-9][0-9]*)([A-Z].*)$/.exec(source);
  if (run !== null) {
    const base = run[2]![0]!.toLowerCase() + run[2]!.slice(1);
    return [Number(run[1]), BASE_SOURCE_ORDER[base] ?? -1];
  }
  const side = /^(before|after)([A-Z].*)$/.exec(source);
  if (side !== null) {
    const base = side[2]![0]!.toLowerCase() + side[2]!.slice(1);
    return [0, BASE_SOURCE_ORDER[base] ?? -1];
  }
  return [0, BASE_SOURCE_ORDER[source] ?? -1];
}

/** Maps one cell-side base source onto the result's evidence vocabulary. */
export function cellSource(
  ctx: CellEmitCtx,
  base: BaseSource,
): CellEvidenceSource {
  if (ctx.subject === undefined) return base;
  const suffix = base[0]!.toUpperCase() + base.slice(1);
  return `${ctx.subject}${suffix}` as CellEvidenceSource;
}

export function cellEv(
  ctx: CellEmitCtx,
  base: BaseSource,
  pointer: string,
  extra?: Partial<Omit<CellEvidenceReference, "source" | "pointer">>,
): CellEvidenceReference {
  return {
    source: cellSource(ctx, base),
    pointer,
    ...extra,
  };
}

/** Sorts evidence per contract: run order, base source order, pointer bytes. */
export function sortCellEvidence(
  evidence: readonly CellEvidenceReference[],
): CellEvidenceReference[] {
  const key = (entry: CellEvidenceReference) => sourceOrderKey(entry.source);
  return [...evidence]
    .map((entry) => ({ entry, key: key(entry) }))
    .sort(
      (a, b) =>
        a.key[0] - b.key[0] ||
        a.key[1] - b.key[1] ||
        compareBytes(a.entry.pointer, b.entry.pointer),
    )
    .map(({ entry }) => entry);
}

export function cellEntry(
  ctx: CellEmitCtx,
  lane: CellLane,
  id: string,
  state: CellEntryState,
  completeness: CellCompleteness,
  statement: string,
  evidence: readonly CellEvidenceReference[],
): CellEntry {
  return {
    lane,
    ...(ctx.subject === undefined ? {} : { subject: ctx.subject }),
    id,
    state,
    completeness,
    statement: sanitizeText(statement),
    evidence: sortCellEvidence(evidence),
    provenance: { transform: [ctx.command, `entry:${id}`] },
  };
}

/** Orders entries: side, then lane, then the builder's own order. */
export function sortCellEntries(entries: readonly CellEntry[]): CellEntry[] {
  const subjectRank = (entry: CellEntry) =>
    entry.subject === "before" ? 0 : entry.subject === "after" ? 1 : 2;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        subjectRank(a.entry) - subjectRank(b.entry) ||
        LANE_ORDER[a.entry.lane] - LANE_ORDER[b.entry.lane] ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

// -- input descriptors ------------------------------------------------------

export function cellRunInput(
  cell: CellRun,
  label?: string,
): CellRunInputDescriptor {
  const trace = cell.run.trace;
  const observation = cell.observation;
  // The descriptor is the report's compact identity record: only a bound
  // export's snapshot ids belong to this cell. An export whose recorded
  // cellId does not equal the trace's cell_id stays out of it, exactly as
  // the configuration lane withholds that export's content.
  const document = observation.exportDocument;
  const bound =
    observation.record !== undefined &&
    observation.exportDeclared &&
    document !== null &&
    trace.cellId !== undefined &&
    document.data.snapshot.cellId === trace.cellId;
  const snapshot = bound ? document!.data.snapshot : undefined;
  return {
    label: label ?? cell.label,
    runId: trace.runId,
    cellId: trace.cellId ?? null,
    taskDigest: trace.task.digest,
    profileName: trace.profile.name,
    profileDigest: trace.profile.digest,
    runtimeId: trace.runtime.id,
    requestedCellDigest: trace.requestedCell?.digest ?? null,
    observationStatus: trace.observation?.status ?? null,
    observationReason: trace.observation?.reason ?? null,
    exportObservedSnapshotId: snapshot?.observedSnapshotId ?? null,
    exportResolvedSnapshotId: snapshot?.resolvedSnapshotId ?? null,
  };
}

// -- association lane -------------------------------------------------------

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function exportEntryEv(
  ctx: CellCtx,
  record: AuditedArtifactRecord,
  note?: string,
): CellEvidenceReference {
  return cellEv(ctx, "manifest", `/artifacts/${record.entryIndex ?? 0}`, {
    ...(record.digest !== null && SHA256_DIGEST.test(record.digest)
      ? { digest: record.digest }
      : {}),
    ...(note === undefined ? {} : { note }),
  });
}

export function exportDocEv(
  ctx: CellCtx,
  record: AuditedArtifactRecord,
  pointer: string,
  elementId?: string,
): CellEvidenceReference {
  return cellEv(ctx, "export", pointer, {
    ...(record.digest !== null && SHA256_DIGEST.test(record.digest)
      ? { digest: record.digest }
      : {}),
    ...(elementId === undefined ? {} : { elementId }),
  });
}

/**
 * The shared cascade for checks that need a parsed export: when no
 * conforming document exists, the check's state mirrors *why* — nothing
 * recorded stays `not-recorded`; retained-but-unusable bytes are
 * `unverifiable`.
 */
function noExportState(observation: CellObservation): CellEntryState {
  return observation.record === undefined ||
    (!observation.exportDeclared && observation.exportRecord === null)
    ? "not-recorded"
    : "unverifiable";
}

/**
 * Why no configuration is presented for one cell. A parsed export that is
 * not bound to this cell is stated as *unbound*, never as a missing or
 * uninterpretable document: the bytes exist and were read, and only the
 * association failed.
 */
export function availabilityReason(
  observation: CellObservation,
  binding: CellEntryState,
): string {
  if (binding === "not-recorded") return noExportReason(observation);
  if (binding === "inconsistent")
    return (
      "the retained export records a different cell_id than the trace " +
      "(see association.export-binding): the document exists and was read, " +
      "but it is not bound to this cell"
    );
  if (observation.exportDocument !== null) {
    const cellId = observation.exportDocument.data.snapshot.cellId;
    return cellId === undefined
      ? "the retained export does not record a cellId, so the association cannot be checked"
      : cellId === null
        ? "the retained export records cellId: null — it asserts no cell association"
        : "the trace records no cell_id, so the retained export's association cannot be checked";
  }
  return noExportReason(observation);
}

export function noExportReason(observation: CellObservation): string {
  if (observation.record === undefined)
    return "the trace records no observation record";
  if (observation.exportRecord === null)
    return observation.exportDeclared
      ? `the trace declares '${OBSERVATION_EXPORT_PATH}' but the manifest does not retain it`
      : `the observation record does not declare '${OBSERVATION_EXPORT_PATH}'`;
  if (observation.exportRecord.state !== "verified")
    return `the retained export artifact is in state '${observation.exportRecord.state}'`;
  if (observation.exportIssue !== null)
    return `the verified bytes are not an interpretable export (${observation.exportIssueDetail ?? observation.exportIssue})`;
  return "no interpretable export document is retained";
}

/** Whether the raw trace document records the named top-level field. */
function traceHasField(ctx: CellCtx, field: string): boolean {
  const document = ctx.cell.run.trace.document;
  return (
    typeof document === "object" &&
    document !== null &&
    Object.prototype.hasOwnProperty.call(document, field)
  );
}

/**
 * Evidence for an optional trace field: the field pointer when the raw
 * document records it, otherwise the document root with a note — so the
 * reference always resolves and still says which field was absent.
 */
export function traceFieldEv(
  ctx: CellCtx,
  field: string,
): CellEvidenceReference {
  return traceHasField(ctx, field)
    ? cellEv(ctx, "trace", `/${field}`)
    : cellEv(ctx, "trace", "", { note: `no ${field} field` });
}

/**
 * Evidence for a nullable record inside an optional/required trace object:
 * the nested pointer when the raw document records it, otherwise the
 * parent object pointer with a note.
 */
export function traceNestedEv(
  ctx: CellCtx,
  parent: string,
  field: string,
): CellEvidenceReference {
  const document = ctx.cell.run.trace.document;
  const parentValue =
    typeof document === "object" && document !== null
      ? (document as Record<string, unknown>)[parent]
      : undefined;
  const present =
    typeof parentValue === "object" &&
    parentValue !== null &&
    Object.prototype.hasOwnProperty.call(parentValue, field);
  return present
    ? cellEv(ctx, "trace", `/${parent}/${field}`)
    : cellEv(ctx, "trace", `/${parent}`, {
        note: `no ${field} field`,
      });
}

/**
 * Evidence into the bound export: a document pointer when a verified
 * document exists, otherwise the export's manifest entry — the retained
 * bytes, not the unparseable content.
 */
function exportRefEv(
  ctx: CellCtx,
  record: AuditedArtifactRecord,
  pointer: string,
  elementId?: string,
  note?: string,
): CellEvidenceReference {
  return ctx.cell.observation.exportDocument !== null
    ? exportDocEv(ctx, record, pointer, elementId)
    : exportEntryEv(ctx, record, note ?? "no verified export document");
}

/**
 * Evidence for an optional field inside the bound export's `data.snapshot`:
 * the field pointer when the document records the key, otherwise the
 * `data.snapshot` object with a note. A key a document does not carry
 * (pfl before v1.2.0, or an authored record) leaves the reference
 * resolvable and still says which field was absent.
 */
function exportNestedEv(
  ctx: CellCtx,
  record: AuditedArtifactRecord,
  parent: string,
  field: string,
): CellEvidenceReference {
  const document = ctx.cell.observation.exportDocument;
  const parentValue = document === null ? undefined : document.data.snapshot;
  const present =
    typeof parentValue === "object" &&
    parentValue !== null &&
    Object.prototype.hasOwnProperty.call(parentValue, field);
  return present
    ? exportRefEv(ctx, record, `${parent}/${field}`)
    : exportRefEv(ctx, record, parent, undefined, `no ${field} field`);
}

export function exportDocEvidence(ctx: CellCtx): CellEvidenceReference[] {
  const record = ctx.cell.observation.exportRecord;
  const evidence: CellEvidenceReference[] = [
    ctx.cell.observation.record === undefined
      ? cellEv(ctx, "trace", "", { note: "no observation field" })
      : cellEv(ctx, "trace", "/observation"),
  ];
  if (record !== null && record.entryIndex !== null)
    evidence.push(exportEntryEv(ctx, record));
  else
    evidence.push(
      cellEv(ctx, "manifest", "", { note: "no export manifest entry" }),
    );
  return evidence;
}

/**
 * The fixed association checks (docs/v0.9-scope.md#cross-record-checks).
 * Every check emits an entry even when nothing is recorded, so a missing
 * observation reads as absence, never as an empty configuration.
 * Returns the entries plus the binding state the configuration lane keys
 * on.
 */
export function associationEntries(ctx: CellCtx): {
  entries: CellEntry[];
  binding: CellEntryState;
  /** State of the `association.export-source-project` check. */
  sourceProject: CellEntryState;
} {
  const trace = ctx.cell.run.trace;
  const observation = ctx.cell.observation;
  const record = observation.exportRecord;
  const entries: CellEntry[] = [];

  // association.cell-id
  entries.push(
    trace.cellId === undefined
      ? cellEntry(
          ctx,
          "association",
          "association.cell-id",
          "not-recorded",
          "unknown",
          "the trace does not record a cell_id",
          [cellEv(ctx, "trace", "", { note: "no cell_id field" })],
        )
      : cellEntry(
          ctx,
          "association",
          "association.cell-id",
          "recorded",
          "complete",
          `the trace records cell_id '${trace.cellId}'`,
          [cellEv(ctx, "trace", "/cell_id")],
        ),
  );

  // The run's own observation record is what declares the export
  // artifact; an artifact no record declares belongs to no cell record
  // and is never read as this run's observed configuration. It stays
  // reportable as a retained manifest entry and as a record-consistency
  // contradiction (below), but every `export.*` fact is `not-recorded`
  // until a record declares the path (docs/v0.9-scope.md case matrix).
  const exportDeclared =
    observation.record !== undefined && observation.exportDeclared;
  const undeclaredStatement = (): string =>
    observation.record === undefined
      ? "the trace records no observation record, so no export artifact is declared"
      : `the observation record does not declare '${OBSERVATION_EXPORT_PATH}', so the manifest-listed artifact is not read as this run's export`;

  // association.observation
  if (observation.record === undefined) {
    entries.push(
      cellEntry(
        ctx,
        "association",
        "association.observation",
        "not-recorded",
        "unknown",
        "the trace records no observation record; the pre-run observed " +
          "configuration is unknown, not absent",
        [cellEv(ctx, "trace", "", { note: "no observation field" })],
      ),
    );
  } else {
    const reason =
      observation.record.reason === null
        ? ""
        : ` (reason '${observation.record.reason}')`;
    entries.push(
      cellEntry(
        ctx,
        "association",
        "association.observation",
        "recorded",
        observation.record.status === "partial" ? "partial" : "complete",
        `the observation record reports status '${observation.record.status}'` +
          ` from observer '${observation.record.observer.id}'` +
          (observation.record.observer.version === null
            ? ""
            : ` ${observation.record.observer.version}`) +
          reason,
        [
          cellEv(ctx, "trace", "/observation/status"),
          cellEv(ctx, "trace", "/observation/observer/id"),
          ...(observation.record.reason === null
            ? []
            : [cellEv(ctx, "trace", "/observation/reason")]),
        ],
      ),
    );
  }

  // association.export-retained
  {
    let state: CellEntryState;
    let completeness: CellCompleteness;
    let statement: string;
    if (!exportDeclared) {
      state = "not-recorded";
      completeness = "unknown";
      statement = undeclaredStatement();
    } else if (record === null) {
      state = observation.exportDeclared ? "unverifiable" : "not-recorded";
      completeness = "unknown";
      statement = observation.exportDeclared
        ? `the trace declares '${OBSERVATION_EXPORT_PATH}' but the manifest does not list it`
        : `the observation record does not declare '${OBSERVATION_EXPORT_PATH}' and the manifest retains none`;
    } else if (record.state === "verified") {
      state = "verified";
      completeness = "complete";
      statement =
        `the manifest retains '${OBSERVATION_EXPORT_PATH}' and the stored ` +
        `bytes verify (${record.bytes ?? "?"} bytes)`;
    } else if (record.state === "verified-truncated") {
      state = "verified";
      completeness = "partial";
      statement =
        `the manifest retains '${OBSERVATION_EXPORT_PATH}'; the bytes verify ` +
        `but the manifest records them truncated — an incomplete record`;
    } else if (record.state === "digest-mismatch") {
      state = "inconsistent";
      completeness = "unknown";
      statement = `the retained bytes do not match the manifest's recorded digest for '${OBSERVATION_EXPORT_PATH}'`;
    } else {
      state = "unverifiable";
      completeness = "unknown";
      statement = `the manifest lists '${OBSERVATION_EXPORT_PATH}' but its stored bytes are '${record.state}'`;
    }
    const evidence: CellEvidenceReference[] = [];
    if (record !== null && record.entryIndex !== null)
      evidence.push(exportEntryEv(ctx, record));
    else
      evidence.push(
        cellEv(ctx, "manifest", "", { note: "no such manifest entry" }),
      );
    if (observation.record !== undefined)
      evidence.push(cellEv(ctx, "trace", "/observation/artifacts"));
    entries.push(
      cellEntry(
        ctx,
        "association",
        "association.export-retained",
        state,
        completeness,
        statement,
        evidence,
      ),
    );
  }

  // association.export-document
  {
    const issue = observation.exportIssue;
    let state: CellEntryState;
    let completeness: CellCompleteness;
    let statement: string;
    if (!exportDeclared) {
      state = "not-recorded";
      completeness = "unknown";
      statement = undeclaredStatement();
    } else if (record === null || observation.exportDocument !== null) {
      state = observation.exportDocument !== null ? "verified" : "not-recorded";
      completeness =
        observation.exportDocument === null
          ? "unknown"
          : observation.exportDocument.completeness;
      statement =
        observation.exportDocument === null
          ? "no export artifact is retained"
          : `the retained bytes are a conforming pfl export document ` +
            `(pflVersion '${observation.exportDocument.pflVersion}', completeness '${observation.exportDocument.completeness}')`;
    } else if (
      record.state === "verified" ||
      record.state === "verified-truncated"
    ) {
      // Bytes verified but the content is not a usable export document.
      if (record.truncated) {
        state = "unverifiable";
        completeness = "partial";
        statement =
          "the retained bytes verify but are truncated; no complete document can be trusted";
      } else if (
        issue === "failure-document" ||
        issue === "unsupported-version"
      ) {
        state = "unverifiable";
        completeness = "unknown";
        statement = `the retained bytes are not an interpretable export: ${observation.exportIssueDetail}`;
      } else {
        state = "inconsistent";
        completeness = "unknown";
        statement = `the retained bytes are not the declared export record: ${observation.exportIssueDetail ?? "not a pfl export document"}`;
      }
    } else {
      state = "unverifiable";
      completeness = "unknown";
      statement = `no verified export bytes exist (artifact state '${record.state}')`;
    }
    entries.push(
      cellEntry(
        ctx,
        "association",
        "association.export-document",
        state,
        completeness,
        statement,
        exportDocEvidence(ctx),
      ),
    );
  }

  // association.export-binding — cellId equality.
  {
    const exported = observation.exportDocument?.data.snapshot.cellId;
    let state: CellEntryState;
    let completeness: CellCompleteness;
    let statement: string;
    if (!exportDeclared) {
      state = "not-recorded";
      completeness = "unknown";
      statement =
        `${undeclaredStatement()}; the association between this run and ` +
        `a retained export cannot be checked`;
    } else if (observation.exportDocument === null) {
      state = noExportState(observation);
      completeness = "unknown";
      statement = `no interpretable export exists to compare: ${noExportReason(observation)}`;
    } else if (trace.cellId === undefined) {
      state = "unverifiable";
      completeness = "unknown";
      statement =
        "the trace records no cell_id, so the export's declared cell " +
        "association cannot be checked";
    } else if (exported === undefined) {
      state = "unverifiable";
      completeness = "unknown";
      statement =
        "the export does not carry data.snapshot.cellId (pfl before " +
        "v1.2.0 or the key omitted), so the association cannot be checked";
    } else if (exported === null) {
      state = "unverifiable";
      completeness = "unknown";
      statement =
        "the export records cellId: null — it asserts no cell association";
    } else if (exported === trace.cellId) {
      state = "verified";
      completeness = "complete";
      statement =
        `the export's recorded cellId '${exported}' equals the trace's ` +
        `cell_id — a recorded association between the run and the ` +
        `export's caller-asserted provenance, not proof of observation`;
    } else {
      state = "inconsistent";
      completeness = "complete";
      statement =
        `the export's recorded cellId '${exported}' does not equal the ` +
        `trace's cell_id '${trace.cellId}'`;
    }
    const evidence: CellEvidenceReference[] = [
      trace.cellId === undefined
        ? cellEv(ctx, "trace", "", { note: "no cell_id field" })
        : cellEv(ctx, "trace", "/cell_id"),
    ];
    if (record !== null)
      evidence.push(exportNestedEv(ctx, record, "/data/snapshot", "cellId"));
    else
      evidence.push(
        cellEv(ctx, "manifest", "", { note: "no export manifest entry" }),
      );
    entries.push(
      cellEntry(
        ctx,
        "association",
        "association.export-binding",
        state,
        completeness,
        statement,
        evidence,
      ),
    );
  }

  // association.export-snapshots — observation.snapshot_ids vs export ids.
  {
    let state: CellEntryState;
    let completeness: CellCompleteness;
    let statement: string;
    if (!exportDeclared) {
      state = "not-recorded";
      completeness = "unknown";
      statement = undeclaredStatement();
    } else if (observation.exportDocument === null) {
      state = noExportState(observation);
      completeness = "unknown";
      statement = `no interpretable export exists to compare: ${noExportReason(observation)}`;
    } else if (observation.record === undefined) {
      state = "not-recorded";
      completeness = "unknown";
      statement =
        "the trace records no observation record, so no snapshot_ids " +
        "declaration exists to compare against";
    } else if (observation.record.snapshotIds === null) {
      state = "unverifiable";
      completeness = "unknown";
      statement =
        "the observation record does not record snapshot_ids; the " +
        "export's own snapshot ids cannot be cross-checked";
    } else {
      const snapshot = observation.exportDocument.data.snapshot;
      const ids = observation.record.snapshotIds;
      const observedOk = snapshot.observedSnapshotId === ids.observed;
      const resolvedOk = snapshot.resolvedSnapshotId === ids.resolved;
      if (observedOk && resolvedOk) {
        state = "verified";
        completeness = "complete";
        statement =
          `the recorded snapshot_ids ('${ids.observed}', '${ids.resolved}') ` +
          `equal the export's observed and resolved snapshot ids`;
      } else {
        state = "inconsistent";
        completeness = "complete";
        statement =
          `the recorded snapshot_ids ('${ids.observed}', '${ids.resolved}') ` +
          `do not equal the export's snapshot ids ` +
          `('${snapshot.observedSnapshotId}', '${snapshot.resolvedSnapshotId}')`;
      }
    }
    const evidence: CellEvidenceReference[] = [];
    if (observation.record !== undefined)
      evidence.push(cellEv(ctx, "trace", "/observation/snapshot_ids"));
    else
      evidence.push(cellEv(ctx, "trace", "", { note: "no observation field" }));
    if (record !== null)
      evidence.push(
        exportRefEv(ctx, record, "/data/snapshot/observedSnapshotId"),
        exportRefEv(ctx, record, "/data/snapshot/resolvedSnapshotId"),
      );
    else
      evidence.push(
        cellEv(ctx, "manifest", "", { note: "no export manifest entry" }),
      );
    entries.push(
      cellEntry(
        ctx,
        "association",
        "association.export-snapshots",
        state,
        completeness,
        statement,
        evidence,
      ),
    );
  }

  // association.export-runtime — export runtime id vs trace runtime id.
  {
    let state: CellEntryState;
    let completeness: CellCompleteness;
    let statement: string;
    if (!exportDeclared) {
      state = "not-recorded";
      completeness = "unknown";
      statement = undeclaredStatement();
    } else if (observation.exportDocument === null) {
      state = noExportState(observation);
      completeness = "unknown";
      statement = `no interpretable export exists to compare: ${noExportReason(observation)}`;
    } else if (
      observation.exportDocument.data.runtime.id === trace.runtime.id
    ) {
      state = "verified";
      completeness = "complete";
      statement = `the export's runtime.id '${trace.runtime.id}' equals the trace's runtime.id`;
    } else {
      state = "inconsistent";
      completeness = "complete";
      statement =
        `the export's runtime.id '${observation.exportDocument.data.runtime.id}' ` +
        `does not equal the trace's runtime.id '${trace.runtime.id}'`;
    }
    const evidence: CellEvidenceReference[] = [
      cellEv(ctx, "trace", "/runtime/id"),
    ];
    if (record !== null)
      evidence.push(exportRefEv(ctx, record, "/data/runtime/id"));
    else
      evidence.push(
        cellEv(ctx, "manifest", "", { note: "no export manifest entry" }),
      );
    entries.push(
      cellEntry(
        ctx,
        "association",
        "association.export-runtime",
        state,
        completeness,
        statement,
        evidence,
      ),
    );
  }

  // association.export-completeness — observation.completeness vs export.
  {
    let state: CellEntryState;
    let completeness: CellCompleteness;
    let statement: string;
    if (!exportDeclared) {
      state = "not-recorded";
      completeness = "unknown";
      statement = undeclaredStatement();
    } else if (observation.exportDocument === null) {
      state = noExportState(observation);
      completeness = "unknown";
      statement = `no interpretable export exists to compare: ${noExportReason(observation)}`;
    } else if (observation.record === undefined) {
      state = "not-recorded";
      completeness = "unknown";
      statement =
        "the trace records no observation record, so no completeness " +
        "declaration exists to compare against";
    } else if (observation.record.completeness === null) {
      state = "unverifiable";
      completeness = "unknown";
      statement =
        "the observation record records no completeness token; the " +
        "export's completeness cannot be cross-checked";
    } else if (
      observation.record.completeness ===
      observation.exportDocument.completeness
    ) {
      state = "verified";
      completeness = "complete";
      statement = `the observation record's completeness '${observation.record.completeness}' equals the export's`;
    } else {
      state = "inconsistent";
      completeness = "complete";
      statement =
        `the observation record's completeness '${observation.record.completeness}' ` +
        `does not equal the export's '${observation.exportDocument.completeness}'`;
    }
    const evidence: CellEvidenceReference[] = [];
    if (observation.record !== undefined)
      evidence.push(cellEv(ctx, "trace", "/observation/completeness"));
    else
      evidence.push(cellEv(ctx, "trace", "", { note: "no observation field" }));
    if (record !== null)
      evidence.push(exportRefEv(ctx, record, "/completeness"));
    else
      evidence.push(
        cellEv(ctx, "manifest", "", { note: "no export manifest entry" }),
      );
    entries.push(
      cellEntry(
        ctx,
        "association",
        "association.export-completeness",
        state,
        completeness,
        statement,
        evidence,
      ),
    );
  }

  // association.export-source-project — the declared source-project
  // identity: the trace's `seed.source_project` versus the identity the
  // retained export carries (yuurei #214, pfl #217). Both records are
  // caller-declared provenance; their agreement binds one declared source
  // identity to this cell's own records. `remote`/`head` are never
  // compared — pfl redacts them at persistence, so the identity comparison
  // keys on `id` and `kind` only.
  {
    const declared = trace.seed?.sourceProject;
    const carried =
      observation.exportDocument === null
        ? undefined
        : observation.exportDocument.data.snapshot.sourceProject;
    let state: CellEntryState;
    let completeness: CellCompleteness;
    let statement: string;
    if (!exportDeclared) {
      state = "not-recorded";
      completeness = "unknown";
      statement = undeclaredStatement();
    } else if (observation.exportDocument === null) {
      state = noExportState(observation);
      completeness = "unknown";
      statement = `no interpretable export exists to compare: ${noExportReason(observation)}`;
    } else if (
      declared === undefined &&
      carried !== undefined &&
      carried !== null
    ) {
      state = "unverifiable";
      completeness = "unknown";
      statement =
        `the export declares source-project identity '${carried.id}' ` +
        `(issuer '${carried.issuer}') but the trace's seed record declares ` +
        `none — the declaration cannot be cross-checked against this run's ` +
        `seed record`;
    } else if (declared === undefined) {
      state = "not-recorded";
      completeness = "unknown";
      statement =
        carried === null
          ? "the export records no source-project declaration " +
            "(sourceProject: null) and the trace's seed record declares " +
            "none either — the observed cell's source identity is unknown, " +
            "not absent"
          : "neither the trace's seed record nor the export records a " +
            "source-project identity — the observed cell's source identity " +
            "is unknown";
    } else if (carried === undefined) {
      state = "unverifiable";
      completeness = "unknown";
      statement =
        `the trace's seed record declares source-project identity ` +
        `'${declared.id}' but the export does not carry ` +
        `data.snapshot.sourceProject (a pfl from before the field existed, ` +
        `or a pre-schema-3 artifact) — the declaration cannot be ` +
        `cross-checked against the observation`;
    } else if (carried === null) {
      state = "unverifiable";
      completeness = "unknown";
      statement =
        `the trace's seed record declares source-project identity ` +
        `'${declared.id}' but the export records sourceProject: null — ` +
        `no valid declaration reached the observation`;
    } else if (declared.id === carried.id && declared.kind === carried.kind) {
      state = "verified";
      completeness = "complete";
      statement =
        `the trace's seed record and the retained export declare the same ` +
        `source-project identity '${declared.id}' (kind '${declared.kind}') ` +
        `— a recorded agreement between the run's seed record and the ` +
        `caller-asserted provenance the observation carried, not proof the ` +
        `source itself was observed`;
    } else {
      state = "inconsistent";
      completeness = "complete";
      statement =
        declared.id !== carried.id
          ? `the trace's seed record declares source-project identity ` +
            `'${declared.id}' but the retained export carries ` +
            `'${carried.id}'`
          : `the records declare the same source-project id ` +
            `'${declared.id}' under different kinds ('${declared.kind}' vs ` +
            `'${carried.kind}')`;
    }
    const evidence: CellEvidenceReference[] = [
      trace.seed === undefined
        ? cellEv(ctx, "trace", "", { note: "no seed field" })
        : traceNestedEv(ctx, "seed", "source_project"),
    ];
    if (record !== null)
      evidence.push(
        exportNestedEv(ctx, record, "/data/snapshot", "sourceProject"),
      );
    else
      evidence.push(
        cellEv(ctx, "manifest", "", { note: "no export manifest entry" }),
      );
    entries.push(
      cellEntry(
        ctx,
        "association",
        "association.export-source-project",
        state,
        completeness,
        statement,
        evidence,
      ),
    );
  }

  // association.record-consistency — the record's own coherence.
  {
    const problems: string[] = [];
    const obsRecord = observation.record;
    if (obsRecord === undefined) {
      // A manifest-listed export with no observation record is a
      // contradiction: a run that was not observed must not retain an
      // observation artifact, and the artifact is never read either way.
      const listed = ctx.cell.run.entries.some(
        (entry) => entry.path === OBSERVATION_EXPORT_PATH,
      );
      entries.push(
        listed
          ? cellEntry(
              ctx,
              "association",
              "association.record-consistency",
              "inconsistent",
              "complete",
              `the manifest retains '${OBSERVATION_EXPORT_PATH}' but the trace records no observation at all`,
              [
                cellEv(ctx, "trace", "", { note: "no observation field" }),
                cellEv(ctx, "manifest", "/artifacts"),
              ],
            )
          : cellEntry(
              ctx,
              "association",
              "association.record-consistency",
              "not-recorded",
              "unknown",
              "the trace records no observation record to check",
              [cellEv(ctx, "trace", "", { note: "no observation field" })],
            ),
      );
    } else {
      if (observation.unsafeDeclaredPaths.length > 0)
        problems.push(
          `declares artifact paths outside the run directory: ${observation.unsafeDeclaredPaths.join(", ")}`,
        );
      if (obsRecord.status === "unavailable" && obsRecord.artifacts.length > 0)
        problems.push(
          "records status 'unavailable' yet declares retained artifacts",
        );
      if (
        (obsRecord.status === "recorded" || obsRecord.status === "partial") &&
        !observation.exportDeclared
      )
        problems.push(
          `records status '${obsRecord.status}' but declares no export artifact at '${OBSERVATION_EXPORT_PATH}'`,
        );
      if (!observation.exportDeclared && record !== null)
        problems.push(
          `the manifest retains '${OBSERVATION_EXPORT_PATH}' but the observation record does not declare it`,
        );
      if (
        observation.exportDeclared &&
        record === null &&
        (obsRecord.status === "recorded" || obsRecord.status === "partial")
      )
        problems.push(
          `records status '${obsRecord.status}' but the manifest does not retain '${OBSERVATION_EXPORT_PATH}': a declared-and-retained export is what the status asserts`,
        );
      const extras =
        observation.otherDeclaredPaths.length === 0
          ? ""
          : `; it also declares ${observation.otherDeclaredPaths.length} non-export artifact(s) that are not interpreted`;
      entries.push(
        problems.length === 0
          ? cellEntry(
              ctx,
              "association",
              "association.record-consistency",
              "verified",
              "complete",
              `the observation record is internally coherent (status '${obsRecord.status}')${extras}`,
              [cellEv(ctx, "trace", "/observation")],
            )
          : cellEntry(
              ctx,
              "association",
              "association.record-consistency",
              "inconsistent",
              "complete",
              `the observation record contradicts itself: ${problems.join("; ")}${extras}`,
              [cellEv(ctx, "trace", "/observation")],
            ),
      );
    }
  }

  const bindingEntry = entries.find(
    (entry) => entry.id === "association.export-binding",
  )!;
  const sourceProjectEntry = entries.find(
    (entry) => entry.id === "association.export-source-project",
  )!;
  return {
    entries,
    binding: bindingEntry.state,
    sourceProject: sourceProjectEntry.state,
  };
}

// -- configuration lane -----------------------------------------------------

/**
 * What the bound export declares. Emitted only when the cell_id binding
 * is verified; any other outcome produces one availability marker so the
 * lane's absence of content is itself explained — never mistaken for "no
 * configuration".
 */
export function configurationEntries(
  ctx: CellCtx,
  binding: CellEntryState,
): CellEntry[] {
  const observation = ctx.cell.observation;
  const document = observation.exportDocument;
  const record = observation.exportRecord;
  if (document === null || record === null || binding !== "verified") {
    // The availability marker mirrors the binding outcome: an undeclared or
    // unrecorded association is absence (not-recorded), a contradiction is
    // inconsistent, and a declared-but-unusable export is unverifiable.
    const state: CellEntryState =
      binding === "not-recorded"
        ? "not-recorded"
        : binding === "inconsistent"
          ? "inconsistent"
          : "unverifiable";
    return [
      cellEntry(
        ctx,
        "configuration",
        "configuration.availability",
        state,
        "unknown",
        "no bound export is available: " +
          `${availabilityReason(observation, binding)}; the pre-run ` +
          `configuration is unknown, not absent or unchanged`,
        exportDocEvidence(ctx),
      ),
    ];
  }

  const completeness: CellCompleteness = document.completeness;
  const entries: CellEntry[] = [];
  const snapshot = document.data.snapshot;

  entries.push(
    cellEntry(
      ctx,
      "configuration",
      "configuration.snapshot",
      "recorded",
      completeness,
      `the bound export identifies observed snapshot ` +
        `'${snapshot.observedSnapshotId}', resolved snapshot ` +
        `'${snapshot.resolvedSnapshotId}', schema '${snapshot.schemaVersion}', ` +
        `captured '${snapshot.capturedAt}'`,
      [
        exportDocEv(ctx, record, "/data/snapshot/observedSnapshotId"),
        exportDocEv(ctx, record, "/data/snapshot/resolvedSnapshotId"),
        exportDocEv(ctx, record, "/data/snapshot/capturedAt"),
      ],
    ),
    cellEntry(
      ctx,
      "configuration",
      "configuration.subject",
      "recorded",
      completeness,
      `the export describes project '${document.data.project.id}' ` +
        `('${document.data.project.displayName}') under runtime ` +
        `'${document.data.runtime.id}'`,
      [
        exportDocEv(ctx, record, "/data/project/id"),
        exportDocEv(ctx, record, "/data/runtime/id"),
      ],
    ),
    cellEntry(
      ctx,
      "configuration",
      "configuration.completeness",
      "recorded",
      completeness,
      `the export declares completeness '${document.completeness}' with ` +
        `${document.diagnostics.length} diagnostic(s)`,
      [
        exportDocEv(ctx, record, "/completeness"),
        exportDocEv(ctx, record, "/diagnostics"),
      ],
    ),
  );

  const elements = [...document.data.elements].sort((a, b) =>
    compareBytes(a.id, b.id),
  );
  for (const element of elements) {
    const index = document.data.elements.indexOf(element);
    const observed = element.observed;
    const scope =
      observed.native.scope === null
        ? "no scope"
        : `scope '${observed.native.scope}'`;
    const reason =
      observed.reason === undefined ? "" : `, reason '${observed.reason}'`;
    const resolved =
      element.resolved === null
        ? "; no resolved layer recorded"
        : `; resolved as '${element.resolved.status}' (activation '${element.resolved.activation}', strategy '${element.resolved.resolution.strategy}')`;
    const interpretation =
      element.interpretation === null
        ? "; no interpretation recorded"
        : `; interpretation facets [${element.interpretation.facets.join(", ")}] (confidence '${element.interpretation.confidence}')`;
    entries.push(
      cellEntry(
        ctx,
        "configuration",
        `configuration.element.${element.id}`,
        "recorded",
        completeness,
        `element '${element.id}' (kind '${observed.native.kind}', origin ` +
          `'${observed.native.origin}', ${scope}) is observed as ` +
          `'${observed.status}'${reason}${resolved}${interpretation}`,
        [exportDocEv(ctx, record, `/data/elements/${index}`, element.id)],
      ),
    );
  }

  for (const [position, [index, relation]] of [
    ...document.data.relations.entries(),
  ]
    .sort((a, b) => byRelation(a[1], b[1]) || a[0] - b[0])
    .entries()) {
    entries.push(
      cellEntry(
        ctx,
        "configuration",
        `configuration.relation.${position}`,
        "recorded",
        completeness,
        `the export records relation '${relation.type}' from ` +
          `'${relation.from}' to '${relation.to}'`,
        [exportDocEv(ctx, record, `/data/relations/${index}`)],
      ),
    );
  }

  for (const [position, [index, finding]] of [
    ...document.data.findings.entries(),
  ]
    .sort((a, b) => byFinding(a[1], b[1]) || a[0] - b[0])
    .entries()) {
    entries.push(
      cellEntry(
        ctx,
        "configuration",
        `configuration.finding.${position}`,
        "recorded",
        completeness,
        `the export records a '${finding.rule}' finding on ` +
          `[${finding.elementIds.join(", ")}]: ${finding.message}`,
        [exportDocEv(ctx, record, `/data/findings/${index}`)],
      ),
    );
  }

  return entries;
}

/**
 * A stored-byte citation for one artifact: the artifact's own pointer with
 * the manifest-recorded digest when the stored bytes were verified, and
 * the manifest entry itself (with a note) when they were not — a missing
 * or digest-mismatched artifact is evidence about the manifest's record,
 * not about bytes that were read.
 */
function storedByteEv(
  ctx: CellCtx,
  base: "patch" | "result",
  run: CellRun["run"],
  index: number | null,
  absentNote: string,
): CellEvidenceReference {
  if (index === null) return cellEv(ctx, "manifest", "", { note: absentNote });
  const entry = run.entries[index];
  const verified =
    entry.state === "verified" || entry.state === "verified-truncated";
  if (verified)
    return cellEv(
      ctx,
      base,
      `/artifacts/${index}`,
      entry.digest === null ? {} : { digest: entry.digest },
    );
  return cellEv(ctx, "manifest", `/artifacts/${index}`, {
    note: `the stored bytes are '${entry.state}'`,
  });
}

// -- execution lane ---------------------------------------------------------

/**
 * What the run's own records say about the run — the yuurei lane. `null`
 * fields are stated as unrecorded values of a record that exists;
 * optional fields absent from the trace emit `not-recorded`.
 */
export function executionEntries(ctx: CellCtx): CellEntry[] {
  const run = ctx.cell.run;
  const trace = run.trace;
  const entries: CellEntry[] = [];

  entries.push(
    cellEntry(
      ctx,
      "execution",
      "execution.run-id",
      "recorded",
      "complete",
      `the trace records run_id '${trace.runId}' (started ${trace.startedAt}, finished ${trace.finishedAt})`,
      [
        cellEv(ctx, "trace", "/run_id"),
        cellEv(ctx, "trace", "/started_at"),
        cellEv(ctx, "trace", "/finished_at"),
      ],
    ),
    cellEntry(
      ctx,
      "execution",
      "execution.task",
      "recorded",
      "complete",
      `the run's task is '${trace.task.source}' (digest ${trace.task.digest})`,
      [
        cellEv(ctx, "trace", "/task/source"),
        cellEv(ctx, "trace", "/task/digest"),
      ],
    ),
    cellEntry(
      ctx,
      "execution",
      "execution.profile",
      "recorded",
      "complete",
      `the run used profile '${trace.profile.name}' (digest ${trace.profile.digest})`,
      [
        cellEv(ctx, "trace", "/profile/name"),
        cellEv(ctx, "trace", "/profile/digest"),
      ],
    ),
    cellEntry(
      ctx,
      "execution",
      "execution.runtime",
      "recorded",
      "complete",
      trace.runtime.version === null
        ? `the run's runtime is '${trace.runtime.id}' (version not recorded)`
        : `the run's runtime is '${trace.runtime.id}' version '${trace.runtime.version}'`,
      [
        cellEv(ctx, "trace", "/runtime/id"),
        traceNestedEv(ctx, "runtime", "version"),
      ],
    ),
    cellEntry(
      ctx,
      "execution",
      "execution.model",
      "recorded",
      "complete",
      `${
        trace.model.requested === ""
          ? "the run requested no model (model.requested is an empty string)"
          : `the run requested model '${trace.model.requested}'`
      }` +
        (trace.model.resolved === null
          ? "; no resolved model is recorded"
          : ` and resolved '${trace.model.resolved}'` +
            (trace.model.resolvedReason === undefined
              ? ""
              : ` (reason '${trace.model.resolvedReason}')`)),
      [
        cellEv(ctx, "trace", "/model/requested"),
        traceNestedEv(ctx, "model", "resolved"),
      ],
    ),
    trace.requestedCell === undefined
      ? cellEntry(
          ctx,
          "execution",
          "execution.requested-cell",
          "not-recorded",
          "unknown",
          "the trace records no requested_cell record",
          [cellEv(ctx, "trace", "", { note: "no requested_cell field" })],
        )
      : cellEntry(
          ctx,
          "execution",
          "execution.requested-cell",
          "recorded",
          "complete",
          `the trace records requested_cell digest '${trace.requestedCell.digest}' (inputs_version ${trace.requestedCell.inputsVersion})`,
          [
            cellEv(ctx, "trace", "/requested_cell/digest"),
            cellEv(ctx, "trace", "/requested_cell/inputs_version"),
          ],
        ),
    cellEntry(
      ctx,
      "execution",
      "execution.isolation",
      "recorded",
      "complete",
      `the run records isolation strategy '${trace.isolation.strategy}' (verified: ${trace.isolation.verified})`,
      [
        cellEv(ctx, "trace", "/isolation/strategy"),
        cellEv(ctx, "trace", "/isolation/verified"),
      ],
    ),
    cellEntry(
      ctx,
      "execution",
      "execution.outcome",
      "recorded",
      "complete",
      `the run's execution records exit_code ` +
        `${trace.execution.exitCode === null ? "not recorded" : `'${trace.execution.exitCode}'`}, ` +
        `signal ${trace.execution.signal === null ? "not recorded" : `'${trace.execution.signal}'`}, ` +
        `duration_ms ${trace.execution.durationMs === null ? "not recorded" : trace.execution.durationMs}, ` +
        `timed_out ${trace.execution.timedOut}`,
      [cellEv(ctx, "trace", "/execution")],
    ),
  );

  const usageKeys = Object.keys(trace.usage).sort(compareBytes);
  entries.push(
    cellEntry(
      ctx,
      "execution",
      "execution.usage",
      "recorded",
      "complete",
      usageKeys.length === 0
        ? "the run's usage record is empty"
        : `the run records usage ${usageKeys
            .map(
              (key) =>
                `${key}=${trace.usage[key] === null ? "not recorded" : trace.usage[key]}`,
            )
            .join(", ")}`,
      [traceFieldEv(ctx, "usage")],
    ),
    trace.cost === null
      ? cellEntry(
          ctx,
          "execution",
          "execution.cost",
          "recorded",
          "complete",
          "the trace records no cost",
          [cellEv(ctx, "trace", "/cost")],
        )
      : cellEntry(
          ctx,
          "execution",
          "execution.cost",
          "recorded",
          "complete",
          `the trace records cost ${trace.cost.amount} ${trace.cost.currency}`,
          [
            traceNestedEv(ctx, "cost", "amount"),
            traceNestedEv(ctx, "cost", "currency"),
          ],
        ),
  );

  const stateCounts = new Map<string, number>();
  for (const entry of run.entries)
    stateCounts.set(entry.state, (stateCounts.get(entry.state) ?? 0) + 1);
  const stateSummary = [...stateCounts.keys()]
    .sort(compareBytes)
    .map((state) => `${state}×${stateCounts.get(state)}`)
    .join(", ");
  entries.push(
    cellEntry(
      ctx,
      "execution",
      "execution.artifacts",
      "recorded",
      "complete",
      `the manifest lists ${run.entries.length} artifact(s): ${stateSummary}`,
      [cellEv(ctx, "manifest", "/artifacts")],
    ),
    cellEntry(
      ctx,
      "execution",
      "execution.result",
      "recorded",
      "complete",
      `the final-result record is in state '${run.resultState}'`,
      [
        storedByteEv(
          ctx,
          "result",
          run,
          run.resultEntryIndex,
          "no result.txt entry",
        ),
        traceFieldEv(ctx, "diagnostics"),
      ],
    ),
    cellEntry(
      ctx,
      "execution",
      "execution.patch",
      "recorded",
      "complete",
      `the patch record is in state '${run.patchState}'` +
        (run.patch === null
          ? ""
          : ` covering ${run.patch.files.length} file(s)`),
      [
        ...(trace.patch === undefined
          ? []
          : [cellEv(ctx, "trace", "/patch/state")]),
        storedByteEv(
          ctx,
          "patch",
          run,
          run.patchEntryIndex,
          "no patch.diff entry",
        ),
      ],
    ),
    cellEntry(
      ctx,
      "execution",
      "execution.diagnostics",
      "recorded",
      "complete",
      `the trace records ${trace.diagnostics.length} diagnostic(s)`,
      [traceFieldEv(ctx, "diagnostics")],
    ),
  );

  return entries;
}

// -- audit lane -------------------------------------------------------------

const AUDIT_SOURCE_MAP: Record<AuditEvidenceSource, BaseSource> = {
  trace: "trace",
  manifest: "manifest",
  patch: "patch",
  result: "result",
  baselineManifest: "baselineManifest",
  changes: "changes",
  // The cell report supplies no check reports, so this mapping never
  // fires; it exists to keep the lookup total.
  checkReport: "evaluation",
};

/** The v0.8 audit facts for the same loaded run, re-sourced per side. */
export function auditEntries(ctx: CellCtx): CellEntry[] {
  const audit = auditRun({ run: ctx.cell.run });
  return audit.facts.map((fact: AuditFact) => ({
    lane: "audit",
    ...(ctx.subject === undefined ? {} : { subject: ctx.subject }),
    id: `audit.${fact.id}`,
    state: fact.state,
    completeness: fact.completeness,
    statement: fact.reason,
    evidence: sortCellEvidence(
      fact.evidence.map((evidence) => ({
        ...evidence,
        source: cellSource(ctx, AUDIT_SOURCE_MAP[evidence.source]),
      })),
    ),
    provenance: {
      transform: [ctx.command, "audit-run", `fact:${fact.id}`],
    },
  }));
}

// -- evaluation lane --------------------------------------------------------

/**
 * The supplied evaluation document as labelled context: a binding check
 * and, only when bound, its verdicts restated verbatim. A document that
 * does not describe this run is reported as inconsistent and its
 * verdicts withheld — they are another run's, not this cell's.
 */
export function evaluationEntries(
  ctx: CellCtx,
  evaluation: SuppliedEvaluation | undefined,
): CellEntry[] {
  if (evaluation === undefined) return [];
  const entries: CellEntry[] = [
    cellEntry(
      ctx,
      "evaluation",
      "evaluation.supplied",
      evaluation.state === "parsed" ? "recorded" : "unverifiable",
      evaluation.state === "parsed" ? "complete" : "unknown",
      evaluation.state === "parsed"
        ? `the supplied document '${evaluation.label}' is a gatefold ` +
            `v${evaluation.schemaVersion} result`
        : `the supplied document '${evaluation.label}' is not a usable ` +
            `gatefold evaluation result: ${evaluation.error}`,
      [cellEv(ctx, "evaluation", "")],
    ),
  ];

  // A single-cell report presents only a v6 `evaluate-run` result. A v7
  // `compare-evaluations` document describes two runs and has no
  // per-run verdict field, so it is reported as a wrong-kind document
  // rather than bound through its `beforeRun` and rendered from a field
  // it does not carry.
  const wrongKind =
    evaluation.state === "parsed" && evaluation.schemaVersion !== 6;
  const runBinding = wrongKind ? null : evaluation.run;
  const bound =
    evaluation.state === "parsed" &&
    runBinding !== null &&
    runBinding.runId === ctx.cell.run.trace.runId &&
    runBinding.taskDigest === ctx.cell.run.trace.task.digest;
  entries.push(
    cellEntry(
      ctx,
      "evaluation",
      "evaluation.binding",
      evaluation.state !== "parsed" || runBinding === null
        ? "unverifiable"
        : bound
          ? "verified"
          : "inconsistent",
      evaluation.state !== "parsed" || runBinding === null
        ? "unknown"
        : "complete",
      wrongKind
        ? `the supplied document is a gatefold v${evaluation.schemaVersion} ` +
            `comparison of two runs; a single-cell report presents only a v6 ` +
            `evaluate-run result, so its transitions are not this run's verdicts`
        : evaluation.state !== "parsed" || runBinding === null
          ? "the supplied document records no run identity to bind against"
          : bound
            ? `the supplied evaluation's recorded run ('${runBinding.runId}', ` +
              `task ${runBinding.taskDigest}) matches this run's trace`
            : `the supplied evaluation's recorded run ` +
              `('${runBinding.runId}', task ${runBinding.taskDigest}) does ` +
              `not match this run ('${ctx.cell.run.trace.runId}', task ` +
              `${ctx.cell.run.trace.task.digest}); its verdicts are withheld`,
      [
        typeof evaluation.document === "object" &&
        evaluation.document !== null &&
        "inputs" in evaluation.document
          ? cellEv(ctx, "evaluation", "/inputs")
          : cellEv(ctx, "evaluation", "", { note: "no inputs field" }),
        cellEv(ctx, "trace", "/run_id"),
        cellEv(ctx, "trace", "/task/digest"),
      ],
    ),
  );
  if (bound) {
    for (const verdict of evaluation.verdicts) {
      entries.push(
        cellEntry(
          ctx,
          "evaluation",
          `evaluation.eval-${verdict.index}`,
          "recorded",
          "complete",
          `the supplied evaluation records criterion ` +
            `'${verdict.criterionId}' (${verdict.kind}) as ` +
            `'${verdict.verdict}': ${verdict.reason}`,
          [cellEv(ctx, "evaluation", `/evaluations/${verdict.index}/verdict`)],
        ),
      );
    }
  }
  return entries;
}

/** All per-cell lanes in contract order. */
export function cellEntries(
  ctx: CellCtx,
  evaluation?: SuppliedEvaluation,
): CellEntry[] {
  const association = associationEntries(ctx);
  return [
    ...association.entries,
    ...configurationEntries(ctx, association.binding),
    ...executionEntries(ctx),
    ...auditEntries(ctx),
    ...evaluationEntries(ctx, evaluation),
  ];
}

/** Documents the validator needs for one cell side. */
export function cellDocs(cell: CellRun): CellSideDocs {
  return {
    traceDocument: cell.run.trace.document,
    manifestDocument: cell.run.manifestDocument,
    patchEntryIndex: cell.run.patchEntryIndex,
    patchEntryDigest:
      cell.run.patchEntryIndex === null
        ? undefined
        : cell.run.entries[cell.run.patchEntryIndex].digest,
    patchBytes: cell.run.patchBytes,
    patchPaths: cell.run.patch?.files.map((file) => file.path) ?? null,
    resultEntryIndex: cell.run.resultEntryIndex,
    resultEntryDigest:
      cell.run.resultEntryIndex === null
        ? undefined
        : cell.run.entries[cell.run.resultEntryIndex].digest,
    resultBytes: cell.run.resultBytes,
    baselineManifest: cell.run.baselineManifest,
    changes: cell.run.changes,
    exportRecord: cell.observation.exportRecord,
    exportDocument: cell.observation.exportRecord?.document ?? null,
  };
}

export function checkCellLimits(result: {
  readonly entries: readonly CellEntry[];
}): void {
  if (result.entries.length > MAX_EMITTED_CLAIMS)
    throw new PflExportError(
      "invalid-shape",
      `the report would emit ${result.entries.length} entries, exceeding the ${MAX_EMITTED_CLAIMS} entry ceiling`,
    );
  const evidenceCount = result.entries.reduce(
    (total, entry) => total + entry.evidence.length,
    0,
  );
  if (evidenceCount > MAX_EVIDENCE_REFERENCES)
    throw new PflExportError(
      "invalid-shape",
      `the report would cite ${evidenceCount} evidence references, exceeding the ${MAX_EVIDENCE_REFERENCES} reference ceiling`,
    );
}

/**
 * Builds the v9 single-cell report (docs/v0.9-scope.md). Pure over the
 * loaded inputs; the reader performed all I/O.
 */
export function reportCell(input: {
  cell: CellRun;
  label?: string;
  evaluation?: SuppliedEvaluation;
}): CellReportResult {
  const ctx: CellCtx = { cell: input.cell, command: "report-cell" };
  const entries = sortCellEntries(cellEntries(ctx, input.evaluation));
  const result: CellReportResult = {
    schemaVersion: CELL_SCHEMA_VERSION,
    source: { command: "report-cell" },
    inputs: {
      run: cellRunInput(input.cell, input.label),
      ...(input.evaluation === undefined
        ? {}
        : {
            evaluation: {
              label: input.evaluation.label,
              schemaVersion: input.evaluation.schemaVersion ?? 0,
              command:
                input.evaluation.schemaVersion === 7
                  ? ("compare-evaluations" as const)
                  : ("evaluate-run" as const),
            },
          }),
    },
    entries,
  };
  checkCellLimits(result);
  assertValidCellResult(result);
  assertCellEvidenceResolves(result, {
    cells: [cellDocs(input.cell)],
    evaluation: input.evaluation?.document ?? null,
  });
  return result;
}
