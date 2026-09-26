import type { Completeness } from "../input/pfl-export.js";

export const COMPARISON_SCHEMA_VERSION = 3;

/** Which of the three input documents an evidence pointer resolves against. */
export type ComparisonEvidenceSource = "before" | "after" | "diff";

export interface ComparisonEvidenceReference {
  readonly source: ComparisonEvidenceSource;
  readonly pointer: string;
  readonly elementId?: string;
  readonly note?: string;
}

/**
 * v3 provenance carries only `transform`: per-document metadata (labels,
 * versions, snapshot ids) lives in the result's top-level `inputs` map
 * because one comparison claim can cite up to three documents.
 */
export interface ComparisonClaimProvenance {
  readonly transform: readonly string[];
}

export interface ComparisonClaim {
  readonly claim: string;
  readonly ruleId: string;
  readonly evidence: readonly ComparisonEvidenceReference[];
  readonly provenance: ComparisonClaimProvenance;
  readonly confidence: number;
}

export interface ComparisonExportInput {
  readonly label: string;
  readonly command: "export";
  readonly pflVersion: string;
  readonly observedSnapshotId: string;
  readonly resolvedSnapshotId: string;
  readonly completeness: Completeness;
  readonly runtimeVersion: string | null;
  readonly semanticsVersion: string;
  readonly classifierVersion: string;
  readonly interpretationOrigin: "stored" | "recomputed";
}

export interface ComparisonDiffInput {
  readonly label: string;
  readonly command: "diff";
  readonly pflVersion: string;
  readonly observedSnapshotIdA: string;
  readonly observedSnapshotIdB: string;
  readonly resolvedSnapshotIdA: string;
  readonly resolvedSnapshotIdB: string;
  readonly completeness: Completeness;
  readonly classifierVersionA: string;
  readonly classifierVersionB: string;
  readonly interpretationOriginA: "stored" | "recomputed";
  readonly interpretationOriginB: "stored" | "recomputed";
}

/** Machine-readable result of `gatefold compare` (schema v3). */
export interface ComparisonResult {
  readonly schemaVersion: typeof COMPARISON_SCHEMA_VERSION;
  readonly source: { readonly command: "compare" };
  readonly inputs: {
    readonly before: ComparisonExportInput;
    readonly after: ComparisonExportInput;
    readonly diff: ComparisonDiffInput;
  };
  readonly claims: readonly ComparisonClaim[];
}
