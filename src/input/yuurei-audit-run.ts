import {
  loadRunDirectory,
  PATCH_ARTIFACT_PATH,
  verifyArtifactEntry,
  type ArtifactState,
  type ManifestEntry,
} from "./yuurei-run.js";
import { parsePatchDiff, PatchParseError } from "./yuurei-patch.js";
import { parseSeededPatchDiff } from "./yuurei-seeded-patch.js";
import {
  BASELINE_MANIFEST_ARTIFACT_PATH,
  CHANGES_ARTIFACT_PATH,
  legacyPatchToOutput,
  normalizeResultText,
  PATCH_FAILURE_DIAGNOSTIC,
  PATCH_OMISSION_DIAGNOSTIC,
  RESULT_ARTIFACT_PATH,
  RESULT_DIAGNOSTIC_STATES,
  type EvaluatedRun,
  type FinalResultState,
  type OutputPatch,
  type OutputPatchState,
} from "./yuurei-seeded-run.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One manifest-listed supplemental record (`baseline-manifest.json` or
 * `changes.json`) as the audit needs it: the manifest entry's verification
 * state, its digest-verified stored bytes, and — only for untruncated
 * verified bytes — the parsed JSON document. Verified bytes cut at a size
 * cap can never carry a trusted complete record, so they are captured for
 * integrity facts but never parsed.
 */
export interface AuditedArtifactRecord {
  /** Index into the run's `entries`, or null when the manifest lists none. */
  readonly entryIndex: number | null;
  /** The entry's verification state, or `not-recorded` when unlisted. */
  readonly state: ArtifactState | "not-recorded";
  /** The manifest-recorded digest when listed, else null. */
  readonly digest: string | null;
  readonly truncated: boolean;
  /** Stored byte count when the file was examined. */
  readonly bytes?: number;
  /** The digest-verified stored bytes (untruncated or cut), else null. */
  readonly content: Buffer | null;
  /**
   * The parsed JSON object — only when the stored bytes verify
   * untruncated and decode to a JSON object; null otherwise.
   */
  readonly document: Record<string, unknown> | null;
  /** Why `document` is null despite verified untruncated bytes. */
  readonly documentError: string | null;
}

const EMPTY_RECORD: AuditedArtifactRecord = {
  entryIndex: null,
  state: "not-recorded",
  digest: null,
  truncated: false,
  content: null,
  document: null,
  documentError: null,
};

/**
 * A run directory normalized for auditing (docs/v0.8-scope.md): everything
 * `EvaluatedRun` carries, plus the parsed seeded supplemental records and
 * the flags a strict reader would have turned into rejections. Here a
 * bounded contradiction between two well-formed records — a `patch.base`
 * disagreeing with `seed`, a `patch.state` disagreeing with the manifest —
 * is preserved as data for the audit's `inconsistent` facts; only
 * violations that make the input untrustworthy to *read* still reject.
 */
export interface AuditedRun extends EvaluatedRun {
  /**
   * True when the trace's `patch.base` record contradicts the `seed`
   * record's presence: no single patch grammar then applies, so the stored
   * bytes are verified but never parsed.
   */
  readonly patchGrammarAmbiguous: boolean;
  /** True when verified patch bytes failed the run's patch grammar. */
  readonly patchMalformed: boolean;
  readonly baselineManifest: AuditedArtifactRecord;
  readonly changes: AuditedArtifactRecord;
  /**
   * Additional manifest-listed records the caller asked to be verified
   * and parsed (v0.9: the observation export path the trace declares),
   * keyed by artifact path. Empty when none were requested. An
   * interpreted-but-failed entry (missing, digest mismatch) still appears
   * here with its state so the caller can report it; a path the manifest
   * does not list is absent entirely.
   */
  readonly extraRecords: ReadonlyMap<string, AuditedArtifactRecord>;
}

/** Parses verified supplemental-record bytes into a JSON object. */
function parseRecordDocument(
  content: Buffer,
  path: string,
):
  | { document: Record<string, unknown>; documentError: null }
  | {
      document: null;
      documentError: string;
    } {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    return {
      document: null,
      documentError: `verified ${path} is not valid JSON`,
    };
  }
  if (!isRecord(value))
    return {
      document: null,
      documentError: `verified ${path} is not a JSON object`,
    };
  return { document: value, documentError: null };
}

/**
 * Loads one yuurei run directory for auditing: the trace, the manifest, and
 * each record the contract binds to the audit — `patch.diff`, `result.txt`,
 * and on a seeded run `baseline-manifest.json` and `changes.json` — with
 * every entry's verification state preserved and the supplemental documents
 * parsed when their bytes verify untruncated. Unlike `readEvaluatedRun`,
 * cross-record contradictions are *not* rejected here: the audit reports
 * them. Structural violations (unreadable or malformed documents,
 * unconfined paths, symlink escapes, size limits) still fail closed inside
 * the shared readers.
 */
export interface ReadAuditedRunOptions {
  /**
   * Manifest paths beyond the built-in audit set that should also be
   * verified and parsed into `extraRecords`. Paths must come from the
   * caller's own contract (for v0.9, the paths the trace's observation
   * record declares); paths the manifest does not list are silently
   * absent from `extraRecords` — presence there, not request, is what
   * makes bytes reachable.
   */
  /**
   * Additional artifact paths to interpret, either fixed or derived from
   * the parsed trace. The function form lets a caller interpret a path
   * only when the run's own records declare it, so an undeclared
   * manifest entry is never opened (and so cannot fail the run).
   */
  readonly extraInterpretedPaths?:
    | readonly string[]
    | ((trace: EvaluatedRun["trace"]) => readonly string[]);
}

export async function readAuditedRun(
  dirPath: string,
  options: ReadAuditedRunOptions = {},
): Promise<AuditedRun> {
  const loaded = await loadRunDirectory(dirPath);
  const { display, realRunDir, trace, manifestDocument } = loaded;
  const seeded = trace.seed !== undefined;
  const patchRecord = trace.patch;
  // `patch.base` declares which grammar the stored diff was written in. A
  // record contradicting the seed leaves that ambiguous: the bytes still
  // verify, but no interpretation is trusted.
  const patchGrammarAmbiguous =
    patchRecord !== undefined && (patchRecord.base === "seeded") !== seeded;

  const diagnostics = trace.diagnostics;
  const resultDiagnosticIndex = diagnostics.findIndex((item) =>
    Object.hasOwn(RESULT_DIAGNOSTIC_STATES, item),
  );
  const patchOmissionIndex = diagnostics.findIndex((item) =>
    PATCH_OMISSION_DIAGNOSTIC.test(item),
  );
  const patchFailureIndex = diagnostics.indexOf(PATCH_FAILURE_DIAGNOSTIC);

  const entries: ManifestEntry[] = [];
  let patch: OutputPatch | null = null;
  let patchBytes: Buffer | null = null;
  let patchEntryIndex: number | null = null;
  let patchEntryTruncated = false;
  let patchMalformed = false;
  let patchState: OutputPatchState = "not-recorded";
  let resultBytes: Buffer | null = null;
  let resultText: string | null = null;
  let resultEntryIndex: number | null = null;
  let resultEntryState: ArtifactState | null = null;
  let baselineManifest = EMPTY_RECORD;
  let changes = EMPTY_RECORD;
  const extraRecords = new Map<string, AuditedArtifactRecord>();

  // The records the audit interprets: patch.diff and result.txt on every
  // run, plus the seeded run's two supplemental records, plus any extra
  // paths the caller declared. Everything else stays an unverified
  // manifest fact and is never opened.
  const interpretedPaths = new Set([
    PATCH_ARTIFACT_PATH,
    RESULT_ARTIFACT_PATH,
    ...(seeded ? [BASELINE_MANIFEST_ARTIFACT_PATH, CHANGES_ARTIFACT_PATH] : []),
    ...(typeof options.extraInterpretedPaths === "function"
      ? options.extraInterpretedPaths(trace)
      : (options.extraInterpretedPaths ?? [])),
  ]);

  for (const entry of loaded.rawEntries) {
    if (!interpretedPaths.has(entry.path)) {
      entries.push({ ...entry, state: "unverified" });
      continue;
    }
    const verified = await verifyArtifactEntry(entry, dirPath, realRunDir);
    const digestVerified =
      verified.content !== undefined &&
      (verified.state === "verified" ||
        verified.state === "verified-truncated");
    let stateRecord: OutputPatchState = verified.state;
    if (entry.path === PATCH_ARTIFACT_PATH) {
      patchEntryIndex = entry.index;
      patchEntryTruncated = entry.truncated;
      if (digestVerified && !patchGrammarAmbiguous) {
        patchBytes = verified.content!;
        try {
          patch = seeded
            ? parseSeededPatchDiff(verified.content!, {
                allowTruncatedTail: entry.truncated,
              })
            : legacyPatchToOutput(
                parsePatchDiff(verified.content!, {
                  allowTruncatedTail: entry.truncated,
                }),
              );
        } catch (error) {
          if (!(error instanceof PatchParseError)) throw error;
          patchMalformed = true;
          stateRecord = "malformed";
        }
      }
      patchState = stateRecord;
    } else if (entry.path === RESULT_ARTIFACT_PATH) {
      resultEntryIndex = entry.index;
      resultEntryState = verified.state;
      if (digestVerified) {
        resultBytes = verified.content!;
        // A truncated result is still decodable data about the stored
        // prefix; the audit records the decode on both verified states.
        resultText = normalizeResultText(verified.content!);
      }
    } else {
      // Supplemental records are interpreted only on seeded runs; a listed
      // record on a legacy run stays an unverified manifest fact.
      const digest = entry.digest.length > 0 ? entry.digest : null;
      let document: Record<string, unknown> | null = null;
      let documentError: string | null = null;
      if (verified.state === "verified" && verified.content !== undefined) {
        const parsed = parseRecordDocument(verified.content, entry.path);
        document = parsed.document;
        documentError = parsed.documentError;
      }
      const record: AuditedArtifactRecord = {
        entryIndex: entry.index,
        state: verified.state,
        digest,
        truncated: entry.truncated,
        ...(verified.bytes === undefined ? {} : { bytes: verified.bytes }),
        content: digestVerified ? verified.content! : null,
        document,
        documentError,
      };
      if (entry.path === BASELINE_MANIFEST_ARTIFACT_PATH)
        baselineManifest = record;
      else if (entry.path === CHANGES_ARTIFACT_PATH) changes = record;
      else extraRecords.set(entry.path, record);
    }
    entries.push({
      index: entry.index,
      path: entry.path,
      kind: entry.kind,
      digest: entry.digest,
      truncated: entry.truncated,
      state: verified.state,
      ...(verified.bytes === undefined ? {} : { bytes: verified.bytes }),
    });
  }

  const resultState: FinalResultState =
    resultEntryState !== null
      ? resultEntryState
      : resultDiagnosticIndex !== -1
        ? RESULT_DIAGNOSTIC_STATES[diagnostics[resultDiagnosticIndex]]
        : "not-recorded";

  return {
    dirPath: display,
    trace,
    manifestDocument,
    entries,
    seeded,
    patchRecord,
    patchEntryIndex,
    patchEntryTruncated,
    patch,
    patchBytes,
    patchState,
    patchGrammarAmbiguous,
    patchMalformed,
    resultEntryIndex,
    resultBytes,
    resultText,
    resultState,
    baselineManifest,
    changes,
    extraRecords,
    resultDiagnosticIndex,
    patchOmissionIndex,
    patchFailureIndex,
  };
}
