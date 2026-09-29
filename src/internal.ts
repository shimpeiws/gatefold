/**
 * Explicitly unstable package surface (`@shimpeiws/gatefold/internal`):
 * helper exports that callers may need to assemble advanced pipelines —
 * low-level document validators, patch parsers, artifact-path constants,
 * and the deprecated evaluate-run internals. These names are supported
 * intent, not frozen signatures: they may change in any release without
 * a schema bump and are not covered by the 1.0 SemVer promise that the
 * `.` export and the `./schema/*` files carry.
 */
export {
  bindCheckReport,
  loadCheckReports,
  type BoundCheckReport,
  type BoundVerdict,
  type LoadedCheckReport,
} from "./application/check-report-binding.js";
export {
  AFTER_SOURCES,
  BEFORE_SOURCES,
  evaluateCriterion,
  SINGLE_SOURCES,
  type SideSources,
} from "./application/evaluate-run.js";
export { parseCheckReport } from "./input/check-report.js";
export { parsePflExport } from "./input/pfl-export.js";
export { parseTaskSpec } from "./input/task-spec.js";
export { parseYuureiTrace } from "./input/yuurei-trace.js";
export {
  parsePatchDiff,
  PatchParseError,
  type ParsedPatch,
  type PatchContentLine,
  type PatchFile,
} from "./input/yuurei-patch.js";
export {
  parseSeededPatchDiff,
  type ParsedSeededPatch,
  type SeededChangeKind,
  type SeededPatchContentLine,
  type SeededPatchFile,
} from "./input/yuurei-seeded-patch.js";
export { PATCH_ARTIFACT_PATH } from "./input/yuurei-run.js";
export { OBSERVATION_EXPORT_PATH } from "./input/yuurei-cell.js";
export {
  BASELINE_MANIFEST_ARTIFACT_PATH,
  CHANGES_ARTIFACT_PATH,
  normalizeResultText,
  RESULT_ARTIFACT_PATH,
} from "./input/yuurei-seeded-run.js";
