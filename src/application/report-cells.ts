import { compareBytes } from "../domain/byte-order.js";
import type {
  CellEntry,
  CellEvidenceReference,
  CellsRunName,
} from "../domain/cell.js";
import {
  CELLS_MAX_RUNS,
  CELLS_SCHEMA_VERSION,
  type CellsReportResult,
} from "../domain/cells.js";
import {
  assertCellsEvidenceResolves,
  assertValidCellsResult,
} from "../domain/validate-cells.js";
import {
  PflExportError,
  type PflExportDocument,
  type PflSnapshotElement,
} from "../input/pfl-export.js";
import type { CellRun } from "../input/yuurei-cell.js";
import type { YuureiTrace } from "../input/yuurei-trace.js";
import {
  associationEntries,
  auditEntries,
  cellDocs,
  cellEntry,
  cellEv,
  cellRunInput,
  checkCellLimits,
  configurationEntries,
  executionEntries,
  traceFieldEv,
  traceNestedEv,
  type CellCtx,
  type CellEmitCtx,
} from "./cell-report.js";
import { canonicalJson, relationKey } from "./cell-diff.js";
import {
  exportSourceEv,
  exportSideEv,
  traceSeedSourceEv,
} from "./compare-cells.js";
import { describeRequestedModel, jsonEquals } from "./trace-comparability.js";

/**
 * The v0.10 `report-cells` orchestrator (docs/v0.10-scope.md): one
 * bounded, explicitly supplied set of yuurei run directories. Every run
 * keeps its v0.9 per-cell lanes under a `run<N>` subject; a `set` lane
 * states which configuration records each run observed, which differ,
 * and which could not be checked — counts over eligible (bound-export)
 * observations only. No stability verdict, no direction, no causal
 * reading.
 */

interface SetCaveat {
  readonly field: string;
  readonly text: string;
  readonly evidence: readonly CellEvidenceReference[];
}

/** One supplied run whose bound export counts toward denominators. */
interface EligibleRun {
  readonly index: number;
  readonly ctx: CellCtx;
  readonly doc: PflExportDocument;
}

const SET_CTX: CellEmitCtx = { command: "report-cells" };

function setEntry(
  id: string,
  state: CellEntry["state"],
  completeness: CellEntry["completeness"],
  statement: string,
  evidence: readonly CellEvidenceReference[],
): CellEntry {
  return cellEntry(
    SET_CTX,
    "set",
    id,
    state,
    completeness,
    statement,
    evidence,
  );
}

function runName(index: number): CellsRunName {
  return `run${index + 1}` as CellsRunName;
}

/** `run1, run2, and run4` — or the bare name when one run is listed. */
function nameList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Orders entries: run subject in order, then lane, then builder order. */
function sortCellsEntries(
  entries: readonly CellEntry[],
  runCount: number,
): CellEntry[] {
  const LANE_RANK: Record<CellEntry["lane"], number> = {
    association: 0,
    configuration: 1,
    execution: 2,
    audit: 3,
    evaluation: 4,
    comparison: 5,
    set: 6,
  };
  const subjectRank = (entry: CellEntry): number => {
    const subject = entry.subject;
    if (subject === undefined) return runCount;
    const match = /^run([1-9][0-9]*)$/.exec(subject);
    return match === null ? runCount : Number(match[1]) - 1;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        subjectRank(a.entry) - subjectRank(b.entry) ||
        LANE_RANK[a.entry.lane] - LANE_RANK[b.entry.lane] ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

// -- comparability gate ------------------------------------------------------

function mismatched(message: string): PflExportError {
  return new PflExportError("mismatched-inputs", message);
}

/**
 * The v0.10 set comparability gate: the v0.5 conditions v9 enforces
 * pairwise, applied uniformly across all supplied traces. The first
 * non-uniform gated field rejects the whole set, naming the pair it
 * failed on — a mixed set is never partitioned silently. A field absent
 * on some trace makes the condition unverifiable, not violated, matching
 * v9: a `set.caveat.*` entry records the gap. Observed-property drift
 * (yuurei/runtime version, resolved model, isolation verification) is
 * recorded the same way.
 */
function checkCellsComparability(
  traces: readonly YuureiTrace[],
  ctxs: readonly CellCtx[],
): SetCaveat[] {
  const caveats: SetCaveat[] = [];
  const names = ctxs.map((ctx) => ctx.subject as string);
  const n = traces.length;

  /** First index ≥ 1 whose value differs from run1's, else -1. */
  const firstDiffering = <T>(
    get: (trace: YuureiTrace) => T,
    eq: (a: T, b: T) => boolean = (a, b) => a === b,
  ): number => {
    const first = get(traces[0]!);
    for (let i = 1; i < n; i += 1) if (!eq(first, get(traces[i]!))) return i;
    return -1;
  };

  const reject = (field: string, i: number, a: string, b: string): never => {
    throw mismatched(
      `run1's trace records ${field} ${a} but ${names[i]}'s records ` +
        `${b}; only runs of the same requested execution are reported as one set`,
    );
  };

  if (traces.every((t) => t.requestedCell !== undefined)) {
    const i = firstDiffering((t) => t.requestedCell!.inputsVersion);
    if (i !== -1)
      reject(
        "requested_cell.inputs_version",
        i,
        `${traces[0]!.requestedCell!.inputsVersion}`,
        `${traces[i]!.requestedCell!.inputsVersion}`,
      );
  } else {
    const missing = names.filter(
      (_, i) => traces[i]!.requestedCell === undefined,
    );
    caveats.push({
      field: "requested_cell.inputs_version",
      text:
        `the input-set version could not be verified because ${nameList(missing)} ` +
        `${missing.length === 1 ? "does" : "do"} not record requested_cell; ` +
        `the runs may or may not have requested the same input set`,
      evidence: ctxs.map((ctx, i) =>
        traces[i]!.requestedCell === undefined
          ? cellEv(ctx, "trace", "", { note: "no requested_cell field" })
          : cellEv(ctx, "trace", "/requested_cell/inputs_version"),
      ),
    });
  }

  let i = firstDiffering((t) => t.task.digest);
  if (i !== -1)
    reject(
      "task.digest",
      i,
      `'${traces[0]!.task.digest}'`,
      `'${traces[i]!.task.digest}'`,
    );
  i = firstDiffering((t) => t.runtime.id);
  if (i !== -1)
    reject(
      "runtime.id",
      i,
      `'${traces[0]!.runtime.id}'`,
      `'${traces[i]!.runtime.id}'`,
    );
  i = firstDiffering((t) => t.model.requested);
  if (i !== -1)
    reject(
      "model.requested",
      i,
      describeRequestedModel(traces[0]!.model.requested),
      describeRequestedModel(traces[i]!.model.requested),
    );
  i = firstDiffering((t) => t.isolation.strategy);
  if (i !== -1)
    reject(
      "isolation.strategy",
      i,
      `'${traces[0]!.isolation.strategy}'`,
      `'${traces[i]!.isolation.strategy}'`,
    );

  if (traces.every((t) => t.executionOptions !== undefined)) {
    i = firstDiffering((t) => t.executionOptions!.timeoutMs);
    if (i !== -1)
      reject(
        "execution_options.timeout_ms",
        i,
        `${traces[0]!.executionOptions!.timeoutMs}`,
        `${traces[i]!.executionOptions!.timeoutMs}`,
      );
    i = firstDiffering((t) => t.executionOptions!.runtime, jsonEquals);
    if (i !== -1)
      throw mismatched(
        `run1's trace and ${names[i]}'s record different ` +
          `execution_options.runtime records`,
      );
  } else {
    const missing = names.filter(
      (_, index) => traces[index]!.executionOptions === undefined,
    );
    caveats.push({
      field: "execution_options",
      text:
        `the execution options could not be fully compared because ${nameList(missing)} ` +
        `${missing.length === 1 ? "does" : "do"} not record execution_options; ` +
        `timeout and runtime options may or may not have matched`,
      evidence: ctxs.map((ctx, index) =>
        traces[index]!.executionOptions === undefined
          ? cellEv(ctx, "trace", "", { note: "no execution_options field" })
          : cellEv(ctx, "trace", "/execution_options"),
      ),
    });
  }

  /**
   * Observed-property drift: present-but-differing observed values never
   * reject — they are recorded so an observed difference is not silently
   * attributed to the repeated configuration.
   */
  const drift = <T extends string | number | boolean>(
    field: string,
    pointer: string,
    label: string,
    get: (trace: YuureiTrace) => T | null | undefined,
  ) => {
    const groups = new Map<T, string[]>();
    for (const [index, trace] of traces.entries()) {
      const value = get(trace);
      if (value === undefined || value === null) continue;
      (groups.get(value) ?? groups.set(value, []).get(value)!).push(
        names[index]!,
      );
    }
    if (groups.size <= 1) return;
    const detail = [...groups.entries()]
      .map(([value, group]) => `'${value}' on ${nameList(group)}`)
      .join("; ");
    caveats.push({
      field,
      text:
        `the recorded ${label} differ (${detail}); a difference between ` +
        `the supplied runs' observations may reflect this drift, not the configuration`,
      evidence: ctxs.flatMap((ctx, index) =>
        get(traces[index]!) === undefined || get(traces[index]!) === null
          ? [cellEv(ctx, "trace", "", { note: `no ${field} recorded` })]
          : [cellEv(ctx, "trace", pointer)],
      ),
    });
  };

  drift(
    "yuurei_version",
    "/yuurei_version",
    "yuurei versions",
    (t) => t.yuureiVersion,
  );
  drift(
    "runtime.version",
    "/runtime/version",
    "runtime versions",
    (t) => t.runtime.version,
  );
  drift(
    "model.resolved",
    "/model/resolved",
    "resolved models",
    (t) => t.model.resolved,
  );
  drift(
    "model.resolved_reason",
    "/model/resolved_reason",
    "resolved-model reasons",
    (t) => t.model.resolvedReason,
  );
  drift(
    "isolation.verified",
    "/isolation/verified",
    "isolation verification outcomes",
    (t) => t.isolation.verified,
  );

  return caveats.sort((a, b) => compareBytes(a.field, b.field));
}

// -- set lane ----------------------------------------------------------------

/**
 * The element's recorded content signature under pfl `diff` semantics
 * (kind, scope, source digest, canonical metadata) — equal signatures
 * group runs that recorded the same observed form.
 */
function elementSignature(element: PflSnapshotElement): string {
  return canonicalJson({
    kind: element.observed.native.kind,
    scope: element.observed.native.scope,
    digest: element.observed.source.digest,
    metadata: element.observed.metadata,
  });
}

/**
 * The shared completeness of a set statement: `complete` only when every
 * eligible export is complete, every supplied run was eligible, and no
 * partial export omits the record — a partial export's omission is an
 * unestablished absence, and an unbound run is an unknown observation.
 * `unknown` follows an eligible export declaring `completeness:
 * "unknown"`, the v9 convention.
 */
function setCompleteness(args: {
  eligible: readonly EligibleRun[];
  unboundCount: number;
  /** Some partial eligible export does not record this record. */
  unestablished?: boolean;
}): CellEntry["completeness"] {
  if (args.eligible.some((e) => e.doc.completeness === "unknown"))
    return "unknown";
  if (
    args.unboundCount > 0 ||
    args.unestablished === true ||
    args.eligible.some((e) => e.doc.completeness !== "complete")
  )
    return "partial";
  return "complete";
}

/**
 * Lists the run groups sharing each observed form of a record:
 * "run1 and run2 share one observed record; run3 records a distinct one".
 */
function describeGroups(groups: Map<string, string[]>): string {
  return [...groups.values()]
    .map((group) =>
      group.length === 1
        ? `${group[0]} records a distinct observed record`
        : `${nameList(group)} share one observed record`,
    )
    .join("; ");
}

/** "run1's complete export records no such element" phrasing per absent run. */
function absentPhrase(
  runs: readonly EligibleRun[],
  names: readonly string[],
): string {
  return runs
    .map((run) =>
      run.doc.completeness === "complete"
        ? `no record in ${names[run.index]}'s complete export`
        : `no record in ${names[run.index]}'s ${run.doc.completeness} export — an unestablished absence`,
    )
    .join("; ");
}

/**
 * The `set` lane: populations, comparability, identities, the shared
 * source identity, and per-record statements over the union of eligible
 * export records — or `set.config-unavailable` when no repeated
 * statement can be made.
 */
function setLaneEntries(args: {
  ctxs: readonly CellCtx[];
  cells: readonly CellRun[];
  bindings: readonly CellEntry["state"][];
  sourceProjects: readonly CellEntry["state"][];
  caveats: readonly SetCaveat[];
  declaredId: string | null;
  eligible: readonly EligibleRun[];
}): CellEntry[] {
  const {
    ctxs,
    cells,
    bindings,
    sourceProjects,
    caveats,
    declaredId,
    eligible,
  } = args;
  const entries: CellEntry[] = [];
  const names = ctxs.map((ctx) => ctx.subject as string);
  const unbound = names.filter((_, index) => bindings[index] !== "verified");
  const n = ctxs.length;
  const e = eligible.length;

  // set.inputs — the three populations.
  entries.push(
    setEntry(
      "set.inputs",
      "recorded",
      "complete",
      `${n} run directories were supplied (${nameList(names)} in order); ` +
        `${e} of them bind an export and count as eligible observations` +
        (unbound.length === 0
          ? ""
          : `; ${nameList(unbound)} ${unbound.length === 1 ? "has" : "have"} no bound export and ${unbound.length === 1 ? "contributes" : "contribute"} nothing to the denominators below`),
      ctxs.map((ctx) => cellEv(ctx, "trace", "/run_id")),
    ),
  );

  // set.comparability — the gate already ran; this states what held.
  entries.push(
    setEntry(
      "set.comparability",
      "verified",
      "complete",
      `all ${n} supplied runs record the same task.digest, runtime.id, ` +
        `model.requested, isolation.strategy, and execution options — the ` +
        `comparability conditions hold uniformly across the set`,
      ctxs.flatMap((ctx) => [
        cellEv(ctx, "trace", "/task/digest"),
        cellEv(ctx, "trace", "/runtime/id"),
        cellEv(ctx, "trace", "/model/requested"),
        cellEv(ctx, "trace", "/isolation/strategy"),
      ]),
    ),
  );
  for (const caveat of caveats)
    entries.push(
      setEntry(
        `set.caveat.${caveat.field}`,
        "recorded",
        "complete",
        caveat.text,
        caveat.evidence,
      ),
    );

  // set.requested-cell — the requested input set each run records.
  {
    const digests = new Map<string, string[]>();
    const versions = new Map<number, string[]>();
    for (const [index, trace] of cells
      .map((cell) => cell.run.trace)
      .entries()) {
      if (trace.requestedCell === undefined) continue;
      (
        digests.get(trace.requestedCell.digest) ??
        digests
          .set(trace.requestedCell.digest, [])
          .get(trace.requestedCell.digest)!
      ).push(names[index]!);
      (
        versions.get(trace.requestedCell.inputsVersion) ??
        versions
          .set(trace.requestedCell.inputsVersion, [])
          .get(trace.requestedCell.inputsVersion)!
      ).push(names[index]!);
    }
    const versionPart =
      versions.size === 1
        ? `input-set version ${[...versions.keys()][0]}`
        : versions.size === 0
          ? "no recorded input-set version"
          : "differing input-set versions";
    const digestPart =
      digests.size === 0
        ? "no run records a requested_cell digest"
        : digests.size === 1
          ? `all runs that record one share requested_cell.digest '${[...digests.keys()][0]}'`
          : `the requested_cell digests differ (${[...digests.entries()]
              .map(([digest, group]) => `'${digest}' on ${nameList(group)}`)
              .join(
                "; ",
              )}) — cells prepared from different requested input sets under one version`;
    entries.push(
      setEntry(
        "set.requested-cell",
        digests.size === 0 ? "not-recorded" : "recorded",
        digests.size === 0 ? "unknown" : "complete",
        `the supplied runs record ${versionPart}; ${digestPart}`,
        ctxs.map((ctx, index) =>
          cells[index]!.run.trace.requestedCell === undefined
            ? cellEv(ctx, "trace", "", { note: "no requested_cell field" })
            : traceNestedEv(ctx, "requested_cell", "digest"),
        ),
      ),
    );
  }

  // set.profile — identity is the content digest; the name is provenance.
  {
    const profiles = new Map<string, { name: string; runs: string[] }>();
    for (const [index, cell] of cells.entries()) {
      const profile = cell.run.trace.profile;
      const group = profiles.get(profile.digest) ?? {
        name: profile.name,
        runs: [],
      };
      group.runs.push(names[index]!);
      profiles.set(profile.digest, group);
    }
    entries.push(
      setEntry(
        "set.profile",
        "recorded",
        "complete",
        profiles.size === 1
          ? `all ${n} runs used profile '${[...profiles.values()][0]!.name}' ` +
              `(content digest '${[...profiles.keys()][0]}') — the same profile identity`
          : `the runs record ${profiles.size} distinct profile identities: ` +
              [...profiles.entries()]
                .map(
                  ([digest, group]) =>
                    `'${group.name}' (digest '${digest}') on ${nameList(group.runs)}`,
                )
                .join("; ") +
              ` — a profile difference is stated as set context, never a defect`,
        ctxs.flatMap((ctx) => [
          cellEv(ctx, "trace", "/profile/name"),
          cellEv(ctx, "trace", "/profile/digest"),
        ]),
      ),
    );
  }

  // set.identities — recorded identity distinctness; a duplicated id is
  // a recorded fact, not an error.
  {
    const runIds = new Map<string, string[]>();
    const cellIds = new Map<string, string[]>();
    let unnamedCells = 0;
    for (const [index, cell] of cells.entries()) {
      const trace = cell.run.trace;
      (
        runIds.get(trace.runId) ?? runIds.set(trace.runId, []).get(trace.runId)!
      ).push(names[index]!);
      if (trace.cellId === undefined) unnamedCells += 1;
      else
        (
          cellIds.get(trace.cellId) ??
          cellIds.set(trace.cellId, []).get(trace.cellId)!
        ).push(names[index]!);
    }
    const duplicates = (map: Map<string, string[]>, what: string) =>
      [...map.entries()]
        .filter(([, group]) => group.length > 1)
        .map(
          ([id, group]) => `${what} '${id}' is recorded by ${nameList(group)}`,
        );
    const dups = [
      ...duplicates(runIds, "run_id"),
      ...duplicates(cellIds, "cell_id"),
    ];
    entries.push(
      setEntry(
        "set.identities",
        "recorded",
        "complete",
        `the ${n} runs record ${runIds.size} distinct run id(s) and ` +
          `${cellIds.size} distinct cell_id(s)` +
          (unnamedCells > 0
            ? `; ${unnamedCells} run(s) record no cell_id`
            : "") +
          (dups.length === 0
            ? ""
            : `; ${dups.join("; ")} — an equal id is a recorded claim, not proof one prepared cell was reused`),
        ctxs.flatMap((ctx) => [
          cellEv(ctx, "trace", "/run_id"),
          traceFieldEv(ctx, "cell_id"),
        ]),
      ),
    );
  }

  // set.source-identity — the declared source project and the observed
  // cell-local project ids, kept distinct as v9 does.
  {
    const evidence: CellEvidenceReference[] = ctxs.flatMap((ctx, index) => [
      traceSeedSourceEv(ctx),
      ...(bindings[index] === "verified" &&
      cells[index]!.observation.exportDocument !== null
        ? [exportSourceEv(ctx), exportSideEv(ctx, "/data/project/id")]
        : [traceFieldEv(ctx, "observation")]),
    ]);
    const projectIds = [
      ...new Set(eligible.map((run) => run.doc.data.project.id)),
    ];
    const projectPart =
      eligible.length === 0
        ? "no bound export records an observed cell-local project id"
        : `the observed cell-local project ids are ${projectIds
            .map((id, i) => `'${id}' (${names[eligible[i]!.index]!})`)
            .join(", ")}` +
          (projectIds.length === 1
            ? " — the same observed identity"
            : " — distinct observed identities, as expected for separately prepared cells");
    let state: CellEntry["state"];
    let completeness: CellEntry["completeness"];
    let statement: string;
    if (declaredId !== null) {
      const unverified = names.filter(
        (name, index) =>
          bindings[index] === "verified" &&
          sourceProjects[index] !== "verified",
      );
      const allVerified = unverified.length === 0;
      state = allVerified ? "verified" : "unverifiable";
      completeness = allVerified ? "complete" : "unknown";
      statement =
        `the supplied runs declare one source-project identity '${declaredId}'` +
        (allVerified
          ? `, verified by the trace seed record and bound export of every eligible run`
          : `, but the declaration cannot be verified against both records on ${nameList(unverified)}`) +
        `; ${projectPart}`;
    } else if (eligible.length === 0) {
      state = "not-recorded";
      completeness = "unknown";
      statement = `no supplied run binds an export, so no shared source-project identity is recorded; ${projectPart}`;
    } else if (projectIds.length === 1) {
      state = "recorded";
      completeness = "complete";
      statement =
        `no run declares a source-project identity; the bound exports record ` +
        `one observed cell-local project id '${projectIds[0]}' — the set is ` +
        `joined on the observed identity, which is not a declared source identity`;
    } else {
      state = "unverifiable";
      completeness = "unknown";
      statement =
        `no declared source-project identity is recorded and the bound ` +
        `exports' observed project ids differ; whether the set describes ` +
        `one source project is unverifiable — ${projectPart}`;
    }
    entries.push(
      setEntry("set.source-identity", state, completeness, statement, evidence),
    );
  }

  // The configuration account needs ≥ 2 bound exports over one shared
  // identity; anything less emits the availability marker only.
  const projectIds = [
    ...new Set(eligible.map((run) => run.doc.data.project.id)),
  ];
  const sharedIdentity = declaredId !== null || projectIds.length === 1;
  if (eligible.length < 2 || !sharedIdentity) {
    const reason =
      eligible.length < 2
        ? `only ${eligible.length} of ${n} supplied runs bind an export ` +
          `(${unbound.length === 0 ? "" : `${nameList(unbound)} record(s) no bound export; `}` +
          `a repeated-observation statement needs at least two)`
        : `no shared source-project identity is established`;
    entries.push(
      setEntry(
        "set.config-unavailable",
        eligible.length === 0 ? "not-recorded" : "unverifiable",
        "unknown",
        `the repeated-observation account cannot be reported: ${reason}; ` +
          `the supplied set's configuration records may or may not differ — ` +
          `this is never 'no recorded difference'`,
        ctxs.flatMap((ctx) => exportDocEvidenceFor(ctx)),
      ),
    );
    return entries;
  }

  // -- per-record statements over the union ---------------------------------

  interface RecordedForm {
    readonly run: EligibleRun;
    readonly element: PflSnapshotElement;
    readonly elementIndex: number;
  }
  const byId = new Map<string, RecordedForm[]>();
  for (const run of eligible)
    run.doc.data.elements.forEach((element, elementIndex) => {
      (byId.get(element.id) ?? byId.set(element.id, []).get(element.id)!).push({
        run,
        element,
        elementIndex,
      });
    });
  const ids = [...byId.keys()].sort(compareBytes);

  let identicalAll = 0;
  let differing = 0;
  let subset = 0;
  for (const forms of byId.values()) {
    if (forms.length < e) subset += 1;
    else if (new Set(forms.map((f) => elementSignature(f.element))).size > 1)
      differing += 1;
    else identicalAll += 1;
  }
  entries.push(
    setEntry(
      "set.elements",
      "recorded",
      setCompleteness({ eligible, unboundCount: unbound.length }),
      `the ${e} eligible exports record ${ids.length} distinct element id(s): ` +
        `${identicalAll} recorded identically in every eligible export, ` +
        `${differing} present in all with differing observed records, ` +
        `${subset} recorded in only a subset` +
        (unbound.length > 0
          ? `; ${nameList(unbound)} could not be checked (no bound export)`
          : ""),
      eligible.map((run) => exportSideEv(run.ctx, "/data/elements")),
    ),
  );

  for (const id of ids) {
    const forms = byId.get(id)!;
    const absent = eligible.filter((run) => !forms.some((f) => f.run === run));
    const signatures = new Map<string, string[]>();
    for (const form of forms)
      (
        signatures.get(elementSignature(form.element)) ??
        signatures
          .set(elementSignature(form.element), [])
          .get(elementSignature(form.element))!
      ).push(names[form.run.index]!);
    const resolvedGroups = new Map<string | null, string[]>();
    for (const form of forms) {
      const key =
        form.element.resolved === null ? null : form.element.resolved.status;
      (resolvedGroups.get(key) ?? resolvedGroups.set(key, []).get(key)!).push(
        names[form.run.index]!,
      );
    }

    const parts: string[] = [
      `element '${id}' is recorded in ${forms.length} of ${e} eligible exports`,
    ];
    if (absent.length > 0) parts.push(absentPhrase(absent, names));
    if (signatures.size > 1) {
      parts.push(`the observed records differ — ${describeGroups(signatures)}`);
    } else {
      parts.push(
        forms.length === e
          ? "the observed records are identical"
          : "the recorded forms are identical across the exports that record the element",
      );
    }
    if (resolvedGroups.size === 1 && resolvedGroups.has(null))
      parts.push("no resolved layer is recorded in any eligible export");
    else if (resolvedGroups.size === 1)
      parts.push(
        `resolved status '${[...resolvedGroups.keys()][0]}' in all eligible exports`,
      );
    else
      parts.push(
        `resolved status differs — ` +
          [...resolvedGroups.entries()]
            .map(([status, group]) =>
              status === null
                ? `no resolved layer in ${nameList(group)}`
                : `'${status}' in ${nameList(group)}`,
            )
            .join("; "),
      );
    if (unbound.length > 0)
      parts.push(`${nameList(unbound)} could not be checked (no bound export)`);

    const unestablished = absent.some(
      (run) => run.doc.completeness !== "complete",
    );
    const evidence: CellEvidenceReference[] = forms.map((form) =>
      exportSideEv(form.run.ctx, `/data/elements/${form.elementIndex}`, id),
    );
    for (const run of absent)
      evidence.push(exportSideEv(run.ctx, "/data/elements", id));
    for (const runIndex of ctxs
      .map((_, index) => index)
      .filter((index) => bindings[index] !== "verified"))
      evidence.push(traceFieldEv(ctxs[runIndex]!, "observation"));

    entries.push(
      setEntry(
        `set.element.${id}`,
        "recorded",
        setCompleteness({
          eligible,
          unboundCount: unbound.length,
          unestablished,
        }),
        parts.join("; "),
        evidence,
      ),
    );
  }

  // Relations: union over eligible exports keyed by (type, from, to).
  {
    const union = new Map<
      string,
      { from: string; to: string; type: string; runs: EligibleRun[] }
    >();
    for (const run of eligible)
      for (const relation of run.doc.data.relations) {
        const key = relationKey(relation);
        const bucket =
          union.get(key) ?? union.set(key, { ...relation, runs: [] }).get(key)!;
        bucket.runs.push(run);
      }
    const keys = [...union.entries()].sort(([a], [b]) => compareBytes(a, b));
    keys.forEach(([key, bucket], index) => {
      const absent = eligible.filter((run) => !bucket.runs.includes(run));
      const parts = [
        `relation '${bucket.type}' '${bucket.from}' → '${bucket.to}' is recorded ` +
          `in ${bucket.runs.length} of ${e} eligible exports`,
      ];
      if (absent.length > 0) parts.push(absentPhrase(absent, names));
      if (unbound.length > 0)
        parts.push(
          `${nameList(unbound)} could not be checked (no bound export)`,
        );
      entries.push(
        setEntry(
          `set.relation.${index}`,
          "recorded",
          setCompleteness({
            eligible,
            unboundCount: unbound.length,
            unestablished: absent.some(
              (run) => run.doc.completeness !== "complete",
            ),
          }),
          parts.join("; "),
          [
            ...bucket.runs.map((run) => {
              const i = run.doc.data.relations.findIndex(
                (r) => relationKey(r) === key,
              );
              return exportSideEv(run.ctx, `/data/relations/${i}`);
            }),
            ...absent.map((run) => exportSideEv(run.ctx, "/data/relations")),
          ],
        ),
      );
    });
  }

  // Findings: union over eligible exports keyed by the whole record.
  {
    const union = new Map<
      string,
      {
        finding: PflExportDocument["data"]["findings"][number];
        runs: EligibleRun[];
      }
    >();
    for (const run of eligible)
      for (const finding of run.doc.data.findings) {
        const key = canonicalJson(finding);
        const bucket =
          union.get(key) ?? union.set(key, { finding, runs: [] }).get(key)!;
        bucket.runs.push(run);
      }
    const entries_ = [...union.values()].sort((a, b) => {
      const fa = a.finding;
      const fb = b.finding;
      return (
        compareBytes(fa.rule, fb.rule) ||
        compareBytes(
          fa.elementIds.join("\u0000"),
          fb.elementIds.join("\u0000"),
        ) ||
        compareBytes(fa.message, fb.message)
      );
    });
    entries_.forEach((bucket, index) => {
      const absent = eligible.filter((run) => !bucket.runs.includes(run));
      const parts = [
        `finding '${bucket.finding.rule}'` +
          (bucket.finding.elementIds.length === 0
            ? ""
            : ` on ${bucket.finding.elementIds.join(", ")}`) +
          ` is recorded in ${bucket.runs.length} of ${e} eligible exports`,
      ];
      if (absent.length > 0) parts.push(absentPhrase(absent, names));
      if (unbound.length > 0)
        parts.push(
          `${nameList(unbound)} could not be checked (no bound export)`,
        );
      entries.push(
        setEntry(
          `set.finding.${index}`,
          "recorded",
          setCompleteness({
            eligible,
            unboundCount: unbound.length,
            unestablished: absent.some(
              (run) => run.doc.completeness !== "complete",
            ),
          }),
          parts.join("; "),
          [
            ...bucket.runs.map((run) => {
              const i = run.doc.data.findings.findIndex(
                (f) => canonicalJson(f) === canonicalJson(bucket.finding),
              );
              return exportSideEv(run.ctx, `/data/findings/${i}`);
            }),
            ...absent.map((run) => exportSideEv(run.ctx, "/data/findings")),
          ],
        ),
      );
    });
  }

  return entries;
}

/**
 * Evidence for a run with no bound export — the trace's observation
 * record states why no export exists to cite.
 */
function exportDocEvidenceFor(ctx: CellCtx): CellEvidenceReference[] {
  const bound =
    ctx.cell.observation.exportRecord !== null &&
    ctx.cell.observation.exportDocument !== null;
  return bound
    ? [exportSideEv(ctx, "/data/elements")]
    : [traceFieldEv(ctx, "observation")];
}

// -- orchestrator --------------------------------------------------------------

/**
 * Builds the v10 repeated-set report (docs/v0.10-scope.md). Pure over the
 * loaded inputs; the reader performed all I/O. Rejects the whole set when
 * the comparability gates or the declared source-project identity do not
 * hold uniformly — never partitions the supplied set.
 */
export function reportCells(input: {
  cells: readonly CellRun[];
  labels?: readonly string[];
}): CellsReportResult {
  const cells = input.cells;
  if (cells.length < 2)
    throw new PflExportError(
      "invalid-shape",
      "report-cells requires at least two run directories",
    );
  if (cells.length > CELLS_MAX_RUNS)
    throw new PflExportError(
      "invalid-shape",
      `report-cells accepts at most ${CELLS_MAX_RUNS} run directories (${cells.length} supplied)`,
    );

  const ctxs: CellCtx[] = cells.map((cell, index) => ({
    cell,
    subject: runName(index),
    command: "report-cells",
  }));
  const names = ctxs.map((ctx) => ctx.subject as string);
  const traces = cells.map((cell) => cell.run.trace);

  // Reject on non-uniform gated fields before any entry is emitted.
  const caveats = checkCellsComparability(traces, ctxs);

  const assocs = ctxs.map((ctx) => associationEntries(ctx));
  const bindings = assocs.map((assoc) => assoc.binding);
  const sourceProjects = assocs.map((assoc) => assoc.sourceProject);

  // The declared source-project gate: every declaring record — each
  // trace's seed.source_project and each bound export's
  // data.snapshot.sourceProject — must name one identity.
  const declared = new Map<string, string[]>();
  const declare = (id: string, name: string) => {
    const group = declared.get(id) ?? declared.set(id, []).get(id)!;
    if (!group.includes(name)) group.push(name);
  };
  for (const [index, cell] of cells.entries()) {
    const declaredByTrace = cell.run.trace.seed?.sourceProject?.id;
    if (declaredByTrace !== undefined) declare(declaredByTrace, names[index]!);
    if (bindings[index] === "verified") {
      const declaredByExport =
        cell.observation.exportDocument?.data.snapshot.sourceProject?.id;
      if (declaredByExport !== undefined && declaredByExport !== null)
        declare(declaredByExport, names[index]!);
    }
  }
  if (declared.size > 1) {
    const [first, second] = [...declared.entries()];
    throw mismatched(
      `the supplied runs declare different source-project identities ` +
        `('${first[0]}' on ${nameList(first[1])} vs '${second[0]}' on ` +
        `${nameList(second[1])}) — the runs do not record one source project`,
    );
  }
  const declaredId = declared.size === 1 ? [...declared.keys()][0]! : null;

  const eligible: EligibleRun[] = ctxs.flatMap((ctx, index) => {
    const doc = cells[index]!.observation.exportDocument;
    return bindings[index] === "verified" && doc !== null
      ? [{ index, ctx, doc }]
      : [];
  });

  // The bound exports' observed runtime must be uniform, as compare-cells
  // requires of a pair.
  if (eligible.length >= 2) {
    const first = eligible[0]!.doc.data.runtime.id;
    const differing = eligible.find((run) => run.doc.data.runtime.id !== first);
    if (differing !== undefined)
      throw mismatched(
        `the retained exports describe different runtimes ` +
          `('${first}' on ${names[eligible[0]!.index]!} vs ` +
          `'${differing.doc.data.runtime.id}' on ${names[differing.index]!})`,
      );
  }

  const entries: CellEntry[] = [];
  for (const [index, ctx] of ctxs.entries())
    entries.push(
      ...assocs[index]!.entries,
      ...configurationEntries(ctx, bindings[index]!),
      ...executionEntries(ctx),
      ...auditEntries(ctx),
    );
  entries.push(
    ...setLaneEntries({
      ctxs,
      cells,
      bindings,
      sourceProjects,
      caveats,
      declaredId,
      eligible,
    }),
  );

  const result: CellsReportResult = {
    schemaVersion: CELLS_SCHEMA_VERSION,
    source: { command: "report-cells" },
    inputs: {
      runs: cells.map((cell, index) => ({
        name: runName(index),
        ...cellRunInput(cell, input.labels?.[index]),
      })),
    },
    entries: sortCellsEntries(entries, cells.length),
  };
  checkCellLimits(result);
  assertValidCellsResult(result);
  assertCellsEvidenceResolves(
    result,
    cells.map((cell) => cellDocs(cell)),
  );
  return result;
}
