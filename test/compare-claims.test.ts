import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareDocuments } from "../src/application/compare.js";
import type { ComparisonResult } from "../src/domain/comparison.js";
import { parsePflExport } from "../src/input/pfl-export.js";
import type {
  PflDiffDocument,
  PflExportDocument,
  PflSnapshotElement,
} from "../src/input/pfl-export.js";

const compareDir = new URL("fixtures/compare/", import.meta.url);

interface Raw {
  raw: unknown;
  doc: PflExportDocument | PflDiffDocument;
}

function makeExport(
  data: unknown,
  extra: Record<string, unknown> = {},
): { raw: unknown; doc: PflExportDocument } {
  const raw = {
    pflVersion: "1.0.0",
    command: "export",
    ok: true,
    completeness: "complete",
    diagnostics: [],
    data,
    ...extra,
  };
  return { raw, doc: parsePflExport(raw, "test") as PflExportDocument };
}

function makeDiff(
  data: unknown,
  extra: Record<string, unknown> = {},
): { raw: unknown; doc: PflDiffDocument } {
  const raw = {
    pflVersion: "1.0.0",
    command: "diff",
    ok: true,
    completeness: "complete",
    diagnostics: [],
    data,
    ...extra,
  };
  return { raw, doc: parsePflExport(raw, "test") as PflDiffDocument };
}

function loadFixture(name: string): Raw {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL(name, compareDir)), "utf8"),
  );
  return { raw, doc: parsePflExport(raw, name) };
}

function element(
  id: string,
  overrides: {
    status?: string | null;
    activation?: string;
    facets?: readonly string[] | null;
  } = {},
): PflSnapshotElement {
  const {
    status = "effective",
    activation = "always",
    facets = ["instructions"],
  } = overrides;
  return {
    id,
    observed: {
      id,
      native: { kind: "markdown", origin: "project", scope: null },
      source: { path: `docs/${id}.md` },
      inspectability: "observable",
      metadata: {},
      status: "observed",
    },
    resolved:
      status === null
        ? null
        : {
            id,
            status,
            activation,
            resolution: { strategy: "override" },
          },
    interpretation:
      facets === null
        ? null
        : {
            elementId: id,
            facets: [...facets],
            confidence: "high",
            reason: "matched instruction pattern",
          },
  } as PflSnapshotElement;
}

function exportData(
  elements: readonly PflSnapshotElement[],
  extra: Record<string, unknown> = {},
  side: "a" | "b" = "a",
) {
  return {
    project: { id: "proj", displayName: "P" },
    runtime: {
      id: "claude-code",
      version: "2.0.0",
      adapter: {
        id: "a",
        version: "1.0.0",
        runtimeCompatibility: "verified",
      },
    },
    snapshot: {
      observedSnapshotId: `obs-${side}`,
      resolvedSnapshotId: `res-${side}`,
      capturedAt: "2026-01-01T00:00:00Z",
      schemaVersion: "1",
    },
    resolution: { semanticsVersion: "1.0.0", confidence: "verified" },
    elements,
    relations: [],
    findings: [],
    interpretation: {
      classifier: { id: "c", version: "1.0.0" },
      origin: "stored",
    },
    ...extra,
  };
}

function diffData(overrides: Record<string, unknown> = {}) {
  return {
    runtime: "claude-code",
    observedSnapshotIdA: "obs-a",
    observedSnapshotIdB: "obs-b",
    resolvedSnapshotIdA: "res-a",
    resolvedSnapshotIdB: "res-b",
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
      a: { classifierVersion: "1.0.0", origin: "stored" },
      b: { classifierVersion: "1.0.0", origin: "stored" },
    },
    ...overrides,
  };
}

/** Resolves an RFC 6901 pointer against a raw input document. */
function pointerExists(raw: unknown, pointer: string): boolean {
  if (pointer === "") return true;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = raw;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return false;
    if (Array.isArray(current)) {
      const i = Number(segment);
      if (!Number.isInteger(i) || i < 0 || i >= current.length) return false;
      current = current[i];
    } else {
      if (!(segment in current)) return false;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return true;
}

function expectEvidenceResolves(
  result: ComparisonResult,
  raws: Record<"before" | "after" | "diff", unknown>,
) {
  const order = { before: 0, after: 1, diff: 2 };
  for (const c of result.claims) {
    expect(c.evidence.length).toBeGreaterThan(0);
    for (const e of c.evidence)
      expect(
        pointerExists(raws[e.source], e.pointer),
        `${c.ruleId}: ${e.source}:${e.pointer} should resolve`,
      ).toBe(true);
    const sorted = [...c.evidence].sort(
      (a, b) =>
        order[a.source] - order[b.source] ||
        (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0),
    );
    expect(c.evidence, `${c.ruleId} evidence sorted`).toEqual(sorted);
  }
}

describe("compare claims (#35)", () => {
  it("emits evidence-backed claims for the matching triple", () => {
    const before = loadFixture("before.json") as {
      raw: unknown;
      doc: PflExportDocument;
    };
    const after = loadFixture("after.json") as {
      raw: unknown;
      doc: PflExportDocument;
    };
    const diff = loadFixture("diff.json") as {
      raw: unknown;
      doc: PflDiffDocument;
    };
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const rules = result.claims.map((c) => c.ruleId);
    expect(rules).toContain("compare-inputs");
    expect(rules).toContain("compare-element-added");
    expect(rules).toContain("compare-element-removed");
    expect(rules).toContain("compare-status-transition");
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it.each(["", "relation-only/", "drift-partial/"])(
    "resolves every claim evidence pointer inside the committed triple at %s",
    (subdir) => {
      const before = loadFixture(`${subdir}before.json`) as {
        raw: unknown;
        doc: PflExportDocument;
      };
      const after = loadFixture(`${subdir}after.json`) as {
        raw: unknown;
        doc: PflExportDocument;
      };
      const diff = loadFixture(`${subdir}diff.json`) as {
        raw: unknown;
        doc: PflDiffDocument;
      };
      const result = compareDocuments({
        before: before.doc,
        after: after.doc,
        diff: diff.doc,
      });
      expectEvidenceResolves(result, {
        before: before.raw,
        after: after.raw,
        diff: diff.raw,
      });
    },
  );

  it("describes an element newly effective through addition", () => {
    const before = makeExport(exportData([element("x")], {}, "a"));
    const after = makeExport(exportData([element("x"), element("y")], {}, "b"));
    const diff = makeDiff(
      diffData({
        structural: {
          added: 1,
          removed: 0,
          changed: 0,
          addedIds: ["y"],
          removedIds: [],
          changedIds: [],
        },
        effective: {
          newlyEffective: 1,
          noLongerEffective: 0,
          activationChanged: 0,
          statusChanges: [],
        },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const added = result.claims.find(
      (c) => c.ruleId === "compare-element-added",
    );
    expect(added).toBeDefined();
    expect(added!.claim).toContain("'y'");
    expect(added!.claim).toContain("added between A and B");
    expect(added!.claim).toContain("'effective'");
    const sources = added!.evidence.map((e) => `${e.source}:${e.pointer}`);
    expect(sources).toContain("diff:/data/structural/addedIds/0");
    expect(sources).toContain("after:/data/elements/1/resolved/status");
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("describes an effective → shadowed status transition", () => {
    const before = makeExport(exportData([element("x")], {}, "a"));
    const after = makeExport(
      exportData([element("x", { status: "shadowed" })], {}, "b"),
    );
    const diff = makeDiff(
      diffData({
        effective: {
          newlyEffective: 0,
          noLongerEffective: 1,
          activationChanged: 0,
          statusChanges: [{ id: "x", from: "effective", to: "shadowed" }],
        },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const transition = result.claims.find(
      (c) => c.ruleId === "compare-status-transition",
    );
    expect(transition).toBeDefined();
    expect(transition!.claim).toContain("'effective' in A");
    expect(transition!.claim).toContain("'shadowed' in B");
    const sources = transition!.evidence.map((e) => `${e.source}:${e.pointer}`);
    expect(sources).toContain("before:/data/elements/0/resolved/status");
    expect(sources).toContain("after:/data/elements/0/resolved/status");
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("emits no element-state claims for a relation-only change", () => {
    const shared = [element("x"), element("y")];
    const before = makeExport(exportData(shared, { relations: [] }, "a"));
    const after = makeExport(
      exportData(
        shared,
        { relations: [{ type: "shadows", from: "x", to: "y" }] },
        "b",
      ),
    );
    const diff = makeDiff(
      diffData({
        relations: {
          added: [{ type: "shadows", from: "x", to: "y" }],
          removed: [],
        },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const elementRules = result.claims.filter((c) =>
      [
        "compare-element-added",
        "compare-element-removed",
        "compare-element-changed",
        "compare-status-transition",
        "compare-activation-change",
        "compare-facet-change",
        "compare-contradiction",
      ].includes(c.ruleId),
    );
    expect(elementRules).toEqual([]);
  });

  it("preserves uncertainty on a partial-completeness side", () => {
    const before = makeExport(exportData([element("x")], {}, "a"));
    const after = makeExport(exportData([], {}, "b"), {
      completeness: "partial",
    });
    const diff = makeDiff(
      diffData({
        structural: {
          added: 0,
          removed: 1,
          changed: 0,
          addedIds: [],
          removedIds: ["x"],
          changedIds: [],
        },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const caveat = result.claims.find(
      (c) => c.ruleId === "compare-completeness" && c.claim.includes("after"),
    );
    expect(caveat).toBeDefined();
    const removed = result.claims.find(
      (c) => c.ruleId === "compare-element-removed",
    );
    expect(removed!.claim).toContain("absence may be unobserved");
    const removedEvidence = removed!.evidence.map(
      (e) => `${e.source}:${e.pointer}`,
    );
    expect(removedEvidence).toContain("after:/data/elements");
    expect(removedEvidence).toContain("after:/completeness");
    expect(
      result.claims.some((c) => c.ruleId === "compare-contradiction"),
    ).toBe(false);
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("surfaces version and semantics drift as caveat claims", () => {
    const before = makeExport(exportData([element("x")], {}, "a"));
    const after = makeExport(
      exportData(
        [element("x")],
        {
          resolution: { semanticsVersion: "2.0.0", confidence: "verified" },
          interpretation: {
            classifier: { id: "c", version: "2.0.0" },
            origin: "recomputed",
          },
        },
        "b",
      ),
      { pflVersion: "1.5.0" },
    );
    const diff = makeDiff(diffData({ versionNotes: ["classifier updated"] }), {
      pflVersion: "1.5.0",
    });
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const drifts = result.claims.filter(
      (c) => c.ruleId === "compare-version-drift",
    );
    expect(drifts.some((c) => c.claim.includes("different pfl versions"))).toBe(
      true,
    );
    expect(
      drifts.some((c) => c.claim.includes("resolution semantics versions")),
    ).toBe(true);
    expect(
      drifts.some((c) => c.claim.includes("different classifier versions")),
    ).toBe(true);
    expect(drifts.some((c) => c.claim.includes("classifier updated"))).toBe(
      true,
    );
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("surfaces document disagreements as contradiction claims", () => {
    const before = makeExport(
      exportData([element("x", { status: "effective" })], {}, "a"),
    );
    const after = makeExport(
      exportData([element("x", { status: "shadowed" })], {}, "b"),
    );
    const diff = makeDiff(
      diffData({
        effective: {
          newlyEffective: 0,
          noLongerEffective: 0,
          activationChanged: 0,
          statusChanges: [{ id: "x", from: "shadowed", to: "effective" }],
        },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const contradictions = result.claims.filter(
      (c) => c.ruleId === "compare-contradiction",
    );
    expect(contradictions.length).toBe(2);
    expect(contradictions[0].claim).toContain("disagree about element 'x'");
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("emits claims in deterministic rule order", () => {
    const run = () => {
      const before = makeExport(
        exportData([element("b"), element("a")], {}, "a"),
      );
      const after = makeExport(
        exportData(
          [element("a", { status: "shadowed" }), element("b")],
          {},
          "b",
        ),
      );
      const diff = makeDiff(
        diffData({
          effective: {
            newlyEffective: 0,
            noLongerEffective: 1,
            activationChanged: 0,
            statusChanges: [{ id: "a", from: "effective", to: "shadowed" }],
          },
        }),
      );
      return compareDocuments({
        before: before.doc,
        after: after.doc,
        diff: diff.doc,
      });
    };
    const first = run();
    const second = run();
    expect(first.claims).toEqual(second.claims);
    const transitions = first.claims.filter(
      (c) => c.ruleId === "compare-status-transition",
    );
    expect(transitions.length).toBe(1);
    expect(transitions[0].claim).toContain("'a'");
  });
});

describe("compare claims (#36)", () => {
  it("contextualizes an added relation with both endpoints", () => {
    const before = makeExport(
      exportData([element("x"), element("y")], {}, "a"),
    );
    const after = makeExport(
      exportData(
        [element("x", { status: "shadowed" }), element("y")],
        {
          relations: [{ type: "shadows", from: "x", to: "y" }],
        },
        "b",
      ),
    );
    const diff = makeDiff(
      diffData({
        effective: {
          newlyEffective: 0,
          noLongerEffective: 1,
          activationChanged: 0,
          statusChanges: [{ id: "x", from: "effective", to: "shadowed" }],
        },
        relations: {
          added: [{ type: "shadows", from: "x", to: "y" }],
          removed: [],
        },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const relation = result.claims.find(
      (c) => c.ruleId === "compare-relation-added",
    );
    expect(relation).toBeDefined();
    expect(relation!.claim).toContain("'x' shadows element 'y'");
    expect(relation!.claim).toContain("'x' resolves as 'shadowed' in B");
    expect(relation!.claim).toContain("not a cause");
    const sources = relation!.evidence.map((e) => `${e.source}:${e.pointer}`);
    expect(sources).toContain("diff:/data/relations/added/0/type");
    expect(sources).toContain("after:/data/elements/0/resolved/status");
    expect(sources).toContain("after:/data/elements/1/resolved/status");
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("preserves uncertainty for a relation endpoint missing on a partial side", () => {
    const before = makeExport(exportData([element("x")], {}, "a"));
    const after = makeExport(exportData([element("x")], {}, "b"), {
      completeness: "partial",
    });
    const diff = makeDiff(
      diffData({
        relations: {
          added: [{ type: "shadows", from: "x", to: "gone" }],
          removed: [],
        },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const relation = result.claims.find(
      (c) => c.ruleId === "compare-relation-added",
    );
    expect(relation).toBeDefined();
    expect(relation!.claim).toContain("a new relation");
    expect(relation!.claim).toContain("'gone'");
    expect(relation!.claim).toContain("absence may be unobserved");
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("contextualizes added and removed findings with their cited elements", () => {
    const findingA = {
      rule: "shadowed-instructions",
      message: "instruction shadowed",
      elementIds: ["x"],
    };
    const before = makeExport(
      exportData([element("x")], { findings: [findingA] }, "a"),
    );
    const after = makeExport(exportData([element("x")], {}, "b"));
    const diff = makeDiff(
      diffData({
        findings: { added: [], removed: [findingA] },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const removed = result.claims.find(
      (c) => c.ruleId === "compare-finding-removed",
    );
    expect(removed).toBeDefined();
    expect(removed!.claim).toContain("'shadowed-instructions'");
    expect(removed!.claim).toContain("'x' resolves as 'effective' in A");
    const sources = removed!.evidence.map((e) => `${e.source}:${e.pointer}`);
    expect(sources).toContain("diff:/data/findings/removed/0/rule");
    expect(sources).toContain("before:/data/elements/0/resolved/status");
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("reports a reworded finding as removal plus addition", () => {
    const before = makeExport(exportData([element("x")], {}, "a"));
    const after = makeExport(exportData([element("x")], {}, "b"));
    const diff = makeDiff(
      diffData({
        findings: {
          added: [
            {
              rule: "r1",
              message: "element x is shadowed now",
              elementIds: ["x"],
            },
          ],
          removed: [
            { rule: "r1", message: "element x shadowed", elementIds: ["x"] },
          ],
        },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const reworded = result.claims.filter(
      (c) => c.ruleId === "compare-finding-reworded",
    );
    expect(reworded.length).toBe(1);
    expect(reworded[0].claim).toContain("same rule and element ids");
    expect(reworded[0].claim).toContain(
      "not evidence that the underlying condition resolved",
    );
    const removed = result.claims.find(
      (c) => c.ruleId === "compare-finding-removed",
    );
    expect(removed!.claim).toContain(
      "the diff also adds a finding for the same rule and element ids",
    );
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("keeps relation/finding claims deterministic and after element claims", () => {
    const before = makeExport(exportData([element("x")], {}, "a"));
    const after = makeExport(exportData([element("x")], {}, "b"));
    const diff = makeDiff(
      diffData({
        relations: {
          added: [
            { type: "shadows", from: "x", to: "y" },
            { type: "overrides", from: "y", to: "x" },
          ],
          removed: [],
        },
      }),
    );
    const first = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const second = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    expect(first.claims).toEqual(second.claims);
    const rules = first.claims.map((c) => c.ruleId);
    const lastElementRule = Math.max(
      ...rules.map((r, i) =>
        [
          "compare-element-added",
          "compare-element-removed",
          "compare-element-changed",
          "compare-status-transition",
          "compare-activation-change",
          "compare-facet-change",
        ].includes(r)
          ? i
          : -1,
      ),
    );
    const firstRelationRule = rules.indexOf("compare-relation-added");
    expect(firstRelationRule).toBeGreaterThan(lastElementRule);
    expect(
      first.claims.filter((c) => c.ruleId === "compare-relation-added").length,
    ).toBe(2);
  });
});

describe("compare claims (#36) review findings", () => {
  it("hedges a finding's cited element missing on a partial side", () => {
    const finding = {
      rule: "r1",
      message: "x looks stale",
      elementIds: ["x", "gone"],
    };
    const before = makeExport(
      exportData([element("x"), element("gone")], { findings: [finding] }, "a"),
      { completeness: "partial" },
    );
    const after = makeExport(exportData([element("x")], {}, "b"));
    const diff = makeDiff(
      diffData({ findings: { added: [], removed: [finding] } }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const removed = result.claims.find(
      (c) => c.ruleId === "compare-finding-removed",
    );
    expect(removed).toBeDefined();
    expect(removed!.claim).toContain("'x' resolves as 'effective' in A");
    expect(removed!.claim).toContain("'gone'");
    const evidence = removed!.evidence.map((e) => `${e.source}:${e.pointer}`);
    expect(evidence).toContain("before:/data/elements/1/id");
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("phrases overrides and accumulates-with like the diff rules", () => {
    const before = makeExport(
      exportData([element("x"), element("y")], {}, "a"),
    );
    const after = makeExport(
      exportData(
        [element("x"), element("y")],
        {
          relations: [
            { type: "overrides", from: "x", to: "y" },
            { type: "accumulates-with", from: "y", to: "x" },
          ],
        },
        "b",
      ),
    );
    const diff = makeDiff(
      diffData({
        relations: {
          added: [
            { type: "overrides", from: "x", to: "y" },
            { type: "accumulates-with", from: "y", to: "x" },
          ],
          removed: [],
        },
      }),
    );
    const result = compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
    const claims = result.claims.filter(
      (c) => c.ruleId === "compare-relation-added",
    );
    expect(claims.length).toBe(2);
    expect(claims[0].claim).toContain("'x' overrides element 'y'");
    expect(claims[1].claim).toContain("'y' accumulates with element 'x'");
  });
});

describe("compare output ceilings", () => {
  it("rejects a triple whose claims would exceed the claim ceiling", () => {
    const ids = (prefix: string) =>
      Array.from({ length: 10000 }, (_, i) => `${prefix}-${i}`);
    const before = makeExport(exportData([], {}, "a"));
    const after = makeExport(exportData([], {}, "b"));
    const diff = makeDiff(
      diffData({
        structural: {
          added: 10000,
          removed: 10000,
          changed: 10000,
          addedIds: ids("add"),
          removedIds: ids("rem"),
          changedIds: ids("chg"),
        },
      }),
    );
    // 30k structural ids each emit an element claim plus contradiction
    // claims (absent from complete exports) — together exceeding 50k.
    try {
      compareDocuments({
        before: before.doc,
        after: after.doc,
        diff: diff.doc,
      });
      expect.unreachable("expected the comparison to be rejected");
    } catch (error) {
      expect(error).toMatchObject({
        name: "PflExportError",
        code: "invalid-shape",
      });
      expect((error as Error).message).toContain("claim ceiling");
    }
  });
});

describe("compare review fixes (devin-review PR #49)", () => {
  function compare(
    before: { doc: PflExportDocument },
    after: { doc: PflExportDocument },
    diff: { doc: PflDiffDocument },
  ) {
    return compareDocuments({
      before: before.doc,
      after: after.doc,
      diff: diff.doc,
    });
  }

  it("does not flag a complete export that lacks a null-side status change", () => {
    const before = makeExport(exportData([], {}, "a"));
    const after = makeExport(exportData([element("x")], {}, "b"));
    const diff = makeDiff(
      diffData({
        structural: {
          added: 1,
          removed: 0,
          changed: 0,
          addedIds: ["x"],
          removedIds: [],
          changedIds: [],
        },
        effective: {
          newlyEffective: 1,
          noLongerEffective: 0,
          activationChanged: 0,
          statusChanges: [{ id: "x", from: null, to: "effective" }],
        },
      }),
    );
    const result = compare(before, after, diff);
    expect(
      result.claims.filter((c) => c.ruleId === "compare-contradiction"),
    ).toHaveLength(0);
  });

  it("flags a non-null diff status against an export with no resolved entry", () => {
    const before = makeExport(
      exportData([element("x", { status: null })], {}, "a"),
    );
    const after = makeExport(
      exportData([element("x", { status: "shadowed" })], {}, "b"),
    );
    const diff = makeDiff(
      diffData({
        effective: {
          newlyEffective: 0,
          noLongerEffective: 1,
          activationChanged: 0,
          statusChanges: [{ id: "x", from: "effective", to: "shadowed" }],
        },
      }),
    );
    const result = compare(before, after, diff);
    const contradictions = result.claims.filter(
      (c) => c.ruleId === "compare-contradiction",
    );
    expect(
      contradictions.some((c) => c.claim.includes("has no resolved entry")),
    ).toBe(true);
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("cites the resolved null entry when an element has no resolved layer", () => {
    const before = makeExport(
      exportData([element("x", { status: null, facets: null })], {}, "a"),
    );
    const after = makeExport(exportData([], {}, "b"));
    const diff = makeDiff(
      diffData({
        structural: {
          added: 0,
          removed: 1,
          changed: 0,
          addedIds: [],
          removedIds: ["x"],
          changedIds: [],
        },
      }),
    );
    const result = compare(before, after, diff);
    const removed = result.claims.find(
      (c) => c.ruleId === "compare-element-removed",
    );
    expect(removed).toBeDefined();
    const pointers = removed!.evidence.map((e) => `${e.source}:${e.pointer}`);
    expect(pointers).toContain("before:/data/elements/0/resolved");
    expect(pointers).toContain("before:/data/elements/0/interpretation");
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("caveats classifier drift between an export and its diff side", () => {
    const before = makeExport(exportData([element("x")], {}, "a"));
    const after = makeExport(exportData([element("x")], {}, "b"));
    const diff = makeDiff(
      diffData({
        interpretation: {
          a: { classifierVersion: "2.0.0", origin: "recomputed" },
          b: { classifierVersion: "1.0.0", origin: "stored" },
        },
      }),
    );
    const result = compare(before, after, diff);
    const drift = result.claims.filter(
      (c) => c.ruleId === "compare-version-drift",
    );
    expect(
      drift.some(
        (c) =>
          c.claim.includes("'1.0.0'") &&
          c.claim.includes("'2.0.0'") &&
          c.claim.includes("side A"),
      ),
    ).toBe(true);
    expectEvidenceResolves(result, {
      before: before.raw,
      after: after.raw,
      diff: diff.raw,
    });
  });

  it("does not report runtime drift when a version is unknown", () => {
    const before = makeExport(exportData([element("x")], {}, "a"));
    const after = makeExport(
      exportData(
        [element("x")],
        {
          runtime: {
            id: "claude-code",
            version: null,
            adapter: {
              id: "a",
              version: "1.0.0",
              runtimeCompatibility: "verified",
            },
          },
        },
        "b",
      ),
    );
    const diff = makeDiff(diffData());
    const result = compare(before, after, diff);
    expect(
      result.claims.some((c) => c.claim.includes("runtime versions")),
    ).toBe(false);
  });

  it("orders relation and finding claims independently of diff array order", () => {
    const relations = [
      { type: "shadows", from: "z", to: "a" },
      { type: "shadows", from: "a", to: "z" },
    ];
    const findings = [
      { rule: "r2", message: "m2", elementIds: ["z"] },
      { rule: "r1", message: "m1", elementIds: ["a"] },
    ];
    const build = (
      addedRelations: typeof relations,
      addedFindings: typeof findings,
    ) =>
      makeDiff(
        diffData({
          relations: { added: addedRelations, removed: [] },
          findings: { added: addedFindings, removed: [] },
        }),
      );
    const before = makeExport(exportData([], {}, "a"));
    const after = makeExport(exportData([element("a"), element("z")], {}, "b"));
    const result1 = compare(before, after, build(relations, findings));
    const result2 = compare(
      before,
      after,
      build([...relations].reverse(), [...findings].reverse()),
    );
    expect(result1.claims.map((c) => c.claim)).toEqual(
      result2.claims.map((c) => c.claim),
    );
  });
});
