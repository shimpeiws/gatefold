import { PflExportError } from "./pfl-export.js";
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
import type { YuureiTracePatch, YuureiTraceSeed } from "./yuurei-trace.js";
import type { YuureiTrace } from "./yuurei-trace.js";

/** The artifact path of the durable final result Gatefold interprets. */
export const RESULT_ARTIFACT_PATH = "result.txt";
/** The seeded run's durable baseline record, verified when manifest-listed. */
export const BASELINE_MANIFEST_ARTIFACT_PATH = "baseline-manifest.json";
/** The seeded run's durable change-set record, verified when manifest-listed. */
export const CHANGES_ARTIFACT_PATH = "changes.json";

/**
 * The state of a run's `patch.diff` for v0.7 consumers: the manifest entry's
 * state when listed, `malformed` when verified bytes violate the patch
 * grammar, or `not-recorded` when the manifest lists no patch entry.
 */
export type OutputPatchState = ArtifactState | "malformed" | "not-recorded";

/**
 * The state of a run's `result.txt` for v0.7 consumers
 * (docs/yuurei-seeded-run-contract.md): the manifest entry's state when
 * listed, `not-emitted`/`parse-failed`/`save-failed` from the trace's
 * `result:` diagnostics, or `not-recorded` when nothing records a result.
 */
export type FinalResultState =
  | ArtifactState
  | "not-emitted"
  | "parse-failed"
  | "save-failed"
  | "not-recorded";

/** The fixed result diagnostics the shipped pipeline records (#202). */
export const RESULT_DIAGNOSTIC_STATES: Readonly<
  Record<string, FinalResultState>
> = {
  "result: no final message emitted": "not-emitted",
  "result: final message could not be parsed": "parse-failed",
  "result: save failed; result.txt not recorded": "save-failed",
};

/** The fixed diagnostic recorded when no `patch.diff` was published. */
export const PATCH_FAILURE_DIAGNOSTIC =
  "patch: generation failed; patch.diff not recorded";

/**
 * The counted omission diagnostics the patch builders record
 * (`patch: <n> binary file(s) omitted`, `patch: <n> file(s) omitted over
 * the total cap`, and so on) — evidence that a stored patch is partial.
 */
export const PATCH_OMISSION_DIAGNOSTIC = /^patch: \d+ /;

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
  /** The trace's `patch` completeness record, undefined on older traces. */
  readonly patchRecord: YuureiTracePatch | undefined;
  /** Index into `entries` of the `patch.diff` entry, or null when unlisted. */
  readonly patchEntryIndex: number | null;
  /** Whether the manifest marks the patch entry `truncated`. */
  readonly patchEntryTruncated: boolean;
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
  /**
   * Index into `trace.diagnostics` of the `result:` diagnostic that
   * determines `resultState` when no manifest entry exists, else -1.
   */
  readonly resultDiagnosticIndex: number;
  /**
   * Index into `trace.diagnostics` of the first `patch: <n> …` omission
   * diagnostic, or -1: evidence that the stored patch may be partial on
   * traces that predate the `patch` record.
   */
  readonly patchOmissionIndex: number;
  /**
   * Index into `trace.diagnostics` of the
   * `patch: generation failed; patch.diff not recorded` diagnostic, or -1.
   */
  readonly patchFailureIndex: number;
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
export function legacyPatchToOutput(patch: {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidShape(message: string): PflExportError {
  return new PflExportError("invalid-shape", message);
}

/**
 * Two trace records that cannot both describe the run make the run
 * directory untrustworthy: a `patch.base` of `seeded` without a `seed`
 * record, `empty` with one, a seeded run on pre-seeding requested-cell
 * inputs, or differing requested and materialized baseline digests.
 * Shipped yuurei never produces them — materialization mismatches abort
 * before the trace is written — so they are rejected as malformed input.
 */
function checkSeedConsistency(trace: YuureiTrace): void {
  const seeded = trace.seed !== undefined;
  const patchBase = trace.patch?.base;
  if (patchBase !== undefined && (patchBase === "seeded") !== seeded)
    throw invalidShape(
      `trace.patch.base "${patchBase}" contradicts the trace's ` +
        (seeded ? "seed record" : "absent seed record"),
    );
  const inputsVersion = trace.requestedCell?.inputsVersion;
  if (inputsVersion !== undefined && inputsVersion !== (seeded ? 2 : 1))
    throw invalidShape(
      `requested_cell.inputs_version ${inputsVersion} contradicts the ` +
        `trace's ${seeded ? "seed record" : "absent seed record"}`,
    );
  if (
    seeded &&
    trace.seed!.baseline.requestedDigest !==
      trace.seed!.baseline.materializedDigest
  )
    throw invalidShape(
      "seed.baseline requested_digest differs from materialized_digest",
    );
}

/** Parses verified supplemental-artifact bytes that must be a JSON object. */
function parseArtifactJson(
  content: Buffer,
  path: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw invalidShape(`verified ${path} is not valid JSON`);
  }
  if (!isRecord(value))
    throw invalidShape(`verified ${path} is not a JSON object`);
  return value;
}

function expectField(
  doc: Record<string, unknown>,
  key: string,
  expected: unknown,
  path: string,
): void {
  if (doc[key] !== expected)
    throw invalidShape(
      `verified ${path} field '${key}' does not match the trace's seed record`,
    );
}

/**
 * A verified `baseline-manifest.json` must restate the trace's seed record:
 * the shipped writer builds both from the same resolved seed, so any
 * disagreement is contradictory data.
 */
function checkBaselineManifest(
  doc: Record<string, unknown>,
  seed: YuureiTraceSeed,
): void {
  expectField(doc, "version", 1, BASELINE_MANIFEST_ARTIFACT_PATH);
  expectField(doc, "policy", seed.policy, BASELINE_MANIFEST_ARTIFACT_PATH);
  expectField(doc, "source", seed.source, BASELINE_MANIFEST_ARTIFACT_PATH);
  expectField(doc, "head", seed.head, BASELINE_MANIFEST_ARTIFACT_PATH);
  expectField(
    doc,
    "requested_digest",
    seed.baseline.requestedDigest,
    BASELINE_MANIFEST_ARTIFACT_PATH,
  );
  expectField(
    doc,
    "materialized_digest",
    seed.baseline.materializedDigest,
    BASELINE_MANIFEST_ARTIFACT_PATH,
  );
  if (!isRecord(doc.files))
    throw invalidShape(
      `verified ${BASELINE_MANIFEST_ARTIFACT_PATH} field 'files' is not an object`,
    );
  if (Object.keys(doc.files).length !== seed.baseline.files)
    throw invalidShape(
      `verified ${BASELINE_MANIFEST_ARTIFACT_PATH} file count does not ` +
        "match seed.baseline.files",
    );
}

function stringListField(
  doc: Record<string, unknown>,
  key: string,
  path: string,
): string[] {
  const value = doc[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw invalidShape(
      `verified ${path} field '${key}' is not an array of strings`,
    );
  return value as string[];
}

const CHANGE_KINDS = ["added", "modified", "deleted"] as const;

/**
 * A verified `changes.json` must agree with the trace's seed record and
 * with the parsed patch: shipped yuurei writes `changes.json` only when the
 * collection completed, the trace carries `seed.changes` under exactly the
 * same condition, and the patch is built from that one change set. A
 * `changes` field absent from the trace while a verified `changes.json`
 * exists — or any count, digest, or path-set disagreement — is
 * contradictory data.
 */
function checkChangesManifest(
  doc: Record<string, unknown>,
  seed: YuureiTraceSeed,
  patch: OutputPatch | null,
  patchRecord: YuureiTracePatch | undefined,
): void {
  expectField(doc, "version", 1, CHANGES_ARTIFACT_PATH);
  expectField(
    doc,
    "baseline_digest",
    seed.baseline.requestedDigest,
    CHANGES_ARTIFACT_PATH,
  );
  if (seed.changes === undefined)
    throw invalidShape(
      `verified ${CHANGES_ARTIFACT_PATH} exists but the trace's ` +
        "seed.changes record is absent",
    );
  const changeSets = {} as Record<(typeof CHANGE_KINDS)[number], string[]>;
  for (const kind of CHANGE_KINDS) {
    const paths = stringListField(doc, kind, CHANGES_ARTIFACT_PATH);
    if (paths.length !== seed.changes[kind])
      throw invalidShape(
        `verified ${CHANGES_ARTIFACT_PATH} '${kind}' count does not ` +
          "match seed.changes",
      );
    changeSets[kind] = paths;
  }
  if (patch === null) return;
  // Every patch block is a description of one recorded change, so each
  // parsed path must appear under its recorded kind. Under a `complete`
  // patch record the two sets are exactly equal; under `partial` or on
  // traces without the record, the patch is a subset.
  for (const kind of CHANGE_KINDS) {
    const recorded = new Set(changeSets[kind]);
    const patched = patch.files.filter((file) => file.change === kind);
    for (const file of patched)
      if (!recorded.has(file.path))
        throw invalidShape(
          `patch.diff records a ${kind} change for '${file.path}' that ` +
            `verified ${CHANGES_ARTIFACT_PATH} does not list`,
        );
    if (
      patchRecord?.state === "complete" &&
      patched.length !== changeSets[kind].length
    )
      throw invalidShape(
        `patch.state 'complete' contradicts a ${kind} change set in ` +
          `verified ${CHANGES_ARTIFACT_PATH} that patch.diff does not cover`,
      );
  }
}

/**
 * The trace's seed.changes counts bound what an honest patch can record:
 * more patch blocks of a kind than the trace counts is contradictory, and
 * a `complete` patch record with fewer is a claim the stored bytes do not
 * support. Runs that record no changes can still hold an empty complete
 * patch, which this check leaves untouched.
 */
function checkPatchAgainstSeedChanges(
  patch: OutputPatch | null,
  seed: YuureiTraceSeed,
  patchRecord: YuureiTracePatch | undefined,
): void {
  if (patch === null || seed.changes === undefined) return;
  for (const kind of CHANGE_KINDS) {
    const count = patch.files.filter((file) => file.change === kind).length;
    if (count > seed.changes[kind])
      throw invalidShape(
        `patch.diff records ${count} ${kind} file(s) but ` +
          `seed.changes.${kind} is ${seed.changes[kind]}`,
      );
    if (patchRecord?.state === "complete" && count !== seed.changes[kind])
      throw invalidShape(
        `patch.state 'complete' contradicts seed.changes.${kind} ` +
          `${seed.changes[kind]}: patch.diff covers ${count}`,
      );
  }
}

/**
 * Loads one yuurei run directory for v0.7 evaluation
 * (docs/yuurei-seeded-run-contract.md): the trace (with `seed` and `patch`
 * records when present), the manifest, `patch.diff` parsed with the seeded
 * baseline-relative grammar for a seeded run and the legacy all-additions
 * grammar otherwise, and — on seeded runs — `baseline-manifest.json` and
 * `changes.json` verified and cross-checked against the trace, plus
 * `result.txt` verified and decoded when the manifest lists it. Everything
 * else is never opened.
 */
export async function readEvaluatedRun(dirPath: string): Promise<EvaluatedRun> {
  const loaded = await loadRunDirectory(dirPath);
  const { display, realRunDir, trace, manifestDocument } = loaded;
  const seeded = trace.seed !== undefined;
  const patchRecord = trace.patch;
  checkSeedConsistency(trace);

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
  let patchState: OutputPatchState = "not-recorded";
  let resultBytes: Buffer | null = null;
  let resultText: string | null = null;
  let resultEntryIndex: number | null = null;
  let resultEntryState: ArtifactState | null = null;
  let baselineManifestContent: Buffer | null = null;
  let changesContent: Buffer | null = null;

  // The paths Gatefold verifies and interprets: patch.diff and result.txt
  // on every run, the seeded run's two manifest documents when the trace
  // records a seed. All other entries stay unverified manifest facts.
  const interpretedPaths = seeded
    ? new Set([
        PATCH_ARTIFACT_PATH,
        RESULT_ARTIFACT_PATH,
        BASELINE_MANIFEST_ARTIFACT_PATH,
        CHANGES_ARTIFACT_PATH,
      ])
    : new Set([PATCH_ARTIFACT_PATH, RESULT_ARTIFACT_PATH]);

  for (const entry of loaded.rawEntries) {
    if (!interpretedPaths.has(entry.path)) {
      entries.push({ ...entry, state: "unverified" });
      continue;
    }
    const verified = await verifyArtifactEntry(entry, dirPath, realRunDir);
    let stateRecord: OutputPatchState = verified.state;
    const digestVerified =
      verified.content !== undefined &&
      (verified.state === "verified" ||
        verified.state === "verified-truncated");
    if (entry.path === PATCH_ARTIFACT_PATH) {
      patchEntryIndex = entry.index;
      patchEntryTruncated = entry.truncated;
      if (digestVerified) {
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
          patch = null;
          stateRecord = "malformed";
        }
      }
      patchState = stateRecord;
    } else if (entry.path === RESULT_ARTIFACT_PATH) {
      resultEntryIndex = entry.index;
      resultEntryState = verified.state;
      if (digestVerified) {
        resultBytes = verified.content!;
        // Bytes that do not decode as UTF-8 are uninterpretable: keep the
        // verified state on the entry, but the text stays unavailable.
        resultText =
          verified.state === "verified"
            ? normalizeResultText(verified.content!)
            : null;
      }
    } else if (
      verified.state === "verified" &&
      verified.content !== undefined
    ) {
      // The supplemental manifests are digested whole by yuurei; bytes cut
      // at a size cap cannot be trusted to carry complete records, so only
      // untruncated verified content is cross-checked.
      if (entry.path === BASELINE_MANIFEST_ARTIFACT_PATH)
        baselineManifestContent = verified.content;
      else changesContent = verified.content;
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

  // `patch.state: "absent"` means no patch was published; any other state
  // means one was, and a `complete` record is never a cut one. A
  // generation-failed diagnostic asserts the same absence. Records that
  // disagree with the manifest describe two different runs.
  if (patchRecord !== undefined) {
    if (patchRecord.state === "absent" && patchEntryIndex !== null)
      throw invalidShape(
        "patch.state 'absent' contradicts the manifest's patch.diff entry",
      );
    if (patchRecord.state !== "absent" && patchEntryIndex === null)
      throw invalidShape(
        `patch.state '${patchRecord.state}' contradicts the manifest's ` +
          "absent patch.diff record",
      );
    if (patchRecord.state === "complete" && patchEntryTruncated)
      throw invalidShape(
        "patch.state 'complete' contradicts the manifest's " +
          "truncated record for patch.diff",
      );
    // Shipped yuurei derives `state` from the same omissions the counted
    // diagnostics report, so a `complete` record cannot sit beside them.
    if (patchRecord.state === "complete" && patchOmissionIndex !== -1)
      throw invalidShape(
        "patch.state 'complete' contradicts the trace's patch omission " +
          "diagnostics",
      );
    // A generation failure is what `state: "absent"` records; the
    // diagnostic cannot coexist with any other state.
    if (patchRecord.state !== "absent" && patchFailureIndex !== -1)
      throw invalidShape(
        `patch.state '${patchRecord.state}' contradicts the trace's ` +
          "patch generation-failed diagnostic",
      );
  }
  if (patchFailureIndex !== -1 && patchEntryIndex !== null)
    throw invalidShape(
      "a 'patch: generation failed' diagnostic contradicts the " +
        "manifest's patch.diff entry",
    );

  // Shipped yuurei only produces a patch when the change collection that
  // writes `seed.changes` completed; a published patch over an absent
  // `changes` record cannot be the run this trace describes.
  if (
    seeded &&
    trace.seed!.changes === undefined &&
    patchRecord !== undefined &&
    patchRecord.state !== "absent"
  )
    throw invalidShape(
      `patch.state '${patchRecord.state}' contradicts the trace's ` +
        "absent seed.changes record",
    );

  if (seeded) {
    if (baselineManifestContent !== null)
      checkBaselineManifest(
        parseArtifactJson(
          baselineManifestContent,
          BASELINE_MANIFEST_ARTIFACT_PATH,
        ),
        trace.seed!,
      );
    if (changesContent !== null)
      checkChangesManifest(
        parseArtifactJson(changesContent, CHANGES_ARTIFACT_PATH),
        trace.seed!,
        patch,
        patchRecord,
      );
    checkPatchAgainstSeedChanges(patch, trace.seed!, patchRecord);
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
    resultEntryIndex,
    resultBytes,
    resultText,
    resultState,
    resultDiagnosticIndex,
    patchOmissionIndex,
    patchFailureIndex,
  };
}
