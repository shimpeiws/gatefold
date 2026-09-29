import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

// Case A consumer proof (issue #87): an external `analyze`-style evaluator
// drives Gatefold's *packed* CLI over genuine upstream-produced runs and
// decides the proposition "an observation failure must never be
// represented as no configuration change" using only the documented
// accessor surface (docs/analyze-accessor-contract.md, contract v1).
//
// Expected output versions: schemaVersion 9, source.command
// "report-cell"/"compare-cells". The consumer below never imports Gatefold
// code, never parses `statement` prose, and never opens a file that a
// result does not name through its inputs/evidence records.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

type Json = Record<string, unknown>;
interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const sha256 = (content: string | Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

function cellFixture(name: string): string {
  return fileURLToPath(
    new URL(`./fixtures/yuurei-cell/${name}`, import.meta.url),
  );
}

// -- the consumer -----------------------------------------------------------

/**
 * The Case A evaluation over one `compare-cells` result. Returns the
 * admission decision plus the per-side evidence class; a violation is an
 * explicit contradiction between an unavailable/unbound observation and a
 * claimed configuration difference.
 */
function evaluateCaseA(result: Json): {
  admission: "admitted" | "withheld" | "rejected";
  sides: Record<string, "bound" | "missing" | "disqualified">;
  violations: string[];
} {
  if ((result.schemaVersion as number) !== 9 || result.source === undefined)
    return {
      admission: "rejected",
      sides: {},
      violations: ["not a v9 result"],
    };
  const inputs = result.inputs as Json;
  const entries = result.entries as Json[];
  const entry = (id: string, subject?: string) =>
    entries.find(
      (e) =>
        e.id === id &&
        (subject === undefined
          ? e.subject === undefined
          : e.subject === subject),
    );
  const sides: Record<string, "bound" | "missing" | "disqualified"> = {};
  const violations: string[] = [];
  for (const subject of ["before", "after"] as const) {
    const descriptor = inputs[subject] as Json | undefined;
    const binding = entry("association.export-binding", subject);
    const retained = entry("association.export-retained", subject);
    const observed = entry("association.observation", subject);
    if (descriptor === undefined || binding === undefined) {
      violations.push(`${subject}: subject descriptor or binding check absent`);
      continue;
    }
    const state = binding.state as string;
    const retainedState = retained?.state as string | undefined;
    // Per the accessor contract: a side is "missing" only when nothing was
    // recorded at all — no observation record, no export. A declared
    // observation failure (association.observation recorded, status
    // unavailable) is present-but-disqualified evidence, never missing.
    const nothingRecorded =
      (observed === undefined || observed.state === "not-recorded") &&
      descriptor.observationStatus === null &&
      state === "not-recorded" &&
      (retainedState === "not-recorded" || retainedState === undefined);
    sides[subject] =
      state === "verified"
        ? "bound"
        : nothingRecorded
          ? "missing"
          : "disqualified";
  }
  const unavailable = entry("comparison.config-unavailable");
  const differenceEntries = entries.filter(
    (e) =>
      typeof e.id === "string" &&
      /^comparison\.(elements|effective|element-|relation-|finding-|facet)/.test(
        e.id,
      ),
  );
  // Case A rule: a side that is not bound must withhold the difference —
  // emitted element/relation/finding entries would represent an
  // unobserved side's configuration, i.e. a failure shown as a verdict
  // about change.
  const anyUnbound = Object.values(sides).some((s) => s !== "bound");
  if (anyUnbound && differenceEntries.length > 0)
    violations.push(
      "configuration difference emitted while a side has no bound export",
    );
  if (anyUnbound && unavailable === undefined)
    violations.push(
      "no config-unavailable marker while a side has no bound export",
    );
  if (!anyUnbound && unavailable !== undefined)
    violations.push("config-unavailable emitted while both sides are bound");
  return {
    admission:
      violations.length > 0 ? "rejected" : anyUnbound ? "withheld" : "admitted",
    sides,
    violations,
  };
}

/** Resolve a v9 evidence pointer against the named run's input files. */
function resolveEvidence(
  ref: Json,
  sideLabel: string,
): { file: string; value: unknown; digestOk: boolean } {
  const source = String(ref.source).replace(/^(before|after)/, "");
  const fileFor: Record<string, string> = {
    Trace: "trace.json",
    Manifest: "artifacts.json",
    Export: "observation/export.json",
    BaselineManifest: "baseline-manifest.json",
    Changes: "changes.json",
  };
  const rel = fileFor[source];
  if (rel === undefined)
    return { file: source, value: undefined, digestOk: true };
  const file = join(sideLabel, rel);
  if (
    rel === "observation/export.json" ||
    rel === "baseline-manifest.json" ||
    rel === "changes.json"
  ) {
    // Digest-bearing evidence: the cited stored bytes must hash to the
    // manifest-recorded digest the reference repeats.
    const manifest = JSON.parse(
      readFileSync(join(sideLabel, "artifacts.json"), "utf8"),
    ) as { artifacts: { path: string; digest: string }[] };
    const entry = manifest.artifacts.find((a) => a.path === rel);
    const actual = sha256(readFileSync(file));
    if (
      entry === undefined ||
      entry.digest !== ref.digest ||
      ref.digest !== actual
    )
      return { file, value: undefined, digestOk: false };
  }
  const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const pointer = String(ref.pointer);
  let value: unknown = doc;
  for (const segment of pointer.split("/").slice(1)) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    value = (value as Record<string, unknown>)[key];
  }
  return { file, value, digestOk: true };
}

// -- packed install -----------------------------------------------------------

let gatefoldBin = "";
let prefixDir = "";
let workDir = "";

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "gatefold-casea-pack-"));
  const { stdout: packOut } = await execFileAsync(
    "npm",
    ["pack", "--pack-destination", workDir, "--ignore-scripts"],
    { cwd: root, timeout: 180_000 },
  );
  const filename = packOut.trim().split("\n").pop()!;
  prefixDir = join(workDir, "prefix");
  await execFileAsync(
    "npm",
    [
      "install",
      "--prefix",
      prefixDir,
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(workDir, filename),
    ],
    { cwd: workDir, timeout: 180_000 },
  );
  gatefoldBin = join(
    prefixDir,
    "node_modules",
    "@shimpeiws",
    "gatefold",
    "bin",
    "gatefold.js",
  );
}, 240_000);

afterAll(() => {
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

async function installed(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [gatefoldBin, ...args],
      { cwd: workDir },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof e.code === "number" ? e.code : -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function copyRun(name: string, label: string): string {
  const dir = join(workDir, label);
  cpSync(cellFixture(name), dir, { recursive: true });
  return dir;
}

// -- the Case A proof over real evidence --------------------------------------

describe("analyze Case A consumer over the packed CLI", () => {
  it("admits the genuine same-source pair and resolves evidence digests to the named runs", async () => {
    const run = await installed([
      "compare-cells",
      "--before",
      cellFixture("cell-real-pair-a"),
      "--after",
      cellFixture("cell-real-pair-b"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as Json;
    expect(result.schemaVersion).toBe(9);
    expect((result.source as Json).command).toBe("compare-cells");
    const verdict = evaluateCaseA(result);
    expect(verdict.violations).toEqual([]);
    expect(verdict.admission).toBe("admitted");
    expect(verdict.sides).toEqual({ before: "bound", after: "bound" });

    // Source pointers and retained-byte digests resolve to the named
    // input: every export-sourced citation carries the manifest digest and
    // resolves inside the verified bytes.
    const entries = result.entries as Json[];
    const inputs = result.inputs as Json;
    const labels = {
      before: cellFixture("cell-real-pair-a"),
      after: cellFixture("cell-real-pair-b"),
    };
    expect((inputs.before as Json).label).toBe(labels.before);
    const exportRefs = entries.flatMap((e) =>
      (e.evidence as Json[]).filter(
        (ref) =>
          String(ref.source).endsWith("Export") ||
          String(ref.source).endsWith("BaselineManifest") ||
          String(ref.source).endsWith("Changes"),
      ),
    );
    expect(exportRefs.length).toBeGreaterThan(0);
    for (const ref of exportRefs) {
      const side = String(ref.source).startsWith("before")
        ? labels.before
        : labels.after;
      const resolved = resolveEvidence(ref, side);
      expect(resolved.digestOk, resolved.file).toBe(true);
      expect(resolved.value).not.toBeUndefined();
    }
  });

  it("withholds the comparison on a real observation failure — admitted path stays distinct", async () => {
    const run = await installed([
      "compare-cells",
      "--before",
      cellFixture("cell-real-run-a"),
      "--after",
      cellFixture("cell-real-run-d"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as Json;
    const verdict = evaluateCaseA(result);
    expect(verdict.violations).toEqual([]);
    expect(verdict.admission).toBe("withheld");
    // run-d's observation record is present and declares a failure:
    // present-but-disqualified evidence, distinguishable from missing.
    expect(verdict.sides).toEqual({ before: "bound", after: "disqualified" });
    expect(((result.inputs as Json).after as Json).observationStatus).toBe(
      "unavailable",
    );
    expect(((result.inputs as Json).after as Json).observationReason).toBe(
      "observer-not-found",
    );
  });

  it("classifies a corrupt retained export as disqualified, not missing", async () => {
    const dir = copyRun("cell-real-run-b", "corrupt-export");
    writeFileSync(join(dir, "observation", "export.json"), "{}");
    const run = await installed([
      "compare-cells",
      "--before",
      cellFixture("cell-real-run-a"),
      "--after",
      dir,
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const verdict = evaluateCaseA(JSON.parse(run.stdout) as Json);
    expect(verdict.violations).toEqual([]);
    expect(verdict.admission).toBe("withheld");
    expect(verdict.sides.after).toBe("disqualified");
  });

  it("classifies a contradicted cell association as disqualified", async () => {
    const dir = copyRun("cell-real-run-b", "contradicted-cell");
    const trace = JSON.parse(
      readFileSync(join(dir, "trace.json"), "utf8"),
    ) as Json;
    trace.cell_id = "cell_somewhere_else";
    writeFileSync(join(dir, "trace.json"), JSON.stringify(trace));
    const run = await installed([
      "compare-cells",
      "--before",
      cellFixture("cell-real-run-a"),
      "--after",
      dir,
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const verdict = evaluateCaseA(JSON.parse(run.stdout) as Json);
    expect(verdict.violations).toEqual([]);
    expect(verdict.admission).toBe("withheld");
    expect(verdict.sides.after).toBe("disqualified");
  });

  it("classifies a declared-but-unretained export as disqualified", async () => {
    const dir = copyRun("cell-real-run-b", "unretained-export");
    const manifest = JSON.parse(
      readFileSync(join(dir, "artifacts.json"), "utf8"),
    ) as { artifacts: Json[] };
    manifest.artifacts = manifest.artifacts.filter(
      (a) => a.path !== "observation/export.json",
    );
    writeFileSync(join(dir, "artifacts.json"), JSON.stringify(manifest));
    const run = await installed([
      "compare-cells",
      "--before",
      cellFixture("cell-real-run-a"),
      "--after",
      dir,
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const verdict = evaluateCaseA(JSON.parse(run.stdout) as Json);
    expect(verdict.violations).toEqual([]);
    expect(verdict.admission).toBe("withheld");
    expect(verdict.sides.after).toBe("disqualified");
  });

  it("classifies a side with no observation record at all as missing", async () => {
    const dir = copyRun("cell-real-run-b", "no-observation");
    // Strip the observation record and its declared export entirely:
    // nothing was recorded on this side — genuinely missing evidence,
    // distinct from a recorded failure (disqualified).
    const trace = JSON.parse(
      readFileSync(join(dir, "trace.json"), "utf8"),
    ) as Json;
    delete trace.observation;
    writeFileSync(join(dir, "trace.json"), JSON.stringify(trace));
    rmSync(join(dir, "observation", "export.json"), { force: true });
    const manifest = JSON.parse(
      readFileSync(join(dir, "artifacts.json"), "utf8"),
    ) as { artifacts: Json[] };
    manifest.artifacts = manifest.artifacts.filter(
      (a) => a.path !== "observation/export.json",
    );
    writeFileSync(join(dir, "artifacts.json"), JSON.stringify(manifest));
    const run = await installed([
      "compare-cells",
      "--before",
      cellFixture("cell-real-run-a"),
      "--after",
      dir,
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const verdict = evaluateCaseA(JSON.parse(run.stdout) as Json);
    expect(verdict.violations).toEqual([]);
    expect(verdict.admission).toBe("withheld");
    expect(verdict.sides.after).toBe("missing");
  });

  it("detects the semantic mutation: an observation failure dressed as an unchanged configuration", async () => {
    // Genuine upstream evidence: run-a observed, run-d's observer failed.
    const run = await installed([
      "compare-cells",
      "--before",
      cellFixture("cell-real-run-a"),
      "--after",
      cellFixture("cell-real-run-d"),
      "--format",
      "json",
    ]);
    const result = JSON.parse(run.stdout) as Json;
    expect(evaluateCaseA(result).admission).toBe("withheld");

    // The mutation harness: rewrite the result so the failure looks like
    // "observed, and nothing changed" — the representation Case A forbids.
    // The forged entry copies real evidence so the mutation stays
    // schema-valid: the consumer's rejection is semantic, not malformed-input.
    const mutated = JSON.parse(run.stdout) as Json;
    const entries = mutated.entries as Json[];
    const donor = entries.find(
      (e) => Array.isArray(e.evidence) && (e.evidence as Json[]).length > 0,
    );
    expect(donor).toBeDefined();
    mutated.entries = entries.filter(
      (e) => e.id !== "comparison.config-unavailable",
    );
    (mutated.entries as Json[]).push({
      lane: "comparison",
      id: "comparison.elements",
      state: "recorded",
      completeness: "complete",
      statement: "the retained exports record no element differences",
      evidence: donor!.evidence,
      provenance: { transform: ["compare-cells", "entry:comparison.elements"] },
    });
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../schema/claim-result.v9.json", import.meta.url),
        ),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate(mutated), "forged entry must stay schema-valid").toBe(true);
    const verdict = evaluateCaseA(mutated);
    expect(verdict.admission).toBe("rejected");
    expect(verdict.violations).toContain(
      "configuration difference emitted while a side has no bound export",
    );
    expect(verdict.violations).toContain(
      "no config-unavailable marker while a side has no bound export",
    );
  });

  it("keeps a single unavailable observation as unknown — never 'no configuration'", async () => {
    const run = await installed([
      "report-cell",
      "--run",
      cellFixture("cell-real-run-d"),
      "--format",
      "json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as Json;
    expect(result.schemaVersion).toBe(9);
    const availability = (result.entries as Json[]).find(
      (e) => e.id === "configuration.availability",
    );
    expect(availability?.state).toBe("not-recorded");
    expect(
      (result.entries as Json[]).some(
        (e) =>
          typeof e.id === "string" && e.id.startsWith("configuration.element."),
      ),
    ).toBe(false);
    expect(((result.inputs as Json).run as Json).observationStatus).toBe(
      "unavailable",
    );
  });
});
