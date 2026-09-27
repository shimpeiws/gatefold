import { PatchParseError } from "./yuurei-patch.js";

/**
 * Parser for a seeded run's `patch.diff`: a UTF-8, LF-terminated unified diff
 * against the seeded baseline (docs/yuurei-seeded-run-contract.md). Shipped
 * yuurei emits paths without `a/`/`b/` prefixes: each file block is
 * `--- /dev/null` (added) or `--- <path>`, then `+++ <path>` or
 * `+++ /dev/null` (deleted), followed by `@@ -s1,c1 +s2,c2 @@` hunks of ` `
 * context, `-` removed, and `+` added lines, with an optional
 * `\ No newline at end of file` marker. A modified block names the same path
 * on both sides. Line and byte ranges into the stored bytes are recorded so
 * verdicts can cite bounded evidence ranges.
 */
export { PatchParseError };

/** How a seeded patch block describes the file's change against baseline. */
export type SeededChangeKind = "added" | "modified" | "deleted";

/** One `+` content line, with its position in the stored patch bytes. */
export interface SeededPatchContentLine {
  /** 1-based line number within the patch file. */
  readonly lineNumber: number;
  /** 0-based byte offset of the line's first byte. */
  readonly byteStart: number;
  /** 0-based byte offset one past the line's terminating LF. */
  readonly byteEnd: number;
  /** The line content without the leading `+`. */
  readonly text: string;
}

/** One changed file as recorded by a seeded patch block. */
export interface SeededPatchFile {
  /** Workspace-relative path: `+++` side for added/modified, `---` side for deleted. */
  readonly path: string;
  readonly change: SeededChangeKind;
  /** The `+` content lines across all hunks (without the prefix). */
  readonly addedLines: readonly string[];
  /** The `-` content lines across all hunks (without the prefix). */
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
  readonly contentLines: readonly SeededPatchContentLine[];
}

export interface ParsedSeededPatch {
  readonly files: readonly SeededPatchFile[];
  /**
   * False when parsing stopped at an incomplete tail that the caller
   * accepted because the manifest marks the entry `truncated`. The parsed
   * files are a prefix of what the run recorded; anything past the cut is
   * unknown.
   */
  readonly complete: boolean;
}

/** Maximum file blocks a patch may carry before it is uninterpretable. */
export const MAX_SEEDED_PATCH_FILES = 65_536;

interface RawLine {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/;
const NO_NEWLINE = "\\ No newline at end of file";

/** Splits the stored bytes into LF-terminated lines, decoding each as UTF-8. */
function splitLines(bytes: Buffer): { lines: RawLine[]; partialTail: boolean } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const lines: RawLine[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x0a) continue;
    lines.push(decodeLine(decoder, bytes, start, i + 1));
    start = i + 1;
  }
  const partialTail = start < bytes.length;
  if (partialTail) lines.push(decodeLine(decoder, bytes, start, bytes.length));
  return { lines, partialTail };
}

function decodeLine(
  decoder: TextDecoder,
  bytes: Buffer,
  start: number,
  end: number,
): RawLine {
  // The last line of a truncated file may not end with LF.
  const bodyEnd = end > start && bytes[end - 1] === 0x0a ? end - 1 : end;
  let text: string;
  try {
    text = decoder.decode(bytes.subarray(start, bodyEnd));
  } catch {
    throw new PatchParseError("patch.diff is not valid UTF-8");
  }
  return { byteStart: start, byteEnd: end, text };
}

class CutTail extends Error {}

/**
 * Parses verified seeded `patch.diff` bytes into file blocks. When
 * `allowTruncatedTail` is set (the manifest records `truncated: true`), a
 * block cut off mid-structure ends the parse with `complete: false` instead
 * of raising; anything else raises `PatchParseError`.
 */
export function parseSeededPatchDiff(
  bytes: Buffer,
  options: { allowTruncatedTail: boolean },
): ParsedSeededPatch {
  const { lines, partialTail } = splitLines(bytes);
  const files: SeededPatchFile[] = [];
  const seenPaths = new Set<string>();

  const fail = (message: string): never => {
    const errorAtTruncatedBoundary =
      pos >= lines.length || (partialTail && pos === lines.length - 1);
    if (options.allowTruncatedTail && errorAtTruncatedBoundary)
      throw new CutTail();
    throw new PatchParseError(message);
  };

  let pos = 0;
  try {
    while (pos < lines.length) {
      if (files.length >= MAX_SEEDED_PATCH_FILES)
        throw new PatchParseError(
          `patch.diff carries more than ${MAX_SEEDED_PATCH_FILES} file blocks`,
        );
      const blockStart = pos;

      const oldHeader = lines[pos].text;
      if (!oldHeader.startsWith("--- "))
        fail(
          `expected a '--- <path>' or '--- /dev/null' header at patch line ${pos + 1}, got '${oldHeader}'`,
        );
      const oldSide = oldHeader.slice(4);
      const added = oldSide === "/dev/null";
      pos += 1;

      if (pos >= lines.length || !lines[pos].text.startsWith("+++ "))
        fail(
          `expected a '+++ <path>' or '+++ /dev/null' header after patch line ${blockStart + 1}`,
        );
      const newSide = lines[pos].text.slice(4);
      const deleted = newSide === "/dev/null";
      if (added && deleted)
        fail(
          `a file block cannot have /dev/null on both sides at patch line ${pos + 1}`,
        );
      // A modified block must name the same file on both sides: shipped
      // yuurei records no renames, so differing paths are foreign data.
      if (!added && !deleted && oldSide !== newSide)
        fail(
          `a modified file block names differing paths at patch line ${pos + 1} ('${oldSide}' versus '${newSide}')`,
        );
      const path = deleted ? oldSide : newSide;
      if (path.length === 0)
        fail(`empty path in a file header at patch line ${pos + 1}`);
      const change: SeededChangeKind = added
        ? "added"
        : deleted
          ? "deleted"
          : "modified";
      // A well-formed yuurei patch records each workspace path exactly once;
      // a duplicate is a grammar violation, not a cut tail, so it stays a
      // hard error even when truncation is allowed.
      if (seenPaths.has(path))
        throw new PatchParseError(
          `duplicate path '${path}' at patch line ${blockStart + 1}`,
        );
      seenPaths.add(path);
      pos += 1;

      const content: SeededPatchContentLine[] = [];
      const addedLines: string[] = [];
      const removedLines: string[] = [];
      let hunkCount = 0;
      let markerSeen = false;
      // A block carries zero or more hunks; each hunk must satisfy its
      // declared old/new line counts.
      while (pos < lines.length && lines[pos].text.startsWith("@@ ")) {
        const hunk =
          HUNK_HEADER.exec(lines[pos].text) ??
          fail(`invalid hunk header at patch line ${pos + 1}`);
        const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
        const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
        if (
          !Number.isSafeInteger(oldCount) ||
          !Number.isSafeInteger(newCount) ||
          oldCount < 0 ||
          newCount < 0
        )
          fail(`invalid hunk counts at patch line ${pos + 1}`);
        hunkCount += 1;
        pos += 1;
        let seenOld = 0;
        let seenNew = 0;
        while (seenOld < oldCount || seenNew < newCount) {
          if (pos >= lines.length)
            fail(
              `hunk at patch line ${pos} ended early ` +
                `(declared -${oldCount}/+${newCount})`,
            );
          const text = lines[pos].text;
          const tag = text.charAt(0);
          if (tag !== " " && tag !== "-" && tag !== "+")
            fail(
              `expected a hunk content line at patch line ${pos + 1} ` +
                `(declared -${oldCount}/+${newCount}), got '${text}'`,
            );
          if (tag !== "+") seenOld += 1;
          if (tag !== "-") seenNew += 1;
          if (seenOld > oldCount || seenNew > newCount)
            fail(
              `hunk at patch line ${pos + 1} exceeds its declared counts ` +
                `(-${oldCount}/+${newCount})`,
            );
          if (tag === "+") {
            const body = text.slice(1);
            addedLines.push(body);
            content.push({
              lineNumber: pos + 1,
              byteStart: lines[pos].byteStart,
              byteEnd: lines[pos].byteEnd,
              text: body,
            });
          } else if (tag === "-") {
            removedLines.push(text.slice(1));
          }
          pos += 1;
        }
        if (pos < lines.length && lines[pos].text === NO_NEWLINE) {
          markerSeen = true;
          pos += 1;
        }
      }
      // An added block with no hunk is an empty added file; a modified or
      // deleted block must carry at least one hunk — otherwise nothing
      // describes the change.
      if (hunkCount === 0 && change !== "added")
        fail(
          `a ${change} file block carries no hunk at patch line ${blockStart + 1}`,
        );
      // Under a truncation allowance a block is evidence of a complete
      // record only once its terminator is observed: the `\ No newline`
      // marker was read, or a following line rules out a marker lost to
      // the cut — a complete line, or a partial tail that cannot be the
      // marker's start. A block that reaches the end of the stored bytes
      // without one belongs to the unknown tail, not to the record.
      const sealed =
        markerSeen ||
        (pos < lines.length &&
          (pos < lines.length - 1 ||
            !partialTail ||
            !NO_NEWLINE.startsWith(lines[pos].text)));
      if (!sealed && options.allowTruncatedTail)
        return { files, complete: false };
      files.push({
        path,
        change,
        addedLines,
        removedLines,
        startLine: blockStart + 1,
        endLine: pos,
        byteStart: lines[blockStart].byteStart,
        byteEnd: lines[pos - 1].byteEnd,
        contentLines: content,
      });
    }
  } catch (error) {
    if (!(error instanceof CutTail)) throw error;
    return { files, complete: false };
  }

  // Bytes that do not end at an LF boundary are a cut final line.
  if (partialTail) {
    if (!options.allowTruncatedTail)
      throw new PatchParseError("patch.diff does not end at a line boundary");
    return { files, complete: false };
  }
  return { files, complete: true };
}
