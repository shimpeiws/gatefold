/**
 * Parser for yuurei's `patch.diff` artifact: a UTF-8, LF-terminated unified
 * diff of additions against an empty workspace
 * (docs/yuurei-run-contract.md). The grammar is a sequence of file blocks —
 * `--- /dev/null`, `+++ <path>`, then for a non-empty file one
 * `@@ -0,0 +1,N @@` hunk of N `+`-prefixed lines and an optional
 * `\ No newline at end of file` marker. An empty file is its two header
 * lines alone. The parser records line and byte ranges into the stored bytes
 * so claims can cite bounded evidence ranges.
 */

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchParseError";
  }
}

/** One `+` content line, with its position in the stored patch bytes. */
export interface PatchContentLine {
  /** 1-based line number within the patch file. */
  readonly lineNumber: number;
  /** 0-based byte offset of the line's first byte. */
  readonly byteStart: number;
  /** 0-based byte offset one past the line's terminating LF. */
  readonly byteEnd: number;
  /** The line content without the leading `+`. */
  readonly text: string;
}

/** One generated file as recorded by a patch block. */
export interface PatchFile {
  readonly path: string;
  /** The file's content lines (without the `+` prefix). */
  readonly lines: readonly string[];
  /** Whether the stored file ends with a trailing LF. */
  readonly trailingNewline: boolean;
  /** 1-based line number of the block's `--- /dev/null` header. */
  readonly startLine: number;
  /** 1-based line number of the block's last line. */
  readonly endLine: number;
  /** 0-based byte offset of the block's first byte. */
  readonly byteStart: number;
  /** 0-based byte offset one past the block's last byte. */
  readonly byteEnd: number;
  /** 1-based line number of the `@@` hunk header, or null for an empty file. */
  readonly hunkLine: number | null;
  /** The `+` lines of the hunk, in order; empty for an empty file. */
  readonly contentLines: readonly PatchContentLine[];
}

export interface ParsedPatch {
  readonly files: readonly PatchFile[];
  /**
   * False when parsing stopped at an incomplete tail that the caller
   * accepted because the manifest marks the entry `truncated`. The parsed
   * files are a prefix of what the run recorded; anything past the cut is
   * unknown.
   */
  readonly complete: boolean;
}

/** Maximum file blocks a patch may carry before it is uninterpretable. */
export const MAX_PATCH_FILES = 65_536;

interface RawLine {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly text: string;
}

const HUNK_HEADER = /^@@ -0,0 \+1,(\d+) @@$/;
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
 * Parses verified `patch.diff` bytes into file blocks. When
 * `allowTruncatedTail` is set (the manifest records `truncated: true`), a
 * block cut off mid-structure ends the parse with `complete: false` instead
 * of raising; anything else raises `PatchParseError`.
 */
export function parsePatchDiff(
  bytes: Buffer,
  options: { allowTruncatedTail: boolean },
): ParsedPatch {
  const { lines, partialTail } = splitLines(bytes);
  const files: PatchFile[] = [];
  const seenPaths = new Set<string>();

  const fail = (message: string): never => {
    if (options.allowTruncatedTail) throw new CutTail();
    throw new PatchParseError(message);
  };

  let pos = 0;
  try {
    while (pos < lines.length) {
      if (files.length >= MAX_PATCH_FILES)
        throw new PatchParseError(
          `patch.diff carries more than ${MAX_PATCH_FILES} file blocks`,
        );
      const blockStart = pos;
      if (lines[pos].text !== "--- /dev/null")
        fail(
          `expected '--- /dev/null' at patch line ${pos + 1}, got '${lines[pos].text}'`,
        );
      pos += 1;
      if (pos >= lines.length || !lines[pos].text.startsWith("+++ "))
        fail(
          `expected a '+++ <path>' header after patch line ${blockStart + 1}`,
        );
      const path = lines[pos].text.slice(4);
      if (path.length === 0)
        fail(`empty path in the '+++' header at patch line ${pos + 1}`);
      // A well-formed yuurei patch records each workspace path exactly once;
      // a duplicate is a grammar violation, not a cut tail, so it stays a
      // hard error even when truncation is allowed.
      if (seenPaths.has(path))
        throw new PatchParseError(
          `duplicate '+++' path '${path}' at patch line ${pos + 1}`,
        );
      seenPaths.add(path);
      pos += 1;

      const content: PatchContentLine[] = [];
      let hunkLine: number | null = null;
      let trailingNewline = true;
      const hunk =
        pos < lines.length ? HUNK_HEADER.exec(lines[pos].text) : null;
      if (hunk !== null) {
        const count = Number(hunk[1]);
        if (!Number.isSafeInteger(count) || count < 1)
          fail(`invalid hunk count at patch line ${pos + 1}`);
        hunkLine = pos + 1;
        pos += 1;
        for (let i = 0; i < count; i += 1) {
          if (pos >= lines.length || !lines[pos].text.startsWith("+"))
            fail(
              `expected a '+' content line at patch line ${pos + 1} ` +
                `(hunk declares ${count} lines)`,
            );
          content.push({
            lineNumber: pos + 1,
            byteStart: lines[pos].byteStart,
            byteEnd: lines[pos].byteEnd,
            text: lines[pos].text.slice(1),
          });
          pos += 1;
        }
        if (pos < lines.length && lines[pos].text === NO_NEWLINE) {
          trailingNewline = false;
          pos += 1;
        }
      }
      // Under a truncation allowance a block is evidence of a complete
      // generated file only once its terminator is observed: the
      // `\ No newline` marker was read, or a following line rules out a
      // marker lost to the cut — a complete line, or a partial tail that
      // cannot be the marker's start. An unsealed block reaching the end
      // of the stored bytes (a partial content line, a header cut before
      // its hunk, a hunk whose marker may be cut) belongs to the unknown
      // tail, not to the recorded prefix.
      const sealed =
        !trailingNewline ||
        (pos < lines.length &&
          (pos < lines.length - 1 ||
            !partialTail ||
            !NO_NEWLINE.startsWith(lines[pos].text)));
      if (!sealed && options.allowTruncatedTail)
        return { files, complete: false };
      files.push({
        path,
        lines: content.map((line) => line.text),
        trailingNewline,
        startLine: blockStart + 1,
        endLine: pos, // pos is the index after the block = its last line number
        byteStart: lines[blockStart].byteStart,
        byteEnd: lines[pos - 1].byteEnd,
        hunkLine,
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
