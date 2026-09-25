import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliError,
  EXIT_INPUT,
  EXIT_INTERNAL,
  EXIT_USAGE,
  exitCodeForError,
  filterClaims,
  main,
  runCli,
} from "../src/cli.js";
import type { AnalysisResult } from "../src/domain/claim.js";
import { PflExportError } from "../src/input/pfl-export.js";
import { formatHuman } from "../src/output/human.js";

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
    expect(output).toContain("provenance:");
  });

  it("human output renders cited element ids next to their pointers", async () => {
    const output = await runCli([valid]);
    expect(output).toContain(
      "/data/findings/0/elementIds/0 (claude-code:user:rules/style.md)",
    );
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
    for (const value of ["1.5", "-0.1", "abc", "0x1", "1e0", ""]) {
      await expect(
        runCli([valid, "--min-confidence", value]),
      ).rejects.toMatchObject({ exitCode: EXIT_USAGE });
    }
    for (const arg of ["--min-confidence=", "--min-confidence= "]) {
      await expect(runCli([valid, arg])).rejects.toMatchObject({
        exitCode: EXIT_USAGE,
      });
    }
    await expect(runCli([valid, "--min-confidence"])).rejects.toMatchObject({
      exitCode: EXIT_USAGE,
    });
  });

  it("treats a bare -- as end of options", async () => {
    const parsed = await parseJson(["--format", "json", "--", valid]);
    expect(parsed.schemaVersion).toBe(1);
    // After --, a leading-dash token is a positional, not an option.
    await expect(runCli(["--", valid, "--bogus"])).rejects.toMatchObject({
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

  it("produces a schema-valid result when the filter empties the claim set", async () => {
    const all = await parseJson([valid, "--format", "json"]);
    const emptied = filterClaims(all, Number.MAX_SAFE_INTEGER);
    expect(emptied.claims).toEqual([]);
    expect(validate(emptied), JSON.stringify(validate.errors)).toBe(true);
    expect(formatHuman(emptied, 0.5)).toBe(
      "No claims found at or above confidence 0.50.",
    );
    expect(formatHuman(emptied)).toBe("No claims found.");
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
    expect(await main([fixture("malformed.json")])).toBe(EXIT_INPUT);
    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain("gatefold:");
    expect(await main(["--bogus"])).toBe(EXIT_USAGE);
    expect(await main(["--help"])).toBe(0);
  });

  it("maps a missing input file to the input exit code", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["/nonexistent/no-such-file.json"])).toBe(EXIT_INPUT);
  });

  it("resets process.exitCode after a success", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await main(["--bogus"]);
    expect(process.exitCode).toBe(EXIT_USAGE);
    await main([valid]);
    expect(process.exitCode).toBe(0);
  });
});
