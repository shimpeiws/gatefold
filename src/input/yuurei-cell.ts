import {
  readAuditedRun,
  type AuditedArtifactRecord,
  type AuditedRun,
} from "./yuurei-audit-run.js";
import {
  parsePflExport,
  PflExportError,
  type PflExportDocument,
} from "./pfl-export.js";
import { isConfinedArtifactPath } from "./yuurei-run.js";
import type { YuureiObservation } from "./yuurei-trace.js";

/**
 * The fixed artifact path the run's own `observation` record declares for
 * the pfl export (docs/v0.9-scope.md). It is the only path the shipped
 * observer records; any other declared observation path is a reportable
 * fact, never interpreted as the export. The path is resolved only
 * through the manifest: a listed entry supplies the digest the retained
 * bytes must match.
 */
export const OBSERVATION_EXPORT_PATH = "observation/export.json";

/**
 * Why a digest-verified export artifact could not be interpreted as a
 * conforming `pfl export` document. `failure-document`: `ok: false`;
 * `unsupported-version`: a pfl envelope outside the supported range;
 * `wrong-command`: a valid pfl document of another command kind;
 * `malformed`: the bytes are not a valid pfl export document at all.
 */
export type ExportInterpretationIssue =
  | "failure-document"
  | "unsupported-version"
  | "wrong-command"
  | "malformed";

/**
 * What the run's observation record declares and what the manifest
 * retained of it. `exportRecord` is null when the manifest does not list
 * the declared export path; `exportDocument` is non-null only when
 * untruncated digest-verified bytes parse as a conforming export.
 */
export interface CellObservation {
  /** The trace's `observation` record — undefined means not recorded. */
  readonly record: YuureiObservation | undefined;
  /** Whether the record declares the fixed export path. */
  readonly exportDeclared: boolean;
  /** Manifest state of the export artifact, or null when unlisted. */
  readonly exportRecord: AuditedArtifactRecord | null;
  /** Declared confined paths other than the export — reported, never opened. */
  readonly otherDeclaredPaths: readonly string[];
  /** Declared paths failing lexical confinement — reported, never resolved. */
  readonly unsafeDeclaredPaths: readonly string[];
  /** The typed export document when the verified bytes parse. */
  readonly exportDocument: PflExportDocument | null;
  /** Why `exportDocument` is null despite verified untruncated bytes. */
  readonly exportIssue: ExportInterpretationIssue | null;
  /** The detail message paired with `exportIssue`. */
  readonly exportIssueDetail: string | null;
}

/** One cell input: the audited run plus its resolved observation lane. */
export interface CellRun {
  /** The run directory argument, sanitized for display. */
  readonly label: string;
  readonly run: AuditedRun;
  readonly observation: CellObservation;
}

/**
 * Loads one cell: the audit-level run records plus the observation export
 * the trace declares. Only a declared export is interpreted: when the
 * trace records no `observation`, or its record does not declare the
 * fixed path, the manifest-listed entry is neither opened nor verified —
 * it stays a reportable manifest fact and a `record-consistency`
 * contradiction, so a broken artifact at that path cannot fail the whole
 * report. Only the fixed contract path is ever opened, and only for a run
 * whose own record declares it; other declared observation paths are
 * classified for the report without touching their bytes.
 */
export async function readCellRun(dirPath: string): Promise<CellRun> {
  const run = await readAuditedRun(dirPath, {
    // Only an export the run's own observation record declares is
    // interpreted: an undeclared manifest entry is never opened, so a
    // broken or escaping artifact cannot fail the report and cannot be
    // mistaken for this run's observed configuration.
    extraInterpretedPaths: (trace) =>
      (trace.observation?.artifacts ?? []).some(
        (artifact) => artifact.path === OBSERVATION_EXPORT_PATH,
      )
        ? [OBSERVATION_EXPORT_PATH]
        : [],
  });
  const record = run.trace.observation;
  const declared = record?.artifacts ?? [];
  const exportDeclared = declared.some(
    (entry) => entry.path === OBSERVATION_EXPORT_PATH,
  );
  const unsafeDeclaredPaths = declared
    .filter((entry) => !isConfinedArtifactPath(entry.path))
    .map((entry) => entry.path);
  const otherDeclaredPaths = declared
    .filter(
      (entry) =>
        entry.path !== OBSERVATION_EXPORT_PATH &&
        isConfinedArtifactPath(entry.path),
    )
    .map((entry) => entry.path);

  const exportRecord = run.extraRecords.get(OBSERVATION_EXPORT_PATH) ?? null;
  let exportDocument: PflExportDocument | null = null;
  let exportIssue: ExportInterpretationIssue | null = null;
  let exportIssueDetail: string | null = null;
  if (exportRecord !== null && exportRecord.document !== null) {
    try {
      const parsed = parsePflExport(
        exportRecord.document,
        `artifact ${OBSERVATION_EXPORT_PATH}`,
      );
      if (parsed.command !== "export") {
        exportIssue = "wrong-command";
        exportIssueDetail = `the artifact is a pfl '${parsed.command}' document, not an export`;
      } else {
        exportDocument = parsed;
      }
    } catch (error) {
      if (!(error instanceof PflExportError)) throw error;
      exportIssueDetail = error.message;
      exportIssue =
        error.code === "export-failed"
          ? "failure-document"
          : error.code === "unsupported-version"
            ? "unsupported-version"
            : error.code === "unsupported-command"
              ? "wrong-command"
              : "malformed";
    }
  } else if (exportRecord !== null && exportRecord.documentError !== null) {
    exportIssue = "malformed";
    exportIssueDetail = exportRecord.documentError;
  }

  return {
    label: run.dirPath,
    run,
    observation: {
      record,
      exportDeclared,
      exportRecord,
      otherDeclaredPaths,
      unsafeDeclaredPaths,
      exportDocument,
      exportIssue,
      exportIssueDetail,
    },
  };
}
