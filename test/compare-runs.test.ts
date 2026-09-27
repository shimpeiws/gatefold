import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/application/compare-runs.js";
import type {
  RunClaim,
  RunComparisonResult,
} from "../src/domain/run-comparison.js";
import { readYuureiRun } from "../src/input/yuurei-run.js";
import { formatRunComparisonHuman } from "../src/output/human.js";

const dir = new URL("fixtures/yuurei-run/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/claim-result.v5.json", import.meta.url)),
    "utf8",
  ),
);
const ajv = new Ajv2020();
const validate = ajv.compile(schema);

async function load(before: string, after: string) {
  return compareRuns({
    before: await readYuureiRun(fixture(before)),
    after: await readYuureiRun(fixture(after)),
    labels: { before, after },
  });
}

function runClaims(result: RunComparisonResult): RunClaim[] {
  return result.claims.filter((claim) => claim.ruleId.startsWith("run-"));
}

function claimsByRule(result: RunComparisonResult, ruleId: string): RunClaim[] {
  return result.claims.filter((claim) => claim.ruleId === ruleId);
}

function expectSchemaValid(result: RunComparisonResult): void {
  if (!validate(result))
    throw new Error(
      `result failed schema validation: ${JSON.stringify(validate.errors)}`,
    );
}

describe("compareRuns", () => {
  it("produces a schema-v5 result for a comparable pair", async () => {
    const result = await load("run-a", "run-b");
    expect(result.schemaVersion).toBe(5);
    expect(result.source).toEqual({ command: "compare-runs" });
    expect(result.inputs.beforeRun.document).toBe("yuurei-run");
    expect(result.inputs.beforeRun.label).toBe("run-a");
    expect(result.inputs.beforeRun.trace.document).toBe("yuurei-trace");
    expect(result.inputs.beforeRun.patchState).toBe("verified");
    expect(result.inputs.afterRun.patchState).toBe("verified");
    expectSchemaValid(result);
  });

  it("preserves the manifest facts of both sides verbatim", async () => {
    const result = await load("run-a", "run-b");
    for (const side of ["beforeRun", "afterRun"] as const) {
      const artifacts = result.inputs[side].artifacts;
      expect(artifacts.map((entry) => entry.path)).toEqual([
        "stdout.log",
        "stderr.log",
        "patch.diff",
      ]);
      const patch = artifacts.find((entry) => entry.path === "patch.diff")!;
      expect(patch.state).toBe("verified");
      expect(patch.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const logs = artifacts.filter((entry) => entry.kind === "log");
      for (const log of logs) expect(log.state).toBe("unverified");
    }
  });

  it("emits the trace rules' claims alongside the artifact claims", async () => {
    const result = await load("run-a", "run-b");
    const traceClaims = result.claims.filter(
      (claim) => !claim.ruleId.startsWith("run-"),
    );
    expect(traceClaims.length).toBeGreaterThan(0);
    for (const claim of traceClaims)
      for (const evidence of claim.evidence)
        expect(["beforeTrace", "afterTrace"]).toContain(evidence.source);
  });

  it("reports identical generated-file sets", async () => {
    const result = await load("run-a", "run-a2");
    const summary = claimsByRule(result, "run-generated-files");
    expect(summary).toHaveLength(1);
    expect(summary[0].claim).toContain("same");
    expect(claimsByRule(result, "run-file-added")).toEqual([]);
    expect(claimsByRule(result, "run-file-removed")).toEqual([]);
    expect(claimsByRule(result, "run-file-changed")).toEqual([]);
    expectSchemaValid(result);
  });

  it("reports added, removed, and changed files with bounded evidence", async () => {
    const result = await load("run-a", "run-b");

    const added = claimsByRule(result, "run-file-added");
    expect(added).toHaveLength(1);
    expect(added[0].claim).toContain("docs/guide.md");
    expect(added[0].claim).toContain("Run B");
    const addedPatch = added[0].evidence.find(
      (evidence) => evidence.source === "afterPatch",
    )!;
    expect(addedPatch.path).toBe("docs/guide.md");
    expect(addedPatch.digest).toMatch(/^sha256:/);
    expect(addedPatch.lines!.start).toBeGreaterThanOrEqual(1);
    expect(addedPatch.lines!.end).toBeGreaterThanOrEqual(
      addedPatch.lines!.start,
    );
    expect(addedPatch.bytes!.end).toBeGreaterThan(addedPatch.bytes!.start);
    const addedAbsent = added[0].evidence.find(
      (evidence) => evidence.source === "beforePatch",
    )!;
    expect(addedAbsent.pointer).toBe("/artifacts/2");

    const removed = claimsByRule(result, "run-file-removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].claim).toContain("src/util.ts");
    expect(removed[0].claim).toContain("Run A");

    const changed = claimsByRule(result, "run-file-changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].claim).toContain("README.md");
    // Each side's evidence names its own differing line region.
    for (const source of ["beforePatch", "afterPatch"]) {
      const reference = changed[0].evidence.find(
        (evidence) => evidence.source === source,
      )!;
      expect(reference.path).toBe("README.md");
      expect(reference.lines!.end).toBeGreaterThanOrEqual(
        reference.lines!.start,
      );
    }

    const summary = claimsByRule(result, "run-generated-files")[0];
    expect(summary.claim).toContain("1 identical");
    expect(summary.claim).toContain("1 changed");
    expect(summary.claim).toContain("recorded only by A");
    expect(summary.claim).toContain("recorded only by B");
    expectSchemaValid(result);
  });

  it("cites patch bytes that resolve inside the stored file", async () => {
    const result = await load("run-a", "run-b");
    const runs = {
      beforePatch: await readYuureiRun(fixture("run-a")),
      afterPatch: await readYuureiRun(fixture("run-b")),
    };
    for (const claim of runClaims(result)) {
      for (const evidence of claim.evidence) {
        if (
          evidence.source !== "beforePatch" &&
          evidence.source !== "afterPatch"
        )
          continue;
        if (evidence.bytes === undefined) continue;
        const bytes = runs[evidence.source].patchBytes!;
        expect(evidence.bytes.end).toBeLessThanOrEqual(bytes.length);
      }
    }
  });

  it("emits per-entry manifest claims for both sides", async () => {
    const result = await load("run-a", "run-b");
    const manifest = claimsByRule(result, "run-manifest");
    expect(manifest).toHaveLength(6);
    const patchClaims = manifest.filter((claim) =>
      claim.claim.includes("'patch.diff'"),
    );
    expect(patchClaims).toHaveLength(2);
    expect(patchClaims[0].evidence[0].pointer).toMatch(/^\/artifacts\/\d+$/);
  });

  it("marks a truncated patch as a caveat and compares only its prefix", async () => {
    const result = await load("run-truncated", "run-a");
    expect(result.inputs.beforeRun.patchState).toBe("verified-truncated");
    const caveat = claimsByRule(result, "run-patch-state");
    expect(caveat).toHaveLength(1);
    expect(caveat[0].claim).toContain("truncated");
    expect(caveat[0].claim).toContain("stored prefix");
    // The truncated run's only recorded file is README.md, also present in
    // run-a with different content; run-a's other two files read as added.
    const changed = claimsByRule(result, "run-file-changed");
    expect(changed.map((claim) => claim.claim)).toEqual(
      expect.arrayContaining([expect.stringContaining("README.md")]),
    );
    expect(claimsByRule(result, "run-file-added")).toHaveLength(2);
    expect(claimsByRule(result, "run-file-removed")).toEqual([]);
    expectSchemaValid(result);
  });

  it("keeps the unknown remainder caveat for a truncated complete prefix", async () => {
    const base = mkdtempSync(join(tmpdir(), "gatefold-runs-"));
    try {
      const trace = readFileSync(`${fixture("run-a")}/trace.json`, "utf8");
      const make = async (name: string, patch: string, truncated: boolean) => {
        const runDir = join(base, name);
        mkdirSync(runDir);
        writeFileSync(join(runDir, "trace.json"), trace);
        writeFileSync(join(runDir, "patch.diff"), patch);
        const digest = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
        writeFileSync(
          join(runDir, "artifacts.json"),
          JSON.stringify({
            artifacts: [
              { path: "patch.diff", kind: "patch", digest, truncated },
            ],
          }),
        );
        return readYuureiRun(runDir);
      };
      const completePrefix =
        "--- /dev/null\n+++ a.txt\n@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file\n";
      const result = compareRuns({
        before: await make("a", completePrefix, true),
        after: await make("b", completePrefix, false),
      });
      const summary = claimsByRule(result, "run-generated-files")[0].claim;
      expect(summary).toContain("truncated");
      expect(summary).toContain("unknown");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never claims a file whose block ends at the truncation boundary", async () => {
    const base = mkdtempSync(join(tmpdir(), "gatefold-runs-"));
    try {
      const trace = readFileSync(`${fixture("run-a")}/trace.json`, "utf8");
      const make = async (name: string, patch: string, truncated: boolean) => {
        const runDir = join(base, name);
        mkdirSync(runDir);
        writeFileSync(join(runDir, "trace.json"), trace);
        writeFileSync(join(runDir, "patch.diff"), patch);
        const digest = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
        writeFileSync(
          join(runDir, "artifacts.json"),
          JSON.stringify({
            artifacts: [
              { path: "patch.diff", kind: "patch", digest, truncated },
            ],
          }),
        );
        return readYuureiRun(runDir);
      };
      // B's stored bytes end right after b.txt's header — a.txt is a
      // sealed record, b.txt is the unknown tail.
      const full = "--- /dev/null\n+++ a.txt\n@@ -0,0 +1,1 @@\n+x\n";
      const result = compareRuns({
        before: await make("a", "", false),
        after: await make("b", `${full}--- /dev/null\n+++ b.txt\n`, true),
      });
      const added = claimsByRule(result, "run-file-added");
      expect(added.map((claim) => claim.claim)).toEqual([
        expect.stringContaining("'a.txt'"),
      ]);
      expectSchemaValid(result);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never claims a missing patch means no output", async () => {
    const result = await load("run-nopatch", "run-a");
    expect(result.inputs.beforeRun.patchState).toBe("not-recorded");
    const caveat = claimsByRule(result, "run-patch-state");
    expect(caveat).toHaveLength(1);
    expect(caveat[0].claim).toContain("no patch.diff entry");
    expect(caveat[0].claim).toContain("does not mean");
    // No file-level claims: the before side's record is unavailable.
    expect(claimsByRule(result, "run-file-added")).toEqual([]);
    expect(claimsByRule(result, "run-file-removed")).toEqual([]);
    expect(claimsByRule(result, "run-file-changed")).toEqual([]);
    const summary = claimsByRule(result, "run-generated-files")[0];
    expect(summary.claim).toContain("covers only run B's record");
    expectSchemaValid(result);
  });

  it("keeps an unverifiable digest as unknown, not as absent output", async () => {
    const result = await load("run-unreadable-diff", "run-b");
    expect(result.inputs.beforeRun.patchState).toBe("unverified");
    const caveat = claimsByRule(result, "run-patch-state")[0];
    expect(caveat.claim).toContain("not interpreted");
  });

  it("compares empty patches as identical zero-file sets", async () => {
    const result = await load("run-empty", "run-empty");
    const summary = claimsByRule(result, "run-generated-files")[0];
    expect(summary.claim).toContain("same");
    expect(summary.claim).toContain("0 generated files");
  });

  it("rejects incomparable traces before interpreting artifacts", async () => {
    const before = await readYuureiRun(fixture("run-a"));
    const after = await readYuureiRun(fixture("run-a"));
    // A manifest-level difference is fine; a task difference is not.
    const incompatible = {
      ...after,
      trace: {
        ...after.trace,
        task: { ...after.trace.task, digest: "sha256:other" },
      },
    };
    expect(() => compareRuns({ before, after: incompatible })).toThrowError(
      /task\.digest/,
    );
  });

  it("reports a trailing-newline-only difference explicitly", async () => {
    const base = mkdtempSync(join(tmpdir(), "gatefold-runs-"));
    try {
      const trace = readFileSync(`${fixture("run-a")}/trace.json`, "utf8");
      const make = async (name: string, patch: string) => {
        const runDir = join(base, name);
        mkdirSync(runDir);
        writeFileSync(join(runDir, "trace.json"), trace);
        writeFileSync(join(runDir, "patch.diff"), patch);
        const digest = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
        writeFileSync(
          join(runDir, "artifacts.json"),
          JSON.stringify({
            artifacts: [{ path: "patch.diff", kind: "patch", digest }],
          }),
        );
        return readYuureiRun(runDir);
      };
      const withNewline = "--- /dev/null\n+++ f.txt\n@@ -0,0 +1,1 @@\n+x\n";
      const withoutNewline = `${withNewline}\\ No newline at end of file\n`;
      const result = compareRuns({
        before: await make("a", withNewline),
        after: await make("b", withoutNewline),
      });
      const changed = claimsByRule(result, "run-file-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0].claim).toContain("trailing-newline");
      expect(changed[0].claim).toContain("f.txt");
      expectSchemaValid(result);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("is deterministic across repeated runs", async () => {
    const first = await load("run-a", "run-b");
    const second = await load("run-a", "run-b");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
