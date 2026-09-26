import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/application/analyze.js";
import { RULES } from "../src/application/rules.js";
import type { Claim } from "../src/domain/claim.js";
import { sanitizeText } from "../src/domain/sanitize.js";
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
  /^(?:|\/data(?:\/.*)?|\/pflVersion|\/completeness|\/diagnostics(?:\/\d+)?)$/;

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

  it("normalizes unsafe characters in provenance strings copied from the export", () => {
    const doc = {
      pflVersion: "1.0.0",
      command: "report",
      ok: true,
      completeness: "complete",
      diagnostics: [],
      data: {
        runtime: "codex",
        runtimeName: "cli\u202eengine",
        project: { id: "p", displayName: "d" },
        observedSnapshotId: "snap\u2028shot",
        resolvedSnapshotId: "res\ufeffid",
        stats: {
          observed: 0,
          effective: 0,
          shadowed: 0,
          conditional: 0,
          opaque: 0,
        },
        findings: [],
        interpretation: { classifierVersion: "v\x7f1", origin: "stored" },
      },
    };
    const result = analyze(parsePflExport(doc, "inline"));
    expect(result.claims.length).toBeGreaterThan(0);
    for (const claim of result.claims) {
      expect(claim.provenance.runtimeName).toBe("cli\\u202eengine");
      expect(claim.provenance.observedSnapshotId).toBe("snap\\u2028shot");
      expect(claim.provenance.resolvedSnapshotId).toBe("res\\ufeffid");
      expect(claim.provenance.classifierVersion).toBe("v\\u007f1");
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
      command: "report" as const,
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
      command: "report" as const,
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
    const { EXPORT_RULES } = await import("../src/application/export-rules.js");
    const doc = await readFile(
      fileURLToPath(new URL("../docs/rules.md", import.meta.url)),
      "utf8",
    );
    for (const rule of [...RULES, ...EXPORT_RULES]) {
      expect(doc, rule.id).toContain(`\`${rule.id}\``);
    }
  });
});

describe("export snapshot rules", () => {
  const EXPORT_FIXTURES = [
    "valid-export.json",
    "valid-export-empty.json",
    "valid-export-partial.json",
  ];

  it("emits only schema-valid claims for every valid export fixture", async () => {
    for (const name of EXPORT_FIXTURES) {
      const result = analyze(await load(name));
      expect(result.source.command, name).toBe("export");
      expect(() => assertValidResult(result), name).not.toThrow();
    }
  });

  it("is deterministic for the same export input", async () => {
    const input = await load("valid-export.json");
    expect(JSON.stringify(analyze(input))).toBe(JSON.stringify(analyze(input)));
  });

  it("every claim carries evidence, provenance, and a registered ruleId", async () => {
    const { EXPORT_RULES } = await import("../src/application/export-rules.js");
    for (const name of EXPORT_FIXTURES) {
      const input = await load(name);
      const result = analyze(input);
      expect(result.claims.length, name).toBeGreaterThan(0);
      for (const claim of result.claims) {
        expect(claim.evidence.length, name).toBeGreaterThanOrEqual(1);
        for (const evidence of claim.evidence)
          expect(evidence.pointer, name).toMatch(ALLOWED_POINTER);
        expect(claim.provenance.sourceFile, name).toBe(fixture(name));
        expect(claim.provenance.exportVersion, name).toBe(input.pflVersion);
        expect(claim.provenance.transform[0], name).toBe("pfl-export-envelope");
        expect(claim.provenance.transform, name).toContain(
          `rule:${claim.ruleId}`,
        );
        expect(
          EXPORT_RULES.some((rule) => rule.id === claim.ruleId),
          `${name} ${claim.ruleId}`,
        ).toBe(true);
        expect(claim.provenance.interpretationOrigin, name).toMatch(
          /^(stored|recomputed)$/,
        );
        expect(claim.confidence, name).toBeGreaterThanOrEqual(0);
        expect(claim.confidence, name).toBeLessThanOrEqual(1);
      }
    }
  });

  it("describes the runtime, adapter, and project", async () => {
    const [claim] = byRule(
      analyze(await load("valid-export.json")),
      "export-described",
    );
    expect(claim.claim).toBe(
      "The export describes a 'claude-code' harness for project 'owner/repo' via adapter 'claude-code' version '0.1.1' (runtime compatibility 'verified').",
    );
    expect(claim.evidence.map((e) => e.pointer)).toEqual([
      "/data/runtime/id",
      "/data/runtime/adapter",
      "/data/project/displayName",
    ]);
  });

  it("reports joined contents and nullable-layer counts", async () => {
    const [claim] = byRule(
      analyze(await load("valid-export.json")),
      "export-snapshot-contents",
    );
    expect(claim.claim).toBe(
      "The export joins 3 element(s) by id — 2 with a resolved layer and 1 with an interpretation — alongside 2 relation(s) and 2 finding(s).",
    );
    expect(claim.confidence).toBe(1);

    const [empty] = byRule(
      analyze(await load("valid-export-empty.json")),
      "export-snapshot-contents",
    );
    expect(empty.claim).toBe(
      "The export joins 0 element(s) by id — 0 with a resolved layer and 0 with an interpretation — alongside 0 relation(s) and 0 finding(s).",
    );

    const [partial] = byRule(
      analyze(await load("valid-export-partial.json")),
      "export-snapshot-contents",
    );
    expect(partial.confidence).toBe(0.8);
    expect(partial.claim).toContain("2 element(s)");
    expect(partial.claim).toContain("1 with a resolved layer");
    expect(partial.claim).toContain("1 with an interpretation");
  });

  it("reports interpretation provenance from the export's declared fields", async () => {
    const [claim] = byRule(
      analyze(await load("valid-export.json")),
      "export-interpretation-provenance",
    );
    expect(claim.claim).toBe(
      "The export's interpretation was produced by classifier 'pfl-native' version '5' with origin 'stored'; resolution used semantics version '2' with confidence 'verified'.",
    );
    expect(claim.evidence.map((e) => e.pointer)).toEqual([
      "/data/interpretation",
      "/data/resolution",
    ]);
    expect(claim.provenance.observedSnapshotId).toBe("obs_0123456789ab");
    expect(claim.provenance.resolvedSnapshotId).toBe("res_0123456789ab");
    expect(claim.provenance.classifierVersion).toBe("5");
  });

  it("reports only warning and error diagnostics", async () => {
    const claims = byRule(
      analyze(await load("valid-export-partial.json")),
      "diagnostic-reported",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].claim).toBe(
      "The export reports diagnostic 'runtime-version-unverified' (warning) at '~/.codex/config.toml': runtime version 3.0.0 is newer than the verified range",
    );
    expect(claims[0].evidence.map((e) => e.pointer)).toEqual([
      "/diagnostics/1",
    ]);
  });

  it("reports completeness only when the export is not complete", async () => {
    expect(
      byRule(analyze(await load("valid-export.json")), "completeness-reported"),
    ).toHaveLength(0);
    const [claim] = byRule(
      analyze(await load("valid-export-partial.json")),
      "completeness-reported",
    );
    expect(claim.claim).toBe(
      "The export is marked 'partial' with 2 diagnostic(s) recorded.",
    );
    expect(claim.evidence.map((e) => e.pointer)).toEqual([
      "/completeness",
      "/diagnostics",
    ]);
  });

  it("sanitizes untrusted strings inside claim prose", () => {
    const doc = {
      pflVersion: "1.0.0",
      command: "export",
      ok: true,
      completeness: "complete",
      diagnostics: [
        {
          severity: "warning",
          code: "w",
          message: "runs \x1b[1mBold\x1b[0m",
          path: "p\u202ex",
        },
      ],
      data: {
        project: { id: "p", displayName: "evil\x1b[2J\nname" },
        runtime: {
          id: "claude-code",
          version: null,
          adapter: {
            id: "claude-code",
            version: "0.1.1",
            runtimeCompatibility: "unverified",
          },
        },
        snapshot: {
          observedSnapshotId: "obs\ufeffid",
          resolvedSnapshotId: "res\u2028id",
          capturedAt: "t",
          schemaVersion: "1",
        },
        resolution: {
          semanticsVersion: "2",
          confidence: "unverified-runtime-version",
        },
        elements: [],
        relations: [],
        findings: [],
        interpretation: {
          classifier: { id: "c", version: "v\x7f1" },
          origin: "recomputed",
        },
      },
    };
    const result = analyze(parsePflExport(doc, "inline"));
    for (const claim of result.claims) {
      expect(sanitizeText(claim.claim)).toBe(claim.claim);
      expect(claim.provenance.observedSnapshotId).toBe("obs\\ufeffid");
      expect(claim.provenance.resolvedSnapshotId).toBe("res\\u2028id");
      expect(claim.provenance.classifierVersion).toBe("v\\u007f1");
    }
    const [diag] = byRule(result, "diagnostic-reported");
    expect(diag.claim).toContain("\\u001b");
    expect(diag.claim).toContain("\\u202e");
  });
});

describe("diff comparison rules", () => {
  const DIFF_FIXTURES = [
    "valid-diff.json",
    "valid-diff-empty.json",
    "valid-diff-partial.json",
  ];

  function diffDoc(data: Record<string, unknown>) {
    return {
      pflVersion: "1.0.0",
      command: "diff",
      ok: true,
      completeness: "complete",
      diagnostics: [],
      data: {
        runtime: "claude-code",
        observedSnapshotIdA: "obs_a",
        observedSnapshotIdB: "obs_b",
        resolvedSnapshotIdA: "res_a",
        resolvedSnapshotIdB: "res_b",
        structural: {
          added: 0,
          removed: 0,
          changed: 0,
          addedIds: [],
          removedIds: [],
          changedIds: [],
        },
        effective: {
          newlyEffective: 0,
          noLongerEffective: 0,
          activationChanged: 0,
          statusChanges: [],
        },
        facetDeltas: {},
        relations: { added: [], removed: [] },
        findings: { added: [], removed: [] },
        versionNotes: [],
        interpretation: {
          a: { classifierVersion: "5", origin: "stored" },
          b: { classifierVersion: "5", origin: "stored" },
        },
        ...data,
      },
    };
  }

  it("emits only schema-valid claims for every valid diff fixture", async () => {
    for (const name of DIFF_FIXTURES) {
      const result = analyze(await load(name));
      expect(result.source.command, name).toBe("diff");
      expect(() => assertValidResult(result), name).not.toThrow();
    }
  });

  it("is deterministic for the same diff input", async () => {
    const input = await load("valid-diff.json");
    expect(JSON.stringify(analyze(input))).toBe(JSON.stringify(analyze(input)));
  });

  it("every claim carries evidence, provenance, and a registered ruleId", async () => {
    const { DIFF_RULES } = await import("../src/application/diff-rules.js");
    for (const name of DIFF_FIXTURES) {
      const input = await load(name);
      const result = analyze(input);
      expect(result.claims.length, name).toBeGreaterThan(0);
      for (const claim of result.claims) {
        expect(claim.evidence.length, name).toBeGreaterThanOrEqual(1);
        for (const evidence of claim.evidence)
          expect(evidence.pointer, name).toMatch(ALLOWED_POINTER);
        expect(claim.provenance.sourceFile, name).toBe(fixture(name));
        expect(claim.provenance.exportVersion, name).toBe(input.pflVersion);
        expect(claim.provenance.transform, name).toContain(
          `rule:${claim.ruleId}`,
        );
        expect(
          DIFF_RULES.some((rule) => rule.id === claim.ruleId),
          `${name} ${claim.ruleId}`,
        ).toBe(true);
        expect(claim.confidence, name).toBeGreaterThanOrEqual(0);
        expect(claim.confidence, name).toBeLessThanOrEqual(1);
      }
    }
  });

  it("describes the A to B direction and runtime", async () => {
    const [claim] = byRule(
      analyze(await load("valid-diff.json")),
      "diff-described",
    );
    expect(claim.claim).toBe(
      "The diff compares snapshot 'res_aaa111' (observed 'obs_aaa111') to 'res_bbb222' (observed 'obs_bbb222') for runtime 'claude-code'.",
    );
    expect(claim.evidence.map((e) => e.pointer)).toContain(
      "/data/resolvedSnapshotIdA",
    );
    expect(claim.evidence.map((e) => e.pointer)).toContain(
      "/data/resolvedSnapshotIdB",
    );
  });

  it("keeps diff provenance to sourceFile, pflVersion, and transform", async () => {
    // A diff has two snapshot ids and two classifier versions; the
    // single-valued provenance fields cannot express them, so they ride in
    // claim text instead (docs/rules.md, docs/pfl-export-contract.md).
    const result = analyze(await load("valid-diff.json"));
    for (const claim of result.claims) {
      expect(claim.provenance.classifierVersion).toBeUndefined();
      expect(claim.provenance.observedSnapshotId).toBeUndefined();
      expect(claim.provenance.resolvedSnapshotId).toBeUndefined();
      expect(claim.provenance.interpretationOrigin).toBeUndefined();
    }
  });

  it("reports per-side interpretation provenance without a classifier id", async () => {
    const [claim] = byRule(
      analyze(await load("valid-diff.json")),
      "diff-interpretation-provenance",
    );
    expect(claim.claim).toContain("'5' with origin 'stored'");
    expect(claim.claim).toContain("'6' with origin 'recomputed'");
  });

  it("reports only warning and error diagnostics", async () => {
    const claims = byRule(
      analyze(await load("valid-diff-partial.json")),
      "diagnostic-reported",
    );
    expect(claims.length).toBe(1);
    expect(claims[0].claim).toContain("snapshot-unreadable");
    expect(claims[0].claim).toContain("/redacted/path");
    expect(claims[0].evidence[0].pointer).toBe("/diagnostics/0");
  });

  it("reports completeness only when the diff is not complete", async () => {
    expect(
      byRule(analyze(await load("valid-diff.json")), "completeness-reported"),
    ).toEqual([]);
    const [claim] = byRule(
      analyze(await load("valid-diff-partial.json")),
      "completeness-reported",
    );
    expect(claim.claim).toContain("'partial'");
  });

  it("sanitizes untrusted strings inside claim prose", () => {
    const doc = {
      pflVersion: "1.0.0",
      command: "diff",
      ok: true,
      completeness: "complete",
      diagnostics: [],
      data: {
        runtime: "claude-code\x1b[2J",
        observedSnapshotIdA: "obs\ufeffa",
        observedSnapshotIdB: "obs_b",
        resolvedSnapshotIdA: "res\u2028a",
        resolvedSnapshotIdB: "res_b",
        structural: {
          added: 0,
          removed: 0,
          changed: 0,
          addedIds: [],
          removedIds: [],
          changedIds: [],
        },
        effective: {
          newlyEffective: 0,
          noLongerEffective: 0,
          activationChanged: 0,
          statusChanges: [],
        },
        facetDeltas: {},
        relations: { added: [], removed: [] },
        findings: { added: [], removed: [] },
        versionNotes: [],
        interpretation: {
          a: { classifierVersion: "v\x7f5", origin: "stored" },
          b: { classifierVersion: "5", origin: "stored" },
        },
      },
    };
    const result = analyze(parsePflExport(doc, "inline"));
    for (const claim of result.claims)
      expect(sanitizeText(claim.claim)).toBe(claim.claim);
    const [described] = byRule(result, "diff-described");
    expect(described.claim).toContain("\\u001b");
    expect(described.claim).toContain("\\ufeff");
    expect(described.claim).toContain("\\u2028");
    const [prov] = byRule(result, "diff-interpretation-provenance");
    expect(prov.claim).toContain("v\\u007f5");
  });

  it("describes added, removed, and changed element ids with direction", async () => {
    const result = analyze(await load("valid-diff.json"));
    const [added] = byRule(result, "diff-element-added");
    expect(added.claim).toBe(
      "Element 'el_added' is present in snapshot B with no counterpart in snapshot A.",
    );
    expect(added.evidence).toEqual([
      { pointer: "/data/structural/addedIds/0", elementId: "el_added" },
    ]);
    const [removed] = byRule(result, "diff-element-removed");
    expect(removed.claim).toBe(
      "Element 'el_removed' was present in snapshot A and is absent from snapshot B.",
    );
    const [changed] = byRule(result, "diff-element-changed");
    expect(changed.claim).toContain("'el_changed'");
    expect(changed.claim).toContain("present in both snapshots");
    expect(changed.claim).not.toMatch(/improve|regress|better|worse/i);
  });

  it("reports empty structural sections without claiming harness identity", async () => {
    const result = analyze(await load("valid-diff-empty.json"));
    const [added] = byRule(result, "diff-element-added");
    expect(added.claim).toBe(
      "The diff reports no elements present only in snapshot B.",
    );
    expect(added.evidence).toEqual([{ pointer: "/data/structural/added" }]);
    expect(byRule(result, "diff-element-removed")[0].evidence[0].pointer).toBe(
      "/data/structural/removed",
    );
    expect(byRule(result, "diff-element-changed")[0].evidence[0].pointer).toBe(
      "/data/structural/changed",
    );
    for (const claim of result.claims)
      expect(claim.claim).not.toMatch(
        /identical|same harness|unchanged harness/i,
      );
  });

  it("reports aggregate effective totals with the inclusion caveat", async () => {
    const [claim] = byRule(
      analyze(await load("valid-diff.json")),
      "diff-effective-totals",
    );
    expect(claim.claim).toContain("2 element(s) became effective");
    expect(claim.claim).toContain("1 stopped being effective");
    expect(claim.claim).toContain("potentially effective");
    expect(claim.claim).toContain(
      "need not equal the number of status-change records",
    );
  });

  it("describes status transitions and links them to changed ids only when listed", async () => {
    const claims = byRule(
      analyze(await load("valid-diff.json")),
      "diff-status-transition",
    );
    expect(claims).toHaveLength(2);
    expect(claims[0].claim).toBe(
      "Element 'el_changed' resolved status went from 'shadowed' in A to 'effective' in B; it is also listed among the changed element ids.",
    );
    expect(claims[0].evidence.map((e) => e.pointer)).toEqual([
      "/data/effective/statusChanges/0/id",
      "/data/effective/statusChanges/0/from",
      "/data/effective/statusChanges/0/to",
      "/data/structural/changedIds/0",
    ]);
    expect(claims[1].claim).toBe(
      "Element 'el_other' resolved status went from 'effective' in A to 'unresolved' in B.",
    );
    expect(claims[1].evidence.map((e) => e.pointer)).toEqual([
      "/data/effective/statusChanges/1/id",
      "/data/effective/statusChanges/1/from",
      "/data/effective/statusChanges/1/to",
    ]);
  });

  it("phrases null status-change sides as absence, not a negative fact", () => {
    const doc = diffDoc({
      structural: {
        added: 1,
        removed: 0,
        changed: 0,
        addedIds: ["el_new"],
        removedIds: [],
        changedIds: [],
      },
      effective: {
        newlyEffective: 1,
        noLongerEffective: 0,
        activationChanged: 0,
        statusChanges: [{ id: "el_new", from: null, to: "effective" }],
      },
    });
    const [claim] = byRule(
      analyze(parsePflExport(doc, "inline")),
      "diff-status-transition",
    );
    expect(claim.claim).toBe(
      "Element 'el_new' resolved status went from no resolved status in A to 'effective' in B.",
    );
    expect(claim.claim).not.toMatch(/broken|missing|absent.*bad/i);
  });

  it("describes a pure content change without inventing a status transition", () => {
    const doc = diffDoc({
      structural: {
        added: 0,
        removed: 0,
        changed: 1,
        addedIds: [],
        removedIds: [],
        changedIds: ["el_x"],
      },
    });
    const result = analyze(parsePflExport(doc, "inline"));
    const [changed] = byRule(result, "diff-element-changed");
    expect(changed.claim).toContain("'el_x'");
    expect(byRule(result, "diff-status-transition")).toEqual([]);
  });

  it("describes added and removed relations with direction", async () => {
    const result = analyze(await load("valid-diff.json"));
    const [added] = byRule(result, "diff-relation-added");
    expect(added.claim).toBe(
      "Present in B but not in A: element 'el_added' overrides element 'el_changed'.",
    );
    expect(added.evidence.map((e) => e.pointer)).toEqual([
      "/data/relations/added/0/type",
      "/data/relations/added/0/from",
      "/data/relations/added/0/to",
    ]);
    const [removed] = byRule(result, "diff-relation-removed");
    expect(removed.claim).toBe(
      "Present in A but not in B: element 'el_removed' shadows element 'el_other'.",
    );
  });

  it("reports legacy relation types without interpreting semantics", () => {
    const doc = diffDoc({
      relations: {
        added: [{ type: "contains", from: "el_a", to: "el_b" }],
        removed: [],
      },
    });
    const [claim] = byRule(
      analyze(parsePflExport(doc, "inline")),
      "diff-relation-added",
    );
    expect(claim.claim).toContain("'contains'");
    expect(claim.claim).toContain("semantics not interpreted");
  });

  it("describes added and removed findings with cited ids", async () => {
    const result = analyze(await load("valid-diff.json"));
    const [added] = byRule(result, "diff-finding-added");
    expect(added.claim).toContain("'shadowed-element'");
    expect(added.claim).toContain("'el_changed'");
    expect(added.claim).not.toMatch(/improve|better/i);
    const [removed] = byRule(result, "diff-finding-removed");
    expect(removed.claim).toContain("'broad-tool-access'");
    expect(removed.claim).toContain("'el_removed', 'el_other'");
    expect(removed.evidence.map((e) => e.pointer)).toEqual([
      "/data/findings/removed/0/rule",
      "/data/findings/removed/0/message",
      "/data/findings/removed/0/elementIds/0",
      "/data/findings/removed/0/elementIds/1",
    ]);
  });

  it("notes a same-rule, same-elements add/remove as a reworded pair, not a proven harness change", () => {
    const doc = diffDoc({
      findings: {
        added: [
          {
            rule: "broad-tool-access",
            message: "element el_a grants wide access now",
            elementIds: ["el_a"],
          },
        ],
        removed: [
          {
            rule: "broad-tool-access",
            message: "element el_a granted wide access",
            elementIds: ["el_a"],
          },
          {
            rule: "unrelated",
            message: "different finding",
            elementIds: ["el_z"],
          },
        ],
      },
    });
    const claims = byRule(
      analyze(parsePflExport(doc, "inline")),
      "diff-finding-added",
    );
    expect(claims[0].claim).toContain("add-plus-remove pair");
    expect(claims[0].claim).toContain(
      "does not by itself prove a harness change",
    );
    expect(claims[0].evidence.map((e) => e.pointer)).toEqual([
      "/data/findings/added/0/rule",
      "/data/findings/added/0/message",
      "/data/findings/added/0/elementIds/0",
      "/data/findings/removed/0",
    ]);
    const removed = byRule(
      analyze(parsePflExport(doc, "inline")),
      "diff-finding-removed",
    );
    expect(removed[0].claim).toContain("add-plus-remove pair");
    expect(removed[0].claim).toContain(
      "does not by itself prove a harness change",
    );
    expect(removed[0].evidence.map((e) => e.pointer)).toEqual([
      "/data/findings/removed/0/rule",
      "/data/findings/removed/0/message",
      "/data/findings/removed/0/elementIds/0",
      "/data/findings/added/0",
    ]);
    expect(removed[1].claim).not.toContain("add-plus-remove");
  });

  it("caps the listed element ids inside a finding claim", () => {
    const doc = diffDoc({
      findings: {
        added: [
          {
            rule: "r",
            message: "m",
            elementIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"],
          },
        ],
        removed: [],
      },
    });
    const [claim] = byRule(
      analyze(parsePflExport(doc, "inline")),
      "diff-finding-added",
    );
    expect(claim.claim).toContain("'e1'");
    expect(claim.claim).toContain("and 2 more");
    expect(claim.claim).not.toContain("'e7'");
  });

  it("describes facet deltas including zero, never as improvement or per-element attribution", async () => {
    const result = analyze(await load("valid-diff.json"));
    const deltas = byRule(result, "diff-facet-delta");
    expect(deltas).toHaveLength(6);
    const controls = deltas.find((c) => c.claim.includes("'controls'"));
    expect(controls?.claim).toContain("increased by 2");
    expect(controls?.claim).toContain(
      "not attributable to an individual element",
    );
    const memory = deltas.find((c) => c.claim.includes("'memory'"));
    expect(memory?.claim).toContain("decreased by 1");
    const knowledge = deltas.find((c) => c.claim.includes("'knowledge'"));
    expect(knowledge?.claim).toContain("is unchanged");
    for (const claim of deltas)
      expect(claim.claim).not.toMatch(/improve|regress|better|worse/i);
  });

  it("escapes facet names inside evidence pointers per RFC 6901", () => {
    const doc = diffDoc({ facetDeltas: { "a/b~c": 1 } });
    const [claim] = byRule(
      analyze(parsePflExport(doc, "inline")),
      "diff-facet-delta",
    );
    expect(claim.claim).toContain("'a/b~c'");
    expect(claim.evidence).toEqual([{ pointer: "/data/facetDeltas/a~1b~0c" }]);
  });

  it("rejects malformed pointers in the shared assertion pattern", () => {
    expect("foobar").not.toMatch(ALLOWED_POINTER);
    expect("/dat").not.toMatch(ALLOWED_POINTER);
    expect("/data/findings/added/0/elementIds/3").toMatch(ALLOWED_POINTER);
    expect("").toMatch(ALLOWED_POINTER);
  });

  it("quotes version notes as prose caveats", async () => {
    const notes = byRule(
      analyze(await load("valid-diff.json")),
      "diff-version-note",
    );
    expect(notes).toHaveLength(2);
    expect(notes[0].claim).toBe(
      "The diff records a comparison caveat: 'classifier version differs: 5 → 6'.",
    );
    expect(notes[0].evidence[0].pointer).toBe("/data/versionNotes/0");
  });

  it("flags recomputed origins and differing classifier versions as caveats", async () => {
    const caveats = byRule(
      analyze(await load("valid-diff.json")),
      "diff-comparison-caveats",
    );
    expect(caveats).toHaveLength(2);
    expect(caveats[0].claim).toContain("Side B");
    expect(caveats[0].claim).toContain("recomputed rather than stored");
    expect(caveats[1].claim).toContain("'5' vs '6'");
    expect(caveats[1].claim).toContain(
      "may reflect the classifier change rather than a harness change",
    );
    const quiet = analyze(
      parsePflExport(
        diffDoc({
          interpretation: {
            a: { classifierVersion: "5", origin: "stored" },
            b: { classifierVersion: "5", origin: "stored" },
          },
        }),
        "inline",
      ),
    );
    expect(byRule(quiet, "diff-comparison-caveats")).toEqual([]);
  });

  it("keeps claim order stable: new rules before diagnostic and completeness", async () => {
    const result = analyze(await load("valid-diff-partial.json"));
    const ruleIds = result.claims.map((claim) => claim.ruleId);
    const first = (id: string) => ruleIds.indexOf(id);
    expect(first("diff-described")).toBe(0);
    expect(first("diff-element-added")).toBeGreaterThan(
      first("diff-interpretation-provenance"),
    );
    expect(first("diff-comparison-caveats")).toBeLessThan(
      first("diagnostic-reported"),
    );
    expect(first("completeness-reported")).toBe(ruleIds.length - 1);
  });

  it("every registered diff rule id is documented in docs/rules.md", async () => {
    const { DIFF_RULES } = await import("../src/application/diff-rules.js");
    const doc = await readFile(
      fileURLToPath(new URL("../docs/rules.md", import.meta.url)),
      "utf8",
    );
    for (const rule of DIFF_RULES) {
      expect(doc, rule.id).toContain(`\`${rule.id}\``);
    }
  });
});
