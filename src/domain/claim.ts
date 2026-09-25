export const CLAIM_SCHEMA_VERSION = 1;

export interface EvidenceReference {
  readonly pointer: string;
  readonly elementId?: string;
  readonly note?: string;
}

export interface ClaimProvenance {
  readonly sourceFile: string;
  readonly exportVersion?: string;
  readonly transform: readonly string[];
}

export interface Claim {
  readonly claim: string;
  readonly evidence: readonly EvidenceReference[];
  readonly provenance: ClaimProvenance;
  readonly confidence: number;
}

export interface AnalysisResult {
  readonly schemaVersion: typeof CLAIM_SCHEMA_VERSION;
  readonly claims: readonly Claim[];
}
