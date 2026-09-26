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
    expect(finding.claim).not.toContain("\u202e");
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

  it("describes each element's observed layer with cited fields only", async () => {
    const claims = byRule(
      analyze(await load("valid-export-layers.json")),
      "element-observed-state",
    );
    expect(claims).toHaveLength(5);
    expect(claims[0].claim).toBe(
      "pfl observed element 'el_0fc92802d8f84176' at 'CLAUDE.md' as kind 'instructions' from origin 'project' (scope 'project'); observed status is 'observed'.",
    );
    expect(claims[0].evidence.map((e) => e.pointer)).toEqual([
      "/data/elements/0/id",
      "/data/elements/0/observed/native/kind",
      "/data/elements/0/observed/native/origin",
      "/data/elements/0/observed/source/path",
      "/data/elements/0/observed/native/scope",
      "/data/elements/0/observed/status",
    ]);
    expect(
      claims[0].evidence.every((e) => e.elementId === "el_0fc92802d8f84176"),
    ).toBe(true);
    const unreadable = claims[3];
    expect(unreadable.claim).toContain(
      "observed status is 'unreadable' ('unreadable')",
    );
    expect(unreadable.evidence.map((e) => e.pointer)).toContain(
      "/data/elements/3/observed/reason",
    );
    const skipped = claims[4];
    expect(skipped.claim).toContain(
      "observed status is 'skipped' ('symlink-not-followed')",
    );
    for (const claim of claims) expect(claim.confidence).toBe(1);
  });

  it("describes resolved layers, skips null layers, and qualifies 'effective'", async () => {
    const claims = byRule(
      analyze(await load("valid-export-layers.json")),
      "element-resolved-state",
    );
    expect(claims).toHaveLength(3);
    expect(claims[0].claim).toBe(
      "The resolved layer marks element 'el_0fc92802d8f84176' as 'effective' — potentially effective in the static environment, not evidence that an agent used it, activation 'always', strategy 'accumulate', applicable to 'project'; reason: accumulates with the other layers.",
    );
    expect(claims[0].evidence.map((e) => e.pointer)).toEqual([
      "/data/elements/0/id",
      "/data/elements/0/resolved/status",
      "/data/elements/0/resolved/activation",
      "/data/elements/0/resolved/resolution/strategy",
      "/data/elements/0/resolved/applicability",
      "/data/elements/0/resolved/resolution/reason",
    ]);
    expect(claims[1].claim).toContain("as 'shadowed'");
    expect(claims[1].claim).not.toContain("potentially effective");
    const conditional = claims[2];
    expect(conditional.claim).toContain("as 'conditional'");
    expect(conditional.claim).toContain("applicable to 'tool-event' ('Bash')");
    const elementIds = claims.map((claim) => claim.evidence[0].elementId);
    expect(elementIds).not.toContain("el_3dd48ff23ccabb12");
    expect(elementIds).not.toContain("el_9deadbeef00112233");
  });

  it("describes interpretations without treating a null layer as a negative finding", async () => {
    const claims = byRule(
      analyze(await load("valid-export-layers.json")),
      "element-interpretation",
    );
    expect(claims).toHaveLength(2);
    expect(claims[0].claim).toBe(
      "The classifier assigned element 'el_0fc92802d8f84176' facet(s) 'instructions' with confidence 'medium': defines agent behavior.",
    );
    expect(claims[0].evidence.map((e) => e.pointer)).toEqual([
      "/data/elements/0/id",
      "/data/elements/0/interpretation/facets",
      "/data/elements/0/interpretation/confidence",
      "/data/elements/0/interpretation/reason",
    ]);
    // 'medium' is the cited classification confidence, not the claim's own
    // confidence: the cited fields fully support this statement.
    expect(claims[0].confidence).toBe(1);
    expect(claims[1].claim).toBe(
      "The classifier recorded no facets for element 'el_2cc38ee12bb9aa01' with confidence 'unknown': no facet matched this element.",
    );
    expect(claims[1].evidence.map((e) => e.pointer)).toEqual([
      "/data/elements/2/id",
      "/data/elements/2/interpretation/facets",
      "/data/elements/2/interpretation/confidence",
      "/data/elements/2/interpretation/reason",
    ]);
    expect(
      claims.every(
        (claim) => claim.claim.includes("no interpretation") === false,
      ),
    ).toBe(true);
  });

  it("keeps element claims deterministic, sanitized, and document-local", async () => {
    const input = await load("valid-export-layers.json");
    const result = analyze(input);
    const elementClaims = result.claims.filter((claim) =>
      /element-(observed|resolved|interpretation)/.test(claim.ruleId),
    );
    expect(elementClaims.length).toBeGreaterThan(0);
    for (const claim of elementClaims) {
      expect(claim.claim).toBe(sanitizeText(claim.claim));
      expect(claim.evidence.length).toBeGreaterThan(0);
      for (const evidence of claim.evidence) {
        expect(evidence.pointer).toMatch(/^\/data\/elements\/\d+\//);
        expect(evidence.elementId).toBeTruthy();
      }
    }
  });

  it("escapes a hostile element id in human-readable evidence output", async () => {
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
        elements: [
          {
            id: "el_\x1b[2J\u202eevil",
            observed: {
              id: "el_\x1b[2J\u202eevil",
              native: { kind: "instructions", origin: "project", scope: null },
              source: {},
              inspectability: "observable",
              metadata: {},
              status: "observed",
            },
            resolved: null,
            interpretation: null,
          },
        ],
        relations: [],
        findings: [],
        interpretation: {
          classifier: { id: "pfl-native", version: "5" },
          origin: "stored",
        },
      },
    };
    const result = analyze(parsePflExport(doc, "inline"));
    const { formatHuman } = await import("../src/output/human.js");
    const rendered = formatHuman(result);
    expect(rendered).not.toContain("\x1b[2J");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).toContain("\\u001b");
    // JSON output keeps the raw id for machine correlation; only the
    // human renderer escapes it.
    const elementClaims = result.claims.filter((claim) =>
      claim.ruleId.startsWith("element-"),
    );
    expect(
      elementClaims.every((claim) =>
        claim.evidence.every((e) => e.elementId === "el_\x1b[2J\u202eevil"),
      ),
    ).toBe(true);
  });

  function exportDocWith(overrides: {
    elements?: unknown[];
    relations?: unknown[];
    findings?: unknown[];
  }) {
    return {
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
        elements: overrides.elements ?? [],
        relations: overrides.relations ?? [],
        findings: overrides.findings ?? [],
        interpretation: {
          classifier: { id: "pfl-native", version: "5" },
          origin: "stored",
        },
      },
    };
  }

  function layerElement(id: string) {
    return {
      id,
      observed: {
        id,
        native: { kind: "instructions", origin: "project", scope: null },
        source: {},
        inspectability: "observable",
        metadata: {},
        status: "observed",
      },
      resolved: null,
      interpretation: null,
    };
  }

  it("describes relations with direction and neutral legacy phrasing", async () => {
    const claims = byRule(
      analyze(await load("valid-export.json")),
      "export-relation-described",
    );
    expect(claims).toHaveLength(2);
    // 'from' is the winner: el_1ab… shadows el_0fc…, not the reverse.
    expect(claims[0].claim).toBe(
      "element 'el_1ab29cd03ef45678' shadows element 'el_0fc92802d8f84176'.",
    );
    expect(claims[0].evidence.map((e) => e.pointer)).toEqual([
      "/data/relations/0/type",
      "/data/relations/0/from",
      "/data/relations/0/to",
    ]);
    expect(claims[0].evidence[1].elementId).toBe("el_1ab29cd03ef45678");
    expect(claims[0].evidence[2].elementId).toBe("el_0fc92802d8f84176");
    expect(claims[1].claim).toBe(
      "element 'el_0fc92802d8f84176' accumulates with element 'el_1ab29cd03ef45678'.",
    );

    const doc = exportDocWith({
      elements: [layerElement("el_a"), layerElement("el_b")],
      relations: [
        { type: "overrides", from: "el_a", to: "el_b" },
        { type: "contains", from: "el_b", to: "el_a" },
      ],
    });
    const legacy = byRule(
      analyze(parsePflExport(doc, "inline")),
      "export-relation-described",
    );
    expect(legacy[0].claim).toBe("element 'el_a' overrides element 'el_b'.");
    expect(legacy[1].claim).toBe(
      "pfl declares a 'contains' relation from element 'el_b' to element 'el_a'.",
    );
  });

  it("contextualizes findings with element kind, path, and status", async () => {
    const claims = byRule(
      analyze(await load("valid-export.json")),
      "export-finding-context",
    );
    expect(claims).toHaveLength(3);
    expect(claims[0].claim).toBe(
      "Finding 'shadowed-element' states: element el_1ab29cd03ef45678 is shadowed by a managed entry. It references element 'el_1ab29cd03ef45678' (kind 'mcp-server' at '.mcp.json', observed status 'observed', resolved 'shadowed').",
    );
    expect(claims[0].evidence.map((e) => e.pointer)).toEqual([
      "/data/findings/0",
      "/data/findings/0/elementIds/0",
      "/data/elements/1/id",
      "/data/elements/1/observed/native/kind",
      "/data/elements/1/observed/source/path",
      "/data/elements/1/observed/status",
      "/data/elements/1/resolved/status",
    ]);
    // Null-layer element: no resolved status is fabricated.
    const skipped = claims.find((c) =>
      c.claim.includes("el_9deadbeef00112233"),
    );
    expect(skipped?.claim).toContain("observed status 'skipped'");
    expect(skipped?.claim).not.toContain("resolved");
    expect(skipped?.evidence.map((e) => e.pointer)).not.toContain(
      "/data/elements/2/resolved/status",
    );
  });

  it("describes unresolved, repeated, and empty finding references without inventing context", () => {
    const doc = exportDocWith({
      elements: [layerElement("el_a")],
      findings: [
        {
          rule: "r1",
          message: "m1",
          elementIds: ["el_a", "el_missing", "el_a"],
        },
        { rule: "r2", message: "m2", elementIds: [] },
      ],
    });
    const claims = byRule(
      analyze(parsePflExport(doc, "inline")),
      "export-finding-context",
    );
    expect(claims).toHaveLength(3);
    expect(claims[0].claim).toContain("It references element 'el_a'");
    const unresolved = claims[1];
    expect(unresolved.claim).toBe(
      "Finding 'r1' states: m1. It references element 'el_missing', which is not among the export's joined elements.",
    );
    expect(unresolved.evidence.map((e) => e.pointer)).toEqual([
      "/data/findings/0",
      "/data/findings/0/elementIds/1",
    ]);
    // The repeated 'el_a' emits no second claim.
    expect(claims[2].claim).toBe("Finding 'r2' states: m2.");
    expect(claims[2].evidence.map((e) => e.pointer)).toEqual([
      "/data/findings/1",
    ]);
  });

  it("rejects a relation/finding-heavy export that exceeds the evidence ceiling", () => {
    const ids = Array.from({ length: 5_000 }, (_, i) => `el_${i}`);
    const doc = exportDocWith({
      elements: ids.map(layerElement),
      relations: Array.from({ length: 20_000 }, (_, i) => ({
        type: "shadows",
        from: ids[i % ids.length],
        to: ids[(i + 1) % ids.length],
      })),
      findings: Array.from({ length: 5 }, (_, f) => ({
        rule: `r${f}`,
        message: "m",
        elementIds: ids.slice(f * 1_000, f * 1_000 + 1_000),
      })),
    });
    // 5,000 observed claims × 4 + 20,000 relations × 3 + 5,000 finding
    // references × 5 exceeds 100,000 evidence references while staying
    // under the claim ceiling: the deterministic input error must fire.
    expect(() => analyze(parsePflExport(doc, "inline"))).toThrow(
      /evidence references/,
    );
  });

  it("keeps claim order stable across the new rules", async () => {
    const result = analyze(await load("valid-export.json"));
    const ruleIds = result.claims.map((claim) => claim.ruleId);
    const first = (id: string) => ruleIds.indexOf(id);
    expect(first("element-observed-state")).toBeGreaterThanOrEqual(0);
    expect(first("element-observed-state")).toBeLessThan(
      first("element-resolved-state"),
    );
    expect(first("element-resolved-state")).toBeLessThan(
      first("element-interpretation"),
    );
    expect(first("element-interpretation")).toBeLessThan(
      first("export-relation-described"),
    );
    expect(first("export-relation-described")).toBeLessThan(
      first("export-finding-context"),
    );
  });

  it("rejects a document whose claims would exceed the evidence ceiling", () => {
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
    expect(() => analyze(parsePflExport(doc, "inline"))).toThrow(
      /evidence references|claim ceiling|invalid-shape/,
    );
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
