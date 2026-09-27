import type {
  TraceClaim,
  TraceEvidenceReference,
} from "../domain/trace-comparison.js";
import { sanitizeText } from "../domain/sanitize.js";
import type { YuureiTrace } from "../input/yuurei-trace.js";
import type { TraceComparisonView } from "./trace-comparability.js";

/** One trace-comparison claim rule, evaluated against the two traces. */
export interface TraceRule {
  readonly ruleId: string;
  evaluate(view: TraceComparisonView): readonly TraceClaim[];
}

const SOURCE_ORDER: Record<string, number> = { beforeTrace: 0, afterTrace: 1 };

/** Sorts evidence per contract: source (beforeTrace < afterTrace), then pointer. */
function sortEvidence(
  evidence: readonly TraceEvidenceReference[],
): TraceEvidenceReference[] {
  return [...evidence].sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0),
  );
}

function claim(
  ruleId: string,
  text: string,
  evidence: readonly TraceEvidenceReference[],
  confidence = 1,
): TraceClaim {
  return {
    claim: sanitizeText(text),
    ruleId,
    evidence: sortEvidence(evidence),
    provenance: { transform: ["compare-traces", `rule:${ruleId}`] },
    confidence,
  };
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/**
 * The shortest representation of a number that never uses exponent notation,
 * so a claim can quote a small measurement as a decimal.
 */
function plainNumber(value: number): string {
  const shortest = String(value);
  if (!shortest.includes("e") && !shortest.includes("E")) return shortest;
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return shortest;
  const fixed = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  if (fixed === "" || fixed === "-" || Number(fixed) === 0) return shortest;
  return fixed;
}

/**
 * Renders a recorded number. Grouping is a display convenience, so it is used
 * only when it leaves the recorded value unchanged: the formatter's default
 * three-fraction-digit limit would otherwise quote a different number than
 * the evidence points at. Fractional measurements keep their recorded digits.
 */
function formatNumber(value: number): string {
  const plain = plainNumber(value);
  const grouped = NUMBER_FORMAT.format(value);
  return grouped.replace(/,/g, "") === plain ? grouped : plain;
}

/**
 * Renders a computed difference. Double-precision noise is dropped, but a
 * nonzero difference is never rendered as zero.
 */
function formatNumberDelta(value: number): string {
  if (value === 0) return "0";
  const cleaned = Number(value.toPrecision(15));
  return formatNumber(cleaned === 0 ? value : cleaned);
}

/**
 * A cost delta is an estimate displayed to at most six decimal places, so
 * binary floating-point tails never reach the claim text. A nonzero
 * difference below that threshold keeps its precision rather than being
 * rounded to zero.
 */
function formatCostDelta(value: number): string {
  if (value === 0 || Number.isInteger(value)) return String(value);
  const rounded = Number(value.toFixed(6));
  return rounded === 0 ? plainNumber(value) : String(rounded);
}

/** Escapes one usage key as an RFC 6901 pointer segment. */
function pointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * The recorded outcome of one side's `execution` object as a phrase:
 * timeout, then exit code and signal as recorded. A recorded signal is
 * reported even when an exit code is present, and the missing-exit-code
 * phrase is reserved for a run with neither. Null fields are stated as
 * unobserved, never as zero or failure.
 */
function executionOutcome(trace: YuureiTrace, side: "A" | "B"): string {
  const execution = trace.execution;
  const parts: string[] = [];
  if (execution.timedOut) parts.push("timed out");
  if (execution.exitCode !== null) parts.push(`exited ${execution.exitCode}`);
  if (execution.signal !== null)
    parts.push(`terminated with signal '${execution.signal}'`);
  if (execution.exitCode === null && execution.signal === null)
    parts.push("recorded no exit code");
  return `run ${side} ${parts.join(" and ")}`;
}

export const TRACE_RULES: readonly TraceRule[] = [
  {
    // One statement of what the pair is: two runs of the same requested
    // task content, runtime, requested model, and isolation strategy. Run
    // provenance (ids, sources) is described, never used as identity.
    ruleId: "trace-inputs",
    evaluate(view) {
      const { before, after } = view;
      let text =
        `Runs '${before.runId}' (A) and '${after.runId}' (B) requested the ` +
        `same task content (task.digest '${before.task.digest}'), runtime ` +
        `'${before.runtime.id}', model '${before.model.requested}', and ` +
        `isolation strategy '${before.isolation.strategy}'`;
      if (before.task.source !== after.task.source)
        text +=
          `; the task sources differ ('${before.task.source}' vs ` +
          `'${after.task.source}') but are provenance, not identity`;
      const verified = [before.isolation.verified, after.isolation.verified];
      if (!verified.every(Boolean))
        text +=
          `; isolation verification recorded ${before.isolation.verified} ` +
          `on A and ${after.isolation.verified} on B`;
      text += ".";
      return [
        claim("trace-inputs", text, [
          { source: "beforeTrace", pointer: "/run_id" },
          { source: "beforeTrace", pointer: "/task/digest" },
          ...(before.task.source !== after.task.source
            ? [
                {
                  source: "beforeTrace" as const,
                  pointer: "/task/source",
                },
              ]
            : []),
          { source: "beforeTrace", pointer: "/runtime/id" },
          { source: "beforeTrace", pointer: "/model/requested" },
          { source: "beforeTrace", pointer: "/isolation/strategy" },
          { source: "beforeTrace", pointer: "/isolation/verified" },
          { source: "afterTrace", pointer: "/run_id" },
          ...(before.task.source !== after.task.source
            ? [
                {
                  source: "afterTrace" as const,
                  pointer: "/task/source",
                },
              ]
            : []),
          { source: "afterTrace", pointer: "/task/digest" },
          { source: "afterTrace", pointer: "/runtime/id" },
          { source: "afterTrace", pointer: "/model/requested" },
          { source: "afterTrace", pointer: "/isolation/strategy" },
          { source: "afterTrace", pointer: "/isolation/verified" },
        ]),
      ];
    },
  },
  {
    // Comparability caveats: unverifiable identity inputs and observed
    // environment drift, one claim per caveat in field byte order.
    ruleId: "trace-comparability",
    evaluate(view) {
      return view.caveats.map((caveat) =>
        claim(
          "trace-comparability",
          `Comparability caveat: ${caveat.text}.`,
          caveat.evidence,
        ),
      );
    },
  },
  {
    // The profile/harness variant is the subject of the comparison: it is
    // described, never rejected. A requested-cell digest difference is
    // descriptive too — the digest never decides comparability.
    ruleId: "trace-profiles",
    evaluate(view) {
      const { before, after } = view;
      const sameProfile =
        before.profile.name === after.profile.name &&
        before.profile.digest === after.profile.digest;
      let text = sameProfile
        ? `Both runs used profile '${before.profile.name}' (content digest ` +
          `'${before.profile.digest}').`
        : `Run A used profile '${before.profile.name}' (content digest ` +
          `'${before.profile.digest}') and run B used profile ` +
          `'${after.profile.name}' (content digest ` +
          `'${after.profile.digest}'); the profile difference is the ` +
          `compared variable.`;
      if (
        before.requestedCell !== undefined &&
        after.requestedCell !== undefined &&
        before.requestedCell.digest !== after.requestedCell.digest
      )
        text +=
          ` The requested-cell digests differ ` +
          `('${before.requestedCell.digest}' vs ` +
          `'${after.requestedCell.digest}')` +
          (before.profile.digest === after.profile.digest
            ? `, though the profile contents are identical, so the profile ` +
              `difference does not explain it.`
            : `, consistent with the differing profile contents.`);
      const evidence: TraceEvidenceReference[] = [
        { source: "beforeTrace", pointer: "/profile/name" },
        { source: "beforeTrace", pointer: "/profile/digest" },
        { source: "afterTrace", pointer: "/profile/name" },
        { source: "afterTrace", pointer: "/profile/digest" },
      ];
      if (
        before.requestedCell !== undefined &&
        after.requestedCell !== undefined &&
        before.requestedCell.digest !== after.requestedCell.digest
      )
        evidence.push(
          { source: "beforeTrace", pointer: "/requested_cell/digest" },
          { source: "afterTrace", pointer: "/requested_cell/digest" },
        );
      return [claim("trace-profiles", text, evidence)];
    },
  },
  {
    ruleId: "trace-runtime",
    evaluate(view) {
      const { before, after } = view;
      const side = (trace: YuureiTrace, name: "A" | "B") =>
        trace.runtime.version === null
          ? `run ${name} recorded the runtime version as unobserved`
          : `run ${name} recorded runtime version '${trace.runtime.version}'`;
      const text =
        `Both runs recorded runtime '${before.runtime.id}': ` +
        `${side(before, "A")}; ${side(after, "B")}.`;
      return [
        claim("trace-runtime", text, [
          { source: "beforeTrace", pointer: "/runtime/id" },
          { source: "beforeTrace", pointer: "/runtime/version" },
          { source: "afterTrace", pointer: "/runtime/id" },
          { source: "afterTrace", pointer: "/runtime/version" },
        ]),
      ];
    },
  },
  {
    ruleId: "trace-model",
    evaluate(view) {
      const { before, after } = view;
      const evidence: TraceEvidenceReference[] = [
        { source: "beforeTrace", pointer: "/model/requested" },
        { source: "beforeTrace", pointer: "/model/resolved" },
        { source: "afterTrace", pointer: "/model/requested" },
        { source: "afterTrace", pointer: "/model/resolved" },
      ];
      const side = (trace: YuureiTrace, name: "A" | "B") => {
        if (trace.model.resolved !== null)
          return `run ${name} resolved to '${trace.model.resolved}'`;
        const reason = trace.model.resolvedReason;
        if (reason === undefined)
          return (
            `run ${name} did not observe the effective model ` +
            `(recorded resolved as null)`
          );
        return (
          `run ${name} did not observe the effective model ` +
          `(resolved_reason '${reason}')`
        );
      };
      for (const [trace, source] of [
        [before, "beforeTrace"],
        [after, "afterTrace"],
      ] as const) {
        if (trace.model.resolvedReason !== undefined)
          evidence.push({
            source,
            pointer: "/model/resolved_reason",
          });
      }
      const text =
        `Both runs requested model '${before.model.requested}': ` +
        `${side(before, "A")}; ${side(after, "B")}.`;
      return [claim("trace-model", text, evidence)];
    },
  },
  {
    // Exit code, signal, and timeout are execution outcomes, not verdicts:
    // the claim always says so, and never equates exit 0 with a good answer.
    ruleId: "trace-execution",
    evaluate(view) {
      const { before, after } = view;
      const evidence: TraceEvidenceReference[] = [
        { source: "beforeTrace", pointer: "/execution/exit_code" },
        { source: "beforeTrace", pointer: "/execution/timed_out" },
        { source: "afterTrace", pointer: "/execution/exit_code" },
        { source: "afterTrace", pointer: "/execution/timed_out" },
      ];
      for (const [trace, source] of [
        [before, "beforeTrace"],
        [after, "afterTrace"],
      ] as const) {
        if (trace.execution.signal !== null)
          evidence.push({ source, pointer: "/execution/signal" });
      }
      const text =
        `${executionOutcome(before, "A")}; ${executionOutcome(after, "B")}. ` +
        `Exit status describes process termination, not answer quality.`;
      return [claim("trace-execution", text, evidence)];
    },
  },
  {
    ruleId: "trace-duration",
    evaluate(view) {
      const { before, after } = view;
      const evidence: TraceEvidenceReference[] = [
        { source: "beforeTrace", pointer: "/execution/duration_ms" },
        { source: "afterTrace", pointer: "/execution/duration_ms" },
      ];
      const a = before.execution.durationMs;
      const b = after.execution.durationMs;
      let text: string;
      if (a !== null && b !== null)
        text =
          `Run A recorded a duration of ${formatNumber(a)} ms and run B ` +
          `${formatNumber(b)} ms, a recorded difference of ` +
          `${formatNumberDelta(b - a)} ms.`;
      else if (a === null && b === null)
        text = `Neither run recorded a duration; no difference is computed.`;
      else
        text =
          a === null
            ? `Run A did not record a duration while run B recorded ` +
              `${formatNumber(b as number)} ms; no difference is computed.`
            : `Run A recorded ${formatNumber(a)} ms while run B did not ` +
              `record a duration; no difference is computed.`;
      return [claim("trace-duration", text, evidence)];
    },
  },
  {
    // Usage keys are compared only when numeric on both sides. A key on one
    // side only is reported as asymmetric observation, with absent ("never
    // attempted") and null ("attempted but unobserved") kept distinct.
    ruleId: "trace-usage",
    evaluate(view) {
      const { before, after } = view;
      const keys = [
        ...new Set([...Object.keys(before.usage), ...Object.keys(after.usage)]),
      ].sort();
      const claims: TraceClaim[] = [];
      for (const key of keys) {
        const aHas = Object.prototype.hasOwnProperty.call(before.usage, key);
        const bHas = Object.prototype.hasOwnProperty.call(after.usage, key);
        const a = before.usage[key];
        const b = after.usage[key];
        const segment = pointerSegment(key);
        const aPointer: TraceEvidenceReference = {
          source: "beforeTrace",
          pointer: `/usage/${segment}`,
        };
        const bPointer: TraceEvidenceReference = {
          source: "afterTrace",
          pointer: `/usage/${segment}`,
        };
        const keyText = `usage key '${key}'`;
        if (aHas && bHas && a !== null && b !== null) {
          claims.push(
            claim(
              "trace-usage",
              `Run A recorded ${formatNumber(a)} for ${keyText}; run B ` +
                `recorded ${formatNumber(b)} (a recorded difference of ` +
                `${formatNumberDelta(b - a)}).`,
              [aPointer, bPointer],
            ),
          );
        } else if (aHas && bHas && a === null && b === null) {
          claims.push(
            claim(
              "trace-usage",
              `Both runs record ${keyText} as unobserved (the measurement ` +
                `was attempted but not observed on either side).`,
              [aPointer, bPointer],
            ),
          );
        } else if (aHas && bHas) {
          const observed = a === null ? b : a;
          const observedSide = a === null ? "B" : "A";
          const unobservedSide = a === null ? "A" : "B";
          claims.push(
            claim(
              "trace-usage",
              `Run ${observedSide} recorded ` +
                `${formatNumber(observed as number)} for ${keyText}; run ` +
                `${unobservedSide} records the key as unobserved ` +
                `(attempted but not observed), so no difference is computed.`,
              [aPointer, bPointer],
            ),
          );
        } else {
          const present = aHas ? aPointer : bPointer;
          const absent: TraceEvidenceReference = {
            source: aHas ? "afterTrace" : "beforeTrace",
            pointer: "/usage",
            note: `no ${key} entry`,
          };
          const presentValue = aHas ? a : b;
          const presentSide = aHas ? "A" : "B";
          const absentSide = aHas ? "B" : "A";
          const presentText =
            presentValue === null
              ? `run ${presentSide} records ${keyText} as unobserved ` +
                `(attempted but not observed)`
              : `run ${presentSide} recorded ` +
                `${formatNumber(presentValue as number)} for ${keyText}`;
          claims.push(
            claim(
              "trace-usage",
              `${presentText}; run ${absentSide} does not record the key ` +
                `(the measurement was never attempted).`,
              [present, absent],
            ),
          );
        }
      }
      return claims;
    },
  },
  {
    // Cost is an estimate and is phrased as one: compared only when both
    // sides carry an estimate in the same currency; otherwise each side's
    // estimate is stated separately with no numeric difference.
    ruleId: "trace-cost",
    evaluate(view) {
      const { before, after } = view;
      const evidence: TraceEvidenceReference[] = [];
      if (before.cost === null)
        evidence.push({
          source: "beforeTrace",
          pointer: "/cost",
          note: "no cost estimate",
        });
      else
        evidence.push(
          { source: "beforeTrace", pointer: "/cost/amount" },
          { source: "beforeTrace", pointer: "/cost/currency" },
        );
      if (after.cost === null)
        evidence.push({
          source: "afterTrace",
          pointer: "/cost",
          note: "no cost estimate",
        });
      else
        evidence.push(
          { source: "afterTrace", pointer: "/cost/amount" },
          { source: "afterTrace", pointer: "/cost/currency" },
        );
      let text: string;
      if (before.cost === null && after.cost === null)
        text = `Neither run produced a cost estimate.`;
      else if (before.cost === null || after.cost === null) {
        const present = before.cost ?? after.cost;
        const presentSide = before.cost === null ? "B" : "A";
        const absentSide = before.cost === null ? "A" : "B";
        text =
          `Run ${presentSide} recorded an estimated cost of ` +
          `${plainNumber(present!.amount)} ${present!.currency}; run ${absentSide} ` +
          `produced no cost estimate, so no difference is computed.`;
      } else if (before.cost.currency === after.cost.currency)
        text =
          `Run A recorded an estimated cost of ${plainNumber(before.cost.amount)} ` +
          `${before.cost.currency} and run B an estimated ` +
          `${plainNumber(after.cost.amount)} ${after.cost.currency} (a recorded ` +
          `difference of ${formatCostDelta(after.cost.amount - before.cost.amount)} ` +
          `${before.cost.currency}). Both amounts are estimates.`;
      else
        text =
          `Run A recorded an estimated cost of ${plainNumber(before.cost.amount)} ` +
          `${before.cost.currency} and run B an estimated ` +
          `${plainNumber(after.cost.amount)} ${after.cost.currency}; the currencies ` +
          `differ, so the two estimates are reported separately with no ` +
          `numeric difference.`;
      return [claim("trace-cost", text, evidence)];
    },
  },
  {
    // Diagnostics are yuurei's durable non-fatal notes: quoted verbatim as
    // fixed strings, never parsed into codes.
    ruleId: "trace-diagnostic",
    evaluate(view) {
      const claims: TraceClaim[] = [];
      for (const [trace, side, source] of [
        [view.before, "A", "beforeTrace"],
        [view.after, "B", "afterTrace"],
      ] as const) {
        for (const [index, note] of trace.diagnostics.entries())
          claims.push(
            claim(
              "trace-diagnostic",
              `Run ${side} recorded a diagnostic: '${note}'.`,
              [{ source, pointer: `/diagnostics/${index}` }],
            ),
          );
      }
      return claims;
    },
  },
];
