import {
  EVALUATION_COMPARISON_SCHEMA_VERSION,
  type CriterionTransition,
  type EvaluationComparisonResult,
  type EvaluationEvidenceReference,
} from "../domain/evaluation.js";
import {
  assertEvaluationComparisonEvidenceResolves,
  assertValidEvaluationComparisonResult,
} from "../domain/validate-evaluation.js";
import { sanitizeText } from "../domain/sanitize.js";
import { PflExportError } from "../input/pfl-export.js";
import type { TaskSpec } from "../input/task-spec.js";
import type { EvaluatedRun } from "../input/yuurei-seeded-run.js";
import type { LoadedCheckReport } from "./check-report-binding.js";
import {
  AFTER_SOURCES,
  assertEvaluationLimits,
  assertSpecBinding,
  BEFORE_SOURCES,
  bindReports,
  evaluateCriterion,
  evaluationRunInput,
  runContext,
  specInput,
} from "./evaluate-run.js";
import { checkTraceComparability } from "./trace-comparability.js";

/**
 * Enforces the v0.7 evaluation-comparability contract
 * (docs/v0.7-scope.md#ab-comparability-for-evaluations): each side binds to
 * the shared spec, the seeded/legacy run kinds match, and the v0.5
 * run-condition checks hold between the traces. The supplied spec fixes the
 * rubric for both sides, so rubric comparability holds by construction.
 * Returns the v0.5 caveat list for allowed differences.
 */
function checkEvaluationComparability(
  before: EvaluatedRun,
  after: EvaluatedRun,
  spec: TaskSpec,
) {
  assertSpecBinding(before, spec);
  assertSpecBinding(after, spec);
  if (before.seeded !== after.seeded)
    throw new PflExportError(
      "mismatched-inputs",
      `the runs record different workspace kinds ` +
        `(A is ${before.seeded ? "seeded" : "empty-workspace"}, ` +
        `B is ${after.seeded ? "seeded" : "empty-workspace"}); ` +
        `a seeded run is never compared with a legacy empty-workspace run`,
    );
  if (
    before.seeded &&
    before.trace.baseline?.digest !== after.trace.baseline?.digest
  )
    throw new PflExportError(
      "mismatched-inputs",
      `the runs record different baseline digests ` +
        `('${before.trace.baseline?.digest}' vs ` +
        `'${after.trace.baseline?.digest}'); ` +
        `only runs seeded from the same baseline are comparable`,
    );
  return checkTraceComparability(before.trace, after.trace);
}

/**
 * Compares two already-loaded runs against one task spec
 * (docs/v0.7-scope.md): enforces spec binding and run comparability,
 * evaluates each side's criteria, and reports per-criterion A → B
 * transitions — including `unknown` — with no aggregate score. Callers
 * must load runs with `readEvaluatedRun`, the spec with `readTaskSpec`,
 * and reports with `loadCheckReports` first; this function performs no I/O.
 */
export function compareEvaluations(input: {
  before: EvaluatedRun;
  after: EvaluatedRun;
  spec: TaskSpec;
  beforeCheckReports?: readonly LoadedCheckReport[];
  afterCheckReports?: readonly LoadedCheckReport[];
  labels?: { before?: string; after?: string; spec?: string };
}): EvaluationComparisonResult {
  const caveats = checkEvaluationComparability(
    input.before,
    input.after,
    input.spec,
  );
  const beforeBound = bindReports(
    input.before,
    input.spec,
    input.beforeCheckReports ?? [],
  );
  const afterBound = bindReports(
    input.after,
    input.spec,
    input.afterCheckReports ?? [],
  );

  const transitions: CriterionTransition[] = input.spec.criteria.map(
    (criterion) => {
      const beforeEval = evaluateCriterion(
        input.before,
        criterion,
        beforeBound,
        BEFORE_SOURCES,
      );
      const afterEval = evaluateCriterion(
        input.after,
        criterion,
        afterBound,
        AFTER_SOURCES,
      );
      const changed = beforeEval.verdict !== afterEval.verdict;
      // Each side's evaluation cites the shared spec identically; drop exact
      // duplicates so every emitted reference is distinct.
      const seen = new Set<string>();
      const evidence: EvaluationEvidenceReference[] = [
        ...beforeEval.evidence,
        ...afterEval.evidence,
      ].filter((entry) => {
        const key = JSON.stringify(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        before: beforeEval.verdict,
        after: afterEval.verdict,
        changed,
        reason: sanitizeText(
          changed
            ? `criterion '${criterion.id}' moved ${beforeEval.verdict} → ` +
                `${afterEval.verdict}: A — ${beforeEval.reason}; ` +
                `B — ${afterEval.reason}`
            : `criterion '${criterion.id}' stayed ${beforeEval.verdict}: ` +
                `${beforeEval.reason}`,
        ),
        confidence: 1,
        evidence,
        provenance: {
          transform: ["compare-evaluations", `criterion:${criterion.id}`],
        },
      };
    },
  );
  assertEvaluationLimits(transitions);

  const result: EvaluationComparisonResult = {
    schemaVersion: EVALUATION_COMPARISON_SCHEMA_VERSION,
    source: { command: "compare-evaluations" },
    inputs: {
      beforeRun: evaluationRunInput(input.before, input.labels?.before),
      afterRun: evaluationRunInput(input.after, input.labels?.after),
      spec: specInput(input.spec, input.labels?.spec),
      beforeCheckReports: beforeBound.map((b) => b.descriptor),
      afterCheckReports: afterBound.map((b) => b.descriptor),
    },
    context: {
      before: runContext(input.before),
      after: runContext(input.after),
    },
    transitions,
    caveats: caveats.map((caveat) => ({
      field: caveat.field,
      text: caveat.text,
      evidence: caveat.evidence as readonly EvaluationEvidenceReference[],
    })),
  };
  assertValidEvaluationComparisonResult(result);
  assertEvaluationComparisonEvidenceResolves(result, {
    beforeRun: input.before,
    afterRun: input.after,
    spec: input.spec,
    beforeCheckReports: beforeBound,
    afterCheckReports: afterBound,
  });
  return result;
}
