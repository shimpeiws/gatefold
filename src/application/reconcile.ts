import type { ComparisonEvidenceReference } from "../domain/comparison.js";
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
  /** Index into the matching diff id list (addedIds/removedIds/changedIds), or null when structural is "none". */
  readonly structuralIndex: number | null;
  /** The diff-recorded resolved-status transition, if the diff lists one. */
  readonly statusChange: {
    readonly from: string | null;
    readonly to: string | null;
    /** Index into data.effective.statusChanges. */
    readonly index: number;
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
   * Conflicts between what the diff asserts and what the exports carry,
   * each with the evidence pointers that prove the disagreement. Missing
   * data on a partial or unknown-completeness side is recorded as
   * unobserved instead — partial observation is not a contradiction.
   */
  readonly contradictions: readonly {
    readonly detail: string;
    readonly evidence: readonly ComparisonEvidenceReference[];
  }[];
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
    diff.data.effective.statusChanges.map((change, index) => [
      change.id,
      { ...change, index },
    ]),
  );
  const bucketIndexes: Readonly<
    Record<Exclude<StructuralChange, "none">, Map<string, number>>
  > = {
    added: new Map(
      diff.data.structural.addedIds.map((id, index) => [id, index]),
    ),
    removed: new Map(
      diff.data.structural.removedIds.map((id, index) => [id, index]),
    ),
    changed: new Map(
      diff.data.structural.changedIds.map((id, index) => [id, index]),
    ),
  };
  const ids = new Set<string>([
    ...bucketIndexes.added.keys(),
    ...bucketIndexes.removed.keys(),
    ...bucketIndexes.changed.keys(),
    ...statusChanges.keys(),
  ]);

  const elements: ElementReconciliation[] = [...ids].sort().map((id) => {
    // The reader enforces pairwise disjointness of the structural lists, so
    // an id belongs to at most one bucket.
    const structuralKey = (
      Object.keys(bucketIndexes) as Exclude<StructuralChange, "none">[]
    ).find((key) => bucketIndexes[key].has(id));
    const structural: StructuralChange = structuralKey ?? "none";
    const structuralIndex =
      structuralKey === undefined
        ? null
        : (bucketIndexes[structuralKey].get(id) ?? null);
    const structuralList = {
      added: "addedIds",
      removed: "removedIds",
      changed: "changedIds",
      none: null,
    }[structural];
    const structuralPointer =
      structuralList === null
        ? null
        : `/data/structural/${structuralList}/${structuralIndex}`;
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

    const diffRef = (pointer: string): ComparisonEvidenceReference => ({
      source: "diff",
      pointer,
      elementId: id,
    });
    const statusPointer =
      statusChange === null
        ? null
        : `/data/effective/statusChanges/${statusChange.index}`;

    const contradictions: {
      detail: string;
      evidence: ComparisonEvidenceReference[];
    }[] = [];
    if (structural === "added" && bi !== null)
      contradictions.push({
        detail: "listed as added by the diff but present in the before export",
        evidence: [
          diffRef(structuralPointer!),
          {
            source: "before",
            pointer: `/data/elements/${bi}/id`,
            elementId: id,
          },
        ],
      });
    if (structural === "removed" && ai !== null)
      contradictions.push({
        detail: "listed as removed by the diff but present in the after export",
        evidence: [
          diffRef(structuralPointer!),
          {
            source: "after",
            pointer: `/data/elements/${ai}/id`,
            elementId: id,
          },
        ],
      });
    if (
      structural === "added" &&
      ai === null &&
      after.completeness === "complete"
    )
      contradictions.push({
        detail:
          "listed as added by the diff but absent from the complete after export",
        evidence: [
          diffRef(structuralPointer!),
          { source: "after", pointer: "/data/elements", elementId: id },
        ],
      });
    if (
      structural === "removed" &&
      bi === null &&
      before.completeness === "complete"
    )
      contradictions.push({
        detail:
          "listed as removed by the diff but absent from the complete before export",
        evidence: [
          diffRef(structuralPointer!),
          { source: "before", pointer: "/data/elements", elementId: id },
        ],
      });
    if (structural === "changed") {
      if (bi === null && before.completeness === "complete")
        contradictions.push({
          detail:
            "listed as changed by the diff but absent from the complete before export",
          evidence: [
            diffRef(structuralPointer!),
            { source: "before", pointer: "/data/elements", elementId: id },
          ],
        });
      if (ai === null && after.completeness === "complete")
        contradictions.push({
          detail:
            "listed as changed by the diff but absent from the complete after export",
          evidence: [
            diffRef(structuralPointer!),
            { source: "after", pointer: "/data/elements", elementId: id },
          ],
        });
    }
    if (statusChange !== null) {
      const statusRef = (field: string): ComparisonEvidenceReference => ({
        source: "diff",
        pointer: `${statusPointer}/${field}`,
        elementId: id,
      });
      if (
        (bi === null && before.completeness === "complete") ||
        (ai === null && after.completeness === "complete")
      )
        contradictions.push({
          detail:
            "has a diff status change but is absent from a complete export",
          evidence: [
            statusRef("id"),
            {
              source: bi === null ? "before" : "after",
              pointer: "/data/elements",
              elementId: id,
            },
          ],
        });
      if (
        statusChange.from !== null &&
        beforeElement?.resolved != null &&
        beforeElement.resolved.status !== statusChange.from
      )
        contradictions.push({
          detail: `diff records status from '${statusChange.from}' but the before export resolves '${beforeElement.resolved.status}'`,
          evidence: [
            statusRef("from"),
            {
              source: "before",
              pointer: `/data/elements/${bi}/resolved/status`,
              elementId: id,
            },
          ],
        });
      if (
        statusChange.to !== null &&
        afterElement?.resolved != null &&
        afterElement.resolved.status !== statusChange.to
      )
        contradictions.push({
          detail: `diff records status to '${statusChange.to}' but the after export resolves '${afterElement.resolved.status}'`,
          evidence: [
            statusRef("to"),
            {
              source: "after",
              pointer: `/data/elements/${ai}/resolved/status`,
              elementId: id,
            },
          ],
        });
      // A null side marks the element as absent on that side in the diff;
      // an export that still carries a resolved status contradicts that.
      if (statusChange.from === null && beforeElement?.resolved != null)
        contradictions.push({
          detail: `diff records no before status but the before export resolves '${beforeElement.resolved.status}'`,
          evidence: [
            statusRef("from"),
            {
              source: "before",
              pointer: `/data/elements/${bi}/resolved/status`,
              elementId: id,
            },
          ],
        });
      if (statusChange.to === null && afterElement?.resolved != null)
        contradictions.push({
          detail: `diff records no after status but the after export resolves '${afterElement.resolved.status}'`,
          evidence: [
            statusRef("to"),
            {
              source: "after",
              pointer: `/data/elements/${ai}/resolved/status`,
              elementId: id,
            },
          ],
        });
    }

    return {
      id,
      structural,
      structuralIndex,
      statusChange:
        statusChange === null
          ? null
          : {
              from: statusChange.from,
              to: statusChange.to,
              index: statusChange.index,
            },
      beforeIndex: bi,
      afterIndex: ai,
      activationChange,
      facetChange,
      contradictions,
    };
  });

  return { before, after, diff, elements };
}
