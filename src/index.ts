export { analyze } from "./application/analyze.js";
export { compareDocuments } from "./application/compare.js";
export { compareRuns } from "./application/compare-runs.js";
export { compareTraces } from "./application/compare-traces.js";
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
export {
  RUN_COMPARISON_SCHEMA_VERSION,
  type RunArtifactDescriptor,
  type RunClaim,
  type RunClaimProvenance,
  type RunComparisonResult,
  type RunEvidenceRange,
  type RunEvidenceReference,
  type RunEvidenceSource,
  type RunInputDescriptor,
} from "./domain/run-comparison.js";
export {
  TRACE_COMPARISON_SCHEMA_VERSION,
  type TraceClaim,
  type TraceClaimProvenance,
  type TraceComparisonResult,
  type TraceEvidenceReference,
  type TraceEvidenceSource,
  type TraceInputDescriptor,
} from "./domain/trace-comparison.js";
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
export {
  parsePatchDiff,
  PatchParseError,
  type ParsedPatch,
  type PatchContentLine,
  type PatchFile,
} from "./input/yuurei-patch.js";
export {
  PATCH_ARTIFACT_PATH,
  readYuureiRun,
  type ArtifactState,
  type ManifestEntry,
  type PatchState,
  type YuureiRun,
} from "./input/yuurei-run.js";
export {
  parseYuureiTrace,
  readYuureiTrace,
  readYuureiTraceStdin,
  TRACE_SCHEMA_VERSION,
} from "./input/yuurei-trace.js";
export type {
  YuureiTrace,
  YuureiTraceArtifact,
  YuureiTraceCost,
  YuureiTraceDefinition,
  YuureiTraceExecution,
  YuureiTraceExecutionOptions,
  YuureiTraceIsolation,
  YuureiTraceModel,
  YuureiTraceProfile,
  YuureiTraceRequestedCell,
  YuureiTraceResolvedReason,
  YuureiTraceRuntime,
  YuureiTraceTask,
} from "./input/yuurei-trace.js";
export {
  formatComparisonHuman,
  formatHuman,
  formatRunComparisonHuman,
  formatTraceComparisonHuman,
} from "./output/human.js";
export { formatJson } from "./output/json.js";
