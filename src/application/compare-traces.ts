import {
  TRACE_COMPARISON_SCHEMA_VERSION,
  type TraceComparisonResult,
  type TraceInputDescriptor,
} from "../domain/trace-comparison.js";
import {
  assertTraceEvidenceResolves,
  assertValidTraceComparisonResult,
} from "../domain/validate-trace-comparison.js";
import { PflExportError } from "../input/pfl-export.js";
import type { YuureiTrace } from "../input/yuurei-trace.js";
import { MAX_EMITTED_CLAIMS, MAX_EVIDENCE_REFERENCES } from "./limits.js";
import { checkTraceComparability } from "./trace-comparability.js";
import { TRACE_RULES } from "./trace-rules.js";

/**
 * The per-trace descriptor recorded in `inputs`: identity fields verbatim,
 * absent optional fields absent, `execution_options` and `definition`
 * carried as the trace's raw subdocuments so option-level and provenance
 * drift stay auditable. Describes, never interprets.
 */
export function traceInput(
  trace: YuureiTrace,
  label?: string,
): TraceInputDescriptor {
  const raw = trace.document as Readonly<Record<string, unknown>>;
  return {
    label: label ?? trace.sourcePath,
    document: "yuurei-trace",
    schemaVersion: trace.schemaVersion,
    runId: trace.runId,
    ...(trace.yuureiVersion === undefined
      ? {}
      : { yuureiVersion: trace.yuureiVersion }),
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt,
    runtimeId: trace.runtime.id,
    runtimeVersion: trace.runtime.version,
    modelRequested: trace.model.requested,
    modelResolved: trace.model.resolved,
    ...(trace.model.resolvedReason === undefined
      ? {}
      : { modelResolvedReason: trace.model.resolvedReason }),
    profileName: trace.profile.name,
    profileDigest: trace.profile.digest,
    taskSource: trace.task.source,
    taskDigest: trace.task.digest,
    isolationStrategy: trace.isolation.strategy,
    isolationVerified: trace.isolation.verified,
    ...(trace.requestedCell === undefined
      ? {}
      : {
          requestedCellDigest: trace.requestedCell.digest,
          requestedCellInputsVersion: trace.requestedCell.inputsVersion,
        }),
    ...(raw.execution_options === undefined
      ? {}
      : {
          executionOptions: raw.execution_options as Readonly<
            Record<string, unknown>
          >,
        }),
    ...(raw.definition === undefined
      ? {}
      : {
          definition: raw.definition as Readonly<Record<string, unknown>>,
        }),
  };
}

/**
 * Compares two already-parsed yuurei traces as one A → B run comparison
 * (docs/v0.5-scope.md): enforces the comparability policy, emits the
 * schema-v4 claims with per-trace evidence, and enforces the output
 * ceilings. Callers must parse and validate each input with the trace
 * reader first; this function does not re-check per-document shape.
 */
export function compareTraces(input: {
  before: YuureiTrace;
  after: YuureiTrace;
  /**
   * Raw CLI arguments recorded as the inputs' labels (the parser stores a
   * sanitized sourcePath, which cannot represent the supplied path). When
   * omitted, each trace's sanitized sourcePath is used.
   */
  labels?: { before?: string; after?: string };
}): TraceComparisonResult {
  const caveats = checkTraceComparability(input.before, input.after);
  const claims = TRACE_RULES.flatMap((rule) =>
    rule.evaluate({ before: input.before, after: input.after, caveats }),
  );
  if (claims.length > MAX_EMITTED_CLAIMS)
    throw new PflExportError(
      "invalid-shape",
      `trace comparison would emit ${claims.length} claims, exceeding the ${MAX_EMITTED_CLAIMS} claim ceiling`,
    );
  const evidenceCount = claims.reduce(
    (total, claim) => total + claim.evidence.length,
    0,
  );
  if (evidenceCount > MAX_EVIDENCE_REFERENCES)
    throw new PflExportError(
      "invalid-shape",
      `trace comparison would cite ${evidenceCount} evidence references, exceeding the ${MAX_EVIDENCE_REFERENCES} reference ceiling`,
    );

  const result: TraceComparisonResult = {
    schemaVersion: TRACE_COMPARISON_SCHEMA_VERSION,
    source: { command: "compare-traces" },
    inputs: {
      beforeTrace: traceInput(input.before, input.labels?.before),
      afterTrace: traceInput(input.after, input.labels?.after),
    },
    claims,
  };
  assertValidTraceComparisonResult(result);
  assertTraceEvidenceResolves(result, {
    beforeTrace: input.before.document,
    afterTrace: input.after.document,
  });
  return result;
}
