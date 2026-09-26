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
    id: "element-observed-state",
    description:
      "Describes each element's observed layer: identity, redacted path, native kind and origin, status, and reason. Never infers beyond the observed fields.",
    evaluate: (input) =>
      input.data.elements.map((element, index) => {
        const at = `/data/elements/${index}/observed`;
        const observed = element.observed;
        const elementId = element.id;
        const evidence: EvidenceReference[] = [
          { pointer: `/data/elements/${index}/id`, elementId },
          { pointer: `${at}/native/kind`, elementId },
          { pointer: `${at}/native/origin`, elementId },
        ];
        let text = `pfl observed element '${elementId}'`;
        if (observed.source.path !== undefined) {
          text += ` at '${observed.source.path}'`;
          evidence.push({ pointer: `${at}/source/path`, elementId });
        }
        text += ` as kind '${observed.native.kind}' from origin '${observed.native.origin}'`;
        if (observed.native.scope !== null) {
          text += ` (scope '${observed.native.scope}')`;
          evidence.push({ pointer: `${at}/native/scope`, elementId });
        }
        text += `; observed status is '${observed.status}'`;
        evidence.push({ pointer: `${at}/status`, elementId });
        if (observed.reason !== undefined) {
          text += ` ('${observed.reason}')`;
          evidence.push({ pointer: `${at}/reason`, elementId });
        }
        return makeClaim(
          input,
          "element-observed-state",
          `${text}.`,
          evidence,
          1,
        );
      }),
  },
  {
    id: "element-resolved-state",
    description:
      "Describes each element's resolved layer: status, activation, applicability, and strategy. 'effective' means potentially effective in the static environment, not proof of runtime use.",
    evaluate: (input) =>
      input.data.elements.flatMap((element, index) => {
        const resolved = element.resolved;
        if (resolved === null) return [];
        const at = `/data/elements/${index}/resolved`;
        const elementId = element.id;
        const evidence: EvidenceReference[] = [
          { pointer: `/data/elements/${index}/id`, elementId },
          { pointer: `${at}/status`, elementId },
          { pointer: `${at}/activation`, elementId },
          { pointer: `${at}/resolution/strategy`, elementId },
        ];
        const qualification =
          resolved.status === "effective"
            ? " — potentially effective in the static environment, not evidence that an agent used it"
            : "";
        let text = `The resolved layer marks element '${elementId}' as '${resolved.status}'${qualification}, activation '${resolved.activation}', strategy '${resolved.resolution.strategy}'`;
        if (resolved.applicability !== undefined) {
          const target =
            resolved.applicability.target === undefined
              ? ""
              : ` ('${resolved.applicability.target}')`;
          text += `, applicable to '${resolved.applicability.type}'${target}`;
          evidence.push({ pointer: `${at}/applicability`, elementId });
        }
        if (resolved.resolution.reason !== undefined) {
          text += `; reason: ${resolved.resolution.reason}`;
          evidence.push({ pointer: `${at}/resolution/reason`, elementId });
        }
        return [
          makeClaim(input, "element-resolved-state", `${text}.`, evidence, 1),
        ];
      }),
  },
  {
    id: "element-interpretation",
    description:
      "Describes each element's derived interpretation: assigned facets, classification confidence, and reason. A null layer means the export has no interpretation entry, not that the element has no facet.",
    evaluate: (input) =>
      input.data.elements.flatMap((element, index) => {
        const interpretation = element.interpretation;
        if (interpretation === null) return [];
        const at = `/data/elements/${index}/interpretation`;
        const elementId = element.id;
        const evidence: EvidenceReference[] = [
          { pointer: `/data/elements/${index}/id`, elementId },
          { pointer: `${at}/facets`, elementId },
          { pointer: `${at}/confidence`, elementId },
          { pointer: `${at}/reason`, elementId },
        ];
        const text =
          interpretation.facets.length === 0
            ? `The classifier recorded no facets for element '${elementId}' with confidence '${interpretation.confidence}': ${interpretation.reason}`
            : `The classifier assigned element '${elementId}' facet(s) ${interpretation.facets
                .map((facet) => `'${facet}'`)
                .join(
                  ", ",
                )} with confidence '${interpretation.confidence}': ${interpretation.reason}`;
        return [
          makeClaim(input, "element-interpretation", `${text}.`, evidence, 1),
        ];
      }),
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
