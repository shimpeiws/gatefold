export { analyze } from "./application/analyze.js";
export { CLAIM_SCHEMA_VERSION } from "./domain/claim.js";
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
  PflExport,
  PflExportErrorCode,
  PflFinding,
  PflReportData,
  PflReportStats,
} from "./input/pfl-export.js";
export { formatHuman } from "./output/human.js";
export { formatJson } from "./output/json.js";
