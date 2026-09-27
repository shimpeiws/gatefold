import { describe, expect, it } from "vitest";
import {
  MAX_PATCH_FILES,
  parsePatchDiff,
  PatchParseError,
} from "../src/input/yuurei-patch.js";

const block = (path: string, lines: string[] = [], noNewline = false) =>
  `--- /dev/null\n+++ ${path}\n` +
  (lines.length === 0
    ? ""
    : `@@ -0,0 +1,${lines.length} @@\n` +
      lines.map((line) => `+${line}\n`).join("") +
      (noNewline ? "\\ No newline at end of file\n" : ""));

describe("parsePatchDiff", () => {
  it("parses empty files, hunks, and the no-newline marker", () => {
    const parsed = parsePatchDiff(
      Buffer.from(block("empty.txt") + block("a.txt", ["one", "two"], true)),
      { allowTruncatedTail: false },
    );
    expect(parsed.complete).toBe(true);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0].path).toBe("empty.txt");
    expect(parsed.files[0].lines).toEqual([]);
    expect(parsed.files[0].hunkLine).toBeNull();
    expect(parsed.files[1].lines).toEqual(["one", "two"]);
    expect(parsed.files[1].trailingNewline).toBe(false);
  });

  it("accepts an empty patch as a zero-file record", () => {
    const parsed = parsePatchDiff(Buffer.alloc(0), {
      allowTruncatedTail: false,
    });
    expect(parsed).toEqual({ files: [], complete: true });
  });

  it("rejects duplicate file paths even under a truncation allowance", () => {
    const duplicate = block("same.txt", ["x"]) + block("same.txt", ["y"]);
    expect(() =>
      parsePatchDiff(Buffer.from(duplicate), { allowTruncatedTail: false }),
    ).toThrowError(/duplicate '...' path/);
    expect(() =>
      parsePatchDiff(Buffer.from(duplicate), { allowTruncatedTail: true }),
    ).toThrowError(PatchParseError);
  });

  it("rejects non-UTF-8 bytes and non-diff content", () => {
    expect(() =>
      parsePatchDiff(Buffer.from([0xff, 0xfe, 0x0a]), {
        allowTruncatedTail: false,
      }),
    ).toThrowError(PatchParseError);
    expect(() =>
      parsePatchDiff(Buffer.from("not a diff\n"), {
        allowTruncatedTail: false,
      }),
    ).toThrowError(PatchParseError);
  });

  it("treats a cut tail as incomplete only when truncation is allowed", () => {
    const cut =
      block("a.txt", ["one"]) +
      "--- /dev/null\n+++ b.txt\n@@ -0,0 +1,3 @@\n+x\n";
    expect(() =>
      parsePatchDiff(Buffer.from(cut), { allowTruncatedTail: false }),
    ).toThrowError(PatchParseError);
    const parsed = parsePatchDiff(Buffer.from(cut), {
      allowTruncatedTail: true,
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("excludes a block cut inside a content line from the prefix", () => {
    const cut =
      block("a.txt", ["one"]) +
      "--- /dev/null\n+++ b.txt\n@@ -0,0 +1,2 @@\n+x\n+unfinished";
    const parsed = parsePatchDiff(Buffer.from(cut), {
      allowTruncatedTail: true,
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("does not read a header cut before its hunk as an empty file", () => {
    const cut = block("a.txt", ["one"]) + "--- /dev/null\n+++ b.txt\n";
    const parsed = parsePatchDiff(Buffer.from(cut), {
      allowTruncatedTail: true,
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.files.map((file) => file.path)).toEqual(["a.txt"]);
    // The same bytes are a complete patch when nothing was cut: the
    // two-line block is genuinely an empty file.
    const whole = parsePatchDiff(Buffer.from(cut), {
      allowTruncatedTail: false,
    });
    expect(whole.complete).toBe(true);
    expect(whole.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(whole.files[1].lines).toEqual([]);
  });

  it("excludes a boundary block whose no-newline marker may be cut", () => {
    // The hunk is satisfied at the end of the stored bytes, but a truncated
    // patch may have lost a `\ No newline at end of file` line — the
    // file's trailing newline is unknowable.
    const cut = block("a.txt", ["one"]) + block("b.txt", ["x"]);
    const parsed = parsePatchDiff(Buffer.from(cut), {
      allowTruncatedTail: true,
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("excludes a block followed by a partially stored marker", () => {
    const cut =
      block("a.txt", ["one"]) +
      "--- /dev/null\n+++ b.txt\n@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of fi";
    const parsed = parsePatchDiff(Buffer.from(cut), {
      allowTruncatedTail: true,
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it(
    "preserves complete files when a truncated tail ends inside UTF-8",
    () => {
    const prefix = Buffer.from(block("a.txt", ["ok"]));
    const header = Buffer.from(
      "--- /dev/null\n+++ b.txt\n@@ -0,0 +1,1 @@\n+",
    );
    const partialCodePoint = Buffer.from([0xc3]);
    const parsed = parsePatchDiff(
      Buffer.concat([prefix, header, partialCodePoint]),
      { allowTruncatedTail: true },
    );
    expect(parsed.complete).toBe(false);
    expect(parsed.files.map((file) => file.path)).toEqual(["a.txt"]);
    },
  );

  it("rejects malformed complete lines before a truncated tail", () => {
    const malformed =
      block("a.txt", ["ok"]) +
      "garbage\n" +
      block("b.txt", ["hidden"]);
    expect(() =>
      parsePatchDiff(Buffer.from(malformed), { allowTruncatedTail: true }),
    ).toThrowError(PatchParseError);
  });

  it("keeps a boundary block whose no-newline marker was read", () => {
    const withLf = block("a.txt", ["one"]) + block("b.txt", ["x"], true);
    const parsed = parsePatchDiff(Buffer.from(withLf), {
      allowTruncatedTail: true,
    });
    expect(parsed.complete).toBe(true);
    expect(parsed.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(parsed.files[1].trailingNewline).toBe(false);
    // A marker fully stored without its LF still seals the block.
    const withoutLf = withLf.slice(0, -1);
    const cut = parsePatchDiff(Buffer.from(withoutLf), {
      allowTruncatedTail: true,
    });
    expect(cut.complete).toBe(false);
    expect(cut.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("rejects a patch carrying more file blocks than the ceiling", () => {
    const many = Array.from({ length: MAX_PATCH_FILES + 1 }, (_unused, index) =>
      block(`f${index}`),
    ).join("");
    expect(() =>
      parsePatchDiff(Buffer.from(many), { allowTruncatedTail: false }),
    ).toThrowError(PatchParseError);
  });
});
