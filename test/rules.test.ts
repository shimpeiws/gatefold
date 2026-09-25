import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/application/analyze.js";
import { RULES } from "../src/application/rules.js";
import type { Claim } from "../src/domain/claim.js";
import { assertValidResult } from "../src/domain/validate.js";
import { parsePflExport, readPflExport } from "../src/input/pfl-export.js";
import { formatJson } from "../src/output/json.js";

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

  it("stamps every claim with its producing rule's stable ruleId", async () => {
    for (const name of [
      "valid-report.json",
      "valid-report-minimal.json",
      "valid-report-partial.json",
      "empty-report.json",
    ]) {
      const result = analyze(await load(name));
      for (const claim of result.claims) {
        expect(claim.ruleId.length, name).toBeGreaterThan(0);
        expect(claim.provenance.transform, `${name} ${claim.ruleId}`).toContain(
          `rule:${claim.ruleId}`,
        );
        expect(
          RULES.some((rule) => rule.id === claim.ruleId),
          `${name} ${claim.ruleId}`,
        ).toBe(true);
      }
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

  it("keeps every cited element id as evidence on an accepted worst-case report", () => {
    const doc = {
      pflVersion: "1.0.0",
      command: "report",
      ok: true,
      completeness: "complete",
      diagnostics: [],
      data: {
        runtime: "codex",
        project: { id: "p", displayName: "d" },
        stats: {
          observed: 0,
          effective: 0,
          shadowed: 0,
          conditional: 0,
          opaque: 0,
        },
        findings: Array.from({ length: 10 }, (_, f) => ({
          rule: "r",
          message: "m",
          elementIds: Array.from({ length: 1_000 }, (_, i) => `f${f}-e${i}`),
        })),
        interpretation: { classifierVersion: "1", origin: "stored" },
      },
    };
    const result = analyze(parsePflExport(doc, "inline"));
    const ids = byRule(result, "finding-reported").flatMap((claim) =>
      claim.evidence.flatMap((e) =>
        e.elementId === undefined ? [] : [e.elementId],
      ),
    );
    expect(ids).toHaveLength(10_000);
    expect(new Set(ids).size).toBe(10_000);
    expect(ids).toContain("f9-e999");
  });

  it("reports each warning/error diagnostic with code, severity, path, and message", async () => {
    const result = analyze(await load("valid-report-partial.json"));
    const claims = byRule(result, "diagnostic-reported");
    expect(claims).toHaveLength(1);
    expect(claims[0].claim).toBe(
      "The export reports diagnostic 'runtime-version-unverified' (warning) at '~/.pfl/projects/git-0f214d60555919a5': runtime version is newer than verified",
    );
    expect(claims[0].evidence.map((e) => e.pointer)).toEqual([
      "/diagnostics/0",
    ]);
    expect(claims[0].confidence).toBe(1);
  });

  it("reports error diagnostics on a partial export", () => {
    const doc = {
      pflVersion: "1.0.0",
      command: "report",
      ok: true,
      completeness: "partial",
      diagnostics: [
        {
          severity: "info",
          code: "cache-warm",
          message: "cache was warm",
        },
        {
          severity: "error",
          code: "snapshot-truncated",
          message: "snapshot was truncated",
          path: "/data/stats",
        },
        { severity: "warning", code: "degraded", message: "partial coverage" },
      ],
      data: {
        runtime: "codex",
        project: { id: "p", displayName: "d" },
        stats: {
          observed: 0,
          effective: 0,
          shadowed: 0,
          conditional: 0,
          opaque: 0,
        },
        findings: [],
        interpretation: { classifierVersion: "1", origin: "recomputed" },
      },
    };
    const claims = byRule(
      analyze(parsePflExport(doc, "inline")),
      "diagnostic-reported",
    );
    expect(claims.map((c) => c.claim)).toEqual([
      "The export reports diagnostic 'snapshot-truncated' (error) at '/data/stats': snapshot was truncated",
      "The export reports diagnostic 'degraded' (warning): partial coverage",
    ]);
    expect(claims.map((c) => c.evidence[0].pointer)).toEqual([
      "/diagnostics/1",
      "/diagnostics/2",
    ]);
  });

  it("records interpretation metadata in provenance", async () => {
    const result = analyze(await load("valid-report.json"));
    for (const claim of result.claims) {
      expect(claim.provenance.classifierVersion).toBe("1");
      expect(claim.provenance.interpretationOrigin).toBe("stored");
      expect(claim.provenance.observedSnapshotId).toBe("obs-abc123");
      expect(claim.provenance.runtimeName).toBe("Claude Code");
    }
    const minimal = analyze(await load("valid-report-minimal.json"));
    for (const claim of minimal.claims) {
      expect(claim.provenance.interpretationOrigin).toBe("recomputed");
      expect(claim.provenance.observedSnapshotId).toBeUndefined();
      expect(claim.provenance.runtimeName).toBeUndefined();
    }
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

  it("emits one observation-status claim combining completeness, diagnostics, and origin", async () => {
    const complete = byRule(
      analyze(await load("valid-report.json")),
      "observation-status",
    );
    expect(complete).toHaveLength(1);
    expect(complete[0].ruleId).toBe("observation-status");
    expect(complete[0].claim).toBe(
      "The export reports completeness 'complete' with no diagnostics; the interpretation was produced by classifier version '1' with origin 'stored'.",
    );
    expect(complete[0].evidence.map((e) => e.pointer)).toEqual([
      "/completeness",
      "/diagnostics",
      "/data/interpretation",
    ]);
    expect(complete[0].confidence).toBe(1);
    expect(complete[0].provenance.observedSnapshotId).toBe("obs-abc123");
  });

  it("reports diagnostic severities and recomputed origin on partial reports", async () => {
    const [claim] = byRule(
      analyze(await load("valid-report-partial.json")),
      "observation-status",
    );
    expect(claim.claim).toBe(
      "The export reports completeness 'partial' with 1 diagnostic(s) (0 info, 1 warning, 0 error); the interpretation was produced by classifier version '1' with origin 'recomputed'.",
    );
  });

  it("describes unknown completeness without inferring a cause", () => {
    const doc = {
      pflVersion: "1.0.0",
      command: "report",
      ok: true,
      completeness: "unknown",
      diagnostics: [
        { severity: "error", code: "snapshot-missing", message: "gone" },
      ],
      data: {
        runtime: "codex",
        project: { id: "p", displayName: "d" },
        stats: {
          observed: 0,
          effective: 0,
          shadowed: 0,
          conditional: 0,
          opaque: 0,
        },
        findings: [],
        interpretation: { classifierVersion: "2", origin: "stored" },
      },
    };
    const [claim] = byRule(
      analyze(parsePflExport(doc, "inline")),
      "observation-status",
    );
    expect(claim.claim).toBe(
      "The export reports completeness 'unknown' with 1 diagnostic(s) (0 info, 0 warning, 1 error); the interpretation was produced by classifier version '2' with origin 'stored'.",
    );
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

  it("escapes bidi, zero-width, and line-separator characters", () => {
    const input = {
      sourcePath: "inline",
      pflVersion: "1.0.0",
      completeness: "complete" as const,
      diagnostics: [],
      data: {
        runtime: "claude-code",
        project: { id: "p", displayName: "p\u200bq" },
        stats: {
          observed: 0,
          effective: 0,
          shadowed: 0,
          conditional: 0,
          opaque: 0,
        },
        findings: [
          {
            rule: "r",
            message: "ok \u202egnirts\u202c\u2028next\ufeff",
            elementIds: [],
          },
        ],
        interpretation: { classifierVersion: "1", origin: "stored" as const },
      },
    };
    const result = analyze(input);
    for (const claim of result.claims) {
      expect(claim.claim).not.toMatch(/[\u200b\u2028\u202c\u202e\ufeff]/);
    }
    const [finding] = byRule(result, "finding-reported");
    expect(finding.claim).toContain("\\u202e");
    expect(finding.claim).toContain("\\u2028");
  });

  it("keeps the literal \\uXXXX text in JSON output, distinct from JSON escaping", () => {
    const input = {
      sourcePath: "inline",
      pflVersion: "1.0.0",
      completeness: "complete" as const,
      diagnostics: [],
      data: {
        runtime: "claude-code",
        project: { id: "p", displayName: "d" },
        stats: {
          observed: 0,
          effective: 0,
          shadowed: 0,
          conditional: 0,
          opaque: 0,
        },
        findings: [{ rule: "r", message: "bad ‮text", elementIds: [] }],
        interpretation: { classifierVersion: "1", origin: "stored" as const },
      },
    };
    const json = formatJson(analyze(input));
    // In the serialized JSON the normalized character reads as \\u202e;
    // parsing the document yields the literal \u202e text, not the raw char.
    expect(json).toContain("\\\\u202e");
    const parsed = JSON.parse(json);
    const finding = parsed.claims.find((c: Claim) =>
      c.claim.includes("finding"),
    );
    expect(finding.claim).toContain("\\u202e");
    expect(finding.claim).not.toContain("‮");
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
