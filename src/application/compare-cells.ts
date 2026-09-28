import { compareBytes } from "../domain/byte-order.js";
import {
  CELL_SCHEMA_VERSION,
  type CellEntry,
  type CellEvidenceReference,
  type CellReportResult,
} from "../domain/cell.js";
import { PflExportError } from "../input/pfl-export.js";
import type { SuppliedEvaluation } from "../input/cell-evaluation.js";
import type { CellRun } from "../input/yuurei-cell.js";
import type { OutputFile } from "../input/yuurei-seeded-run.js";
import {
  checkTraceComparability,
  type ComparabilityCaveat,
} from "./trace-comparability.js";
import { diffCellExports } from "./cell-diff.js";
import {
  assertCellEvidenceResolves,
  assertValidCellResult,
} from "../domain/validate-cell.js";
import {
  cellDocs,
  cellEntries,
  cellEntry,
  cellRunInput,
  cellSource,
  sortCellEntries,
  type CellCtx,
} from "./cell-report.js";
import { MAX_EMITTED_CLAIMS, MAX_EVIDENCE_REFERENCES } from "./limits.js";

function mismatched(message: string): PflExportError {
  return new PflExportError("mismatched-inputs", message);
}

/** The comparison ctx: no subject — comparison entries belong to neither side. */
const CMP_CTX = { command: "compare-cells" } as const;

function cmpEntry(
  id: string,
  state: CellEntry["state"],
  completeness: CellEntry["completeness"],
  statement: string,
  evidence: readonly CellEvidenceReference[],
): CellEntry {
  return cellEntry(
    CMP_CTX,
    "comparison",
    id,
    state,
    completeness,
    statement,
    evidence,
  );
}

/** Evidence citing one side's export document inside its elements array. */
function exportElementEvidence(
  ctx: CellCtx,
  elementIndex: number,
  elementId: string,
): CellEvidenceReference[] {
  const record = ctx.cell.observation.exportRecord;
  if (record === null) return [];
  return [
    {
      source: cellSource(ctx, "export"),
      pointer: `/data/elements/${elementIndex}`,
      ...(record.digest !== null && /^sha256:[0-9a-f]{64}$/.test(record.digest)
        ? { digest: record.digest }
        : {}),
      elementId,
    },
  ];
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The manifest-recorded digest of a listed artifact, when sha256-shaped. */
function entryDigest(
  run: CellRun["run"],
  index: number | null,
): {
  digest?: string;
} {
  if (index === null) return {};
  const digest = run.entries[index].digest;
  return digest !== null && SHA256_DIGEST.test(digest) ? { digest } : {};
}

/**
 * Evidence into one side's bound export document, stamped with the
 * manifest-recorded digest so the citation binds to the verified bytes.
 * Only call where a verified export document exists.
 */
function exportSideEv(
  ctx: CellCtx,
  pointer: string,
  elementId?: string,
): CellEvidenceReference {
  const record = ctx.cell.observation.exportRecord;
  return {
    source: cellSource(ctx, "export"),
    pointer,
    ...(record !== null &&
    record.digest !== null &&
    SHA256_DIGEST.test(record.digest)
      ? { digest: record.digest }
      : {}),
    ...(elementId === undefined ? {} : { elementId }),
  };
}

/** Whether the supplied document records `inputs.<key>`. */
function evaluationInputsHas(
  evaluation: SuppliedEvaluation,
  key: string,
): boolean {
  const document = evaluation.document;
  if (typeof document !== "object" || document === null) return false;
  const inputs = (document as Record<string, unknown>).inputs;
  return (
    typeof inputs === "object" &&
    inputs !== null &&
    Object.prototype.hasOwnProperty.call(inputs, key)
  );
}

/** Whether two recorded patch blocks describe identical output content. */
function sameOutputFile(a: OutputFile, b: OutputFile): boolean {
  return (
    a.change === b.change &&
    a.addedLines.length === b.addedLines.length &&
    a.removedLines.length === b.removedLines.length &&
    a.addedLines.every((line, i) => line === b.addedLines[i]) &&
    a.removedLines.every((line, i) => line === b.removedLines[i])
  );
}

/** The added/removed/changed/identical file sets between two output patches. */
function diffOutputFileSets(
  before: readonly OutputFile[],
  after: readonly OutputFile[],
): {
  added: OutputFile[];
  removed: OutputFile[];
  changed: { file: OutputFile }[];
  identical: OutputFile[];
} {
  const byPathA = new Map(before.map((file) => [file.path, file]));
  const byPathB = new Map(after.map((file) => [file.path, file]));
  const paths = [...new Set([...byPathA.keys(), ...byPathB.keys()])];
  paths.sort(compareBytes);
  const added: OutputFile[] = [];
  const removed: OutputFile[] = [];
  const changed: { file: OutputFile }[] = [];
  const identical: OutputFile[] = [];
  for (const path of paths) {
    const a = byPathA.get(path);
    const b = byPathB.get(path);
    if (a === undefined) added.push(b as OutputFile);
    else if (b === undefined) removed.push(a);
    else if (sameOutputFile(a, b)) identical.push(a);
    else changed.push({ file: a });
  }
  return { added, removed, changed, identical };
}

function elementIndex(cell: CellRun, id: string): number | null {
  const document = cell.observation.exportDocument;
  if (document === null) return null;
  const index = document.data.elements.findIndex(
    (element) => element.id === id,
  );
  return index === -1 ? null : index;
}

/**
 * The directional A → B statements: pfl-diff semantics between the two
 * bound exports plus the recorded run-record differences, always side by
 * side, never causal.
 */
function comparisonEntries(
  beforeCtx: CellCtx,
  afterCtx: CellCtx,
  caveats: readonly ComparabilityCaveat[],
  evaluation: SuppliedEvaluation | undefined,
): CellEntry[] {
  const before = beforeCtx.cell;
  const after = afterCtx.cell;
  const entries: CellEntry[] = [];

  entries.push(
    cmpEntry(
      "comparison.comparability",
      "verified",
      "complete",
      "the two runs satisfy the v0.5 comparability conditions: same task " +
        "digest, runtime, requested model, isolation strategy, and execution options",
      [
        { source: "beforeTrace", pointer: "/task/digest" },
        { source: "afterTrace", pointer: "/task/digest" },
        { source: "beforeTrace", pointer: "/runtime/id" },
        { source: "afterTrace", pointer: "/runtime/id" },
      ],
    ),
  );

  for (const caveat of caveats) {
    entries.push(
      cmpEntry(
        `comparison.caveat.${caveat.field}`,
        "recorded",
        "complete",
        caveat.text,
        caveat.evidence as readonly CellEvidenceReference[],
      ),
    );
  }

  // The cells' recorded identities: distinct prepared cells are expected.
  {
    const idA = before.run.trace.cellId;
    const idB = after.run.trace.cellId;
    const side = (id: string | undefined) =>
      id === undefined ? "records no cell_id" : `records cell_id '${id}'`;
    entries.push(
      cmpEntry(
        "comparison.cell-ids",
        "recorded",
        "complete",
        `cell A ${side(idA)}; cell B ${side(idB)} — the two prepared cells are distinct instances`,
        [
          {
            source: "beforeTrace",
            pointer: idA === undefined ? "" : "/cell_id",
            ...(idA === undefined ? { note: "no cell_id field" } : {}),
          },
          {
            source: "afterTrace",
            pointer: idB === undefined ? "" : "/cell_id",
            ...(idB === undefined ? { note: "no cell_id field" } : {}),
          },
        ],
      ),
    );
  }

  {
    const digestA = before.run.trace.requestedCell?.digest;
    const digestB = after.run.trace.requestedCell?.digest;
    const side = (digest: string | undefined) =>
      digest === undefined ? "records no requested_cell" : `'${digest}'`;
    entries.push(
      cmpEntry(
        "comparison.requested-cell",
        "recorded",
        "complete",
        `the runs' requested_cell digests are ${side(digestA)} (A) and ${side(digestB)} (B)` +
          (digestA !== undefined && digestB !== undefined && digestA !== digestB
            ? "; a different requested input set is the subject of this comparison"
            : ""),
        [
          {
            source: "beforeTrace",
            pointer: digestA === undefined ? "" : "/requested_cell/digest",
            ...(digestA === undefined
              ? { note: "no requested_cell field" }
              : {}),
          },
          {
            source: "afterTrace",
            pointer: digestB === undefined ? "" : "/requested_cell/digest",
            ...(digestB === undefined
              ? { note: "no requested_cell field" }
              : {}),
          },
        ],
      ),
    );
  }

  // The configuration difference requires a bound export on each side.
  const exportA = before.observation.exportDocument;
  const exportB = after.observation.exportDocument;
  if (exportA !== null && exportB !== null) {
    if (exportA.data.project.id !== exportB.data.project.id)
      throw mismatched(
        `the retained exports describe different projects ` +
          `('${exportA.data.project.id}' vs '${exportB.data.project.id}')`,
      );
    if (exportA.data.runtime.id !== exportB.data.runtime.id)
      throw mismatched(
        `the retained exports describe different runtimes ` +
          `('${exportA.data.runtime.id}' vs '${exportB.data.runtime.id}')`,
      );

    const completeness =
      exportA.completeness === "complete" && exportB.completeness === "complete"
        ? "complete"
        : exportA.completeness === "unknown" ||
            exportB.completeness === "unknown"
          ? "unknown"
          : "partial";
    const diff = diffCellExports(exportA, exportB);

    entries.push(
      cmpEntry(
        "comparison.elements",
        "recorded",
        completeness,
        diff.addedIds.length === 0 &&
          diff.removedIds.length === 0 &&
          diff.changedIds.length === 0
          ? "the two retained exports record identical element sets and contents"
          : `between the retained exports, ${diff.addedIds.length} element id(s) ` +
              `were added, ${diff.removedIds.length} removed, and ` +
              `${diff.changedIds.length} changed`,
        [
          exportSideEv(beforeCtx, "/data/elements"),
          exportSideEv(afterCtx, "/data/elements"),
        ],
      ),
    );

    const beforeById = new Map(
      exportA.data.elements.map((element) => [element.id, element]),
    );
    const afterById = new Map(
      exportB.data.elements.map((element) => [element.id, element]),
    );
    for (const id of diff.addedIds)
      entries.push(
        cmpEntry(
          `comparison.element-added.${id}`,
          "recorded",
          completeness,
          `element '${id}' is present in B's export and not in A's`,
          exportElementEvidence(afterCtx, elementIndex(after, id)!, id),
        ),
      );
    for (const id of diff.removedIds)
      entries.push(
        cmpEntry(
          `comparison.element-removed.${id}`,
          "recorded",
          completeness,
          `element '${id}' is present in A's export and not in B's`,
          exportElementEvidence(beforeCtx, elementIndex(before, id)!, id),
        ),
      );
    for (const id of diff.changedIds) {
      const a = beforeById.get(id)!;
      const b = afterById.get(id)!;
      const aspects: string[] = [];
      if (a.observed.native.kind !== b.observed.native.kind)
        aspects.push(
          `kind '${a.observed.native.kind}' → '${b.observed.native.kind}'`,
        );
      if (a.observed.native.scope !== b.observed.native.scope)
        aspects.push(
          `scope '${a.observed.native.scope ?? "none"}' → '${b.observed.native.scope ?? "none"}'`,
        );
      if (a.observed.source.digest !== b.observed.source.digest)
        aspects.push("content digest changed");
      if (aspects.length === 0) aspects.push("metadata changed");
      entries.push(
        cmpEntry(
          `comparison.element-changed.${id}`,
          "recorded",
          completeness,
          `element '${id}' differs between the exports: ${aspects.join("; ")}`,
          [
            ...exportElementEvidence(beforeCtx, elementIndex(before, id)!, id),
            ...exportElementEvidence(afterCtx, elementIndex(after, id)!, id),
          ],
        ),
      );
    }

    entries.push(
      cmpEntry(
        "comparison.effective",
        "recorded",
        completeness,
        `resolved-layer transitions: ${diff.newlyEffective} element(s) newly ` +
          `effective, ${diff.noLongerEffective} no longer effective, ` +
          `${diff.activationChanged} activation change(s); an effective ` +
          `status is a static fact, never evidence of runtime use`,
        [
          exportSideEv(beforeCtx, "/data/elements"),
          exportSideEv(afterCtx, "/data/elements"),
        ],
      ),
    );
    for (const change of diff.statusChanges)
      entries.push(
        cmpEntry(
          `comparison.status-change.${change.id}`,
          "recorded",
          completeness,
          `element '${change.id}' resolved status ` +
            `'${change.from}' → '${change.to}'`,
          [
            ...exportElementEvidence(
              beforeCtx,
              elementIndex(before, change.id)!,
              change.id,
            ),
            ...exportElementEvidence(
              afterCtx,
              elementIndex(after, change.id)!,
              change.id,
            ),
          ],
        ),
      );

    for (const [facet, delta] of Object.entries(diff.facetDeltas))
      entries.push(
        cmpEntry(
          `comparison.facet.${facet}`,
          "recorded",
          completeness,
          `interpretation facet '${facet}' count changed by ${delta} ` +
            `between the two exports`,
          [
            exportSideEv(beforeCtx, "/data/elements"),
            exportSideEv(afterCtx, "/data/elements"),
          ],
        ),
      );

    for (const [index, relation] of diff.relationsAdded.entries())
      entries.push(
        cmpEntry(
          `comparison.relation-added.${index}`,
          "recorded",
          completeness,
          `relation '${relation.type}' from '${relation.from}' to ` +
            `'${relation.to}' is recorded in B's export and not in A's`,
          [exportSideEv(afterCtx, "/data/relations")],
        ),
      );
    for (const [index, relation] of diff.relationsRemoved.entries())
      entries.push(
        cmpEntry(
          `comparison.relation-removed.${index}`,
          "recorded",
          completeness,
          `relation '${relation.type}' from '${relation.from}' to ` +
            `'${relation.to}' is recorded in A's export and not in B's`,
          [exportSideEv(beforeCtx, "/data/relations")],
        ),
      );
    for (const [index, finding] of diff.findingsAdded.entries())
      entries.push(
        cmpEntry(
          `comparison.finding-added.${index}`,
          "recorded",
          completeness,
          `finding '${finding.rule}' is recorded in B's export and not in ` +
            `A's: ${finding.message}`,
          [exportSideEv(afterCtx, "/data/findings")],
        ),
      );
    for (const [index, finding] of diff.findingsRemoved.entries())
      entries.push(
        cmpEntry(
          `comparison.finding-removed.${index}`,
          "recorded",
          completeness,
          `finding '${finding.rule}' is recorded in A's export and not in ` +
            `B's: ${finding.message}`,
          [exportSideEv(beforeCtx, "/data/findings")],
        ),
      );
    for (const [index, note] of diff.versionNotes.entries())
      entries.push(
        cmpEntry(
          `comparison.version-note.${index}`,
          "recorded",
          "complete",
          `the exports' tooling versions differ — ${note}`,
          [
            exportSideEv(beforeCtx, "/data/interpretation"),
            exportSideEv(afterCtx, "/data/interpretation"),
          ],
        ),
      );
  } else {
    const missing =
      exportA === null && exportB === null
        ? "neither cell retains a bound export"
        : exportA === null
          ? "cell A retains no bound export"
          : "cell B retains no bound export";
    entries.push(
      cmpEntry(
        "comparison.config-unavailable",
        exportA === null &&
          exportB === null &&
          before.observation.record === undefined &&
          after.observation.record === undefined
          ? "not-recorded"
          : "unverifiable",
        "unknown",
        `the configuration difference cannot be reported: ${missing}; ` +
          "the configuration may or may not differ — this is never 'no " +
          "configuration change'",
        [
          {
            source: "beforeTrace",
            pointer:
              before.observation.record === undefined ? "" : "/observation",
            ...(before.observation.record === undefined
              ? { note: "no observation field" }
              : {}),
          },
          {
            source: "afterTrace",
            pointer:
              after.observation.record === undefined ? "" : "/observation",
            ...(after.observation.record === undefined
              ? { note: "no observation field" }
              : {}),
          },
        ],
      ),
    );
  }

  // Recorded run differences, side by side.
  const executionA = before.run.trace.execution;
  const executionB = after.run.trace.execution;
  entries.push(
    cmpEntry(
      "comparison.outcome",
      "recorded",
      "complete",
      `the runs' recorded outcomes: exit_code ${executionA.exitCode ?? "not recorded"} (A) ` +
        `vs ${executionB.exitCode ?? "not recorded"} (B); ` +
        `duration_ms ${executionA.durationMs ?? "not recorded"} vs ` +
        `${executionB.durationMs ?? "not recorded"}; ` +
        `timed_out ${executionA.timedOut} vs ${executionB.timedOut}`,
      [
        { source: "beforeTrace", pointer: "/execution" },
        { source: "afterTrace", pointer: "/execution" },
      ],
    ),
  );

  const usageKeys = [
    ...new Set([
      ...Object.keys(before.run.trace.usage),
      ...Object.keys(after.run.trace.usage),
    ]),
  ].sort(compareBytes);
  for (const key of usageKeys) {
    const a = before.run.trace.usage[key];
    const b = after.run.trace.usage[key];
    const show = (value: number | null | undefined) =>
      value === undefined
        ? "the key is absent"
        : value === null
          ? "not recorded"
          : String(value);
    entries.push(
      cmpEntry(
        `comparison.usage.${key}`,
        "recorded",
        "complete",
        `usage '${key}': A recorded ${show(a)}; B recorded ${show(b)}`,
        [
          {
            source: "beforeTrace",
            pointer:
              a === undefined
                ? "/usage"
                : `/usage/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          },
          {
            source: "afterTrace",
            pointer:
              b === undefined
                ? "/usage"
                : `/usage/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          },
        ],
      ),
    );
  }

  {
    const costA = before.run.trace.cost;
    const costB = after.run.trace.cost;
    let statement: string;
    if (costA === null && costB === null)
      statement = "neither trace records a cost";
    else if (costA === null || costB === null)
      statement = `cost is recorded on one side only (A: ${costA === null ? "not recorded" : `${costA.amount} ${costA.currency}`}; B: ${costB === null ? "not recorded" : `${costB.amount} ${costB.currency}`})`;
    else if (costA.currency !== costB.currency)
      statement = `the recorded costs use different currencies (${costA.currency} vs ${costB.currency}): ${costA.amount} ${costA.currency} vs ${costB.amount} ${costB.currency}`;
    else
      statement = `the recorded costs are ${costA.amount} ${costA.currency} (A) vs ${costB.amount} ${costB.currency} (B)`;
    entries.push(
      cmpEntry("comparison.cost", "recorded", "complete", statement, [
        { source: "beforeTrace", pointer: "/cost" },
        { source: "afterTrace", pointer: "/cost" },
      ]),
    );
  }

  {
    const patchA = before.run.patch;
    const patchB = after.run.patch;
    if (patchA === null || patchB === null) {
      entries.push(
        cmpEntry(
          "comparison.patch",
          "unverifiable",
          "unknown",
          `the patch sets cannot be compared: A's patch is '${before.run.patchState}', ` +
            `B's is '${after.run.patchState}'`,
          [
            {
              source: "beforeTrace",
              pointer: before.run.trace.patch === undefined ? "" : "/patch",
              ...(before.run.trace.patch === undefined
                ? { note: "no patch record" }
                : {}),
            },
            {
              source: "afterTrace",
              pointer: after.run.trace.patch === undefined ? "" : "/patch",
              ...(after.run.trace.patch === undefined
                ? { note: "no patch record" }
                : {}),
            },
          ],
        ),
      );
    } else {
      const patchDiff = diffOutputFileSets(patchA.files, patchB.files);
      entries.push(
        cmpEntry(
          "comparison.patch",
          "recorded",
          "complete",
          `between the retained patches: ${patchDiff.added.length} file(s) ` +
            `added, ${patchDiff.removed.length} removed, ` +
            `${patchDiff.changed.length} changed, ` +
            `${patchDiff.identical.length} identical`,
          [
            {
              source: "beforePatch",
              pointer: `/artifacts/${before.run.patchEntryIndex}`,
              ...entryDigest(before.run, before.run.patchEntryIndex),
            },
            {
              source: "afterPatch",
              pointer: `/artifacts/${after.run.patchEntryIndex}`,
              ...entryDigest(after.run, after.run.patchEntryIndex),
            },
          ],
        ),
      );
      for (const file of patchDiff.added)
        entries.push(
          cmpEntry(
            `comparison.patch-file-added.${file.path}`,
            "recorded",
            "complete",
            `file '${file.path}' appears in B's patch and not in A's`,
            [
              {
                source: "afterPatch",
                pointer: `/artifacts/${after.run.patchEntryIndex}`,
                ...entryDigest(after.run, after.run.patchEntryIndex),
                path: file.path,
              },
            ],
          ),
        );
      for (const file of patchDiff.removed)
        entries.push(
          cmpEntry(
            `comparison.patch-file-removed.${file.path}`,
            "recorded",
            "complete",
            `file '${file.path}' appears in A's patch and not in B's`,
            [
              {
                source: "beforePatch",
                pointer: `/artifacts/${before.run.patchEntryIndex}`,
                ...entryDigest(before.run, before.run.patchEntryIndex),
                path: file.path,
              },
            ],
          ),
        );
      for (const change of patchDiff.changed)
        entries.push(
          cmpEntry(
            `comparison.patch-file-changed.${change.file.path}`,
            "recorded",
            "complete",
            `file '${change.file.path}' changed between the two retained patches`,
            [
              {
                source: "beforePatch",
                pointer: `/artifacts/${before.run.patchEntryIndex}`,
                ...entryDigest(before.run, before.run.patchEntryIndex),
                path: change.file.path,
              },
              {
                source: "afterPatch",
                pointer: `/artifacts/${after.run.patchEntryIndex}`,
                ...entryDigest(after.run, after.run.patchEntryIndex),
                path: change.file.path,
              },
            ],
          ),
        );
    }
  }

  entries.push(
    cmpEntry(
      "comparison.result",
      "recorded",
      "complete",
      `the final-result record states are '${before.run.resultState}' (A) ` +
        `and '${after.run.resultState}' (B)`,
      [
        before.run.resultEntryIndex === null
          ? {
              source: "beforeManifest",
              pointer: "",
              note: "no result.txt entry",
            }
          : {
              source: "beforeResult",
              pointer: `/artifacts/${before.run.resultEntryIndex}`,
              ...entryDigest(before.run, before.run.resultEntryIndex),
            },
        after.run.resultEntryIndex === null
          ? {
              source: "afterManifest",
              pointer: "",
              note: "no result.txt entry",
            }
          : {
              source: "afterResult",
              pointer: `/artifacts/${after.run.resultEntryIndex}`,
              ...entryDigest(after.run, after.run.resultEntryIndex),
            },
      ],
    ),
  );

  if (evaluation !== undefined) {
    const boundA =
      evaluation.state === "parsed" &&
      evaluation.beforeRun !== null &&
      evaluation.beforeRun.runId === before.run.trace.runId &&
      evaluation.beforeRun.taskDigest === before.run.trace.task.digest;
    const boundB =
      evaluation.state === "parsed" &&
      evaluation.afterRun !== null &&
      evaluation.afterRun.runId === after.run.trace.runId &&
      evaluation.afterRun.taskDigest === after.run.trace.task.digest;
    entries.push(
      cmpEntry(
        "comparison.evaluation-binding",
        evaluation.state !== "parsed"
          ? "unverifiable"
          : boundA && boundB
            ? "verified"
            : "inconsistent",
        boundA && boundB ? "complete" : "unknown",
        evaluation.state !== "parsed"
          ? `the supplied document is not a usable gatefold result: ${evaluation.error}`
          : boundA && boundB
            ? "the supplied v7 evaluation comparison binds to both runs"
            : `the supplied evaluation comparison does not bind to these runs ` +
              `(A bound: ${boundA}, B bound: ${boundB}); its transitions are withheld`,
        [
          evaluationInputsHas(evaluation, "beforeRun")
            ? { source: "beforeEvaluation", pointer: "/inputs/beforeRun" }
            : {
                source: "beforeEvaluation",
                pointer: "",
                note: "no inputs.beforeRun field",
              },
          evaluationInputsHas(evaluation, "afterRun")
            ? { source: "afterEvaluation", pointer: "/inputs/afterRun" }
            : {
                source: "afterEvaluation",
                pointer: "",
                note: "no inputs.afterRun field",
              },
          { source: "beforeTrace", pointer: "/run_id" },
          { source: "afterTrace", pointer: "/run_id" },
        ],
      ),
    );
    if (boundA && boundB) {
      for (const transition of evaluation.verdicts) {
        entries.push(
          cmpEntry(
            `comparison.evaluation-transition.${transition.index}`,
            "recorded",
            "complete",
            `the supplied evaluation records criterion ` +
              `'${transition.criterionId}' (${transition.kind}) as ` +
              `'${transition.before}' → '${transition.after}': ` +
              `${transition.reason}`,
            [
              {
                source: "beforeEvaluation",
                pointer: `/transitions/${transition.index}`,
              },
            ],
          ),
        );
      }
    }
  }

  return entries;
}

/**
 * Builds the v9 A → B cell comparison (docs/v0.9-scope.md). Throws
 * `mismatched-inputs` when the v0.5 trace comparability checks or the
 * export-side identity checks fail; everything else is reported.
 */
export function compareCells(input: {
  before: CellRun;
  after: CellRun;
  labels?: { before?: string; after?: string };
  evaluation?: SuppliedEvaluation;
}): CellReportResult {
  const caveats = checkTraceComparability(
    input.before.run.trace,
    input.after.run.trace,
  );
  const beforeCtx: CellCtx = {
    cell: input.before,
    subject: "before",
    command: "compare-cells",
  };
  const afterCtx: CellCtx = {
    cell: input.after,
    subject: "after",
    command: "compare-cells",
  };
  const entries: CellEntry[] = [
    ...cellEntries(beforeCtx),
    ...cellEntries(afterCtx),
    ...comparisonEntries(beforeCtx, afterCtx, caveats, input.evaluation),
  ];
  // The evaluation lane for a pair is comparison-scoped: it lives in the
  // comparison entries above (transitions are inherently A → B).
  const result: CellReportResult = {
    schemaVersion: CELL_SCHEMA_VERSION,
    source: { command: "compare-cells" },
    inputs: {
      before: cellRunInput(input.before, input.labels?.before),
      after: cellRunInput(input.after, input.labels?.after),
      ...(input.evaluation === undefined
        ? {}
        : {
            evaluation: {
              label: input.evaluation.label,
              schemaVersion: input.evaluation.schemaVersion ?? 0,
              command:
                input.evaluation.schemaVersion === 6
                  ? ("evaluate-run" as const)
                  : ("compare-evaluations" as const),
            },
          }),
    },
    entries: sortCellEntries(entries),
  };
  if (result.entries.length > MAX_EMITTED_CLAIMS)
    throw new PflExportError(
      "invalid-shape",
      `the comparison would emit ${result.entries.length} entries, exceeding the ${MAX_EMITTED_CLAIMS} entry ceiling`,
    );
  const evidenceCount = result.entries.reduce(
    (total, entry) => total + entry.evidence.length,
    0,
  );
  if (evidenceCount > MAX_EVIDENCE_REFERENCES)
    throw new PflExportError(
      "invalid-shape",
      `the comparison would cite ${evidenceCount} evidence references, exceeding the ${MAX_EVIDENCE_REFERENCES} reference ceiling`,
    );
  assertValidCellResult(result);
  assertCellEvidenceResolves(result, {
    cells: [cellDocs(input.before), cellDocs(input.after)],
    evaluation: input.evaluation?.document ?? null,
  });
  return result;
}
