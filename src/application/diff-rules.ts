import type {
  Claim,
  ClaimProvenance,
  EvidenceReference,
} from "../domain/claim.js";
import { sanitizeText } from "../domain/sanitize.js";
import type { PflDiffDocument, PflFinding } from "../input/pfl-export.js";

/** One descriptive rule over a `pfl diff` A → B comparison document. */
export interface DiffClaimRule {
  readonly id: string;
  readonly description: string;
  readonly evaluate: (input: PflDiffDocument) => readonly Claim[];
}

function provenance(input: PflDiffDocument, ruleId: string): ClaimProvenance {
  return {
    sourceFile: input.sourcePath,
    exportVersion: input.pflVersion,
    transform: ["pfl-export-envelope", `rule:${ruleId}`],
  };
}

function makeClaim(
  input: PflDiffDocument,
  ruleId: string,
  claim: string,
  evidence: readonly EvidenceReference[],
  confidence: number,
): Claim {
  return {
    claim: sanitizeText(claim),
    ruleId,
    evidence,
    provenance: provenance(input, ruleId),
    confidence,
  };
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

const SEMANTIC_RELATIONS: Readonly<Record<string, string>> = {
  shadows: "shadows",
  overrides: "overrides",
  "accumulates-with": "accumulates with",
};

function relationSentence(relation: {
  readonly type: string;
  readonly from: string;
  readonly to: string;
}): string {
  const semantic = SEMANTIC_RELATIONS[relation.type];
  if (semantic !== undefined)
    return `element '${relation.from}' ${semantic} element '${relation.to}'`;
  return `a '${relation.type}' relation from element '${relation.from}' to element '${relation.to}' (legacy type; semantics not interpreted)`;
}

function relationEvidence(
  side: "added" | "removed",
  index: number,
  relation: { readonly from: string; readonly to: string },
): EvidenceReference[] {
  const base = `/data/relations/${side}/${index}`;
  return [
    { pointer: `${base}/type` },
    { pointer: `${base}/from`, elementId: relation.from },
    { pointer: `${base}/to`, elementId: relation.to },
  ];
}

const MAX_LISTED_FINDING_IDS = 5;

function findingList(elementIds: readonly string[]): string {
  const shown = elementIds
    .slice(0, MAX_LISTED_FINDING_IDS)
    .map((id) => `'${id}'`)
    .join(", ");
  const rest = elementIds.length - MAX_LISTED_FINDING_IDS;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

function findingKey(finding: PflFinding): string {
  return JSON.stringify([finding.rule, [...finding.elementIds].sort()]);
}

function pairQueues(findings: readonly PflFinding[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  findings.forEach((finding, index) => {
    const key = findingKey(finding);
    const queue = map.get(key);
    if (queue === undefined) map.set(key, [index]);
    else queue.push(index);
  });
  return map;
}

function takePair(
  queues: Map<string, number[]>,
  finding: PflFinding,
): number | undefined {
  const queue = queues.get(findingKey(finding));
  return queue === undefined || queue.length === 0 ? undefined : queue.shift();
}

export const DIFF_RULES: readonly DiffClaimRule[] = [
  {
    id: "diff-described",
    description:
      "States the comparison's direction (A → B), runtime, and the snapshot identifiers on each side.",
    evaluate: (input) => {
      const data = input.data;
      return [
        makeClaim(
          input,
          "diff-described",
          `The diff compares snapshot '${data.resolvedSnapshotIdA}' (observed '${data.observedSnapshotIdA}') to '${data.resolvedSnapshotIdB}' (observed '${data.observedSnapshotIdB}') for runtime '${data.runtime}'.`,
          [
            { pointer: "/data/runtime" },
            { pointer: "/data/resolvedSnapshotIdA" },
            { pointer: "/data/resolvedSnapshotIdB" },
            { pointer: "/data/observedSnapshotIdA" },
            { pointer: "/data/observedSnapshotIdB" },
          ],
          1,
        ),
      ];
    },
  },
  {
    id: "diff-interpretation-provenance",
    description:
      "Reports which classifier version produced each side's interpretation and whether it was stored or recomputed.",
    evaluate: (input) => {
      const { a, b } = input.data.interpretation;
      return [
        makeClaim(
          input,
          "diff-interpretation-provenance",
          `Side A's interpretation was produced by classifier version '${a.classifierVersion}' with origin '${a.origin}'; side B's by classifier version '${b.classifierVersion}' with origin '${b.origin}'.`,
          [
            { pointer: "/data/interpretation/a" },
            { pointer: "/data/interpretation/b" },
          ],
          1,
        ),
      ];
    },
  },
  {
    id: "diff-element-added",
    description:
      "Each element id present only on side B, or a no-addition statement citing the count field.",
    evaluate: (input) => {
      const { addedIds } = input.data.structural;
      if (addedIds.length === 0)
        return [
          makeClaim(
            input,
            "diff-element-added",
            "The diff reports no elements present only in snapshot B.",
            [{ pointer: "/data/structural/added" }],
            1,
          ),
        ];
      return addedIds.map((id, index) =>
        makeClaim(
          input,
          "diff-element-added",
          `Element '${id}' is present in snapshot B with no counterpart in snapshot A.`,
          [
            {
              pointer: `/data/structural/addedIds/${index}`,
              elementId: id,
            },
          ],
          1,
        ),
      );
    },
  },
  {
    id: "diff-element-removed",
    description:
      "Each element id present only on side A, or a no-removal statement citing the count field.",
    evaluate: (input) => {
      const { removedIds } = input.data.structural;
      if (removedIds.length === 0)
        return [
          makeClaim(
            input,
            "diff-element-removed",
            "The diff reports no elements present only in snapshot A.",
            [{ pointer: "/data/structural/removed" }],
            1,
          ),
        ];
      return removedIds.map((id, index) =>
        makeClaim(
          input,
          "diff-element-removed",
          `Element '${id}' was present in snapshot A and is absent from snapshot B.`,
          [
            {
              pointer: `/data/structural/removedIds/${index}`,
              elementId: id,
            },
          ],
          1,
        ),
      );
    },
  },
  {
    id: "diff-element-changed",
    description:
      "Each element id present on both sides whose content pfl marks as changed, or a no-change statement citing the count field.",
    evaluate: (input) => {
      const { changedIds } = input.data.structural;
      if (changedIds.length === 0)
        return [
          makeClaim(
            input,
            "diff-element-changed",
            "The diff reports no elements whose content changed between the snapshots.",
            [{ pointer: "/data/structural/changed" }],
            1,
          ),
        ];
      return changedIds.map((id, index) =>
        makeClaim(
          input,
          "diff-element-changed",
          `Element '${id}' is present in both snapshots and pfl marks its content as changed.`,
          [
            {
              pointer: `/data/structural/changedIds/${index}`,
              elementId: id,
            },
          ],
          1,
        ),
      );
    },
  },
  {
    id: "diff-effective-totals",
    description:
      "The aggregate effective-status counters, with the caveat that they include added/removed elements and need not equal the status-change record count.",
    evaluate: (input) => {
      const { effective } = input.data;
      return [
        makeClaim(
          input,
          "diff-effective-totals",
          `Between the snapshots, ${effective.newlyEffective} element(s) became effective and ${effective.noLongerEffective} stopped being effective — where effective means potentially effective in the static environment — and ${effective.activationChanged} changed activation; these totals include elements added or removed between snapshots, so they need not equal the number of status-change records.`,
          [
            { pointer: "/data/effective/newlyEffective" },
            { pointer: "/data/effective/noLongerEffective" },
            { pointer: "/data/effective/activationChanged" },
          ],
          1,
        ),
      ];
    },
  },
  {
    id: "diff-status-transition",
    description:
      "Each recorded resolved-status transition A → B, linked to the changed-id list only when the same id appears there.",
    evaluate: (input) => {
      const { statusChanges } = input.data.effective;
      const changedIndex = new Map(
        input.data.structural.changedIds.map((id, i) => [id, i]),
      );
      return statusChanges.map((change, index) => {
        const from =
          change.from === null
            ? "no resolved status in A"
            : `'${change.from}' in A`;
        const to =
          change.to === null
            ? "no resolved status in B"
            : `'${change.to}' in B`;
        const evidence: EvidenceReference[] = [
          {
            pointer: `/data/effective/statusChanges/${index}/id`,
            elementId: change.id,
          },
          { pointer: `/data/effective/statusChanges/${index}/from` },
          { pointer: `/data/effective/statusChanges/${index}/to` },
        ];
        let linked = "";
        const ci = changedIndex.get(change.id);
        if (ci !== undefined) {
          linked = "; it is also listed among the changed element ids";
          evidence.push({ pointer: `/data/structural/changedIds/${ci}` });
        }
        return makeClaim(
          input,
          "diff-status-transition",
          `Element '${change.id}' resolved status went from ${from} to ${to}${linked}.`,
          evidence,
          1,
        );
      });
    },
  },
  {
    id: "diff-facet-delta",
    description:
      "Each recorded facet delta A → B as an aggregate count change never attributed to an individual element.",
    evaluate: (input) =>
      Object.entries(input.data.facetDeltas).map(([facet, delta]) => {
        const movement =
          delta === 0
            ? "is unchanged"
            : delta > 0
              ? `increased by ${delta}`
              : `decreased by ${-delta}`;
        return makeClaim(
          input,
          "diff-facet-delta",
          `The count of elements carrying facet '${facet}' ${movement} from A to B; this is an aggregate delta pfl computed across the snapshots and is not attributable to an individual element.`,
          [{ pointer: `/data/facetDeltas/${escapePointer(facet)}` }],
          1,
        );
      }),
  },
  {
    id: "diff-relation-added",
    description:
      "Each relation present on side B but not on side A, with direction; legacy types are reported without interpreting semantics.",
    evaluate: (input) =>
      input.data.relations.added.map((relation, index) =>
        makeClaim(
          input,
          "diff-relation-added",
          `Present in B but not in A: ${relationSentence(relation)}.`,
          relationEvidence("added", index, relation),
          1,
        ),
      ),
  },
  {
    id: "diff-relation-removed",
    description:
      "Each relation present on side A but not on side B, with direction; legacy types are reported without interpreting semantics.",
    evaluate: (input) =>
      input.data.relations.removed.map((relation, index) =>
        makeClaim(
          input,
          "diff-relation-removed",
          `Present in A but not in B: ${relationSentence(relation)}.`,
          relationEvidence("removed", index, relation),
          1,
        ),
      ),
  },
  {
    id: "diff-finding-added",
    description:
      "Each finding present on side B but not on side A; a same-rule, same-elements removal is noted as a reworded pair.",
    evaluate: (input) => {
      const removedPairs = pairQueues(input.data.findings.removed);
      return input.data.findings.added.map((finding, index) => {
        const evidence: EvidenceReference[] = [
          { pointer: `/data/findings/added/${index}/rule` },
          { pointer: `/data/findings/added/${index}/message` },
          { pointer: `/data/findings/added/${index}/elementIds` },
          ...finding.elementIds
            .slice(0, MAX_LISTED_FINDING_IDS)
            .map((id, j) => ({
              pointer: `/data/findings/added/${index}/elementIds/${j}`,
              elementId: id,
            })),
        ];
        let paired = "";
        const pairedIndex = takePair(removedPairs, finding);
        if (pairedIndex !== undefined) {
          paired =
            "; a removed finding with the same rule and element references exists — pfl treats a reworded finding as an add-plus-remove pair, so this does not by itself prove a harness change";
          evidence.push({
            pointer: `/data/findings/removed/${pairedIndex}`,
          });
        }
        const ids =
          finding.elementIds.length === 0
            ? "citing no elements"
            : `citing elements ${findingList(finding.elementIds)}`;
        return makeClaim(
          input,
          "diff-finding-added",
          `A finding from rule '${finding.rule}' appears in B but not in A, ${ids}: ${finding.message}${paired}.`,
          evidence,
          1,
        );
      });
    },
  },
  {
    id: "diff-finding-removed",
    description:
      "Each finding present on side A but not on side B; a same-rule, same-elements addition is noted as a reworded pair.",
    evaluate: (input) => {
      const addedPairs = pairQueues(input.data.findings.added);
      return input.data.findings.removed.map((finding, index) => {
        const evidence: EvidenceReference[] = [
          { pointer: `/data/findings/removed/${index}/rule` },
          { pointer: `/data/findings/removed/${index}/message` },
          { pointer: `/data/findings/removed/${index}/elementIds` },
          ...finding.elementIds
            .slice(0, MAX_LISTED_FINDING_IDS)
            .map((id, j) => ({
              pointer: `/data/findings/removed/${index}/elementIds/${j}`,
              elementId: id,
            })),
        ];
        let paired = "";
        const pairedIndex = takePair(addedPairs, finding);
        if (pairedIndex !== undefined) {
          paired =
            "; an added finding with the same rule and element references exists — pfl treats a reworded finding as an add-plus-remove pair, so this does not by itself prove a harness change";
          evidence.push({ pointer: `/data/findings/added/${pairedIndex}` });
        }
        const ids =
          finding.elementIds.length === 0
            ? "citing no elements"
            : `citing elements ${findingList(finding.elementIds)}`;
        return makeClaim(
          input,
          "diff-finding-removed",
          `A finding from rule '${finding.rule}' appears in A but not in B, ${ids}: ${finding.message}${paired}.`,
          evidence,
          1,
        );
      });
    },
  },
  {
    id: "diff-version-note",
    description:
      "Each version note pfl recorded, quoted as a prose comparison caveat rather than a machine code.",
    evaluate: (input) =>
      input.data.versionNotes.map((note, index) =>
        makeClaim(
          input,
          "diff-version-note",
          `The diff records a comparison caveat: '${note}'.`,
          [{ pointer: `/data/versionNotes/${index}` }],
          1,
        ),
      ),
  },
  {
    id: "diff-comparison-caveats",
    description:
      "Caveats derived from per-side interpretation provenance: recomputed origins and differing classifier versions.",
    evaluate: (input) => {
      const { a, b } = input.data.interpretation;
      const claims: Claim[] = [];
      for (const [side, label] of [
        [a, "A"],
        [b, "B"],
      ] as const) {
        if (side.origin === "recomputed")
          claims.push(
            makeClaim(
              input,
              "diff-comparison-caveats",
              `Side ${label}'s interpretation was recomputed rather than stored, so its interpretation-level facts were regenerated for this comparison.`,
              [
                {
                  pointer: `/data/interpretation/${label.toLowerCase()}/origin`,
                },
              ],
              1,
            ),
          );
      }
      if (a.classifierVersion !== b.classifierVersion)
        claims.push(
          makeClaim(
            input,
            "diff-comparison-caveats",
            `The sides were interpreted by different classifier versions ('${a.classifierVersion}' vs '${b.classifierVersion}'), so interpretation-level differences may reflect the classifier change rather than a harness change.`,
            [
              { pointer: "/data/interpretation/a/classifierVersion" },
              { pointer: "/data/interpretation/b/classifierVersion" },
            ],
            1,
          ),
        );
      return claims;
    },
  },
  {
    id: "diagnostic-reported",
    description:
      "Reports each warning or error diagnostic the diff carries: code, message, and path.",
    evaluate: (input) =>
      input.diagnostics.flatMap((diagnostic, index) => {
        if (
          diagnostic.severity !== "warning" &&
          diagnostic.severity !== "error"
        )
          return [];
        const atPath =
          diagnostic.path === undefined ? "" : ` at '${diagnostic.path}'`;
        return [
          makeClaim(
            input,
            "diagnostic-reported",
            `The diff reports diagnostic '${diagnostic.code}' (${diagnostic.severity})${atPath}: ${diagnostic.message}`,
            [{ pointer: `/diagnostics/${index}` }],
            1,
          ),
        ];
      }),
  },
  {
    id: "completeness-reported",
    description:
      "Reports when the diff is not complete and how many diagnostics it carries.",
    evaluate: (input) => {
      if (input.completeness === "complete") return [];
      return [
        makeClaim(
          input,
          "completeness-reported",
          `The diff is marked '${input.completeness}' with ${input.diagnostics.length} diagnostic(s) recorded.`,
          [{ pointer: "/completeness" }, { pointer: "/diagnostics" }],
          1,
        ),
      ];
    },
  },
];
