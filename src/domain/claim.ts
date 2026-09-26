export const CLAIM_SCHEMA_VERSION = 2;

export interface EvidenceReference {
  readonly pointer: string;
  readonly elementId?: string;
  readonly note?: string;
}

export interface ClaimProvenance {
  readonly sourceFile: string;
  readonly exportVersion?: string;
  readonly transform: readonly string[];
  readonly classifierVersion?: string;
  readonly interpretationOrigin?: string;
  readonly observedSnapshotId?: string;
  readonly resolvedSnapshotId?: string;
  readonly runtimeName?: string;
}

export interface Claim {
  readonly claim: string;
  readonly ruleId: string;
  readonly evidence: readonly EvidenceReference[];
  readonly provenance: ClaimProvenance;
  readonly confidence: number;
}

export interface AnalysisResult {
  readonly schemaVersion: typeof CLAIM_SCHEMA_VERSION;
  /** Identifies which input document produced this result (v0.3). */
  readonly source: {
    readonly pflVersion: string;
    readonly command: "report" | "export";
  };
  readonly claims: readonly Claim[];
}
