import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/application/analyze.js";
import { RULES } from "../src/application/rules.js";
import type { Claim } from "../src/domain/claim.js";
import { assertValidResult } from "../src/domain/validate.js";
import { parsePflExport, readPflExport } from "../src/input/pfl-export.js";

const dir = new URL("fixtures/pfl-export/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));

async function load(name: string) {
  return readPflExport(fixture(name));
}

function byRule(result: { claims: readonly Claim[] }, ruleId: string) {
  return result.claims.filter((c) =>
    c.provenance.transform.includes(`rule:${ruleId}`),
  );
}

const ALLOWED_POINTER =
  /^(|\/data(\/|$)|\/pflVersion|\/completeness|\/diagnostics(\/\d+)?$)/;

describe("descriptive rules", () => {
  it("emits only schema-valid claims for every valid fixture", async () => {
    for (const name of [
      "valid-report.json",
      "valid-report-minimal.json",
      "valid-report-partial.json",
      "empty-report.json",
    ]) {
      const result = analyze(await load(name));
      expect(() => assertValidResult(result), name).not.toThrow();
    }
  });

  it("is deterministic for the same input", async () => {
    const input = await load("valid-report.json");
    expect(JSON.stringify(analyze(input))).toBe(JSON.stringify(analyze(input)));
  });

  it("every claim carries evidence and provenance", async () => {
    const result = analyze(await load("valid-report.json"));
    expect(result.claims.length).toBeGreaterThan(0);
    for (const claim of result.claims) {
      expect(claim.evidence.length).toBeGreaterThanOrEqual(1);
      for (const evidence of claim.evidence) {
        expect(evidence.pointer).toMatch(ALLOWED_POINTER);
      }
      expect(claim.provenance.sourceFile).toBe(fixture("valid-report.json"));
      expect(claim.provenance.exportVersion).toBe("1.0.0");
      expect(claim.provenance.transform[0]).toBe("pfl-report-envelope");
    }
  });

  it("describes the runtime and project", async () => {
    const [claim] = byRule(
      analyze(await load("valid-report.json")),
      "runtime-described",
    );
    expect(claim.claim).toBe(
      "The export describes a 'claude-code' harness for project 'example-project'.",
    );
    expect(claim.evidence.map((e) => e.pointer)).toEqual([
      "/data/runtime",
      "/data/project/displayName",
    ]);
  });

  it("reports element counts", async () => {
    const [claim] = byRule(
      analyze(await load("valid-report.json")),
      "element-counts",
    );
    expect(claim.claim).toBe(
      "pfl observed 12 elements: 10 effective, 1 shadowed, 1 conditional, 0 opaque.",
    );
  });

  it("reports facet composition sorted by facet name", async () => {
    const claims = byRule(
      analyze(await load("valid-report.json")),
      "facet-composition",
    );
    expect(claims.map((c) => c.claim)).toEqual([
      "The harness declares 3 'actions' element(s).",
      "The harness declares 1 'controls' element(s).",
      "The harness declares 4 'instructions' element(s).",
      "The harness declares 2 'knowledge' element(s).",
    ]);
  });

  it("reports findings with cited element ids as evidence", async () => {
    const claims = byRule(
      analyze(await load("valid-report.json")),
      "finding-reported",
    );
    expect(claims).toHaveLength(2);
    expect(claims[0].claim).toContain("'shadowed-element' finding");
    expect(claims[0].evidence.map((e) => e.elementId).filter(Boolean)).toEqual([
      "claude-code:user:rules/style.md",
    ]);
  });

  it("downgrades stats-derived confidence on partial exports", async () => {
    const result = analyze(await load("valid-report-partial.json"));
    const [counts] = byRule(result, "element-counts");
    expect(counts.confidence).toBe(0.8);
    const [completeness] = byRule(result, "completeness-reported");
    expect(completeness.claim).toContain("'partial'");
    expect(completeness.claim).toContain("1 diagnostic");
  });

  it("emits no completeness claim for complete exports", async () => {
    const result = analyze(await load("valid-report.json"));
    expect(byRule(result, "completeness-reported")).toHaveLength(0);
  });

  it("escapes control characters in external strings", () => {
    const doc = {
      pflVersion: "1.0.0",
      command: "report",
      ok: true,
      completeness: "complete",
      diagnostics: [],
      data: {
        runtime: "claude-code",
        project: { id: "p", displayName: "evil\x1b[2J\nname" },
        stats: {
          observed: 0,
          effective: 0,
          shadowed: 0,
          conditional: 0,
          opaque: 0,
        },
        findings: [
          {
            rule: "broad-tool-access",
            message: "runs \x1b[1mBold\x1b[0m shell",
            elementIds: [],
          },
        ],
        interpretation: { classifierVersion: "1", origin: "stored" },
      },
    };
    const result = analyze(parsePflExport(doc, "inline"));
    for (const claim of result.claims) {
      expect(claim.claim).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    }
    const [runtime] = byRule(result, "runtime-described");
    expect(runtime.claim).toContain("\\u001b");
    const [finding] = byRule(result, "finding-reported");
    expect(finding.claim).toContain("\\u001b");
  });

  it("every registered rule id is documented in docs/rules.md", async () => {
    const doc = await readFile(
      fileURLToPath(new URL("../docs/rules.md", import.meta.url)),
      "utf8",
    );
    for (const rule of RULES) {
      expect(doc, rule.id).toContain(`\`${rule.id}\``);
    }
  });
});
