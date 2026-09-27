import { compareBytes } from "../domain/byte-order.js";
import {
  EVALUATION_SCHEMA_VERSION,
  type CriterionEvaluation,
  type EvaluationEvidenceReference,
  type EvaluationEvidenceSource,
  type EvaluationResult,
  type EvaluationRunDescriptor,
  type RunContextDescriptor,
  type SpecDescriptor,
  type Verdict,
} from "../domain/evaluation.js";
import { jsonEquals } from "./trace-comparability.js";
import {
  assertEvaluationEvidenceResolves,
  assertValidEvaluationResult,
} from "../domain/validate-evaluation.js";
import { PflExportError } from "../input/pfl-export.js";
import type { TaskCriterion, TaskSpec } from "../input/task-spec.js";
import type { EvaluatedRun, OutputFile } from "../input/yuurei-seeded-run.js";
import { sanitizeText } from "../domain/sanitize.js";
import {
  bindCheckReport,
  type BoundCheckReport,
  type LoadedCheckReport,
} from "./check-report-binding.js";
import { traceInput } from "./compare-traces.js";
import { MAX_EMITTED_CLAIMS, MAX_EVIDENCE_REFERENCES } from "./limits.js";

/**
 * Maps the logical documents a verdict cites onto the evidence `source`
 * names of one result shape: single-run names for `evaluate-run` (v6), and
 * `before*`/`after*` names for the two sides of `compare-evaluations` (v7).
 */
export interface SideSources {
  readonly trace: EvaluationEvidenceSource;
  readonly manifest: EvaluationEvidenceSource;
  readonly patch: EvaluationEvidenceSource;
  readonly result: EvaluationEvidenceSource;
  readonly spec: EvaluationEvidenceSource;
  readonly checkReport: EvaluationEvidenceSource;
}

export const SINGLE_SOURCES: SideSources = {
  trace: "trace",
  manifest: "manifest",
  patch: "patch",
  result: "result",
  spec: "spec",
  checkReport: "checkReport",
};
export const BEFORE_SOURCES: SideSources = {
  trace: "beforeTrace",
  manifest: "beforeManifest",
  patch: "beforePatch",
  result: "beforeResult",
  spec: "spec",
  checkReport: "beforeCheckReport",
};
export const AFTER_SOURCES: SideSources = {
  trace: "afterTrace",
  manifest: "afterManifest",
  patch: "afterPatch",
  result: "afterResult",
  spec: "spec",
  checkReport: "afterCheckReport",
};

const SOURCE_ORDER: Record<string, number> = {
  spec: 0,
  trace: 1,
  manifest: 2,
  patch: 3,
  result: 4,
  checkReport: 5,
  beforeTrace: 10,
  afterTrace: 11,
  beforeManifest: 12,
  afterManifest: 13,
  beforePatch: 14,
  afterPatch: 15,
  beforeResult: 16,
  afterResult: 17,
  beforeCheckReport: 18,
  afterCheckReport: 19,
};

/** Sorts evidence per contract: by source order, then pointer byte order. */
function sortEvidence(
  evidence: readonly EvaluationEvidenceReference[],
): EvaluationEvidenceReference[] {
  return [...evidence].sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      compareBytes(a.pointer, b.pointer),
  );
}

function evaluation(
  criterion: TaskCriterion,
  verdict: Verdict,
  reason: string,
  evidence: readonly EvaluationEvidenceReference[],
  confidence = 1,
): CriterionEvaluation {
  return {
    criterionId: criterion.id,
    kind: criterion.kind,
    verdict,
    reason: sanitizeText(reason),
    confidence,
    evidence: sortEvidence(evidence),
    provenance: {
      transform: ["evaluate-run", `criterion:${criterion.id}`],
    },
  };
}

function specEvidence(
  criterion: TaskCriterion,
  src: SideSources,
): EvaluationEvidenceReference {
  return { source: src.spec, pointer: `/criteria/${criterion.index}` };
}

function patchPointer(run: EvaluatedRun): string | null {
  return run.patchEntryIndex === null
    ? null
    : `/artifacts/${run.patchEntryIndex}`;
}

function patchDigest(run: EvaluatedRun): string {
  return run.patchEntryIndex === null
    ? ""
    : run.entries[run.patchEntryIndex].digest;
}

/** Evidence citing a generated file's block inside a verified patch. */
function fileEvidence(
  run: EvaluatedRun,
  src: SideSources,
  file: OutputFile,
  note?: string,
): EvaluationEvidenceReference {
  return {
    source: src.patch,
    pointer: patchPointer(run) ?? "",
    digest: patchDigest(run),
    path: file.path,
    lines: { start: file.startLine, end: file.endLine },
    bytes: { start: file.byteStart, end: file.byteEnd },
    ...(note === undefined ? {} : { note }),
  };
}

/** Evidence citing the patch entry itself (a state, not file content). */
function patchEntryEvidence(
  run: EvaluatedRun,
  src: SideSources,
  note?: string,
): EvaluationEvidenceReference {
  const pointer = patchPointer(run);
  return pointer === null
    ? { source: src.manifest, pointer: "", note: note ?? "no patch.diff entry" }
    : {
        source: src.manifest,
        pointer,
        ...(note === undefined ? {} : { note }),
      };
}

function resultPointer(run: EvaluatedRun): string | null {
  return run.resultEntryIndex === null
    ? null
    : `/artifacts/${run.resultEntryIndex}`;
}

function resultDigest(run: EvaluatedRun): string {
  return run.resultEntryIndex === null
    ? ""
    : run.entries[run.resultEntryIndex].digest;
}

/** Evidence citing the verified `result.txt` bytes as a whole. */
function resultEvidence(
  run: EvaluatedRun,
  src: SideSources,
  note?: string,
): EvaluationEvidenceReference {
  const lines = run.resultBytes === null ? 0 : lineCount(run.resultBytes);
  return {
    source: src.result,
    pointer: resultPointer(run) ?? "",
    digest: resultDigest(run),
    // An empty stored file has no line 1 to cite; the byte range {0, 0}
    // still bounds the (empty) record.
    ...(lines === 0 ? {} : { lines: { start: 1, end: lines } }),
    bytes: {
      start: 0,
      end: run.resultBytes === null ? 0 : run.resultBytes.length,
    },
    ...(note === undefined ? {} : { note }),
  };
}

/** Evidence citing the result entry itself (a state, not content). */
function resultEntryEvidence(
  run: EvaluatedRun,
  src: SideSources,
  note?: string,
): EvaluationEvidenceReference {
  const pointer = resultPointer(run);
  return pointer === null
    ? {
        source: src.manifest,
        pointer: "",
        note: note ?? "no result.txt entry",
      }
    : {
        source: src.manifest,
        pointer,
        ...(note === undefined ? {} : { note }),
      };
}

/** Counts LF-terminated lines in stored artifact bytes. */
function lineCount(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count === 0 && bytes.length > 0 ? 1 : count;
}

const FILE_KIND_CHANGES: Record<string, "added" | "modified" | "deleted"> = {
  "file-added": "added",
  "file-modified": "modified",
  "file-deleted": "deleted",
};

/** Evidence citing the trace's `patch` completeness record. */
function patchRecordEvidence(
  src: SideSources,
  note?: string,
): EvaluationEvidenceReference {
  return {
    source: src.trace,
    pointer: "/patch/state",
    ...(note === undefined ? {} : { note }),
  };
}

/** Evidence citing one trace diagnostic by its array index. */
function diagnosticEvidence(
  src: SideSources,
  index: number,
): EvaluationEvidenceReference {
  return { source: src.trace, pointer: `/diagnostics/${index}` };
}

/** Evaluates one `file-*` criterion against the unified patch record. */
function evaluateFileCriterion(
  run: EvaluatedRun,
  criterion: TaskCriterion,
  src: SideSources,
): CriterionEvaluation {
  const spec = specEvidence(criterion, src);
  const expected = FILE_KIND_CHANGES[criterion.kind];
  const kindName = expected;

  // The trace's records decide whether stored patch bytes can carry a
  // verdict at all. `patch.state: "absent"` or a generation-failed
  // diagnostic asserts no patch was published; stored bytes that
  // contradict that record are unusable evidence either way.
  const patchDisavowed =
    run.patchRecord?.state === "absent" || run.patchFailureIndex !== -1;
  if (patchDisavowed || run.patch === null) {
    const evidence: EvaluationEvidenceReference[] = [
      spec,
      patchEntryEvidence(run, src, `patch.diff is ${run.patchState}`),
    ];
    let reason: string;
    if (run.patchRecord?.state === "absent") {
      reason =
        `the trace records the patch as absent; it cannot establish ` +
        `whether '${criterion.path}' was ${kindName}`;
      evidence.push(patchRecordEvidence(src));
    } else if (run.patchFailureIndex !== -1) {
      reason =
        `the trace records that patch generation failed; it cannot ` +
        `establish whether '${criterion.path}' was ${kindName}`;
      evidence.push(diagnosticEvidence(src, run.patchFailureIndex));
    } else {
      reason =
        `the patch is ${run.patchState}; no file record can establish ` +
        `whether '${criterion.path}' was ${kindName}`;
    }
    return evaluation(criterion, "unknown", reason, evidence);
  }

  // A legacy empty-workspace patch is additions only: it can never express
  // modification or deletion against a baseline.
  if (!run.seeded && expected !== "added") {
    return evaluation(
      criterion,
      "unknown",
      `the run records no seeded baseline; an all-additions patch cannot ` +
        `express a ${kindName} file`,
      [
        spec,
        { source: src.trace, pointer: "", note: "no seed field" },
        patchEntryEvidence(run, src),
      ],
    );
  }

  const file = run.patch.files.find((f) => f.path === criterion.path);
  if (file !== undefined) {
    if (file.change === expected) {
      return evaluation(
        criterion,
        "pass",
        `the patch records '${criterion.path}' as ${kindName}`,
        [spec, fileEvidence(run, src, file)],
      );
    }
    return evaluation(
      criterion,
      "fail",
      `the patch records '${criterion.path}' as ${file.change}, not ${kindName}`,
      [spec, fileEvidence(run, src, file, `recorded as ${file.change}`)],
    );
  }

  // Absence of a block is a negative verdict only when the patch is a
  // complete record of the run's changes: an untruncated stored patch that
  // the trace marks `complete` — or, on traces predating the `patch`
  // record, one whose diagnostics report no omissions. A `partial` patch,
  // a cut tail, or recorded omissions leave the path's change unknown.
  if (run.patchRecord?.state === "partial") {
    return evaluation(
      criterion,
      "unknown",
      `the trace records the patch as partial; '${criterion.path}' may ` +
        `be an omitted change`,
      [
        spec,
        patchRecordEvidence(src),
        patchEntryEvidence(run, src, `no block for ${criterion.path}`),
      ],
    );
  }
  if (!run.patch.complete) {
    return evaluation(
      criterion,
      "unknown",
      `the patch is truncated; '${criterion.path}' may be in the cut tail`,
      [
        spec,
        patchEntryEvidence(
          run,
          src,
          `no block for ${criterion.path} in the stored prefix`,
        ),
      ],
    );
  }
  if (run.patchRecord === undefined && run.patchOmissionIndex !== -1) {
    return evaluation(
      criterion,
      "unknown",
      `the trace records omitted patch content; '${criterion.path}' may ` +
        `be an omitted change`,
      [
        spec,
        diagnosticEvidence(src, run.patchOmissionIndex),
        patchEntryEvidence(run, src, `no block for ${criterion.path}`),
      ],
    );
  }
  return evaluation(
    criterion,
    "fail",
    `the complete patch does not record '${criterion.path}'`,
    [spec, patchEntryEvidence(run, src, `no block for ${criterion.path}`)],
  );
}

/** Evidence for a final-result criterion that cannot reach content. */
function resultUnavailable(
  run: EvaluatedRun,
  criterion: TaskCriterion,
  src: SideSources,
  reason: string,
): CriterionEvaluation {
  const evidence: EvaluationEvidenceReference[] = [
    specEvidence(criterion, src),
  ];
  if (run.resultEntryIndex !== null)
    evidence.push(
      resultEntryEvidence(run, src, `result.txt is ${run.resultState}`),
    );
  else if (run.resultDiagnosticIndex !== -1)
    evidence.push(diagnosticEvidence(src, run.resultDiagnosticIndex));
  else
    evidence.push(
      resultEntryEvidence(run, src, `result.txt is ${run.resultState}`),
    );
  return evaluation(criterion, "unknown", reason, evidence);
}

/** Evaluates one `final-result-*` criterion against the verified result. */
function evaluateResultCriterion(
  run: EvaluatedRun,
  criterion: TaskCriterion,
  src: SideSources,
): CriterionEvaluation {
  const spec = specEvidence(criterion, src);
  if (run.resultState !== "verified")
    return resultUnavailable(
      run,
      criterion,
      src,
      `the final result is ${run.resultState}; it cannot establish the criterion`,
    );
  if (run.resultText === null)
    return resultUnavailable(
      run,
      criterion,
      src,
      "the verified result bytes are not decodable UTF-8",
    );

  const text = run.resultText;
  const cited = () => [spec, resultEvidence(run, src)];

  if (criterion.kind === "final-result-exact") {
    return text === criterion.text
      ? evaluation(
          criterion,
          "pass",
          "the final result matches the expected text exactly",
          cited(),
        )
      : evaluation(
          criterion,
          "fail",
          "the final result differs from the expected text",
          cited(),
        );
  }
  if (criterion.kind === "final-result-contains") {
    return text.includes(criterion.text as string)
      ? evaluation(
          criterion,
          "pass",
          "the final result contains the expected text",
          cited(),
        )
      : evaluation(
          criterion,
          "fail",
          "the final result does not contain the expected text",
          cited(),
        );
  }
  // final-result-json-field
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return evaluation(
      criterion,
      "fail",
      "the final result is not a JSON document; the required field does not exist",
      cited(),
    );
  }
  const resolved = resolveJsonPointer(document, criterion.pointer as string);
  if (resolved.found && jsonEquals(resolved.value, criterion.equals)) {
    return evaluation(
      criterion,
      "pass",
      `the final result field '${criterion.pointer}' equals the expected value`,
      cited(),
    );
  }
  return evaluation(
    criterion,
    "fail",
    resolved.found
      ? `the final result field '${criterion.pointer}' does not equal the expected value`
      : `the final result has no field at '${criterion.pointer}'`,
    cited(),
  );
}

/** Resolves an RFC 6901 pointer, returning the value for equality checks. */
function resolveJsonPointer(
  document: unknown,
  pointer: string,
): { found: boolean; value?: unknown } {
  let current = document;
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      if (
        !Object.prototype.hasOwnProperty.call(
          current as Record<string, unknown>,
          segment,
        )
      )
        return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

/** Evaluates one `external-check` criterion against the bound reports. */
function evaluateExternalCriterion(
  criterion: TaskCriterion,
  reports: readonly BoundCheckReport[],
  src: SideSources,
): CriterionEvaluation {
  const spec = specEvidence(criterion, src);
  const hits: {
    report: BoundCheckReport;
    verdict: Verdict;
    rowIndex: number;
  }[] = [];
  let conflict = false;
  for (const report of reports) {
    const bound = report.verdicts.get(criterion.id);
    if (bound === undefined) continue;
    if (bound.conflict) conflict = true;
    hits.push({
      report,
      verdict: bound.verdict,
      rowIndex: bound.rowIndex,
    });
  }
  if (conflict || new Set(hits.map((h) => h.verdict)).size > 1) {
    const first = hits[0];
    const evidence: EvaluationEvidenceReference[] = [spec];
    // Cite the results array, not one row: a conflict verdict must not
    // depend on the order rows appear in the report.
    if (first !== undefined)
      evidence.push({
        source: src.checkReport,
        pointer: "/results",
        elementId: first.report.descriptor.label,
        note: "conflicting verdicts recorded",
      });
    return evaluation(
      criterion,
      "unknown",
      `conflicting check results were reported for '${criterion.id}'`,
      evidence,
    );
  }
  if (hits.length === 0) {
    const anyAccepted = reports.some((r) => r.descriptor.state === "accepted");
    return evaluation(
      criterion,
      "unknown",
      anyAccepted
        ? `no check result was reported for '${criterion.id}'`
        : `no accepted check report could supply a result for '${criterion.id}'`,
      [spec, checkReportStateEvidence(reports, src)],
    );
  }
  const hit = hits[0];
  return evaluation(
    criterion,
    hit.verdict,
    hit.verdict === "pass"
      ? `evaluator '${hit.report.descriptor.evaluatorId}' reported pass`
      : hit.verdict === "fail"
        ? `evaluator '${hit.report.descriptor.evaluatorId}' reported fail`
        : `evaluator '${hit.report.descriptor.evaluatorId}' reported unknown`,
    [
      spec,
      {
        source: src.checkReport,
        pointer: `/results/${hit.rowIndex}`,
        elementId: hit.report.descriptor.label,
      },
    ],
  );
}

/** Evidence pointing at why no accepted report could supply verdicts. */
function checkReportStateEvidence(
  reports: readonly BoundCheckReport[],
  src: SideSources,
): EvaluationEvidenceReference {
  if (reports.length === 0)
    return {
      source: src.manifest,
      pointer: "",
      note: "no check report was supplied",
    };
  const rejected = reports.find((r) => r.descriptor.state !== "accepted");
  if (rejected !== undefined)
    return {
      source: src.checkReport,
      pointer: "",
      elementId: rejected.descriptor.label,
      note: `report ${rejected.descriptor.state}: ${rejected.descriptor.error}`,
    };
  const first = reports[0];
  return {
    source: src.checkReport,
    pointer: "/results",
    elementId: first.descriptor.label,
    note: "no result row names this criterion",
  };
}

/** Evaluates a single criterion against the run and bound reports. */
export function evaluateCriterion(
  run: EvaluatedRun,
  criterion: TaskCriterion,
  reports: readonly BoundCheckReport[],
  src: SideSources,
): CriterionEvaluation {
  if (criterion.kind === "external-check")
    return evaluateExternalCriterion(criterion, reports, src);
  if (criterion.kind.startsWith("file-"))
    return evaluateFileCriterion(run, criterion, src);
  return evaluateResultCriterion(run, criterion, src);
}

/**
 * Enforces the spec-to-run binding (docs/v0.7-scope.md): the spec's
 * `task.digest` must equal the run's recorded task digest, and a declared
 * `baseline.digest` must equal the seeded run's requested baseline
 * identity — a criterion is never evaluated against the wrong task or
 * baseline.
 */
export function assertSpecBinding(run: EvaluatedRun, spec: TaskSpec): void {
  if (spec.taskDigest !== run.trace.task.digest)
    throw new PflExportError(
      "mismatched-inputs",
      `the spec's task.digest '${spec.taskDigest}' does not match the run's ` +
        `task.digest '${run.trace.task.digest}'`,
    );
  const requestedDigest = run.trace.seed?.baseline.requestedDigest;
  if (
    spec.baselineDigest !== undefined &&
    spec.baselineDigest !== requestedDigest
  )
    throw new PflExportError(
      "mismatched-inputs",
      `the spec's baseline.digest '${spec.baselineDigest}' does not match ` +
        `the run's requested baseline digest ` +
        `'${requestedDigest ?? "none recorded"}'`,
    );
}

/** The per-run descriptor recorded in `inputs` for evaluation results. */
export function evaluationRunInput(
  run: EvaluatedRun,
  label?: string,
): EvaluationRunDescriptor {
  return {
    label: label ?? run.dirPath,
    document: "yuurei-run",
    trace: traceInput(run.trace),
    seeded: run.seeded,
    baseline:
      run.trace.seed === undefined
        ? null
        : {
            digest: run.trace.seed.baseline.requestedDigest,
            materializedDigest: run.trace.seed.baseline.materializedDigest,
            source: run.trace.seed.source,
            head: run.trace.seed.head,
          },
    changes:
      run.trace.seed?.changes === undefined
        ? null
        : {
            added: run.trace.seed.changes.added,
            modified: run.trace.seed.changes.modified,
            deleted: run.trace.seed.changes.deleted,
          },
    patchRecord:
      run.patchRecord === undefined
        ? null
        : { base: run.patchRecord.base, state: run.patchRecord.state },
    patchState: run.patchState,
    resultState: run.resultState,
    artifacts: run.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      digest: entry.digest,
      ...(entry.truncated ? { truncated: true as const } : {}),
      ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
      state: entry.state,
    })),
  };
}

/** The spec descriptor recorded in `inputs` for evaluation results. */
export function specInput(spec: TaskSpec, label?: string): SpecDescriptor {
  return {
    label: label ?? spec.sourcePath,
    document: "task-spec",
    specVersion: spec.specVersion,
    rubricId: spec.rubricId,
    taskDigest: spec.taskDigest,
    baselineDigest: spec.baselineDigest ?? null,
    criterionCount: spec.criteria.length,
  };
}

/** The observed run context preserved separately from verdicts. */
export function runContext(run: EvaluatedRun): RunContextDescriptor {
  return {
    execution: {
      exitCode: run.trace.execution.exitCode,
      signal: run.trace.execution.signal,
      timedOut: run.trace.execution.timedOut,
    },
    model: {
      requested: run.trace.model.requested,
      resolved: run.trace.model.resolved,
      ...(run.trace.model.resolvedReason === undefined
        ? {}
        : { resolvedReason: run.trace.model.resolvedReason }),
    },
    usage: run.trace.usage,
    cost: run.trace.cost,
  };
}

/**
 * Binds every supplied check report to the run and spec, returning the
 * bound reports whose descriptors are recorded in `inputs`.
 */
export function bindReports(
  run: EvaluatedRun,
  spec: TaskSpec,
  reports: readonly LoadedCheckReport[],
): BoundCheckReport[] {
  return reports.map((loaded) => bindCheckReport(loaded, run, spec));
}

/** Enforces the output ceilings on a completed evaluation list. */
export function assertEvaluationLimits(
  evaluations: readonly { evidence: readonly unknown[] }[],
): void {
  if (evaluations.length > MAX_EMITTED_CLAIMS)
    throw new PflExportError(
      "invalid-shape",
      `evaluation would emit ${evaluations.length} results, exceeding the ${MAX_EMITTED_CLAIMS} ceiling`,
    );
  const evidenceCount = evaluations.reduce(
    (total, entry) => total + entry.evidence.length,
    0,
  );
  if (evidenceCount > MAX_EVIDENCE_REFERENCES)
    throw new PflExportError(
      "invalid-shape",
      `evaluation would cite ${evidenceCount} evidence references, exceeding the ${MAX_EVIDENCE_REFERENCES} ceiling`,
    );
}

/**
 * Evaluates one already-loaded run against the task spec
 * (docs/v0.7-scope.md): binds the spec to the run, binds each supplied
 * check report, and resolves every criterion's verdict from verified
 * evidence only. Callers must load the run with `readEvaluatedRun`, the
 * spec with `readTaskSpec`, and reports with `loadCheckReports` first;
 * this function performs no I/O.
 */
export function evaluateRun(input: {
  run: EvaluatedRun;
  spec: TaskSpec;
  checkReports?: readonly LoadedCheckReport[];
  /**
   * Raw CLI arguments recorded as the inputs' labels. When omitted, each
   * input's own path is used.
   */
  labels?: { run?: string; spec?: string };
  sources?: SideSources;
}): EvaluationResult {
  const src = input.sources ?? SINGLE_SOURCES;
  assertSpecBinding(input.run, input.spec);
  const bound = bindReports(input.run, input.spec, input.checkReports ?? []);
  const evaluations = input.spec.criteria.map((criterion) =>
    evaluateCriterion(input.run, criterion, bound, src),
  );
  assertEvaluationLimits(evaluations);

  const result: EvaluationResult = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    source: { command: "evaluate-run" },
    inputs: {
      run: evaluationRunInput(input.run, input.labels?.run),
      spec: specInput(input.spec, input.labels?.spec),
      checkReports: bound.map((b) => b.descriptor),
    },
    context: runContext(input.run),
    evaluations,
  };
  assertValidEvaluationResult(result);
  assertEvaluationEvidenceResolves(result, {
    run: input.run,
    spec: input.spec,
    checkReports: bound,
  });
  return result;
}
