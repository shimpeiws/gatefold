import type { BoundCheckReport } from "../application/check-report-binding.js";
import type { TaskSpec } from "../input/task-spec.js";
import type { EvaluatedRun } from "../input/yuurei-seeded-run.js";
import {
  EVALUATION_COMPARISON_SCHEMA_VERSION,
  EVALUATION_SCHEMA_VERSION,
  type CriterionEvaluation,
  type CriterionTransition,
  type EvaluationComparisonResult,
  type EvaluationEvidenceReference,
  type EvaluationEvidenceSource,
  type EvaluationResult,
} from "./evaluation.js";
import { resolvePointer } from "./validate-trace-comparison.js";

const POINTER_PATTERN = /^$|^(?:\/(?:[^/~]|~0|~1)*)*$/;
const SINGLE_SOURCES: readonly EvaluationEvidenceSource[] = [
  "trace",
  "manifest",
  "patch",
  "result",
  "spec",
  "checkReport",
];
const COMPARISON_SOURCES: readonly EvaluationEvidenceSource[] = [
  "beforeTrace",
  "afterTrace",
  "beforeManifest",
  "afterManifest",
  "beforePatch",
  "afterPatch",
  "beforeResult",
  "afterResult",
  "spec",
  "beforeCheckReport",
  "afterCheckReport",
];
const VERDICTS = ["pass", "fail", "unknown"] as const;
const ARTIFACT_STATES = [
  "verified",
  "verified-truncated",
  "digest-mismatch",
  "missing",
  "unverified",
] as const;
const PATCH_STATES = [...ARTIFACT_STATES, "malformed", "not-recorded"] as const;
const RESULT_STATES = [
  ...ARTIFACT_STATES,
  "not-emitted",
  "parse-failed",
  "save-failed",
  "not-recorded",
] as const;
const REPORT_STATES = ["accepted", "invalid", "mismatched"] as const;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new Error(`invalid evaluation result: ${message}`);
}

function checkEvidence(
  evidence: EvaluationEvidenceReference,
  at: string,
  sources: readonly EvaluationEvidenceSource[],
): void {
  if (
    typeof evidence.source !== "string" ||
    !(sources as readonly string[]).includes(evidence.source)
  )
    fail(`${at}.source must be a known evaluation document source`);
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

function checkVerdictEntry(
  entry: CriterionEvaluation | CriterionTransition,
  at: string,
  sources: readonly EvaluationEvidenceSource[],
): void {
  if (typeof entry.criterionId !== "string" || entry.criterionId.length === 0)
    fail(`${at}.criterionId must be a non-empty string`);
  if (typeof entry.kind !== "string" || entry.kind.length === 0)
    fail(`${at}.kind must be a non-empty string`);
  if (typeof entry.reason !== "string" || entry.reason.length === 0)
    fail(`${at}.reason must be a non-empty string`);
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0)
    fail(`${at}.evidence must contain at least one reference`);
  for (const [ei, evidence] of entry.evidence.entries())
    checkEvidence(evidence, `${at}.evidence[${ei}]`, sources);
  const provenance = entry.provenance;
  if (
    provenance === undefined ||
    !Array.isArray(provenance.transform) ||
    provenance.transform.some((t: unknown) => typeof t !== "string")
  )
    fail(`${at}.provenance must carry transform`);
  if (
    typeof entry.confidence !== "number" ||
    entry.confidence < 0 ||
    entry.confidence > 1
  )
    fail(`${at}.confidence must be a number in [0, 1]`);
}

/** Enforces the run-descriptor invariants shared by v6, v7, and v8. */
export function checkRunDescriptor(input: unknown, at: string): void {
  const run = input as Record<string, unknown>;
  if (
    run.document !== "yuurei-run" ||
    (run.trace as Record<string, unknown> | undefined)?.document !==
      "yuurei-trace"
  )
    fail(`${at} must bind a yuurei run directory`);
  if (typeof run.seeded !== "boolean") fail(`${at}.seeded must be a boolean`);
  if (run.baseline !== null && typeof run.baseline !== "object")
    fail(`${at}.baseline must be an object or null`);
  if (run.changes !== null && typeof run.changes !== "object")
    fail(`${at}.changes must be an object or null`);
  if (run.patchRecord !== null && typeof run.patchRecord !== "object")
    fail(`${at}.patchRecord must be an object or null`);
  if (!(PATCH_STATES as readonly string[]).includes(run.patchState as string))
    fail(`${at}.patchState must be a known patch state`);
  if (!(RESULT_STATES as readonly string[]).includes(run.resultState as string))
    fail(`${at}.resultState must be a known result state`);
  if (!Array.isArray(run.artifacts)) fail(`${at}.artifacts must be an array`);
  for (const [ai, entry] of (
    run.artifacts as Record<string, unknown>[]
  ).entries()) {
    const eat = `${at}.artifacts[${ai}]`;
    if (
      typeof entry.path !== "string" ||
      typeof entry.kind !== "string" ||
      typeof entry.digest !== "string" ||
      !(ARTIFACT_STATES as readonly string[]).includes(entry.state as string)
    )
      fail(`${eat} must carry path, kind, digest, and a known state`);
    if (entry.truncated !== undefined && entry.truncated !== true)
      fail(`${eat}.truncated must be true when present`);
    if (
      entry.bytes !== undefined &&
      (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0)
    )
      fail(`${eat}.bytes must be a non-negative integer when present`);
  }
}

function checkSpecDescriptor(input: unknown, at: string): void {
  const spec = input as Record<string, unknown>;
  if (spec.document !== "task-spec")
    fail(`${at} must bind a task-evaluation spec`);
  if (
    typeof spec.rubricId !== "string" ||
    typeof spec.taskDigest !== "string" ||
    typeof spec.specVersion !== "number"
  )
    fail(`${at} must carry rubricId, taskDigest, and specVersion`);
  if (spec.baselineDigest !== null && typeof spec.baselineDigest !== "string")
    fail(`${at}.baselineDigest must be a string or null`);
  if (
    !Number.isSafeInteger(spec.criterionCount) ||
    (spec.criterionCount as number) < 1
  )
    fail(`${at}.criterionCount must be a positive integer`);
}

function checkReportDescriptors(reports: unknown, at: string): void {
  if (!Array.isArray(reports)) fail(`${at} must be an array`);
  for (const [ri, entry] of (reports as Record<string, unknown>[]).entries()) {
    const eat = `${at}[${ri}]`;
    if (entry.document !== "check-report")
      fail(`${eat} must bind a check report`);
    if (entry.evaluatorId !== null && typeof entry.evaluatorId !== "string")
      fail(`${eat}.evaluatorId must be a string or null`);
    if (!(REPORT_STATES as readonly string[]).includes(entry.state as string))
      fail(`${eat}.state must be a known report state`);
    if (
      !Number.isSafeInteger(entry.resultCount) ||
      (entry.resultCount as number) < 0
    )
      fail(`${eat}.resultCount must be a non-negative integer`);
  }
}

function checkRunContext(context: unknown, at: string): void {
  const ctx = context as Record<string, unknown>;
  const execution = ctx.execution as Record<string, unknown> | undefined;
  const model = ctx.model as Record<string, unknown> | undefined;
  if (
    execution === undefined ||
    typeof execution.timedOut !== "boolean" ||
    model === undefined ||
    typeof model.requested !== "string"
  )
    fail(`${at} must carry execution and model context`);
}

/**
 * Enforces the claim-result invariants that schema/claim-result.v6.json
 * declares, at the evaluation boundary. Kept in sync with the schema by the
 * evaluation tests, which validate emitted results with ajv.
 */
export function assertValidEvaluationResult(result: EvaluationResult): void {
  if (result.schemaVersion !== EVALUATION_SCHEMA_VERSION)
    fail(`schemaVersion must be ${EVALUATION_SCHEMA_VERSION}`);
  if (
    result.source === undefined ||
    typeof result.source !== "object" ||
    result.source === null ||
    result.source.command !== "evaluate-run"
  )
    fail(`source.command must be 'evaluate-run'`);
  const inputs = result.inputs;
  if (inputs === undefined || typeof inputs !== "object" || inputs === null)
    fail("inputs must be an object");
  checkRunDescriptor(inputs.run, "inputs.run");
  checkSpecDescriptor(inputs.spec, "inputs.spec");
  checkReportDescriptors(inputs.checkReports, "inputs.checkReports");
  checkRunContext(result.context, "context");
  if (!Array.isArray(result.evaluations)) fail("evaluations must be an array");
  for (const [index, entry] of result.evaluations.entries()) {
    const at = `evaluations[${index}]`;
    if (!(VERDICTS as readonly string[]).includes(entry.verdict as string))
      fail(`${at}.verdict must be pass, fail, or unknown`);
    checkVerdictEntry(entry, at, SINGLE_SOURCES);
  }
}

/**
 * Enforces the claim-result invariants that schema/claim-result.v7.json
 * declares, at the comparison boundary.
 */
export function assertValidEvaluationComparisonResult(
  result: EvaluationComparisonResult,
): void {
  if (result.schemaVersion !== EVALUATION_COMPARISON_SCHEMA_VERSION)
    fail(`schemaVersion must be ${EVALUATION_COMPARISON_SCHEMA_VERSION}`);
  if (
    result.source === undefined ||
    typeof result.source !== "object" ||
    result.source === null ||
    result.source.command !== "compare-evaluations"
  )
    fail(`source.command must be 'compare-evaluations'`);
  const inputs = result.inputs;
  if (inputs === undefined || typeof inputs !== "object" || inputs === null)
    fail("inputs must be an object");
  checkRunDescriptor(inputs.beforeRun, "inputs.beforeRun");
  checkRunDescriptor(inputs.afterRun, "inputs.afterRun");
  checkSpecDescriptor(inputs.spec, "inputs.spec");
  checkReportDescriptors(
    inputs.beforeCheckReports,
    "inputs.beforeCheckReports",
  );
  checkReportDescriptors(inputs.afterCheckReports, "inputs.afterCheckReports");
  checkRunContext(result.context.before, "context.before");
  checkRunContext(result.context.after, "context.after");
  if (!Array.isArray(result.transitions)) fail("transitions must be an array");
  for (const [index, entry] of result.transitions.entries()) {
    const at = `transitions[${index}]`;
    for (const side of ["before", "after"] as const)
      if (!(VERDICTS as readonly string[]).includes(entry[side] as string))
        fail(`${at}.${side} must be pass, fail, or unknown`);
    if (typeof entry.changed !== "boolean")
      fail(`${at}.changed must be a boolean`);
    checkVerdictEntry(entry, at, COMPARISON_SOURCES);
  }
  if (!Array.isArray(result.caveats)) fail("caveats must be an array");
  for (const [ci, caveat] of result.caveats.entries()) {
    const at = `caveats[${ci}]`;
    if (typeof caveat.field !== "string" || typeof caveat.text !== "string")
      fail(`${at} must carry field and text`);
    if (!Array.isArray(caveat.evidence) || caveat.evidence.length === 0)
      fail(`${at}.evidence must contain at least one reference`);
    for (const [ei, evidence] of caveat.evidence.entries())
      checkEvidence(evidence, `${at}.evidence[${ei}]`, COMPARISON_SOURCES);
  }
}

function patchLineCount(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count === 0 && bytes.length > 0 ? 1 : count;
}

function checkArtifactEvidence(
  evidence: EvaluationEvidenceReference,
  run: EvaluatedRun,
  entryIndex: number | null,
  bytes: Buffer | null,
  parsedFiles: readonly { path: string }[] | null,
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
  const entry = run.entries[entryIndex];
  if (evidence.digest !== entry.digest)
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
    if (evidence.lines.end > patchLineCount(bytes))
      fail(`${at}.lines exceeds the stored artifact lines`);
  }
  if (
    evidence.path !== undefined &&
    parsedFiles !== null &&
    !parsedFiles.some((file) => file.path === evidence.path)
  )
    fail(
      `${at}.path names a file the patch does not record ` +
        `('${evidence.path}')`,
    );
}

function checkReportResolution(
  evidence: EvaluationEvidenceReference,
  reports: readonly BoundCheckReport[],
  at: string,
): void {
  // `elementId` names the supplying report by label; without it, the
  // pointer must resolve in at least one bound report document. A rejected
  // report carries no parsed document, so it may only be cited as a whole
  // (the empty pointer) by its label.
  const candidates =
    evidence.elementId === undefined
      ? reports
      : reports.filter((r) => r.descriptor.label === evidence.elementId);
  const found = candidates.some((r) =>
    r.report === null
      ? evidence.pointer === ""
      : resolvePointer(r.report.document, evidence.pointer).found,
  );
  if (!found)
    fail(
      `${at} pointer '${evidence.pointer}' does not resolve in the ` +
        `checkReport document`,
    );
}

/** Resolution context for v6 evidence. */
export interface EvaluationDocs {
  readonly run: EvaluatedRun;
  readonly spec: TaskSpec;
  readonly checkReports: readonly BoundCheckReport[];
}

/**
 * Enforces the v6 evidence contract against the loaded inputs: trace,
 * manifest, spec, and check-report pointers resolve inside the named
 * document; patch/result evidence cites the artifact's manifest entry,
 * repeats its recorded digest, and keeps ranges inside the verified bytes.
 */
export function assertEvaluationEvidenceResolves(
  result: EvaluationResult,
  docs: EvaluationDocs,
): void {
  for (const [index, entry] of result.evaluations.entries()) {
    for (const [ei, evidence] of entry.evidence.entries()) {
      const at = `evaluations[${index}].evidence[${ei}]`;
      switch (evidence.source) {
        case "patch":
          checkArtifactEvidence(
            evidence,
            docs.run,
            docs.run.patchEntryIndex,
            docs.run.patchBytes,
            docs.run.patch?.files ?? null,
            at,
          );
          break;
        case "result":
          checkArtifactEvidence(
            evidence,
            docs.run,
            docs.run.resultEntryIndex,
            docs.run.resultBytes,
            null,
            at,
          );
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
        case "spec":
          if (!resolvePointer(docs.spec.document, evidence.pointer).found)
            fail(`${at} pointer does not resolve in the spec document`);
          break;
        case "checkReport":
          checkReportResolution(evidence, docs.checkReports, at);
          break;
        default:
          fail(`${at}.source '${evidence.source}' is not a v6 evidence source`);
      }
    }
  }
}

/** Resolution context for v7 evidence. */
export interface EvaluationComparisonDocs {
  readonly beforeRun: EvaluatedRun;
  readonly afterRun: EvaluatedRun;
  readonly spec: TaskSpec;
  readonly beforeCheckReports: readonly BoundCheckReport[];
  readonly afterCheckReports: readonly BoundCheckReport[];
}

/**
 * Enforces the v7 evidence contract: every pointer resolves inside the
 * document its `before*`/`after*` source names.
 */
export function assertEvaluationComparisonEvidenceResolves(
  result: EvaluationComparisonResult,
  docs: EvaluationComparisonDocs,
): void {
  const docFor = (source: EvaluationEvidenceSource): unknown => {
    if (source === "spec") return docs.spec.document;
    const side = source.startsWith("before") ? docs.beforeRun : docs.afterRun;
    return source.endsWith("Trace")
      ? side.trace.document
      : side.manifestDocument;
  };
  const resolve = (
    entries: readonly { evidence: readonly EvaluationEvidenceReference[] }[],
    label: string,
  ): void => {
    for (const [index, entry] of entries.entries()) {
      for (const [ei, evidence] of entry.evidence.entries()) {
        const at = `${label}[${index}].evidence[${ei}]`;
        switch (evidence.source) {
          case "beforePatch":
            checkArtifactEvidence(
              evidence,
              docs.beforeRun,
              docs.beforeRun.patchEntryIndex,
              docs.beforeRun.patchBytes,
              docs.beforeRun.patch?.files ?? null,
              at,
            );
            continue;
          case "afterPatch":
            checkArtifactEvidence(
              evidence,
              docs.afterRun,
              docs.afterRun.patchEntryIndex,
              docs.afterRun.patchBytes,
              docs.afterRun.patch?.files ?? null,
              at,
            );
            continue;
          case "beforeResult":
            checkArtifactEvidence(
              evidence,
              docs.beforeRun,
              docs.beforeRun.resultEntryIndex,
              docs.beforeRun.resultBytes,
              null,
              at,
            );
            continue;
          case "afterResult":
            checkArtifactEvidence(
              evidence,
              docs.afterRun,
              docs.afterRun.resultEntryIndex,
              docs.afterRun.resultBytes,
              null,
              at,
            );
            continue;
          case "beforeCheckReport":
            checkReportResolution(evidence, docs.beforeCheckReports, at);
            continue;
          case "afterCheckReport":
            checkReportResolution(evidence, docs.afterCheckReports, at);
            continue;
          default:
            if (
              !resolvePointer(docFor(evidence.source), evidence.pointer).found
            )
              fail(
                `${at} pointer '${evidence.pointer}' does not resolve in the ` +
                  `${evidence.source} document`,
              );
        }
      }
    }
  };
  resolve(result.transitions, "transitions");
  resolve(result.caveats, "caveats");
}
