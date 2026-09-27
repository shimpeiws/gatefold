import {
  loadRunDirectory,
  PATCH_ARTIFACT_PATH,
  verifyArtifactEntry,
  type ArtifactState,
  type ManifestEntry,
} from "./yuurei-run.js";
import {
  parsePatchDiff,
  PatchParseError,
  type PatchContentLine,
} from "./yuurei-patch.js";
import {
  parseSeededPatchDiff,
  type SeededChangeKind,
} from "./yuurei-seeded-patch.js";
import type { YuureiTrace } from "./yuurei-trace.js";

/** The artifact path of the durable final result Gatefold interprets. */
export const RESULT_ARTIFACT_PATH = "result.txt";

/**
 * The state of a run's `patch.diff` for v0.7 consumers: the manifest entry's
 * state when listed, `malformed` when verified bytes violate the patch
 * grammar, or `not-recorded` when the manifest lists no patch entry.
 */
export type OutputPatchState = ArtifactState | "malformed" | "not-recorded";

/**
 * The state of a run's `result.txt` for v0.7 consumers
 * (docs/yuurei-seeded-run-contract.md): the manifest entry's state when
 * listed, `not-emitted`/`parse-failed` from the trace's `final_result`
 * marker, or `not-recorded` when nothing records a result.
 */
export type FinalResultState =
  | ArtifactState
  | "not-emitted"
  | "parse-failed"
  | "not-recorded";

/** One file recorded by a run's patch, in the unified v0.7 shape. */
export interface OutputFile {
  readonly path: string;
  /**
   * The change the patch records against the seeded baseline. A legacy
   * empty-workspace patch records every file as `added`.
   */
  readonly change: SeededChangeKind;
  /** The `+` content lines across the file's hunks. */
  readonly addedLines: readonly string[];
  /** The `-` content lines across the file's hunks; empty for added files. */
  readonly removedLines: readonly string[];
  /** 1-based line number of the block's `---` header. */
  readonly startLine: number;
  /** 1-based line number of the block's last line. */
  readonly endLine: number;
  /** 0-based byte offset of the block's first byte. */
  readonly byteStart: number;
  /** 0-based byte offset one past the block's last byte. */
  readonly byteEnd: number;
  /** The `+` lines with their stored positions, for evidence ranges. */
  readonly contentLines: readonly PatchContentLine[];
}

/** The parsed patch shared by legacy and seeded runs. */
export interface OutputPatch {
  readonly files: readonly OutputFile[];
  /** False when a truncated patch's stored prefix is all that parsed. */
  readonly complete: boolean;
}

/**
 * A validated run directory for v0.7 evaluation: the parsed trace, the raw
 * manifest document, the manifest entries with their verification states,
 * the unified patch record, and the verified final-result bytes.
 */
export interface EvaluatedRun {
  /** The directory argument, sanitized for display. */
  readonly dirPath: string;
  readonly trace: YuureiTrace;
  readonly manifestDocument: unknown;
  readonly entries: readonly ManifestEntry[];
  /** Whether the trace records seeded-workspace provenance. */
  readonly seeded: boolean;
  /** Index into `entries` of the `patch.diff` entry, or null when unlisted. */
  readonly patchEntryIndex: number | null;
  readonly patch: OutputPatch | null;
  /** Stored patch bytes when the digest verified; null otherwise. */
  readonly patchBytes: Buffer | null;
  readonly patchState: OutputPatchState;
  /** Index into `entries` of the `result.txt` entry, or null when unlisted. */
  readonly resultEntryIndex: number | null;
  /** Stored result bytes when the digest verified; null otherwise. */
  readonly resultBytes: Buffer | null;
  /**
   * The verified result text, normalized per contract (UTF-8, one leading
   * BOM stripped, CRLF→LF); null when unavailable or undecodable.
   */
  readonly resultText: string | null;
  readonly resultState: FinalResultState;
}

/**
 * Normalizes verified `result.txt` bytes per the contract: strict UTF-8
 * decode, one leading U+FEFF stripped, CRLF (and lone CR) normalized to LF.
 * Returns null when the bytes do not decode.
 */
export function normalizeResultText(bytes: Buffer): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Maps a legacy all-additions patch record into the unified output shape. */
function legacyPatchToOutput(patch: {
  files: readonly {
    path: string;
    lines: readonly string[];
    startLine: number;
    endLine: number;
    byteStart: number;
    byteEnd: number;
    contentLines: readonly PatchContentLine[];
  }[];
  complete: boolean;
}): OutputPatch {
  return {
    complete: patch.complete,
    files: patch.files.map((file) => ({
      path: file.path,
      change: "added" as const,
      addedLines: file.lines,
      removedLines: [],
      startLine: file.startLine,
      endLine: file.endLine,
      byteStart: file.byteStart,
      byteEnd: file.byteEnd,
      contentLines: file.contentLines,
    })),
  };
}

/**
 * Loads one yuurei run directory for v0.7 evaluation
 * (docs/yuurei-seeded-run-contract.md): the trace (with `baseline` and
 * `final_result` when recorded), the manifest, `patch.diff` parsed with the
 * seeded baseline-relative grammar for a seeded run and the legacy
 * all-additions grammar otherwise, and `result.txt` verified and decoded
 * when the manifest lists it. Everything else is never opened.
 */
export async function readEvaluatedRun(dirPath: string): Promise<EvaluatedRun> {
  const loaded = await loadRunDirectory(dirPath);
  const { display, realRunDir, trace, manifestDocument } = loaded;
  const seeded = trace.baseline !== undefined;

  const entries: ManifestEntry[] = [];
  let patch: OutputPatch | null = null;
  let patchBytes: Buffer | null = null;
  let patchEntryIndex: number | null = null;
  let patchState: OutputPatchState = "not-recorded";
  let resultBytes: Buffer | null = null;
  let resultText: string | null = null;
  let resultEntryIndex: number | null = null;
  let resultEntryState: ArtifactState | null = null;

  for (const entry of loaded.rawEntries) {
    if (
      entry.path !== PATCH_ARTIFACT_PATH &&
      entry.path !== RESULT_ARTIFACT_PATH
    ) {
      entries.push({ ...entry, state: "unverified" });
      continue;
    }
    const verified = await verifyArtifactEntry(entry, dirPath, realRunDir);
    let stateRecord: OutputPatchState = verified.state;
    if (
      entry.path === PATCH_ARTIFACT_PATH &&
      verified.content !== undefined &&
      (verified.state === "verified" || verified.state === "verified-truncated")
    ) {
      patchBytes = verified.content;
      try {
        patch = seeded
          ? parseSeededPatchDiff(verified.content, {
              allowTruncatedTail: entry.truncated,
            })
          : legacyPatchToOutput(
              parsePatchDiff(verified.content, {
                allowTruncatedTail: entry.truncated,
              }),
            );
      } catch (error) {
        if (!(error instanceof PatchParseError)) throw error;
        patch = null;
        stateRecord = "malformed";
      }
    }
    if (entry.path === PATCH_ARTIFACT_PATH) {
      patchEntryIndex = entry.index;
      patchState = stateRecord;
    } else {
      resultEntryIndex = entry.index;
      resultEntryState = verified.state;
      if (
        verified.content !== undefined &&
        (verified.state === "verified" ||
          verified.state === "verified-truncated")
      ) {
        resultBytes = verified.content;
        // Bytes that do not decode as UTF-8 are uninterpretable: keep the
        // verified state on the entry, but the text stays unavailable.
        resultText =
          verified.state === "verified"
            ? normalizeResultText(verified.content)
            : null;
      }
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
      : trace.finalResult === undefined
        ? "not-recorded"
        : trace.finalResult.status === "recorded"
          ? "missing"
          : trace.finalResult.status === "not_emitted"
            ? "not-emitted"
            : "parse-failed";

  return {
    dirPath: display,
    trace,
    manifestDocument,
    entries,
    seeded,
    patchEntryIndex,
    patch,
    patchBytes,
    patchState,
    resultEntryIndex,
    resultBytes,
    resultText,
    resultState,
  };
}
