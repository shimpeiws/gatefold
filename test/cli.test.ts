import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_INPUT,
  EXIT_INTERNAL,
  EXIT_USAGE,
  exitCodeForError,
  main,
  runCli,
} from "../src/cli.js";
import type { AnalysisResult } from "../src/domain/claim.js";
import { CliError } from "../src/cli.js";
import { PflExportError } from "../src/input/pfl-export.js";

const dir = new URL("fixtures/pfl-export/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));
const valid = fixture("valid-report.json");
const minimal = fixture("valid-report-minimal.json");

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/claim-result.v1.json", import.meta.url)),
    "utf8",
  ),
);
const ajv = new Ajv2020();
const validate = ajv.compile(schema);

async function parseJson(args: string[]): Promise<AnalysisResult> {
  return JSON.parse(await runCli(args));
}

describe("gatefold CLI", () => {
  it("returns JSON that validates against the claim-result schema", async () => {
    const parsed = await parseJson([valid, "--format", "json"]);
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.claims.length).toBeGreaterThan(0);
  });

  it("returns human-readable claims with confidence and evidence", async () => {
    const output = await runCli([minimal, "--format=human"]);
    expect(output).toContain("1. The export describes a 'codex' harness");
    expect(output).toContain("pfl observed 0 elements");
    expect(output).toContain("confidence: 1.00");
    expect(output).toContain("evidence: /data/");
  });

  it("--min-confidence filters claims without changing their contents", async () => {
    const partial = fixture("valid-report-partial.json");
    const all = await parseJson([partial, "--format", "json"]);
    const filtered = await parseJson([
      partial,
      "--format",
      "json",
      "--min-confidence",
      "0.9",
    ]);
    const expected = all.claims.filter((c) => c.confidence >= 0.9);
    expect(filtered.claims).toEqual(expected);
    expect(filtered.claims.length).toBeLessThan(all.claims.length);
    expect(filtered.schemaVersion).toBe(all.schemaVersion);
  });

  it("--min-confidence drops exactly the downgraded stats claims", async () => {
    const filtered = await parseJson([
      fixture("valid-report-partial.json"),
      "--format",
      "json",
      "--min-confidence=1",
    ]);
    for (const claim of filtered.claims) expect(claim.confidence).toBe(1);
    expect(filtered.claims.length).toBeGreaterThan(0);
    expect(
      filtered.claims.some((c) =>
        c.provenance.transform.includes("rule:element-counts"),
      ),
    ).toBe(false);
  });

  it("filtered output still validates against the schema", async () => {
    const filtered = await parseJson([
      fixture("valid-report-partial.json"),
      "--format",
      "json",
      "--min-confidence",
      "0.85",
    ]);
    expect(validate(filtered), JSON.stringify(validate.errors)).toBe(true);
  });

  it("prints usage covering every v0.1 option", async () => {
    const help = await runCli(["--help"]);
    expect(help).toContain("Usage: gatefold");
    expect(help).toContain("--format");
    expect(help).toContain("--min-confidence");
    expect(help).toContain("Exit codes");
  });

  it("rejects invalid --min-confidence values", async () => {
    for (const value of ["1.5", "-0.1", "abc"]) {
      await expect(
        runCli([valid, "--min-confidence", value]),
      ).rejects.toMatchObject({ exitCode: EXIT_USAGE });
    }
    await expect(runCli([valid, "--min-confidence"])).rejects.toMatchObject({
      exitCode: EXIT_USAGE,
    });
  });

  it("rejects unsupported formats and extra inputs", async () => {
    await expect(runCli([valid, "--format", "yaml"])).rejects.toMatchObject({
      exitCode: EXIT_USAGE,
    });
    await expect(runCli([valid, minimal])).rejects.toMatchObject({
      exitCode: EXIT_USAGE,
    });
    await expect(runCli([valid, "--bogus"])).rejects.toMatchObject({
      exitCode: EXIT_USAGE,
    });
  });

  it("requires an input file", async () => {
    await expect(runCli([])).rejects.toMatchObject({
      exitCode: EXIT_USAGE,
    });
  });

  it("maps each failure class to a distinct exit code", () => {
    expect(exitCodeForError(new CliError("x", EXIT_USAGE))).toBe(EXIT_USAGE);
    expect(exitCodeForError(new PflExportError("invalid-json", "x"))).toBe(
      EXIT_INPUT,
    );
    expect(exitCodeForError(new Error("x"))).toBe(EXIT_INTERNAL);
  });
});

describe("gatefold CLI main()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("writes output to stdout and returns 0", async () => {
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = await main([valid, "--format", "json"]);
    expect(code).toBe(0);
    const written = out.mock.calls.map((c) => String(c[0])).join("");
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it("writes errors to stderr only and returns the mapped code", async () => {
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    expect(await main([fixture("malformed-json.json")])).toBe(EXIT_INPUT);
    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain("gatefold:");
    expect(await main(["--bogus"])).toBe(EXIT_USAGE);
    expect(await main(["--help"])).toBe(0);
  });
});
