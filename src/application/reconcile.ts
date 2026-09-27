import type { ComparisonEvidenceReference } from "../domain/comparison.js";
import type {
  PflDiffDocument,
  PflExportDocument,
} from "../input/pfl-export.js";

/** Structural bucket an element id falls into per the diff. */
export type StructuralChange = "added" | "removed" | "changed" | "none";

/** A recorded disagreement between the diff and the exports. */
export interface ReconciliationContradiction {
  readonly detail: string;
  readonly evidence: readonly ComparisonEvidenceReference[];
}

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
  readonly contradictions: readonly ReconciliationContradiction[];
}

/**
 * One relation change from the diff, joined to the endpoint elements in each
 * export. Endpoint absence on a partial side stays unobserved.
 */
export interface RelationReconciliation {
  readonly direction: "added" | "removed";
  /** Index into diff.data.relations[direction]. */
  readonly index: number;
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly fromBeforeIndex: number | null;
  readonly fromAfterIndex: number | null;
  readonly toBeforeIndex: number | null;
  readonly toAfterIndex: number | null;
  /**
   * Presence disagreements between this delta and the complete exports.
   * A partial or unknown side never produces one — its absence stays
   * unobserved.
   */
  readonly contradictions: readonly ReconciliationContradiction[];
}

/**
 * One finding change from the diff, joined to the cited elements in each
 * export. `counterpart` links a removed finding to the added finding that
 * shares (rule, sorted elementIds) with a different message — descriptive
 * evidence of a possible rewording, not a semantic resolution.
 */
export interface FindingReconciliation {
  readonly direction: "added" | "removed";
  /** Index into diff.data.findings[direction]. */
  readonly index: number;
  readonly rule: string;
  readonly message: string;
  readonly elementIds: readonly string[];
  readonly elementIndexes: readonly {
    readonly id: string;
    readonly beforeIndex: number | null;
    readonly afterIndex: number | null;
  }[];
  /**
   * For a removed finding: index into findings.added of a same-rule,
   * same-elements finding with a different message, or null.
   */
  readonly counterpart: number | null;
  /**
   * Presence disagreements between this delta and the complete exports,
   * same gating as relation contradictions.
   */
  readonly contradictions: readonly ReconciliationContradiction[];
}

/** The joined per-element comparison view consumed by the compare rules. */
export interface ComparisonView {
  readonly before: PflExportDocument;
  readonly after: PflExportDocument;
  readonly diff: PflDiffDocument;
  readonly elements: readonly ElementReconciliation[];
  readonly relations: readonly RelationReconciliation[];
  readonly findings: readonly FindingReconciliation[];
  /**
   * Document-level disagreements that no single element owns, such as
   * aggregate activation/facet totals that contradict what the two complete
   * exports derive.
   */
  readonly documentContradictions: readonly ReconciliationContradiction[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Finding identity for deterministic ordering: rule, sorted ids, message. */
const findingIdentity = (finding: {
  rule: string;
  message: string;
  elementIds: readonly string[];
}): string =>
  JSON.stringify([
    finding.rule,
    [...finding.elementIds].sort(),
    finding.message,
  ]);

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
  // Every export id joins the view: shared ids can carry derived
  // activation/facet changes (the diff records those only as aggregate
  // counts), and one-sided ids unlisted by the diff are themselves a
  // disagreement worth recording.
  for (const id of beforeIndex.keys()) ids.add(id);
  for (const id of afterIndex.keys()) ids.add(id);

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
      // Two complete exports holding identical elements for a changed id
      // contradict the diff's assertion that the element differs.
      if (
        bi !== null &&
        ai !== null &&
        before.completeness === "complete" &&
        after.completeness === "complete" &&
        JSON.stringify(beforeElement) === JSON.stringify(afterElement)
      )
        contradictions.push({
          detail:
            "listed as changed by the diff but identical in the two complete exports",
          evidence: [
            diffRef(structuralPointer!),
            {
              source: "before",
              pointer: `/data/elements/${bi}`,
              elementId: id,
            },
            {
              source: "after",
              pointer: `/data/elements/${ai}`,
              elementId: id,
            },
          ],
        });
    }
    if (statusChange !== null) {
      const statusRef = (field: string): ComparisonEvidenceReference => ({
        source: "diff",
        pointer: `${statusPointer}/${field}`,
        elementId: id,
      });
      const absentCompleteSides: ComparisonEvidenceReference[] = [];
      // A null side records the element as absent on that side, so a
      // complete export lacking it agrees with the diff; only a non-null
      // side status contradicts an empty complete export.
      if (
        bi === null &&
        before.completeness === "complete" &&
        statusChange.from !== null
      )
        absentCompleteSides.push({
          source: "before",
          pointer: "/data/elements",
          elementId: id,
        });
      if (
        ai === null &&
        after.completeness === "complete" &&
        statusChange.to !== null
      )
        absentCompleteSides.push({
          source: "after",
          pointer: "/data/elements",
          elementId: id,
        });
      if (absentCompleteSides.length > 0)
        contradictions.push({
          detail:
            "has a diff status change but is absent from a complete export",
          evidence: [statusRef("id"), ...absentCompleteSides],
        });
      if (statusChange.from !== null && beforeElement !== null) {
        if (beforeElement.resolved === null)
          contradictions.push({
            detail: `diff records status from '${statusChange.from}' but the before export has no resolved entry`,
            evidence: [
              statusRef("from"),
              {
                source: "before",
                pointer: `/data/elements/${bi}/resolved`,
                elementId: id,
              },
            ],
          });
        else if (beforeElement.resolved.status !== statusChange.from)
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
      }
      if (statusChange.to !== null && afterElement !== null) {
        if (afterElement.resolved === null)
          contradictions.push({
            detail: `diff records status to '${statusChange.to}' but the after export has no resolved entry`,
            evidence: [
              statusRef("to"),
              {
                source: "after",
                pointer: `/data/elements/${ai}/resolved`,
                elementId: id,
              },
            ],
          });
        else if (afterElement.resolved.status !== statusChange.to)
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
      }
      // A null side marks the element as absent on that side in the diff;
      // an export that still carries the element — resolved or not —
      // contradicts that.
      if (statusChange.from === null && beforeElement !== null) {
        if (beforeElement.resolved === null)
          contradictions.push({
            detail:
              "diff records no before status but the before export contains the element with no resolved entry",
            evidence: [
              statusRef("from"),
              {
                source: "before",
                pointer: `/data/elements/${bi}/id`,
                elementId: id,
              },
            ],
          });
        else
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
      }
      if (statusChange.to === null && afterElement !== null) {
        if (afterElement.resolved === null)
          contradictions.push({
            detail:
              "diff records no after status but the after export contains the element with no resolved entry",
            evidence: [
              statusRef("to"),
              {
                source: "after",
                pointer: `/data/elements/${ai}/id`,
                elementId: id,
              },
            ],
          });
        else
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
    }
    if (structural === "none" && statusChange === null) {
      // A shared element whose resolved status differs between two
      // complete exports changed state without the diff recording it.
      if (
        bi !== null &&
        ai !== null &&
        before.completeness === "complete" &&
        after.completeness === "complete" &&
        beforeElement?.resolved != null &&
        afterElement?.resolved != null &&
        beforeElement.resolved.status !== afterElement.resolved.status
      )
        contradictions.push({
          detail: `the exports resolve '${beforeElement.resolved.status}' in A and '${afterElement.resolved.status}' in B but the diff records no status change`,
          evidence: [
            {
              source: "before",
              pointer: `/data/elements/${bi}/resolved/status`,
              elementId: id,
            },
            {
              source: "after",
              pointer: `/data/elements/${ai}/resolved/status`,
              elementId: id,
            },
            { source: "diff", pointer: "/data/effective/statusChanges" },
          ],
        });
      // The diff does not mention this id at all. When the opposite
      // export is complete, its provable absence makes the diff's
      // silence disagree with the side that carries the element; a
      // partial opposite side leaves the absence unobserved.
      if (bi === null && ai !== null && before.completeness === "complete")
        contradictions.push({
          detail:
            "present in the after export and provably absent from the complete before export, but absent from every diff change set",
          evidence: [
            { source: "before", pointer: "/data/elements", elementId: id },
            {
              source: "after",
              pointer: `/data/elements/${ai}/id`,
              elementId: id,
            },
            { source: "diff", pointer: "/data/structural" },
          ],
        });
      if (ai === null && bi !== null && after.completeness === "complete")
        contradictions.push({
          detail:
            "present in the before export and provably absent from the complete after export, but absent from every diff change set",
          evidence: [
            {
              source: "before",
              pointer: `/data/elements/${bi}/id`,
              elementId: id,
            },
            { source: "after", pointer: "/data/elements", elementId: id },
            { source: "diff", pointer: "/data/structural" },
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

  // Aggregate disagreements are checked only when the populations are
  // comparable. activationChanged may count added/removed or transitioned
  // elements under the diff producer's own semantics, so totals match only
  // when both complete exports cover the same fully-resolved element set
  // and the diff records no structural additions/removals or status
  // changes. facetDeltas are a per-facet count delta over every interpreted
  // element in each export — including one-sided elements — and are
  // incomparable when a classifier drift separates an export from its
  // diff side or when any element lacks an interpretation layer.
  const documentContradictions: ReconciliationContradiction[] = [];
  if (before.completeness === "complete" && after.completeness === "complete") {
    const sameElementIds =
      before.data.elements.length === after.data.elements.length &&
      before.data.elements.every((el) => afterIndex.has(el.id));
    if (
      sameElementIds &&
      diff.data.structural.addedIds.length === 0 &&
      diff.data.structural.removedIds.length === 0 &&
      diff.data.effective.statusChanges.length === 0 &&
      before.data.elements.every((el) => el.resolved !== null) &&
      after.data.elements.every((el) => el.resolved !== null)
    ) {
      const derived = elements.filter(
        (el) => el.activationChange !== null,
      ).length;
      const recorded = diff.data.effective.activationChanged;
      if (derived !== recorded)
        documentContradictions.push({
          detail: `the diff records ${recorded} activation changes but the two complete exports derive ${derived}`,
          evidence: [
            { source: "diff", pointer: "/data/effective/activationChanged" },
          ],
        });
    }
    if (
      before.data.interpretation.classifier.version ===
        diff.data.interpretation.a.classifierVersion &&
      after.data.interpretation.classifier.version ===
        diff.data.interpretation.b.classifierVersion &&
      before.data.elements.every((el) => el.interpretation !== null) &&
      after.data.elements.every((el) => el.interpretation !== null)
    ) {
      const facetCounts = (
        document: PflExportDocument,
      ): Map<string, number> => {
        const counts = new Map<string, number>();
        for (const el of document.data.elements)
          for (const facet of el.interpretation!.facets)
            counts.set(facet, (counts.get(facet) ?? 0) + 1);
        return counts;
      };
      const beforeCounts = facetCounts(before);
      const afterCounts = facetCounts(after);
      const facets = [
        ...new Set([
          ...beforeCounts.keys(),
          ...afterCounts.keys(),
          ...Object.keys(diff.data.facetDeltas),
        ]),
      ].sort();
      for (const facet of facets) {
        const derived =
          (afterCounts.get(facet) ?? 0) - (beforeCounts.get(facet) ?? 0);
        const hasFacet = Object.hasOwn(diff.data.facetDeltas, facet);
        const recorded = hasFacet ? diff.data.facetDeltas[facet] : 0;
        if (derived !== recorded)
          documentContradictions.push({
            detail: `the diff records facet delta ${recorded} for '${facet}' but the two complete exports derive ${derived}`,
            evidence: [
              {
                source: "diff",
                pointer: hasFacet
                  ? `/data/facetDeltas/${facet.replace(/~/g, "~0").replace(/\//g, "~1")}`
                  : "/data/facetDeltas",
              },
            ],
          });
      }
    }
  }

  // A relation delta asserts presence on one side and absence on the
  // other; check each record against the complete exports' collections.
  const relationIdentity = (relation: {
    type: string;
    from: string;
    to: string;
  }): string => JSON.stringify([relation.type, relation.from, relation.to]);
  const beforeRelations = new Set(before.data.relations.map(relationIdentity));
  const afterRelations = new Set(after.data.relations.map(relationIdentity));
  const relations: RelationReconciliation[] = (
    ["added", "removed"] as const
  ).flatMap((direction) =>
    diff.data.relations[direction].map((relation, index) => {
      const base = `/data/relations/${direction}/${index}`;
      const diffEvidence: ComparisonEvidenceReference[] = [
        { source: "diff", pointer: `${base}/type` },
        { source: "diff", pointer: `${base}/from`, elementId: relation.from },
        { source: "diff", pointer: `${base}/to`, elementId: relation.to },
      ];
      const contradictions: ReconciliationContradiction[] = [];
      const inBefore = beforeRelations.has(relationIdentity(relation));
      const inAfter = afterRelations.has(relationIdentity(relation));
      const exportSide = (
        source: "before" | "after",
      ): ComparisonEvidenceReference => ({
        source,
        pointer: "/data/relations",
      });
      if (direction === "added") {
        if (before.completeness === "complete" && inBefore)
          contradictions.push({
            detail:
              "listed as an added relation but already present in the complete before export",
            evidence: [...diffEvidence, exportSide("before")],
          });
        if (after.completeness === "complete" && !inAfter)
          contradictions.push({
            detail:
              "listed as an added relation but absent from the complete after export",
            evidence: [...diffEvidence, exportSide("after")],
          });
      } else {
        if (before.completeness === "complete" && !inBefore)
          contradictions.push({
            detail:
              "listed as a removed relation but absent from the complete before export",
            evidence: [...diffEvidence, exportSide("before")],
          });
        if (after.completeness === "complete" && inAfter)
          contradictions.push({
            detail:
              "listed as a removed relation but still present in the complete after export",
            evidence: [...diffEvidence, exportSide("after")],
          });
      }
      return {
        direction,
        index,
        type: relation.type,
        from: relation.from,
        to: relation.to,
        fromBeforeIndex: beforeIndex.get(relation.from) ?? null,
        fromAfterIndex: afterIndex.get(relation.from) ?? null,
        toBeforeIndex: beforeIndex.get(relation.to) ?? null,
        toAfterIndex: afterIndex.get(relation.to) ?? null,
        contradictions,
      };
    }),
  );

  // A removed finding pairs with an added finding for the same rule and the
  // same element set when the message differs — the diff-visible shape of a
  // reworded finding (removal plus addition). Each added finding pairs with
  // at most one removed finding. Both the queue and the removed indexes are
  // sorted by message before pairing so the assignment cannot depend on the
  // diff's array order; `index` breaks ties between identical messages.
  const addedFindingQueues = new Map<string, number[]>();
  diff.data.findings.added.forEach((finding, index) => {
    const key = JSON.stringify([finding.rule, [...finding.elementIds].sort()]);
    const queue = addedFindingQueues.get(key);
    if (queue === undefined) addedFindingQueues.set(key, [index]);
    else queue.push(index);
  });
  for (const queue of addedFindingQueues.values())
    queue.sort(
      (a, b) =>
        byString(
          diff.data.findings.added[a].message,
          diff.data.findings.added[b].message,
        ) || a - b,
    );
  const counterpartOf = new Map<number, number>();
  const removedIndexes = diff.data.findings.removed
    .map((_, index) => index)
    .sort(
      (a, b) =>
        byString(
          findingIdentity(diff.data.findings.removed[a]),
          findingIdentity(diff.data.findings.removed[b]),
        ) || a - b,
    );
  for (const index of removedIndexes) {
    const finding = diff.data.findings.removed[index];
    const queue =
      addedFindingQueues.get(
        JSON.stringify([finding.rule, [...finding.elementIds].sort()]),
      ) ?? [];
    const position = queue.findIndex(
      (i) => diff.data.findings.added[i].message !== finding.message,
    );
    if (position !== -1) counterpartOf.set(index, queue.splice(position, 1)[0]);
  }
  // Finding presence is checked on the full identity (rule, message,
  // element ids): a reworded message is a different finding, not a
  // contradiction.
  const exportFindingIdentity = (finding: {
    rule: string;
    message: string;
    elementIds: readonly string[];
  }): string =>
    JSON.stringify([
      finding.rule,
      finding.message,
      [...finding.elementIds].sort(),
    ]);
  const beforeFindings = new Set(
    before.data.findings.map(exportFindingIdentity),
  );
  const afterFindings = new Set(after.data.findings.map(exportFindingIdentity));
  const findings: FindingReconciliation[] = (
    ["added", "removed"] as const
  ).flatMap((direction) =>
    diff.data.findings[direction].map((finding, index) => {
      const base = `/data/findings/${direction}/${index}`;
      const diffEvidence: ComparisonEvidenceReference[] = [
        { source: "diff", pointer: `${base}/rule` },
        { source: "diff", pointer: `${base}/message` },
        { source: "diff", pointer: `${base}/elementIds` },
      ];
      const contradictions: ReconciliationContradiction[] = [];
      const inBefore = beforeFindings.has(exportFindingIdentity(finding));
      const inAfter = afterFindings.has(exportFindingIdentity(finding));
      const exportSide = (
        source: "before" | "after",
      ): ComparisonEvidenceReference => ({
        source,
        pointer: "/data/findings",
      });
      if (direction === "added") {
        if (before.completeness === "complete" && inBefore)
          contradictions.push({
            detail:
              "listed as an added finding but already present in the complete before export",
            evidence: [...diffEvidence, exportSide("before")],
          });
        if (after.completeness === "complete" && !inAfter)
          contradictions.push({
            detail:
              "listed as an added finding but absent from the complete after export",
            evidence: [...diffEvidence, exportSide("after")],
          });
      } else {
        if (before.completeness === "complete" && !inBefore)
          contradictions.push({
            detail:
              "listed as a removed finding but absent from the complete before export",
            evidence: [...diffEvidence, exportSide("before")],
          });
        if (after.completeness === "complete" && inAfter)
          contradictions.push({
            detail:
              "listed as a removed finding but still present in the complete after export",
            evidence: [...diffEvidence, exportSide("after")],
          });
      }
      return {
        direction,
        index,
        rule: finding.rule,
        message: finding.message,
        elementIds: finding.elementIds,
        elementIndexes: finding.elementIds.map((id) => ({
          id,
          beforeIndex: beforeIndex.get(id) ?? null,
          afterIndex: afterIndex.get(id) ?? null,
        })),
        counterpart:
          direction === "removed" ? (counterpartOf.get(index) ?? null) : null,
        contradictions,
      };
    }),
  );

  // Sort by stable identifying fields so a permutation of the diff arrays
  // does not reorder claims; `index` keeps evidence pointers bound to the
  // original record and breaks ties between identical records.
  const relationsSorted = [...relations].sort(
    (a, b) =>
      byString(a.from, b.from) ||
      byString(a.to, b.to) ||
      byString(a.type, b.type) ||
      a.index - b.index,
  );
  const findingsSorted = [...findings].sort(
    (a, b) =>
      byString(a.direction, b.direction) ||
      byString(findingIdentity(a), findingIdentity(b)) ||
      a.index - b.index,
  );

  return {
    before,
    after,
    diff,
    elements,
    relations: relationsSorted,
    findings: findingsSorted,
    documentContradictions,
  };
}
