import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { compareEvaluations } from "../src/application/compare-evaluations.js";
import { loadCheckReports } from "../src/application/check-report-binding.js";
import { evaluateRun } from "../src/application/evaluate-run.js";
import { parseTaskSpec, readTaskSpec } from "../src/input/task-spec.js";
import { PflExportError } from "../src/input/pfl-export.js";
import {
  parseSeededPatchDiff,
  PatchParseError,
} from "../src/input/yuurei-seeded-patch.js";
import { readEvaluatedRun } from "../src/input/yuurei-seeded-run.js";
import { runCli } from "../src/cli.js";

const dir = new URL("fixtures/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));

const sha256 = (content: string | Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gatefold-eval-"));
}

const seededPatch =
  "--- src/auth.ts\n" +
  "+++ src/auth.ts\n" +
  "@@ -1,3 +1,4 @@\n" +
  " export function check(token) {\n" +
  "-  return token.exp > now();\n" +
  "+  return token.exp > now() && !token.revoked;\n" +
  " }\n" +
  "+export const VERSION = 2;\n" +
  "--- /dev/null\n" +
  "+++ test/auth.test.ts\n" +
  "@@ -0,0 +1,1 @@\n" +
  "+import { check };\n" +
  "--- legacy/util.ts\n" +
  "+++ /dev/null\n" +
  "@@ -1,1 +0,0 @@\n" +
  "-export const OLD = true;\n";

const legacyPatch =
  "--- /dev/null\n+++ README.md\n@@ -0,0 +1,1 @@\n+# readme\n";

const RESULT_TEXT = '{"status": "fixed", "note": "token expiry"}\n';

interface RunOptions {
  trace?: Record<string, unknown>;
  manifest?: unknown;
  patch?: string | null;
  result?: string | null;
}

/** The seed record the default seededPatch is consistent with. */
function seedDoc(
  changes: { added: number; modified: number; deleted: number } | null = {
    added: 1,
    modified: 1,
    deleted: 1,
  },
  baselineDigest = "sha256:base-1",
): Record<string, unknown> {
  return {
    policy: "git-tracked-files",
    source: "/seed/x",
    head: "0123456789abcdef0123456789abcdef01234567",
    baseline: {
      requested_digest: baselineDigest,
      materialized_digest: baselineDigest,
      files: 3,
      bytes: 42,
    },
    ...(changes === null ? {} : { changes }),
  };
}

/** A shipped-contract seeded trace (yuurei #202, inputs_version 2). */
function seededTrace(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "0.3",
    run_id: "run-seeded-t",
    started_at: "t0",
    finished_at: "t1",
    runtime: { id: "claude-code", version: "2.0.0" },
    model: { requested: "m", resolved: "m-1", resolved_reason: "observed" },
    profile: { name: "p", digest: "sha256:p" },
    task: { source: "t", digest: "sha256:task-x" },
    requested_cell: { digest: "sha256:cell", inputs_version: 2 },
    seed: seedDoc(),
    patch: { base: "seeded", state: "complete" },
    isolation: { strategy: "cell", verified: true },
    execution: {
      exit_code: 0,
      signal: null,
      duration_ms: 10,
      timed_out: false,
    },
    usage: {},
    cost: null,
    artifacts: [],
    ...overrides,
  };
}

/** A shipped-contract empty-workspace trace (inputs_version 1). */
function legacyTrace(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const t = seededTrace();
  delete t.seed;
  return {
    ...t,
    requested_cell: { digest: "sha256:cell", inputs_version: 1 },
    patch: { base: "empty", state: "complete" },
    ...overrides,
  };
}

/** Writes a run directory; patch/result default to recorded and verified. */
function writeRun(base: string, name: string, opts: RunOptions = {}): string {
  const runDir = join(base, name);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "trace.json"),
    JSON.stringify(opts.trace ?? seededTrace()),
  );
  const artifacts: Record<string, unknown>[] = [];
  const patch = opts.patch === undefined ? seededPatch : opts.patch;
  if (patch !== null) {
    writeFileSync(join(runDir, "patch.diff"), patch);
    artifacts.push({
      path: "patch.diff",
      kind: "patch",
      digest: sha256(patch),
    });
  }
  const result = opts.result === undefined ? RESULT_TEXT : opts.result;
  if (result !== null) {
    writeFileSync(join(runDir, "result.txt"), result);
    artifacts.push({
      path: "result.txt",
      kind: "result",
      digest: sha256(result),
    });
  }
  writeFileSync(
    join(runDir, "artifacts.json"),
    JSON.stringify(opts.manifest ?? { artifacts }),
  );
  return runDir;
}

function writeSpec(base: string, spec: unknown): string {
  const path = join(base, `spec-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

function specDoc(criteria: unknown[] = defaultCriteria()): unknown {
  return {
    specVersion: 1,
    rubricId: "r1",
    task: { digest: "sha256:task-x" },
    baseline: { digest: "sha256:base-1" },
    criteria,
  };
}

function defaultCriteria(): unknown[] {
  return [
    { id: "mod", kind: "file-modified", path: "src/auth.ts" },
    { id: "added", kind: "file-added", path: "test/auth.test.ts" },
    { id: "deleted", kind: "file-deleted", path: "legacy/util.ts" },
    {
      id: "status",
      kind: "final-result-json-field",
      pointer: "/status",
      equals: "fixed",
    },
    { id: "mentions", kind: "final-result-contains", text: "expiry" },
    { id: "unit", kind: "external-check" },
  ];
}

function writeReport(base: string, name: string, report: unknown): string {
  const path = join(base, name);
  writeFileSync(path, JSON.stringify(report));
  return path;
}

const v6Schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/claim-result.v6.json", import.meta.url)),
    "utf8",
  ),
);
const v7Schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/claim-result.v7.json", import.meta.url)),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: true });
const validateV6 = ajv.compile(v6Schema);
const validateV7 = ajv.compile(v7Schema);

describe("parseSeededPatchDiff", () => {
  it("parses added, modified, and deleted blocks with ranges", () => {
    const parsed = parseSeededPatchDiff(Buffer.from(seededPatch), {
      allowTruncatedTail: false,
    });
    expect(parsed.complete).toBe(true);
    expect(parsed.files.map((f) => [f.path, f.change])).toEqual([
      ["src/auth.ts", "modified"],
      ["test/auth.test.ts", "added"],
      ["legacy/util.ts", "deleted"],
    ]);
    const modified = parsed.files[0];
    expect(modified.removedLines).toEqual(["  return token.exp > now();"]);
    expect(modified.addedLines).toEqual([
      "  return token.exp > now() && !token.revoked;",
      "export const VERSION = 2;",
    ]);
    const bytes = Buffer.from(seededPatch);
    for (const file of parsed.files)
      expect(bytes.subarray(file.byteStart, file.byteEnd).toString()).toContain(
        file.change === "deleted" ? `--- ${file.path}` : `+++ ${file.path}`,
      );
  });

  it("treats an empty patch as a complete zero-change record", () => {
    const parsed = parseSeededPatchDiff(Buffer.from(""), {
      allowTruncatedTail: false,
    });
    expect(parsed).toEqual({ files: [], complete: true });
  });

  it.each([
    [
      "a git-format modified block with differing a//b/ paths",
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n",
    ],
    ["dev/null on both sides", "--- /dev/null\n+++ /dev/null\n"],
    ["a hunk count mismatch", "--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@\n-x\n+y\n"],
    ["a modified block with no hunk", "--- a.ts\n+++ a.ts\n"],
    ["an empty header path", "--- \n+++ /dev/null\n"],
    [
      "a duplicate path",
      "--- /dev/null\n+++ a.ts\n@@ -0,0 +1,1 @@\n+x\n--- /dev/null\n+++ a.ts\n@@ -0,0 +1,1 @@\n+y\n",
    ],
  ])("rejects %s as malformed", (_name, patch) => {
    expect(() =>
      parseSeededPatchDiff(Buffer.from(patch), {
        allowTruncatedTail: false,
      }),
    ).toThrow(PatchParseError);
  });

  it("keeps only the sealed prefix of a truncated patch", () => {
    const cut =
      "--- /dev/null\n+++ a.ts\n@@ -0,0 +1,1 @@\n+x\n--- b.ts\n+++ b.ts\n";
    const parsed = parseSeededPatchDiff(Buffer.from(cut), {
      allowTruncatedTail: true,
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("keeps the sealed prefix when the cut splits a UTF-8 code point", () => {
    const bytes = Buffer.concat([
      Buffer.from(
        "--- /dev/null\n+++ a.ts\n@@ -0,0 +1,1 @@\n+x\n" +
          "--- b.ts\n+++ b.ts\n@@ -1,1 +1,1 @@\n-old\n+",
      ),
      Buffer.from([0xe3, 0x81]),
    ]);
    const parsed = parseSeededPatchDiff(bytes, { allowTruncatedTail: true });
    expect(parsed.complete).toBe(false);
    expect(parsed.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(() =>
      parseSeededPatchDiff(bytes, { allowTruncatedTail: false }),
    ).toThrow(PatchParseError);
  });

  it("fails a duplicate path even under a truncation allowance", () => {
    const patch =
      "--- /dev/null\n+++ a.ts\n@@ -0,0 +1,1 @@\n+x\n--- /dev/null\n+++ a.ts\n@@ -0,0 +1,1 @@\n+y\n";
    expect(() =>
      parseSeededPatchDiff(Buffer.from(patch), { allowTruncatedTail: true }),
    ).toThrow(PatchParseError);
  });
});

describe("readEvaluatedRun", () => {
  it("loads a seeded run: seed, patch record, verified result and manifests", async () => {
    const run = await readEvaluatedRun(fixture("yuurei-run/seeded-a"));
    expect(run.seeded).toBe(true);
    expect(run.trace.seed?.baseline.requestedDigest).toBe(
      "sha256:baseline-seeded-1",
    );
    expect(run.trace.seed?.changes).toEqual({
      added: 1,
      modified: 1,
      deleted: 1,
    });
    expect(run.patchRecord).toEqual({ base: "seeded", state: "complete" });
    expect(run.patchState).toBe("verified");
    expect(run.patch!.files.map((f) => [f.path, f.change])).toEqual([
      ["src/auth.ts", "modified"],
      ["test/auth.test.ts", "added"],
      ["legacy/util.ts", "deleted"],
    ]);
    expect(run.resultState).toBe("verified");
    expect(run.resultText).toContain('"status": "fixed"');
    const verifiedPaths = run.entries
      .filter((e) => e.state === "verified")
      .map((e) => e.path);
    expect(verifiedPaths).toEqual([
      "patch.diff",
      "result.txt",
      "baseline-manifest.json",
      "changes.json",
    ]);
  });

  it("reads a legacy empty-workspace run with the legacy grammar", async () => {
    const run = await readEvaluatedRun(fixture("yuurei-run/run-a"));
    expect(run.seeded).toBe(false);
    expect(run.patch!.files.every((f) => f.change === "added")).toBe(true);
    expect(run.resultState).toBe("not-recorded");
    expect(run.resultText).toBeNull();
  });

  it("reads result availability from shipped diagnostics", async () => {
    const base = tmp();
    try {
      for (const [diagnostic, expected] of [
        ["result: no final message emitted", "not-emitted"],
        ["result: final message could not be parsed", "parse-failed"],
        ["result: save failed; result.txt not recorded", "save-failed"],
      ] as const) {
        const runDir = writeRun(base, `r-${expected}`, {
          trace: seededTrace({ diagnostics: [diagnostic] }),
          result: null,
        });
        const run = await readEvaluatedRun(runDir);
        expect(run.resultState).toBe(expected);
        expect(run.trace.diagnostics[run.resultDiagnosticIndex]).toBe(
          diagnostic,
        );
      }
      const noMarker = writeRun(base, "r-none", { result: null });
      expect((await readEvaluatedRun(noMarker)).resultState).toBe(
        "not-recorded",
      );
      // An unrelated diagnostic must not collide with the lookup table.
      const protoKey = writeRun(base, "r-proto", {
        trace: seededTrace({ diagnostics: ["toString"] }),
        result: null,
      });
      expect((await readEvaluatedRun(protoKey)).resultState).toBe(
        "not-recorded",
      );
      // A listed result entry with no file behind it is 'missing'.
      const missingDir = writeRun(base, "r-missing", { result: null });
      writeFileSync(
        join(missingDir, "artifacts.json"),
        JSON.stringify({
          artifacts: [
            {
              path: "patch.diff",
              kind: "patch",
              digest: sha256(seededPatch),
            },
            {
              path: "result.txt",
              kind: "result",
              digest: sha256("ghost"),
            },
          ],
        }),
      );
      expect((await readEvaluatedRun(missingDir)).resultState).toBe("missing");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks a digest-mismatched or truncated result without interpreting it", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "r", { result: RESULT_TEXT });
      writeFileSync(
        join(runDir, "artifacts.json"),
        JSON.stringify({
          artifacts: [
            {
              path: "patch.diff",
              kind: "patch",
              digest: sha256(seededPatch),
            },
            {
              path: "result.txt",
              kind: "result",
              digest: sha256("other"),
            },
          ],
        }),
      );
      const run = await readEvaluatedRun(runDir);
      expect(run.resultState).toBe("digest-mismatch");
      expect(run.resultText).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks a seeded run's git-format (a//b/) patch as malformed", async () => {
    const base = tmp();
    try {
      const run = await readEvaluatedRun(
        writeRun(base, "r", {
          patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n",
        }),
      );
      expect(run.patchState).toBe("malformed");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "a patch.base of 'empty' on a seeded run",
      seededTrace({ patch: { base: "empty", state: "complete" } }),
      null,
      "contradicts",
    ],
    [
      "a patch.base of 'seeded' without a seed",
      legacyTrace({ patch: { base: "seeded", state: "complete" } }),
      null,
      "contradicts",
    ],
    [
      "requested-cell inputs_version 1 on a seeded run",
      seededTrace({
        requested_cell: { digest: "sha256:cell", inputs_version: 1 },
      }),
      null,
      "inputs_version",
    ],
    [
      "requested-cell inputs_version 2 without a seed",
      legacyTrace({
        requested_cell: { digest: "sha256:cell", inputs_version: 2 },
      }),
      null,
      "inputs_version",
    ],
    [
      "an unknown workspace inputs_version without a seed",
      legacyTrace({
        requested_cell: { digest: "sha256:cell", inputs_version: 3 },
      }),
      null,
      "inputs_version",
    ],
    [
      "a seed whose requested and materialized digests differ",
      seededTrace({
        seed: {
          ...seedDoc(),
          baseline: {
            requested_digest: "sha256:base-1",
            materialized_digest: "sha256:base-2",
            files: 3,
            bytes: 42,
          },
        },
      }),
      null,
      "requested_digest",
    ],
    [
      "a 'complete' patch record over a truncated manifest entry",
      seededTrace(),
      { truncatedPatch: true },
      "complete",
    ],
    [
      "an 'absent' patch record with a patch.diff entry",
      seededTrace({ patch: { base: "seeded", state: "absent" } }),
      null,
      "absent",
    ],
    [
      "a non-absent patch record with no patch.diff entry",
      seededTrace({ patch: { base: "seeded", state: "partial" } }),
      { patch: null },
      "partial",
    ],
    [
      "a generation-failed diagnostic with a patch.diff entry",
      seededTrace({
        diagnostics: ["patch: generation failed; patch.diff not recorded"],
      }),
      null,
      "generation",
    ],
    [
      "a published patch over an absent seed.changes record",
      seededTrace({ seed: seedDoc(null) }),
      null,
      "seed.changes",
    ],
    [
      "a 'complete' patch record alongside counted omissions",
      seededTrace({
        diagnostics: ["patch: 1 binary file(s) omitted"],
      }),
      null,
      "complete",
    ],
    [
      "a 'partial' patch record alongside generation-failed",
      seededTrace({
        patch: { base: "seeded", state: "partial" },
        diagnostics: ["patch: generation failed; patch.diff not recorded"],
      }),
      null,
      "generation",
    ],
  ])(
    "rejects contradictory records: %s",
    async (_name, traceDoc, opts, message) => {
      const base = tmp();
      try {
        const runDir = writeRun(base, "r", {
          trace: traceDoc,
          ...(opts?.patch === null ? { patch: null } : {}),
        });
        if (opts?.truncatedPatch) {
          writeFileSync(
            join(runDir, "artifacts.json"),
            JSON.stringify({
              artifacts: [
                {
                  path: "patch.diff",
                  kind: "patch",
                  digest: sha256(seededPatch),
                  truncated: true,
                },
              ],
            }),
          );
        }
        await expect(readEvaluatedRun(runDir)).rejects.toMatchObject({
          code: "invalid-shape",
          message: expect.stringContaining(message),
        });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      "a verified baseline-manifest.json whose digests differ",
      {
        "baseline-manifest.json": JSON.stringify({
          version: 1,
          policy: "git-tracked-files",
          source: "/seed/x",
          head: "0123456789abcdef0123456789abcdef01234567",
          requested_digest: "sha256:base-2",
          materialized_digest: "sha256:base-2",
          files: {},
        }),
      },
      "seed record",
    ],
    [
      "a verified changes.json whose counts differ from seed.changes",
      {
        "changes.json": JSON.stringify({
          version: 1,
          baseline_digest: "sha256:base-1",
          added: [],
          modified: ["src/auth.ts"],
          deleted: [],
        }),
      },
      "seed.changes",
    ],
    [
      "a verified changes.json the trace does not record",
      {
        "changes.json": JSON.stringify({
          version: 1,
          baseline_digest: "sha256:base-1",
          added: ["test/auth.test.ts"],
          modified: ["src/auth.ts"],
          deleted: ["legacy/util.ts"],
        }),
        trace: seededTrace({ seed: seedDoc(null) }),
      },
      "seed.changes",
    ],
  ])(
    "rejects contradictory seeded artifacts: %s",
    async (_name, extra, message) => {
      const base = tmp();
      try {
        const files: Record<string, unknown> = { ...extra };
        const traceDoc = files.trace as Record<string, unknown> | undefined;
        delete files.trace;
        const runDir = writeRun(
          base,
          "r",
          traceDoc === undefined ? {} : { trace: traceDoc },
        );
        const artifacts = [
          { path: "patch.diff", kind: "patch", digest: sha256(seededPatch) },
          {
            path: "result.txt",
            kind: "result",
            digest: sha256(RESULT_TEXT),
          },
        ];
        for (const [path, content] of Object.entries(files)) {
          writeFileSync(join(runDir, path), content as string);
          artifacts.push({
            path,
            kind: "file",
            digest: sha256(content as string),
          });
        }
        writeFileSync(
          join(runDir, "artifacts.json"),
          JSON.stringify({ artifacts }),
        );
        await expect(readEvaluatedRun(runDir)).rejects.toMatchObject({
          code: "invalid-shape",
          message: expect.stringContaining(message),
        });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});

describe("task spec parsing", () => {
  it("accepts the committed fixture spec", async () => {
    const spec = await readTaskSpec(fixture("evaluation/task-spec.json"));
    expect(spec.rubricId).toBe("auth-repair-v1");
    expect(spec.baselineDigest).toBe("sha256:baseline-seeded-1");
    expect(spec.criteria).toHaveLength(6);
  });

  it.each([
    ["a non-integer specVersion", { specVersion: "1" }],
    ["an unsupported specVersion", { specVersion: 2 }],
    ["a missing task digest", { task: {} }],
    [
      "a repeated criterion id",
      {
        criteria: [
          { id: "x", kind: "file-added", path: "a" },
          { id: "x", kind: "file-added", path: "b" },
        ],
      },
    ],
    [
      "an unknown criterion kind",
      {
        criteria: [{ id: "x", kind: "run-shell", path: "a" }],
      },
    ],
    [
      "a file criterion without path",
      {
        criteria: [{ id: "x", kind: "file-added" }],
      },
    ],
    [
      "a json-field criterion without equals",
      {
        criteria: [{ id: "x", kind: "final-result-json-field", pointer: "/a" }],
      },
    ],
    [
      "a json-field criterion with a bad pointer",
      {
        criteria: [
          { id: "x", kind: "final-result-json-field", pointer: "a", equals: 1 },
        ],
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    const spec = { ...specDoc(defaultCriteria()), ...overrides };
    expect(() => parseTaskSpec(spec, "test")).toThrowError(/task spec/);
  });

  it("accepts a spec without a baseline binding", () => {
    const spec = parseTaskSpec(
      {
        specVersion: 1,
        rubricId: "r",
        task: { digest: "sha256:t" },
        criteria: [{ id: "a", kind: "file-added", path: "x" }],
      },
      "test",
    );
    expect(spec.baselineDigest).toBeUndefined();
  });

  it("rejects an equals value nested beyond the reader's depth cap", () => {
    // jsonEquals recurses on this value; a container beyond 12 nesting
    // levels must fail as an input error (invalid-shape), not a RangeError
    // (internal error).
    const nested = (levels: number): unknown =>
      levels === 0 ? "leaf" : { a: nested(levels - 1) };
    const spec = (equals: unknown) => ({
      specVersion: 1,
      rubricId: "r",
      task: { digest: "sha256:t" },
      criteria: [
        {
          id: "x",
          kind: "final-result-json-field",
          pointer: "/a",
          equals,
        },
      ],
    });
    expect(() => parseTaskSpec(spec(nested(13)), "test")).not.toThrow();
    expect(() => parseTaskSpec(spec(nested(14)), "test")).toThrowError(
      /nested no deeper/,
    );
    expect(() => parseTaskSpec(spec(nested(14)), "test")).toThrowError(
      PflExportError,
    );
  });
});

describe("evaluateRun", () => {
  async function evaluate(
    runDir: string,
    specPath: string,
    reports: string[] = [],
  ) {
    return evaluateRun({
      run: await readEvaluatedRun(runDir),
      spec: await readTaskSpec(specPath),
      checkReports: await loadCheckReports(reports),
      labels: { run: runDir, spec: specPath },
    });
  }

  it("evaluates every supported criterion on the seeded fixture", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, specDoc());
      const report = writeReport(base, "report.json", {
        reportVersion: 1,
        evaluator: { id: "vitest" },
        subject: {
          taskDigest: "sha256:task-x",
          baselineDigest: "sha256:base-1",
        },
        results: [{ criterionId: "unit", verdict: "pass" }],
      });
      const runDir = writeRun(base, "run", {});
      const result = await evaluate(runDir, specPath, [report]);
      expect(validateV6(result), JSON.stringify(validateV6.errors)).toBe(true);
      expect(
        Object.fromEntries(
          result.evaluations.map((e) => [e.criterionId, e.verdict]),
        ),
      ).toEqual({
        mod: "pass",
        added: "pass",
        deleted: "pass",
        status: "pass",
        mentions: "pass",
        unit: "pass",
      });
      for (const entry of result.evaluations) {
        expect(entry.evidence.length).toBeGreaterThan(0);
        expect(entry.confidence).toBeGreaterThan(0);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "seeded-nochange",
      {
        "auth-fixed": "fail",
        "tests-added": "fail",
        "legacy-removed": "fail",
        "answer-status": "fail",
        "answer-mentions-expiry": "fail",
        "unit-tests": "unknown",
      },
    ],
    [
      "seeded-partial",
      {
        "auth-fixed": "pass",
        "tests-added": "unknown",
        "legacy-removed": "unknown",
        "answer-status": "pass",
        "answer-mentions-expiry": "pass",
        "unit-tests": "unknown",
      },
    ],
    [
      "seeded-nopatch",
      {
        "auth-fixed": "unknown",
        "tests-added": "unknown",
        "legacy-removed": "unknown",
        "answer-status": "pass",
        "answer-mentions-expiry": "pass",
        "unit-tests": "unknown",
      },
    ],
    [
      "seeded-noresult",
      {
        "auth-fixed": "pass",
        "tests-added": "pass",
        "legacy-removed": "pass",
        "answer-status": "unknown",
        "answer-mentions-expiry": "unknown",
        "unit-tests": "unknown",
      },
    ],
  ])(
    "evaluates the committed %s fixture under the shipped contract",
    async (name, expected) => {
      const result = await evaluate(
        fixture(`yuurei-run/${name}`),
        fixture("evaluation/task-spec.json"),
      );
      expect(validateV6(result), JSON.stringify(validateV6.errors)).toBe(true);
      expect(
        Object.fromEntries(
          result.evaluations.map((e) => [e.criterionId, e.verdict]),
        ),
      ).toEqual(expected);
    },
  );

  it("cites patch.state for criteria a partial patch does not record", async () => {
    const result = await evaluate(
      fixture("yuurei-run/seeded-partial"),
      fixture("evaluation/task-spec.json"),
    );
    const added = result.evaluations.find(
      (e) => e.criterionId === "tests-added",
    )!;
    expect(added.verdict).toBe("unknown");
    expect(
      added.evidence.some(
        (e) => e.source === "trace" && e.pointer === "/patch/state",
      ),
    ).toBe(true);
  });

  it("fails file criteria a complete patch does not record", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, specDoc());
      const runDir = writeRun(base, "run", {
        trace: seededTrace({
          seed: seedDoc({ added: 0, modified: 1, deleted: 0 }),
        }),
        patch: "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n",
      });
      const result = await evaluate(runDir, specPath);
      for (const id of ["mod", "added", "deleted"])
        expect(
          result.evaluations.find((e) => e.criterionId === id)!.verdict,
        ).toBe("fail");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "absent",
      {
        patch: null,
        trace: seededTrace({
          patch: { base: "seeded", state: "absent" },
          seed: seedDoc(null),
        }),
      },
    ],
    ["malformed", { patch: "not a diff\n" }],
    ["digest-mismatch", { patch: seededPatch, result: RESULT_TEXT }],
  ])(
    "reports file criteria unknown when the patch is %s",
    async (_name, opts) => {
      const base = tmp();
      try {
        const specPath = writeSpec(base, specDoc());
        const runDir = writeRun(base, "run", opts);
        if (_name === "digest-mismatch")
          writeFileSync(
            join(runDir, "artifacts.json"),
            JSON.stringify({
              artifacts: [
                { path: "patch.diff", kind: "patch", digest: sha256("x") },
                {
                  path: "result.txt",
                  kind: "result",
                  digest: sha256(RESULT_TEXT),
                },
              ],
            }),
          );
        const result = await evaluate(runDir, specPath);
        for (const id of ["mod", "added", "deleted"]) {
          const entry = result.evaluations.find((e) => e.criterionId === id)!;
          expect(entry.verdict, id).toBe("unknown");
          expect(entry.reason).toContain("patch");
        }
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("leaves a criterion whose file may be in the cut tail unknown", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(
        base,
        specDoc([{ id: "mod", kind: "file-modified", path: "src/auth.ts" }]),
      );
      const cut =
        "--- other.ts\n+++ other.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n--- src/auth.ts\n";
      const runDir = join(base, "run");
      mkdirSync(runDir);
      writeFileSync(
        join(runDir, "trace.json"),
        JSON.stringify(
          seededTrace({
            seed: seedDoc({ added: 0, modified: 2, deleted: 0 }),
            patch: { base: "seeded", state: "partial" },
          }),
        ),
      );
      writeFileSync(join(runDir, "patch.diff"), cut);
      writeFileSync(
        join(runDir, "artifacts.json"),
        JSON.stringify({
          artifacts: [
            {
              path: "patch.diff",
              kind: "patch",
              digest: sha256(cut),
              truncated: true,
            },
          ],
        }),
      );
      const result = await evaluate(runDir, specPath);
      const entry = result.evaluations[0];
      expect(entry.verdict).toBe("unknown");
      expect(entry.reason).toContain("partial");
      expect(
        entry.evidence.some(
          (e) => e.source === "trace" && e.pointer === "/patch/state",
        ),
      ).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("evaluates the sealed prefix of a truncated patch normally", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(
        base,
        specDoc([{ id: "mod", kind: "file-modified", path: "other.ts" }]),
      );
      const cut =
        "--- other.ts\n+++ other.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n--- src/auth.ts\n";
      const runDir = join(base, "run");
      mkdirSync(runDir);
      writeFileSync(
        join(runDir, "trace.json"),
        JSON.stringify(
          seededTrace({
            seed: seedDoc({ added: 0, modified: 2, deleted: 0 }),
            patch: { base: "seeded", state: "partial" },
          }),
        ),
      );
      writeFileSync(join(runDir, "patch.diff"), cut);
      writeFileSync(
        join(runDir, "artifacts.json"),
        JSON.stringify({
          artifacts: [
            {
              path: "patch.diff",
              kind: "patch",
              digest: sha256(cut),
              truncated: true,
            },
          ],
        }),
      );
      const result = await evaluate(runDir, specPath);
      expect(result.evaluations[0].verdict).toBe("pass");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("evaluates a legacy run's file-added but never modification", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, {
        specVersion: 1,
        rubricId: "r",
        task: { digest: "sha256:task-x" },
        criteria: [
          { id: "added", kind: "file-added", path: "README.md" },
          { id: "mod", kind: "file-modified", path: "x.ts" },
        ],
      });
      const runDir = writeRun(base, "run", {
        trace: legacyTrace(),
        patch: legacyPatch,
        result: null,
      });
      const result = await evaluate(runDir, specPath);
      const verdicts = Object.fromEntries(
        result.evaluations.map((e) => [e.criterionId, e.verdict]),
      );
      expect(verdicts).toEqual({ added: "pass", mod: "unknown" });
      expect(result.inputs.run.seeded).toBe(false);
      expect(result.inputs.run.patchRecord).toEqual({
        base: "empty",
        state: "complete",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves an omitted file unknown on a trace predating the patch record", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(
        base,
        specDoc([
          { id: "added", kind: "file-added", path: "test/auth.test.ts" },
          { id: "mod", kind: "file-modified", path: "src/auth.ts" },
        ]),
      );
      const noPatchRecord = seededTrace({
        diagnostics: ["patch: 1 binary file(s) omitted"],
      });
      delete noPatchRecord.patch;
      const runDir = writeRun(base, "run", {
        trace: noPatchRecord,
        patch: "--- src/auth.ts\n+++ src/auth.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n",
      });
      const result = await evaluate(runDir, specPath);
      const verdicts = Object.fromEntries(
        result.evaluations.map((e) => [e.criterionId, e.verdict]),
      );
      expect(verdicts).toEqual({ added: "unknown", mod: "pass" });
      const added = result.evaluations.find((e) => e.criterionId === "added")!;
      expect(
        added.evidence.some(
          (e) => e.source === "trace" && e.pointer === "/diagnostics/0",
        ),
      ).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    ["result: no final message emitted", "not-emitted"],
    ["result: final message could not be parsed", "parse-failed"],
    ["result: save failed; result.txt not recorded", "save-failed"],
  ])(
    "reports final-result criteria unknown when %s",
    async (diagnostic, expected) => {
      const base = tmp();
      try {
        const specPath = writeSpec(
          base,
          specDoc([
            {
              id: "mentions",
              kind: "final-result-contains",
              text: "expiry",
            },
          ]),
        );
        const runDir = writeRun(base, "run", {
          trace: seededTrace({ diagnostics: [diagnostic] }),
          result: null,
        });
        const result = await evaluate(runDir, specPath);
        const entry = result.evaluations[0];
        expect(entry.verdict).toBe("unknown");
        expect(entry.reason).toContain(expected);
        expect(
          entry.evidence.some(
            (e) => e.source === "trace" && e.pointer === "/diagnostics/0",
          ),
        ).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("fails a json-field criterion on verified non-JSON result text", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(
        base,
        specDoc([
          {
            id: "status",
            kind: "final-result-json-field",
            pointer: "/status",
            equals: "fixed",
          },
        ]),
      );
      const runDir = writeRun(base, "run", { result: "plain prose answer\n" });
      const result = await evaluate(runDir, specPath);
      expect(result.evaluations[0].verdict).toBe("fail");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("passes and fails final-result-exact on normalized text only", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(
        base,
        specDoc([{ id: "exact", kind: "final-result-exact", text: "a\nb" }]),
      );
      const passDir = writeRun(base, "pass", { result: "a\r\nb" });
      const failDir = writeRun(base, "fail", { result: "a\nb\n" });
      expect((await evaluate(passDir, specPath)).evaluations[0].verdict).toBe(
        "pass",
      );
      expect((await evaluate(failDir, specPath)).evaluations[0].verdict).toBe(
        "fail",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("evaluates an empty verified result and cites a valid byte range", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(
        base,
        specDoc([
          { id: "mentions", kind: "final-result-contains", text: "expiry" },
        ]),
      );
      const runDir = writeRun(base, "run", { result: "" });
      const result = await evaluate(runDir, specPath);
      const entry = result.evaluations[0];
      expect(entry.verdict).toBe("fail");
      const resultRef = entry.evidence.find((e) => e.source === "result")!;
      expect(resultRef.bytes).toEqual({ start: 0, end: 0 });
      expect(resultRef.lines).toBeUndefined();
      expect(validateV6(result), JSON.stringify(validateV6.errors)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "the spec's task digest",
      { task: { digest: "sha256:other-task" } },
      "task.digest",
    ],
    [
      "the spec's baseline digest",
      { baseline: { digest: "sha256:other-base" } },
      "baseline",
    ],
  ])(
    "rejects evaluation when %s does not match the run",
    async (_name, overrides, field) => {
      const base = tmp();
      try {
        const spec = {
          ...specDoc(defaultCriteria()),
          ...overrides,
        } as Record<string, unknown>;
        const specPath = writeSpec(base, spec);
        const runDir = writeRun(base, "run", {});
        await expect(evaluate(runDir, specPath)).rejects.toMatchObject({
          code: "mismatched-inputs",
          message: expect.stringContaining(field),
        });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("rejects a spec declaring a baseline against a legacy run", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, specDoc());
      const runDir = writeRun(base, "run", {
        trace: legacyTrace(),
        patch: legacyPatch,
      });
      await expect(evaluate(runDir, specPath)).rejects.toMatchObject({
        code: "mismatched-inputs",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never produces a pass from unverifiable evidence", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, specDoc());
      const runDir = writeRun(base, "run", {
        trace: seededTrace({
          patch: { base: "seeded", state: "absent" },
          seed: seedDoc(null),
        }),
        patch: null,
        result: null,
      });
      const result = await evaluate(runDir, specPath);
      for (const entry of result.evaluations)
        expect(entry.verdict).toBe("unknown");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("check reports", () => {
  async function evaluateWithReports(
    runDir: string,
    specPath: string,
    reports: string[],
  ) {
    return evaluateRun({
      run: await readEvaluatedRun(runDir),
      spec: await readTaskSpec(specPath),
      checkReports: await loadCheckReports(reports),
      labels: { run: runDir, spec: specPath },
    });
  }

  const externalSpec = () =>
    specDoc([
      { id: "unit", kind: "external-check" },
      { id: "lint", kind: "external-check" },
    ]);

  it("applies pass and fail verdicts from accepted reports", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, externalSpec());
      const report = writeReport(base, "r.json", {
        reportVersion: 1,
        evaluator: { id: "vitest", version: "3" },
        subject: { taskDigest: "sha256:task-x" },
        results: [
          { criterionId: "unit", verdict: "pass" },
          { criterionId: "lint", verdict: "fail" },
        ],
      });
      const runDir = writeRun(base, "run", {});
      const result = await evaluateWithReports(runDir, specPath, [report]);
      const verdicts = Object.fromEntries(
        result.evaluations.map((e) => [e.criterionId, e.verdict]),
      );
      expect(verdicts).toEqual({ unit: "pass", lint: "fail" });
      const rowEvidence = result.evaluations[0].evidence.find(
        (e) => e.source === "checkReport",
      );
      expect(rowEvidence!.pointer).toBe("/results/0");
      expect(result.inputs.checkReports[0].state).toBe("accepted");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks a subject-mismatched report and leaves criteria unknown", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, externalSpec());
      const runDir = writeRun(base, "run", {});
      const result = await evaluateWithReports(runDir, specPath, [
        fixture("evaluation/check-report-mismatched.json"),
      ]);
      expect(result.inputs.checkReports[0].state).toBe("mismatched");
      for (const entry of result.evaluations)
        expect(entry.verdict).toBe("unknown");
      expect(validateV6(result), JSON.stringify(validateV6.errors)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks a malformed report invalid and leaves criteria unknown", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, externalSpec());
      writeFileSync(join(base, "bad.json"), "{ not json");
      const runDir = writeRun(base, "run", {});
      const result = await evaluateWithReports(runDir, specPath, [
        join(base, "bad.json"),
      ]);
      expect(result.inputs.checkReports[0].state).toBe("invalid");
      for (const entry of result.evaluations)
        expect(entry.verdict).toBe("unknown");
      expect(validateV6(result), JSON.stringify(validateV6.errors)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves an unreported criterion unknown and ignores foreign rows", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, externalSpec());
      const report = writeReport(base, "r.json", {
        reportVersion: 1,
        evaluator: { id: "e" },
        subject: { taskDigest: "sha256:task-x" },
        results: [
          { criterionId: "unit", verdict: "pass" },
          { criterionId: "mod", verdict: "fail" },
        ],
      });
      const runDir = writeRun(base, "run", {});
      const result = await evaluateWithReports(runDir, specPath, [report]);
      const verdicts = Object.fromEntries(
        result.evaluations.map((e) => [e.criterionId, e.verdict]),
      );
      // The 'mod' row is ignored (not external-check); 'lint' has no row.
      expect(verdicts).toEqual({ unit: "pass", lint: "unknown" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps a criterion unknown on conflicting duplicate rows", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, externalSpec());
      const report = writeReport(base, "r.json", {
        reportVersion: 1,
        evaluator: { id: "e" },
        subject: { taskDigest: "sha256:task-x" },
        results: [
          { criterionId: "unit", verdict: "pass" },
          { criterionId: "unit", verdict: "fail" },
          { criterionId: "lint", verdict: "pass" },
          { criterionId: "lint", verdict: "pass" },
        ],
      });
      const runDir = writeRun(base, "run", {});
      const result = await evaluateWithReports(runDir, specPath, [report]);
      const verdicts = Object.fromEntries(
        result.evaluations.map((e) => [e.criterionId, e.verdict]),
      );
      expect(verdicts).toEqual({ unit: "unknown", lint: "pass" });
      expect(result.evaluations[0].reason).toContain("conflicting");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves criteria unknown when no report is supplied", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, externalSpec());
      const runDir = writeRun(base, "run", {});
      const result = await evaluateWithReports(runDir, specPath, []);
      for (const entry of result.evaluations)
        expect(entry.verdict).toBe("unknown");
      expect(validateV6(result), JSON.stringify(validateV6.errors)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a report whose declared patch digest differs", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, externalSpec());
      const report = writeReport(base, "r.json", {
        reportVersion: 1,
        evaluator: { id: "e" },
        subject: {
          taskDigest: "sha256:task-x",
          patchDigest: sha256("not-the-patch"),
        },
        results: [{ criterionId: "unit", verdict: "pass" }],
      });
      const runDir = writeRun(base, "run", {});
      const result = await evaluateWithReports(runDir, specPath, [report]);
      expect(result.inputs.checkReports[0].state).toBe("mismatched");
      expect(result.evaluations[0].verdict).toBe("unknown");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("compareEvaluations", () => {
  async function compare(
    beforeDir: string,
    afterDir: string,
    specPath: string,
    beforeReports: string[] = [],
    afterReports: string[] = [],
  ) {
    return compareEvaluations({
      before: await readEvaluatedRun(beforeDir),
      after: await readEvaluatedRun(afterDir),
      spec: await readTaskSpec(specPath),
      beforeCheckReports: await loadCheckReports(beforeReports),
      afterCheckReports: await loadCheckReports(afterReports),
      labels: { before: beforeDir, after: afterDir, spec: specPath },
    });
  }

  it("reports pass→fail, unchanged, and external transitions on fixtures", async () => {
    const result = await compare(
      fixture("yuurei-run/seeded-a"),
      fixture("yuurei-run/seeded-b"),
      fixture("evaluation/task-spec.json"),
      [fixture("evaluation/check-report-a.json")],
      [fixture("evaluation/check-report-b.json")],
    );
    expect(validateV7(result), JSON.stringify(validateV7.errors)).toBe(true);
    const transitions = Object.fromEntries(
      result.transitions.map((t) => [
        t.criterionId,
        [t.before, t.after, t.changed],
      ]),
    );
    expect(transitions["auth-fixed"]).toEqual(["pass", "fail", true]);
    expect(transitions["tests-added"]).toEqual(["pass", "fail", true]);
    expect(transitions["legacy-removed"]).toEqual(["pass", "fail", true]);
    expect(transitions["answer-status"]).toEqual(["pass", "fail", true]);
    expect(transitions["answer-mentions-expiry"]).toEqual([
      "pass",
      "pass",
      false,
    ]);
    expect(transitions["unit-tests"]).toEqual(["pass", "fail", true]);
  });

  it("reports fail→pass and unknown→pass transitions", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(
        base,
        specDoc([
          { id: "mod", kind: "file-modified", path: "src/auth.ts" },
          { id: "mentions", kind: "final-result-contains", text: "expiry" },
          { id: "unit", kind: "external-check" },
        ]),
      );
      const beforeDir = writeRun(base, "before", {
        patch: "--- other.ts\n+++ other.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n",
        result: null,
        trace: seededTrace({
          seed: seedDoc({ added: 0, modified: 1, deleted: 0 }),
          diagnostics: ["result: no final message emitted"],
        }),
      });
      const afterDir = writeRun(base, "after", {});
      const report = writeReport(base, "r.json", {
        reportVersion: 1,
        evaluator: { id: "e" },
        subject: { taskDigest: "sha256:task-x" },
        results: [{ criterionId: "unit", verdict: "pass" }],
      });
      const result = await compare(beforeDir, afterDir, specPath, [], [report]);
      const transitions = Object.fromEntries(
        result.transitions.map((t) => [t.criterionId, [t.before, t.after]]),
      );
      expect(transitions.mod).toEqual(["fail", "pass"]);
      expect(transitions.mentions).toEqual(["unknown", "pass"]);
      expect(transitions.unit).toEqual(["unknown", "pass"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "different baseline digests",
      seededTrace({
        seed: seedDoc(
          { added: 1, modified: 1, deleted: 1 },
          "sha256:base-other",
        ),
      }),
      "baseline",
    ],
    ["a legacy after run", legacyTrace(), "baseline"],
    [
      "a different task digest",
      seededTrace({ task: { source: "t", digest: "sha256:task-other" } }),
      "task.digest",
    ],
    [
      "a different requested model",
      seededTrace({
        model: { requested: "other-model", resolved: "m-1" },
      }),
      "model.requested",
    ],
  ])(
    "rejects the comparison when the after run records %s",
    async (_name, afterTrace, field) => {
      const base = tmp();
      try {
        const specPath = writeSpec(base, specDoc());
        const beforeDir = writeRun(base, "before", {});
        const afterDir = writeRun(base, "after", { trace: afterTrace });
        await expect(
          compare(beforeDir, afterDir, specPath),
        ).rejects.toMatchObject({
          code: "mismatched-inputs",
          message: expect.stringContaining(field),
        });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("rejects a seeded run against a legacy run under a baseline-free spec", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, {
        specVersion: 1,
        rubricId: "r",
        task: { digest: "sha256:task-x" },
        criteria: [{ id: "a", kind: "file-added", path: "x" }],
      });
      const beforeDir = writeRun(base, "before", {});
      const afterDir = writeRun(base, "after", { trace: legacyTrace() });
      await expect(
        compare(beforeDir, afterDir, specPath),
      ).rejects.toMatchObject({
        code: "mismatched-inputs",
        message: expect.stringContaining("workspace kinds"),
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("emits comparability caveats without blocking allowed differences", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(base, specDoc());
      const beforeDir = writeRun(base, "before", {
        trace: seededTrace({ yuurei_version: "0.3.0" }),
      });
      const afterDir = writeRun(base, "after", {
        trace: seededTrace({
          yuurei_version: "0.4.0",
        }),
      });
      const result = await compare(beforeDir, afterDir, specPath);
      expect(result.caveats.some((c) => c.field === "yuurei_version")).toBe(
        true,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("is deterministic: identical output for identical inputs", async () => {
    const first = await compare(
      fixture("yuurei-run/seeded-a"),
      fixture("yuurei-run/seeded-b"),
      fixture("evaluation/task-spec.json"),
      [fixture("evaluation/check-report-a.json")],
      [fixture("evaluation/check-report-b.json")],
    );
    const second = await compare(
      fixture("yuurei-run/seeded-a"),
      fixture("yuurei-run/seeded-b"),
      fixture("evaluation/task-spec.json"),
      [fixture("evaluation/check-report-a.json")],
      [fixture("evaluation/check-report-b.json")],
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("evaluate-run / compare-evaluations CLI", () => {
  const seededA = fixture("yuurei-run/seeded-a");
  const seededB = fixture("yuurei-run/seeded-b");
  const spec = fixture("evaluation/task-spec.json");
  const reportA = fixture("evaluation/check-report-a.json");
  const reportB = fixture("evaluation/check-report-b.json");

  it("runs evaluate-run in JSON and validates against schema v6", async () => {
    const out = JSON.parse(
      await runCli([
        "evaluate-run",
        "--run",
        seededA,
        "--spec",
        spec,
        "--check-report",
        reportA,
        "--format",
        "json",
      ]),
    );
    expect(validateV6(out), JSON.stringify(validateV6.errors)).toBe(true);
    expect(out.schemaVersion).toBe(6);
    expect(
      out.evaluations.every((e: { verdict: string }) => e.verdict === "pass"),
    ).toBe(true);
  });

  it("runs evaluate-run in human form with verdicts and evidence", async () => {
    const out = await runCli([
      "evaluate-run",
      "--run",
      seededA,
      "--spec",
      spec,
      "--check-report",
      reportA,
    ]);
    expect(out).toContain("[pass] criterion 'auth-fixed'");
    expect(out).toContain("confidence:");
    expect(out).toContain("evidence:");
    expect(out).toContain("checkReport:/results/0");
  });

  it("runs compare-evaluations in JSON and validates against schema v7", async () => {
    const out = JSON.parse(
      await runCli([
        "compare-evaluations",
        "--before",
        seededA,
        "--after",
        seededB,
        "--spec",
        spec,
        "--before-check-report",
        reportA,
        "--after-check-report",
        reportB,
        "--format",
        "json",
      ]),
    );
    expect(validateV7(out), JSON.stringify(validateV7.errors)).toBe(true);
    expect(out.schemaVersion).toBe(7);
    expect(
      out.transitions.some((t: { changed: boolean }) => t.changed === true),
    ).toBe(true);
  });

  it("runs compare-evaluations in human form", async () => {
    const out = await runCli([
      "compare-evaluations",
      "--before",
      seededA,
      "--after",
      seededB,
      "--spec",
      spec,
    ]);
    expect(out).toContain(
      "criterion 'auth-fixed' (file-modified): pass → fail",
    );
    expect(out).toContain("(unchanged)");
  });

  it("sanitizes hostile result text in human output", async () => {
    const base = tmp();
    try {
      const hostile = "ok \x1b[31mRED\x1b[0m $ {\u2028} end\n";
      const runDir = writeRun(base, "run", {
        result: hostile,
        patch: "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n",
        trace: seededTrace({
          seed: seedDoc({ added: 0, modified: 1, deleted: 0 }),
        }),
      });
      const specPath = writeSpec(base, {
        specVersion: 1,
        rubricId: "r",
        task: { digest: "sha256:task-x" },
        baseline: { digest: "sha256:base-1" },
        criteria: [
          {
            id: "exact",
            kind: "final-result-exact",
            text: "something-else",
          },
        ],
      });
      const out = await runCli([
        "evaluate-run",
        "--run",
        runDir,
        "--spec",
        specPath,
      ]);
      expect(out).not.toContain("\x1b[31m");
      expect(out).not.toContain("\u2028");
      expect(out).toContain("[fail]");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    [["evaluate-run"], "requires"],
    [["evaluate-run", "--run", seededA], "requires"],
    [["compare-evaluations", "--before", seededA, "--spec", spec], "requires"],
    [["evaluate-run", "--run", "-", "--spec", spec], "stdin"],
    [
      ["evaluate-run", "positional", "--run", seededA, "--spec", spec],
      "no positional",
    ],
    [
      ["evaluate-run", "--run", seededA, "--run", seededB, "--spec", spec],
      "already set",
    ],
  ])("rejects bad invocation %j with a usage error", async (args, message) => {
    await expect(runCli(args)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(message),
    });
  });

  it("exits 3 when the spec does not bind to the run", async () => {
    const base = tmp();
    try {
      const specPath = writeSpec(
        base,
        specDoc([{ id: "a", kind: "file-added", path: "x" }]),
      );
      await expect(
        runCli(["evaluate-run", "--run", seededA, "--spec", specPath]),
      ).rejects.toMatchObject({ code: "mismatched-inputs" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
