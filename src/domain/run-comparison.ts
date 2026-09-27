import type { ArtifactState, PatchState } from "../input/yuurei-run.js";
import type { TraceInputDescriptor } from "./trace-comparison.js";

export const RUN_COMPARISON_SCHEMA_VERSION = 5;

/**
 * Which document inside a run an evidence reference resolves against: the
 * run's trace, its artifact manifest, or its verified `patch.diff` bytes.
 */
export type RunEvidenceSource =
  | "beforeTrace"
  | "afterTrace"
  | "beforeManifest"
  | "afterManifest"
  | "beforePatch"
  | "afterPatch";

/** An inclusive 1-based line range or half-open 0-based byte range. */
export interface RunEvidenceRange {
  readonly start: number;
  readonly end: number;
}

/**
 * v5 evidence. `pointer` is an RFC 6901 JSON Pointer into the document named
 * by `source` — for the `*Patch` sources it is the manifest pointer of the
 * `patch.diff` entry, binding the citation to the manifest record. `digest`
 * repeats the verified stored digest; `path`, `lines`, and `bytes` locate
 * generated-file content inside the stored patch bytes.
 */
export interface RunEvidenceReference {
  readonly source: RunEvidenceSource;
  readonly pointer: string;
  readonly digest?: string;
  readonly path?: string;
  readonly lines?: RunEvidenceRange;
  readonly bytes?: RunEvidenceRange;
  readonly elementId?: string;
  readonly note?: string;
}

export interface RunClaimProvenance {
  readonly transform: readonly string[];
}

export interface RunClaim {
  readonly claim: string;
  readonly ruleId: string;
  readonly evidence: readonly RunEvidenceReference[];
  readonly provenance: RunClaimProvenance;
  readonly confidence: number;
}

/**
 * One manifest entry preserved verbatim plus its verification outcome
 * (docs/yuurei-run-contract.md).
 */
export interface RunArtifactDescriptor {
  readonly path: string;
  readonly kind: string;
  readonly digest: string;
  readonly truncated?: true;
  readonly bytes?: number;
  readonly state: ArtifactState;
}

/**
 * The descriptor of one loaded run directory: the supplied label, the trace
 * descriptor from the v4 schema, the manifest facts, and the patch summary.
 */
export interface RunInputDescriptor {
  readonly label: string;
  readonly document: "yuurei-run";
  readonly trace: TraceInputDescriptor;
  readonly patchState: PatchState;
  readonly artifacts: readonly RunArtifactDescriptor[];
}

/** Machine-readable result of `gatefold compare-runs` (schema v5). */
export interface RunComparisonResult {
  readonly schemaVersion: typeof RUN_COMPARISON_SCHEMA_VERSION;
  readonly source: { readonly command: "compare-runs" };
  readonly inputs: {
    readonly beforeRun: RunInputDescriptor;
    readonly afterRun: RunInputDescriptor;
  };
  readonly claims: readonly RunClaim[];
}
