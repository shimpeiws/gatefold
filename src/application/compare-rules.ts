import type {
  ComparisonClaim,
  ComparisonEvidenceReference,
} from "../domain/comparison.js";
import { sanitizeText } from "../domain/sanitize.js";
import type {
  PflExportDocument,
  PflSnapshotElement,
} from "../input/pfl-export.js";
import type { ComparisonView, ElementReconciliation } from "./reconcile.js";

/** One comparison claim rule, evaluated against the reconciled view. */
export interface CompareRule {
  readonly ruleId: string;
  evaluate(view: ComparisonView): readonly ComparisonClaim[];
}

const SOURCE_ORDER: Record<string, number> = { before: 0, after: 1, diff: 2 };

/** Sorts evidence per contract: source (before < after < diff), then pointer. */
function sortEvidence(
  evidence: readonly ComparisonEvidenceReference[],
): ComparisonEvidenceReference[] {
  return [...evidence].sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0),
  );
}

function claim(
  ruleId: string,
  text: string,
  evidence: readonly ComparisonEvidenceReference[],
  confidence = 1,
): ComparisonClaim {
  return {
    claim: sanitizeText(text),
    ruleId,
    evidence: sortEvidence(evidence),
    provenance: { transform: ["compare-reconcile", `rule:${ruleId}`] },
    confidence,
  };
}

/**
 * Descriptive context for one element on one side: observed layer, resolved
 * layer, interpretation layer. Absent layers are stated as "no entry" and
 * never attributed properties.
 */
function describeElement(
  document: PflExportDocument,
  index: number,
  source: "before" | "after",
  side: "A" | "B",
): { text: string; evidence: ComparisonEvidenceReference[] } {
  const element: PflSnapshotElement = document.data.elements[index];
  const at = `/data/elements/${index}`;
  const elementId = element.id;
  const evidence: ComparisonEvidenceReference[] = [
    { source, pointer: `${at}/id`, elementId },
    { source, pointer: `${at}/observed/native/kind`, elementId },
    { source, pointer: `${at}/observed/native/origin`, elementId },
    { source, pointer: `${at}/observed/status`, elementId },
  ];
  let text =
    `in ${side} it is observed as kind '${element.observed.native.kind}' ` +
    `from origin '${element.observed.native.origin}' with observed status ` +
    `'${element.observed.status}'`;
  if (element.resolved === null) text += "; it has no resolved entry";
  else {
    const qualified =
      element.resolved.status === "effective"
        ? "'effective' (potentially effective in the static environment, " +
          "not evidence that an agent used it)"
        : `'${element.resolved.status}'`;
    text += `; it resolves as ${qualified} with activation '${element.resolved.activation}'`;
    evidence.push(
      { source, pointer: `${at}/resolved/status`, elementId },
      { source, pointer: `${at}/resolved/activation`, elementId },
    );
  }
  if (element.interpretation === null)
    text += "; it has no interpretation entry";
  else {
    const facets = element.interpretation.facets;
    text +=
      facets.length === 0
        ? `; the classifier recorded no facets (confidence '${element.interpretation.confidence}')`
        : `; the classifier assigns facets ${facets.map((f) => `'${f}'`).join(", ")} (confidence '${element.interpretation.confidence}')`;
    evidence.push(
      { source, pointer: `${at}/interpretation/facets`, elementId },
      { source, pointer: `${at}/interpretation/confidence`, elementId },
    );
  }
  return { text, evidence };
}

function diffListPointer(
  element: ElementReconciliation,
): ComparisonEvidenceReference | null {
  if (element.structuralIndex === null || element.structural === "none")
    return null;
  const list = {
    added: "addedIds",
    removed: "removedIds",
    changed: "changedIds",
  }[element.structural];
  return {
    source: "diff",
    pointer: `/data/structural/${list}/${element.structuralIndex}`,
    elementId: element.id,
  };
}

/**
 * Context statement for a side where the export may lack the element:
 * partial or unknown completeness means absence may be unobserved.
 */
function absentContext(
  completeness: PflExportDocument["completeness"],
  side: "A" | "B",
): string {
  return completeness === "complete"
    ? `the ${side} export contains no element with this id`
    : `the ${side} export does not record an element with this id, but it was captured with completeness '${completeness}' so absence may be unobserved`;
}

/**
 * Claim rules for `gatefold compare`, in deterministic emission order
 * (docs/v0.4-scope.md). Element claims (#35); relation/finding claims (#36)
 * extend this list.
 */
export const COMPARE_RULES: readonly CompareRule[] = [
  {
    ruleId: "compare-inputs",
    evaluate: (view) => [
      claim(
        "compare-inputs",
        `The three documents describe one A → B comparison of project ` +
          `'${view.before.data.project.id}' on runtime ` +
          `'${view.before.data.runtime.id}': A is observed snapshot ` +
          `'${view.diff.data.observedSnapshotIdA}' (resolved ` +
          `'${view.diff.data.resolvedSnapshotIdA}') and B is observed ` +
          `'${view.diff.data.observedSnapshotIdB}' (resolved ` +
          `'${view.diff.data.resolvedSnapshotIdB}').`,
        [
          {
            source: "before",
            pointer: "/data/snapshot/observedSnapshotId",
          },
          {
            source: "before",
            pointer: "/data/snapshot/resolvedSnapshotId",
          },
          { source: "before", pointer: "/data/project/id" },
          { source: "before", pointer: "/data/runtime/id" },
          { source: "after", pointer: "/data/snapshot/observedSnapshotId" },
          { source: "after", pointer: "/data/snapshot/resolvedSnapshotId" },
          { source: "diff", pointer: "/data/runtime" },
          { source: "diff", pointer: "/data/observedSnapshotIdA" },
          { source: "diff", pointer: "/data/resolvedSnapshotIdA" },
          { source: "diff", pointer: "/data/observedSnapshotIdB" },
          { source: "diff", pointer: "/data/resolvedSnapshotIdB" },
        ],
      ),
    ],
  },
  {
    ruleId: "compare-completeness",
    evaluate: (view) =>
      (
        [
          ["before", view.before, "A"],
          ["after", view.after, "B"],
          ["diff", view.diff, "the diff"],
        ] as const
      )
        .filter(([, doc]) => doc.completeness !== "complete")
        .map(([source, doc, side]) =>
          claim(
            "compare-completeness",
            `The ${source} document was captured with completeness ` +
              `'${doc.completeness}', so absence of data in ${side} may be ` +
              "unobserved rather than absent.",
            [{ source, pointer: "/completeness" }],
          ),
        ),
  },
  {
    ruleId: "compare-version-drift",
    evaluate: (view) => {
      const claims: ComparisonClaim[] = [];
      const versions = [
        view.before.pflVersion,
        view.after.pflVersion,
        view.diff.pflVersion,
      ];
      if (new Set(versions).size > 1)
        claims.push(
          claim(
            "compare-version-drift",
            `The three inputs were produced by different pfl versions ` +
              `(before '${view.before.pflVersion}', after ` +
              `'${view.after.pflVersion}', diff '${view.diff.pflVersion}').`,
            [
              { source: "before", pointer: "/pflVersion" },
              { source: "after", pointer: "/pflVersion" },
              { source: "diff", pointer: "/pflVersion" },
            ],
          ),
        );
      const beforeSemantics = view.before.data.resolution.semanticsVersion;
      const afterSemantics = view.after.data.resolution.semanticsVersion;
      if (beforeSemantics !== afterSemantics)
        claims.push(
          claim(
            "compare-version-drift",
            `The two exports used different resolution semantics versions ` +
              `(A '${beforeSemantics}', B '${afterSemantics}'), so resolved ` +
              "states are not directly comparable.",
            [
              {
                source: "before",
                pointer: "/data/resolution/semanticsVersion",
              },
              { source: "after", pointer: "/data/resolution/semanticsVersion" },
            ],
          ),
        );
      const beforeClassifier =
        view.before.data.interpretation.classifier.version;
      const afterClassifier = view.after.data.interpretation.classifier.version;
      if (beforeClassifier !== afterClassifier)
        claims.push(
          claim(
            "compare-version-drift",
            `The two exports were interpreted by different classifier ` +
              `versions (A '${beforeClassifier}', B '${afterClassifier}'), ` +
              "so facet differences may reflect the classifier change.",
            [
              {
                source: "before",
                pointer: "/data/interpretation/classifier/version",
              },
              {
                source: "after",
                pointer: "/data/interpretation/classifier/version",
              },
            ],
          ),
        );
      const beforeRuntime = view.before.data.runtime.version;
      const afterRuntime = view.after.data.runtime.version;
      if (beforeRuntime !== afterRuntime)
        claims.push(
          claim(
            "compare-version-drift",
            `The two exports were captured under different runtime versions ` +
              `(A '${beforeRuntime ?? "unknown"}', B ` +
              `'${afterRuntime ?? "unknown"}').`,
            [
              { source: "before", pointer: "/data/runtime/version" },
              { source: "after", pointer: "/data/runtime/version" },
            ],
          ),
        );
      for (const [index, note] of view.diff.data.versionNotes.entries())
        claims.push(
          claim(
            "compare-version-drift",
            `pfl recorded a version note for this diff: '${note}'.`,
            [{ source: "diff", pointer: `/data/versionNotes/${index}` }],
          ),
        );
      return claims;
    },
  },
  {
    ruleId: "compare-element-added",
    evaluate: (view) =>
      view.elements
        .filter((element) => element.structural === "added")
        .map((element) => {
          const evidence = [diffListPointer(element)!];
          let text = `The diff lists element '${element.id}' as added between A and B`;
          if (element.afterIndex !== null) {
            const side = describeElement(
              view.after,
              element.afterIndex,
              "after",
              "B",
            );
            text += `; ${side.text}`;
            evidence.push(...side.evidence);
          } else text += `; ${absentContext(view.after.completeness, "B")}`;
          if (element.beforeIndex !== null) {
            text += "; the A export also contains an element with this id";
            evidence.push({
              source: "before",
              pointer: `/data/elements/${element.beforeIndex}/id`,
              elementId: element.id,
            });
          } else text += `; ${absentContext(view.before.completeness, "A")}`;
          return claim("compare-element-added", `${text}.`, evidence);
        }),
  },
  {
    ruleId: "compare-element-removed",
    evaluate: (view) =>
      view.elements
        .filter((element) => element.structural === "removed")
        .map((element) => {
          const evidence = [diffListPointer(element)!];
          let text = `The diff lists element '${element.id}' as removed between A and B`;
          if (element.beforeIndex !== null) {
            const side = describeElement(
              view.before,
              element.beforeIndex,
              "before",
              "A",
            );
            text += `; ${side.text}`;
            evidence.push(...side.evidence);
          } else text += `; ${absentContext(view.before.completeness, "A")}`;
          if (element.afterIndex !== null) {
            text += "; the B export also contains an element with this id";
            evidence.push({
              source: "after",
              pointer: `/data/elements/${element.afterIndex}/id`,
              elementId: element.id,
            });
          } else text += `; ${absentContext(view.after.completeness, "B")}`;
          return claim("compare-element-removed", `${text}.`, evidence);
        }),
  },
  {
    ruleId: "compare-element-changed",
    evaluate: (view) =>
      view.elements
        .filter((element) => element.structural === "changed")
        .map((element) => {
          const evidence = [diffListPointer(element)!];
          let text =
            `The diff marks element '${element.id}' as changed between A ` +
            "and B";
          if (element.beforeIndex !== null) {
            const side = describeElement(
              view.before,
              element.beforeIndex,
              "before",
              "A",
            );
            text += `; ${side.text}`;
            evidence.push(...side.evidence);
          } else text += `; ${absentContext(view.before.completeness, "A")}`;
          if (element.afterIndex !== null) {
            const side = describeElement(
              view.after,
              element.afterIndex,
              "after",
              "B",
            );
            text += `; ${side.text}`;
            evidence.push(...side.evidence);
          } else text += `; ${absentContext(view.after.completeness, "B")}`;
          return claim("compare-element-changed", `${text}.`, evidence);
        }),
  },
  {
    ruleId: "compare-status-transition",
    evaluate: (view) =>
      view.elements
        .filter((element) => element.statusChange !== null)
        .map((element) => {
          const change = element.statusChange!;
          const base = `/data/effective/statusChanges/${change.index}`;
          const evidence: ComparisonEvidenceReference[] = [
            { source: "diff", pointer: `${base}/id`, elementId: element.id },
            { source: "diff", pointer: `${base}/from`, elementId: element.id },
            { source: "diff", pointer: `${base}/to`, elementId: element.id },
          ];
          const from =
            change.from === null
              ? "no resolved status in A"
              : `'${change.from}' in A`;
          const to =
            change.to === null
              ? "no resolved status in B"
              : `'${change.to}' in B`;
          let text =
            `The diff records element '${element.id}' resolved status ` +
            `going from ${from} to ${to}`;
          if (element.beforeIndex !== null) {
            const resolved =
              view.before.data.elements[element.beforeIndex].resolved;
            if (resolved !== null) {
              text += `; the before export resolves it as '${resolved.status}'`;
              evidence.push({
                source: "before",
                pointer: `/data/elements/${element.beforeIndex}/resolved/status`,
                elementId: element.id,
              });
            } else text += "; the before export has no resolved entry for it";
          } else text += `; ${absentContext(view.before.completeness, "A")}`;
          if (element.afterIndex !== null) {
            const resolved =
              view.after.data.elements[element.afterIndex].resolved;
            if (resolved !== null) {
              text += `; the after export resolves it as '${resolved.status}'`;
              evidence.push({
                source: "after",
                pointer: `/data/elements/${element.afterIndex}/resolved/status`,
                elementId: element.id,
              });
            } else text += "; the after export has no resolved entry for it";
          } else text += `; ${absentContext(view.after.completeness, "B")}`;
          if (change.to === "effective")
            text +=
              " — 'effective' means potentially effective in the static " +
              "environment, not evidence that an agent used it";
          return claim("compare-status-transition", `${text}.`, evidence);
        }),
  },
  {
    ruleId: "compare-activation-change",
    evaluate: (view) =>
      view.elements
        .filter((element) => element.activationChange !== null)
        .map((element) => {
          const change = element.activationChange!;
          return claim(
            "compare-activation-change",
            `Comparing the two exports, element '${element.id}' activation ` +
              `changed from '${change.from}' in A to '${change.to}' in B.`,
            [
              {
                source: "before",
                pointer: `/data/elements/${element.beforeIndex}/resolved/activation`,
                elementId: element.id,
              },
              {
                source: "after",
                pointer: `/data/elements/${element.afterIndex}/resolved/activation`,
                elementId: element.id,
              },
            ],
          );
        }),
  },
  {
    ruleId: "compare-facet-change",
    evaluate: (view) =>
      view.elements
        .filter((element) => element.facetChange !== null)
        .map((element) => {
          const change = element.facetChange!;
          const parts: string[] = [];
          if (change.added.length > 0)
            parts.push(`added ${change.added.map((f) => `'${f}'`).join(", ")}`);
          if (change.removed.length > 0)
            parts.push(
              `removed ${change.removed.map((f) => `'${f}'`).join(", ")}`,
            );
          return claim(
            "compare-facet-change",
            `Comparing the two exports' interpretation layers, element ` +
              `'${element.id}' facets changed between A and B: ` +
              `${parts.join("; ")}.`,
            [
              {
                source: "before",
                pointer: `/data/elements/${element.beforeIndex}/interpretation/facets`,
                elementId: element.id,
              },
              {
                source: "after",
                pointer: `/data/elements/${element.afterIndex}/interpretation/facets`,
                elementId: element.id,
              },
            ],
          );
        }),
  },
  {
    ruleId: "compare-contradiction",
    evaluate: (view) =>
      view.elements.flatMap((element) =>
        element.contradictions.map((contradiction) =>
          claim(
            "compare-contradiction",
            `The documents disagree about element '${element.id}': ` +
              `${contradiction.detail}.`,
            contradiction.evidence,
          ),
        ),
      ),
  },
];
