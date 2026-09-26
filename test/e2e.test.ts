import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function gatefold(args: string[], cwd = root): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [bin, ...args],
      { cwd },
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

function gatefoldWithStdin(
  args: string[],
  input: string | Buffer,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [bin, ...args],
      { cwd: root },
      (error, stdout, stderr) => {
        resolve({
          code:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : -1,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
    // The child may destroy stdin early (oversized input); ignore EPIPE.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

const schema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v2.json`, "utf8"),
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
    expect(result.schemaVersion).toBe(2);
    expect(result.source).toEqual({
      pflVersion: "1.0.0",
      command: "report",
    });
    expect(result.claims.length).toBeGreaterThan(0);
    for (const claim of result.claims) {
      expect(typeof claim.ruleId).toBe("string");
      expect(claim.ruleId.length).toBeGreaterThan(0);
    }
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
    expect(filtered.schemaVersion).toBe(2);
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

  it("reads a pfl export from stdin when the input is '-'", async () => {
    const input = readFileSync(fixture("valid-report.json"), "utf8");
    const run = await gatefoldWithStdin(["-", "--format", "json"], input);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(result.claims.length).toBeGreaterThan(0);
    for (const claim of result.claims) {
      expect(claim.provenance.sourceFile).toBe("<stdin>");
    }
  });

  it("produces human-readable claims from stdin", async () => {
    const input = readFileSync(fixture("valid-report.json"), "utf8");
    const run = await gatefoldWithStdin(["-"], input);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("1. The export describes");
    expect(run.stdout).toContain("<stdin>");
  });

  it("accepts a BOM-prefixed export on stdin", async () => {
    const input = readFileSync(fixture("valid-report.json"), "utf8");
    const run = await gatefoldWithStdin(["-"], "\uFEFF" + input);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("The export describes");
  });

  it("rejects malformed stdin with the input-error exit code", async () => {
    const run = await gatefoldWithStdin(["-"], "{ not json");
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("not valid JSON");
  });

  it("rejects oversized stdin with the input-error exit code", async () => {
    const input = Buffer.alloc(17 * 1024 * 1024, 0x20);
    const run = await gatefoldWithStdin(["-"], input);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("byte limit");
  });

  it("reads a file literally named '-' after --", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gatefold-dash-"));
    try {
      writeFileSync(
        join(tmp, "-"),
        readFileSync(fixture("valid-report-minimal.json")),
      );
      const run = await gatefold(["--", "-"], tmp);
      expect(run.code).toBe(0);
      const json = await gatefold(["--format", "json", "--", "-"], tmp);
      expect(json.code).toBe(0);
      const result = JSON.parse(json.stdout);
      for (const claim of result.claims) {
        expect(claim.provenance.sourceFile).toBe("-");
      }
      expect(run.stdout).toContain("The export describes");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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
    expect(JSON.parse(run.stdout).schemaVersion).toBe(2);
  });

  it("package metadata exposes the gatefold binary and library entry", () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
    expect(pkg.name).toBe("@shimpeiws/gatefold");
    expect(pkg.bin.gatefold).toBe("./bin/gatefold.js");
    expect(pkg.engines.node).toBe(">=22.12.0");
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
      "docs/v0.3-scope.md",
      "schema/claim-result.v1.json",
      "schema/claim-result.v2.json",
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
  }, 15_000);

  it("accepts a full pfl export from a file with schema-valid output", async () => {
    const run = await gatefold([
      fixture("valid-export.json"),
      "--format",
      "json",
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(result.schemaVersion).toBe(2);
    expect(result.source).toEqual({
      pflVersion: "1.0.0",
      command: "export",
    });
    expect(result.claims.length).toBeGreaterThan(0);
  });

  it("accepts a full pfl export from stdin", async () => {
    const input = readFileSync(fixture("valid-export.json"), "utf8");
    const run = await gatefoldWithStdin(["-", "--format", "json"], input);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(result.source.command).toBe("export");
    for (const claim of result.claims) {
      expect(claim.provenance.sourceFile).toBe("<stdin>");
    }
  });

  it("produces human-readable claims for a pfl export", async () => {
    const run = await gatefold([fixture("valid-export.json")]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("1. The export describes");
    expect(run.stdout).toContain("confidence:");
    expect(run.stdout).toContain("rule:");
  });

  it("accepts empty and partial pfl exports", async () => {
    for (const name of [
      "valid-export-empty.json",
      "valid-export-partial.json",
    ]) {
      const run = await gatefold([fixture(name), "--format", "json"]);
      expect(run.code, name).toBe(0);
      expect(run.stderr, name).toBe("");
      const result = JSON.parse(run.stdout);
      expect(validate(result), name).toBe(true);
      expect(result.source.command, name).toBe("export");
      expect(result.claims.length, name).toBeGreaterThan(0);
    }
    const partial = JSON.parse(
      (
        await gatefold([
          fixture("valid-export-partial.json"),
          "--format",
          "json",
        ])
      ).stdout,
    );
    expect(
      partial.claims.some((c: { claim: string }) =>
        c.claim.includes("'partial'"),
      ),
    ).toBe(true);
  });

  it.each([
    "export-failure-document.json",
    "unsupported-command-diff.json",
    "export-invalid-shape.json",
    "export-mismatched-join.json",
    "export-wrong-enum.json",
  ])(
    "rejects invalid export %s with exit 3 and a stderr-only error",
    async (name) => {
      const run = await gatefold([fixture(name)]);
      expect(run.code).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
      expect(run.stderr.trim().length).toBeGreaterThan(10);
    },
  );

  it("names the offending element when joined ids mismatch", async () => {
    const run = await gatefold([fixture("export-mismatched-join.json")]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("joins mismatched ids");
    expect(run.stderr).toContain("el_0fc92802d8f84176");
  });

  it("produces byte-identical output across runs for the same export", async () => {
    const first = await gatefold([
      fixture("valid-export.json"),
      "--format",
      "json",
    ]);
    const second = await gatefold([
      fixture("valid-export.json"),
      "--format",
      "json",
    ]);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
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
