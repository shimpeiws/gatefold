import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { auditRun } from "../src/application/audit-run.js";
import { reportCell } from "../src/application/cell-report.js";
import { compareCells } from "../src/application/compare-cells.js";
import { reportCells } from "../src/application/report-cells.js";
import { readAuditedRun } from "../src/input/yuurei-audit-run.js";
import { readCellRun } from "../src/input/yuurei-cell.js";

// Contract tests for docs/analyze-accessor-contract.md (accessor contract
// v1): a stand-in `analyze` consumer resolves every Case A accessor using
// only the documented selectors — result fields, entry id+lane+subject,
// and evidence pointers into listed inputs — never `statement` prose.
// Fixtures mix genuine upstream-produced runs (cell-real-*) with
// contract-shaped authored records; mutations copy a real run and patch
// its records so each failure mode is exercised against verified bytes.

type Json = Record<string, unknown>;

const sha256 = (content: string | Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gatefold-accessors-"));
}

function fixture(name: string): string {
  return fileURLToPath(
    new URL(`./fixtures/yuurei-cell/${name}`, import.meta.url),
  );
}

async function report(dir: string): Promise<Json> {
  return (await reportCell({
    cell: await readCellRun(dir),
  })) as unknown as Json;
}

async function compare(before: string, after: string): Promise<Json> {
  return (await compareCells({
    before: await readCellRun(before),
    after: await readCellRun(after),
  })) as unknown as Json;
}

// -- consumer-side accessor resolver (documented selectors only) -----------

function inputs(result: Json, subject?: string): Json {
  const inputs = result.inputs as Json;
  if (subject === "before" || subject === "after")
    return inputs[subject] as Json;
  return (inputs.run ?? (inputs.runs as Json[])[0]) as Json;
}

function entries(result: Json): Json[] {
  return result.entries as Json[];
}

function entryAt(result: Json, id: string, subject?: string): Json | undefined {
  return entries(result).find(
    (entry) =>
      entry.id === id &&
      (subject === undefined
        ? entry.subject === undefined
        : entry.subject === subject),
  );
}

const accessors = {
  observationStatus: (result: Json, subject?: string) =>
    inputs(result, subject).observationStatus as string | null,
  observationReason: (result: Json, subject?: string) =>
    (inputs(result, subject).observationReason ?? null) as string | null,
  exportRetained: (result: Json, subject?: string) =>
    entryAt(result, "association.export-retained", subject)?.state,
  exportDocument: (result: Json, subject?: string) =>
    entryAt(result, "association.export-document", subject)?.state,
  exportBinding: (result: Json, subject?: string) =>
    entryAt(result, "association.export-binding", subject)?.state,
  exportObservedSnapshotId: (result: Json, subject?: string) =>
    inputs(result, subject).exportObservedSnapshotId as string | null,
  configAvailability: (result: Json, subject?: string) =>
    entryAt(result, "configuration.availability", subject)?.state,
  configElementEntries: (result: Json, subject?: string) =>
    entries(result).filter(
      (entry) =>
        typeof entry.id === "string" &&
        entry.id.startsWith("configuration.element.") &&
        (subject === undefined || entry.subject === subject),
    ),
  configDifference: (result: Json) =>
    entryAt(result, "comparison.config-unavailable") === undefined
      ? "emitted"
      : "withheld",
  sourceIdentity: (result: Json) =>
    entryAt(result, "comparison.source-identity")?.state,
  auditFacts: (result: Json) => result.facts as Json[] | undefined,
  setInputs: (result: Json) => entryAt(result, "set.inputs")?.state,
  setRecords: (result: Json) =>
    entries(result).filter(
      (entry) =>
        typeof entry.id === "string" &&
        /^set\.(element|relation|finding)\./.test(entry.id),
    ),
  setConfigUnavailable: (result: Json) =>
    entryAt(result, "set.config-unavailable")?.state,
};

// -- fixture mutation helpers ----------------------------------------------

function cloneRun(name: string, base: string, label: string): string {
  const dir = join(base, label);
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

function readJson(dir: string, rel: string): Json {
  return JSON.parse(readFileSync(join(dir, rel), "utf8")) as Json;
}

function writeJson(dir: string, rel: string, doc: unknown): void {
  writeFileSync(join(dir, rel), JSON.stringify(doc));
}

function rewriteExportDigest(dir: string): void {
  const manifest = readJson(dir, "artifacts.json");
  const entries = manifest.artifacts as Json[];
  const entry = entries.find((item) => item.path === "observation/export.json");
  if (entry === undefined) throw new Error("no export manifest entry");
  entry.digest = sha256(readFileSync(join(dir, "observation", "export.json")));
  writeJson(dir, "artifacts.json", manifest);
}

// -- the case matrix ---------------------------------------------------------

describe("analyze accessor contract v1", () => {
  it("admits a fully bound real cell with resolvable identity and observation", async () => {
    const result = await report(fixture("cell-real-pair-a"));
    expect(result.schemaVersion).toBe(9);
    expect(accessors.observationStatus(result)).toBe("recorded");
    expect(accessors.observationReason(result)).toBeNull();
    expect(accessors.exportRetained(result)).toBe("verified");
    expect(accessors.exportDocument(result)).toBe("verified");
    expect(accessors.exportBinding(result)).toBe("verified");
    expect(accessors.exportObservedSnapshotId(result)).toBe("obs_d282348b1bf2");
    expect(accessors.configAvailability(result)).toBeUndefined();
    expect(accessors.configElementEntries(result).length).toBeGreaterThan(0);
    const run = inputs(result);
    expect(run.runId).toBe("20260928T123716Z-2c2a");
    expect(run.cellId).toBe("cell_20260928T123716Z-34bcd6f1");
  });

  it("reports an observer failure as unavailable evidence with its verbatim reason", async () => {
    const result = await report(fixture("cell-observation-unavailable"));
    expect(accessors.observationStatus(result)).toBe("unavailable");
    expect(accessors.observationReason(result)).toBe("export-failed");
    // The export records were never retained, but the observation record
    // exists and declares the failure — a disqualified side per the
    // contract's decision table, never a silently absent one.
    expect(accessors.exportRetained(result)).toBe("not-recorded");
    expect(accessors.exportBinding(result)).toBe("not-recorded");
    expect(accessors.configAvailability(result)).toBe("not-recorded");
    expect(accessors.exportObservedSnapshotId(result)).toBeNull();
    expect(accessors.configElementEntries(result)).toEqual([]);
  });

  it("keeps an absent observation record distinct from a recorded failure", async () => {
    const result = await report(fixture("cell-unobserved"));
    expect(accessors.observationStatus(result)).toBeNull();
    expect(accessors.observationReason(result)).toBeNull();
    expect(entryAt(result, "association.observation")?.state).toBe(
      "not-recorded",
    );
    expect(accessors.configAvailability(result)).toBe("not-recorded");
  });

  it("flags retained bytes that fail digest verification as disqualified, not missing", async () => {
    const base = tmp();
    try {
      const dir = cloneRun("cell-real-pair-a", base, "corrupt");
      writeFileSync(join(dir, "observation", "export.json"), "{}");
      // The manifest still records the original digest: stored bytes fail.
      const result = await report(dir);
      expect(accessors.exportRetained(result)).toBe("inconsistent");
      expect(accessors.exportBinding(result)).toBe("unverifiable");
      expect(accessors.configAvailability(result)).toBe("unverifiable");
      expect(accessors.exportObservedSnapshotId(result)).toBeNull();
      expect(accessors.configElementEntries(result)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("flags verified bytes that are not a conforming export as inconsistent", async () => {
    const base = tmp();
    try {
      const dir = cloneRun("cell-real-pair-a", base, "unparsable");
      writeJson(dir, "observation/export.json", { not: "an export" });
      rewriteExportDigest(dir); // bytes now verify — content still rejected
      const result = await report(dir);
      expect(accessors.exportRetained(result)).toBe("verified");
      expect(accessors.exportDocument(result)).toBe("inconsistent");
      expect(accessors.exportBinding(result)).toBe("unverifiable");
      expect(accessors.configElementEntries(result)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("distinguishes an unbound export (no cellId) from a contradicted one", async () => {
    const base = tmp();
    try {
      const unboundDir = cloneRun("cell-real-pair-a", base, "unbound");
      const doc = readJson(unboundDir, "observation/export.json");
      delete ((doc.data as Json).snapshot as Json).cellId;
      writeJson(unboundDir, "observation/export.json", doc);
      rewriteExportDigest(unboundDir);
      const unbound = await report(unboundDir);
      expect(accessors.exportBinding(unbound)).toBe("unverifiable");
      expect(accessors.exportObservedSnapshotId(unbound)).toBeNull();

      const contradictedDir = cloneRun("cell-real-pair-a", base, "other-cell");
      const trace = readJson(contradictedDir, "trace.json");
      trace.cell_id = "cell_other";
      writeJson(contradictedDir, "trace.json", trace);
      const contradicted = await report(contradictedDir);
      expect(accessors.exportBinding(contradicted)).toBe("inconsistent");
      expect(accessors.exportObservedSnapshotId(contradicted)).toBeNull();
      expect(accessors.configAvailability(contradicted)).toBe("inconsistent");
      expect(accessors.configElementEntries(contradicted)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("admits the real same-source pair and emits a configuration difference", async () => {
    const result = await compare(
      fixture("cell-real-pair-a"),
      fixture("cell-real-pair-b"),
    );
    expect(accessors.sourceIdentity(result)).toBe("verified");
    expect(accessors.configDifference(result)).toBe("emitted");
    expect(entryAt(result, "comparison.elements")?.state).toBe("recorded");
    for (const side of ["before", "after"] as const) {
      expect(accessors.exportBinding(result, side)).toBe("verified");
    }
  });

  it("withholds the difference — never asserts no change — when one side's observation failed", async () => {
    const base = tmp();
    try {
      const dir = cloneRun("cell-real-pair-b", base, "failed");
      const trace = readJson(dir, "trace.json");
      trace.observation = {
        observer: { id: "pfl", version: "1.2.0" },
        status: "unavailable",
        reason: "observer-not-found",
        completeness: null,
        snapshot_ids: null,
        artifacts: [],
      };
      writeJson(dir, "trace.json", trace);
      const result = await compare(fixture("cell-real-pair-a"), dir);
      // Case A: the observation failure surfaces as unavailable evidence.
      expect(accessors.observationStatus(result, "after")).toBe("unavailable");
      expect(accessors.observationReason(result, "after")).toBe(
        "observer-not-found",
      );
      expect(accessors.exportBinding(result, "after")).toBe("not-recorded");
      expect(accessors.configDifference(result)).toBe("withheld");
      const unavailable = entryAt(result, "comparison.config-unavailable");
      expect(unavailable?.state).toBe("unverifiable");
      // No emitted entry may assert sameness or absence of change.
      expect(
        entries(result).filter(
          (entry) =>
            typeof entry.id === "string" &&
            /^(comparison\.(element|relation|finding|elements|effective))/.test(
              entry.id,
            ),
        ),
      ).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("resolves the v8 audit.facts accessor to per-fact state and completeness", async () => {
    const result = (await auditRun({
      run: await readAuditedRun(fixture("cell-real-run-a")),
    })) as unknown as Json;
    expect(result.schemaVersion).toBe(8);
    const facts = accessors.auditFacts(result);
    expect(facts).toBeDefined();
    expect(facts!.length).toBeGreaterThan(0);
    const ids = new Set(facts!.map((fact) => fact.id));
    for (const expected of [
      "run.trace",
      "run.manifest",
      "patch.record",
      "result.stored",
    ]) {
      expect(ids.has(expected), expected).toBe(true);
    }
    for (const fact of facts!) {
      expect(typeof fact.state).toBe("string");
      expect(typeof fact.completeness).toBe("string");
    }
  });

  it("resolves the v10 set accessors over a real two-run set", async () => {
    const result = (await reportCells({
      cells: await Promise.all(
        ["cell-real-run-a", "cell-real-run-b"].map((name) =>
          readCellRun(fixture(name)),
        ),
      ),
    })) as unknown as Json;
    expect(result.schemaVersion).toBe(10);
    expect(accessors.setInputs(result)).toBe("recorded");
    expect(accessors.setRecords(result).length).toBeGreaterThan(0);
    expect(accessors.setConfigUnavailable(result)).toBeUndefined();
    const descriptor = inputs(result);
    expect(descriptor.observationStatus).toBe("recorded");
    expect(descriptor.observationReason).toBeNull();
  });

  it("withholds the v10 set account when fewer than two exports are bound", async () => {
    const result = (await reportCells({
      cells: await Promise.all(
        ["cell-real-run-a", "cell-real-run-d"].map((name) =>
          readCellRun(fixture(name)),
        ),
      ),
    })) as unknown as Json;
    expect(accessors.setInputs(result)).toBe("recorded");
    expect(accessors.setConfigUnavailable(result)).toBe("unverifiable");
    // run-d's own lanes still report its records — an unbound run is a
    // named contributor, never silently dropped or counted as absent.
    const run2 = (result.inputs as Json).runs as Json[];
    expect(run2[1].observationStatus).toBe("unavailable");
    expect(run2[1].observationReason).toBe("observer-not-found");
  });

  it("keeps v9 results emitted before observationReason existed valid", async () => {
    const result = await report(fixture("cell-real-pair-a"));
    const run = inputs(result);
    delete run.observationReason;
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../schema/claim-result.v9.json", import.meta.url),
        ),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate(result)).toBe(true);
    // A contract-v1 consumer reads an absent optional field as unrecorded.
    expect(accessors.observationReason(result)).toBeNull();
  });
});
