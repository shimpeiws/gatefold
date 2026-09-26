import type {
  Claim,
  ClaimProvenance,
  EvidenceReference,
} from "../domain/claim.js";
import { sanitizeText } from "../domain/sanitize.js";
import type { PflExportDocument } from "../input/pfl-export.js";

/** One descriptive rule over a `pfl export` full-snapshot document. */
export interface ExportClaimRule {
  readonly id: string;
  readonly description: string;
  readonly evaluate: (input: PflExportDocument) => readonly Claim[];
}

function provenance(input: PflExportDocument, ruleId: string): ClaimProvenance {
  const data = input.data;
  return {
    sourceFile: input.sourcePath,
    exportVersion: input.pflVersion,
    transform: ["pfl-export-envelope", `rule:${ruleId}`],
    classifierVersion: sanitizeText(data.interpretation.classifier.version),
    interpretationOrigin: data.interpretation.origin,
    observedSnapshotId: sanitizeText(data.snapshot.observedSnapshotId),
    resolvedSnapshotId: sanitizeText(data.snapshot.resolvedSnapshotId),
  };
}

/** Confidence for count claims: 1 only when completeness is "complete". */
function countsConfidence(input: PflExportDocument): number {
  return input.completeness === "complete" ? 1 : 0.8;
}

function makeClaim(
  input: PflExportDocument,
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

export const EXPORT_RULES: readonly ExportClaimRule[] = [
  {
    id: "export-described",
    description:
      "States which runtime, adapter, and project the export describes.",
    evaluate: (input) => {
      const runtime = input.data.runtime;
      return [
        makeClaim(
          input,
          "export-described",
          `The export describes a '${runtime.id}' harness for project '${input.data.project.displayName}' via adapter '${runtime.adapter.id}' version '${runtime.adapter.version}' (runtime compatibility '${runtime.adapter.runtimeCompatibility}').`,
          [
            { pointer: "/data/runtime/id" },
            { pointer: "/data/runtime/adapter" },
            { pointer: "/data/project/displayName" },
          ],
          1,
        ),
      ];
    },
  },
  {
    id: "export-snapshot-contents",
    description:
      "Reports how many joined elements, relations, and findings the export carries, and how many elements carry each nullable layer.",
    evaluate: (input) => {
      const elements = input.data.elements;
      const resolvedCount = elements.filter(
        (element) => element.resolved !== null,
      ).length;
      const interpretationCount = elements.filter(
        (element) => element.interpretation !== null,
      ).length;
      return [
        makeClaim(
          input,
          "export-snapshot-contents",
          `The export joins ${elements.length} element(s) by id — ${resolvedCount} with a resolved layer and ${interpretationCount} with an interpretation — alongside ${input.data.relations.length} relation(s) and ${input.data.findings.length} finding(s).`,
          [
            { pointer: "/data/elements" },
            { pointer: "/data/relations" },
            { pointer: "/data/findings" },
          ],
          countsConfidence(input),
        ),
      ];
    },
  },
  {
    id: "export-interpretation-provenance",
    description:
      "Reports which classifier produced the export's interpretation and with which resolution semantics and confidence.",
    evaluate: (input) => {
      const interpretation = input.data.interpretation;
      const resolution = input.data.resolution;
      return [
        makeClaim(
          input,
          "export-interpretation-provenance",
          `The export's interpretation was produced by classifier '${interpretation.classifier.id}' version '${interpretation.classifier.version}' with origin '${interpretation.origin}'; resolution used semantics version '${resolution.semanticsVersion}' with confidence '${resolution.confidence}'.`,
          [
            { pointer: "/data/interpretation" },
            { pointer: "/data/resolution" },
          ],
          1,
        ),
      ];
    },
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
];
