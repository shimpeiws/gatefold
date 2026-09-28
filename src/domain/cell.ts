/**
 * The v0.9 cell-report result model (docs/v0.9-scope.md): one
 * evidence-backed account of a yuurei cell — the run's trace and manifest
 * records, the verified pre-run pfl export the observation record
 * declares, the v0.8 audit facts, and an optional supplied evaluation —
 * or a directional A → B account of two compatible cells. Entries are
 * statements about records: each carries the lane it belongs to, a check
 * or record state, and a completeness dimension, never a verdict.
 */
export const CELL_SCHEMA_VERSION = 9;

/** The CLI commands that emit this result shape. */
export type CellCommand = "report-cell" | "compare-cells";

/**
 * The named record family an entry reports. Fixed set; extended only
 * additively.
 */
export type CellLane =
  | "association"
  | "configuration"
  | "execution"
  | "audit"
  | "evaluation"
  | "comparison";

/**
 * The entry's outcome. `verified`, `inconsistent`, `unverifiable`, and
 * `not-recorded` are the v0.8 cross-check states; `recorded` marks an
 * entry that restates what a document declares (configuration content,
 * run records, supplied evaluations, computed A → B differences) without
 * an independent check.
 */
export type CellEntryState =
  | "recorded"
  | "verified"
  | "inconsistent"
  | "unverifiable"
  | "not-recorded";

/** How complete the underlying evidence is — separate from `state`. */
export type CellCompleteness = "complete" | "partial" | "unknown";

/** The named input an evidence reference resolves against. */
export type CellEvidenceSource =
  | "trace"
  | "manifest"
  | "export"
  | "patch"
  | "result"
  | "baselineManifest"
  | "changes"
  | "evaluation"
  | "beforeTrace"
  | "beforeManifest"
  | "beforeExport"
  | "beforePatch"
  | "beforeResult"
  | "beforeBaselineManifest"
  | "beforeChanges"
  | "beforeEvaluation"
  | "afterTrace"
  | "afterManifest"
  | "afterExport"
  | "afterPatch"
  | "afterResult"
  | "afterBaselineManifest"
  | "afterChanges"
  | "afterEvaluation";

/**
 * One resolvable pointer into a named input. `pointer` is a JSON Pointer
 * inside the source's document — for `patch`/`result` it names the
 * artifact's manifest entry (`/artifacts/<i>`) with `path`, `lines`, and
 * `bytes` locating content inside the verified bytes. `digest` repeats
 * the verified stored digest; `elementId` names the export element cited.
 */
export interface CellEvidenceReference {
  readonly source: CellEvidenceSource;
  readonly pointer: string;
  readonly digest?: string;
  readonly path?: string;
  readonly lines?: { readonly start: number; readonly end: number };
  readonly bytes?: { readonly start: number; readonly end: number };
  readonly elementId?: string;
  readonly note?: string;
}

/** The code path that produced an entry. */
export interface CellProvenance {
  readonly transform: readonly string[];
}

/** One statement in a cell report. */
export interface CellEntry {
  readonly lane: CellLane;
  /**
   * `compare-cells` only: the cell side the entry describes. Absent on
   * `comparison` entries and in single-cell results.
   */
  readonly subject?: "before" | "after";
  readonly id: string;
  readonly state: CellEntryState;
  readonly completeness: CellCompleteness;
  readonly statement: string;
  readonly evidence: readonly CellEvidenceReference[];
  readonly provenance: CellProvenance;
}

/**
 * The input descriptor recorded for one run directory: the identities a
 * reader needs to reconcile the report without reloading the input.
 */
export interface CellRunInputDescriptor {
  readonly label: string;
  readonly runId: string;
  /** The trace's `cell_id`, or null when the run does not record one. */
  readonly cellId: string | null;
  readonly taskDigest: string;
  readonly profileName: string;
  readonly profileDigest: string;
  readonly runtimeId: string;
  /** `requested_cell.digest`, or null when the trace predates it. */
  readonly requestedCellDigest: string | null;
  /** The recorded observation status, or null when observation is absent. */
  readonly observationStatus: "recorded" | "partial" | "unavailable" | null;
  /** The bound export's snapshot ids, or null when none was bound. */
  readonly exportObservedSnapshotId: string | null;
  readonly exportResolvedSnapshotId: string | null;
}

/** The descriptor recorded for a supplied evaluation document. */
export interface CellEvaluationInput {
  readonly label: string;
  /** The supplied document's schema version (6 or 7). */
  readonly schemaVersion: number;
  readonly command: "evaluate-run" | "compare-evaluations";
}

/** `report-cell` records `run`; `compare-cells` records `before`/`after`. */
export interface CellInputs {
  readonly run?: CellRunInputDescriptor;
  readonly before?: CellRunInputDescriptor;
  readonly after?: CellRunInputDescriptor;
  readonly evaluation?: CellEvaluationInput;
}

export interface CellReportResult {
  readonly schemaVersion: typeof CELL_SCHEMA_VERSION;
  readonly source: { readonly command: CellCommand };
  readonly inputs: CellInputs;
  readonly entries: readonly CellEntry[];
}
