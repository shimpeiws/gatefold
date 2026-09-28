import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PflExportError } from "../src/input/pfl-export.js";
import {
  parseYuureiTrace,
  readYuureiTrace,
  readYuureiTraceStdin,
  TRACE_SCHEMA_VERSION,
} from "../src/input/yuurei-trace.js";

const dir = new URL("fixtures/yuurei-trace/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));

const VALID = [
  "valid-trace.json",
  "valid-trace-older.json",
  "valid-trace-model-unobserved.json",
  "valid-trace-execution-nulls.json",
  "valid-trace-usage-mixed.json",
  "valid-trace-unknown-fields.json",
];

/** A minimal document carrying every required field and nothing else. */
function validDoc(): Record<string, any> {
  return {
    schema_version: "0.3",
    run_id: "run-t",
    started_at: "2026-09-20T10:00:00Z",
    finished_at: "2026-09-20T10:00:01Z",
    runtime: { id: "claude-code", version: null },
    model: { requested: "m", resolved: null },
    profile: { name: "p", digest: "sha256:p" },
    task: { source: "t.md", digest: "sha256:t" },
    isolation: { strategy: "cell", verified: true },
    execution: {
      exit_code: 0,
      signal: null,
      duration_ms: 100,
      timed_out: false,
    },
    usage: {},
    cost: null,
    artifacts: [],
  };
}

async function* streamOf(chunks: (string | Buffer)[]) {
  for (const chunk of chunks) yield chunk;
}

describe("yuurei trace reader contract", () => {
  it("loads every valid fixture as typed data", async () => {
    for (const name of VALID) {
      const trace = await readYuureiTrace(fixture(name));
      expect(trace.schemaVersion, name).toBe(TRACE_SCHEMA_VERSION);
      expect(trace.runId, name).toBeTruthy();
      expect(Array.isArray(trace.artifacts), name).toBe(true);
      expect(trace.document, name).toBeDefined();
    }
  });

  it("exposes every optional field on the full fixture", async () => {
    const trace = await readYuureiTrace(fixture("valid-trace.json"));
    expect(trace.yuureiVersion).toBe("0.3.0");
    expect(trace.requestedCell).toEqual({
      digest: "sha256:cell-a",
      inputsVersion: 1,
    });
    expect(trace.executionOptions).toEqual({
      timeoutMs: 600000,
      runtime: { max_turns: 40, sandbox: "seatbelt" },
    });
    expect(trace.definition).toEqual({
      run: "nightly",
      cliOverrides: ["model"],
    });
    expect(trace.model.resolvedReason).toBe("observed");
    expect(trace.cost).toEqual({ amount: 0.42, currency: "USD" });
  });

  it("keeps absent optional fields undefined on the older-trace shape", async () => {
    const trace = await readYuureiTrace(fixture("valid-trace-older.json"));
    expect(trace.yuureiVersion).toBeUndefined();
    expect(trace.requestedCell).toBeUndefined();
    expect(trace.executionOptions).toBeUndefined();
    expect(trace.definition).toBeUndefined();
    // Present-but-null stays null: unobserved, not absent.
    expect(trace.runtime.version).toBeNull();
    expect(trace.model.resolved).toBeNull();
    expect(trace.model.resolvedReason).toBeUndefined();
    expect(trace.cost).toBeNull();
  });

  it("keeps usage absent/null/observed keys distinct", async () => {
    const trace = await readYuureiTrace(
      fixture("valid-trace-usage-mixed.json"),
    );
    expect(trace.usage.input_tokens).toBe(3100);
    expect(trace.usage.output_tokens).toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(trace.usage, "output_tokens"),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(trace.usage, "cache_read_tokens"),
    ).toBe(false);
  });

  it("records execution nulls and timeout without inventing values", async () => {
    const trace = await readYuureiTrace(
      fixture("valid-trace-execution-nulls.json"),
    );
    expect(trace.execution).toEqual({
      exitCode: null,
      signal: "SIGKILL",
      durationMs: 600000,
      timedOut: true,
    });
  });

  it("ignores unknown additive fields", async () => {
    const trace = await readYuureiTrace(
      fixture("valid-trace-unknown-fields.json"),
    );
    expect(trace.runId).toBe("run-f1");
    expect((trace as Record<string, unknown>).level).toBeUndefined();
  });

  it("accepts an empty model.requested as a recorded absent request", () => {
    // yuurei's `run` CLI defaults the field to '' when neither --model nor the
    // run definition supplies one, so a shipped trace records an empty
    // request. It is a value, not a missing field or a malformed one.
    const doc = validDoc();
    doc.model.requested = "";
    const trace = parseYuureiTrace(doc, "x.json");
    expect(trace.model.requested).toBe("");
    // the empty value is still capped and still must be a string
    const wrongType = validDoc();
    wrongType.model.requested = null;
    expect(() => parseYuureiTrace(wrongType, "x.json")).toThrow(PflExportError);
  });

  it.each([
    [
      "wrong-schema-version.json",
      "unsupported-version",
      "unsupported trace schema_version",
    ],
    ["missing-required.json", "invalid-shape", "execution"],
    ["invalid-usage.json", "invalid-shape", "usage.input_tokens"],
    ["non-object.json", "invalid-shape", "top level"],
    ["malformed.json", "invalid-json", "not valid JSON"],
  ])("rejects %s with code %s", async (name, code, messagePart) => {
    const error = await readYuureiTrace(fixture(name)).catch((e) => e);
    expect(error).toBeInstanceOf(PflExportError);
    expect((error as PflExportError).code).toBe(code);
    expect((error as PflExportError).message).toContain(messagePart);
  });

  it("rejects a pfl document as a kind mismatch", () => {
    for (const doc of [
      { pflVersion: "1.0.0", command: "export", ok: true, data: {} },
      { pflVersion: "1.0.0", command: "report", ok: true, data: {} },
      { pflVersion: "1.0.0", command: "diff", ok: true, data: {} },
      { pflVersion: "1.0.0" },
    ]) {
      const error = (() => {
        try {
          parseYuureiTrace(doc, "x.json");
          return null;
        } catch (e) {
          return e;
        }
      })() as PflExportError;
      expect(error).toBeInstanceOf(PflExportError);
      expect(error.code).toBe("mismatched-inputs");
      expect(error.message).toContain("yuurei trace");
    }
    const exportError = (() => {
      try {
        parseYuureiTrace(
          { pflVersion: "1.0.0", command: "export", ok: true, data: {} },
          "x.json",
        );
      } catch (e) {
        return e;
      }
    })() as PflExportError;
    expect(exportError.message).toContain("pfl export");
  });

  it("rejects malformed required-field shapes deterministically", () => {
    for (const [mutate, part] of [
      [(d: any) => delete d.run_id, "run_id"],
      [(d: any) => (d.runtime = "x"), "runtime"],
      [(d: any) => (d.model.requested = 5), "model.requested"],
      [(d: any) => delete d.model.resolved, "model.resolved"],
      [(d: any) => (d.isolation.verified = "yes"), "isolation.verified"],
      [(d: any) => (d.execution.timed_out = "no"), "execution.timed_out"],
      [(d: any) => delete d.execution.exit_code, "execution.exit_code"],
      [(d: any) => delete d.cost, "cost"],
      [(d: any) => (d.artifacts = {}), "artifacts"],
      [(d: any) => (d.schema_version = ""), "schema_version"],
      [(d: any) => (d.schema_version = 3), "schema_version"],
    ] as const) {
      const doc = validDoc();
      mutate(doc);
      const error = (() => {
        try {
          parseYuureiTrace(doc, "x.json");
          return null;
        } catch (e) {
          return e;
        }
      })() as PflExportError;
      expect(error, part).toBeInstanceOf(PflExportError);
      expect(error.code, part).toBe("invalid-shape");
      expect(error.message, part).toContain(part);
    }
  });

  it("accepts each resolved_reason variant and rejects bogus ones", () => {
    for (const reason of ["observed", "unobserved", "parse_failed"]) {
      const doc = validDoc();
      doc.model.resolved_reason = reason;
      expect(parseYuureiTrace(doc, "x.json").model.resolvedReason).toBe(reason);
    }
    const doc = validDoc();
    doc.model.resolved_reason = "guessed";
    expect(() => parseYuureiTrace(doc, "x.json")).toThrow(
      "model.resolved_reason",
    );
    const nullReason = validDoc();
    nullReason.model.resolved_reason = null;
    expect(() => parseYuureiTrace(nullReason, "x.json")).toThrow(
      "model.resolved_reason",
    );
  });

  it("enforces the trace resource ceilings", () => {
    const expectLimit = (mutate: (d: any) => void, part: string) => {
      const doc = validDoc();
      mutate(doc);
      const error = (() => {
        try {
          parseYuureiTrace(doc, "x.json");
          return null;
        } catch (e) {
          return e;
        }
      })() as PflExportError;
      expect(error, part).toBeInstanceOf(PflExportError);
      expect(error.code, part).toBe("invalid-shape");
      expect(error.message, part).toContain(part);
    };
    expectLimit((d) => {
      d.usage = Object.fromEntries(
        Array.from({ length: 1001 }, (_, i) => [`k${i}`, 1]),
      );
    }, "usage");
    expectLimit((d) => {
      d.artifacts = Array.from({ length: 10001 }, (_, i) => ({
        path: `p${i}`,
        kind: "k",
      }));
    }, "artifacts");
    expectLimit((d) => {
      d.diagnostics = Array.from({ length: 10001 }, (_, i) => `d${i}`);
    }, "diagnostics");
    expectLimit((d) => {
      d.definition = {
        run: null,
        cli_overrides: Array.from({ length: 1001 }, (_, i) => `f${i}`),
      };
    }, "definition.cli_overrides");
    expectLimit((d) => {
      d.execution_options = {
        timeout_ms: 1,
        runtime: Object.fromEntries(
          Array.from({ length: 1001 }, (_, i) => [`k${i}`, 1]),
        ),
      };
    }, "execution_options.runtime");
    expectLimit((d) => {
      let nested: any = { leaf: 1 };
      for (let i = 0; i < 15; i += 1) nested = { next: nested };
      d.execution_options = { timeout_ms: 1, runtime: nested };
    }, "execution_options.runtime");
    expectLimit((d) => {
      d.run_id = "x".repeat(4097);
    }, "run_id");
    expectLimit((d) => {
      d.execution_options = { timeout_ms: 1.5, runtime: {} };
    }, "execution_options.timeout_ms");
    expectLimit((d) => {
      d.requested_cell = { digest: "x", inputs_version: 1.5 };
    }, "requested_cell.inputs_version");
    expectLimit((d) => {
      d.cost = { amount: "0.5", currency: "USD" };
    }, "cost.amount");
  });

  it("rejects an unreadable file", async () => {
    const error = await readYuureiTrace(fixture("does-not-exist.json")).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(PflExportError);
    expect((error as PflExportError).code).toBe("unreadable-file");
    expect((error as PflExportError).message).toContain("cannot read");
  });

  it("reads a trace from stdin with the <stdin> label and BOM handling", async () => {
    const trace = await readYuureiTraceStdin(
      streamOf(["﻿" + JSON.stringify(validDoc())]),
    );
    expect(trace.sourcePath).toBe("<stdin>");
    expect(trace.runId).toBe("run-t");
  });

  it("rejects oversized stdin under the byte ceiling", async () => {
    const big = Buffer.alloc(17 * 1024 * 1024, 0x20);
    const error = await readYuureiTraceStdin(streamOf([big])).catch((e) => e);
    expect(error).toBeInstanceOf(PflExportError);
    expect((error as PflExportError).code).toBe("invalid-shape");
    expect((error as PflExportError).message).toContain("byte limit");
  });

  it("rejects an oversized regular file before reading it", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "gatefold-trace-big-"));
    try {
      const path = join(tmp, "big.json");
      await writeFile(path, Buffer.alloc(17 * 1024 * 1024, 0x20));
      const error = await readYuureiTrace(path).catch((e) => e);
      expect(error).toBeInstanceOf(PflExportError);
      expect((error as PflExportError).code).toBe("invalid-shape");
      expect((error as PflExportError).message).toContain("byte limit");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("sanitizes hostile strings in the recorded source path", () => {
    const trace = parseYuureiTrace(validDoc(), "bad\tpath.json");
    expect(trace.sourcePath).toBe("bad\\u0009path.json");
  });
});
