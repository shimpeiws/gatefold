import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readYuureiRun } from "../src/input/yuurei-run.js";

const dir = new URL("fixtures/yuurei-run/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));

const sha256 = (content: string | Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gatefold-run-"));
}

/** Writes a minimal valid run: a trace plus a manifest. */
function writeRun(
  base: string,
  opts: {
    manifest?: unknown;
    patch?: string | null;
    traceFrom?: string;
  } = {},
): string {
  const runDir = join(base, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "trace.json"),
    opts.traceFrom ?? JSON.stringify(minimalTrace()),
  );
  const manifest = opts.manifest ?? {
    artifacts: [
      {
        path: "stdout.log",
        kind: "log",
        digest: sha256(""),
      },
    ],
  };
  writeFileSync(
    join(runDir, "artifacts.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  if (opts.patch !== undefined && opts.patch !== null)
    writeFileSync(join(runDir, "patch.diff"), opts.patch);
  return runDir;
}

function minimalTrace(): unknown {
  return {
    schema_version: "0.3",
    run_id: "run-t",
    started_at: "t0",
    finished_at: "t1",
    runtime: { id: "claude-code", version: null },
    model: { requested: "m", resolved: null },
    profile: { name: "p", digest: "sha256:p" },
    task: { source: "t", digest: "sha256:t" },
    isolation: { strategy: "cell", verified: true },
    execution: {
      exit_code: 0,
      signal: null,
      duration_ms: null,
      timed_out: false,
    },
    usage: {},
    cost: null,
    artifacts: [],
  };
}

describe("readYuureiRun", () => {
  it("loads a valid run directory with verified patch and unread logs", async () => {
    const run = await readYuureiRun(fixture("run-a"));
    expect(run.trace.runId).toBe("run-a1");
    expect(run.entries).toHaveLength(3);
    const patch = run.entries.find((e) => e.path === "patch.diff")!;
    expect(patch.state).toBe("verified");
    expect(patch.bytes).toBeGreaterThan(0);
    for (const log of ["stdout.log", "stderr.log"])
      expect(run.entries.find((e) => e.path === log)!.state).toBe("unverified");
    expect(run.patchState).toBe("verified");
    expect(run.patch!.files.map((f) => f.path)).toEqual([
      "README.md",
      "src/index.ts",
      "src/util.ts",
    ]);
    // src/util.ts lacks a trailing newline.
    const util = run.patch!.files[2];
    expect(util.trailingNewline).toBe(false);
    expect(util.lines).toEqual(["export const A = true;"]);
  });

  it("records byte ranges that resolve into the stored patch bytes", async () => {
    const run = await readYuureiRun(fixture("run-a"));
    const bytes = run.patchBytes!;
    for (const file of run.patch!.files) {
      const slice = bytes.subarray(file.byteStart, file.byteEnd).toString();
      expect(slice).toContain(`+++ ${file.path}`);
      for (const line of file.contentLines)
        expect(bytes.subarray(line.byteStart, line.byteEnd).toString()).toBe(
          `+${line.text}\n`,
        );
    }
  });

  it("parses a verified-truncated patch as its complete prefix", async () => {
    const run = await readYuureiRun(fixture("run-truncated"));
    expect(run.patchState).toBe("verified-truncated");
    expect(run.patch!.complete).toBe(false);
    expect(run.patch!.files.map((f) => f.path)).toEqual(["README.md"]);
  });

  it("treats a manifest without patch.diff as not-recorded", async () => {
    const run = await readYuureiRun(fixture("run-nopatch"));
    expect(run.patchState).toBe("not-recorded");
    expect(run.patchEntryIndex).toBeNull();
    expect(run.patch).toBeNull();
  });

  it("treats a non-sha256 digest as unverified and never reads the bytes", async () => {
    const run = await readYuureiRun(fixture("run-unreadable-diff"));
    const entry = run.entries.find((e) => e.path === "patch.diff")!;
    expect(entry.state).toBe("unverified");
    expect(run.patchState).toBe("unverified");
    expect(run.patch).toBeNull();
  });

  it("accepts an empty patch as a verified zero-file record", async () => {
    const run = await readYuureiRun(fixture("run-empty"));
    expect(run.patchState).toBe("verified");
    expect(run.patch!.files).toEqual([]);
    expect(run.patch!.complete).toBe(true);
  });

  it("rejects a missing directory and a non-directory argument", async () => {
    await expect(readYuureiRun("/nonexistent/run-dir")).rejects.toMatchObject({
      code: "unreadable-file",
    });
    await expect(
      readYuureiRun(fixture("run-a/trace.json")),
    ).rejects.toMatchObject({ code: "unreadable-file" });
  });

  it("rejects a run whose artifacts.json is missing or malformed", async () => {
    const base = tmp();
    try {
      // manifest absent entirely
      const noManifest = join(base, "no-manifest");
      mkdirSync(noManifest);
      writeFileSync(
        join(noManifest, "trace.json"),
        JSON.stringify(minimalTrace()),
      );
      await expect(readYuureiRun(noManifest)).rejects.toMatchObject({
        code: "unreadable-file",
      });
      // manifest not valid JSON
      const bad = writeRun(base, { manifest: "{ not json" });
      await expect(readYuureiRun(bad)).rejects.toMatchObject({
        code: "invalid-json",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    ["a non-object manifest", []],
    ["a manifest without an artifacts array", { notArtifacts: [] }],
    ["a non-object entry", { artifacts: ["patch.diff"] }],
    ["an entry missing digest", { artifacts: [{ path: "x", kind: "file" }] }],
    [
      "a non-boolean truncated",
      { artifacts: [{ path: "x", kind: "f", digest: "d", truncated: "yes" }] },
    ],
  ])("rejects %s with invalid-shape", async (_name, manifest) => {
    const base = tmp();
    try {
      const runDir = writeRun(base, { manifest });
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    "../escape",
    "a/../b",
    "/absolute",
    "C:\\win",
    ".",
    "a//b",
    "",
    "a\0b",
  ])("rejects the unconfined manifest path %j", async (path) => {
    const base = tmp();
    try {
      const runDir = writeRun(base, {
        manifest: {
          artifacts: [{ path, kind: "patch", digest: sha256("") }],
        },
      });
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a patch.diff symlink that escapes the run directory", async () => {
    const base = tmp();
    try {
      const outside = join(base, "outside.diff");
      writeFileSync(outside, "--- /dev/null\n+++ x\n");
      const runDir = writeRun(base, { patch: null });
      symlinkSync(outside, join(runDir, "patch.diff"));
      writeFileSync(
        join(runDir, "artifacts.json"),
        JSON.stringify({
          artifacts: [
            { path: "patch.diff", kind: "patch", digest: sha256("") },
          ],
        }),
      );
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects an escaping patch symlink even when its digest is invalid", async () => {
    const base = tmp();
    try {
      const outside = join(base, "outside.diff");
      writeFileSync(outside, "outside");
      const runDir = writeRun(base, { patch: null });
      symlinkSync(outside, join(runDir, "patch.diff"));
      writeFileSync(
        join(runDir, "artifacts.json"),
        JSON.stringify({
          artifacts: [
            { path: "patch.diff", kind: "patch", digest: "not-a-digest" },
          ],
        }),
      );
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a trace.json symlink that escapes the run directory", async () => {
    const base = tmp();
    try {
      const outside = join(base, "outside-trace.json");
      writeFileSync(outside, JSON.stringify(minimalTrace()));
      const runDir = writeRun(base, { patch: null });
      rmSync(join(runDir, "trace.json"));
      symlinkSync(outside, join(runDir, "trace.json"));
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects an artifacts.json symlink that escapes the run directory", async () => {
    const base = tmp();
    try {
      const outside = join(base, "outside-manifest.json");
      writeFileSync(outside, JSON.stringify({ artifacts: [] }));
      const runDir = writeRun(base, { patch: null });
      rmSync(join(runDir, "artifacts.json"));
      symlinkSync(outside, join(runDir, "artifacts.json"));
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("accepts a trace.json symlink that resolves inside the run directory", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, { patch: null });
      const realTrace = join(runDir, "real-trace.json");
      writeFileSync(realTrace, JSON.stringify(minimalTrace()));
      rmSync(join(runDir, "trace.json"));
      symlinkSync(realTrace, join(runDir, "trace.json"));
      const run = await readYuureiRun(runDir);
      expect(run.trace).toBeDefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a fixed-name member that is not a regular file", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, { patch: null });
      rmSync(join(runDir, "trace.json"));
      mkdirSync(join(runDir, "trace.json"));
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a FIFO trace.json promptly instead of blocking", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, { patch: null });
      rmSync(join(runDir, "trace.json"));
      execFileSync("mkfifo", [join(runDir, "trace.json")]);
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a FIFO artifacts.json promptly instead of blocking", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, { patch: null });
      rmSync(join(runDir, "artifacts.json"));
      execFileSync("mkfifo", [join(runDir, "artifacts.json")]);
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks a listed-but-absent patch.diff as missing", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, {
        manifest: {
          artifacts: [
            { path: "patch.diff", kind: "patch", digest: sha256("") },
          ],
        },
      });
      const run = await readYuureiRun(runDir);
      expect(run.patchState).toBe("missing");
      expect(run.patch).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks stored bytes that do not hash to the recorded digest", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, {
        patch: "--- /dev/null\n+++ a\n",
        manifest: {
          artifacts: [
            { path: "patch.diff", kind: "patch", digest: sha256("other") },
          ],
        },
      });
      const run = await readYuureiRun(runDir);
      expect(run.patchState).toBe("digest-mismatch");
      expect(run.patch).toBeNull();
      expect(run.entries[0].bytes).toBeGreaterThan(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a manifest with more entries than the ceiling", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, {
        manifest: {
          artifacts: Array.from({ length: 10_001 }, (_unused, index) => ({
            path: `f${index}`,
            kind: "file",
            digest: sha256(""),
          })),
        },
      });
      await expect(readYuureiRun(runDir)).rejects.toMatchObject({
        code: "invalid-shape",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    ["patch.diff", "patch", "patch"],
    ["an unread artifact", "stdout.log", "log"],
  ])(
    "rejects a manifest that lists %s on two entries",
    async (_name, path, kind) => {
      const base = tmp();
      try {
        const runDir = writeRun(base, {
          manifest: {
            artifacts: [
              { path, kind, digest: sha256("first") },
              { path, kind, digest: sha256("second") },
            ],
          },
        });
        await expect(readYuureiRun(runDir)).rejects.toMatchObject({
          code: "invalid-shape",
        });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("does not record a truncated patch's unsealed tail block as a file", async () => {
    const base = tmp();
    try {
      // The stored bytes end right after b.txt's header: whether the file
      // was empty or its hunk was cut is unknowable.
      const patch =
        "--- /dev/null\n+++ a.txt\n@@ -0,0 +1,1 @@\n+x\n" +
        "--- /dev/null\n+++ b.txt\n";
      const runDir = writeRun(base, {
        patch,
        manifest: {
          artifacts: [
            {
              path: "patch.diff",
              kind: "patch",
              digest: sha256(patch),
              truncated: true,
            },
          ],
        },
      });
      const run = await readYuureiRun(runDir);
      expect(run.patchState).toBe("verified-truncated");
      expect(run.patch!.complete).toBe(false);
      expect(run.patch!.files.map((file) => file.path)).toEqual(["a.txt"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks a verified patch with duplicate file paths as malformed", async () => {
    const base = tmp();
    try {
      const patch =
        "--- /dev/null\n+++ a.txt\n@@ -0,0 +1,1 @@\n+x\n" +
        "--- /dev/null\n+++ a.txt\n@@ -0,0 +1,1 @@\n+y\n";
      const runDir = writeRun(base, {
        patch,
        manifest: {
          artifacts: [
            { path: "patch.diff", kind: "patch", digest: sha256(patch) },
          ],
        },
      });
      const run = await readYuureiRun(runDir);
      expect(run.patchState).toBe("malformed");
      expect(run.patch).toBeNull();
      expect(run.entries[0].state).toBe("verified");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks verified bytes that violate the patch grammar as malformed", async () => {
    const base = tmp();
    try {
      const patch = "this is not a diff\n";
      const runDir = writeRun(base, {
        patch,
        manifest: {
          artifacts: [
            { path: "patch.diff", kind: "patch", digest: sha256(patch) },
          ],
        },
      });
      const run = await readYuureiRun(runDir);
      expect(run.patchState).toBe("malformed");
      expect(run.patch).toBeNull();
      expect(run.entries[0].state).toBe("verified");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
