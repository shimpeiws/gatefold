import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { compareTraces } from "../src/application/compare-traces.js";
import { runCli, EXIT_INPUT, EXIT_USAGE } from "../src/cli.js";
import type {
  TraceComparisonResult,
  TraceEvidenceReference,
} from "../src/domain/trace-comparison.js";
import { PflExportError } from "../src/input/pfl-export.js";
import {
  parseYuureiTrace,
  readYuureiTrace,
} from "../src/input/yuurei-trace.js";

const dir = new URL("fixtures/compare-traces/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));

const traceA = fixture("a.json");
const traceB = fixture("b.json");

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schema/claim-result.v4.json", import.meta.url)),
    "utf8",
  ),
);
const ajv = new Ajv2020();
const validate = ajv.compile(schema);

function compareDocs(before: unknown, after: unknown): TraceComparisonResult {
  return compareTraces({
    before: parseYuureiTrace(before, "before.json"),
    after: parseYuureiTrace(after, "after.json"),
  });
}

function docA(): unknown {
  return JSON.parse(readFileSync(traceA, "utf8"));
}
function docB(): unknown {
  return JSON.parse(readFileSync(traceB, "utf8"));
}

function claimsOf(
  result: TraceComparisonResult,
  ruleId: string,
): readonly { claim: string; evidence: readonly TraceEvidenceReference[] }[] {
  return result.claims.filter((claim) => claim.ruleId === ruleId);
}

/** Independent RFC 6901 resolver used to double-check emitted pointers. */
function resolve(document: unknown, pointer: string): unknown {
  let current: unknown = document;
  for (const segment of pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (Array.isArray(current)) {
      expect(segment).toMatch(/^\d+$/);
      current = current[Number(segment)];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error(`pointer '${pointer}' does not resolve`);
    }
  }
  return current;
}

function assertPointersResolve(result: TraceComparisonResult): void {
  const before = JSON.parse(readFileSync(traceA, "utf8"));
  const after = JSON.parse(readFileSync(traceB, "utf8"));
  for (const claim of result.claims)
    for (const evidence of claim.evidence) {
      const doc = evidence.source === "beforeTrace" ? before : after;
      expect(
        () => resolve(doc, evidence.pointer),
        `${claim.ruleId} ${evidence.source}:${evidence.pointer}`,
      ).not.toThrow();
    }
}

describe("gatefold compare-traces", () => {
  it("produces a schema-v4 result for a comparable pair", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
    });
    expect(result.schemaVersion).toBe(4);
    expect(result.source).toEqual({ command: "compare-traces" });
    expect(validate(result), JSON.stringify(validate.errors, null, 2)).toBe(
      true,
    );
    const ruleIds = new Set(result.claims.map((claim) => claim.ruleId));
    for (const ruleId of [
      "trace-inputs",
      "trace-profiles",
      "trace-runtime",
      "trace-model",
      "trace-execution",
      "trace-duration",
      "trace-usage",
      "trace-cost",
    ])
      expect(ruleIds, ruleId).toContain(ruleId);
    assertPointersResolve(result);
  });

  it("records both input descriptors verbatim in inputs", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
      labels: { before: "a.json", after: "b.json" },
    });
    const before = result.inputs.beforeTrace;
    expect(before).toMatchObject({
      label: "a.json",
      document: "yuurei-trace",
      schemaVersion: "0.3",
      runId: "run-a1",
      yuureiVersion: "0.3.0",
      runtimeId: "claude-code",
      runtimeVersion: "2.1.272",
      modelRequested: "claude-sonnet-4-5",
      modelResolved: "claude-sonnet-4-5-20250929",
      modelResolvedReason: "observed",
      profileName: "baseline",
      profileDigest: "sha256:aaa",
      taskDigest: "sha256:task1",
      isolationStrategy: "cell",
      isolationVerified: true,
      requestedCellDigest: "sha256:cell-a",
      requestedCellInputsVersion: 1,
      executionOptions: {
        timeout_ms: 600000,
        runtime: { max_turns: 40 },
      },
      definition: { run: "nightly", cli_overrides: ["model"] },
    });
    expect(result.inputs.afterTrace.profileName).toBe("variant");
  });

  it("describes the profile difference as the compared variable", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
    });
    const [profile] = claimsOf(result, "trace-profiles");
    expect(profile.claim).toContain("profile 'baseline'");
    expect(profile.claim).toContain("profile 'variant'");
    expect(profile.claim).toContain("requested-cell digests differ");
  });

  it("states the per-run outcome without equating it to quality", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
    });
    const [execution] = claimsOf(result, "trace-execution");
    // All three required execution fields are stated on each side.
    expect(execution.claim).toContain("run A was not timed out, exited 0");
    expect(execution.claim).toContain("run B was not timed out, exited 0");
    expect(execution.claim).toContain("recorded no signal (unobserved)");
    expect(execution.claim).toContain("not answer quality");
  });

  it("reports signal and timeout for a killed run", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(fixture("b-timeout.json")),
    });
    const [execution] = claimsOf(result, "trace-execution");
    expect(execution.claim).toContain("run B timed out");
    expect(execution.claim).toContain("'SIGKILL'");
    expect(execution.claim).not.toContain("B exited");
    // `signal` is a required key present in every trace, so both sides cite
    // it even when the value is null.
    const signalRefs = execution.evidence.filter(
      (e) => e.pointer === "/execution/signal",
    );
    expect(signalRefs.map((e) => e.source)).toEqual([
      "beforeTrace",
      "afterTrace",
    ]);
  });

  it("compares duration only when both sides record it", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
    });
    const [duration] = claimsOf(result, "trace-duration");
    expect(duration.claim).toContain("12,400 ms");
    expect(duration.claim).toContain("41,800 ms");
    expect(duration.claim).toContain("29,400 ms");

    const mutated = docB() as Record<string, any>;
    mutated.execution.duration_ms = null;
    const partial = compareDocs(docA(), mutated);
    const [one] = claimsOf(partial, "trace-duration");
    expect(one.claim).toContain("run B did not record a duration");
    expect(one.claim).toContain("no difference is computed");
  });

  it("compares usage only on shared numeric keys, keeping absent/null distinct", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
    });
    const usage = claimsOf(result, "trace-usage");
    const byKey = (key: string) =>
      usage.filter((claim) => claim.claim.includes(`'${key}'`));
    // Shared numeric keys: a difference is computed.
    expect(byKey("input_tokens")[0].claim).toContain("3,200");
    expect(byKey("output_tokens")[0].claim).toContain("1,430");
    // A-only numeric key: reported, no comparison.
    const cache = byKey("cache_read_tokens")[0];
    expect(cache.claim).toContain("never attempted");
    expect(
      cache.evidence.find((e) => e.source === "afterTrace")!.note,
    ).toContain("cache_read_tokens");
    // null on A, numeric on B: no difference.
    const scratch = byKey("scratchpad_reads")[0];
    expect(scratch.claim).toContain("unobserved");
    expect(scratch.claim).toContain("no difference is computed");
  });

  it("compares cost only when currencies match and labels it an estimate", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
    });
    const [cost] = claimsOf(result, "trace-cost");
    expect(cost.claim).toContain("estimated cost of 0.42 USD");
    expect(cost.claim).toContain("0.91 USD");
    expect(cost.claim).toContain("estimates");

    const mismatched = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(fixture("b-currency-mismatch.json")),
    });
    const [noDelta] = claimsOf(mismatched, "trace-cost");
    expect(noDelta.claim).toContain("currencies differ");
    expect(noDelta.claim).toContain("no numeric difference");

    const nullCost = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(fixture("b-cost-null.json")),
    });
    const [oneSide] = claimsOf(nullCost, "trace-cost");
    expect(oneSide.claim).toContain("no cost estimate");
    expect(
      oneSide.evidence.find(
        (e) => e.source === "afterTrace" && e.pointer === "/cost",
      )!.note,
    ).toBe("no cost estimate");
  });

  it("describes unobserved resolved models without inventing them", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(fixture("b-resolved-null.json")),
    });
    const [model] = claimsOf(result, "trace-model");
    expect(model.claim).toContain("run B did not observe");
    expect(model.claim).toContain("'unobserved'");
    expect(
      model.evidence.some(
        (e) =>
          e.source === "afterTrace" && e.pointer === "/model/resolved_reason",
      ),
    ).toBe(true);
  });

  it("emits one caveat claim per observed-identity drift", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(fixture("b-drift.json")),
    });
    const caveats = claimsOf(result, "trace-comparability").map((c) =>
      c.claim.replace("Comparability caveat: ", ""),
    );
    expect(caveats.length).toBe(4);
    expect(caveats.join("\n")).toContain("yuurei version");
    expect(caveats.join("\n")).toContain("runtime versions differ");
    expect(caveats.join("\n")).toContain("resolved models differ");
    expect(caveats.join("\n")).toContain("isolation verification");
    for (const claim of claimsOf(result, "trace-comparability"))
      expect(claim.evidence.length).toBeGreaterThan(0);
  });

  it("accepts an older trace with caveats for the missing optional fields", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(fixture("a-older.json")),
      after: await readYuureiTrace(traceB),
    });
    const caveats = claimsOf(result, "trace-comparability").map(
      (claim) => claim.claim,
    );
    expect(caveats.join("\n")).toContain("requested_cell");
    expect(caveats.join("\n")).toContain("execution_options");
    // The missing optional fields cite the root with a note.
    const rootNotes = new Set(
      result.claims
        .flatMap((claim) => claim.evidence)
        .filter((e) => e.pointer === "")
        .map((e) => e.note),
    );
    expect(rootNotes).toEqual(
      new Set(["no requested_cell field", "no execution_options field"]),
    );
  });

  it.each([
    [
      "task.digest",
      (doc: any) => {
        doc.task.digest = "sha256:other";
      },
      "task.digest",
    ],
    [
      "runtime.id",
      (doc: any) => {
        doc.runtime.id = "codex";
      },
      "runtime.id",
    ],
    [
      "model.requested",
      (doc: any) => {
        doc.model.requested = "claude-opus-4-1";
      },
      "model.requested",
    ],
    [
      "isolation.strategy",
      (doc: any) => {
        doc.isolation.strategy = "none";
      },
      "isolation.strategy",
    ],
    [
      "requested_cell.inputs_version",
      (doc: any) => {
        doc.requested_cell.inputs_version = 2;
      },
      "inputs_version",
    ],
    [
      "execution_options.timeout_ms",
      (doc: any) => {
        doc.execution_options.timeout_ms = 300000;
      },
      "timeout_ms",
    ],
    [
      "execution_options.runtime",
      (doc: any) => {
        doc.execution_options.runtime.max_turns = 41;
      },
      "execution_options.runtime",
    ],
    [
      "execution_options.timeout_ms null-vs-value",
      (doc: any) => {
        doc.execution_options.timeout_ms = null;
      },
      "timeout_ms",
    ],
  ])(
    "rejects a clear mismatch in %s before emitting claims",
    (_name, mutate, part) => {
      const b = docB() as Record<string, any>;
      mutate(b);
      const error = (() => {
        try {
          compareDocs(docA(), b);
          return null;
        } catch (e) {
          return e;
        }
      })() as PflExportError;
      expect(error).toBeInstanceOf(PflExportError);
      expect(error.code).toBe("mismatched-inputs");
      expect(error.message).toContain(part);
    },
  );

  it("states an empty requested model as no model requested", () => {
    // yuurei records model.requested as '' when no model was requested. Both
    // sides carry the same recorded value, so the pair stays comparable and
    // the statements name the absent request instead of quoting a model ''.
    const a = docA() as Record<string, any>;
    const b = docB() as Record<string, any>;
    a.model.requested = "";
    b.model.requested = "";
    const result = compareDocs(a, b);
    const inputs = claimsOf(result, "trace-inputs")[0]!;
    expect(inputs.claim).toContain(
      "no model (model.requested is empty on both)",
    );
    expect(inputs.claim).not.toContain("model ''");
    const model = claimsOf(result, "trace-model")[0]!;
    expect(model.claim).toContain("requested no model");
    expect(model.claim).not.toContain("model ''");
    // the evidence pointers still resolve to the recorded field
    expect(model.evidence.map((e) => `${e.source}:${e.pointer}`)).toContain(
      "beforeTrace:/model/requested",
    );
  });

  it("names an absent request when one side records an empty model", () => {
    const b = docB() as Record<string, any>;
    b.model.requested = "";
    const error = (() => {
      try {
        compareDocs(docA(), b);
        return null;
      } catch (e) {
        return e;
      }
    })() as PflExportError;
    expect(error.code).toBe("mismatched-inputs");
    expect(error.message).toContain("model.requested");
    // the empty side is described, not rendered as a pair of quotes
    expect(error.message).toContain("none (an empty string)");
  });

  it("rejects a task-mismatched fixture pair", async () => {
    await expect(
      Promise.resolve().then(() =>
        compareTraces({
          before: parseYuureiTrace(docA(), "a.json"),
          after: parseYuureiTrace(
            JSON.parse(readFileSync(fixture("b-task-mismatch.json"), "utf8")),
            "b-task-mismatch.json",
          ),
        }),
      ),
    ).rejects.toMatchObject({ code: "mismatched-inputs" });
  });

  it("treats identical non-profile fields with equal caveats in both directions", async () => {
    const forward = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(fixture("b-drift.json")),
    });
    const reverse = compareTraces({
      before: await readYuureiTrace(fixture("b-drift.json")),
      after: await readYuureiTrace(traceA),
    });
    expect(forward.claims.length).toBe(reverse.claims.length);
    expect(claimsOf(forward, "trace-comparability").length).toBe(
      claimsOf(reverse, "trace-comparability").length,
    );
  });

  it("produces identical output for identical inputs and usage-key reordering", async () => {
    const first = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
    });
    const reorderedB = docB() as Record<string, any>;
    reorderedB.usage = {
      output_tokens: reorderedB.usage.output_tokens,
      input_tokens: reorderedB.usage.input_tokens,
      scratchpad_reads: reorderedB.usage.scratchpad_reads,
    };
    const second = compareDocs(docA(), reorderedB);
    // Claims are label-independent; inputs differ only in the label.
    expect(second.claims).toEqual(first.claims);
    const again = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
    });
    expect(again).toEqual(first);
  });

  it("quotes diagnostics verbatim as per-run claims", async () => {
    const result = compareTraces({
      before: await readYuureiTrace(traceA),
      after: await readYuureiTrace(traceB),
    });
    const diagnostics = claimsOf(result, "trace-diagnostic");
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].claim).toContain("'stdout.log omitted by adapter'");
    expect(diagnostics[0].claim).toContain("Run B");
  });

  it("sanitizes hostile claim content from untrusted trace strings", async () => {
    const b = docB() as Record<string, any>;
    b.diagnostics = ["line1\nline2\u200bwith zero width"];
    const result = compareDocs(docA(), b);
    const [diagnostic] = claimsOf(result, "trace-diagnostic");
    expect(diagnostic.claim).not.toContain("\n");
    expect(diagnostic.claim).not.toContain("\u200b");
    expect(diagnostic.claim).toContain("\\u000a");
  });
});

describe("gatefold compare-traces CLI", () => {
  it("returns schema-v4 JSON for a comparable pair", async () => {
    const parsed = JSON.parse(
      await runCli([
        "compare-traces",
        "--before",
        traceA,
        "--after",
        traceB,
        "--format",
        "json",
      ]),
    );
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true);
    expect(parsed.inputs.beforeTrace.label).toBe(traceA);
    expect(parsed.inputs.afterTrace.label).toBe(traceB);
  });

  it("accepts flags before the subcommand and --flag=value", async () => {
    const parsed = JSON.parse(
      await runCli([
        "--format=json",
        "compare-traces",
        `--before=${traceA}`,
        `--after=${traceB}`,
      ]),
    );
    expect(parsed.schemaVersion).toBe(4);
  });

  it("renders human output with source-tagged evidence", async () => {
    const output = await runCli([
      "compare-traces",
      "--before",
      traceA,
      "--after",
      traceB,
    ]);
    expect(output).toContain("compare-traces → rule:trace-inputs");
    expect(output).toContain("beforeTrace:/run_id");
    expect(output).toContain("afterTrace:/run_id");
    expect(output).toContain("confidence: 1.00");
  });

  it("rejects missing or duplicated flags as usage errors", async () => {
    for (const args of [
      ["compare-traces"],
      ["compare-traces", "--before", traceA],
      ["compare-traces", "--after", traceB],
      [
        "compare-traces",
        "--before",
        traceA,
        "--after",
        traceB,
        "--before",
        traceA,
      ],
    ])
      await expect(runCli(args)).rejects.toMatchObject({
        exitCode: EXIT_USAGE,
      });
  });

  it("rejects positional inputs, a third trace flag, and two stdin inputs", async () => {
    for (const args of [
      ["compare-traces", "--before", traceA, "--after", traceB, "extra.json"],
      [
        "compare-traces",
        "--before",
        traceA,
        "--after",
        traceB,
        "--diff",
        traceA,
      ],
      ["compare-traces", "--before", "-", "--after", "-"],
    ])
      await expect(runCli(args)).rejects.toMatchObject({
        exitCode: EXIT_USAGE,
      });
  });

  it("maps a mismatched pair to the input error exit code", async () => {
    await expect(
      runCli([
        "compare-traces",
        "--before",
        traceA,
        "--after",
        fixture("b-task-mismatch.json"),
      ]),
    ).rejects.toMatchObject({ code: "mismatched-inputs" });
    expect(EXIT_INPUT).toBe(3);
  });

  it("rejects a pfl document fed to compare-traces as an input error", async () => {
    const pfl = fileURLToPath(
      new URL("fixtures/pfl-export/valid-report.json", import.meta.url),
    );
    await expect(
      runCli(["compare-traces", "--before", pfl, "--after", traceB]),
    ).rejects.toMatchObject({ code: "mismatched-inputs" });
  });

  it("keeps the compare-traces name usable for a file after --", async () => {
    // After --, 'compare-traces' is a positional filename, so it reaches the
    // pfl reader as an unreadable file rather than parsing as a subcommand.
    await expect(runCli(["--", "compare-traces"])).rejects.toMatchObject({
      code: "unreadable-file",
    });
  });
});

describe("gatefold compare-traces review regressions", () => {
  it("quotes fractional usage values and their difference without rounding to zero", () => {
    const before = docA() as any;
    const after = docB() as any;
    before.usage = { latency: 0.0004 };
    after.usage = { latency: 0.0008 };
    const [usage] = claimsOf(compareDocs(before, after), "trace-usage");
    expect(usage.claim).toContain("0.0004");
    expect(usage.claim).toContain("0.0008");
    expect(usage.claim).toContain("difference of 0.0004");
    expect(usage.claim).not.toContain("recorded 0 for");
  });

  it("keeps a nonzero estimated cost difference below the six-decimal threshold", () => {
    const before = docA() as any;
    const after = docB() as any;
    before.cost = { amount: 0.0000001, currency: "USD" };
    after.cost = { amount: 0.0000002, currency: "USD" };
    const [cost] = claimsOf(compareDocs(before, after), "trace-cost");
    expect(cost.claim).toContain("0.0000001 USD");
    expect(cost.claim).toContain("0.0000002 USD");
    expect(cost.claim).toContain("difference of 0.0000001 USD");
  });

  it("does not explain a requested-cell digest difference by identical profiles", () => {
    const before = docA() as any;
    const after = docB() as any;
    after.profile = { ...before.profile };
    after.requested_cell = { ...after.requested_cell, digest: "sha256:cell-z" };
    const [profile] = claimsOf(compareDocs(before, after), "trace-profiles");
    expect(profile.claim).toContain("requested-cell digests differ");
    expect(profile.claim).toContain("profile contents are identical");
    expect(profile.claim).not.toContain(
      "consistent with the differing profile contents",
    );
  });

  it("attributes a requested-cell digest difference to differing profiles", () => {
    const before = docA() as any;
    const after = docB() as any;
    const [profile] = claimsOf(compareDocs(before, after), "trace-profiles");
    expect(profile.claim).toContain(
      "consistent with the differing profile contents",
    );
  });

  it("reports a recorded signal beside a recorded exit code", () => {
    const before = docA() as any;
    const after = docB() as any;
    after.execution = {
      exit_code: 137,
      signal: "SIGKILL",
      duration_ms: 41800,
      timed_out: true,
    };
    const [execution] = claimsOf(compareDocs(before, after), "trace-execution");
    expect(execution.claim).toContain("exited 137");
    expect(execution.claim).toContain("'SIGKILL'");
    expect(execution.claim).toContain("timed out");
    expect(execution.claim).not.toContain("recorded no exit code");
  });

  it("describes null resolved models and null runtime versions as unobserved", () => {
    const before = docA() as any;
    const after = docB() as any;
    delete after.model.resolved_reason;
    after.model.resolved = null;
    after.runtime = { id: "claude-code", version: null };
    const result = compareDocs(before, after);
    const [model] = claimsOf(result, "trace-model");
    const [runtime] = claimsOf(result, "trace-runtime");
    expect(model.claim).toContain("did not observe the effective model");
    expect(model.claim).not.toContain("did not record");
    expect(runtime.claim).toContain(
      "recorded the runtime version as unobserved",
    );
    expect(runtime.claim).not.toContain("did not record");
  });

  it("quotes a tiny usage value exactly instead of a rounded decimal", () => {
    const before = docA() as any;
    const after = docB() as any;
    before.usage = { tiny: 1.234e-20 };
    after.usage = { tiny: 1.234e-20 };
    const [usage] = claimsOf(compareDocs(before, after), "trace-usage");
    expect(usage.claim).toContain("1.234e-20");
    expect(usage.claim).not.toContain("0.00000000000000000001");
  });

  it("quotes a tiny cost amount exactly instead of a rounded decimal", () => {
    const before = docA() as any;
    const after = docB() as any;
    before.cost = { amount: 1.234e-20, currency: "USD" };
    after.cost = { amount: 1.234e-20, currency: "USD" };
    const [cost] = claimsOf(compareDocs(before, after), "trace-cost");
    expect(cost.claim).toContain("1.234e-20");
    expect(cost.claim).not.toContain("0.00000000000000000001");
  });

  it.each([
    [
      "usage",
      (doc: any) => {
        doc.usage = { tokens: Infinity };
      },
    ],
    [
      "cost.amount",
      (doc: any) => {
        doc.cost = { amount: Infinity, currency: "USD" };
      },
    ],
    [
      "execution_options.runtime leaf",
      (doc: any) => {
        doc.execution_options = {
          timeout_ms: 600000,
          runtime: { max_turns: Infinity },
        };
      },
    ],
    [
      "execution.duration_ms",
      (doc: any) => {
        doc.execution = {
          exit_code: 0,
          signal: null,
          duration_ms: Infinity,
          timed_out: false,
        };
      },
    ],
  ])("rejects a non-finite %s as an input error", (_label, mutate) => {
    const doc = docA();
    mutate(doc);
    expect(() => parseYuureiTrace(doc, "before.json")).toThrow(PflExportError);
  });

  it("states an overflowing recorded difference instead of quoting Infinity", () => {
    const before = docA() as any;
    const after = docB() as any;
    before.usage = { span: -Number.MAX_VALUE };
    after.usage = { span: Number.MAX_VALUE };
    before.cost = { amount: -Number.MAX_VALUE, currency: "USD" };
    after.cost = { amount: Number.MAX_VALUE, currency: "USD" };
    before.execution = {
      exit_code: 0,
      signal: null,
      duration_ms: -Number.MAX_VALUE,
      timed_out: false,
    };
    after.execution = {
      exit_code: 0,
      signal: null,
      duration_ms: Number.MAX_VALUE,
      timed_out: false,
    };
    const result = compareDocs(before, after);
    for (const ruleId of ["trace-usage", "trace-cost", "trace-duration"]) {
      const [claimed] = claimsOf(result, ruleId);
      expect(claimed.claim, ruleId).toContain("outside the finite range");
      expect(claimed.claim, ruleId).not.toContain("Infinity");
      expect(claimed.claim, ruleId).not.toContain("NaN");
    }
  });

  it("states a null exit code as unobserved for a signal-terminated run", () => {
    const before = docA() as any;
    const after = docB() as any;
    after.execution = {
      exit_code: null,
      signal: "SIGKILL",
      duration_ms: 41800,
      timed_out: false,
    };
    const [execution] = claimsOf(compareDocs(before, after), "trace-execution");
    expect(execution.claim).toContain("recorded no exit code (unobserved)");
    expect(execution.claim).toContain("terminated with signal 'SIGKILL'");
    expect(execution.claim).toContain("was not timed out");
  });

  it("keeps significant digits in a recorded usage difference", () => {
    const before = docA() as any;
    const after = docB() as any;
    before.usage = { tokens: 0 };
    after.usage = { tokens: 1.000000000000001 };
    const [usage] = claimsOf(compareDocs(before, after), "trace-usage");
    expect(usage.claim).toContain("run B recorded 1.000000000000001");
    expect(usage.claim).toContain("difference of 1.000000000000001");
  });

  it("orders usage keys by UTF-8 byte order, not UTF-16 code units", () => {
    const before = docA() as any;
    const after = docB() as any;
    const keys = ["\u{1F600}", "\uFFFD"];
    before.usage = Object.fromEntries(keys.map((key) => [key, 1]));
    after.usage = Object.fromEntries(keys.map((key) => [key, 1]));
    const order = claimsOf(compareDocs(before, after), "trace-usage").map(
      (claimed) => claimed.claim.match(/usage key '(.*)'/)?.[1],
    );
    // U+FFFD (bytes EF BF BD) sorts before U+1F600 (bytes F0 9F 98 80); by
    // UTF-16 code unit the surrogate pair would sort first instead.
    expect(order).toEqual(["\uFFFD", "\u{1F600}"]);
  });

  it("accepts a valid trace that carries extra pfl-like fields", () => {
    const doc = docA() as any;
    doc.command = "report";
    doc.pflVersion = "1.0.0";
    expect(() => parseYuureiTrace(doc, "before.json")).not.toThrow();
  });

  it("still rejects a real pfl document as a kind mismatch", () => {
    const pfl = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("fixtures/pfl-export/valid-report.json", import.meta.url),
        ),
        "utf8",
      ),
    );
    let error: unknown;
    try {
      parseYuureiTrace(pfl, "before.json");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PflExportError);
    expect((error as PflExportError).code).toBe("mismatched-inputs");
  });
});
