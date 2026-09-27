import type {
  EvaluationRunDescriptor,
  RunContextDescriptor,
} from "./evaluation.js";

export const AUDIT_SCHEMA_VERSION = 8;

/**
 * The outcome of one mechanical fact check (docs/v0.8-scope.md). A
 * verification statement about the run's stored records — never a quality
 * judgement, a criterion verdict, or a claim about runtime behavior:
 *
 * - `verified`: the records affirmatively establish the fact.
 * - `inconsistent`: two well-formed records affirmatively contradict each
 *   other, or verified bytes violate the documented shape of their record.
 * - `unverifiable`: the needed record is missing, mismatched, oversized,
 *   truncated past the checkable region, or otherwise uninterpretable.
 * - `not-recorded`: the record the fact audits was never produced.
 */
export type AuditFactState =
  | "verified"
  | "inconsistent"
  | "unverifiable"
  | "not-recorded";

/**
 * How complete the evidence behind a fact is — a separate dimension from
 * `state`, so a matching stored-byte digest never implies a complete change
 * set: `complete` for whole records or a definitive absence, `partial` for
 * truncated or declared-partial records, `unknown` when the record needed
 * to gauge completeness is absent or unverifiable.
 */
export type AuditCompleteness = "complete" | "partial" | "unknown";

/**
 * Which document an audit evidence reference resolves against: the run's
 * `trace.json` or `artifacts.json`, the verified `patch.diff`/`result.txt`
 * bytes (cited by manifest pointer with digest and bounded ranges, as in
 * v6/v7), the verified `baseline-manifest.json`/`changes.json` documents
 * (pointers resolve inside the parsed artifact JSON), or a supplied
 * external check report.
 */
export type AuditEvidenceSource =
  | "trace"
  | "manifest"
  | "patch"
  | "result"
  | "baselineManifest"
  | "changes"
  | "checkReport";

/** An inclusive 1-based line range or half-open 0-based byte range. */
export interface AuditEvidenceRange {
  readonly start: number;
  readonly end: number;
}

/**
 * v8 evidence. Same reference shape as v6/v7: `pointer` is an RFC 6901
 * pointer into the document named by `source`, `digest` repeats a verified
 * stored digest, and `path`/`lines`/`bytes` locate content inside verified
 * artifact bytes.
 */
export interface AuditEvidenceReference {
  readonly source: AuditEvidenceSource;
  readonly pointer: string;
  readonly digest?: string;
  readonly path?: string;
  readonly lines?: AuditEvidenceRange;
  readonly bytes?: AuditEvidenceRange;
  readonly elementId?: string;
  readonly note?: string;
}

export interface AuditProvenance {
  readonly transform: readonly string[];
}

/**
 * One audited fact. `subject` is present only on `check-report.*` facts and
 * names the supplied report's label, keeping per-report facts
 * distinguishable. Facts carry no confidence and no verdict.
 */
export interface AuditFact {
  readonly id: string;
  readonly subject?: string;
  readonly state: AuditFactState;
  readonly completeness: AuditCompleteness;
  /** Why the state is what it is — including why unverifiable/not-recorded. */
  readonly reason: string;
  readonly evidence: readonly AuditEvidenceReference[];
  readonly provenance: AuditProvenance;
}

/** Whether a supplied check report parsed into the v1 report format. */
export type AuditCheckReportState = "parsed" | "invalid";

/** The descriptor of one supplied check report in an audit's `inputs`. */
export interface AuditCheckReportDescriptor {
  readonly label: string;
  readonly document: "check-report";
  readonly evaluatorId: string | null;
  readonly evaluatorVersion?: string;
  readonly state: AuditCheckReportState;
  /** Why the report is `invalid`, when it is. */
  readonly error?: string;
  readonly resultCount: number;
}

/** Machine-readable result of `gatefold audit-run` (schema v8). */
export interface AuditResult {
  readonly schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  readonly source: { readonly command: "audit-run" };
  readonly inputs: {
    readonly run: EvaluationRunDescriptor;
    readonly checkReports: readonly AuditCheckReportDescriptor[];
  };
  readonly context: RunContextDescriptor;
  readonly facts: readonly AuditFact[];
}
