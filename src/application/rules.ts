import type {
  Claim,
  ClaimProvenance,
  EvidenceReference,
} from "../domain/claim.js";
import { sanitizeText } from "../domain/sanitize.js";
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
  const data = input.data;
  const text = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : sanitizeText(value);
  return {
    sourceFile: input.sourcePath,
    exportVersion: input.pflVersion,
    transform: ["pfl-report-envelope", `rule:${ruleId}`],
    classifierVersion: sanitizeText(data.interpretation.classifierVersion),
    interpretationOrigin: data.interpretation.origin,
    observedSnapshotId: text(data.observedSnapshotId),
    resolvedSnapshotId: text(data.resolvedSnapshotId),
    runtimeName: text(data.runtimeName),
  };
}

/** Confidence for stats-derived claims: 1 only when completeness is "complete". */
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
    claim: sanitizeText(claim),
    ruleId,
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
    id: "diagnostic-reported",
    description:
      "Reports each warning or error diagnostic the export carries: code, message, and path.",
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
            `The export reports diagnostic '${diagnostic.code}' (${diagnostic.severity})${atPath}: ${diagnostic.message}`,
            [{ pointer: `/diagnostics/${index}` }],
            1,
          ),
        ];
      }),
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
  {
    id: "observation-status",
    description:
      "Explains how to read the report's observation status: completeness, diagnostic counts by severity, and interpretation origin.",
    evaluate: (input) => {
      const counts = { info: 0, warning: 0, error: 0 };
      for (const diagnostic of input.diagnostics)
        counts[diagnostic.severity] += 1;
      const diagnosticsText =
        input.diagnostics.length === 0
          ? "no diagnostics"
          : `${input.diagnostics.length} diagnostic(s) (${counts.info} info, ${counts.warning} warning, ${counts.error} error)`;
      const interpretation = input.data.interpretation;
      return [
        makeClaim(
          input,
          "observation-status",
          `The export reports completeness '${input.completeness}' with ${diagnosticsText}; the interpretation was produced by classifier version '${interpretation.classifierVersion}' with origin '${interpretation.origin}'.`,
          [
            { pointer: "/completeness" },
            { pointer: "/diagnostics" },
            { pointer: "/data/interpretation" },
          ],
          1,
        ),
      ];
    },
  },
];
