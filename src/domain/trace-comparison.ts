export const TRACE_COMPARISON_SCHEMA_VERSION = 4;

/** Which of the two input traces an evidence pointer resolves against. */
export type TraceEvidenceSource = "beforeTrace" | "afterTrace";

export interface TraceEvidenceReference {
  readonly source: TraceEvidenceSource;
  readonly pointer: string;
  readonly elementId?: string;
  readonly note?: string;
}

/**
 * v4 provenance carries only `transform`: per-trace metadata (labels,
 * versions, run ids) lives in the result's top-level `inputs` map because
 * one comparison claim can cite both traces.
 */
export interface TraceClaimProvenance {
  readonly transform: readonly string[];
}

export interface TraceClaim {
  readonly claim: string;
  readonly ruleId: string;
  readonly evidence: readonly TraceEvidenceReference[];
  readonly provenance: TraceClaimProvenance;
  readonly confidence: number;
}

/**
 * The validated identity of one input trace, recorded verbatim. Fields the
 * trace does not carry (`yuureiVersion`, `modelResolvedReason`,
 * `requestedCellDigest`, `requestedCellInputsVersion`, `executionOptions`,
 * `definition`) are absent — never rendered as null or invented.
 * `runtimeVersion` and `modelResolved` preserve null (recorded as
 * unobserved). `executionOptions` and `definition` are the trace's raw
 * `execution_options` / `definition` subdocuments.
 */
export interface TraceInputDescriptor {
  readonly label: string;
  readonly document: "yuurei-trace";
  readonly schemaVersion: string;
  readonly runId: string;
  readonly yuureiVersion?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runtimeId: string;
  readonly runtimeVersion: string | null;
  readonly modelRequested: string;
  readonly modelResolved: string | null;
  readonly modelResolvedReason?: "observed" | "unobserved" | "parse_failed";
  readonly profileName: string;
  readonly profileDigest: string;
  readonly taskSource: string;
  readonly taskDigest: string;
  readonly isolationStrategy: string;
  readonly isolationVerified: boolean;
  readonly requestedCellDigest?: string;
  readonly requestedCellInputsVersion?: number;
  readonly executionOptions?: Readonly<Record<string, unknown>>;
  readonly definition?: Readonly<Record<string, unknown>>;
}

/** Machine-readable result of `gatefold compare-traces` (schema v4). */
export interface TraceComparisonResult {
  readonly schemaVersion: typeof TRACE_COMPARISON_SCHEMA_VERSION;
  readonly source: { readonly command: "compare-traces" };
  readonly inputs: {
    readonly beforeTrace: TraceInputDescriptor;
    readonly afterTrace: TraceInputDescriptor;
  };
  readonly claims: readonly TraceClaim[];
}
