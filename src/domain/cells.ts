import type {
  CellEntry,
  CellRunInputDescriptor,
  CellsRunName,
} from "./cell.js";

/**
 * The v0.10 repeated-cell report result model (docs/v0.10-scope.md): one
 * evidence-backed account of a bounded set of comparable yuurei cells —
 * every supplied run's v0.9 lanes plus a `set` lane stating which
 * configuration facts were observed in each run, which differed, and
 * which could not be checked. Entries reuse the v9 `CellEntry` shape
 * with `run1`…`runN` subjects and run-indexed evidence sources; there is
 * no `evaluation` lane and no `comparison` lane — the set is reported
 * side by side, never directionally.
 */
export const CELLS_SCHEMA_VERSION = 10;

/** The CLI command that emits this result shape. */
export type CellsCommand = "report-cells";

/**
 * The bounded-set ceiling: more than this many `--run` arguments is an
 * input error. The bound keeps the emitted report, the per-run lanes,
 * and the O(N²) record grouping inside the shared claim/evidence limits.
 */
export const CELLS_MAX_RUNS = 32;

/**
 * `report-cells` records one descriptor per supplied run, labelled
 * `run1`…`runN` in argument order.
 */
export interface CellsRunInputDescriptor extends CellRunInputDescriptor {
  /** The run's label in this report — `run1`…`runN`. */
  readonly name: CellsRunName;
}

export interface CellsInputs {
  readonly runs: readonly CellsRunInputDescriptor[];
}

export interface CellsReportResult {
  readonly schemaVersion: typeof CELLS_SCHEMA_VERSION;
  readonly source: { readonly command: CellsCommand };
  readonly inputs: CellsInputs;
  readonly entries: readonly CellEntry[];
}
