export { analyze } from "./application/analyze.js";
export { compareDocuments } from "./application/compare.js";
export { CLAIM_SCHEMA_VERSION } from "./domain/claim.js";
export {
  COMPARISON_SCHEMA_VERSION,
  type ComparisonClaim,
  type ComparisonDiffInput,
  type ComparisonEvidenceReference,
  type ComparisonEvidenceSource,
  type ComparisonExportInput,
  type ComparisonResult,
} from "./domain/comparison.js";
export type {
  AnalysisResult,
  Claim,
  ClaimProvenance,
  EvidenceReference,
} from "./domain/claim.js";
export {
  isSupportedPflVersion,
  PflExportError,
  parsePflExport,
  readPflExport,
  readPflExportStdin,
  STDIN_SOURCE,
} from "./input/pfl-export.js";
export type {
  Completeness,
  PflDiagnostic,
  PflDiffData,
  PflDiffDocument,
  PflDiffInterpretationSide,
  PflDiffStatusChange,
  PflDocument,
  PflExport,
  PflExportDocument,
  PflExportErrorCode,
  PflFinding,
  PflReportData,
  PflReportDocument,
  PflReportStats,
  PflSnapshotData,
  PflSnapshotElement,
  PflSnapshotInterpretation,
  PflSnapshotObserved,
  PflSnapshotRelation,
  PflSnapshotResolved,
} from "./input/pfl-export.js";
export { formatComparisonHuman, formatHuman } from "./output/human.js";
export { formatJson } from "./output/json.js";
