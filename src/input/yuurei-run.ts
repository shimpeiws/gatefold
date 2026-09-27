import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { sanitizeText } from "../domain/sanitize.js";
import { InputTooLargeError, MAX_INPUT_BYTES, readBounded } from "./bounded.js";
import { PflExportError } from "./pfl-export.js";
import { readYuureiTrace, type YuureiTrace } from "./yuurei-trace.js";
import {
  parsePatchDiff,
  PatchParseError,
  type ParsedPatch,
} from "./yuurei-patch.js";

/** The one artifact path whose bytes Gatefold reads and interprets. */
export const PATCH_ARTIFACT_PATH = "patch.diff";

/** Manifest scalar strings are bounded like trace scalar strings. */
const MAX_SCALAR_CHARS = 4_096;
const MAX_MANIFEST_ENTRIES = 10_000;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The verification outcome of one manifest entry
 * (docs/yuurei-run-contract.md). Only `verified` and `verified-truncated`
 * patch bytes are ever interpreted; every other state means the recorded
 * content cannot be trusted as what yuurei stored and contributes manifest
 * facts only.
 */
export type ArtifactState =
  | "verified"
  | "verified-truncated"
  | "digest-mismatch"
  | "missing"
  | "unverified";

/**
 * The state of a run's `patch.diff` for consumers: the manifest entry's
 * state when listed, `malformed` when verified bytes violate the patch
 * grammar, or `not-recorded` when the manifest lists no patch entry.
 */
export type PatchState = ArtifactState | "malformed" | "not-recorded";

export interface ManifestEntry {
  /** Position of the entry in the manifest's `artifacts` array. */
  readonly index: number;
  readonly path: string;
  readonly kind: string;
  readonly digest: string;
  readonly truncated: boolean;
  readonly state: ArtifactState;
  /** Stored byte count when the file was examined; absent when not read. */
  readonly bytes?: number;
}

/**
 * A validated yuurei run directory: the parsed trace, the raw manifest
 * document (the evidence source manifest pointers resolve against), the
 * manifest entries with their verification states, and — when the recorded
 * `patch.diff` verifies — its parsed blocks and stored bytes.
 */
export interface YuureiRun {
  /** The directory argument, sanitized for display. */
  readonly dirPath: string;
  readonly trace: YuureiTrace;
  readonly manifestDocument: unknown;
  readonly entries: readonly ManifestEntry[];
  /** Index into `entries` of the `patch.diff` entry, or null when unlisted. */
  readonly patchEntryIndex: number | null;
  readonly patch: ParsedPatch | null;
  /** Stored patch bytes when the digest verified; null otherwise. */
  readonly patchBytes: Buffer | null;
  readonly patchState: PatchState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shapeError(message: string): PflExportError {
  return new PflExportError("invalid-shape", message);
}

function manifestShapeError(field: string, expected: string): PflExportError {
  return shapeError(`artifacts.json field ${field} must be ${expected}`);
}

function manifestString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = record[key];
  if (typeof value !== "string") throw manifestShapeError(path, "a string");
  if (value.length > MAX_SCALAR_CHARS)
    throw manifestShapeError(
      path,
      `a string of at most ${MAX_SCALAR_CHARS} characters`,
    );
  return value;
}

/**
 * Enforces path confinement lexically: a manifest path must be a relative
 * POSIX path with no empty, `.`, or `..` components, no NUL, and no absolute
 * or drive-letter form. A violation rejects the run directory — a manifest
 * that names outside locations is not a trustworthy run description.
 */
function assertConfinedPath(path: string, at: string): void {
  const reason =
    "a relative path confined to the run directory (no empty, '.', or '..'" +
    " components, no NUL, not absolute)";
  const invalid = () =>
    shapeError(`artifacts.json field ${at} must be ${reason}`);
  if (path.length === 0) throw invalid();
  if (path.startsWith("/") || path.startsWith("\\")) throw invalid();
  if (/^[A-Za-z]:/.test(path)) throw invalid();
  if (path.includes("\0")) throw invalid();
  for (const part of path.split("/"))
    if (part === "" || part === "." || part === "..") throw invalid();
}

interface RawEntry {
  readonly index: number;
  readonly path: string;
  readonly kind: string;
  readonly digest: string;
  readonly truncated: boolean;
}

/** Validates the parsed manifest object into raw entries. */
function parseManifest(value: unknown): RawEntry[] {
  if (!isRecord(value))
    throw shapeError("artifacts.json must contain an object at the top level");
  const artifacts = value.artifacts;
  if (!Array.isArray(artifacts))
    throw manifestShapeError("artifacts", "an array");
  if (artifacts.length > MAX_MANIFEST_ENTRIES)
    throw manifestShapeError(
      "artifacts",
      `an array with at most ${MAX_MANIFEST_ENTRIES} items`,
    );
  const seenPaths = new Set<string>();
  return artifacts.map((item, index) => {
    const at = `artifacts[${index}]`;
    if (!isRecord(item)) throw manifestShapeError(at, "an object");
    const path = manifestString(item, "path", `${at}.path`);
    assertConfinedPath(path, `${at}.path`);
    // yuurei's collector records each artifact path once, so a repeated
    // path is contradictory manifest data — not an ordering to pick from.
    if (seenPaths.has(path))
      throw manifestShapeError(
        `${at}.path`,
        "unique within the artifacts array",
      );
    seenPaths.add(path);
    const truncated = item.truncated;
    if (truncated !== undefined && typeof truncated !== "boolean")
      throw manifestShapeError(`${at}.truncated`, "a boolean when present");
    return {
      index,
      path,
      kind: manifestString(item, "kind", `${at}.kind`),
      digest: manifestString(item, "digest", `${at}.digest`),
      truncated: truncated === true,
    };
  });
}

/**
 * Reads and verifies one `patch.diff` entry: resolves the path inside the
 * run directory (rejecting symlink escapes and non-regular targets), reads
 * the bytes under the shared ceiling, and compares their sha256 digest with
 * the manifest's record.
 */
async function verifyPatchEntry(
  entry: RawEntry,
  runDir: string,
  realRunDir: string,
): Promise<{ state: ArtifactState; bytes?: number; content?: Buffer }> {
  const at = `artifacts[${entry.index}]`;
  const fullPath = join(runDir, entry.path);
  let real: string;
  try {
    real = await realpath(fullPath);
  } catch {
    // A listed entry with nothing readable at its path (including a broken
    // symlink) is recorded missing; the manifest fact is preserved.
    return { state: "missing" };
  }
  if (real !== realRunDir && !real.startsWith(realRunDir + sep))
    throw shapeError(
      `artifacts.json field ${at}.path resolves outside the run directory`,
    );
  if (!SHA256_DIGEST.test(entry.digest)) return { state: "unverified" };

  let info;
  try {
    info = await stat(real);
  } catch {
    return { state: "missing" };
  }
  if (!info.isFile())
    throw shapeError(
      `artifacts.json field ${at}.path does not name a regular file`,
    );
  if (info.size > MAX_INPUT_BYTES)
    return { state: "unverified", bytes: info.size };

  let content: Buffer;
  try {
    content = await readBounded(real);
  } catch (error) {
    if (error instanceof InputTooLargeError)
      return { state: "unverified", bytes: info.size };
    return { state: "unverified" };
  }

  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (digest !== entry.digest)
    return { state: "digest-mismatch", bytes: content.length };
  return {
    state: entry.truncated ? "verified-truncated" : "verified",
    bytes: content.length,
    content,
  };
}

/**
 * Loads one yuurei run directory: the trace (per the trace contract), the
 * artifact manifest, and — when the manifest lists `patch.diff` with a
 * verifiable digest — the verified patch bytes parsed per the run-directory
 * contract. Everything else in the directory is never opened.
 */
export async function readYuureiRun(dirPath: string): Promise<YuureiRun> {
  const display = sanitizeText(dirPath);
  let dirInfo;
  try {
    dirInfo = await stat(dirPath);
  } catch {
    throw new PflExportError(
      "unreadable-file",
      `cannot read run directory: ${dirPath}`,
    );
  }
  if (!dirInfo.isDirectory())
    throw new PflExportError(
      "unreadable-file",
      `run directory is not a directory: ${dirPath}`,
    );
  const realRunDir = await realpath(dirPath);

  const trace = await readYuureiTrace(join(dirPath, "trace.json"));

  let manifestText: string;
  const manifestPath = join(dirPath, "artifacts.json");
  try {
    manifestText = (await readBounded(manifestPath)).toString("utf8");
  } catch (error) {
    if (error instanceof InputTooLargeError)
      throw new PflExportError(
        "invalid-shape",
        `artifact manifest exceeds the ${MAX_INPUT_BYTES}-byte limit: ${manifestPath}`,
      );
    throw new PflExportError(
      "unreadable-file",
      `cannot read artifact manifest: ${manifestPath}`,
    );
  }
  const manifestJson =
    manifestText.charCodeAt(0) === 0xfeff
      ? manifestText.slice(1)
      : manifestText;
  let manifestDocument: unknown;
  try {
    manifestDocument = JSON.parse(manifestJson);
  } catch {
    throw new PflExportError(
      "invalid-json",
      `artifact manifest is not valid JSON: ${manifestPath}`,
    );
  }

  const raw = parseManifest(manifestDocument);
  const entries: ManifestEntry[] = [];
  let patch: ParsedPatch | null = null;
  let patchBytes: Buffer | null = null;
  let patchEntryIndex: number | null = null;
  let patchState: PatchState = "not-recorded";

  for (const entry of raw) {
    if (entry.path !== PATCH_ARTIFACT_PATH) {
      entries.push({ ...entry, state: "unverified" });
      continue;
    }
    patchEntryIndex = entry.index;
    const verified = await verifyPatchEntry(entry, dirPath, realRunDir);
    const state = verified.state;
    let stateRecord: PatchState = state;
    if (
      verified.content !== undefined &&
      (state === "verified" || state === "verified-truncated")
    ) {
      try {
        patch = parsePatchDiff(verified.content, {
          allowTruncatedTail: entry.truncated,
        });
        patchBytes = verified.content;
      } catch (error) {
        if (!(error instanceof PatchParseError)) throw error;
        patch = null;
        patchBytes = verified.content;
        stateRecord = "malformed";
      }
    }
    patchState = stateRecord;
    entries.push({
      index: entry.index,
      path: entry.path,
      kind: entry.kind,
      digest: entry.digest,
      truncated: entry.truncated,
      state,
      ...(verified.bytes === undefined ? {} : { bytes: verified.bytes }),
    });
  }

  return {
    dirPath: display,
    trace,
    manifestDocument,
    entries,
    patchEntryIndex,
    patch,
    patchBytes,
    patchState,
  };
}
