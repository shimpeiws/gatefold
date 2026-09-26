import {
  COMPARISON_SCHEMA_VERSION,
  type ComparisonDiffInput,
  type ComparisonExportInput,
  type ComparisonResult,
} from "../domain/comparison.js";
import { assertValidComparisonResult } from "../domain/validate-comparison.js";
import { PflExportError } from "../input/pfl-export.js";
import type {
  PflDiffDocument,
  PflDocument,
  PflExportDocument,
} from "../input/pfl-export.js";
import { COMPARE_RULES } from "./compare-rules.js";
import { MAX_EMITTED_CLAIMS, MAX_EVIDENCE_REFERENCES } from "./limits.js";
import { reconcileDocuments } from "./reconcile.js";

function mismatched(message: string): PflExportError {
  return new PflExportError("mismatched-inputs", message);
}

function requireCommand<K extends PflDocument["command"]>(
  document: PflDocument,
  command: K,
  role: string,
): PflDocument & { command: K } {
  if (document.command !== command)
    throw mismatched(
      `--${role} must be a pfl ${command} document (got command '${document.command}')`,
    );
  return document as PflDocument & { command: K };
}

/** Which diff side an export's snapshot ids bind to, if either. */
function exportMatchesSide(
  document: PflExportDocument,
  diff: PflDiffDocument,
  side: "A" | "B",
): boolean {
  const observed =
    side === "A"
      ? diff.data.observedSnapshotIdA
      : diff.data.observedSnapshotIdB;
  const resolved =
    side === "A"
      ? diff.data.resolvedSnapshotIdA
      : diff.data.resolvedSnapshotIdB;
  return (
    document.data.snapshot.observedSnapshotId === observed &&
    document.data.snapshot.resolvedSnapshotId === resolved
  );
}

function exportInput(document: PflExportDocument): ComparisonExportInput {
  return {
    label: document.sourcePath,
    command: "export",
    pflVersion: document.pflVersion,
    observedSnapshotId: document.data.snapshot.observedSnapshotId,
    resolvedSnapshotId: document.data.snapshot.resolvedSnapshotId,
    completeness: document.completeness,
    runtimeVersion: document.data.runtime.version,
    semanticsVersion: document.data.resolution.semanticsVersion,
    classifierVersion: document.data.interpretation.classifier.version,
    interpretationOrigin: document.data.interpretation.origin,
  };
}

function diffInput(document: PflDiffDocument): ComparisonDiffInput {
  return {
    label: document.sourcePath,
    command: "diff",
    pflVersion: document.pflVersion,
    observedSnapshotIdA: document.data.observedSnapshotIdA,
    observedSnapshotIdB: document.data.observedSnapshotIdB,
    resolvedSnapshotIdA: document.data.resolvedSnapshotIdA,
    resolvedSnapshotIdB: document.data.resolvedSnapshotIdB,
    completeness: document.completeness,
    classifierVersionA: document.data.interpretation.a.classifierVersion,
    classifierVersionB: document.data.interpretation.b.classifierVersion,
    interpretationOriginA: document.data.interpretation.a.origin,
    interpretationOriginB: document.data.interpretation.b.origin,
  };
}

/**
 * Validates that the three documents form one A → B comparison
 * (docs/v0.4-scope.md) and returns the comparison result. Claim rules join
 * the documents in later milestones; for now the result carries the validated
 * inputs and no claims.
 */
export function compareDocuments(input: {
  before: PflDocument;
  after: PflDocument;
  diff: PflDocument;
}): ComparisonResult {
  const before = requireCommand(input.before, "export", "before");
  const after = requireCommand(input.after, "export", "after");
  const diff = requireCommand(input.diff, "diff", "diff");

  if (before.data.project.id !== after.data.project.id)
    throw mismatched(
      `--before and --after describe different projects ('${before.data.project.id}' vs '${after.data.project.id}')`,
    );
  if (
    before.data.runtime.id !== after.data.runtime.id ||
    before.data.runtime.id !== diff.data.runtime
  )
    throw mismatched(
      `the three documents describe different runtimes ('${before.data.runtime.id}', '${after.data.runtime.id}', '${diff.data.runtime}')`,
    );

  const beforeSide: "A" | "B" | null = exportMatchesSide(before, diff, "A")
    ? "A"
    : exportMatchesSide(before, diff, "B")
      ? "B"
      : null;
  const afterSide: "A" | "B" | null = exportMatchesSide(after, diff, "A")
    ? "A"
    : exportMatchesSide(after, diff, "B")
      ? "B"
      : null;

  if (beforeSide === "B" && afterSide === "A")
    throw mismatched(
      "--before binds to the diff's B side and --after to its A side; swap the two exports",
    );
  if (beforeSide !== "A" || afterSide !== "B")
    throw mismatched(
      "the exports' snapshot ids do not bind to the diff's A and B sides " +
        `(before snapshot ${before.data.snapshot.observedSnapshotId}/` +
        `${before.data.snapshot.resolvedSnapshotId}, ` +
        `after ${after.data.snapshot.observedSnapshotId}/` +
        `${after.data.snapshot.resolvedSnapshotId}, ` +
        `diff A ${diff.data.observedSnapshotIdA}/` +
        `${diff.data.resolvedSnapshotIdA}, ` +
        `diff B ${diff.data.observedSnapshotIdB}/` +
        `${diff.data.resolvedSnapshotIdB})`,
    );

  const view = reconcileDocuments(before, after, diff);
  const claims = COMPARE_RULES.flatMap((rule) => rule.evaluate(view));
  if (claims.length > MAX_EMITTED_CLAIMS)
    throw new PflExportError(
      "invalid-shape",
      `comparison would emit ${claims.length} claims, exceeding the ${MAX_EMITTED_CLAIMS} claim ceiling`,
    );
  const evidenceCount = claims.reduce(
    (total, claim) => total + claim.evidence.length,
    0,
  );
  if (evidenceCount > MAX_EVIDENCE_REFERENCES)
    throw new PflExportError(
      "invalid-shape",
      `comparison would cite ${evidenceCount} evidence references, exceeding the ${MAX_EVIDENCE_REFERENCES} reference ceiling`,
    );

  const result: ComparisonResult = {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    source: { command: "compare" },
    inputs: {
      before: exportInput(before),
      after: exportInput(after),
      diff: diffInput(diff),
    },
    claims,
  };
  assertValidComparisonResult(result);
  return result;
}
