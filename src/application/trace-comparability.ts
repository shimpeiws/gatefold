import type { TraceEvidenceReference } from "../domain/trace-comparison.js";
import { PflExportError } from "../input/pfl-export.js";
import type { YuureiTrace } from "../input/yuurei-trace.js";

/**
 * One comparability caveat: a difference or gap the contract allows but
 * readers must see, so an outcome difference is not attributed to the
 * profile when the observed environment differed or could not be verified.
 * `field` is the dotted trace field the caveat is about; caveats are emitted
 * in field byte order inside the comparability rule.
 */
export interface ComparabilityCaveat {
  readonly field: string;
  readonly text: string;
  readonly evidence: readonly TraceEvidenceReference[];
}

/** The comparison view consumed by the trace rules. */
export interface TraceComparisonView {
  readonly before: YuureiTrace;
  readonly after: YuureiTrace;
  readonly caveats: readonly ComparabilityCaveat[];
}

function mismatched(message: string): PflExportError {
  return new PflExportError("mismatched-inputs", message);
}

/**
 * Deep JSON equality for `execution_options.runtime` records: object key
 * order is not significant at any depth; array element order is.
 */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const bArray = b as readonly unknown[];
    return (
      a.length === bArray.length &&
      a.every((item, index) => jsonEquals(item, bArray[index]))
    );
  }
  const aRecord = a as Readonly<Record<string, unknown>>;
  const bRecord = b as Readonly<Record<string, unknown>>;
  const aKeys = Object.keys(aRecord);
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(bRecord, key) &&
      jsonEquals(aRecord[key], bRecord[key]),
  );
}

/**
 * Enforces the v0.5 cross-trace comparability policy
 * (docs/v0.5-scope.md#cross-trace-comparability): the checks run in contract
 * order and the first mismatch is rejected with `mismatched-inputs`. Missing
 * optional identity fields are unknown, never equal or different, so their
 * checks are skipped and recorded as caveats instead. Observed run
 * properties (yuurei_version, runtime.version, model.resolved,
 * model.resolved_reason, isolation.verified) may differ; each real
 * difference becomes a caveat claim. Returns the caveats sorted by field.
 */
export function checkTraceComparability(
  before: YuureiTrace,
  after: YuureiTrace,
): readonly ComparabilityCaveat[] {
  const caveats: ComparabilityCaveat[] = [];

  if (before.requestedCell !== undefined && after.requestedCell !== undefined) {
    if (
      before.requestedCell.inputsVersion !== after.requestedCell.inputsVersion
    )
      throw mismatched(
        `the traces record different requested_cell.inputs_version values ` +
          `(${before.requestedCell.inputsVersion} vs ${after.requestedCell.inputsVersion}); ` +
          `different input-set versions are never compared`,
      );
  } else {
    const missing =
      before.requestedCell === undefined && after.requestedCell === undefined
        ? "neither trace records"
        : before.requestedCell === undefined
          ? "the A trace does not record"
          : "the B trace does not record";
    const evidence: TraceEvidenceReference[] = [];
    if (before.requestedCell === undefined)
      evidence.push({
        source: "beforeTrace",
        pointer: "",
        note: "no requested_cell field",
      });
    else
      evidence.push({
        source: "beforeTrace",
        pointer: "/requested_cell/inputs_version",
      });
    if (after.requestedCell === undefined)
      evidence.push({
        source: "afterTrace",
        pointer: "",
        note: "no requested_cell field",
      });
    else
      evidence.push({
        source: "afterTrace",
        pointer: "/requested_cell/inputs_version",
      });
    caveats.push({
      field: "requested_cell.inputs_version",
      text:
        `the input-set version could not be verified because ${missing} ` +
        `requested_cell; the runs may or may not have requested the same input set`,
      evidence,
    });
  }

  if (before.task.digest !== after.task.digest)
    throw mismatched(
      `the traces record different task.digest values ` +
        `('${before.task.digest}' vs '${after.task.digest}'); ` +
        `only runs of the same task content are comparable`,
    );
  if (before.runtime.id !== after.runtime.id)
    throw mismatched(
      `the traces record different runtime.id values ` +
        `('${before.runtime.id}' vs '${after.runtime.id}')`,
    );
  if (before.model.requested !== after.model.requested)
    throw mismatched(
      `the traces record different model.requested values ` +
        `('${before.model.requested}' vs '${after.model.requested}')`,
    );
  if (before.isolation.strategy !== after.isolation.strategy)
    throw mismatched(
      `the traces record different isolation.strategy values ` +
        `('${before.isolation.strategy}' vs '${after.isolation.strategy}')`,
    );

  if (
    before.executionOptions !== undefined &&
    after.executionOptions !== undefined
  ) {
    if (before.executionOptions.timeoutMs !== after.executionOptions.timeoutMs)
      throw mismatched(
        `the traces record different execution_options.timeout_ms values ` +
          `(${before.executionOptions.timeoutMs} vs ${after.executionOptions.timeoutMs})`,
      );
    if (
      !jsonEquals(
        before.executionOptions.runtime,
        after.executionOptions.runtime,
      )
    )
      throw mismatched(
        `the traces record different execution_options.runtime records`,
      );
  } else {
    const missing =
      before.executionOptions === undefined &&
      after.executionOptions === undefined
        ? "neither trace records"
        : before.executionOptions === undefined
          ? "the A trace does not record"
          : "the B trace does not record";
    const evidence: TraceEvidenceReference[] = [];
    if (before.executionOptions === undefined)
      evidence.push({
        source: "beforeTrace",
        pointer: "",
        note: "no execution_options field",
      });
    else
      evidence.push({ source: "beforeTrace", pointer: "/execution_options" });
    if (after.executionOptions === undefined)
      evidence.push({
        source: "afterTrace",
        pointer: "",
        note: "no execution_options field",
      });
    else evidence.push({ source: "afterTrace", pointer: "/execution_options" });
    caveats.push({
      field: "execution_options",
      text:
        `the execution options could not be fully compared because ${missing} ` +
        `execution_options; timeout and runtime options may or may not have matched`,
      evidence,
    });
  }

  if (
    before.yuureiVersion !== undefined &&
    after.yuureiVersion !== undefined &&
    before.yuureiVersion !== after.yuureiVersion
  )
    caveats.push({
      field: "yuurei_version",
      text:
        `the traces were written by different yuurei versions ` +
        `('${before.yuureiVersion}' vs '${after.yuureiVersion}'); ` +
        `an outcome difference may reflect the yuurei version, not the profile`,
      evidence: [
        { source: "beforeTrace", pointer: "/yuurei_version" },
        { source: "afterTrace", pointer: "/yuurei_version" },
      ],
    });

  if (
    before.runtime.version !== null &&
    after.runtime.version !== null &&
    before.runtime.version !== after.runtime.version
  )
    caveats.push({
      field: "runtime.version",
      text:
        `the recorded runtime versions differ ` +
        `('${before.runtime.version}' vs '${after.runtime.version}'); ` +
        `an outcome difference may reflect the runtime version, not the profile`,
      evidence: [
        { source: "beforeTrace", pointer: "/runtime/version" },
        { source: "afterTrace", pointer: "/runtime/version" },
      ],
    });

  if (
    before.model.resolved !== null &&
    after.model.resolved !== null &&
    before.model.resolved !== after.model.resolved
  )
    caveats.push({
      field: "model.resolved",
      text:
        `the observed resolved models differ ` +
        `('${before.model.resolved}' vs '${after.model.resolved}'); ` +
        `an outcome difference may reflect the resolved model, not the profile`,
      evidence: [
        { source: "beforeTrace", pointer: "/model/resolved" },
        { source: "afterTrace", pointer: "/model/resolved" },
      ],
    });

  if (
    before.model.resolvedReason !== undefined &&
    after.model.resolvedReason !== undefined &&
    before.model.resolvedReason !== after.model.resolvedReason
  )
    caveats.push({
      field: "model.resolved_reason",
      text:
        `the recorded resolved-model reasons differ ` +
        `('${before.model.resolvedReason}' vs '${after.model.resolvedReason}')`,
      evidence: [
        { source: "beforeTrace", pointer: "/model/resolved_reason" },
        { source: "afterTrace", pointer: "/model/resolved_reason" },
      ],
    });

  if (before.isolation.verified !== after.isolation.verified)
    caveats.push({
      field: "isolation.verified",
      text:
        `the recorded isolation verification outcomes differ ` +
        `(${before.isolation.verified} vs ${after.isolation.verified}); ` +
        `an outcome difference may reflect isolation verification, not the profile`,
      evidence: [
        { source: "beforeTrace", pointer: "/isolation/verified" },
        { source: "afterTrace", pointer: "/isolation/verified" },
      ],
    });

  return caveats.sort((a, b) =>
    a.field < b.field ? -1 : a.field > b.field ? 1 : 0,
  );
}
