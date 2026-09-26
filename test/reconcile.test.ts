import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reconcileDocuments } from "../src/application/reconcile.js";
import { parsePflExport } from "../src/input/pfl-export.js";
import type {
  PflDiffDocument,
  PflExportDocument,
  PflSnapshotElement,
} from "../src/input/pfl-export.js";

const compareDir = new URL("fixtures/compare/", import.meta.url);

function parseExport(data: unknown): PflExportDocument {
  return parsePflExport(
    {
      pflVersion: "1.0.0",
      command: "export",
      ok: true,
      completeness: "complete",
      diagnostics: [],
      data,
    },
    "test",
  ) as PflExportDocument;
}

function parseDiff(data: unknown, completeness = "complete"): PflDiffDocument {
  return parsePflExport(
    {
      pflVersion: "1.0.0",
      command: "diff",
      ok: true,
      completeness,
      diagnostics: [],
      data,
    },
    "test",
  ) as PflDiffDocument;
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

function exportData(elements: readonly PflSnapshotElement[], extra = {}) {
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
      observedSnapshotId: "obs",
      resolvedSnapshotId: "res",
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

function diffData(overrides = {}) {
  return {
    runtime: "claude-code",
    observedSnapshotIdA: "obs",
    observedSnapshotIdB: "obs",
    resolvedSnapshotIdA: "res",
    resolvedSnapshotIdB: "res",
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

describe("reconcileDocuments", () => {
  it("joins the committed matching triple", () => {
    const read = (name: string) =>
      parsePflExport(
        JSON.parse(
          readFileSync(fileURLToPath(new URL(name, compareDir)), "utf8"),
        ),
        name,
      );
    const view = reconcileDocuments(
      read("before.json") as PflExportDocument,
      read("after.json") as PflExportDocument,
      read("diff.json") as PflDiffDocument,
    );
    const byId = new Map(view.elements.map((e) => [e.id, e]));
    expect([...byId.keys()].sort()).toEqual([
      "el-added",
      "el-kept",
      "el-removed",
    ]);
    expect(byId.get("el-added")).toMatchObject({
      structural: "added",
      beforeIndex: null,
      afterIndex: 0,
    });
    expect(byId.get("el-removed")).toMatchObject({
      structural: "removed",
      beforeIndex: 1,
      afterIndex: null,
    });
    expect(byId.get("el-kept")).toMatchObject({
      structural: "none",
      statusChange: { from: "effective", to: "shadowed" },
      beforeIndex: 0,
      afterIndex: 1,
    });
    for (const e of view.elements) expect(e.contradictions).toEqual([]);
  });

  it("emits elements in deterministic id order regardless of diff order", () => {
    const before = parseExport(exportData([element("a"), element("b")]));
    const after = parseExport(exportData([element("a"), element("b")]));
    const diff = parseDiff(
      diffData({
        structural: {
          added: 0,
          removed: 0,
          changed: 2,
          addedIds: [],
          removedIds: [],
          changedIds: ["b", "a"],
        },
      }),
    );
    const view = reconcileDocuments(before, after, diff);
    expect(view.elements.map((e) => e.id)).toEqual(["a", "b"]);
    expect(view.elements.every((e) => e.structural === "changed")).toBe(true);
  });

  it("keeps status-only changes separate from structural buckets", () => {
    const before = parseExport(
      exportData([element("x", { status: "effective" })]),
    );
    const after = parseExport(
      exportData([element("x", { status: "shadowed" })]),
    );
    const diff = parseDiff(
      diffData({
        effective: {
          newlyEffective: 0,
          noLongerEffective: 0,
          activationChanged: 0,
          statusChanges: [{ id: "x", from: "effective", to: "shadowed" }],
        },
      }),
    );
    const [record] = reconcileDocuments(before, after, diff).elements;
    expect(record.structural).toBe("none");
    expect(record.statusChange).toEqual({ from: "effective", to: "shadowed" });
    expect(record.contradictions).toEqual([]);
  });

  it("derives activation changes from the exports, not the aggregate count", () => {
    const before = parseExport(
      exportData([element("x", { activation: "always" })]),
    );
    const after = parseExport(
      exportData([element("x", { activation: "on-demand" })]),
    );
    const diff = parseDiff(
      diffData({
        structural: {
          added: 0,
          removed: 0,
          changed: 1,
          addedIds: [],
          removedIds: [],
          changedIds: ["x"],
        },
        effective: {
          newlyEffective: 0,
          noLongerEffective: 0,
          activationChanged: 1,
          statusChanges: [],
        },
      }),
    );
    const [record] = reconcileDocuments(before, after, diff).elements;
    expect(record.activationChange).toEqual({
      from: "always",
      to: "on-demand",
    });
    expect(record.statusChange).toBeNull();
  });

  it("derives facet changes from the exports' interpretations", () => {
    const before = parseExport(
      exportData([element("x", { facets: ["a", "b"] })]),
    );
    const after = parseExport(
      exportData([element("x", { facets: ["b", "c"] })]),
    );
    const diff = parseDiff(
      diffData({
        structural: {
          added: 0,
          removed: 0,
          changed: 1,
          addedIds: [],
          removedIds: [],
          changedIds: ["x"],
        },
        facetDeltas: { a: -1, c: 1 },
      }),
    );
    const [record] = reconcileDocuments(before, after, diff).elements;
    expect(record.facetChange).toEqual({ added: ["c"], removed: ["a"] });
  });

  it("records contradictions between the diff and complete exports", () => {
    const before = parseExport(
      exportData([element("ghost"), element("x", { status: "effective" })]),
    );
    const after = parseExport(
      exportData([element("stayer"), element("x", { status: "shadowed" })]),
    );
    const diff = parseDiff(
      diffData({
        structural: {
          added: 1,
          removed: 1,
          changed: 1,
          addedIds: ["ghost"],
          removedIds: ["stayer"],
          changedIds: ["missing"],
        },
        effective: {
          newlyEffective: 0,
          noLongerEffective: 0,
          activationChanged: 0,
          statusChanges: [{ id: "x", from: "shadowed", to: "effective" }],
        },
      }),
    );
    const view = reconcileDocuments(before, after, diff);
    const byId = new Map(view.elements.map((e) => [e.id, e]));
    expect(byId.get("ghost")!.contradictions[0]).toContain(
      "present in the before",
    );
    expect(byId.get("stayer")!.contradictions[0]).toContain(
      "present in the after",
    );
    expect(byId.get("missing")!.contradictions).toEqual([
      "listed as changed by the diff but absent from the complete before export",
      "listed as changed by the diff but absent from the complete after export",
    ]);
    expect(byId.get("x")!.contradictions).toEqual([
      "diff records status from 'shadowed' but the before export resolves 'effective'",
      "diff records status to 'effective' but the after export resolves 'shadowed'",
    ]);
  });

  it("treats missing ids on partial-completeness sides as unobserved, not contradictions", () => {
    const before = parseExport(exportData([element("x")]));
    const partialAfter = parsePflExport(
      {
        pflVersion: "1.0.0",
        command: "export",
        ok: true,
        completeness: "partial",
        diagnostics: [],
        data: exportData([]),
      },
      "test",
    ) as PflExportDocument;
    const diff = parseDiff(
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
    const [record] = reconcileDocuments(before, partialAfter, diff).elements;
    expect(record.afterIndex).toBeNull();
    expect(record.contradictions).toEqual([]);
  });

  it("does not attribute aggregate counts to individual elements", () => {
    const before = parseExport(exportData([element("x")]));
    const after = parseExport(exportData([element("x")]));
    const diff = parseDiff(
      diffData({
        effective: {
          newlyEffective: 5,
          noLongerEffective: 3,
          activationChanged: 2,
          statusChanges: [],
        },
        facetDeltas: { memory: 4 },
        structural: {
          added: 0,
          removed: 0,
          changed: 1,
          addedIds: [],
          removedIds: [],
          changedIds: ["x"],
        },
      }),
    );
    const [record] = reconcileDocuments(before, after, diff).elements;
    expect(record.statusChange).toBeNull();
    expect(record.activationChange).toBeNull();
    expect(record.facetChange).toBeNull();
    expect(record.contradictions).toEqual([]);
  });

  it("handles opaque and null-layer elements without inventing data", () => {
    const opaque = element("x") as PflSnapshotElement & {
      observed: Record<string, unknown>;
    };
    const beforeEl = {
      ...opaque,
      observed: { ...opaque.observed, inspectability: "opaque" },
      resolved: null,
      interpretation: null,
    };
    const before = parseExport(exportData([beforeEl as PflSnapshotElement]));
    const after = parseExport(exportData([]));
    const diff = parseDiff(
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
    const [record] = reconcileDocuments(before, after, diff).elements;
    expect(record.facetChange).toBeNull();
    expect(record.activationChange).toBeNull();
    expect(record.contradictions).toEqual([]);
  });
});

describe("reconcileDocuments review findings", () => {
  it("flags a changed id absent from a complete side even when the other side is partial", () => {
    const partialBefore = parsePflExport(
      {
        pflVersion: "1.0.0",
        command: "export",
        ok: true,
        completeness: "partial",
        diagnostics: [],
        data: exportData([]),
      },
      "test",
    ) as PflExportDocument;
    const after = parseExport(exportData([]));
    const diff = parseDiff(
      diffData({
        structural: {
          added: 0,
          removed: 0,
          changed: 1,
          addedIds: [],
          removedIds: [],
          changedIds: ["x"],
        },
      }),
    );
    const [record] = reconcileDocuments(partialBefore, after, diff).elements;
    expect(record.contradictions).toEqual([
      "listed as changed by the diff but absent from the complete after export",
    ]);
  });

  it("flags a null-side status change contradicted by an export's resolved status", () => {
    const before = parseExport(exportData([element("x")]));
    const after = parseExport(exportData([element("x")]));
    const diff = parseDiff(
      diffData({
        effective: {
          newlyEffective: 0,
          noLongerEffective: 1,
          activationChanged: 0,
          statusChanges: [{ id: "x", from: "effective", to: null }],
        },
      }),
    );
    const [record] = reconcileDocuments(before, after, diff).elements;
    expect(record.contradictions).toEqual([
      "diff records no after status but the after export resolves 'effective'",
    ]);
  });
});
