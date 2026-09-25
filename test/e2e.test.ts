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
  const pm = process.env.npm_execpath ?? "pnpm";
  const isScript = pm.endsWith(".js") || pm.endsWith(".cjs");
  await execFileAsync(
    isScript ? process.execPath : pm,
    [...(isScript ? [pm] : []), "build"],
    { cwd: root, timeout: 90_000 },
  );
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
    // Pin the fixture to multiple findings so the mapping is non-vacuous.
    expect(source.data.findings.length).toBeGreaterThan(1);
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
    expect(run.stdout).toContain("provenance:");
    expect(run.stdout).toContain("rule:");
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
    expect(validate(filtered), JSON.stringify(validate.errors)).toBe(true);
    expect(filtered.claims).toEqual(
      all.claims.filter((c: { confidence: number }) => c.confidence >= 0.9),
    );
    expect(filtered.claims.length).toBeLessThan(all.claims.length);
    expect(filtered.schemaVersion).toBe(1);
  });

  it.each([
    "malformed.json",
    "empty-file.json",
    "non-object.json",
    "invalid-shape.json",
    "invalid-diagnostics.json",
    "wrong-command.json",
    "failure-document.json",
    "unsupported-version.json",
    "unsupported-version-low.json",
  ])("rejects %s with exit 3 and a stderr-only error", async (name) => {
    const run = await gatefold([fixture(name)]);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("gatefold:");
    expect(run.stderr.trim().length).toBeGreaterThan(10);
  });

  it("error messages are actionable: they name the file and the reason", async () => {
    const run = await gatefold([fixture("malformed.json")]);
    expect(run.stderr).toContain("not valid JSON");
    expect(run.stderr).toContain("malformed.json");
  });

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

  it("treats a bare -- as end of options at the process boundary", async () => {
    const run = await gatefold([
      "--format",
      "json",
      "--",
      fixture("valid-report.json"),
    ]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).schemaVersion).toBe(1);
  });

  it("package metadata exposes the gatefold binary and library entry", () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
    expect(pkg.name).toBe("@shimpeiws/gatefold");
    expect(pkg.bin.gatefold).toBe("./bin/gatefold.js");
    expect(pkg.engines.node).toBe(">=20");
    expect(pkg.license).toBe("MIT");
    expect(pkg.publishConfig.access).toBe("public");
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.exports["."].default).toBe("./dist/src/index.js");
    const binSource = readFileSync(`${root}bin/gatefold.js`, "utf8");
    expect(binSource.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("npm pack --dry-run ships the CLI, dist, docs, and schema only", async () => {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--dry-run", "--json"],
      { cwd: root, timeout: 60_000 },
    );
    const [{ files }] = JSON.parse(stdout);
    const names = files.map((f: { path: string }) => f.path);
    for (const required of [
      "LICENSE",
      "bin/gatefold.js",
      "dist/src/cli.js",
      "dist/src/index.js",
      "dist/src/index.d.ts",
      "docs/overview.md",
      "docs/release-checklist.md",
      "schema/claim-result.v1.json",
      "README.md",
      "package.json",
    ]) {
      expect(names, required).toContain(required);
    }
    for (const forbidden of [
      "test",
      "node_modules",
      "src",
      ".letta",
      "dist/test",
    ]) {
      const hits = names.filter(
        (n: string) => n === forbidden || n.startsWith(`${forbidden}/`),
      );
      expect(hits, forbidden).toEqual([]);
    }
  });

  it("package.json ci:all is exactly the documented clean-install gate", () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
    const steps = (pkg.scripts["ci:all"] as string)
      .split("&&")
      .map((s) => s.trim());
    expect(steps).toEqual([
      "pnpm typecheck",
      "pnpm lint",
      "pnpm format:check",
      "pnpm test --run",
      "pnpm build",
    ]);
  });
});
