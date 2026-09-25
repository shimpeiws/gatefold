import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const bin = `${root}bin/gatefold.js`;
const fixture = (name: string): string =>
  `${root}test/fixtures/pfl-export/${name}`;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function gatefold(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [bin, ...args],
      { cwd: root },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

const schema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v1.json`, "utf8"),
);
const validate = new Ajv2020().compile(schema);

beforeAll(async () => {
  // bin/gatefold.js runs dist/; build so e2e never tests a stale artifact.
  await execFileAsync("pnpm", ["build"], { cwd: root });
}, 120_000);

describe("gatefold e2e (real process)", () => {
  it("valid export exits 0 with schema-valid JSON on stdout", async () => {
    const run = await gatefold([
      fixture("valid-report.json"),
      "--format",
      "json",
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(result.schemaVersion).toBe(1);
    expect(result.claims.length).toBeGreaterThan(0);
  });

  it("emits one finding claim per pfl finding with provenance", async () => {
    const run = await gatefold([
      fixture("valid-report.json"),
      "--format",
      "json",
    ]);
    const result = JSON.parse(run.stdout);
    const source = JSON.parse(
      readFileSync(fixture("valid-report.json"), "utf8"),
    );
    const findings = result.claims.filter(
      (c: { provenance: { transform: string[] } }) =>
        c.provenance.transform.includes("rule:finding-reported"),
    );
    expect(findings).toHaveLength(source.data.findings.length);
    for (const claim of result.claims) {
      expect(claim.provenance.sourceFile).toBe(fixture("valid-report.json"));
      expect(claim.provenance.exportVersion).toBe(source.pflVersion);
    }
  });

  it("human output lists claims with confidence and evidence", async () => {
    const run = await gatefold([fixture("valid-report.json")]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("1. The export describes");
    expect(run.stdout).toContain("confidence:");
    expect(run.stdout).toContain("evidence:");
  });

  it("--min-confidence filters end-to-end without altering claims", async () => {
    const all = JSON.parse(
      (
        await gatefold([
          fixture("valid-report-partial.json"),
          "--format",
          "json",
        ])
      ).stdout,
    );
    const filtered = JSON.parse(
      (
        await gatefold([
          fixture("valid-report-partial.json"),
          "--format",
          "json",
          "--min-confidence",
          "0.9",
        ])
      ).stdout,
    );
    expect(validate(filtered)).toBe(true);
    expect(filtered.claims).toEqual(
      all.claims.filter((c: { confidence: number }) => c.confidence >= 0.9),
    );
    expect(filtered.claims.length).toBeLessThan(all.claims.length);
    expect(filtered.schemaVersion).toBe(1);
  });

  it.each([
    ["malformed.json", "not valid JSON"],
    ["empty-file.json", "not valid JSON"],
    ["non-object.json", "an object at the top level"],
    ["invalid-shape.json", "must be"],
    ["invalid-diagnostics.json", "diagnostics"],
    ["wrong-command.json", "command"],
    ["failure-document.json", "failure document"],
    ["unsupported-version.json", "pflVersion"],
    ["unsupported-version-low.json", "pflVersion"],
  ])(
    "rejects %s with exit 3 and an actionable stderr message",
    async (name, hint) => {
      const run = await gatefold([fixture(name)]);
      expect(run.code).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
      expect(run.stderr.toLowerCase()).toContain(hint.toLowerCase());
    },
  );

  it("rejects usage errors with exit 2", async () => {
    for (const args of [
      [],
      ["--bogus"],
      [fixture("valid-report.json"), "--format", "yaml"],
      [fixture("valid-report.json"), "--min-confidence", "2"],
    ]) {
      const run = await gatefold(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
    }
  });

  it("maps a missing input file to exit 3", async () => {
    const run = await gatefold(["/nonexistent/missing.json"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("cannot read input file");
  });

  it("--help exits 0 and documents every option", async () => {
    const run = await gatefold(["--help"]);
    expect(run.code).toBe(0);
    for (const token of ["--format", "--min-confidence", "Exit codes"]) {
      expect(run.stdout).toContain(token);
    }
  });

  it("package.json ci:all covers the documented clean-install gate", () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
    const ci = pkg.scripts["ci:all"] as string;
    for (const step of ["typecheck", "lint", "format:check", "test", "build"]) {
      expect(ci).toContain(`pnpm ${step}`);
    }
  });
});
