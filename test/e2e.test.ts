import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/**
 * The display contract: no Unicode Cc/Cf/Zl/Zp character reaches stdout
 * verbatim — \t, \n, and \r are the formatter's own line/tab structure.
 */
const UNSAFE_DISPLAY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const displayBody = (stdout: string): string => stdout.replace(/[\t\n\r]/g, "");

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

  it("export element-layer claims are emitted per element per layer", async () => {
    const run = await gatefold([
      fixture("valid-export-layers.json"),
      "--format",
      "json",
    ]);
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    const count = (ruleId: string) =>
      result.claims.filter((c: { provenance: { transform: string[] } }) =>
        c.provenance.transform.includes(`rule:${ruleId}`),
      ).length;
    expect(count("element-observed-state")).toBe(5);
    expect(count("element-resolved-state")).toBe(3);
    expect(count("element-interpretation")).toBe(2);
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

  it("--version prints the package version and exits 0", async () => {
    const run = await gatefold(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
    expect(run.stdout.trim()).toBe(`gatefold ${pkg.version}`);
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
    expect(pkg.exports["./internal"].default).toBe("./dist/src/internal.js");
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
      "dist/src/internal.js",
      "dist/src/internal.d.ts",
      "docs/overview.md",
      "docs/release-checklist.md",
      "docs/v0.3-scope.md",
      "docs/v0.4-scope.md",
      "docs/v0.5-scope.md",
      "docs/v0.6-scope.md",
      "docs/v0.7-scope.md",
      "docs/yuurei-trace-contract.md",
      "docs/yuurei-run-contract.md",
      "docs/yuurei-seeded-run-contract.md",
      "schema/claim-result.v1.json",
      "schema/claim-result.v2.json",
      "schema/claim-result.v3.json",
      "schema/claim-result.v4.json",
      "schema/claim-result.v5.json",
      "schema/claim-result.v6.json",
      "schema/claim-result.v7.json",
      "schema/examples/valid-comparison-result.json",
      "schema/examples/valid-trace-comparison-result.json",
      "schema/examples/valid-run-comparison-result.json",
      "schema/examples/valid-evaluation-result.json",
      "schema/examples/valid-evaluation-comparison-result.json",
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

  it("rejects an export that would exceed the evidence ceiling with exit 3", async () => {
    const many = Array.from({ length: 8_000 }, (_, i) => {
      const id = `el_${i}`;
      return {
        id,
        observed: {
          id,
          native: { kind: "instructions", origin: "project", scope: "project" },
          source: { path: `doc-${i}.md` },
          inspectability: "observable",
          metadata: {},
          status: "observed",
        },
        resolved: {
          id,
          status: "effective",
          applicability: { type: "project" },
          activation: "always",
          resolution: { strategy: "accumulate", reason: "r" },
        },
        interpretation: {
          elementId: id,
          facets: ["instructions"],
          confidence: "high",
          reason: "r",
        },
      };
    });
    const doc = {
      pflVersion: "1.0.0",
      command: "export",
      ok: true,
      completeness: "complete",
      diagnostics: [],
      data: {
        project: { id: "p", displayName: "p" },
        runtime: {
          id: "claude-code",
          version: null,
          adapter: {
            id: "claude-code",
            version: "0.1.1",
            runtimeCompatibility: "verified",
          },
        },
        snapshot: {
          observedSnapshotId: "obs_1",
          resolvedSnapshotId: "res_1",
          capturedAt: "t",
          schemaVersion: "1",
        },
        resolution: { semanticsVersion: "2", confidence: "verified" },
        elements: many,
        relations: [],
        findings: [],
        interpretation: {
          classifier: { id: "pfl-native", version: "5" },
          origin: "stored",
        },
      },
    };
    const tmp = mkdtempSync(join(tmpdir(), "gatefold-ceiling-"));
    try {
      writeFileSync(join(tmp, "over-ceiling.json"), JSON.stringify(doc));
      const run = await gatefold([join(tmp, "over-ceiling.json")]);
      expect(run.code).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
      expect(run.stderr).toContain("evidence references");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts a pfl diff from a file with schema-valid output", async () => {
    const run = await gatefold([
      fixture("valid-diff.json"),
      "--format",
      "json",
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(result.schemaVersion).toBe(2);
    expect(result.source).toEqual({
      pflVersion: "1.4.0",
      command: "diff",
    });
    expect(result.claims.length).toBeGreaterThan(0);
  });

  it("accepts a pfl diff from stdin", async () => {
    const input = readFileSync(fixture("valid-diff.json"), "utf8");
    const run = await gatefoldWithStdin(["-", "--format", "json"], input);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(result.source.command).toBe("diff");
    for (const claim of result.claims) {
      expect(claim.provenance.sourceFile).toBe("<stdin>");
    }
  });

  it("produces human-readable claims for a pfl diff", async () => {
    const run = await gatefold([fixture("valid-diff.json")]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("1. The diff compares");
    expect(run.stdout).toContain("confidence:");
  });

  it("accepts empty and partial pfl diffs", async () => {
    for (const name of ["valid-diff-empty.json", "valid-diff-partial.json"]) {
      const run = await gatefold([fixture(name), "--format", "json"]);
      expect(run.code, name).toBe(0);
      expect(run.stderr, name).toBe("");
      const result = JSON.parse(run.stdout);
      expect(validate(result), name).toBe(true);
      expect(result.source.command, name).toBe("diff");
    }
    const partial = JSON.parse(
      (await gatefold([fixture("valid-diff-partial.json"), "--format", "json"]))
        .stdout,
    );
    expect(
      partial.claims.some((c: { claim: string }) =>
        c.claim.includes("'partial'"),
      ),
    ).toBe(true);
  });

  it.each([
    "diff-failure-document.json",
    "diff-invalid-shape.json",
    "diff-count-mismatch.json",
    "diff-bad-status.json",
  ])(
    "rejects invalid diff %s with exit 3 and a stderr-only error",
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

  it("produces byte-identical output across runs for the same diff", async () => {
    const first = await gatefold([
      fixture("valid-diff.json"),
      "--format",
      "json",
    ]);
    const second = await gatefold([
      fixture("valid-diff.json"),
      "--format",
      "json",
    ]);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  function resolvePointer(document: unknown, pointer: string): unknown {
    let current: unknown = document;
    for (const raw of pointer.split("/").slice(1)) {
      const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (current === null || typeof current !== "object")
        throw new Error(`pointer ${pointer} crosses a scalar`);
      if (Array.isArray(current)) {
        if (!/^(?:0|[1-9]\d*)$/.test(segment))
          throw new Error(
            `pointer ${pointer} segment ${segment} is not an array index`,
          );
        const index = Number(segment);
        if (index >= current.length)
          throw new Error(`pointer ${pointer} index ${segment} out of range`);
        current = current[index];
      } else {
        if (!Object.hasOwn(current, segment))
          throw new Error(`pointer ${pointer} key ${segment} is absent`);
        current = (current as Record<string, unknown>)[segment];
      }
    }
    return current;
  }

  it.each([
    "valid-report.json",
    "valid-export.json",
    "valid-diff.json",
    "valid-export-layers.json",
    "valid-diff-partial.json",
  ])(
    "resolves every claim evidence pointer inside %s and keeps claim fields intact",
    async (name) => {
      const run = await gatefold([fixture(name), "--format", "json"]);
      expect(run.code, name).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
      expect(result.claims.length, name).toBeGreaterThan(0);
      const document = JSON.parse(readFileSync(fixture(name), "utf8"));
      let resolvedPointers = 0;
      for (const claim of result.claims) {
        expect(claim.ruleId.length, name).toBeGreaterThan(0);
        expect(claim.provenance.transform, name).toContain(
          `rule:${claim.ruleId}`,
        );
        expect(claim.confidence, name).toBeGreaterThanOrEqual(0);
        expect(claim.confidence, name).toBeLessThanOrEqual(1);
        expect(claim.provenance.sourceFile, name).toBe(fixture(name));
        for (const evidence of claim.evidence) {
          // Pointers are document-local: they resolve inside this document,
          // never into a second document, a path, or a URL.
          expect(evidence.pointer, name).toMatch(/^\//);
          expect(
            () => resolvePointer(document, evidence.pointer),
            `${name} ${evidence.pointer}`,
          ).not.toThrow();
          resolvedPointers += 1;
        }
      }
      expect(resolvedPointers, name).toBeGreaterThan(0);
    },
  );

  it("never emits raw control characters in human output", async () => {
    const run = await gatefold([fixture("valid-export.json")]);
    expect(run.code).toBe(0);
    expect(displayBody(run.stdout)).not.toMatch(UNSAFE_DISPLAY);
  });

  it("escapes hostile characters in both output formats end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-e2e-"));
    try {
      const doc = JSON.parse(
        readFileSync(fixture("valid-export.json"), "utf8"),
      );
      // Replace every occurrence of the first element id so the layer joins,
      // relation endpoints, and finding references stay consistent.
      const originalId = doc.data.elements[0].id;
      const hostileId = "el-\u001b[31m\u202eevil\u200b\ufeff";
      const replaceIds = (value: unknown): unknown => {
        if (value === originalId) return hostileId;
        if (Array.isArray(value)) return value.map(replaceIds);
        if (value !== null && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
              key,
              replaceIds(entry),
            ]),
          );
        return value;
      };
      const replaced = replaceIds(doc) as typeof doc;
      replaced.data.metadata = { "run\u200b": "v\u001b[32mal" };
      const path = join(dir, "hostile-export.json");
      writeFileSync(path, JSON.stringify(replaced));

      const human = await gatefold([path]);
      expect(human.code).toBe(0);
      expect(displayBody(human.stdout)).not.toMatch(UNSAFE_DISPLAY);
      expect(human.stdout).toContain("\\u001b");
      const json = await gatefold([path, "--format", "json"]);
      expect(json.code).toBe(0);
      const result = JSON.parse(json.stdout);
      for (const claim of result.claims) {
        expect(claim.claim).not.toMatch(UNSAFE_DISPLAY);
      }
      const claimText = result.claims.map((claim) => claim.claim).join("\n");
      expect(claimText).toContain("\\u001b");
      // evidence.elementId is the verbatim id for document correlation;
      // display paths sanitize it. JSON.stringify escapes C0, so no raw
      // control bytes can reach the wire through the JSON document.
      const elementIds = result.claims
        .flatMap((claim) => claim.evidence)
        .map((entry) => entry.elementId)
        .filter((id) => id !== undefined);
      expect(elementIds).toContain(hostileId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--help documents all three accepted commands", async () => {
    const run = await gatefold(["--help"]);
    expect(run.code).toBe(0);
    for (const command of ["report", "export", "diff"])
      expect(run.stdout).toContain(command);
    expect(run.stdout).toContain("report, export, or diff");
    expect(run.stdout).toContain("command");
  });

  it("rejects a version-mismatched export end to end with exit 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-e2e-"));
    try {
      const doc = JSON.parse(
        readFileSync(fixture("valid-export.json"), "utf8"),
      );
      doc.pflVersion = "2.0.0";
      const path = join(dir, "v2-export.json");
      writeFileSync(path, JSON.stringify(doc));
      const run = await gatefold([path]);
      expect(run.code).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("pflVersion");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "installed tarball smoke: pack, install to a prefix, and run all commands including compare",
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gatefold-pack-"));
      try {
        const packed = await execFileAsync(
          "npm",
          ["pack", "--json", `--pack-destination=${dir}`],
          { cwd: root, timeout: 120_000 },
        );
        const [{ filename }] = JSON.parse(packed.stdout);
        await execFileAsync(
          "npm",
          [
            "install",
            "--prefix",
            dir,
            "--no-save",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            join(dir, filename),
          ],
          { cwd: dir, timeout: 120_000 },
        );
        const installedBin = join(
          dir,
          "node_modules",
          "@shimpeiws",
          "gatefold",
          "bin",
          "gatefold.js",
        );
        const installed = async (args: string[]): Promise<Run> => {
          try {
            const { stdout, stderr } = await execFileAsync(
              process.execPath,
              [installedBin, ...args],
              { cwd: dir },
            );
            return { code: 0, stdout, stderr };
          } catch (error) {
            const e = error as {
              code?: number;
              stdout?: string;
              stderr?: string;
            };
            return {
              code: typeof e.code === "number" ? e.code : -1,
              stdout: e.stdout ?? "",
              stderr: e.stderr ?? "",
            };
          }
        };
        const help = await installed(["--help"]);
        expect(help.code).toBe(0);
        for (const fixtureName of [
          "valid-report.json",
          "valid-export.json",
          "valid-diff.json",
        ]) {
          const run = await installed([
            fixture(fixtureName),
            "--format",
            "json",
          ]);
          expect(run.code, fixtureName).toBe(0);
          const result = JSON.parse(run.stdout);
          expect(validate(result), fixtureName).toBe(true);
          expect(result.claims.length, fixtureName).toBeGreaterThan(0);
        }
        const compare = await installed([
          "compare",
          "--before",
          compareFixture("before.json"),
          "--after",
          compareFixture("after.json"),
          "--diff",
          compareFixture("diff.json"),
          "--format",
          "json",
        ]);
        expect(compare.code, compare.stderr).toBe(0);
        const comparison = JSON.parse(compare.stdout);
        expect(
          validateComparison(comparison),
          JSON.stringify(validateComparison.errors),
        ).toBe(true);
        expect(comparison.claims.length).toBeGreaterThan(0);
        const compareTraces = await installed([
          "compare-traces",
          "--before",
          traceFixture("a.json"),
          "--after",
          traceFixture("b.json"),
          "--format",
          "json",
        ]);
        expect(compareTraces.code, compareTraces.stderr).toBe(0);
        const traceResult = JSON.parse(compareTraces.stdout);
        expect(
          validateTraceComparison(traceResult),
          JSON.stringify(validateTraceComparison.errors),
        ).toBe(true);
        expect(traceResult.schemaVersion).toBe(4);
        expect(traceResult.claims.length).toBeGreaterThan(0);
        const compareRunsResult = await installed([
          "compare-runs",
          "--before",
          runFixture("run-a"),
          "--after",
          runFixture("run-b"),
          "--format",
          "json",
        ]);
        expect(compareRunsResult.code, compareRunsResult.stderr).toBe(0);
        const runResult = JSON.parse(compareRunsResult.stdout);
        expect(
          validateRunComparison(runResult),
          JSON.stringify(validateRunComparison.errors),
        ).toBe(true);
        expect(runResult.schemaVersion).toBe(5);
        expect(runResult.claims.length).toBeGreaterThan(0);
        const evaluateResult = await installed([
          "evaluate-run",
          "--run",
          runFixture("seeded-a"),
          "--spec",
          evalFixture("task-spec.json"),
          "--check-report",
          evalFixture("check-report-a.json"),
          "--format",
          "json",
        ]);
        expect(evaluateResult.code, evaluateResult.stderr).toBe(0);
        const evaluation = JSON.parse(evaluateResult.stdout);
        expect(
          validateEvaluation(evaluation),
          JSON.stringify(validateEvaluation.errors),
        ).toBe(true);
        expect(evaluation.schemaVersion).toBe(6);
        expect(evaluation.evaluations.length).toBeGreaterThan(0);
        const compareEvalsResult = await installed([
          "compare-evaluations",
          "--before",
          runFixture("seeded-a"),
          "--after",
          runFixture("seeded-b"),
          "--spec",
          evalFixture("task-spec.json"),
          "--before-check-report",
          evalFixture("check-report-a.json"),
          "--after-check-report",
          evalFixture("check-report-b.json"),
          "--format",
          "json",
        ]);
        expect(compareEvalsResult.code, compareEvalsResult.stderr).toBe(0);
        const evalComparison = JSON.parse(compareEvalsResult.stdout);
        expect(
          validateEvaluationComparison(evalComparison),
          JSON.stringify(validateEvaluationComparison.errors),
        ).toBe(true);
        expect(evalComparison.schemaVersion).toBe(7);
        expect(evalComparison.transitions.length).toBeGreaterThan(0);
        const auditResult = await installed([
          "audit-run",
          "--run",
          runFixture("seeded-a"),
          "--check-report",
          evalFixture("check-report-a.json"),
          "--format",
          "json",
        ]);
        expect(auditResult.code, auditResult.stderr).toBe(0);
        const audit = JSON.parse(auditResult.stdout);
        expect(validateAudit(audit), JSON.stringify(validateAudit.errors)).toBe(
          true,
        );
        expect(audit.schemaVersion).toBe(8);
        expect(audit.facts.length).toBeGreaterThan(0);
        const auditLegacy = await installed([
          "audit-run",
          "--run",
          runFixture("run-a"),
        ]);
        expect(auditLegacy.code, auditLegacy.stderr).toBe(0);
        expect(auditLegacy.stdout).toContain("patch.stored: verified");
        const cellsResult = await installed([
          "report-cells",
          "--run",
          cellFixture("cell-real-run-a"),
          "--run",
          cellFixture("cell-real-run-b"),
          "--format",
          "json",
        ]);
        expect(cellsResult.code, cellsResult.stderr).toBe(0);
        const cellsReport = JSON.parse(cellsResult.stdout);
        expect(
          validateCells(cellsReport),
          JSON.stringify(validateCells.errors),
        ).toBe(true);
        expect(cellsReport.schemaVersion).toBe(10);
        expect(cellsReport.entries.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "frozen export surface: packed dist/src/index.js exports exactly the documented names",
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gatefold-exports-"));
      try {
        const packed = await execFileAsync(
          "npm",
          ["pack", "--json", `--pack-destination=${dir}`],
          { cwd: root, timeout: 120_000 },
        );
        const [{ filename }] = JSON.parse(packed.stdout);
        await execFileAsync("tar", ["-xzf", join(dir, filename), "-C", dir]);
        const index = await import(
          pathToFileURL(join(dir, "package", "dist", "src", "index.js")).href
        );
        const internal = await import(
          pathToFileURL(join(dir, "package", "dist", "src", "internal.js")).href
        );
        // Frozen 1.0 root surface (docs/1.0-contract.md "Package and module
        // surface"). Adding a name is a minor; removing one is a major.
        // Update this list and the contract together.
        expect(Object.keys(index).sort()).toEqual([
          "AUDIT_SCHEMA_VERSION",
          "CELLS_MAX_RUNS",
          "CELLS_SCHEMA_VERSION",
          "CELL_SCHEMA_VERSION",
          "CHECK_REPORT_VERSION",
          "CLAIM_SCHEMA_VERSION",
          "COMPARISON_SCHEMA_VERSION",
          "EVALUATION_COMPARISON_SCHEMA_VERSION",
          "EVALUATION_SCHEMA_VERSION",
          "EXTERNAL_CHECK_KIND",
          "PflExportError",
          "RUN_COMPARISON_SCHEMA_VERSION",
          "STDIN_SOURCE",
          "TASK_SPEC_VERSION",
          "TRACE_COMPARISON_SCHEMA_VERSION",
          "TRACE_SCHEMA_VERSION",
          "analyze",
          "auditRun",
          "compareCells",
          "compareDocuments",
          "compareEvaluations",
          "compareRuns",
          "compareTraces",
          "evaluateRun",
          "formatAuditHuman",
          "formatCellHuman",
          "formatCellsHuman",
          "formatComparisonHuman",
          "formatEvaluationComparisonHuman",
          "formatEvaluationHuman",
          "formatHuman",
          "formatJson",
          "formatRunComparisonHuman",
          "formatTraceComparisonHuman",
          "isSupportedPflVersion",
          "readAuditedRun",
          "readCellEvaluation",
          "readCellRun",
          "readCheckReport",
          "readEvaluatedRun",
          "readPflExport",
          "readPflExportStdin",
          "readTaskSpec",
          "readYuureiRun",
          "readYuureiTrace",
          "readYuureiTraceStdin",
          "reportCell",
          "reportCells",
        ]);
        expect(Object.keys(internal).length).toBeGreaterThan(0);
        for (const name of Object.keys(internal)) {
          expect(
            index[name],
            `${name} must not leak into the stable root surface`,
          ).toBeUndefined();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("exits quietly when the stdout consumer closes early (EPIPE)", async () => {
    // An export large enough that stdout cannot drain into one pipe buffer.
    const dir = mkdtempSync(join(tmpdir(), "gatefold-e2e-"));
    try {
      const input = join(dir, "big-export.json");
      writeFileSync(
        input,
        JSON.stringify({
          pflVersion: "1.0.0",
          command: "report",
          ok: true,
          completeness: "complete",
          diagnostics: [],
          data: {
            runtime: "claude-code",
            runtimeName: "Claude Code",
            project: {
              id: "git-0f214d60555919a5",
              displayName: "example-project",
            },
            observedSnapshotId: "obs-abc123",
            resolvedSnapshotId: "res-def456",
            confidence: "verified",
            stats: {
              observed: 5000,
              effective: 5000,
              shadowed: 0,
              conditional: 0,
              opaque: 0,
              byFacet: {},
            },
            findings: Array.from({ length: 5000 }, (_, i) => ({
              rule: "shadowed-element",
              message: `element ${"x".repeat(200)} is shadowed ${i}`,
              elementIds: [`claude-code:user:rules/${i}.md`],
            })),
            interpretation: { classifierVersion: "1", origin: "stored" },
          },
        }),
      );
      const { code, stderr } = await new Promise<{
        code: number | null;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, [bin, input], { cwd: root });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        // Mimic `| head`: close the read end after the first chunk.
        child.stdout.once("data", () => child.stdout.destroy());
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      });
      expect(code).toBe(0);
      expect(stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

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

const compareSchema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v3.json`, "utf8"),
);
const validateComparison = new Ajv2020().compile(compareSchema);
const compareFixture = (name: string): string =>
  `${root}test/fixtures/compare/${name}`;

const traceSchema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v4.json`, "utf8"),
);
const validateTraceComparison = new Ajv2020().compile(traceSchema);
const traceFixture = (name: string): string =>
  `${root}test/fixtures/compare-traces/${name}`;

const runSchema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v5.json`, "utf8"),
);
const validateRunComparison = new Ajv2020().compile(runSchema);
const runFixture = (name: string): string =>
  `${root}test/fixtures/yuurei-run/${name}`;

const evaluationSchema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v6.json`, "utf8"),
);
const validateEvaluation = new Ajv2020().compile(evaluationSchema);
const evaluationComparisonSchema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v7.json`, "utf8"),
);
const validateEvaluationComparison = new Ajv2020().compile(
  evaluationComparisonSchema,
);
const evalFixture = (name: string): string =>
  `${root}test/fixtures/evaluation/${name}`;

const auditSchema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v8.json`, "utf8"),
);
const validateAudit = new Ajv2020().compile(auditSchema);

const cellSchema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v9.json`, "utf8"),
);
const validateCell = new Ajv2020().compile(cellSchema);
const cellsSchema = JSON.parse(
  readFileSync(`${root}schema/claim-result.v10.json`, "utf8"),
);
const validateCells = new Ajv2020().compile(cellsSchema);
const cellFixture = (name: string): string =>
  `${root}test/fixtures/yuurei-cell/${name}`;

describe("gatefold compare e2e (real process)", () => {
  const before = compareFixture("before.json");
  const after = compareFixture("after.json");
  const diff = compareFixture("diff.json");

  it("accepts a matching triple and emits schema v3 JSON", async () => {
    const run = await gatefold([
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
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(
      validateComparison(result),
      JSON.stringify(validateComparison.errors),
    ).toBe(true);
    expect(result.schemaVersion).toBe(3);
    expect(result.source.command).toBe("compare");
    expect(result.inputs.before.label).toBe(before);
    expect(result.inputs.diff.command).toBe("diff");
  });

  it("reads one input from stdin", async () => {
    const run = await gatefoldWithStdin(
      [
        "compare",
        "--before",
        before,
        "--after",
        after,
        "--diff",
        "-",
        "--format",
        "json",
      ],
      readFileSync(diff),
    );
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.inputs.diff.label).toBe("<stdin>");
  });

  it("rejects swapped exports with exit 3 and a swap hint on stderr", async () => {
    const run = await gatefold([
      "compare",
      "--before",
      after,
      "--after",
      before,
      "--diff",
      diff,
    ]);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("swap");
  });

  it("rejects a mismatched snapshot binding with exit 3", async () => {
    const run = await gatefold([
      "compare",
      "--before",
      before,
      "--after",
      after,
      "--diff",
      compareFixture("diff-wrong-snapshots.json"),
    ]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("snapshot");
  });

  it("rejects a project mismatch and a wrong-command role with exit 3", async () => {
    const projectMismatch = await gatefold([
      "compare",
      "--before",
      before,
      "--after",
      compareFixture("after-wrong-project.json"),
      "--diff",
      diff,
    ]);
    expect(projectMismatch.code).toBe(3);
    expect(projectMismatch.stderr).toContain("different projects");
    const wrongCommand = await gatefold([
      "compare",
      "--before",
      fixture("valid-report.json"),
      "--after",
      after,
      "--diff",
      diff,
    ]);
    expect(wrongCommand.code).toBe(3);
    expect(wrongCommand.stderr).toContain("must be a pfl export");
  });

  it("rejects an oversized compare input with exit 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-oversize-"));
    try {
      const oversized = join(dir, "big.json");
      writeFileSync(oversized, Buffer.alloc(16 * 1024 * 1024 + 1));
      const run = await gatefold([
        "compare",
        "--before",
        oversized,
        "--after",
        after,
        "--diff",
        diff,
      ]);
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("byte limit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed input and usage errors", async () => {
    const malformed = await gatefold([
      "compare",
      "--before",
      fixture("malformed.json"),
      "--after",
      after,
      "--diff",
      diff,
    ]);
    expect(malformed.code).toBe(3);
    const missing = await gatefold(["compare", "--before", before]);
    expect(missing.code).toBe(2);
    const twoStdin = await gatefold([
      "compare",
      "--before",
      "-",
      "--after",
      "-",
      "--diff",
      diff,
    ]);
    expect(twoStdin.code).toBe(2);
  });

  it("emits relation claims and no element claims for a relation-only triple", async () => {
    const run = await gatefold([
      "compare",
      "--before",
      compareFixture("relation-only/before.json"),
      "--after",
      compareFixture("relation-only/after.json"),
      "--diff",
      compareFixture("relation-only/diff.json"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(
      validateComparison(result),
      JSON.stringify(validateComparison.errors),
    ).toBe(true);
    const rules = result.claims.map(
      (claim: { ruleId: string }) => claim.ruleId,
    );
    expect(rules).toContain("compare-relation-added");
    expect(rules).not.toContain("compare-element-added");
    expect(rules).not.toContain("compare-status-transition");
  });

  it("surfaces drift caveats and a reworded finding on the partial triple", async () => {
    const run = await gatefold([
      "compare",
      "--before",
      compareFixture("drift-partial/before.json"),
      "--after",
      compareFixture("drift-partial/after.json"),
      "--diff",
      compareFixture("drift-partial/diff.json"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(
      validateComparison(result),
      JSON.stringify(validateComparison.errors),
    ).toBe(true);
    const rules = result.claims.map(
      (claim: { ruleId: string }) => claim.ruleId,
    );
    expect(rules).toContain("compare-completeness");
    expect(rules).toContain("compare-version-drift");
    expect(rules).toContain("compare-finding-reworded");
    expect(rules).toContain("compare-status-transition");
    expect(
      result.claims.some((claim: { claim: string }) =>
        claim.claim.includes("may be unobserved"),
      ),
    ).toBe(true);
  });
});

describe("gatefold compare-traces e2e (real process)", () => {
  const a = traceFixture("a.json");
  const b = traceFixture("b.json");

  it("accepts a comparable pair and emits schema v4 JSON", async () => {
    const run = await gatefold([
      "compare-traces",
      "--before",
      a,
      "--after",
      b,
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout);
    expect(
      validateTraceComparison(result),
      JSON.stringify(validateTraceComparison.errors),
    ).toBe(true);
    expect(result.schemaVersion).toBe(4);
    expect(result.source.command).toBe("compare-traces");
    expect(result.inputs.beforeTrace.label).toBe(a);
    expect(result.inputs.afterTrace.label).toBe(b);
    expect(result.inputs.beforeTrace.document).toBe("yuurei-trace");
    const rules = result.claims.map(
      (claim: { ruleId: string }) => claim.ruleId,
    );
    for (const ruleId of [
      "trace-inputs",
      "trace-profiles",
      "trace-runtime",
      "trace-model",
      "trace-execution",
      "trace-duration",
      "trace-usage",
      "trace-cost",
    ])
      expect(rules).toContain(ruleId);
  });

  it("emits human output with per-trace evidence sources", async () => {
    const run = await gatefold(["compare-traces", "--before", a, "--after", b]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("beforeTrace:/run_id");
    expect(run.stdout).toContain("afterTrace:/run_id");
    expect(run.stdout).toContain("not answer quality");
  });

  it("reads one trace from stdin and labels it <stdin>", async () => {
    const run = await gatefoldWithStdin(
      ["compare-traces", "--before", "-", "--after", b, "--format", "json"],
      readFileSync(a),
    );
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.inputs.beforeTrace.label).toBe("<stdin>");
    expect(result.inputs.afterTrace.label).toBe(b);
  });

  it("rejects a task-mismatched pair with exit 3 before claims", async () => {
    const run = await gatefold([
      "compare-traces",
      "--before",
      a,
      "--after",
      traceFixture("b-task-mismatch.json"),
    ]);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("task.digest");
  });

  it("rejects malformed and wrong-kind inputs with exit 3", async () => {
    const malformed = await gatefold([
      "compare-traces",
      "--before",
      `${root}test/fixtures/yuurei-trace/malformed.json`,
      "--after",
      b,
    ]);
    expect(malformed.code).toBe(3);
    expect(malformed.stderr).toContain("not valid JSON");
    const wrongKind = await gatefold([
      "compare-traces",
      "--before",
      fixture("valid-report.json"),
      "--after",
      b,
    ]);
    expect(wrongKind.code).toBe(3);
    expect(wrongKind.stderr).toContain("yuurei trace");
    const wrongVersion = await gatefold([
      "compare-traces",
      "--before",
      `${root}test/fixtures/yuurei-trace/wrong-schema-version.json`,
      "--after",
      b,
    ]);
    expect(wrongVersion.code).toBe(3);
    expect(wrongVersion.stderr).toContain("schema_version");
  });

  it("rejects compare-traces usage errors with exit 2", async () => {
    for (const args of [
      ["compare-traces"],
      ["compare-traces", "--before", a],
      ["compare-traces", "--before", "-", "--after", "-"],
      ["compare-traces", "--before", a, "--after", b, "extra.json"],
      ["compare-traces", "--before", a, "--after", b, "--diff", a],
    ]) {
      const run = await gatefold(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
    }
  });

  it("emits caveats rather than failing on observed drift", async () => {
    const run = await gatefold([
      "compare-traces",
      "--before",
      a,
      "--after",
      traceFixture("b-drift.json"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    const caveats = result.claims.filter(
      (claim: { ruleId: string }) => claim.ruleId === "trace-comparability",
    );
    expect(caveats.length).toBe(4);
  });

  it("accepts an older trace shape with missing optional fields", async () => {
    const run = await gatefold([
      "compare-traces",
      "--before",
      traceFixture("a-older.json"),
      "--after",
      b,
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateTraceComparison(result)).toBe(true);
    expect(result.inputs.beforeTrace.yuureiVersion).toBeUndefined();
    expect(result.inputs.beforeTrace.executionOptions).toBeUndefined();
  });

  it("produces byte-identical output across runs for the same pair", async () => {
    const args = [
      "compare-traces",
      "--before",
      a,
      "--after",
      b,
      "--format",
      "json",
    ];
    const first = await gatefold(args);
    const second = await gatefold(args);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("resolves every emitted evidence pointer in the named trace", async () => {
    const run = await gatefold([
      "compare-traces",
      "--before",
      a,
      "--after",
      b,
      "--format",
      "json",
    ]);
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout);
    const documents = {
      beforeTrace: JSON.parse(readFileSync(a, "utf8")),
      afterTrace: JSON.parse(readFileSync(b, "utf8")),
    };
    const resolve = (document: unknown, pointer: string): void => {
      let current: unknown = document;
      for (const raw of pointer.split("/").slice(1)) {
        const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        if (Array.isArray(current)) current = current[Number(segment)];
        else if (current !== null && typeof current === "object")
          current = (current as Record<string, unknown>)[segment];
        else throw new Error(`pointer ${pointer} crosses a scalar`);
      }
      return undefined;
    };
    let resolved = 0;
    for (const claim of result.claims)
      for (const evidence of claim.evidence) {
        expect(evidence.pointer).toMatch(/^(\/|$)/);
        resolve(
          documents[evidence.source as keyof typeof documents],
          evidence.pointer,
        );
        resolved += 1;
      }
    expect(resolved).toBeGreaterThan(0);
  });

  it("never emits raw control characters in trace comparison output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-trace-e2e-"));
    try {
      const hostile = JSON.parse(readFileSync(b, "utf8"));
      hostile.diagnostics = ["bad\u001b[31m char\u200binside"];
      hostile.task.source = "src\u202eevil";
      const path = join(dir, "hostile.json");
      writeFileSync(path, JSON.stringify(hostile));

      const human = await gatefold([
        "compare-traces",
        "--before",
        a,
        "--after",
        path,
      ]);
      expect(human.code).toBe(0);
      expect(displayBody(human.stdout)).not.toMatch(UNSAFE_DISPLAY);
      const json = await gatefold([
        "compare-traces",
        "--before",
        a,
        "--after",
        path,
        "--format",
        "json",
      ]);
      const result = JSON.parse(json.stdout);
      for (const claim of result.claims)
        expect(claim.claim).not.toMatch(UNSAFE_DISPLAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gatefold compare-runs e2e (real process)", () => {
  const a = runFixture("run-a");
  const b = runFixture("run-b");

  it("accepts a comparable pair and emits schema v5 JSON", async () => {
    const run = await gatefold([
      "compare-runs",
      "--before",
      a,
      "--after",
      b,
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout);
    expect(
      validateRunComparison(result),
      JSON.stringify(validateRunComparison.errors),
    ).toBe(true);
    expect(result.schemaVersion).toBe(5);
    expect(result.source.command).toBe("compare-runs");
    expect(result.inputs.beforeRun.label).toBe(a);
    expect(result.inputs.afterRun.label).toBe(b);
    expect(result.inputs.beforeRun.document).toBe("yuurei-run");
    expect(result.inputs.beforeRun.trace.document).toBe("yuurei-trace");
    const rules = result.claims.map(
      (claim: { ruleId: string }) => claim.ruleId,
    );
    for (const ruleId of [
      "run-manifest",
      "run-generated-files",
      "run-file-added",
      "run-file-removed",
      "run-file-changed",
    ])
      expect(rules).toContain(ruleId);
  });

  it("emits human output with per-document evidence sources", async () => {
    const run = await gatefold(["compare-runs", "--before", a, "--after", b]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("beforeManifest:/artifacts/");
    expect(run.stdout).toContain("afterPatch:/artifacts/");
    expect(run.stdout).toContain("docs/guide.md");
  });

  it("identifies A → B through the supplied labels", async () => {
    const run = await gatefold([
      "compare-runs",
      "--before",
      a,
      "--after",
      b,
      "--format",
      "json",
    ]);
    const result = JSON.parse(run.stdout);
    expect(result.inputs.beforeRun.label).toBe(a);
    expect(result.inputs.afterRun.label).toBe(b);
    const added = result.claims.find(
      (claim: { ruleId: string }) => claim.ruleId === "run-file-added",
    );
    expect(added.claim).toContain("docs/guide.md");
    expect(added.claim).toContain("Run B");
  });

  it("keeps a truncated patch as a caveat, not a failure", async () => {
    const run = await gatefold([
      "compare-runs",
      "--before",
      runFixture("run-truncated"),
      "--after",
      a,
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.inputs.beforeRun.patchState).toBe("verified-truncated");
    const caveat = result.claims.find(
      (claim: { ruleId: string }) => claim.ruleId === "run-patch-state",
    );
    expect(caveat.claim).toContain("truncated");
  });

  it("never claims an unrecorded patch means no output", async () => {
    const run = await gatefold([
      "compare-runs",
      "--before",
      runFixture("run-nopatch"),
      "--after",
      a,
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.inputs.beforeRun.patchState).toBe("not-recorded");
    const caveat = result.claims.find(
      (claim: { ruleId: string }) => claim.ruleId === "run-patch-state",
    );
    expect(caveat.claim).toContain("does not mean");
  });

  it("rejects a manifest with a traversal path with exit 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-run-e2e-"));
    try {
      const runDir = join(dir, "run");
      mkdirSync(runDir);
      writeFileSync(
        join(runDir, "trace.json"),
        readFileSync(`${a}/trace.json`),
      );
      writeFileSync(
        join(runDir, "artifacts.json"),
        JSON.stringify({
          artifacts: [
            {
              path: "../escape.diff",
              kind: "patch",
              digest:
                "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            },
          ],
        }),
      );
      const run = await gatefold([
        "compare-runs",
        "--before",
        runDir,
        "--after",
        b,
      ]);
      expect(run.code).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("run directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing run directory and a missing manifest with exit 3", async () => {
    const missingDir = await gatefold([
      "compare-runs",
      "--before",
      `${root}test/fixtures/yuurei-run/no-such-run`,
      "--after",
      b,
    ]);
    expect(missingDir.code).toBe(3);
    expect(missingDir.stderr).toContain("cannot read run directory");
    const dir = mkdtempSync(join(tmpdir(), "gatefold-run-e2e-"));
    try {
      const runDir = join(dir, "run");
      mkdirSync(runDir);
      writeFileSync(
        join(runDir, "trace.json"),
        readFileSync(`${a}/trace.json`),
      );
      const noManifest = await gatefold([
        "compare-runs",
        "--before",
        runDir,
        "--after",
        b,
      ]);
      expect(noManifest.code).toBe(3);
      expect(noManifest.stderr).toContain("artifact manifest");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects compare-runs usage errors with exit 2", async () => {
    for (const args of [
      ["compare-runs"],
      ["compare-runs", "--before", a],
      ["compare-runs", "--before", "-", "--after", b],
      ["compare-runs", "--before", a, "--after", "-"],
      ["compare-runs", "--before", a, "--after", b, "extra"],
      ["compare-runs", "--before", a, "--after", b, "--diff", a],
    ]) {
      const run = await gatefold(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
    }
  });

  it("produces byte-identical output across runs for the same pair", async () => {
    const args = [
      "compare-runs",
      "--before",
      a,
      "--after",
      b,
      "--format",
      "json",
    ];
    const first = await gatefold(args);
    const second = await gatefold(args);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("never emits raw control characters for hostile generated paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-run-e2e-"));
    try {
      const runDir = join(dir, "run");
      mkdirSync(runDir);
      writeFileSync(
        join(runDir, "trace.json"),
        readFileSync(`${a}/trace.json`),
      );
      const patch =
        "--- /dev/null\n" +
        "+++ bad\u001b[31m/path.md\n" +
        "@@ -0,0 +1,1 @@\n" +
        "+body\n";
      writeFileSync(join(runDir, "patch.diff"), patch);
      const digest = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
      writeFileSync(
        join(runDir, "artifacts.json"),
        JSON.stringify({
          artifacts: [{ path: "patch.diff", kind: "patch", digest }],
        }),
      );

      const human = await gatefold([
        "compare-runs",
        "--before",
        runDir,
        "--after",
        b,
      ]);
      expect(human.code, human.stderr).toBe(0);
      expect(displayBody(human.stdout)).not.toMatch(UNSAFE_DISPLAY);
      const json = await gatefold([
        "compare-runs",
        "--before",
        runDir,
        "--after",
        b,
        "--format",
        "json",
      ]);
      const result = JSON.parse(json.stdout);
      for (const claim of result.claims)
        expect(claim.claim).not.toMatch(UNSAFE_DISPLAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gatefold e2e: evaluate-run and compare-evaluations", () => {
  const runDir = runFixture;

  it("evaluate-run emits schema-valid v6 verdicts for a seeded run", async () => {
    const run = await gatefold([
      "evaluate-run",
      "--run",
      runDir("seeded-a"),
      "--spec",
      evalFixture("task-spec.json"),
      "--check-report",
      evalFixture("check-report-a.json"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(
      validateEvaluation(result),
      JSON.stringify(validateEvaluation.errors),
    ).toBe(true);
    expect(result.schemaVersion).toBe(6);
    expect(result.source.command).toBe("evaluate-run");
    expect(result.inputs.run.seeded).toBe(true);
    for (const entry of result.evaluations) {
      expect(["pass", "fail", "unknown"]).toContain(entry.verdict);
      expect(entry.evidence.length).toBeGreaterThan(0);
    }
    expect(
      result.evaluations.map((e: { criterionId: string }) => e.criterionId),
    ).toEqual([
      "auth-fixed",
      "tests-added",
      "legacy-removed",
      "answer-status",
      "answer-mentions-expiry",
      "unit-tests",
    ]);
  });

  it("evaluate-run emits human-readable verdicts by default", async () => {
    const run = await gatefold([
      "evaluate-run",
      "--run",
      runDir("seeded-b"),
      "--spec",
      evalFixture("task-spec.json"),
      "--check-report",
      evalFixture("check-report-b.json"),
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("[fail] criterion 'auth-fixed'");
    expect(run.stdout).toContain("[pass] criterion 'answer-mentions-expiry'");
    expect(run.stdout).toContain("confidence:");
    expect(run.stdout).toContain("evidence:");
  });

  it("a rejected check report leaves external criteria unknown, exit 0", async () => {
    const run = await gatefold([
      "evaluate-run",
      "--run",
      runDir("seeded-a"),
      "--spec",
      evalFixture("task-spec.json"),
      "--check-report",
      evalFixture("check-report-mismatched.json"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.inputs.checkReports[0].state).toBe("mismatched");
    expect(
      result.evaluations.find(
        (e: { criterionId: string }) => e.criterionId === "unit-tests",
      ).verdict,
    ).toBe("unknown");
  });

  it("compare-evaluations emits schema-valid v7 transitions", async () => {
    const run = await gatefold([
      "compare-evaluations",
      "--before",
      runDir("seeded-a"),
      "--after",
      runDir("seeded-b"),
      "--spec",
      evalFixture("task-spec.json"),
      "--before-check-report",
      evalFixture("check-report-a.json"),
      "--after-check-report",
      evalFixture("check-report-b.json"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(
      validateEvaluationComparison(result),
      JSON.stringify(validateEvaluationComparison.errors),
    ).toBe(true);
    expect(result.schemaVersion).toBe(7);
    const transition = result.transitions.find(
      (t: { criterionId: string }) => t.criterionId === "auth-fixed",
    );
    expect([transition.before, transition.after, transition.changed]).toEqual([
      "pass",
      "fail",
      true,
    ]);
  });

  it("rejects evaluate-run missing flags with exit 2", async () => {
    for (const args of [
      ["evaluate-run"],
      ["evaluate-run", "--run", runDir("seeded-a")],
      ["evaluate-run", "--run", "-", "--spec", evalFixture("task-spec.json")],
      [
        "compare-evaluations",
        "--before",
        runDir("seeded-a"),
        "--spec",
        evalFixture("task-spec.json"),
      ],
    ]) {
      const run = await gatefold(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
    }
  });

  it("rejects a spec that does not bind to the run with exit 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-eval-e2e-"));
    try {
      const spec = join(dir, "spec.json");
      writeFileSync(
        spec,
        JSON.stringify({
          specVersion: 1,
          rubricId: "r",
          task: { digest: "sha256:other-task" },
          criteria: [{ id: "a", kind: "file-added", path: "x" }],
        }),
      );
      const run = await gatefold([
        "evaluate-run",
        "--run",
        runDir("seeded-a"),
        "--spec",
        spec,
      ]);
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("task.digest");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gatefold e2e: audit-run", () => {
  const runDir = runFixture;

  it("audit-run emits a schema-valid v8 audit for a seeded run", async () => {
    const run = await gatefold([
      "audit-run",
      "--run",
      runDir("seeded-a"),
      "--check-report",
      evalFixture("check-report-a.json"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateAudit(result), JSON.stringify(validateAudit.errors)).toBe(
      true,
    );
    expect(result.schemaVersion).toBe(8);
    expect(result.source.command).toBe("audit-run");
    expect(result.inputs.run.seeded).toBe(true);
    expect(result.inputs.checkReports).toHaveLength(1);
    expect(result.inputs.checkReports[0].state).toBe("parsed");
    const states = new Map(
      result.facts.map((f: { id: string; state: string }) => [f.id, f.state]),
    );
    for (const id of [
      "run.trace",
      "patch.stored",
      "patch.completeness",
      "changes.record",
      "result.availability",
    ])
      expect(states.get(id), id).toBe("verified");
    for (const id of [
      "check-report.task-binding",
      "check-report.baseline-binding",
      "check-report.patch-binding",
    ])
      expect(states.get(id), id).toBe("verified");
    for (const entry of result.facts)
      expect(entry.evidence.length).toBeGreaterThan(0);
  });

  it("audit-run audits a legacy run without a spec", async () => {
    const run = await gatefold([
      "audit-run",
      "--run",
      runDir("run-a"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateAudit(result), JSON.stringify(validateAudit.errors)).toBe(
      true,
    );
    const states = new Map(
      result.facts.map((f: { id: string; state: string }) => [f.id, f.state]),
    );
    expect(states.get("seed.provenance")).toBe("not-recorded");
    expect(states.get("patch.stored")).toBe("verified");
    expect(states.get("patch.completeness")).toBe("unverifiable");
  });

  it("audit-run emits human-readable facts by default", async () => {
    const run = await gatefold(["audit-run", "--run", runDir("seeded-a")]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("patch.stored: verified; complete");
    expect(run.stdout).toContain("evidence:");
    for (const word of ["[pass]", "[fail]", "criterion", "score"])
      expect(run.stdout).not.toContain(word);
  });

  it("rejects audit-run missing flags and stdin with exit 2", async () => {
    for (const args of [
      ["audit-run"],
      ["audit-run", "--run", "-"],
      ["audit-run", "some-positional", "--run", runDir("seeded-a")],
    ]) {
      const run = await gatefold(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
    }
  });

  it("reports a digest-mismatched patch as inconsistent, exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-audit-e2e-"));
    try {
      const source = runDir("seeded-a");
      const dest = join(dir, "run");
      mkdirSync(dest, { recursive: true });
      for (const file of [
        "trace.json",
        "artifacts.json",
        "patch.diff",
        "result.txt",
      ])
        writeFileSync(join(dest, file), readFileSync(join(source, file)));
      writeFileSync(join(dest, "patch.diff"), "tampered bytes\n");
      const run = await gatefold([
        "audit-run",
        "--run",
        dest,
        "--format",
        "json",
      ]);
      expect(run.code, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(validateAudit(result), JSON.stringify(validateAudit.errors)).toBe(
        true,
      );
      const states = new Map(
        result.facts.map((f: { id: string; state: string }) => [f.id, f.state]),
      );
      expect(states.get("patch.stored")).toBe("inconsistent");
      expect(states.get("patch.interpretable")).toBe("unverifiable");
      expect(states.get("result.stored")).toBe("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a hostile manifest path with exit 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-audit-e2e-"));
    try {
      const source = runDir("seeded-a");
      const dest = join(dir, "run");
      mkdirSync(dest, { recursive: true });
      writeFileSync(
        join(dest, "trace.json"),
        readFileSync(join(source, "trace.json")),
      );
      writeFileSync(
        join(dest, "artifacts.json"),
        JSON.stringify({
          artifacts: [
            {
              path: "../escape.txt",
              kind: "patch",
              digest: "sha256:" + "0".repeat(64),
            },
          ],
        }),
      );
      const run = await gatefold(["audit-run", "--run", dest]);
      expect(run.code).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gatefold e2e: report-cell and compare-cells", () => {
  const entryMap = (result: {
    entries: { id: string; state: string }[];
  }): Map<string, string> =>
    new Map(result.entries.map((e) => [e.id, e.state]));

  it("report-cell emits a schema-valid v9 report for an observed cell", async () => {
    const run = await gatefold([
      "report-cell",
      "--run",
      cellFixture("cell-a"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateCell(result), JSON.stringify(validateCell.errors)).toBe(
      true,
    );
    expect(result.schemaVersion).toBe(9);
    expect(result.source.command).toBe("report-cell");
    expect(result.inputs.run.cellId).toBe("cell_20260920-a1");
    const states = entryMap(result);
    for (const id of [
      "association.cell-id",
      "association.export-retained",
      "association.export-document",
      "association.export-binding",
      "association.export-snapshots",
      "configuration.snapshot",
      "execution.outcome",
      "audit.run.trace",
    ])
      expect(states.get(id), id).not.toBe("unverifiable");
    for (const entry of result.entries)
      expect(entry.evidence.length).toBeGreaterThan(0);
  });

  it("report-cell reports an unobserved run without inventing configuration", async () => {
    const run = await gatefold([
      "report-cell",
      "--run",
      cellFixture("cell-unobserved"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateCell(result), JSON.stringify(validateCell.errors)).toBe(
      true,
    );
    const states = entryMap(result);
    expect(states.get("association.cell-id")).toBe("not-recorded");
    expect(states.get("configuration.availability")).toBe("not-recorded");
    for (const entry of result.entries)
      if (entry.lane === "configuration")
        expect(entry.id.startsWith("configuration.element."), entry.id).toBe(
          false,
        );
  });

  it("report-cell preserves an observer failure distinctly", async () => {
    const run = await gatefold([
      "report-cell",
      "--run",
      cellFixture("cell-observation-unavailable"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateCell(result), JSON.stringify(validateCell.errors)).toBe(
      true,
    );
    const states = entryMap(result);
    expect(states.get("association.cell-id")).toBe("recorded");
    expect(states.get("association.observation")).toBe("recorded");
    expect(states.get("configuration.availability")).toBe("not-recorded");
  });

  it("report-cell emits human-readable lanes by default", async () => {
    const run = await gatefold(["report-cell", "--run", cellFixture("cell-a")]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("association.export-binding:");
    expect(run.stdout).toContain("execution.outcome:");
    expect(run.stdout).toContain("evidence:");
    for (const word of ["[pass]", "[fail]", "criterion", "score"])
      expect(run.stdout).not.toContain(word);
  });

  it("rejects --min-confidence on the confidence-free cell commands", async () => {
    for (const args of [
      ["report-cell", "--run", cellFixture("cell-a"), "--min-confidence", "0"],
      ["report-cell", "--run", cellFixture("cell-a"), "--min-confidence", "1"],
      [
        "compare-cells",
        "--before",
        cellFixture("cell-a"),
        "--after",
        cellFixture("cell-b"),
        "--min-confidence=0.5",
      ],
    ]) {
      const run = await gatefold(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("--min-confidence does not apply");
    }
  });

  it("rejects report-cell missing flags and stdin with exit 2", async () => {
    for (const args of [
      ["report-cell"],
      ["report-cell", "--run", "-"],
      ["report-cell", "some-positional", "--run", cellFixture("cell-a")],
    ]) {
      const run = await gatefold(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
    }
  });

  it("compare-cells emits a schema-valid directional A → B comparison", async () => {
    const run = await gatefold([
      "compare-cells",
      "--before",
      cellFixture("cell-a"),
      "--after",
      cellFixture("cell-b"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateCell(result), JSON.stringify(validateCell.errors)).toBe(
      true,
    );
    expect(result.schemaVersion).toBe(9);
    expect(result.source.command).toBe("compare-cells");
    const ids = result.entries.map((e: { id: string }) => e.id);
    expect(ids).toContain("comparison.element-added.el_ccc");
    expect(ids).toContain("comparison.element-removed.el_aaa");
    expect(ids).toContain("comparison.element-changed.el_bbb");
    expect(ids).not.toContain("comparison.config-unavailable");
  });

  it("compare-cells compares a genuine same-source pair whose observed project ids differ", async () => {
    // Real yuurei #214 + pfl #217 outputs: two cells from one source with
    // distinct cell-local project ids joined on the declared source identity.
    const run = await gatefold([
      "compare-cells",
      "--before",
      cellFixture("cell-real-pair-a"),
      "--after",
      cellFixture("cell-real-pair-b"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateCell(result), JSON.stringify(validateCell.errors)).toBe(
      true,
    );
    const states = entryMap(result);
    expect(states.get("comparison.source-identity")).toBe("verified");
    const identity = result.entries.find(
      (e: { id: string }) => e.id === "comparison.source-identity",
    );
    expect(identity.statement).toContain("git-db9acfc85f531c03");
    expect(states.get("comparison.elements")).toBe("recorded");
  });

  it("compare-cells rejects a genuine different-source pair with exit 3", async () => {
    const run = await gatefold([
      "compare-cells",
      "--before",
      cellFixture("cell-real-pair-a"),
      "--after",
      cellFixture("cell-real-other-source"),
    ]);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("gatefold:");
  });

  it("compare-cells never concludes 'no configuration change' when a side lacks an export", async () => {
    const run = await gatefold([
      "compare-cells",
      "--before",
      cellFixture("cell-a"),
      "--after",
      cellFixture("cell-unobserved"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateCell(result), JSON.stringify(validateCell.errors)).toBe(
      true,
    );
    const states = entryMap(result);
    expect(states.get("comparison.config-unavailable")).toBe("unverifiable");
    const ids = result.entries.map((e: { id: string }) => e.id);
    expect(
      ids.some((id: string) => id.startsWith("comparison.element-added.")),
    ).toBe(false);
  });

  it("compare-cells rejects incompatible runs with exit 3", async () => {
    const run = await gatefold([
      "compare-cells",
      "--before",
      cellFixture("cell-a"),
      "--after",
      cellFixture("cell-incompatible"),
    ]);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("gatefold:");
  });

  it("rejects compare-cells missing flags and stdin with exit 2", async () => {
    for (const args of [
      ["compare-cells"],
      ["compare-cells", "--before", cellFixture("cell-a")],
      ["compare-cells", "--before", "-", "--after", cellFixture("cell-b")],
    ]) {
      const run = await gatefold(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
    }
  });
});

describe("gatefold e2e: report-cells", () => {
  const entryMap = (result: {
    entries: { id: string; state: string }[];
  }): Map<string, string> =>
    new Map(result.entries.map((e) => [e.id, e.state]));

  it("reports a genuine four-run set with one unbound run", async () => {
    const run = await gatefold([
      "report-cells",
      "--run",
      cellFixture("cell-real-run-a"),
      "--run",
      cellFixture("cell-real-run-b"),
      "--run",
      cellFixture("cell-real-run-c"),
      "--run",
      cellFixture("cell-real-run-d"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(validateCells(result), JSON.stringify(validateCells.errors)).toBe(
      true,
    );
    expect(result.schemaVersion).toBe(10);
    expect(result.source.command).toBe("report-cells");
    expect(result.inputs.runs.map((r: { name: string }) => r.name)).toEqual([
      "run1",
      "run2",
      "run3",
      "run4",
    ]);
    const states = entryMap(result);
    expect(states.get("set.comparability")).toBe("verified");
    expect(states.get("set.source-identity")).toBe("verified");
    expect(states.get("set.elements")).toBe("recorded");
    const inputs = result.entries.find(
      (e: { id: string }) => e.id === "set.inputs",
    );
    expect(inputs.statement).toContain("3 of them bind an export");
    for (const entry of result.entries)
      expect(entry.evidence.length).toBeGreaterThan(0);
  });

  it("preserves caller-supplied run order in the labels", async () => {
    const run = await gatefold([
      "report-cells",
      "--run",
      cellFixture("cell-real-run-d"),
      "--run",
      cellFixture("cell-real-run-a"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.inputs.runs[0].label).toContain("cell-real-run-d");
    expect(result.inputs.runs[0].name).toBe("run1");
    // run1 (the unbound run) is excluded from every denominator.
    expect(entryMap(result).get("set.config-unavailable")).toBe("unverifiable");
  });

  it("emits human-readable lanes by default", async () => {
    const run = await gatefold([
      "report-cells",
      "--run",
      cellFixture("cell-real-run-a"),
      "--run",
      cellFixture("cell-real-run-b"),
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("set.elements:");
    expect(run.stdout).toContain("run1:");
    expect(run.stdout).toContain("run2:");
    expect(run.stdout).toContain("evidence:");
    for (const word of ["[pass]", "[fail]", "criterion", "score"])
      expect(run.stdout).not.toContain(word);
  });

  it("rejects single-run, duplicate, stdin, and --min-confidence with exit 2", async () => {
    for (const args of [
      ["report-cells"],
      ["report-cells", "--run", cellFixture("cell-a")],
      [
        "report-cells",
        "--run",
        cellFixture("cell-real-run-a"),
        "--run",
        cellFixture("cell-real-run-a"),
      ],
      ["report-cells", "--run", "-", "--run", cellFixture("cell-a")],
      [
        "report-cells",
        "--run",
        cellFixture("cell-a"),
        "--run",
        cellFixture("cell-b"),
        "--min-confidence",
        "0",
      ],
      ["report-cells", "--run"],
    ]) {
      const run = await gatefold(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("gatefold:");
    }
  });

  it("rejects incompatible runs and differing declared sources with exit 3", async () => {
    const incompatible = await gatefold([
      "report-cells",
      "--run",
      cellFixture("cell-real-run-a"),
      "--run",
      cellFixture("cell-incompatible"),
    ]);
    expect(incompatible.code).toBe(3);
    expect(incompatible.stdout).toBe("");
    const otherSource = await gatefold([
      "report-cells",
      "--run",
      cellFixture("cell-real-pair-a"),
      "--run",
      cellFixture("cell-real-other-source"),
    ]);
    expect(otherSource.code).toBe(3);
    expect(otherSource.stdout).toBe("");
  });
});

describe("human output escapes untrusted text at the boundary (#96)", () => {
  /**
   * The hostile payload from the issue's reproduction: a C0 escape
   * introducing an ANSI sequence, a bidi override that reorders terminal
   * text, and an assigned supplementary-plane tag character that a
   * BMP-only pattern would miss.
   */
  const INJECTED = "x\u001b[31mRED\u001b[0m\u202e\u{e0065}";

  /** The display contract: every unsafe character class is absent. */
  const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

  /** Human output uses `\n` legitimately; nothing else unsafe may survive. */
  function expectEscapedOutput(stdout: string): void {
    expect(stdout.replace(/\n/g, "")).not.toMatch(UNSAFE);
    expect(stdout).toContain("\\u001b");
    expect(stdout).toContain("\\u202e");
    expect(stdout).toContain("\\u{e0065}");
  }

  const withTempDir = <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), "gatefold-sanitize-"));
    return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
  };

  const mutateJsonFile = (
    source: string,
    target: string,
    mutate: (doc: any) => void,
  ): string => {
    const doc = JSON.parse(readFileSync(source, "utf8"));
    mutate(doc);
    writeFileSync(target, JSON.stringify(doc));
    return target;
  };

  const copyRunDir = (source: string, target: string): string => {
    cpSync(source, target, { recursive: true });
    return target;
  };

  const mutateJsonInDir = (
    dir: string,
    name: string,
    mutate: (doc: any) => void,
  ): void => {
    const file = join(dir, name);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    mutate(doc);
    writeFileSync(file, JSON.stringify(doc));
  };

  it("analyze escapes a hostile stats.byFacet key in evidence pointers", () =>
    withTempDir(async (dir) => {
      const input = mutateJsonFile(
        fixture("valid-report.json"),
        join(dir, "report.json"),
        (doc) => {
          doc.data.stats.byFacet[INJECTED] = 1;
        },
      );
      const run = await gatefold([input]);
      expect(run.code, run.stderr).toBe(0);
      expectEscapedOutput(run.stdout);
    }));

  it("analyze --format json keeps the document value verbatim", () =>
    withTempDir(async (dir) => {
      const input = mutateJsonFile(
        fixture("valid-report.json"),
        join(dir, "report.json"),
        (doc) => {
          doc.data.stats.byFacet[INJECTED] = 1;
        },
      );
      const run = await gatefold([input, "--format", "json"]);
      expect(run.code, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout);
      const pointers = result.claims.flatMap(
        (c: { evidence: { pointer: string }[] }) =>
          c.evidence.map((e) => e.pointer),
      );
      expect(
        pointers.some((p: string) => p.includes(INJECTED)),
        "JSON keeps the raw pointer",
      ).toBe(true);
    }));

  it("compare escapes a hostile diff label in the provenance line", () =>
    withTempDir(async (dir) => {
      const diff = join(dir, `diff-${INJECTED}.json`);
      writeFileSync(diff, readFileSync(compareFixture("diff.json"), "utf8"));
      const run = await gatefold([
        "compare",
        "--before",
        compareFixture("before.json"),
        "--after",
        compareFixture("after.json"),
        "--diff",
        diff,
      ]);
      expect(run.code, run.stderr).toBe(0);
      expectEscapedOutput(run.stdout);
    }));

  it("compare-traces escapes a hostile usage key in evidence pointers", () =>
    withTempDir(async (dir) => {
      const before = mutateJsonFile(
        traceFixture("a.json"),
        join(dir, "a.json"),
        (doc) => {
          doc.usage[INJECTED] = 42;
        },
      );
      const run = await gatefold([
        "compare-traces",
        "--before",
        before,
        "--after",
        traceFixture("b.json"),
      ]);
      expect(run.code, run.stderr).toBe(0);
      expectEscapedOutput(run.stdout);
    }));

  it("compare-runs escapes a hostile usage key in evidence pointers", () =>
    withTempDir(async (dir) => {
      const run = copyRunDir(runFixture("run-a"), join(dir, "run-a-usage"));
      mutateJsonInDir(run, "trace.json", (doc) => {
        doc.usage[INJECTED] = 42;
      });
      const result = await gatefold([
        "compare-runs",
        "--before",
        run,
        "--after",
        runFixture("run-b"),
      ]);
      expect(result.code, result.stderr).toBe(0);
      expectEscapedOutput(result.stdout);
    }));

  it("evaluate-run escapes a hostile criterion id in the criterion line", () =>
    withTempDir(async (dir) => {
      const spec = mutateJsonFile(
        evalFixture("task-spec.json"),
        join(dir, "task-spec.json"),
        (doc) => {
          doc.criteria[0].id = `crit-${INJECTED}`;
        },
      );
      const run = await gatefold([
        "evaluate-run",
        "--run",
        runFixture("seeded-a"),
        "--spec",
        spec,
        "--check-report",
        evalFixture("check-report-a.json"),
      ]);
      expect(run.code, run.stderr).toBe(0);
      expectEscapedOutput(run.stdout);
    }));

  it("compare-evaluations escapes a hostile yuurei_version in caveat text", () =>
    withTempDir(async (dir) => {
      const before = copyRunDir(
        runFixture("seeded-a"),
        join(dir, "seeded-a-yv"),
      );
      mutateJsonInDir(before, "trace.json", (doc) => {
        doc.yuurei_version = `0.3.0-${INJECTED}`;
      });
      const run = await gatefold([
        "compare-evaluations",
        "--before",
        before,
        "--after",
        runFixture("seeded-b"),
        "--spec",
        evalFixture("task-spec.json"),
        "--before-check-report",
        evalFixture("check-report-a.json"),
        "--after-check-report",
        evalFixture("check-report-b.json"),
      ]);
      expect(run.code, run.stderr).toBe(0);
      expectEscapedOutput(run.stdout);
    }));

  it("audit-run escapes a hostile run-directory label", () =>
    withTempDir(async (dir) => {
      const run = copyRunDir(
        runFixture("run-a"),
        join(dir, `run-a-${INJECTED}`),
      );
      const result = await gatefold(["audit-run", "--run", run]);
      expect(result.code, result.stderr).toBe(0);
      expectEscapedOutput(result.stdout);
    }));

  it("report-cell escapes a hostile run_id in the input descriptor", () =>
    withTempDir(async (dir) => {
      const run = copyRunDir(cellFixture("cell-a"), join(dir, "cell-a"));
      mutateJsonInDir(run, "trace.json", (doc) => {
        doc.run_id = `run-${INJECTED}`;
      });
      const result = await gatefold(["report-cell", "--run", run]);
      expect(result.code, result.stderr).toBe(0);
      expectEscapedOutput(result.stdout);
    }));

  it("compare-cells escapes a hostile run_id in the input descriptors", () =>
    withTempDir(async (dir) => {
      const run = copyRunDir(cellFixture("cell-a"), join(dir, "cell-a"));
      mutateJsonInDir(run, "trace.json", (doc) => {
        doc.run_id = `run-${INJECTED}`;
      });
      const result = await gatefold([
        "compare-cells",
        "--before",
        run,
        "--after",
        cellFixture("cell-b"),
      ]);
      expect(result.code, result.stderr).toBe(0);
      expectEscapedOutput(result.stdout);
    }));

  it("report-cells escapes a hostile run_id in the input descriptors", () =>
    withTempDir(async (dir) => {
      const run = copyRunDir(
        cellFixture("cell-real-run-a"),
        join(dir, "cell-real-a"),
      );
      mutateJsonInDir(run, "trace.json", (doc) => {
        doc.run_id = `run-${INJECTED}`;
      });
      const result = await gatefold([
        "report-cells",
        "--run",
        run,
        "--run",
        cellFixture("cell-real-run-b"),
      ]);
      expect(result.code, result.stderr).toBe(0);
      expectEscapedOutput(result.stdout);
    }));
});
