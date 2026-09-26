import type {
  PflDiffDocument,
  PflExportDocument,
} from "../input/pfl-export.js";

/** Structural bucket an element id falls into per the diff. */
export type StructuralChange = "added" | "removed" | "changed" | "none";

export interface ElementReconciliation {
  readonly id: string;
  /** The diff's structural classification; "none" when only statusChanges names it. */
  readonly structural: StructuralChange;
  /** The diff-recorded resolved-status transition, if the diff lists one. */
  readonly statusChange: {
    readonly from: string | null;
    readonly to: string | null;
  } | null;
  /** Index into before.data.elements, or null when the export lacks the id. */
  readonly beforeIndex: number | null;
  /** Index into after.data.elements, or null when the export lacks the id. */
  readonly afterIndex: number | null;
  /**
   * Activation change derived by comparing the two exports' resolved layers
   * (the diff carries only an aggregate activationChanged count).
   */
  readonly activationChange: {
    readonly from: string;
    readonly to: string;
  } | null;
  /** Facet difference derived from the two exports' interpretation layers. */
  readonly facetChange: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  } | null;
  /**
   * Conflicts between what the diff asserts and what the exports carry.
   * Missing data on a partial or unknown-completeness side is recorded as
   * unobserved instead — partial observation is not a contradiction.
   */
  readonly contradictions: readonly string[];
}

/** The joined per-element comparison view consumed by the compare rules. */
export interface ComparisonView {
  readonly before: PflExportDocument;
  readonly after: PflExportDocument;
  readonly diff: PflDiffDocument;
  readonly elements: readonly ElementReconciliation[];
}

function indexElements(document: PflExportDocument): Map<string, number> {
  const index = new Map<string, number>();
  document.data.elements.forEach((element, i) => index.set(element.id, i));
  return index;
}

function diffSet<T>(
  before: readonly T[],
  after: readonly T[],
): {
  added: T[];
  removed: T[];
} {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((v) => !beforeSet.has(v)).sort(),
    removed: before.filter((v) => !afterSet.has(v)).sort(),
  };
}

/**
 * Joins the diff's change sets with the element context in both exports into
 * a deterministic per-element view (docs/v0.4-scope.md). The view is
 * descriptive: the diff's ids and transitions are recorded as asserted, the
 * exports supply per-element context, and disagreements are contradictions —
 * never silently resolved.
 */
export function reconcileDocuments(
  before: PflExportDocument,
  after: PflExportDocument,
  diff: PflDiffDocument,
): ComparisonView {
  const beforeIndex = indexElements(before);
  const afterIndex = indexElements(after);
  const statusChanges = new Map(
    diff.data.effective.statusChanges.map((change) => [change.id, change]),
  );
  const buckets: Readonly<
    Record<Exclude<StructuralChange, "none">, readonly string[]>
  > = {
    added: diff.data.structural.addedIds,
    removed: diff.data.structural.removedIds,
    changed: diff.data.structural.changedIds,
  };
  const ids = new Set<string>([
    ...buckets.added,
    ...buckets.removed,
    ...buckets.changed,
    ...statusChanges.keys(),
  ]);

  const elements: ElementReconciliation[] = [...ids].sort().map((id) => {
    // The reader enforces pairwise disjointness of the structural lists, so
    // an id belongs to at most one bucket.
    const structural: StructuralChange =
      (Object.keys(buckets) as Exclude<StructuralChange, "none">[]).find(
        (key) => buckets[key].includes(id),
      ) ?? "none";
    const bi = beforeIndex.get(id) ?? null;
    const ai = afterIndex.get(id) ?? null;
    const beforeElement = bi === null ? null : before.data.elements[bi];
    const afterElement = ai === null ? null : after.data.elements[ai];
    const statusChange = statusChanges.get(id) ?? null;

    const activationChange =
      beforeElement?.resolved != null && afterElement?.resolved != null
        ? beforeElement.resolved.activation !== afterElement.resolved.activation
          ? {
              from: beforeElement.resolved.activation,
              to: afterElement.resolved.activation,
            }
          : null
        : null;
    const facets =
      beforeElement?.interpretation != null &&
      afterElement?.interpretation != null
        ? diffSet(
            beforeElement.interpretation.facets,
            afterElement.interpretation.facets,
          )
        : null;
    const facetChange =
      facets !== null && (facets.added.length > 0 || facets.removed.length > 0)
        ? facets
        : null;

    const contradictions: string[] = [];
    if (structural === "added" && bi !== null)
      contradictions.push(
        "listed as added by the diff but present in the before export",
      );
    if (structural === "removed" && ai !== null)
      contradictions.push(
        "listed as removed by the diff but present in the after export",
      );
    if (
      structural === "added" &&
      ai === null &&
      after.completeness === "complete"
    )
      contradictions.push(
        "listed as added by the diff but absent from the complete after export",
      );
    if (
      structural === "removed" &&
      bi === null &&
      before.completeness === "complete"
    )
      contradictions.push(
        "listed as removed by the diff but absent from the complete before export",
      );
    if (structural === "changed") {
      if (bi === null && before.completeness === "complete")
        contradictions.push(
          "listed as changed by the diff but absent from the complete before export",
        );
      if (ai === null && after.completeness === "complete")
        contradictions.push(
          "listed as changed by the diff but absent from the complete after export",
        );
    }
    if (statusChange !== null) {
      if (
        (bi === null && before.completeness === "complete") ||
        (ai === null && after.completeness === "complete")
      )
        contradictions.push(
          "has a diff status change but is absent from a complete export",
        );
      if (
        statusChange.from !== null &&
        beforeElement?.resolved != null &&
        beforeElement.resolved.status !== statusChange.from
      )
        contradictions.push(
          `diff records status from '${statusChange.from}' but the before export resolves '${beforeElement.resolved.status}'`,
        );
      if (
        statusChange.to !== null &&
        afterElement?.resolved != null &&
        afterElement.resolved.status !== statusChange.to
      )
        contradictions.push(
          `diff records status to '${statusChange.to}' but the after export resolves '${afterElement.resolved.status}'`,
        );
      // A null side marks the element as absent on that side in the diff;
      // an export that still carries a resolved status contradicts that.
      if (statusChange.from === null && beforeElement?.resolved != null)
        contradictions.push(
          `diff records no before status but the before export resolves '${beforeElement.resolved.status}'`,
        );
      if (statusChange.to === null && afterElement?.resolved != null)
        contradictions.push(
          `diff records no after status but the after export resolves '${afterElement.resolved.status}'`,
        );
    }

    return {
      id,
      structural,
      statusChange:
        statusChange === null
          ? null
          : { from: statusChange.from, to: statusChange.to },
      beforeIndex: bi,
      afterIndex: ai,
      activationChange,
      facetChange,
      contradictions,
    };
  });

  return { before, after, diff, elements };
}
