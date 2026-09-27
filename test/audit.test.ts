import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { auditRun } from "../src/application/audit-run.js";
import { loadCheckReports } from "../src/application/check-report-binding.js";
import type { AuditFact, AuditResult } from "../src/domain/audit.js";
import { formatAuditHuman } from "../src/output/human.js";
import { formatJson } from "../src/output/json.js";
import { PflExportError } from "../src/input/pfl-export.js";
import { readAuditedRun } from "../src/input/yuurei-audit-run.js";

const dir = new URL("fixtures/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));
const runFixture = (name: string): string => fixture(`yuurei-run/${name}`);

const sha256 = (content: string | Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gatefold-audit-"));
}

const v8Schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/claim-result.v8.json", import.meta.url)),
    "utf8",
  ),
);
const validateAudit = new Ajv2020().compile(v8Schema);

// One added, one modified, one deleted file — matches seedDoc() defaults.
const seededPatch =
  "--- src/auth.ts\n" +
  "+++ src/auth.ts\n" +
  "@@ -1,3 +1,4 @@\n" +
  " export function check(token) {\n" +
  "-  return token.exp > now();\n" +
  "+  return token.exp > now() && !token.revoked;\n" +
  " }\n" +
  "+export const VERSION = 2;\n" +
  "--- /dev/null\n" +
  "+++ test/auth.test.ts\n" +
  "@@ -0,0 +1,1 @@\n" +
  "+import { check };\n" +
  "--- legacy/util.ts\n" +
  "+++ /dev/null\n" +
  "@@ -1,1 +0,0 @@\n" +
  "-export const OLD = true;\n";

const legacyPatch =
  "--- /dev/null\n+++ README.md\n@@ -0,0 +1,1 @@\n+# readme\n";

const RESULT_TEXT = '{"status": "fixed", "note": "token expiry"}\n';
const BASELINE_DIGEST = "sha256:base-1";

function seedDoc(
  changes: { added: number; modified: number; deleted: number } | null = {
    added: 1,
    modified: 1,
    deleted: 1,
  },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    policy: "git-tracked-files",
    source: "/seed/x",
    head: "0123456789abcdef0123456789abcdef01234567",
    baseline: {
      requested_digest: BASELINE_DIGEST,
      materialized_digest: BASELINE_DIGEST,
      files: 2,
      bytes: 12,
    },
    ...(changes === null ? {} : { changes }),
    ...overrides,
  };
}

function baselineManifestDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    policy: "git-tracked-files",
    source: "/seed/x",
    head: "0123456789abcdef0123456789abcdef01234567",
    requested_digest: BASELINE_DIGEST,
    materialized_digest: BASELINE_DIGEST,
    files: {
      "a.txt": { digest: "sha256:" + "0".repeat(64), mode: 420, bytes: 5 },
      "b.txt": { digest: "sha256:" + "1".repeat(64), mode: 420, bytes: 7 },
    },
    ...overrides,
  };
}

function changesDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    baseline_digest: BASELINE_DIGEST,
    added: ["test/auth.test.ts"],
    modified: ["src/auth.ts"],
    deleted: ["legacy/util.ts"],
    ...overrides,
  };
}

function seededTrace(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "0.3",
    run_id: "run-seeded-t",
    started_at: "t0",
    finished_at: "t1",
    runtime: { id: "claude-code", version: "2.0.0" },
    model: { requested: "m", resolved: "m-1", resolved_reason: "observed" },
    profile: { name: "p", digest: "sha256:p" },
    task: { source: "t", digest: "sha256:task-x" },
    requested_cell: { digest: "sha256:cell", inputs_version: 2 },
    seed: seedDoc(),
    patch: { base: "seeded", state: "complete" },
    isolation: { strategy: "cell", verified: true },
    execution: {
      exit_code: 0,
      signal: null,
      duration_ms: 10,
      timed_out: false,
    },
    usage: {},
    cost: null,
    artifacts: [],
    ...overrides,
  };
}

function legacyTrace(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const t = seededTrace();
  delete t.seed;
  return {
    ...t,
    requested_cell: { digest: "sha256:cell", inputs_version: 1 },
    patch: { base: "empty", state: "complete" },
    ...overrides,
  };
}

interface RunOptions {
  trace?: Record<string, unknown>;
  manifest?: unknown;
  patch?: string | null;
  patchTruncated?: boolean;
  result?: string | null;
  resultTruncated?: boolean;
  baselineManifest?: string | null;
  changes?: string | null;
}

/**
 * Writes a run directory; patch/result/baseline-manifest/changes default
 * to recorded with verified digests on a seeded run.
 */
function writeRun(base: string, name: string, opts: RunOptions = {}): string {
  const runDir = join(base, name);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "trace.json"),
    JSON.stringify(opts.trace ?? seededTrace()),
  );
  const artifacts: Record<string, unknown>[] = [];
  const patch = opts.patch === undefined ? seededPatch : opts.patch;
  if (patch !== null) {
    writeFileSync(join(runDir, "patch.diff"), patch);
    artifacts.push({
      path: "patch.diff",
      kind: "patch",
      digest: sha256(patch),
      ...(opts.patchTruncated ? { truncated: true } : {}),
    });
  }
  const result = opts.result === undefined ? RESULT_TEXT : opts.result;
  if (result !== null) {
    writeFileSync(join(runDir, "result.txt"), result);
    artifacts.push({
      path: "result.txt",
      kind: "result",
      digest: sha256(result),
      ...(opts.resultTruncated ? { truncated: true } : {}),
    });
  }
  const baselineManifest =
    opts.baselineManifest === undefined
      ? JSON.stringify(baselineManifestDoc())
      : opts.baselineManifest;
  if (baselineManifest !== null) {
    writeFileSync(join(runDir, "baseline-manifest.json"), baselineManifest);
    artifacts.push({
      path: "baseline-manifest.json",
      kind: "file",
      digest: sha256(baselineManifest),
    });
  }
  const changes =
    opts.changes === undefined ? JSON.stringify(changesDoc()) : opts.changes;
  if (changes !== null) {
    writeFileSync(join(runDir, "changes.json"), changes);
    artifacts.push({
      path: "changes.json",
      kind: "file",
      digest: sha256(changes),
    });
  }
  writeFileSync(
    join(runDir, "artifacts.json"),
    JSON.stringify(opts.manifest ?? { artifacts }),
  );
  return runDir;
}

function writeReport(base: string, name: string, report: unknown): string {
  const path = join(base, name);
  writeFileSync(
    path,
    typeof report === "string" ? report : JSON.stringify(report),
  );
  return path;
}

function reportDoc(overrides: Record<string, unknown> = {}): unknown {
  return {
    reportVersion: 1,
    evaluator: { id: "vitest", version: "3.0.0" },
    subject: {
      taskDigest: "sha256:task-x",
      baselineDigest: BASELINE_DIGEST,
      patchDigest: sha256(seededPatch),
    },
    results: [{ criterionId: "unit-tests", verdict: "pass" }],
    ...overrides,
  };
}

async function audit(
  runDir: string,
  reportPaths: string[] = [],
): Promise<AuditResult> {
  return auditRun({
    run: await readAuditedRun(runDir),
    checkReports: await loadCheckReports(reportPaths),
    labels: { run: runDir },
  });
}

function factAt(result: AuditResult, id: string, subject?: string): AuditFact {
  const entry = result.facts.find(
    (f) => f.id === id && (subject === undefined || f.subject === subject),
  );
  if (entry === undefined)
    throw new Error(`fact ${id}${subject ? ` [${subject}]` : ""} not emitted`);
  return entry;
}

describe("audit-run", () => {
  it("audits a fully consistent seeded run: every fact verified or complete", async () => {
    const base = tmp();
    try {
      const result = await audit(writeRun(base, "run"));
      expect(result.schemaVersion).toBe(8);
      expect(result.source.command).toBe("audit-run");
      expect(result.facts.map((f) => f.id)).toEqual([
        "run.trace",
        "run.manifest",
        "seed.provenance",
        "seed.inputs-version",
        "seed.patch-base",
        "seed.baseline-materialization",
        "seed.changes-record",
        "baseline-manifest.stored",
        "baseline-manifest.record",
        "changes.stored",
        "changes.record",
        "patch.stored",
        "patch.interpretable",
        "patch.record",
        "patch.completeness",
        "seed.changes-patch",
        "changes.patch-agreement",
        "result.stored",
        "result.availability",
        "result.content",
      ]);
      for (const entry of result.facts) {
        expect(entry.state, entry.id).toBe("verified");
        expect(entry.completeness, entry.id).toBe("complete");
        expect(entry.evidence.length).toBeGreaterThan(0);
      }
      const json = JSON.parse(formatJson(result));
      expect(validateAudit(json), JSON.stringify(validateAudit.errors)).toBe(
        true,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("audits the committed seeded-a fixture end to end", async () => {
    const result = await audit(runFixture("seeded-a"));
    for (const entry of result.facts)
      expect(entry.state, entry.id).toBe("verified");
    const json = JSON.parse(formatJson(result));
    expect(validateAudit(json), JSON.stringify(validateAudit.errors)).toBe(
      true,
    );
  });

  it("marks seeded facts not-recorded on a legacy run and patch completeness unverifiable when undeclared", async () => {
    const base = tmp();
    try {
      const trace = legacyTrace();
      delete trace.patch;
      const result = await audit(
        writeRun(base, "run", {
          trace,
          patch: legacyPatch,
          baselineManifest: null,
          changes: null,
        }),
      );
      expect(factAt(result, "seed.provenance").state).toBe("not-recorded");
      expect(factAt(result, "seed.inputs-version").state).toBe("verified");
      expect(factAt(result, "seed.patch-base").state).toBe("not-recorded");
      expect(factAt(result, "baseline-manifest.stored").state).toBe(
        "not-recorded",
      );
      expect(factAt(result, "changes.stored").state).toBe("not-recorded");
      expect(factAt(result, "patch.stored").state).toBe("verified");
      expect(factAt(result, "patch.interpretable").state).toBe("verified");
      // No completeness record: a whole patch never certifies coverage.
      expect(factAt(result, "patch.completeness")).toMatchObject({
        state: "unverifiable",
        completeness: "unknown",
      });
      expect(factAt(result, "seed.changes-patch").state).toBe("not-recorded");
      expect(factAt(result, "changes.patch-agreement").state).toBe(
        "not-recorded",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("verifies patch completeness on a legacy run whose patch record declares complete", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: legacyTrace(),
          patch: legacyPatch,
          baselineManifest: null,
          changes: null,
        }),
      );
      expect(factAt(result, "patch.record").state).toBe("verified");
      expect(factAt(result, "patch.completeness")).toMatchObject({
        state: "verified",
        completeness: "complete",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports patch.state 'absent' plus a listed patch entry as inconsistent", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: seededTrace({
            patch: { base: "seeded", state: "absent" },
          }),
        }),
      );
      expect(factAt(result, "patch.record").state).toBe("inconsistent");
      expect(factAt(result, "patch.completeness").state).toBe("unverifiable");
      // The stored bytes still verify on their own.
      expect(factAt(result, "patch.stored").state).toBe("verified");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports patch.state 'complete' with no manifest entry as inconsistent", async () => {
    const base = tmp();
    try {
      const result = await audit(writeRun(base, "run", { patch: null }));
      expect(factAt(result, "patch.record").state).toBe("inconsistent");
      expect(factAt(result, "patch.stored").state).toBe("not-recorded");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports patch.state 'complete' on a truncated patch as inconsistent and partial", async () => {
    const base = tmp();
    try {
      // Cut mid-block so the stored prefix parses as an incomplete record.
      const cut = seededPatch.slice(0, seededPatch.indexOf("+++ test/"));
      const result = await audit(
        writeRun(base, "run", { patch: cut, patchTruncated: true }),
      );
      expect(factAt(result, "patch.stored")).toMatchObject({
        state: "verified",
        completeness: "partial",
      });
      expect(factAt(result, "patch.record").state).toBe("inconsistent");
      expect(factAt(result, "patch.completeness")).toMatchObject({
        state: "unverifiable",
        completeness: "partial",
      });
      // 'complete' declares full coverage; the cut prefix covers only a
      // subset, so the records contradict — on partial evidence.
      expect(factAt(result, "seed.changes-patch")).toMatchObject({
        state: "inconsistent",
        completeness: "partial",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves patch completeness unverifiable when a 'complete' record coexists with omission diagnostics", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: seededTrace({
            diagnostics: ["patch: 1 binary file(s) omitted"],
          }),
        }),
      );
      expect(factAt(result, "patch.record").state).toBe("inconsistent");
      expect(factAt(result, "patch.completeness")).toMatchObject({
        state: "unverifiable",
        completeness: "partial",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves patch completeness unverifiable when a 'complete' record coexists with a generation-failed diagnostic", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: seededTrace({
            diagnostics: ["patch: generation failed; patch.diff not recorded"],
          }),
        }),
      );
      expect(factAt(result, "patch.record").state).toBe("inconsistent");
      expect(factAt(result, "patch.completeness")).toMatchObject({
        state: "unverifiable",
        completeness: "partial",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a stored patch with no seed.changes record as inconsistent even without a patch record", async () => {
    const base = tmp();
    try {
      const trace = seededTrace({ seed: seedDoc(null) });
      delete trace.patch;
      const result = await audit(
        writeRun(base, "run", { trace, changes: null }),
      );
      expect(factAt(result, "patch.record").state).toBe("not-recorded");
      expect(factAt(result, "seed.changes-patch")).toMatchObject({
        state: "inconsistent",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a diagnostically published patch with no seed.changes record as inconsistent", async () => {
    const base = tmp();
    try {
      const trace = seededTrace({
        seed: seedDoc(null),
        diagnostics: ["patch: 1 binary file(s) omitted"],
      });
      delete trace.patch;
      const result = await audit(
        writeRun(base, "run", { trace, patch: null, changes: null }),
      );
      expect(factAt(result, "patch.record").state).toBe("not-recorded");
      expect(factAt(result, "seed.changes-patch")).toMatchObject({
        state: "inconsistent",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves the count comparison unverifiable when a declared patch is not stored", async () => {
    const base = tmp();
    try {
      const result = await audit(writeRun(base, "run", { patch: null }));
      expect(factAt(result, "patch.record").state).toBe("inconsistent");
      expect(factAt(result, "seed.changes-patch")).toMatchObject({
        state: "unverifiable",
        completeness: "unknown",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks count and path contradictions on a truncated patch as inconsistent with partial completeness", async () => {
    const base = tmp();
    try {
      // Two sealed added-file blocks in a truncated patch while
      // seed.changes.added is 1 and changes.json lists neither path.
      const extra =
        "--- /dev/null\n+++ a.ts\n@@ -0,0 +1,1 @@\n+x\n" +
        "--- /dev/null\n+++ b.ts\n@@ -0,0 +1,1 @@\n+y\n";
      const result = await audit(
        writeRun(base, "run", { patch: extra, patchTruncated: true }),
      );
      expect(factAt(result, "seed.changes-patch")).toMatchObject({
        state: "inconsistent",
        completeness: "partial",
      });
      expect(factAt(result, "changes.patch-agreement")).toMatchObject({
        state: "inconsistent",
        completeness: "partial",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a truncated decodable result as unverifiable content", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", { resultTruncated: true }),
      );
      expect(factAt(result, "result.stored")).toMatchObject({
        state: "verified",
        completeness: "partial",
      });
      expect(factAt(result, "result.content")).toMatchObject({
        state: "unverifiable",
        completeness: "partial",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a baseline manifest file entry outside the documented shape", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          baselineManifest: JSON.stringify(
            baselineManifestDoc({
              files: {
                "a.txt": { digest: "bogus", mode: 420, bytes: 5 },
                "b.txt": {
                  digest: "sha256:" + "1".repeat(64),
                  mode: -1,
                  bytes: 7,
                },
              },
            }),
          ),
        }),
      );
      expect(factAt(result, "baseline-manifest.record")).toMatchObject({
        state: "inconsistent",
        completeness: "complete",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a declared-partial patch as unverifiable completeness with partial evidence", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: seededTrace({
            patch: { base: "seeded", state: "partial" },
            diagnostics: ["patch: 1 oversized file(s) omitted"],
          }),
        }),
      );
      expect(factAt(result, "patch.record").state).toBe("verified");
      expect(factAt(result, "patch.completeness")).toMatchObject({
        state: "unverifiable",
        completeness: "partial",
      });
      expect(factAt(result, "seed.changes-patch")).toMatchObject({
        state: "verified",
        completeness: "partial",
      });
      expect(factAt(result, "changes.patch-agreement")).toMatchObject({
        state: "verified",
        completeness: "partial",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a patch base contradicting the seed record and leaves the patch uninterpretable", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: seededTrace({
            patch: { base: "empty", state: "complete" },
          }),
        }),
      );
      expect(factAt(result, "seed.patch-base").state).toBe("inconsistent");
      expect(factAt(result, "patch.interpretable")).toMatchObject({
        state: "unverifiable",
        completeness: "unknown",
      });
      // Facts that depend on parsing the patch stay unverifiable too.
      expect(factAt(result, "seed.changes-patch").state).toBe("unverifiable");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports an inputs_version contradicting the seed record as inconsistent", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: seededTrace({
            requested_cell: { digest: "sha256:cell", inputs_version: 1 },
          }),
        }),
      );
      expect(factAt(result, "seed.inputs-version")).toMatchObject({
        state: "inconsistent",
        completeness: "complete",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports divergent baseline digests as inconsistent", async () => {
    const base = tmp();
    try {
      const seed = seedDoc();
      (seed.baseline as Record<string, unknown>).materialized_digest =
        "sha256:other";
      const result = await audit(
        writeRun(base, "run", { trace: seededTrace({ seed }) }),
      );
      expect(factAt(result, "seed.baseline-materialization").state).toBe(
        "inconsistent",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a digest-mismatched patch: stored inconsistent, content checks unverifiable", async () => {
    const base = tmp();
    try {
      const changes = JSON.stringify(changesDoc());
      const result = await audit(
        writeRun(base, "run", {
          changes,
          manifest: {
            artifacts: [
              {
                path: "patch.diff",
                kind: "patch",
                digest: sha256("other bytes"),
              },
              {
                path: "result.txt",
                kind: "result",
                digest: sha256(RESULT_TEXT),
              },
              {
                path: "changes.json",
                kind: "file",
                digest: sha256(changes),
              },
            ],
          },
        }),
      );
      expect(factAt(result, "patch.stored")).toMatchObject({
        state: "inconsistent",
        completeness: "unknown",
      });
      expect(factAt(result, "patch.interpretable").state).toBe("unverifiable");
      expect(factAt(result, "patch.completeness").state).toBe("unverifiable");
      expect(factAt(result, "seed.changes-patch").state).toBe("unverifiable");
      expect(factAt(result, "changes.patch-agreement").state).toBe(
        "unverifiable",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a manifest-listed patch missing from disk as unverifiable", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "run");
      rmSync(join(runDir, "patch.diff"));
      const result = await audit(runDir);
      expect(factAt(result, "patch.stored")).toMatchObject({
        state: "unverifiable",
        completeness: "unknown",
      });
      expect(factAt(result, "patch.interpretable").state).toBe("unverifiable");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports verified but malformed patch bytes as inconsistent interpretable", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", { patch: "not a diff at all\n" }),
      );
      expect(factAt(result, "patch.stored").state).toBe("verified");
      expect(factAt(result, "patch.interpretable")).toMatchObject({
        state: "inconsistent",
      });
      expect(factAt(result, "seed.changes-patch").state).toBe("unverifiable");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports changes.json count disagreement with the trace as inconsistent", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          changes: JSON.stringify(changesDoc({ added: [] })),
        }),
      );
      expect(factAt(result, "changes.stored").state).toBe("verified");
      expect(factAt(result, "changes.record")).toMatchObject({
        state: "inconsistent",
        completeness: "complete",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports verified-but-non-JSON changes.json as inconsistent", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", { changes: "not json\n" }),
      );
      expect(factAt(result, "changes.record")).toMatchObject({
        state: "inconsistent",
      });
      expect(factAt(result, "changes.patch-agreement").state).toBe(
        "unverifiable",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a baseline-manifest field contradicting the seed as inconsistent", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          baselineManifest: JSON.stringify(
            baselineManifestDoc({ policy: "all-files" }),
          ),
        }),
      );
      expect(factAt(result, "baseline-manifest.record")).toMatchObject({
        state: "inconsistent",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a patch block missing from changes.json as inconsistent agreement", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          changes: JSON.stringify(changesDoc({ modified: ["src/other.ts"] })),
          trace: seededTrace(),
        }),
      );
      expect(factAt(result, "changes.record").state).toBe("verified");
      expect(factAt(result, "changes.patch-agreement")).toMatchObject({
        state: "inconsistent",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a published patch with no recorded change set as inconsistent", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: seededTrace({ seed: seedDoc(null) }),
          changes: null,
        }),
      );
      expect(factAt(result, "seed.changes-record").state).toBe("not-recorded");
      expect(factAt(result, "seed.changes-patch")).toMatchObject({
        state: "inconsistent",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps an omitted change set honest: not-recorded, never 'no changes'", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: seededTrace({
            seed: seedDoc(null),
            patch: { base: "seeded", state: "absent" },
          }),
          patch: null,
          changes: null,
        }),
      );
      expect(factAt(result, "seed.changes-record")).toMatchObject({
        state: "not-recorded",
        completeness: "unknown",
      });
      // patch.state 'absent' + no entry + omitted changes: consistent.
      expect(factAt(result, "patch.record").state).toBe("verified");
      expect(factAt(result, "seed.changes-patch").state).toBe("not-recorded");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports result availability: diagnostic plus absent entry agrees", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          result: null,
          trace: seededTrace({
            diagnostics: ["result: no final message emitted"],
          }),
        }),
      );
      expect(factAt(result, "result.stored").state).toBe("not-recorded");
      expect(factAt(result, "result.availability")).toMatchObject({
        state: "verified",
        completeness: "complete",
      });
      expect(factAt(result, "result.content").state).toBe("not-recorded");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a result entry plus a not-emitted diagnostic as inconsistent", async () => {
    const base = tmp();
    try {
      const result = await audit(
        writeRun(base, "run", {
          trace: seededTrace({
            diagnostics: ["result: no final message emitted"],
          }),
        }),
      );
      expect(factAt(result, "result.availability")).toMatchObject({
        state: "inconsistent",
        completeness: "complete",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports no result record at all as not-recorded", async () => {
    const base = tmp();
    try {
      const result = await audit(writeRun(base, "run", { result: null }));
      expect(factAt(result, "result.availability")).toMatchObject({
        state: "not-recorded",
        completeness: "unknown",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects manifest path escapes at the input boundary", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "run", {
        manifest: {
          artifacts: [
            {
              path: "../escape.txt",
              kind: "patch",
              digest: sha256("x"),
            },
          ],
        },
      });
      await expect(readAuditedRun(runDir)).rejects.toBeInstanceOf(
        PflExportError,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("audit-run check reports", () => {
  it("verifies matching subject bindings on a seeded run", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "run");
      const report = writeReport(base, "report.json", reportDoc());
      const result = await audit(runDir, [report]);
      const subject = report;
      expect(factAt(result, "check-report.shape", subject)).toMatchObject({
        state: "verified",
      });
      for (const id of [
        "check-report.task-binding",
        "check-report.baseline-binding",
        "check-report.patch-binding",
        "check-report.results",
      ])
        expect(factAt(result, id, subject).state, id).toBe("verified");
      expect(result.inputs.checkReports[0]).toMatchObject({
        state: "parsed",
        evaluatorId: "vitest",
        resultCount: 1,
      });
      const json = JSON.parse(formatJson(result));
      expect(validateAudit(json), JSON.stringify(validateAudit.errors)).toBe(
        true,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a mismatched declared task digest as inconsistent", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "run");
      const report = writeReport(
        base,
        "report.json",
        reportDoc({
          subject: { taskDigest: "sha256:other-task" },
        }),
      );
      const result = await audit(runDir, [report]);
      expect(factAt(result, "check-report.task-binding", report).state).toBe(
        "inconsistent",
      );
      // Omitted bindings stay not-recorded rather than failing.
      expect(
        factAt(result, "check-report.baseline-binding", report).state,
      ).toBe("not-recorded");
      expect(factAt(result, "check-report.patch-binding", report).state).toBe(
        "not-recorded",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves a declared patch digest unverifiable when the run has no patch", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "run", {
        patch: null,
        trace: seededTrace({
          patch: { base: "seeded", state: "absent" },
          diagnostics: ["patch: generation failed; patch.diff not recorded"],
        }),
      });
      const report = writeReport(base, "report.json", reportDoc());
      const result = await audit(runDir, [report]);
      expect(factAt(result, "check-report.patch-binding", report).state).toBe(
        "unverifiable",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps a truncated patch digest binding partial whether it matches or not", async () => {
    const base = tmp();
    try {
      const cut = seededPatch.slice(0, seededPatch.indexOf("+++ test/"));
      const runDir = writeRun(base, "run", {
        patch: cut,
        patchTruncated: true,
      });
      const match = writeReport(
        base,
        "match.json",
        reportDoc({
          subject: {
            taskDigest: "sha256:task-x",
            baselineDigest: BASELINE_DIGEST,
            patchDigest: sha256(cut),
          },
        }),
      );
      const mismatch = writeReport(
        base,
        "mismatch.json",
        reportDoc({
          subject: {
            taskDigest: "sha256:task-x",
            patchDigest: sha256("other bytes"),
          },
        }),
      );
      const result = await audit(runDir, [match, mismatch]);
      expect(factAt(result, "check-report.patch-binding", match)).toMatchObject(
        {
          state: "verified",
          completeness: "partial",
        },
      );
      expect(
        factAt(result, "check-report.patch-binding", mismatch),
      ).toMatchObject({
        state: "inconsistent",
        completeness: "partial",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a malformed report: shape inconsistent, bindings unverifiable", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "run");
      const report = writeReport(base, "report.json", '{"bogus": true}');
      const result = await audit(runDir, [report]);
      expect(factAt(result, "check-report.shape", report).state).toBe(
        "inconsistent",
      );
      expect(factAt(result, "check-report.task-binding", report).state).toBe(
        "unverifiable",
      );
      expect(result.inputs.checkReports[0].state).toBe("invalid");
      expect(result.inputs.checkReports[0].error).toBeTruthy();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a baseline digest declared for a legacy run as inconsistent", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "run", {
        trace: legacyTrace(),
        patch: legacyPatch,
        baselineManifest: null,
        changes: null,
      });
      const report = writeReport(
        base,
        "report.json",
        reportDoc({
          subject: {
            taskDigest: "sha256:task-x",
            baselineDigest: BASELINE_DIGEST,
            patchDigest: sha256(legacyPatch),
          },
        }),
      );
      const result = await audit(runDir, [report]);
      expect(
        factAt(result, "check-report.baseline-binding", report).state,
      ).toBe("inconsistent");
      expect(factAt(result, "check-report.patch-binding", report).state).toBe(
        "verified",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("preserves duplicate result rows: identical as limitation, conflicting as inconsistent", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "run");
      const identical = writeReport(
        base,
        "dup.json",
        reportDoc({
          results: [
            { criterionId: "unit-tests", verdict: "pass" },
            { criterionId: "unit-tests", verdict: "pass" },
          ],
        }),
      );
      const conflicting = writeReport(
        base,
        "conflict.json",
        reportDoc({
          results: [
            { criterionId: "unit-tests", verdict: "pass" },
            { criterionId: "unit-tests", verdict: "fail" },
          ],
        }),
      );
      const result = await audit(runDir, [identical, conflicting]);
      expect(factAt(result, "check-report.results", identical).state).toBe(
        "verified",
      );
      expect(
        factAt(result, "check-report.results", identical).reason,
      ).toContain("duplicate");
      expect(factAt(result, "check-report.results", conflicting).state).toBe(
        "inconsistent",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("emits per-report facts in argument order with the report label as subject", async () => {
    const base = tmp();
    try {
      const runDir = writeRun(base, "run");
      const a = writeReport(base, "a.json", reportDoc());
      const b = writeReport(
        base,
        "b.json",
        reportDoc({ evaluator: { id: "jest", version: "29.0.0" } }),
      );
      const result = await audit(runDir, [a, b]);
      const reportFacts = result.facts.filter((f) =>
        f.id.startsWith("check-report."),
      );
      expect(reportFacts.map((f) => f.subject)).toEqual([
        a,
        a,
        a,
        a,
        a,
        b,
        b,
        b,
        b,
        b,
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("audit-run output", () => {
  it("emits human output free of verdict/rubric vocabulary", async () => {
    const base = tmp();
    try {
      const result = await audit(writeRun(base, "run"));
      const text = formatAuditHuman(result);
      expect(text).toContain("patch.stored: verified; complete");
      expect(text).toContain("evidence:");
      for (const word of ["pass]", "fail]", "score", "criterion", "verdict"])
        expect(text).not.toContain(word);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never turns a partial patch into a negative assertion about absent files", async () => {
    const base = tmp();
    try {
      // Partial patch covering only the modified file.
      const partial =
        "--- src/auth.ts\n+++ src/auth.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n";
      const result = await audit(
        writeRun(base, "run", {
          patch: partial,
          trace: seededTrace({
            patch: { base: "seeded", state: "partial" },
          }),
        }),
      );
      const agreement = factAt(result, "changes.patch-agreement");
      expect(agreement.state).toBe("verified");
      expect(agreement.completeness).toBe("partial");
      expect(agreement.reason).toContain("subset");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
