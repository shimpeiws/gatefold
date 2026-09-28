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
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { reportCells } from "../src/application/report-cells.js";
import type { CellsReportResult } from "../src/domain/cells.js";
import { CELLS_MAX_RUNS } from "../src/domain/cells.js";
import { PflExportError } from "../src/input/pfl-export.js";
import { readCellRun } from "../src/input/yuurei-cell.js";
import { formatCellsHuman } from "../src/output/human.js";
import { formatJson } from "../src/output/json.js";

// cell-real-run-a..d are genuine yuurei #214 + pfl #217 outputs: four real
// `yuurei run --observe` cells prepared from one seeded repository
// (declared source git-db9acfc85f531c03). a and b record identical
// element sets; c adds and changes elements; d's observation was
// unavailable, so it binds no export.

const root = fileURLToPath(new URL("../", import.meta.url));
const cellFixture = (name: string): string =>
  `${root}test/fixtures/yuurei-cell/${name}`;

const v10Schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/claim-result.v10.json", import.meta.url)),
    "utf8",
  ),
);
const validateCells = new Ajv2020({ strict: true }).compile(v10Schema);

const sha256 = (content: string | Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gatefold-cells-"));
}

async function report(...names: string[]): Promise<CellsReportResult> {
  return reportCells({
    cells: await Promise.all(
      names.map((name) => readCellRun(cellFixture(name))),
    ),
    labels: names,
  });
}

function entryAt(result: CellsReportResult, id: string) {
  const entry = result.entries.find((e) => e.id === id);
  if (entry === undefined) throw new Error(`entry ${id} not emitted`);
  return entry;
}

function expectSchemaValid(result: CellsReportResult): void {
  if (!validateCells(result))
    throw new Error(
      `result failed v10 schema validation: ${JSON.stringify(validateCells.errors)}`,
    );
}

/**
 * Copies a real run fixture and rewrites `trace.json`, keeping every
 * other byte identical — the manifest never covers trace.json, so a
 * patched trace still loads.
 */
function patchedTrace(
  srcDir: string,
  patch: (trace: Record<string, unknown>) => void,
): string {
  const dir = tmp();
  cpSync(srcDir, dir, { recursive: true });
  const path = join(dir, "trace.json");
  const trace = JSON.parse(readFileSync(path, "utf8"));
  patch(trace);
  writeFileSync(path, JSON.stringify(trace, null, 2));
  return dir;
}

/**
 * Copies a real run fixture and rewrites the retained export bytes,
 * re-signing the manifest entry so the artifact stays verified —
 * otherwise the reader discards it before interpreting.
 */
function patchedExport(
  srcDir: string,
  patch: (doc: Record<string, unknown>) => void,
): string {
  const dir = tmp();
  cpSync(srcDir, dir, { recursive: true });
  const exportPath = join(dir, "observation", "export.json");
  const bytes = JSON.stringify(JSON.parse(readFileSync(exportPath, "utf8")));
  const doc = JSON.parse(bytes);
  patch(doc);
  const next = JSON.stringify(doc);
  writeFileSync(exportPath, next);
  const manifestPath = join(dir, "artifacts.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const entry of manifest.artifacts)
    if (entry.path === "observation/export.json") entry.digest = sha256(next);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

describe("report-cells", () => {
  it("reports a genuine four-run set: three bound exports and one unbound run", async () => {
    const result = await report(
      "cell-real-run-a",
      "cell-real-run-b",
      "cell-real-run-c",
      "cell-real-run-d",
    );
    expect(result.schemaVersion).toBe(10);
    expect(result.source.command).toBe("report-cells");
    expectSchemaValid(result);

    expect(result.inputs.runs.map((r) => r.name)).toEqual([
      "run1",
      "run2",
      "run3",
      "run4",
    ]);
    const inputs = entryAt(result, "set.inputs");
    expect(inputs.statement).toContain("4 run directories were supplied");
    expect(inputs.statement).toContain("3 of them bind an export");
    expect(inputs.statement).toContain("run4");

    expect(entryAt(result, "set.comparability").state).toBe("verified");
    const source = entryAt(result, "set.source-identity");
    expect(source.state).toBe("verified");
    expect(source.statement).toContain("git-db9acfc85f531c03");
    // The cell-local project ids stay distinct observed facts.
    expect(source.statement).toContain("path-");

    const elements = entryAt(result, "set.elements");
    expect(elements.statement).toContain("3 distinct element id(s)");
    expect(elements.statement).toContain(
      "recorded identically in every eligible export",
    );
    expect(elements.statement).toContain("1 recorded in only a subset");

    const changed = entryAt(result, "set.element.el_0fc92802d8f84176");
    expect(changed.statement).toContain("3 of 3 eligible exports");
    expect(changed.statement).toContain("differ");
    const added = entryAt(result, "set.element.el_b4b02de1fca70ae7");
    expect(added.statement).toContain("1 of 3 eligible exports");
    expect(added.statement).toContain("no record in run1's complete export");

    // The unbound run is named as unknown, never as a non-observation.
    for (const entry of result.entries.filter(
      (e) => e.id.startsWith("set.element.") || e.id.startsWith("set.finding."),
    ))
      expect(entry.statement).toContain("run4 could not be checked");

    // run4 keeps its own lanes; it just has no configuration content.
    const run4 = result.entries.filter((e) => e.subject === "run4");
    expect(run4.some((e) => e.lane === "association")).toBe(true);
    expect(run4.some((e) => e.id.startsWith("configuration.element."))).toBe(
      false,
    );

    // Every citation resolves into a run's documents.
    for (const entry of result.entries)
      for (const evidence of entry.evidence)
        expect(evidence.source).toMatch(
          /^run[1-9][0-9]*(Trace|Manifest|Export|Patch|Result|BaselineManifest|Changes)$/,
        );
  });

  it("two same-condition runs state only that the eligible records match", async () => {
    const result = await report("cell-real-run-a", "cell-real-run-b");
    expectSchemaValid(result);
    const elements = entryAt(result, "set.elements");
    expect(elements.completeness).toBe("complete");
    expect(elements.statement).toContain("recorded identically");
    expect(elements.statement).toContain("0 recorded in only a subset");
    for (const entry of result.entries)
      expect(entry.statement).not.toMatch(
        /stable|stability|flak|regression|converge/i,
      );
    for (const entry of result.entries.filter((e) =>
      e.id.startsWith("set.element."),
    ))
      expect(entry.statement).not.toContain("differ");
  });

  it("reorders labels with the --run order and is deterministic", async () => {
    const first = await report(
      "cell-real-run-a",
      "cell-real-run-d",
      "cell-real-run-b",
    );
    const second = await report(
      "cell-real-run-a",
      "cell-real-run-d",
      "cell-real-run-b",
    );
    expect(formatJson(first)).toBe(formatJson(second));
    expect(first.inputs.runs.map((r) => r.name)).toEqual([
      "run1",
      "run2",
      "run3",
    ]);
    // run2 is the unbound run here, so it is named as unverifiable.
    expect(entryAt(first, "set.inputs").statement).toContain("run2");
    const reversed = await report(
      "cell-real-run-d",
      "cell-real-run-b",
      "cell-real-run-a",
    );
    expect(reversed.inputs.runs[0]!.name).toBe("run1");
    expect(entryAt(reversed, "set.inputs").statement).toContain("run1");
    expect(entryAt(reversed, "set.inputs").statement).not.toContain(
      "run2 could not",
    );
  });

  it("rejects a set whose declared source-project identities differ", async () => {
    // The run internally agrees (trace and export both name the new
    // source), so the rejection is purely about the set differing.
    const other = patchedExport(
      patchedTrace(cellFixture("cell-real-run-a"), (trace) => {
        (trace.seed as Record<string, unknown>).source_project = {
          id: "git-ffffffffffffffff",
          kind: "git-remote",
          remote: "github.com/gatefold-fixture/other",
        };
      }),
      (doc) => {
        const snapshot = (doc.data as Record<string, unknown>)
          .snapshot as Record<string, unknown>;
        const sp = snapshot.sourceProject as Record<string, unknown>;
        sp.id = "git-ffffffffffffffff";
        sp.remote = "github.com/gatefold-fixture/other";
      },
    );
    try {
      const cells = await Promise.all([
        readCellRun(cellFixture("cell-real-run-a")),
        readCellRun(other),
      ]);
      expect(() => reportCells({ cells })).toThrowError(
        /different source-project identities/,
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("rejects runs of different tasks with mismatched-inputs", async () => {
    const cells = await Promise.all([
      readCellRun(cellFixture("cell-real-run-a")),
      readCellRun(cellFixture("cell-incompatible")),
    ]);
    expect(() => reportCells({ cells })).toThrowError(PflExportError);
    expect(() => reportCells({ cells })).toThrowError(/task\.digest/);
  });

  it("rejects a set when the bound exports' runtime ids differ", async () => {
    const other = patchedExport(cellFixture("cell-real-run-a"), (doc) => {
      const data = doc.data as Record<string, unknown>;
      data.runtime = {
        ...(data.runtime as Record<string, unknown>),
        id: "codex",
      };
    });
    try {
      const cells = await Promise.all([
        readCellRun(cellFixture("cell-real-run-a")),
        readCellRun(other),
      ]);
      expect(() => reportCells({ cells })).toThrowError(/different runtimes/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("excludes a run whose export bytes are missing from every denominator", async () => {
    const broken = tmp();
    cpSync(cellFixture("cell-real-run-a"), broken, { recursive: true });
    rmSync(join(broken, "observation", "export.json"));
    try {
      const result = await reportCells({
        cells: await Promise.all([
          readCellRun(cellFixture("cell-real-run-a")),
          readCellRun(cellFixture("cell-real-run-b")),
          readCellRun(broken),
        ]),
        labels: ["a", "b", "broken"],
      });
      expectSchemaValid(result);
      expect(entryAt(result, "set.inputs").statement).toContain(
        "2 of them bind an export",
      );
      expect(entryAt(result, "set.inputs").statement).toContain("run3");
      for (const entry of result.entries.filter((e) =>
        e.id.startsWith("set.element."),
      )) {
        expect(entry.statement).toContain("of 2 eligible exports");
        expect(entry.statement).toContain("run3 could not be checked");
      }
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("excludes a run whose export bytes are truncated from the denominators", async () => {
    const truncated = tmp();
    cpSync(cellFixture("cell-real-run-a"), truncated, { recursive: true });
    const exportPath = join(truncated, "observation", "export.json");
    writeFileSync(exportPath, readFileSync(exportPath, "utf8").slice(0, 200));
    try {
      const result = await reportCells({
        cells: await Promise.all([
          readCellRun(cellFixture("cell-real-run-a")),
          readCellRun(truncated),
        ]),
      });
      expectSchemaValid(result);
      expect(entryAt(result, "set.inputs").statement).toContain(
        "1 of them bind an export",
      );
      expect(entryAt(result, "set.config-unavailable").state).toBe(
        "unverifiable",
      );
      // The run still reports its own lanes — its truncation is recorded,
      // never read as "no configuration".
      const run2 = result.entries.filter((e) => e.subject === "run2");
      expect(run2.some((e) => e.lane === "association")).toBe(true);
    } finally {
      rmSync(truncated, { recursive: true, force: true });
    }
  });

  it("states duplicate recorded identities without rejecting the set", async () => {
    const duplicate = tmp();
    cpSync(cellFixture("cell-real-run-a"), duplicate, { recursive: true });
    try {
      const result = await reportCells({
        cells: await Promise.all([
          readCellRun(cellFixture("cell-real-run-a")),
          readCellRun(duplicate),
        ]),
        labels: ["a", "copy"],
      });
      expectSchemaValid(result);
      const identities = entryAt(result, "set.identities");
      expect(identities.statement).toContain("1 distinct run id(s)");
      expect(identities.statement).toContain("run1 and run2");
    } finally {
      rmSync(duplicate, { recursive: true, force: true });
    }
  });

  it("never turns a partial export's omission into an absence", async () => {
    const partial = patchedExport(cellFixture("cell-real-run-a"), (doc) => {
      // A partial export may omit elements; the omission is
      // unestablished, never an observed absence.
      doc.completeness = "partial";
      const data = doc.data as Record<string, unknown>;
      data.elements = (data.elements as unknown[]).slice(1);
    });
    try {
      const result = await reportCells({
        cells: await Promise.all([
          readCellRun(cellFixture("cell-real-run-a")),
          readCellRun(partial),
        ]),
      });
      expectSchemaValid(result);
      const entry = result.entries.find(
        (e) =>
          e.id.startsWith("set.element.") &&
          e.statement.includes("1 of 2 eligible exports"),
      );
      expect(entry).toBeDefined();
      expect(entry!.statement).toContain("partial export");
      expect(entry!.statement).toContain("unestablished absence");
      expect(entry!.statement).not.toContain("absent");
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  });

  it("withholds the account when no shared source identity exists", async () => {
    // Neither run declares a source identity and the observed project ids
    // differ: no verified join basis exists, so no repeated-configuration
    // account can be emitted.
    const undeclaredA = patchedExport(
      patchedTrace(cellFixture("cell-real-run-a"), (trace) => {
        delete (trace.seed as Record<string, unknown>).source_project;
      }),
      (doc) => {
        const snapshot = (doc.data as Record<string, unknown>)
          .snapshot as Record<string, unknown>;
        delete snapshot.sourceProject;
      },
    );
    const undeclaredB = patchedExport(
      patchedTrace(cellFixture("cell-real-run-b"), (trace) => {
        delete (trace.seed as Record<string, unknown>).source_project;
      }),
      (doc) => {
        const data = doc.data as Record<string, unknown>;
        const snapshot = data.snapshot as Record<string, unknown>;
        delete snapshot.sourceProject;
        const project = data.project as Record<string, unknown>;
        project.id = "path-zzzzzzzzzzzzzzzz";
      },
    );
    try {
      const result = await reportCells({
        cells: await Promise.all([
          readCellRun(undeclaredA),
          readCellRun(undeclaredB),
        ]),
      });
      expectSchemaValid(result);
      const source = entryAt(result, "set.source-identity");
      expect(source.state).toBe("unverifiable");
      const unavailable = entryAt(result, "set.config-unavailable");
      expect(unavailable.state).toBe("unverifiable");
      expect(result.entries.some((e) => e.id.startsWith("set.element."))).toBe(
        false,
      );
    } finally {
      rmSync(undeclaredA, { recursive: true, force: true });
      rmSync(undeclaredB, { recursive: true, force: true });
    }
  });

  it("withholds the account when fewer than two exports are bound", async () => {
    const result = await report("cell-real-run-a", "cell-real-run-d");
    expectSchemaValid(result);
    const unavailable = entryAt(result, "set.config-unavailable");
    expect(unavailable.state).toBe("unverifiable");
    expect(result.entries.some((e) => e.id.startsWith("set.element."))).toBe(
      false,
    );
  });

  it("records a caveat when some trace lacks requested_cell", async () => {
    const missing = patchedTrace(cellFixture("cell-real-run-a"), (trace) => {
      delete trace.requested_cell;
    });
    try {
      const result = await reportCells({
        cells: await Promise.all([
          readCellRun(cellFixture("cell-real-run-a")),
          readCellRun(missing),
        ]),
      });
      expectSchemaValid(result);
      const caveat = entryAt(
        result,
        "set.caveat.requested_cell.inputs_version",
      );
      expect(caveat.state).toBe("recorded");
      // The runs that do not record the field are named.
      expect(caveat.statement).toContain("run2");
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });

  it("rejects more than the bounded-set ceiling", async () => {
    const cell = await readCellRun(cellFixture("cell-real-run-a"));
    expect(() =>
      reportCells({
        cells: Array.from({ length: CELLS_MAX_RUNS + 1 }, () => cell),
      }),
    ).toThrowError(PflExportError);
  });

  it("emits human-readable output without verdict vocabulary", async () => {
    const result = await report(
      "cell-real-run-a",
      "cell-real-run-b",
      "cell-real-run-c",
    );
    const human = formatCellsHuman(result);
    expect(human).toContain("Cell set report of 3 supplied runs");
    expect(human).toContain("run1:");
    expect(human).toContain("set.elements:");
    expect(human).toContain("evidence:");
    for (const word of ["[pass]", "[fail]", "score", "stable"])
      expect(human).not.toContain(word);
  });
});
