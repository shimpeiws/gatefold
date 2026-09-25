export interface EvidenceReference {
  readonly irRef: string;
  readonly location: string;
}

export interface ClaimProvenance {
  readonly sourceFile: string;
  readonly pflVersion?: string;
  readonly transform: readonly string[];
}

export interface Claim {
  readonly claim: string;
  readonly evidence: readonly EvidenceReference[];
  readonly provenance: ClaimProvenance;
  readonly confidence: number;
}

export interface AnalysisResult {
  readonly claims: readonly Claim[];
}
