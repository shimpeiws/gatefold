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
      "docs/v0.4-scope.md",
      "schema/claim-result.v1.json",
      "schema/claim-result.v2.json",
      "schema/claim-result.v3.json",
      "schema/examples/valid-comparison-result.json",
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
    expect(run.stdout).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
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
      // The sanitizer's unsafe set minus \t \n \r, which the formatter emits.
      const unsafe =
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
      const human = await gatefold([path]);
      expect(human.code).toBe(0);
      expect(human.stdout).not.toMatch(unsafe);
      expect(human.stdout).toContain("\\u001b");
      const json = await gatefold([path, "--format", "json"]);
      expect(json.code).toBe(0);
      const result = JSON.parse(json.stdout);
      for (const claim of result.claims) {
        expect(claim.claim).not.toMatch(unsafe);
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
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
