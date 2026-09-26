import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { EXIT_USAGE, main, runCli } from "../src/cli.js";
import type { ComparisonResult } from "../src/domain/comparison.js";
import { PflExportError } from "../src/input/pfl-export.js";

const dir = new URL("fixtures/compare/", import.meta.url);
const pflDir = new URL("fixtures/pfl-export/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));
const pflFixture = (name: string): string =>
  fileURLToPath(new URL(name, pflDir));

const before = fixture("before.json");
const after = fixture("after.json");
const diff = fixture("diff.json");

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/claim-result.v3.json", import.meta.url)),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: true });
const validate = ajv.compile(schema);

async function compareJson(args: string[]): Promise<ComparisonResult> {
  return JSON.parse(await runCli(args));
}

describe("gatefold compare", () => {
  it("accepts a matching triple and emits a valid schema v3 result", async () => {
    const result = await compareJson([
      "compare",
      "--before",
      before,
      "--after",
      after,
      "--diff",
      diff,
      "--format",
      "json",
    ]);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(result.schemaVersion).toBe(3);
    expect(result.source.command).toBe("compare");
    expect(result.inputs.before.command).toBe("export");
    expect(result.inputs.before.observedSnapshotId).toBe("obs-aaa");
    expect(result.inputs.after.observedSnapshotId).toBe("obs-bbb");
    expect(result.inputs.diff.observedSnapshotIdA).toBe("obs-aaa");
    expect(result.inputs.diff.observedSnapshotIdB).toBe("obs-bbb");
    expect(result.inputs.before.label).toBe(before);
    expect(result.inputs.before.semanticsVersion).toBe("1.0.0");
    expect(result.inputs.before.classifierVersion).toBe("1.0.0");
    expect(result.inputs.diff.classifierVersionA).toBe("1.0.0");
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims.every((claim) => claim.ruleId)).toBe(true);
  });

  it("accepts --flag=value spellings and options before the subcommand", async () => {
    const result = await compareJson([
      "--format",
      "json",
      "compare",
      `--before=${before}`,
      `--after=${after}`,
      `--diff=${diff}`,
    ]);
    expect(result.schemaVersion).toBe(3);
  });

  it("prints a human-readable result", async () => {
    const output = await runCli([
      "compare",
      "--before",
      before,
      "--after",
      after,
      "--diff",
      diff,
    ]);
    expect(output).toContain("el-added");
    expect(output).toContain("evidence:");
  });

  it("rejects swapped exports with a swap hint (exit 3)", async () => {
    await expect(
      runCli(["compare", "--before", after, "--after", before, "--diff", diff]),
    ).rejects.toMatchObject({
      name: "PflExportError",
      code: "mismatched-inputs",
      message: expect.stringContaining("swap"),
    });
  });

  it("rejects exports whose snapshot ids do not bind to the diff", async () => {
    await expect(
      runCli([
        "compare",
        "--before",
        before,
        "--after",
        after,
        "--diff",
        fixture("diff-wrong-snapshots.json"),
      ]),
    ).rejects.toMatchObject({ code: "mismatched-inputs" });
  });

  it("rejects a project mismatch", async () => {
    await expect(
      runCli([
        "compare",
        "--before",
        before,
        "--after",
        fixture("after-wrong-project.json"),
        "--diff",
        diff,
      ]),
    ).rejects.toMatchObject({
      code: "mismatched-inputs",
      message: expect.stringContaining("different projects"),
    });
  });

  it("rejects a runtime mismatch", async () => {
    await expect(
      runCli([
        "compare",
        "--before",
        before,
        "--after",
        after,
        "--diff",
        fixture("diff-wrong-runtime.json"),
      ]),
    ).rejects.toMatchObject({
      code: "mismatched-inputs",
      message: expect.stringContaining("different runtimes"),
    });
  });

  it("rejects a wrong command for a role", async () => {
    await expect(
      runCli([
        "compare",
        "--before",
        pflFixture("valid-report.json"),
        "--after",
        after,
        "--diff",
        diff,
      ]),
    ).rejects.toMatchObject({
      code: "mismatched-inputs",
      message: expect.stringContaining("--before must be a pfl export"),
    });
    await expect(
      runCli([
        "compare",
        "--before",
        before,
        "--after",
        after,
        "--diff",
        before,
      ]),
    ).rejects.toMatchObject({
      code: "mismatched-inputs",
      message: expect.stringContaining("--diff must be a pfl diff"),
    });
  });

  it("rejects malformed and failed documents with the reader's errors", async () => {
    await expect(
      runCli([
        "compare",
        "--before",
        pflFixture("malformed.json"),
        "--after",
        after,
        "--diff",
        diff,
      ]),
    ).rejects.toMatchObject({ code: "invalid-json" });
    await expect(
      runCli([
        "compare",
        "--before",
        before,
        "--after",
        after,
        "--diff",
        pflFixture("diff-failure-document.json"),
      ]),
    ).rejects.toMatchObject({ code: "export-failed" });
  });

  it("rejects an unsupported pflVersion", async () => {
    await expect(
      runCli([
        "compare",
        "--before",
        pflFixture("unsupported-version.json"),
        "--after",
        after,
        "--diff",
        diff,
      ]),
    ).rejects.toMatchObject({ code: "unsupported-version" });
  });

  it("requires all three inputs", async () => {
    for (const args of [
      ["compare", "--after", after, "--diff", diff],
      ["compare", "--before", before, "--diff", diff],
      ["compare", "--before", before, "--after", after],
    ]) {
      await expect(runCli(args)).rejects.toMatchObject({
        exitCode: EXIT_USAGE,
      });
    }
  });

  it("rejects a second stdin input", async () => {
    await expect(
      runCli(["compare", "--before", "-", "--after", "-", "--diff", diff]),
    ).rejects.toMatchObject({ exitCode: EXIT_USAGE });
  });

  it("rejects duplicate flags and positional inputs in compare mode", async () => {
    await expect(
      runCli([
        "compare",
        "--before",
        before,
        "--before",
        before,
        "--after",
        after,
        "--diff",
        diff,
      ]),
    ).rejects.toMatchObject({ exitCode: EXIT_USAGE });
    await expect(
      runCli(["compare", before, "--after", after, "--diff", diff]),
    ).rejects.toMatchObject({ exitCode: EXIT_USAGE });
  });

  it("keeps 'compare' usable as a filename after '--'", async () => {
    await expect(runCli(["--", "compare"])).rejects.toMatchObject({
      name: "PflExportError",
      code: "unreadable-file",
    });
  });

  it("mismatched-inputs maps to the input-error exit code", async () => {
    const error = await runCli([
      "compare",
      "--before",
      after,
      "--after",
      before,
      "--diff",
      diff,
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PflExportError);
    expect(await main(["--help"])).toBe(0);
  });
});
