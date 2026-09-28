import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { reportCell } from "../src/application/cell-report.js";
import { compareCells } from "../src/application/compare-cells.js";
import type { CellEntry, CellReportResult } from "../src/domain/cell.js";
import { PflExportError } from "../src/input/pfl-export.js";
import { readCellEvaluation } from "../src/input/cell-evaluation.js";
import { readCellRun } from "../src/input/yuurei-cell.js";
import { formatCellHuman } from "../src/output/human.js";
import { formatJson } from "../src/output/json.js";

// These fixtures are contract-shaped records authored for the test suite —
// they model the fields yuurei's shipped observation record and pfl v1.2.0's
// export document define; they are not bytes produced by either tool.

const sha256 = (content: string | Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gatefold-cell-"));
}

const v9Schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/claim-result.v9.json", import.meta.url)),
    "utf8",
  ),
);
const validateCell = new Ajv2020({ strict: true }).compile(v9Schema);

const BASELINE_DIGEST = "sha256:base-1";
const seededPatch =
  "--- /dev/null\n+++ src/new.ts\n@@ -0,0 +1,1 @@\n+export const X = 1;\n";
const RESULT_TEXT = '{"status": "fixed"}\n';

function element(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    observed: {
      id,
      native: { kind: "instructions", origin: "project", scope: "project" },
      source: { path: `${id}.md`, digest: sha256(`src:${id}`), sizeBytes: 12 },
      inspectability: "observable",
      metadata: {},
      status: "observed",
      ...(overrides.observed as Record<string, unknown> | undefined),
    },
    resolved:
      overrides.resolved === undefined
        ? {
            id,
            status: "effective",
            activation: "always",
            applicability: { type: "project" },
            resolution: { strategy: "accumulate", reason: "in scope" },
          }
        : overrides.resolved,
    interpretation:
      overrides.interpretation === undefined
        ? {
            elementId: id,
            facets: ["instructions"],
            confidence: "high",
            reason: "defines behavior",
          }
        : overrides.interpretation,
  };
}

/**
 * A contract-shaped pfl v1.2.0 `export` document. `cellId` records the
 * caller-asserted association the observer passed with `--cell-id`.
 */
function exportDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pflVersion: "1.2.0",
    command: "export",
    ok: true,
    completeness: "complete",
    diagnostics: [],
    ...overrides,
    data: {
      project: { id: "path-0123456789abcdef", displayName: "owner/repo" },
      runtime: {
        id: "claude-code",
        version: "2.1.272",
        adapter: {
          id: "claude-code",
          version: "0.1.1",
          runtimeCompatibility: "verified",
        },
      },
      snapshot: {
        observedSnapshotId: "obs_0123456789ab",
        resolvedSnapshotId: "res_0123456789ab",
        capturedAt: "2026-09-20T09:59:00.000Z",
        schemaVersion: "2",
        cellId: "cell_20260920-a1",
      },
      resolution: { semanticsVersion: "2", confidence: "verified" },
      elements: [element("el_aaa"), element("el_bbb")],
      relations: [],
      findings: [],
      interpretation: {
        classifier: { id: "pfl-native", version: "5" },
        origin: "stored",
      },
      ...(overrides.data as Record<string, unknown> | undefined),
    },
  };
}

function observationRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    observer: { id: "pfl", version: "1.2.0" },
    status: "recorded",
    reason: null,
    completeness: null,
    snapshot_ids: {
      observed: "obs_0123456789ab",
      resolved: "res_0123456789ab",
    },
    artifacts: [{ path: "observation/export.json", kind: "export" }],
    ...overrides,
  };
}

function cellTrace(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "0.3",
    run_id: "run-cell-1",
    started_at: "t0",
    finished_at: "t1",
    runtime: { id: "claude-code", version: "2.1.272" },
    model: { requested: "m", resolved: "m-1", resolved_reason: "observed" },
    profile: { name: "p", digest: "sha256:p" },
    task: { source: "t", digest: "sha256:task-x" },
    requested_cell: { digest: "sha256:req-cell", inputs_version: 2 },
    cell_id: "cell_20260920-a1",
    observation: observationRecord(),
    seed: {
      policy: "git-tracked-files",
      source: "/seed/x",
      head: "0123456789abcdef0123456789abcdef01234567",
      baseline: {
        requested_digest: BASELINE_DIGEST,
        materialized_digest: BASELINE_DIGEST,
        files: 1,
        bytes: 5,
      },
      changes: { added: 1, modified: 0, deleted: 0 },
    },
    patch: { base: "seeded", state: "complete" },
    isolation: { strategy: "cell", verified: true },
    execution: {
      exit_code: 0,
      signal: null,
      duration_ms: 10,
      timed_out: false,
    },
    usage: { input_tokens: 100, output_tokens: 10 },
    cost: { amount: 0.01, currency: "USD" },
    artifacts: [],
    ...overrides,
  };
}

interface CellRunOptions {
  trace?: Record<string, unknown>;
  /** The export artifact bytes; null omits the file (manifest still lists it). */
  exportBytes?: string | null;
  /** Whether the manifest lists the export artifact. */
  exportListed?: boolean;
  exportTruncated?: boolean;
  patch?: string | null;
  result?: string | null;
}

function writeCellRun(
  base: string,
  name: string,
  opts: CellRunOptions = {},
): string {
  const runDir = join(base, name);
  mkdirSync(join(runDir, "observation"), { recursive: true });
  writeFileSync(
    join(runDir, "trace.json"),
    JSON.stringify(opts.trace ?? cellTrace()),
  );
  const artifacts: Record<string, unknown>[] = [];
  const patch = opts.patch === undefined ? seededPatch : opts.patch;
  if (patch !== null) {
    writeFileSync(join(runDir, "patch.diff"), patch);
    artifacts.push({
      path: "patch.diff",
      kind: "patch",
      digest: sha256(patch),
    });
  }
  const result = opts.result === undefined ? RESULT_TEXT : opts.result;
  if (result !== null) {
    writeFileSync(join(runDir, "result.txt"), result);
    artifacts.push({
      path: "result.txt",
      kind: "result",
      digest: sha256(result),
    });
  }
  const baselineManifest = JSON.stringify({
    version: 1,
    policy: "git-tracked-files",
    source: "/seed/x",
    head: "0123456789abcdef0123456789abcdef01234567",
    requested_digest: BASELINE_DIGEST,
    materialized_digest: BASELINE_DIGEST,
    files: { "a.txt": { digest: sha256("a"), mode: 420, bytes: 1 } },
  });
  writeFileSync(join(runDir, "baseline-manifest.json"), baselineManifest);
  artifacts.push({
    path: "baseline-manifest.json",
    kind: "file",
    digest: sha256(baselineManifest),
  });
  const changes = JSON.stringify({
    version: 1,
    baseline_digest: BASELINE_DIGEST,
    added: ["src/new.ts"],
    modified: [],
    deleted: [],
  });
  writeFileSync(join(runDir, "changes.json"), changes);
  artifacts.push({
    path: "changes.json",
    kind: "file",
    digest: sha256(changes),
  });
  const exportBytes =
    opts.exportBytes === undefined
      ? JSON.stringify(exportDoc())
      : opts.exportBytes;
  if (exportBytes !== null) {
    writeFileSync(join(runDir, "observation", "export.json"), exportBytes);
  }
  if (opts.exportListed !== false) {
    artifacts.push({
      path: "observation/export.json",
      kind: "export",
      digest: sha256(exportBytes ?? ""),
      ...(opts.exportTruncated ? { truncated: true } : {}),
    });
  }
  writeFileSync(join(runDir, "artifacts.json"), JSON.stringify({ artifacts }));
  return runDir;
}

async function report(
  runDir: string,
  evaluationPath?: string,
): Promise<CellReportResult> {
  return reportCell({
    cell: await readCellRun(runDir),
    evaluation:
      evaluationPath === undefined
        ? undefined
        : await readCellEvaluation(evaluationPath),
    label: runDir,
  });
}

async function compare(
  before: string,
  after: string,
  evaluationPath?: string,
): Promise<CellReportResult> {
  return compareCells({
    before: await readCellRun(before),
    after: await readCellRun(after),
    evaluation:
      evaluationPath === undefined
        ? undefined
        : await readCellEvaluation(evaluationPath),
    labels: { before, after },
  });
}

function entryAt(
  result: CellReportResult,
  id: string,
  subject?: "before" | "after",
): CellEntry {
  const entry = result.entries.find(
    (e) => e.id === id && (subject === undefined || e.subject === subject),
  );
  if (entry === undefined)
    throw new Error(`entry ${id}${subject ? ` [${subject}]` : ""} not emitted`);
  return entry;
}

function entriesWith(result: CellReportResult, prefix: string): CellEntry[] {
  return result.entries.filter((e) => e.id.startsWith(prefix));
}

function expectSchemaValid(result: CellReportResult): void {
  if (!validateCell(result))
    throw new Error(
      `result failed v9 schema validation: ${JSON.stringify(validateCell.errors)}`,
    );
}

describe("report-cell", () => {
  it("reports a fully recorded, digest-verified cell: every lane schema-valid", async () => {
    const base = tmp();
    try {
      const result = await report(writeCellRun(base, "run"));
      expect(result.schemaVersion).toBe(9);
      expect(result.source.command).toBe("report-cell");
      expect(result.inputs.run?.cellId).toBe("cell_20260920-a1");
      expect(result.inputs.run?.observationStatus).toBe("recorded");
      expectSchemaValid(result);
      for (const entry of result.entries)
        expect(entry.evidence.length, entry.id).toBeGreaterThan(0);

      expect(entryAt(result, "association.cell-id")).toMatchObject({
        state: "recorded",
        completeness: "complete",
      });
      expect(entryAt(result, "association.observation").state).toBe("recorded");
      expect(entryAt(result, "association.export-retained")).toMatchObject({
        state: "verified",
        completeness: "complete",
      });
      expect(entryAt(result, "association.export-document").state).toBe(
        "verified",
      );
      // trace cell_id and export snapshot.cellId agree.
      expect(entryAt(result, "association.export-binding").state).toBe(
        "verified",
      );
      expect(
        entriesWith(result, "configuration.element.").length,
      ).toBeGreaterThanOrEqual(2);
      expect(entryAt(result, "execution.run-id").state).toBe("recorded");
      expect(entryAt(result, "execution.usage").state).toBe("recorded");
      // The audit lane mirrors the v0.8 facts.
      expect(result.entries.some((e) => e.lane === "audit")).toBe(true);
      // Every export citation carries the verified digest.
      const exportEv = result.entries
        .flatMap((e) => e.evidence)
        .filter((ev) => ev.source === "export");
      expect(exportEv.length).toBeGreaterThan(0);
      expect(
        exportEv.every(
          (ev) => ev.digest === sha256(JSON.stringify(exportDoc())),
        ),
      ).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a run with no observation record as unknown, never as absent configuration", async () => {
    const base = tmp();
    try {
      const trace = cellTrace();
      delete trace.observation;
      delete trace.cell_id;
      const result = await report(
        writeCellRun(base, "run", {
          trace,
          exportBytes: null,
          exportListed: false,
        }),
      );
      expectSchemaValid(result);
      expect(result.inputs.run?.cellId).toBeNull();
      expect(result.inputs.run?.observationStatus).toBeNull();
      expect(entryAt(result, "association.cell-id").state).toBe("not-recorded");
      expect(entryAt(result, "association.observation")).toMatchObject({
        state: "not-recorded",
        completeness: "unknown",
      });
      expect(entryAt(result, "configuration.availability")).toMatchObject({
        completeness: "unknown",
      });
      expect(entryAt(result, "configuration.availability").statement).toContain(
        "unknown",
      );
      expect(entriesWith(result, "configuration.element.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports an observer failure as an unavailable export, not as no configuration change", async () => {
    const base = tmp();
    try {
      const trace = cellTrace({
        observation: observationRecord({
          status: "unavailable",
          reason: "export-failed",
          snapshot_ids: null,
          artifacts: [],
        }),
      });
      const result = await report(
        writeCellRun(base, "run", {
          trace,
          exportBytes: null,
          exportListed: false,
        }),
      );
      expectSchemaValid(result);
      expect(entryAt(result, "association.observation").statement).toContain(
        "export-failed",
      );
      const availability = entryAt(result, "configuration.availability");
      expect(availability.state).not.toBe("verified");
      expect(availability.completeness).toBe("unknown");
      expect(availability.statement).not.toContain("no configuration change");
      expect(entriesWith(result, "configuration.element.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks a declared-but-unlisted export as unverifiable", async () => {
    const base = tmp();
    try {
      const result = await report(
        writeCellRun(base, "run", {
          exportBytes: null,
          exportListed: false,
        }),
      );
      expectSchemaValid(result);
      expect(entryAt(result, "association.export-retained")).toMatchObject({
        state: "unverifiable",
        completeness: "unknown",
      });
      expect(entriesWith(result, "configuration.element.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a digest mismatch on the export artifact as inconsistent", async () => {
    const base = tmp();
    try {
      // Manifest lists the export but the stored bytes differ.
      const runDir = writeCellRun(base, "run", {
        exportBytes: JSON.stringify(exportDoc()),
      });
      const manifestPath = join(runDir, "artifacts.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const entry of manifest.artifacts)
        if (entry.path === "observation/export.json")
          entry.digest = sha256("tampered");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = await report(runDir);
      expectSchemaValid(result);
      expect(entryAt(result, "association.export-retained").state).toBe(
        "inconsistent",
      );
      expect(entriesWith(result, "configuration.element.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports verified-but-truncated export bytes as partial and parses none", async () => {
    const base = tmp();
    try {
      const result = await report(
        writeCellRun(base, "run", { exportTruncated: true }),
      );
      expectSchemaValid(result);
      expect(entryAt(result, "association.export-retained")).toMatchObject({
        state: "verified",
        completeness: "partial",
      });
      expect(entriesWith(result, "configuration.element.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports malformed export bytes without crashing", async () => {
    const base = tmp();
    try {
      const result = await report(
        writeCellRun(base, "run", { exportBytes: "{ not json" }),
      );
      expectSchemaValid(result);
      expect(entryAt(result, "association.export-document")).toMatchObject({
        completeness: "unknown",
      });
      expect(entriesWith(result, "configuration.element.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a trace/export cell_id mismatch as inconsistent", async () => {
    const base = tmp();
    try {
      const doc = exportDoc();
      (doc.data as Record<string, unknown>).snapshot = {
        ...((doc.data as Record<string, unknown>).snapshot as Record<
          string,
          unknown
        >),
        cellId: "cell_other",
      };
      const result = await report(
        writeCellRun(base, "run", { exportBytes: JSON.stringify(doc) }),
      );
      expectSchemaValid(result);
      expect(entryAt(result, "association.export-binding").state).toBe(
        "inconsistent",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps a supplied v6 evaluation labeled and separate", async () => {
    const base = tmp();
    try {
      const runDir = writeCellRun(base, "run");
      const evalPath = join(base, "evaluation.json");
      writeFileSync(
        evalPath,
        JSON.stringify({
          schemaVersion: 6,
          source: { command: "evaluate-run" },
          inputs: {
            run: { label: runDir },
            spec: { label: "spec" },
            checkReports: [],
          },
          evaluations: [],
        }),
      );
      const result = await report(runDir, evalPath);
      expectSchemaValid(result);
      const supplied = entryAt(result, "evaluation.supplied");
      expect(supplied.lane).toBe("evaluation");
      expect(
        result.entries
          .filter((e) => e.lane === "evaluation")
          .every((e) =>
            e.evidence.every(
              (ev) =>
                ev.source === "evaluation" ||
                ev.source === "trace" ||
                ev.source === "manifest",
            ),
          ),
      ).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("formats human output without verdict vocabulary", async () => {
    const base = tmp();
    try {
      const result = await report(writeCellRun(base, "run"));
      const human = formatCellHuman(result);
      expect(human).toContain("Cell report of");
      expect(human).toContain("association.cell-id");
      expect(human).toContain("evidence:");
      expect(human).not.toMatch(/\bverdict\b|\bscore\b/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("compare-cells", () => {
  it("reports the directional A → B configuration difference for a compatible pair", async () => {
    const base = tmp();
    try {
      // B adds el_ccc, changes el_bbb's digest, drops el_aaa.
      const docB = exportDoc({
        data: {
          elements: [
            element("el_bbb", {
              observed: {
                id: "el_bbb",
                native: {
                  kind: "instructions",
                  origin: "project",
                  scope: "project",
                },
                source: {
                  path: "el_bbb.md",
                  digest: sha256("changed"),
                  sizeBytes: 12,
                },
                inspectability: "observable",
                metadata: {},
                status: "observed",
              },
            }),
            element("el_ccc"),
          ],
        },
      });
      (docB.data as Record<string, unknown>).snapshot = {
        ...((docB.data as Record<string, unknown>).snapshot as Record<
          string,
          unknown
        >),
        observedSnapshotId: "obs_b",
        resolvedSnapshotId: "res_b",
        cellId: "cell_20260920-b2",
      };
      const before = writeCellRun(base, "a");
      const after = writeCellRun(base, "b", {
        trace: cellTrace({
          run_id: "run-cell-2",
          cell_id: "cell_20260920-b2",
          observation: observationRecord({
            snapshot_ids: { observed: "obs_b", resolved: "res_b" },
          }),
        }),
        exportBytes: JSON.stringify(docB),
      });
      const result = await compare(before, after);
      expect(result.schemaVersion).toBe(9);
      expect(result.source.command).toBe("compare-cells");
      expectSchemaValid(result);

      expect(entryAt(result, "comparison.comparability").state).not.toBe(
        "inconsistent",
      );
      const added = entriesWith(result, "comparison.element-added.");
      const removed = entriesWith(result, "comparison.element-removed.");
      const changed = entriesWith(result, "comparison.element-changed.");
      expect(added.map((e) => e.id)).toEqual([
        "comparison.element-added.el_ccc",
      ]);
      expect(removed.map((e) => e.id)).toEqual([
        "comparison.element-removed.el_aaa",
      ]);
      expect(changed.map((e) => e.id)).toEqual([
        "comparison.element-changed.el_bbb",
      ]);
      // A/B evidence carries the side labels.
      for (const e of [...added, ...removed, ...changed])
        for (const ev of e.evidence)
          expect(
            ev.source.startsWith("before") || ev.source.startsWith("after"),
          ).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects runs of different tasks with mismatched-inputs", async () => {
    const base = tmp();
    try {
      const before = writeCellRun(base, "a");
      const after = writeCellRun(base, "b", {
        trace: cellTrace({
          run_id: "run-cell-2",
          task: { source: "t", digest: "sha256:task-y" },
        }),
      });
      await expect(compare(before, after)).rejects.toMatchObject({
        code: "mismatched-inputs",
      } satisfies Partial<PflExportError>);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never claims no configuration change when one side lacks an observation", async () => {
    const base = tmp();
    try {
      const before = writeCellRun(base, "a");
      const traceB = cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" });
      delete traceB.observation;
      const after = writeCellRun(base, "b", {
        trace: traceB,
        exportBytes: null,
        exportListed: false,
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      const availability = entryAt(result, "comparison.config-unavailable");
      expect(availability.completeness).toBe("unknown");
      expect(availability.statement).toContain("may or may not differ");
      expect(entriesWith(result, "comparison.element-added.")).toEqual([]);
      expect(entriesWith(result, "comparison.element-removed.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reverses direction: B → A swaps added and removed", async () => {
    const base = tmp();
    try {
      const docB = exportDoc({
        data: { elements: [element("el_bbb"), element("el_ccc")] },
      });
      (docB.data as Record<string, unknown>).snapshot = {
        ...((docB.data as Record<string, unknown>).snapshot as Record<
          string,
          unknown
        >),
        cellId: "cell_b",
      };
      const a = writeCellRun(base, "a");
      const b = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" }),
        exportBytes: JSON.stringify(docB),
      });
      const forward = await compare(a, b);
      const reverse = await compare(b, a);
      expect(
        entriesWith(forward, "comparison.element-added.").map((e) => e.id),
      ).toEqual(["comparison.element-added.el_ccc"]);
      expect(
        entriesWith(reverse, "comparison.element-removed.").map((e) => e.id),
      ).toEqual(["comparison.element-removed.el_ccc"]);
      expect(
        entriesWith(reverse, "comparison.element-added.").map((e) => e.id),
      ).toEqual(["comparison.element-added.el_aaa"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("is deterministic under reordered export element arrays", async () => {
    const base = tmp();
    try {
      const docReordered = exportDoc({
        data: { elements: [element("el_bbb"), element("el_aaa")] },
      });
      const a = writeCellRun(base, "a");
      const a2 = writeCellRun(base, "a2", {
        exportBytes: JSON.stringify(docReordered),
      });
      const b = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" }),
        exportBytes: JSON.stringify(
          exportDoc({
            data: { elements: [element("el_bbb"), element("el_ccc")] },
          }),
        ),
      });
      const r1 = await compare(a, b);
      const r2 = await compare(a2, b);
      const cmp = (r: CellReportResult) =>
        r.entries.filter((e) => e.lane === "comparison");
      expect(cmp(r1).map((e) => e.id)).toEqual(cmp(r2).map((e) => e.id));
      expect(formatJson(r1)).toContain("comparison.element-added.el_ccc");
      expect(formatJson(r2)).toContain("comparison.element-added.el_ccc");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
