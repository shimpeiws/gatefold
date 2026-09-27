import {
  RUN_COMPARISON_SCHEMA_VERSION,
  type RunClaim,
  type RunComparisonResult,
  type RunInputDescriptor,
} from "../domain/run-comparison.js";
import type { TraceEvidenceReference } from "../domain/trace-comparison.js";
import {
  assertRunEvidenceResolves,
  assertValidRunComparisonResult,
} from "../domain/validate-run-comparison.js";
import { PflExportError } from "../input/pfl-export.js";
import type { YuureiRun } from "../input/yuurei-run.js";
import { traceInput } from "./compare-traces.js";
import { MAX_EMITTED_CLAIMS, MAX_EVIDENCE_REFERENCES } from "./limits.js";
import { RUN_RULES } from "./run-rules.js";
import { checkTraceComparability } from "./trace-comparability.js";
import { TRACE_RULES } from "./trace-rules.js";

/**
 * The per-run descriptor recorded in `inputs`: the supplied directory label,
 * the trace descriptor of the v4 schema, the patch summary state, and the
 * manifest facts with each entry's verification state. Describes, never
 * interprets.
 */
function runInput(run: YuureiRun, label?: string): RunInputDescriptor {
  return {
    label: label ?? run.dirPath,
    document: "yuurei-run",
    trace: traceInput(run.trace),
    patchState: run.patchState,
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

/**
 * Compares two already-loaded yuurei run directories as one A → B run
 * comparison (docs/v0.6-scope.md): enforces the v0.5 trace comparability
 * policy, emits the trace rules' claims plus the artifact rules' schema-v5
 * claims, and enforces the output ceilings. Callers must load each run with
 * `readYuureiRun` first; this function performs no I/O.
 */
export function compareRuns(input: {
  before: YuureiRun;
  after: YuureiRun;
  /**
   * Raw CLI arguments recorded as the inputs' labels. When omitted, each
   * run's sanitized directory path is used.
   */
  labels?: { before?: string; after?: string };
}): RunComparisonResult {
  const caveats = checkTraceComparability(
    input.before.trace,
    input.after.trace,
  );
  const claims: RunClaim[] = [
    ...TRACE_RULES.flatMap((rule) =>
      rule.evaluate({
        before: input.before.trace,
        after: input.after.trace,
        caveats,
      }),
    ).map((c) => ({
      ...c,
      evidence:
        c.evidence as readonly TraceEvidenceReference[] as RunClaim["evidence"],
    })),
    ...RUN_RULES.flatMap((rule) =>
      rule.evaluate({ before: input.before, after: input.after }),
    ),
  ];
  if (claims.length > MAX_EMITTED_CLAIMS)
    throw new PflExportError(
      "invalid-shape",
      `run comparison would emit ${claims.length} claims, exceeding the ${MAX_EMITTED_CLAIMS} claim ceiling`,
    );
  const evidenceCount = claims.reduce(
    (total, claim) => total + claim.evidence.length,
    0,
  );
  if (evidenceCount > MAX_EVIDENCE_REFERENCES)
    throw new PflExportError(
      "invalid-shape",
      `run comparison would cite ${evidenceCount} evidence references, exceeding the ${MAX_EVIDENCE_REFERENCES} reference ceiling`,
    );

  const result: RunComparisonResult = {
    schemaVersion: RUN_COMPARISON_SCHEMA_VERSION,
    source: { command: "compare-runs" },
    inputs: {
      beforeRun: runInput(input.before, input.labels?.before),
      afterRun: runInput(input.after, input.labels?.after),
    },
    claims,
  };
  assertValidRunComparisonResult(result);
  assertRunEvidenceResolves(result, {
    beforeRun: input.before,
    afterRun: input.after,
  });
  return result;
}
