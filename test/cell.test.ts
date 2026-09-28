import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

/**
 * A contract-shaped export document whose recorded `cellId` binds it to a
 * named cell, so both sides of a comparison satisfy the association.
 */
function boundExport(
  cellId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const doc = exportDoc(overrides);
  const data = doc.data as Record<string, unknown>;
  data.snapshot = {
    ...(data.snapshot as Record<string, unknown>),
    cellId,
  };
  return doc;
}

/**
 * A yuurei #214 `seed.source_project` declaration — the trace's own record
 * of the source a seeded cell was prepared from.
 */
function seedSourceProject(id: string): Record<string, unknown> {
  return {
    id,
    kind: id.startsWith("git-") ? "git-remote" : "local-path",
    ...(id.startsWith("git-") ? { remote: "github.com/owner/repo" } : {}),
  };
}

/** A pfl #217 `data.snapshot.sourceProject` declaration. */
function declaredSourceProject(id: string): Record<string, unknown> {
  return {
    ...seedSourceProject(id),
    issuer: "yuurei",
    contractVersion: 1,
  };
}

/**
 * A seeded trace bound to `cellId` whose seed declares the given source
 * identity (or none when `sourceId` is null).
 */
function declaredCellTrace(
  cellId: string,
  sourceId: string | null,
  snapshotIds: { observed: string; resolved: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const trace = cellTrace({
    cell_id: cellId,
    observation: observationRecord({ snapshot_ids: snapshotIds }),
    ...overrides,
  });
  if (sourceId !== null)
    (trace.seed as Record<string, unknown>).source_project =
      seedSourceProject(sourceId);
  return trace;
}

/**
 * A bound export whose observed project id is `projectId` and whose
 * snapshot carries `source` as `sourceProject` (`undefined` omits the key
 * — a pre-schema-3 artifact).
 */
function declaredExport(
  cellId: string,
  projectId: string,
  source: Record<string, unknown> | null | undefined,
  snapshotIds: { observed: string; resolved: string },
): Record<string, unknown> {
  const doc = boundExport(cellId, {
    data: { project: { id: projectId, displayName: "owner/repo" } },
  });
  const snapshot = (doc.data as Record<string, unknown>).snapshot as Record<
    string,
    unknown
  >;
  snapshot.observedSnapshotId = snapshotIds.observed;
  snapshot.resolvedSnapshotId = snapshotIds.resolved;
  if (source !== undefined) snapshot.sourceProject = source;
  return doc;
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

/** Rewrites one artifact entry of an already written run directory. */
function rewriteManifestEntry(
  runDir: string,
  path: string,
  mutate: (entry: Record<string, unknown>) => void,
): void {
  const file = join(runDir, "artifacts.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    artifacts: Record<string, unknown>[];
  };
  const entry = manifest.artifacts.find((item) => item.path === path);
  if (entry === undefined) throw new Error(`no manifest entry for ${path}`);
  mutate(entry);
  writeFileSync(file, JSON.stringify(manifest));
}

/** A conforming v6 `evaluate-run` result document, bound to one run. */
function v6Document(
  runId: string,
  taskDigest = "sha256:task-x",
): Record<string, unknown> {
  return {
    schemaVersion: 6,
    source: { command: "evaluate-run" },
    inputs: {
      run: {
        label: "run",
        document: "yuurei-run",
        trace: { runId, taskDigest },
      },
      spec: { label: "spec", document: "task-spec", specVersion: "1" },
      checkReports: [],
    },
    context: { execution: {}, model: {}, usage: {}, cost: null },
    evaluations: [
      {
        criterionId: "c1",
        kind: "check",
        verdict: "pass",
        confidence: 1,
        reason: "r",
        evidence: [{ source: "spec", pointer: "/criteria/0" }],
        provenance: { transform: ["evaluate-run"] },
      },
    ],
  };
}

/** A conforming v7 `compare-evaluations` result document for two runs. */
function v7Document(
  beforeRunId: string,
  afterRunId: string,
  taskDigest = "sha256:task-x",
): Record<string, unknown> {
  return {
    schemaVersion: 7,
    source: { command: "compare-evaluations" },
    inputs: {
      beforeRun: {
        label: "a",
        document: "yuurei-run",
        trace: { runId: beforeRunId, taskDigest },
      },
      afterRun: {
        label: "b",
        document: "yuurei-run",
        trace: { runId: afterRunId, taskDigest },
      },
      spec: { label: "spec", document: "task-spec", specVersion: "1" },
      beforeCheckReports: [],
      afterCheckReports: [],
    },
    context: { execution: {}, model: {}, usage: {}, cost: null },
    transitions: [
      {
        criterionId: "c1",
        kind: "check",
        before: "pass",
        after: "fail",
        changed: true,
        confidence: 1,
        reason: "r",
        evidence: [{ source: "spec", pointer: "/criteria/0" }],
        provenance: { transform: ["compare-evaluations"] },
      },
    ],
    caveats: [],
  };
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

  it("reads a real pfl v1.2.0 export a run directory retains", async () => {
    // test/fixtures/yuurei-cell/cell-real-pfl/observation/export.json is
    // genuine pfl v1.2.0 output (`pfl export --cell-id ... --json`, schema
    // 2, 80 observed elements, completeness "partial"); only the run
    // records around it are authored. See docs/v0.9-scope.md#fixtures.
    const runDir = fileURLToPath(
      new URL("./fixtures/yuurei-cell/cell-real-pfl", import.meta.url),
    );
    const result = await report(runDir);
    expectSchemaValid(result);
    expect(entryAt(result, "association.export-binding").state).toBe(
      "verified",
    );
    expect(entryAt(result, "association.export-document").state).toBe(
      "verified",
    );
    const elements = entriesWith(result, "configuration.element.");
    expect(elements).toHaveLength(80);
    for (const entry of elements) {
      expect(entry.state).toBe("recorded");
      expect(entry.completeness).toBe("partial");
      expect(entry.evidence[0]?.digest).toBeDefined();
    }
    expect(entryAt(result, "configuration.completeness").statement).toContain(
      "partial",
    );
  });

  it("reads a whole real yuurei v1.2.0 observed run end to end", async () => {
    // test/fixtures/yuurei-cell/cell-real-observed is a genuine
    // `yuurei run probe --observe` directory under level1: trace.json,
    // artifacts.json, the logs, patch.diff, observation/export.json and the
    // observation bundle are all upstream output, and every manifest digest
    // is taken over those bytes. It records model.requested as "" and a
    // failed execution (codex exited 1 with no credentials), so it also
    // pins the reader against a real `status: "recorded"` run rather than a
    // contract-shaped authored one. See docs/v0.9-scope.md#fixtures.
    const runDir = fileURLToPath(
      new URL("./fixtures/yuurei-cell/cell-real-observed", import.meta.url),
    );
    const result = await report(runDir);
    expectSchemaValid(result);
    expect(entryAt(result, "association.cell-id").state).toBe("recorded");
    for (const id of [
      "association.export-retained",
      "association.export-document",
      "association.export-binding",
      "association.export-snapshots",
      "association.export-runtime",
      "association.export-completeness",
      "association.record-consistency",
    ])
      expect(entryAt(result, id).state).toBe("verified");
    // the observer's own export supplies the configuration lane
    const elements = entriesWith(result, "configuration.element.");
    expect(elements.length).toBeGreaterThan(0);
    for (const entry of elements) {
      expect(entry.state).toBe("recorded");
      expect(entry.evidence[0]?.digest).toBeDefined();
    }
    expect(
      entriesWith(result, "configuration.finding.").length,
    ).toBeGreaterThan(0);
    // an empty requested model is an absent request, never a model named ''
    const model = entryAt(result, "execution.model");
    expect(model.statement).toContain("requested no model");
    expect(model.statement).not.toContain("model ''");
    // the run's own execution record is restated; no success is claimed
    const outcome = entryAt(result, "execution.outcome");
    expect(outcome.statement).toContain("exit_code '1'");
  });
});

describe("cell report review regressions", () => {
  it("keeps a supported export without a cellId reportable", async () => {
    const base = tmp();
    try {
      // pfl before v1.2.0 (and an authored record) may omit the key
      // entirely: the association is then unverifiable, never an abort.
      const doc = exportDoc();
      delete (doc.data as { snapshot: Record<string, unknown> }).snapshot
        .cellId;
      const runDir = writeCellRun(base, "run", {
        exportBytes: JSON.stringify(doc),
      });
      const result = await report(runDir);
      expectSchemaValid(result);
      const binding = entryAt(result, "association.export-binding");
      expect(binding.state).toBe("unverifiable");
      expect(binding.completeness).toBe("unknown");
      expect(binding.statement).toContain(
        "does not carry data.snapshot.cellId",
      );
      expect(binding.evidence.map((e) => e.pointer)).toContain(
        "/data/snapshot",
      );
      expect(entryAt(result, "configuration.availability").state).toBe(
        "unverifiable",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("flags a recorded observation whose export the manifest does not retain", async () => {
    const base = tmp();
    try {
      const runDir = writeCellRun(base, "run", { exportListed: false });
      const result = await report(runDir);
      expectSchemaValid(result);
      expect(entryAt(result, "association.export-retained").state).toBe(
        "unverifiable",
      );
      const consistency = entryAt(result, "association.record-consistency");
      expect(consistency.state).toBe("inconsistent");
      expect(consistency.statement).toContain("does not retain");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a v7 comparison document supplied to a single cell as the wrong kind", async () => {
    const base = tmp();
    try {
      const v7 = join(base, "v7.json");
      writeFileSync(v7, JSON.stringify(v7Document("run-cell-1", "run-cell-2")));
      const result = await report(writeCellRun(base, "run"), v7);
      expectSchemaValid(result);
      const binding = entryAt(result, "evaluation.binding");
      expect(binding.state).toBe("unverifiable");
      expect(binding.statement).toContain("v7");
      expect(binding.statement).toContain("v6");
      expect(entriesWith(result, "evaluation.eval-")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not present an incomplete supplied result as evaluation context", async () => {
    const base = tmp();
    try {
      // The reviewer's example: the identity and verdict fields are there,
      // but a conforming v6 result also records the spec, the run context,
      // and per-criterion evidence and provenance.
      const v6 = join(base, "v6.json");
      writeFileSync(
        v6,
        JSON.stringify({
          schemaVersion: 6,
          source: { command: "evaluate-run" },
          inputs: {
            run: {
              trace: { runId: "run-cell-1", taskDigest: "sha256:task-x" },
            },
          },
          evaluations: [
            { criterionId: "c", kind: "check", verdict: "pass", reason: "ok" },
          ],
        }),
      );
      const result = await report(writeCellRun(base, "run"), v6);
      expectSchemaValid(result);
      expect(entryAt(result, "evaluation.supplied").state).toBe("unverifiable");
      expect(entryAt(result, "evaluation.binding").state).toBe("unverifiable");
      expect(entriesWith(result, "evaluation.eval-")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not read an export no observation record declares", async () => {
    const base = tmp();
    try {
      // The manifest retains a matching export, but the trace records no
      // observation at all: the artifact belongs to no cell record and is
      // never published as this run's observed configuration.
      const trace = cellTrace();
      delete trace.observation;
      const runDir = writeCellRun(base, "run", { trace });
      const result = await report(runDir);
      expectSchemaValid(result);
      for (const id of [
        "association.export-retained",
        "association.export-document",
        "association.export-binding",
        "association.export-runtime",
      ])
        expect(entryAt(result, id).state, id).toBe("not-recorded");
      expect(entryAt(result, "configuration.availability").state).toBe(
        "not-recorded",
      );
      expect(entriesWith(result, "configuration.element.")).toEqual([]);
      expect(entriesWith(result, "configuration.relation.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps an unbound export's snapshot ids out of the input descriptor", async () => {
    const base = tmp();
    try {
      // The export parses and retains bytes, but its cellId is not this
      // cell's: the descriptor must not present its snapshot ids as ours.
      const runDir = writeCellRun(base, "run", {
        trace: cellTrace({ cell_id: "cell_other" }),
      });
      const result = await report(runDir);
      expectSchemaValid(result);
      expect(result.inputs.run?.cellId).toBe("cell_other");
      expect(result.inputs.run?.exportObservedSnapshotId).toBeNull();
      expect(result.inputs.run?.exportResolvedSnapshotId).toBeNull();
      const availability = entryAt(result, "configuration.availability");
      expect(availability.state).toBe("inconsistent");
      expect(availability.statement).toContain("not bound to this cell");
      expect(availability.statement).not.toContain(
        "no interpretable export document is retained",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a manifest-listed export with no observation as a contradiction", async () => {
    const base = tmp();
    try {
      const trace = cellTrace();
      delete trace.observation;
      const result = await report(writeCellRun(base, "run", { trace }));
      expectSchemaValid(result);
      const consistency = entryAt(result, "association.record-consistency");
      expect(consistency.state).toBe("inconsistent");
      expect(consistency.statement).toContain("no observation at all");
      expect(entriesWith(result, "configuration.element.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never opens an undeclared manifest export whose path escapes the run", async () => {
    const base = tmp();
    try {
      const outside = join(base, "outside-export.json");
      writeFileSync(outside, JSON.stringify(exportDoc()));
      const trace = cellTrace();
      delete trace.observation;
      const runDir = writeCellRun(base, "run", { trace, exportBytes: null });
      symlinkSync(outside, join(runDir, "observation", "export.json"));
      rewriteManifestEntry(runDir, "observation/export.json", (entry) => {
        entry.digest = sha256(readFileSync(outside));
      });
      // The declaration is what makes an export readable: an undeclared
      // entry is never verified, so the escaping target cannot reject the
      // whole report.
      const result = await report(runDir);
      expectSchemaValid(result);
      expect(entryAt(result, "association.record-consistency").state).toBe(
        "inconsistent",
      );
      expect(entryAt(result, "association.export-binding").state).toBe(
        "not-recorded",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("cites the manifest, not stored bytes, for an unverified artifact", async () => {
    const base = tmp();
    try {
      const runDir = writeCellRun(base, "run");
      rewriteManifestEntry(runDir, "patch.diff", (entry) => {
        entry.digest = `sha256:${"0".repeat(64)}`;
      });
      const result = await report(runDir);
      expectSchemaValid(result);
      const evidence = entryAt(result, "execution.patch").evidence.filter(
        (item) => item.source === "manifest",
      );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.pointer).toBe("/artifacts/0");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports an undeclared manifest export without reading it as the cell", async () => {
    const base = tmp();
    try {
      // The observation record exists but declares no export artifact.
      const runDir = writeCellRun(base, "run", {
        trace: cellTrace({ observation: observationRecord({ artifacts: [] }) }),
      });
      const result = await report(runDir);
      expectSchemaValid(result);
      expect(entryAt(result, "association.export-binding").state).toBe(
        "not-recorded",
      );
      expect(entryAt(result, "association.export-retained").state).toBe(
        "not-recorded",
      );
      expect(entryAt(result, "association.record-consistency").state).toBe(
        "inconsistent",
      );
      expect(entriesWith(result, "configuration.element.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("stops a missing cellId and a null cellId from reading alike", async () => {
    const base = tmp();
    try {
      const nullCellId = exportDoc();
      (nullCellId.data as { snapshot: Record<string, unknown> }).snapshot = {
        ...(nullCellId.data as { snapshot: Record<string, unknown> }).snapshot,
        cellId: null,
      };
      const nullRun = writeCellRun(base, "null-cell-id", {
        exportBytes: JSON.stringify(nullCellId),
      });
      const nullResult = await report(nullRun);
      expectSchemaValid(nullResult);
      expect(
        entryAt(nullResult, "configuration.availability").statement,
      ).toContain("asserts no cell association");

      const absentCellId = exportDoc();
      delete (absentCellId.data as { snapshot: Record<string, unknown> })
        .snapshot.cellId;
      const absentResult = await report(
        writeCellRun(base, "absent-cell-id", {
          exportBytes: JSON.stringify(absentCellId),
        }),
      );
      expectSchemaValid(absentResult);
      expect(
        entryAt(absentResult, "configuration.availability").statement,
      ).toContain("does not record a cellId");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("is deterministic under reordered relation and finding arrays", async () => {
    const base = tmp();
    try {
      const relations = [
        {
          type: "accumulates-with",
          from: "el_aaa",
          to: "el_bbb",
        },
        { type: "shadows", from: "el_bbb", to: "el_aaa" },
      ];
      const findings = [
        {
          rule: "opaque-runtime-layer",
          message: "m1",
          elementIds: ["el_aaa"],
        },
        {
          rule: "conditional-activation",
          message: "m2",
          elementIds: ["el_bbb"],
        },
      ];
      const plain = exportDoc({
        data: { relations, findings },
      });
      const reordered = exportDoc({
        data: {
          elements: [element("el_bbb"), element("el_aaa")],
          relations: [...relations].reverse(),
          findings: [...findings].reverse(),
        },
      });
      const config = async (name: string, bytes: string) => {
        const result = await report(
          writeCellRun(base, name, { exportBytes: bytes }),
        );
        return result.entries
          .filter((e) => e.lane === "configuration")
          .map((e) => ({ id: e.id, statement: e.statement }));
      };
      const a = await config("plain", JSON.stringify(plain));
      const b = await config("reordered", JSON.stringify(reordered));
      expect(b).toEqual(a);
      expect(a.map((e) => e.id)).toContain("configuration.relation.0");
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
            data: {
              snapshot: {
                observedSnapshotId: "obs_0123456789ab",
                resolvedSnapshotId: "res_0123456789ab",
                capturedAt: "2026-09-20T09:59:00.000Z",
                schemaVersion: "2",
                cellId: "cell_b",
              },
              elements: [element("el_bbb"), element("el_ccc")],
            },
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

  it("withholds the configuration difference when a side's export is not bound", async () => {
    const base = tmp();
    try {
      const before = writeCellRun(base, "a");
      // B retains a parseable export, but its recorded cellId does not
      // match its own trace's cell_id: no bound configuration to compare.
      const after = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_other" }),
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      const unavailable = entryAt(result, "comparison.config-unavailable");
      expect(unavailable.state).toBe("unverifiable");
      expect(unavailable.statement).toContain("not bound to its cell");
      expect(unavailable.statement).toContain("may or may not differ");
      expect(entriesWith(result, "comparison.element-added.")).toEqual([]);
      expect(entriesWith(result, "comparison.element-removed.")).toEqual([]);
      expect(entriesWith(result, "comparison.element-changed.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not read a partial patch as a complete file set", async () => {
    const base = tmp();
    try {
      const before = writeCellRun(base, "a");
      const afterDir = writeCellRun(base, "b", {
        trace: cellTrace({
          run_id: "run-cell-2",
          cell_id: "cell_b",
          patch: { base: "seeded", state: "partial" },
        }),
        exportBytes: JSON.stringify(boundExport("cell_b")),
      });
      const result = await compare(before, afterDir);
      expectSchemaValid(result);
      const patch = entryAt(result, "comparison.patch");
      expect(patch.state).toBe("recorded");
      expect(patch.completeness).toBe("partial");
      expect(patch.statement).toContain("cannot be compared as complete sets");
      // Omitted content is never read as deletion.
      expect(entriesWith(result, "comparison.patch-file-removed.")).toEqual([]);
      expect(entriesWith(result, "comparison.patch-file-added.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps distinct relations distinct when their concatenations collide", async () => {
    const base = tmp();
    try {
      // "resolves-to" + from + to collides across these two triples; the
      // comparison must still report one addition and one removal.
      const beforeDoc = boundExport("cell_20260920-a1", {
        data: {
          elements: [element("el_a"), element("aX")],
          relations: [{ type: "resolves-to", from: "el_a", to: "aX" }],
        },
      });
      const afterDoc = boundExport("cell_b", {
        data: {
          elements: [element("el_aa"), element("X")],
          relations: [{ type: "resolves-to", from: "el_aa", to: "X" }],
        },
      });
      const before = writeCellRun(base, "a", {
        exportBytes: JSON.stringify(beforeDoc),
      });
      const after = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" }),
        exportBytes: JSON.stringify(afterDoc),
      });
      const result = await compare(before, after);
      expect(entriesWith(result, "comparison.relation-added.")).toHaveLength(1);
      expect(entriesWith(result, "comparison.relation-removed.")).toHaveLength(
        1,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not call same-content blocks at different positions identical", async () => {
    const base = tmp();
    try {
      const patch = (start: number) =>
        `--- src/f.ts\n+++ src/f.ts\n@@ -${start},1 +${start},1 @@\n-old\n+new\n`;
      const before = writeCellRun(base, "a", { patch: patch(1) });
      const after = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" }),
        patch: patch(9),
        exportBytes: JSON.stringify(boundExport("cell_b")),
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      const summary = entryAt(result, "comparison.patch");
      expect(summary.completeness).toBe("complete");
      expect(summary.statement).toContain("1 changed");
      expect(
        entriesWith(result, "comparison.patch-file-changed.src/f.ts"),
      ).toHaveLength(1);
      expect(entriesWith(result, "comparison.patch-file-added.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports equal cell ids as equal, not as distinct instances", async () => {
    const base = tmp();
    try {
      const before = writeCellRun(base, "a");
      const after = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2" }),
      });
      const result = await compare(before, after);
      const statement = entryAt(result, "comparison.cell-ids").statement;
      expect(statement).toContain("the same cell_id is recorded on both sides");
      expect(statement).not.toContain("distinct prepared cell instances");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("states a shared profile identity in the comparison", async () => {
    const base = tmp();
    try {
      const before = writeCellRun(base, "a");
      const after = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2" }),
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      const entry = entryAt(result, "comparison.profile");
      expect(entry.state).toBe("recorded");
      expect(entry.statement).toContain("both cells used profile 'p'");
      expect(entry.statement).toContain("'sha256:p'");
      expect(entry.statement).toContain("same on both sides");
      expect(entry.evidence.map((e) => `${e.source}:${e.pointer}`)).toEqual([
        "beforeTrace:/profile/digest",
        "afterTrace:/profile/digest",
        "beforeTrace:/profile/name",
        "afterTrace:/profile/name",
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("treats a renamed profile with the same content digest as the same identity", async () => {
    // The content digest is the profile's identity and the name is
    // provenance (docs/yuurei-trace-contract.md), so a rename that leaves the
    // contents alone is not an identity difference.
    const base = tmp();
    try {
      const before = writeCellRun(base, "a");
      const after = writeCellRun(base, "b", {
        trace: cellTrace({
          run_id: "run-cell-2",
          profile: { name: "renamed", digest: "sha256:p" },
        }),
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      const entry = entryAt(result, "comparison.profile");
      expect(entry.statement).toContain(
        "same profile content digest 'sha256:p'",
      );
      expect(entry.statement).toContain("A 'p'");
      expect(entry.statement).toContain("B 'renamed'");
      expect(entry.statement).toContain("a profile name is provenance");
      expect(entry.statement).toContain("the profile identity is the same");
      expect(entry.statement).not.toContain("different profiles");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("states a differing profile identity as the subject, not a defect", async () => {
    // The profile is the compared variable of a cell comparison, so a
    // difference must be stated in the comparison lane rather than left to
    // the two per-side execution entries — and must never reject the pair.
    const base = tmp();
    try {
      const before = writeCellRun(base, "a");
      const after = writeCellRun(base, "b", {
        trace: cellTrace({
          run_id: "run-cell-2",
          profile: { name: "q", digest: "sha256:q" },
        }),
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      const entry = entryAt(result, "comparison.profile");
      expect(entry.state).toBe("recorded");
      expect(entry.statement).toContain("different profiles");
      expect(entry.statement).toContain("A 'p'");
      expect(entry.statement).toContain("'sha256:p'");
      expect(entry.statement).toContain("B 'q'");
      expect(entry.statement).toContain("'sha256:q'");
      expect(entry.statement).toContain("not a defect");
      // the pair stayed comparable: the configuration lane is still emitted
      expect(entryAt(result, "comparison.comparability").state).toBe(
        "verified",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps a facet named __proto__ in the comparison", async () => {
    const base = tmp();
    try {
      const beforeDoc = boundExport("cell_20260920-a1", {
        data: {
          elements: [
            element("el_aaa", {
              interpretation: {
                elementId: "el_aaa",
                facets: ["__proto__"],
                confidence: "high",
                reason: "r",
              },
            }),
          ],
        },
      });
      const afterDoc = boundExport("cell_b", {
        data: { elements: [element("el_aaa")] },
      });
      const before = writeCellRun(base, "a", {
        exportBytes: JSON.stringify(beforeDoc),
      });
      const after = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" }),
        exportBytes: JSON.stringify(afterDoc),
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      const entry = entryAt(result, "comparison.facet.__proto__");
      expect(entry.statement).toContain("count changed by -1");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("cites the field a version note is about", async () => {
    const base = tmp();
    try {
      const afterDoc = boundExport("cell_b");
      (afterDoc.data as { runtime: Record<string, unknown> }).runtime = {
        ...(afterDoc.data as { runtime: Record<string, unknown> }).runtime,
        version: "2.2.0",
      };
      const before = writeCellRun(base, "a");
      const after = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" }),
        exportBytes: JSON.stringify(afterDoc),
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      const note = entryAt(result, "comparison.version-note.0");
      expect(note.statement).toContain("runtime version differs");
      expect(note.evidence.map((item) => item.pointer)).toContain(
        "/data/runtime/version",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("counts a duplicate finding once and a resolved-null transition not at all", async () => {
    const base = tmp();
    try {
      const finding = {
        rule: "opaque-runtime-layer",
        message: "m1",
        elementIds: ["el_bbb"],
      };
      const beforeDoc = boundExport("cell_20260920-a1", {
        data: { elements: [element("el_bbb", { resolved: null })] },
      });
      const afterDoc = boundExport("cell_b", {
        data: {
          elements: [element("el_bbb")],
          findings: [finding, { ...finding }],
        },
      });
      const before = writeCellRun(base, "a", {
        exportBytes: JSON.stringify(beforeDoc),
      });
      const after = writeCellRun(base, "b", {
        trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" }),
        exportBytes: JSON.stringify(afterDoc),
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      // Finding identity is the whole finding and the diff mirrors pfl's
      // `findingsDiff`, which filters the array: a finding recorded twice
      // in B is added once per recorded occurrence, never matched to A's set.
      expect(entriesWith(result, "comparison.finding-added.")).toHaveLength(2);
      expect(entriesWith(result, "comparison.finding-removed.")).toEqual([]);
      // An element with no resolved layer on A and one on B is a
      // newly-effective count, never a from -> to transition claim.
      const effective = entryAt(result, "comparison.effective");
      expect(effective.statement).toContain("1 element(s) newly effective");
      expect(entriesWith(result, "comparison.status-change.")).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("restates a bound v7 result's transitions", async () => {
    const base = tmp();
    try {
      const v7 = join(base, "v7.json");
      writeFileSync(v7, JSON.stringify(v7Document("run-cell-1", "run-cell-2")));
      const result = await compare(
        writeCellRun(base, "a"),
        writeCellRun(base, "b", {
          trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" }),
          exportBytes: JSON.stringify(boundExport("cell_b")),
        }),
        v7,
      );
      expectSchemaValid(result);
      expect(entryAt(result, "comparison.evaluation-binding").state).toBe(
        "verified",
      );
      const transitions = entriesWith(
        result,
        "comparison.evaluation-transition.",
      );
      expect(transitions.map((e) => e.id)).toEqual([
        "comparison.evaluation-transition.0",
      ]);
      expect(transitions[0]?.statement).toContain("'pass' → 'fail'");
      expect(transitions[0]?.statement).toContain("c1");
      expect(transitions[0]?.evidence[0]?.pointer).toBe("/transitions/0");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a v6 result supplied to a comparison as the wrong kind", async () => {
    const base = tmp();
    try {
      const v6 = join(base, "v6.json");
      writeFileSync(v6, JSON.stringify(v6Document("run-cell-1")));
      const result = await compare(
        writeCellRun(base, "a"),
        writeCellRun(base, "b", {
          trace: cellTrace({ run_id: "run-cell-2", cell_id: "cell_b" }),
          exportBytes: JSON.stringify(boundExport("cell_b")),
        }),
        v6,
      );
      expectSchemaValid(result);
      const binding = entryAt(result, "comparison.evaluation-binding");
      expect(binding.state).toBe("unverifiable");
      expect(binding.statement).toContain("v6");
      expect(binding.statement).toContain("v7");
      expect(entriesWith(result, "comparison.evaluation-transition.")).toEqual(
        [],
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("compare-cells source-project identity", () => {
  const SRC_A = "git-1111111111111111";
  const SRC_B = "git-2222222222222222";
  const IDS_A = { observed: "obs_a", resolved: "res_a" };
  const IDS_B = { observed: "obs_b", resolved: "res_b" };
  const PROJECT_A = "path-aaaaaaaaaaaaaaaa";
  const PROJECT_B = "path-bbbbbbbbbbbbbbbb";

  const writePair = (
    base: string,
    sides: {
      before: {
        trace: Record<string, unknown>;
        export: Record<string, unknown>;
      };
      after: {
        trace: Record<string, unknown>;
        export: Record<string, unknown>;
      };
    },
  ) => ({
    before: writeCellRun(base, "a", {
      trace: sides.before.trace,
      exportBytes: JSON.stringify(sides.before.export),
    }),
    after: writeCellRun(base, "b", {
      trace: sides.after.trace,
      exportBytes: JSON.stringify(sides.after.export),
    }),
  });

  const sourceEntry = (result: CellReportResult) =>
    entryAt(result, "comparison.source-identity");
  const noElementDiff = (result: CellReportResult) => {
    expect(entriesWith(result, "comparison.elements")).toEqual([]);
    expect(entriesWith(result, "comparison.element-added.")).toEqual([]);
    expect(entriesWith(result, "comparison.element-removed.")).toEqual([]);
    expect(entriesWith(result, "comparison.element-changed.")).toEqual([]);
    expect(entriesWith(result, "comparison.effective")).toEqual([]);
  };

  it("reports the A → B difference for two observed cells of one declared source", async () => {
    const base = tmp();
    try {
      // Distinct temporary workspaces give the cells distinct observed
      // project ids; the declared source identity agrees on both sides.
      const docB = declaredExport(
        "cell_20260920-b2",
        PROJECT_B,
        declaredSourceProject(SRC_A),
        IDS_B,
      );
      (docB.data as Record<string, unknown>).elements = [
        element("el_bbb"),
        element("el_ccc"),
      ];
      const { before, after } = writePair(base, {
        before: {
          trace: declaredCellTrace("cell_20260920-a1", SRC_A, IDS_A),
          export: declaredExport(
            "cell_20260920-a1",
            PROJECT_A,
            declaredSourceProject(SRC_A),
            IDS_A,
          ),
        },
        after: {
          trace: declaredCellTrace("cell_20260920-b2", SRC_A, IDS_B, {
            run_id: "run-cell-2",
          }),
          export: docB,
        },
      });
      const result = await compare(before, after);
      expectSchemaValid(result);

      const identity = sourceEntry(result);
      expect(identity.state).toBe("verified");
      expect(identity.statement).toContain(SRC_A);
      // Both observed cell-local ids remain stated as distinct facts.
      expect(identity.statement).toContain(PROJECT_A);
      expect(identity.statement).toContain(PROJECT_B);
      const pointers = identity.evidence.map((e) => e.pointer);
      expect(pointers).toContain("/seed/source_project");
      expect(pointers).toContain("/data/snapshot/sourceProject");
      expect(pointers).toContain("/data/project/id");
      expect(
        entryAt(result, "association.export-source-project", "before").state,
      ).toBe("verified");
      expect(
        entryAt(result, "association.export-source-project", "after").state,
      ).toBe("verified");

      // The real diff runs: A's el_aaa was removed, el_ccc added.
      expect(
        entriesWith(result, "comparison.element-added.").map((e) => e.id),
      ).toEqual(["comparison.element-added.el_ccc"]);
      expect(
        entriesWith(result, "comparison.element-removed.").map((e) => e.id),
      ).toEqual(["comparison.element-removed.el_aaa"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects two cells whose verified declared sources differ", async () => {
    const base = tmp();
    try {
      const { before, after } = writePair(base, {
        before: {
          trace: declaredCellTrace("cell_a", SRC_A, IDS_A),
          export: declaredExport(
            "cell_a",
            PROJECT_A,
            declaredSourceProject(SRC_A),
            IDS_A,
          ),
        },
        after: {
          trace: declaredCellTrace("cell_b", SRC_B, IDS_B, {
            run_id: "run-cell-2",
          }),
          export: declaredExport(
            "cell_b",
            PROJECT_B,
            declaredSourceProject(SRC_B),
            IDS_B,
          ),
        },
      });
      const error = await compare(before, after).catch((e) => e);
      expect(error).toMatchObject({ code: "mismatched-inputs" });
      expect((error as Error).message).toContain(SRC_A);
      expect((error as Error).message).toContain(SRC_B);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("withholds the difference when the export declares a source the trace does not record", async () => {
    const base = tmp();
    try {
      // Both exports carry the same declared id, but neither trace records
      // it — the declaration cannot be cross-checked against either run.
      const { before, after } = writePair(base, {
        before: {
          trace: declaredCellTrace("cell_a", null, IDS_A),
          export: declaredExport(
            "cell_a",
            PROJECT_A,
            declaredSourceProject(SRC_A),
            IDS_A,
          ),
        },
        after: {
          trace: declaredCellTrace("cell_b", null, IDS_B, {
            run_id: "run-cell-2",
          }),
          export: declaredExport(
            "cell_b",
            PROJECT_B,
            declaredSourceProject(SRC_A),
            IDS_B,
          ),
        },
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      expect(sourceEntry(result).state).toBe("unverifiable");
      const caveat = entryAt(result, "comparison.config-unavailable");
      expect(caveat.state).toBe("unverifiable");
      expect(caveat.statement).toContain("never 'no configuration change'");
      noElementDiff(result);
      expect(
        entryAt(result, "association.export-source-project", "before").state,
      ).toBe("unverifiable");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("withholds when a declaring trace meets an export that records no source identity", async () => {
    const base = tmp();
    try {
      // A's export is a pre-schema-3 artifact (no sourceProject key); B's
      // export records `sourceProject: null`. Neither side can verify a
      // shared source.
      const { before, after } = writePair(base, {
        before: {
          trace: declaredCellTrace("cell_a", SRC_A, IDS_A),
          export: declaredExport("cell_a", PROJECT_A, undefined, IDS_A),
        },
        after: {
          trace: declaredCellTrace("cell_b", SRC_A, IDS_B, {
            run_id: "run-cell-2",
          }),
          export: declaredExport("cell_b", PROJECT_B, null, IDS_B),
        },
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      expect(sourceEntry(result).state).toBe("unverifiable");
      entryAt(result, "comparison.config-unavailable");
      noElementDiff(result);
      expect(
        entryAt(result, "association.export-source-project", "before").state,
      ).toBe("unverifiable");
      expect(
        entryAt(result, "association.export-source-project", "after").state,
      ).toBe("unverifiable");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("withholds when a cell's own seed and export declare different sources", async () => {
    const base = tmp();
    try {
      // A's records contradict each other; B verifies SRC_B. The pair is
      // caveated — A's records cannot establish which source it was.
      const { before, after } = writePair(base, {
        before: {
          trace: declaredCellTrace("cell_a", SRC_A, IDS_A),
          export: declaredExport(
            "cell_a",
            PROJECT_A,
            declaredSourceProject(SRC_B),
            IDS_A,
          ),
        },
        after: {
          trace: declaredCellTrace("cell_b", SRC_B, IDS_B, {
            run_id: "run-cell-2",
          }),
          export: declaredExport(
            "cell_b",
            PROJECT_B,
            declaredSourceProject(SRC_B),
            IDS_B,
          ),
        },
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      expect(sourceEntry(result).state).toBe("unverifiable");
      entryAt(result, "comparison.config-unavailable");
      noElementDiff(result);
      const association = entryAt(
        result,
        "association.export-source-project",
        "before",
      );
      expect(association.state).toBe("inconsistent");
      expect(association.statement).toContain(SRC_A);
      expect(association.statement).toContain(SRC_B);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("still compares a legacy pair on equal observed project ids", async () => {
    const base = tmp();
    try {
      // No source declarations anywhere; both exports record the same
      // observed project id — the pre-#83 rule, unchanged.
      const docB = boundExport("cell_b", {
        data: { elements: [element("el_bbb"), element("el_ccc")] },
      });
      const { before, after } = writePair(base, {
        before: {
          trace: declaredCellTrace("cell_a", null, IDS_A),
          export: boundExport("cell_a"),
        },
        after: {
          trace: declaredCellTrace("cell_b", null, IDS_B, {
            run_id: "run-cell-2",
          }),
          export: docB,
        },
      });
      const result = await compare(before, after);
      expectSchemaValid(result);
      const identity = sourceEntry(result);
      expect(identity.state).toBe("unverifiable");
      expect(identity.statement).toContain("same observed identity");
      expect(entryAt(result, "comparison.elements").state).toBe("recorded");
      expect(
        entriesWith(result, "comparison.element-added.").map((e) => e.id),
      ).toEqual(["comparison.element-added.el_ccc"]);
      expect(
        entryAt(result, "association.export-source-project", "before").state,
      ).toBe("not-recorded");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reverses direction for a declared same-source pair", async () => {
    const base = tmp();
    try {
      const docB = declaredExport(
        "cell_b",
        PROJECT_B,
        declaredSourceProject(SRC_A),
        IDS_B,
      );
      (docB.data as Record<string, unknown>).elements = [
        element("el_bbb"),
        element("el_ccc"),
      ];
      const { before, after } = writePair(base, {
        before: {
          trace: declaredCellTrace("cell_a", SRC_A, IDS_A),
          export: declaredExport(
            "cell_a",
            PROJECT_A,
            declaredSourceProject(SRC_A),
            IDS_A,
          ),
        },
        after: {
          trace: declaredCellTrace("cell_b", SRC_A, IDS_B, {
            run_id: "run-cell-2",
          }),
          export: docB,
        },
      });
      const result = await compare(after, before);
      expectSchemaValid(result);
      expect(sourceEntry(result).state).toBe("verified");
      // B → A: el_aaa was added going back, el_ccc/el_bbb's extra is removed.
      expect(
        entriesWith(result, "comparison.element-added.").map((e) => e.id),
      ).toEqual(["comparison.element-added.el_aaa"]);
      expect(
        entriesWith(result, "comparison.element-removed.").map((e) => e.id),
      ).toEqual(["comparison.element-removed.el_ccc"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // The cells under cell-real-pair-a/-b/-other-source are genuine
  // artifacts: produced by yuurei's run pipeline (#214 build) seeded from
  // real Git repositories and observed by the real pfl (#217 build). The
  // seeded workspaces were temporary cells, so each export's observed
  // `data.project.id` differs while the declared source identity agrees —
  // the exact pair #83 requires. See docs/v0.9-scope.md#fixtures.
  it("compares a genuine upstream-produced same-source pair end to end", async () => {
    const before = fileURLToPath(
      new URL("./fixtures/yuurei-cell/cell-real-pair-a", import.meta.url),
    );
    const after = fileURLToPath(
      new URL("./fixtures/yuurei-cell/cell-real-pair-b", import.meta.url),
    );
    const result = await compare(before, after);
    expectSchemaValid(result);

    // The observed cell-local project ids differ — the workspaces were
    // distinct — while the declared source identity is shared.
    const identity = sourceEntry(result);
    expect(identity.state).toBe("verified");
    expect(identity.statement).toContain("git-db9acfc85f531c03");
    expect(identity.statement).toContain("path-a9b3bdafe676936f");
    expect(identity.statement).toContain("path-a25ea8edc829502f");
    expect(
      entryAt(result, "association.export-source-project", "before").state,
    ).toBe("verified");
    expect(
      entryAt(result, "association.export-source-project", "after").state,
    ).toBe("verified");
    expect(entryAt(result, "comparison.elements").state).toBe("recorded");
  });

  it("rejects a genuine observed cell of a different declared source", async () => {
    const before = fileURLToPath(
      new URL("./fixtures/yuurei-cell/cell-real-pair-a", import.meta.url),
    );
    const other = fileURLToPath(
      new URL("./fixtures/yuurei-cell/cell-real-other-source", import.meta.url),
    );
    const error = await compare(before, other).catch((e) => e);
    expect(error).toMatchObject({ code: "mismatched-inputs" });
    expect((error as Error).message).toContain("git-db9acfc85f531c03");
    expect((error as Error).message).toContain("git-948b51d1187494ec");
  });

  it("keeps a new-meets-legacy pair caveated when the observed project ids differ", async () => {
    const base = tmp();
    try {
      // cell-real-pair-b with its source declarations stripped — the same
      // bytes a pre-#214 yuurei and pre-#217 pfl would have shipped, digest
      // fixed up so the records stay verified-but-undeclaring. Side A still
      // verifies its declared source; B cannot, so the pair is caveated.
      const declaredDir = fileURLToPath(
        new URL("./fixtures/yuurei-cell/cell-real-pair-a", import.meta.url),
      );
      const legacyDir = join(base, "legacy");
      mkdirSync(join(legacyDir, "observation", "bundle"), {
        recursive: true,
      });
      const sourceDir = fileURLToPath(
        new URL("./fixtures/yuurei-cell/cell-real-pair-b", import.meta.url),
      );
      for (const rel of [
        "trace.json",
        "artifacts.json",
        "baseline-manifest.json",
        "changes.json",
        "patch.diff",
        "stdout.log",
        "stderr.log",
        "resolved-profile.json",
        "observation/export.json",
        "observation/bundle/harness.json",
        "observation/bundle/manifest.json",
      ]) {
        const text = readFileSync(join(sourceDir, rel), "utf8");
        writeFileSync(join(legacyDir, rel), text);
      }
      const trace = JSON.parse(
        readFileSync(join(legacyDir, "trace.json"), "utf8"),
      );
      delete trace.seed.source_project;
      writeFileSync(join(legacyDir, "trace.json"), JSON.stringify(trace));
      const exportPath = join(legacyDir, "observation", "export.json");
      const doc = JSON.parse(readFileSync(exportPath, "utf8"));
      delete doc.data.snapshot.sourceProject;
      const exportBytes = JSON.stringify(doc);
      writeFileSync(exportPath, exportBytes);
      rewriteManifestEntry(legacyDir, "observation/export.json", (entry) => {
        entry.digest = sha256(exportBytes);
      });

      const result = await compare(declaredDir, legacyDir);
      expectSchemaValid(result);
      expect(sourceEntry(result).state).toBe("unverifiable");
      const caveat = entryAt(result, "comparison.config-unavailable");
      expect(caveat.statement).toContain("never 'no configuration change'");
      noElementDiff(result);
      expect(
        entryAt(result, "association.export-source-project", "before").state,
      ).toBe("verified");
      expect(
        entryAt(result, "association.export-source-project", "after").state,
      ).toBe("not-recorded");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
