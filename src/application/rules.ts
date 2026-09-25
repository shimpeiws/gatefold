import type {
  Claim,
  ClaimProvenance,
  EvidenceReference,
} from "../domain/claim.js";
import type { PflExport } from "../input/pfl-export.js";

/** One descriptive rule. Emits zero or more claims; never judges quality. */
export interface ClaimRule {
  readonly id: string;
  readonly description: string;
  readonly evaluate: (input: PflExport) => readonly Claim[];
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function provenance(input: PflExport, ruleId: string): ClaimProvenance {
  return {
    sourceFile: input.sourcePath,
    exportVersion: input.pflVersion,
    transform: ["pfl-report-envelope", `rule:${ruleId}`],
  };
}

/** Confidence for claims derived from stats: full unless the export is partial. */
function statsConfidence(input: PflExport): number {
  return input.completeness === "complete" ? 1 : 0.8;
}

function makeClaim(
  input: PflExport,
  ruleId: string,
  claim: string,
  evidence: readonly EvidenceReference[],
  confidence: number,
): Claim {
  return {
    claim,
    evidence,
    provenance: provenance(input, ruleId),
    confidence,
  };
}

export const RULES: readonly ClaimRule[] = [
  {
    id: "runtime-described",
    description: "States which runtime and project the export describes.",
    evaluate: (input) => [
      makeClaim(
        input,
        "runtime-described",
        `The export describes a '${input.data.runtime}' harness for project '${input.data.project.displayName}'.`,
        [
          { pointer: "/data/runtime" },
          { pointer: "/data/project/displayName" },
        ],
        1,
      ),
    ],
  },
  {
    id: "element-counts",
    description:
      "Reports the observed/effective/shadowed/conditional/opaque element counts.",
    evaluate: (input) => {
      const stats = input.data.stats;
      return [
        makeClaim(
          input,
          "element-counts",
          `pfl observed ${stats.observed} elements: ${stats.effective} effective, ${stats.shadowed} shadowed, ${stats.conditional} conditional, ${stats.opaque} opaque.`,
          [{ pointer: "/data/stats" }],
          statsConfidence(input),
        ),
      ];
    },
  },
  {
    id: "facet-composition",
    description:
      "Reports the per-facet element counts when the export carries byFacet stats.",
    evaluate: (input) => {
      const byFacet = input.data.stats.byFacet ?? {};
      return Object.keys(byFacet)
        .sort()
        .map((facet) =>
          makeClaim(
            input,
            "facet-composition",
            `The harness declares ${byFacet[facet]} '${facet}' element(s).`,
            [{ pointer: `/data/stats/byFacet/${escapePointer(facet)}` }],
            statsConfidence(input),
          ),
        );
    },
  },
  {
    id: "finding-reported",
    description:
      "Reports each pfl finding with its rule id, message, and cited elements.",
    evaluate: (input) =>
      input.data.findings.map((finding, index) =>
        makeClaim(
          input,
          "finding-reported",
          `The export reports a '${finding.rule}' finding: ${finding.message}`,
          [
            { pointer: `/data/findings/${index}` },
            ...finding.elementIds.map((elementId, elementIndex) => ({
              pointer: `/data/findings/${index}/elementIds/${elementIndex}`,
              elementId,
            })),
          ],
          1,
        ),
      ),
  },
  {
    id: "completeness-reported",
    description:
      "Reports when the export is not complete and how many diagnostics it carries.",
    evaluate: (input) => {
      if (input.completeness === "complete") return [];
      return [
        makeClaim(
          input,
          "completeness-reported",
          `The export is marked '${input.completeness}' with ${input.diagnostics.length} diagnostic(s) recorded.`,
          [{ pointer: "/completeness" }, { pointer: "/diagnostics" }],
          1,
        ),
      ];
    },
  },
];
