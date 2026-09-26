import type {
  Claim,
  ClaimProvenance,
  EvidenceReference,
} from "../domain/claim.js";
import { sanitizeText } from "../domain/sanitize.js";
import type { PflDiffDocument } from "../input/pfl-export.js";

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
