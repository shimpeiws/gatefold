import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/application/analyze.js";
import { RULES } from "../src/application/rules.js";
import { assertValidResult } from "../src/domain/validate.js";
import { readPflExport } from "../src/input/pfl-export.js";

const dir = new URL("fixtures/pfl-export/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));

async function load(name: string) {
  return readPflExport(fixture(name));
}

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
        expect(evidence.pointer).toMatch(/^$|^\//);
      }
      expect(claim.provenance.sourceFile).toBe(fixture("valid-report.json"));
      expect(claim.provenance.exportVersion).toBe("1.0.0");
      expect(claim.provenance.transform[0]).toBe("pfl-report-envelope");
    }
  });

  it("describes the runtime and project", async () => {
    const result = analyze(await load("valid-report.json"));
    expect(result.claims[0].claim).toBe(
      "The export describes a 'claude-code' harness for project 'example-project'.",
    );
  });

  it("reports element counts", async () => {
    const result = analyze(await load("valid-report.json"));
    expect(result.claims[1].claim).toBe(
      "pfl observed 12 elements: 10 effective, 1 shadowed, 1 conditional, 0 opaque.",
    );
  });

  it("reports facet composition sorted by facet name", async () => {
    const result = analyze(await load("valid-report.json"));
    const facetClaims = result.claims.filter((c) =>
      c.provenance.transform.includes("rule:facet-composition"),
    );
    expect(facetClaims.map((c) => c.claim)).toEqual([
      "The harness declares 2 'hook' element(s).",
      "The harness declares 1 'mcp' element(s).",
      "The harness declares 3 'skill' element(s).",
      "The harness declares 4 'tool' element(s).",
    ]);
  });

  it("reports findings with cited element ids as evidence", async () => {
    const result = analyze(await load("valid-report.json"));
    const findingClaims = result.claims.filter((c) =>
      c.provenance.transform.includes("rule:finding-reported"),
    );
    expect(findingClaims).toHaveLength(2);
    expect(findingClaims[0].claim).toContain("'shadowed-element' finding");
    expect(
      findingClaims[0].evidence.map((e) => e.elementId).filter(Boolean),
    ).toEqual(["claude-code:user:rules/style.md"]);
  });

  it("downgrades stats-derived confidence on partial exports", async () => {
    const result = analyze(await load("valid-report-partial.json"));
    const counts = result.claims.find((c) =>
      c.provenance.transform.includes("rule:element-counts"),
    );
    expect(counts?.confidence).toBe(0.8);
    const completeness = result.claims.find((c) =>
      c.provenance.transform.includes("rule:completeness-reported"),
    );
    expect(completeness?.claim).toContain("'partial'");
    expect(completeness?.claim).toContain("1 diagnostic");
  });

  it("emits no completeness claim for complete exports", async () => {
    const result = analyze(await load("valid-report.json"));
    expect(
      result.claims.some((c) =>
        c.provenance.transform.includes("rule:completeness-reported"),
      ),
    ).toBe(false);
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
