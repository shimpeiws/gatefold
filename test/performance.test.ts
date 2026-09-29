import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffCellExports } from "../src/application/cell-diff.js";
import { reportCells } from "../src/application/report-cells.js";
import type { PflExportDocument } from "../src/input/pfl-export.js";
import { readCellRun } from "../src/input/yuurei-cell.js";

// Worst-case inputs the schema caps still allow, asserting the hot paths
// stay near-linear (#97). The bounds are generous: the pre-fix code needs
// orders of magnitude longer on the same inputs.

const root = fileURLToPath(new URL("../", import.meta.url));
const cellFixture = (name: string): string =>
  `${root}test/fixtures/yuurei-cell/${name}`;

const sha256 = (content: string | Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gatefold-perf-"));
}

function minimalExport(elements: PflExportDocument["data"]["elements"]) {
  return {
    pflVersion: "1.0.0",
    command: "export",
    ok: true,
    completeness: "complete",
    diagnostics: [],
    data: {
      project: { id: "git-0f214d60555919a5", displayName: "example" },
      runtime: { id: "claude-code", name: "Claude Code", version: "1.0.0" },
      snapshot: { id: "snap-1", capturedAt: "2026-01-01T00:00:00Z" },
      resolution: { confidence: "verified", semanticsVersion: "2" },
      elements,
      relations: [],
      findings: [],
      interpretation: {
        classifier: { id: "pfl-native", version: "5" },
        origin: "stored",
      },
    },
  } as unknown as PflExportDocument;
}

describe("performance ceilings", () => {
  it("diffCellExports counts many distinct facets in one pass", () => {
    // 2,000 distinct facets × 2,000 elements × up to 200 facets per
    // element: the pre-fix facetCount rescanned every element per facet.
    const elementCount = 2_000;
    const facetCount = 2_000;
    const facetsPerElement = 200;
    const elements = Array.from({ length: elementCount }, (_, i) => ({
      id: `el_${i}`,
      observed: {
        id: `el_${i}`,
        inspectability: "observable",
        metadata: {},
        native: { kind: "instructions", origin: "project", scope: "project" },
        source: { digest: `sha256:${"0".repeat(64)}` },
        status: "observed",
      },
      resolved: null,
      interpretation: {
        confidence: "high",
        elementId: `el_${i}`,
        facets: Array.from(
          { length: facetsPerElement },
          (_, k) => `facet_${(i * 7 + k) % facetCount}`,
        ),
        reason: "r",
      },
    }));
    const before = minimalExport(elements);
    const after = minimalExport([...elements].reverse());

    const start = performance.now();
    const diff = diffCellExports(before, after);
    const elapsed = performance.now() - start;

    // Reordered identical inputs produce no deltas.
    expect(Object.keys(diff.facetDeltas)).toHaveLength(0);
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it("reportCells indexes findings and relations once per run", async () => {
    // 32 runs (the CELLS_MAX_RUNS cap) each carrying 1,300 findings:
    // the pre-fix evidence loop rescanned every run's findings per
    // bucket, re-canonicalizing each record. The count stays under the
    // emitted-entry ceiling once per-run finding entries are added.
    const findingCount = 1_300;
    const relationCount = 50;
    const base = tmp();
    const dirs: string[] = [];
    try {
      const src = cellFixture("cell-real-run-a");
      for (let i = 0; i < 32; i++) {
        const dir = join(base, `run-${i}`);
        cpSync(src, dir, { recursive: true });
        const exportPath = join(dir, "observation", "export.json");
        const doc = JSON.parse(readFileSync(exportPath, "utf8"));
        // Two elements suffice: relations only need endpoints that
        // exist, and every per-element entry amplifies the emitted
        // entry count toward MAX_EMITTED_CLAIMS.
        const proto = doc.data.elements[0];
        doc.data.elements = Array.from({ length: 2 }, (_, k) => ({
          ...proto,
          id: `el_${k}`,
          observed: { ...proto.observed, id: `el_${k}` },
          resolved:
            proto.resolved === null
              ? null
              : { ...proto.resolved, id: `el_${k}` },
          interpretation:
            proto.interpretation === null
              ? null
              : { ...proto.interpretation, elementId: `el_${k}` },
        }));
        // Relations must reference existing element ids; keep the set
        // small — the findings lane carries the quadratic evidence loop.
        const REL_TYPES = [
          "shadows",
          "overrides",
          "accumulates-with",
          "contains",
          "discovered-from",
          "resolves-to",
          "applies-to",
        ];
        doc.data.relations = Array.from({ length: relationCount }, (_, k) => ({
          type: REL_TYPES[k % REL_TYPES.length],
          from: `el_${k % 2}`,
          to: `el_${(k + 1) % 2}`,
        }));
        doc.data.findings = Array.from({ length: findingCount }, (_, k) => ({
          rule: "perf-rule",
          message: `finding ${k}`,
          elementIds: ["el_0"],
        }));
        const bytes = JSON.stringify(doc);
        writeFileSync(exportPath, bytes);
        const manifestPath = join(dir, "artifacts.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        for (const entry of manifest.artifacts)
          if (entry.path === "observation/export.json")
            entry.digest = sha256(bytes);
        writeFileSync(manifestPath, JSON.stringify(manifest));
        dirs.push(dir);
      }
      const cells = await Promise.all(dirs.map(readCellRun));

      const start = performance.now();
      const result = reportCells({ cells });
      const elapsed = performance.now() - start;

      expect(result.schemaVersion).toBe(10);
      const findings = result.entries.filter((e) =>
        e.id.startsWith("set.finding."),
      );
      expect(findings.length).toBe(findingCount);
      // Every finding is recorded in all 32 eligible exports and cites
      // each run's own findings index.
      for (const entry of findings.slice(0, 5))
        expect(entry.evidence.length).toBe(32);
      expect(elapsed).toBeLessThan(30_000);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 90_000);
});
