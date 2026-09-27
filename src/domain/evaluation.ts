import type {
  FinalResultState,
  OutputPatchState,
} from "../input/yuurei-seeded-run.js";
import type { ArtifactState } from "../input/yuurei-run.js";
import type { TraceInputDescriptor } from "./trace-comparison.js";

export const EVALUATION_SCHEMA_VERSION = 6;
export const EVALUATION_COMPARISON_SCHEMA_VERSION = 7;

/** A criterion verdict (docs/v0.7-scope.md): never a quality judgement. */
export type Verdict = "pass" | "fail" | "unknown";

/**
 * Which document an evidence reference resolves against: the evaluated
 * run's trace or manifest, its verified `patch.diff`/`result.txt` bytes,
 * the task spec, or an external check report — with `before*`/`after*`
 * forms for the A/B sides of a comparison.
 */
export type EvaluationEvidenceSource =
  | "trace"
  | "manifest"
  | "patch"
  | "result"
  | "spec"
  | "checkReport"
  | "beforeTrace"
  | "afterTrace"
  | "beforeManifest"
  | "afterManifest"
  | "beforePatch"
  | "afterPatch"
  | "beforeResult"
  | "afterResult"
  | "beforeCheckReport"
  | "afterCheckReport";

/** An inclusive 1-based line range or half-open 0-based byte range. */
export interface EvaluationEvidenceRange {
  readonly start: number;
  readonly end: number;
}

/**
 * v6/v7 evidence. `pointer` is an RFC 6901 JSON Pointer into the document
 * named by `source` — for the artifact sources (`*Patch`, `*Result`) it is
 * the manifest pointer of the artifact entry, binding the citation to the
 * manifest record. `digest` repeats the verified stored digest; `path`,
 * `lines`, and `bytes` locate content inside the verified stored bytes.
 */
export interface EvaluationEvidenceReference {
  readonly source: EvaluationEvidenceSource;
  readonly pointer: string;
  readonly digest?: string;
  readonly path?: string;
  readonly lines?: EvaluationEvidenceRange;
  readonly bytes?: EvaluationEvidenceRange;
  readonly elementId?: string;
  readonly note?: string;
}

export interface EvaluationProvenance {
  readonly transform: readonly string[];
}

/** One criterion's evaluated verdict with its reason and evidence. */
export interface CriterionEvaluation {
  readonly criterionId: string;
  readonly kind: string;
  readonly verdict: Verdict;
  /** Why the verdict is what it is — including why it is `unknown`. */
  readonly reason: string;
  readonly confidence: number;
  readonly evidence: readonly EvaluationEvidenceReference[];
  readonly provenance: EvaluationProvenance;
}

/**
 * Observed run context preserved separately from verdicts: execution
 * status, model identity, usage, and cost are described, never scored.
 */
export interface RunContextDescriptor {
  readonly execution: {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
  };
  readonly model: {
    readonly requested: string;
    readonly resolved: string | null;
    readonly resolvedReason?: string;
  };
  readonly usage: Readonly<Record<string, number | null>>;
  readonly cost: { readonly amount: number; readonly currency: string } | null;
}

/** One manifest entry preserved verbatim plus its verification outcome. */
export interface EvaluationArtifactDescriptor {
  readonly path: string;
  readonly kind: string;
  readonly digest: string;
  readonly truncated?: true;
  readonly bytes?: number;
  readonly state: ArtifactState;
}

/** The descriptor of one loaded run directory, seeded-aware. */
export interface EvaluationRunDescriptor {
  readonly label: string;
  readonly document: "yuurei-run";
  readonly trace: TraceInputDescriptor;
  /** Whether the trace records seeded-workspace provenance. */
  readonly seeded: boolean;
  /** The recorded baseline identity, or null for a legacy run. */
  readonly baseline: {
    readonly digest: string;
    readonly source?: string;
  } | null;
  readonly patchState: OutputPatchState;
  readonly resultState: FinalResultState;
  readonly artifacts: readonly EvaluationArtifactDescriptor[];
}

/** The descriptor of the task-evaluation spec both sides share. */
export interface SpecDescriptor {
  readonly label: string;
  readonly document: "task-spec";
  readonly specVersion: number;
  readonly rubricId: string;
  readonly taskDigest: string;
  readonly baselineDigest: string | null;
  readonly criterionCount: number;
}

/** Whether a supplied check report could be bound to its run. */
export type CheckReportState = "accepted" | "invalid" | "mismatched";

/** The descriptor of one supplied check report and its binding outcome. */
export interface CheckReportDescriptor {
  readonly label: string;
  readonly document: "check-report";
  readonly evaluatorId: string | null;
  readonly evaluatorVersion?: string;
  readonly state: CheckReportState;
  /** Why the report was rejected, when `state` is not `accepted`. */
  readonly error?: string;
  readonly resultCount: number;
}

/** Machine-readable result of `gatefold evaluate-run` (schema v6). */
export interface EvaluationResult {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly source: { readonly command: "evaluate-run" };
  readonly inputs: {
    readonly run: EvaluationRunDescriptor;
    readonly spec: SpecDescriptor;
    readonly checkReports: readonly CheckReportDescriptor[];
  };
  readonly context: RunContextDescriptor;
  readonly evaluations: readonly CriterionEvaluation[];
}

/** One criterion's A → B verdict transition. */
export interface CriterionTransition {
  readonly criterionId: string;
  readonly kind: string;
  readonly before: Verdict;
  readonly after: Verdict;
  readonly changed: boolean;
  /** What each side's verdict was and why — never a causal attribution. */
  readonly reason: string;
  readonly confidence: number;
  readonly evidence: readonly EvaluationEvidenceReference[];
  readonly provenance: EvaluationProvenance;
}

/** An allowed-but-meaningful A/B difference surfaced to the reader. */
export interface EvaluationCaveat {
  readonly field: string;
  readonly text: string;
  readonly evidence: readonly EvaluationEvidenceReference[];
}

/** Machine-readable result of `gatefold compare-evaluations` (schema v7). */
export interface EvaluationComparisonResult {
  readonly schemaVersion: typeof EVALUATION_COMPARISON_SCHEMA_VERSION;
  readonly source: { readonly command: "compare-evaluations" };
  readonly inputs: {
    readonly beforeRun: EvaluationRunDescriptor;
    readonly afterRun: EvaluationRunDescriptor;
    readonly spec: SpecDescriptor;
    readonly beforeCheckReports: readonly CheckReportDescriptor[];
    readonly afterCheckReports: readonly CheckReportDescriptor[];
  };
  readonly context: {
    readonly before: RunContextDescriptor;
    readonly after: RunContextDescriptor;
  };
  readonly transitions: readonly CriterionTransition[];
  readonly caveats: readonly EvaluationCaveat[];
}
