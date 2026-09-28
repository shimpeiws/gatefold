import { compareBytes } from "../domain/byte-order.js";
import type {
  PflExportDocument,
  PflFinding,
  PflSnapshotElement,
  PflSnapshotRelation,
} from "../input/pfl-export.js";

/**
 * The A → B configuration difference computed from two bound pfl export
 * documents (docs/v0.9-scope.md). yuurei never stores a `pfl diff`
 * document, so the difference is recomputed here with exactly the
 * semantics `pfl diff` applies (pfl v1.2.0 `structuralDiff`,
 * `effectiveDiff`, `relationsDiff`, `findingsDiff`, `facetDeltas`,
 * `versionNotes`): element equality compares `native.kind`,
 * `native.scope`, `source.digest`, and the canonical serialization of
 * `metadata`; finding identity is the canonical serialization of the
 * whole finding, so a reworded finding is an add plus a remove.
 */
/**
 * One tooling-version difference between the two exports. `kind` names
 * which export record the note is about, so the emitted entry cites the
 * pointer that can substantiate it rather than a shared interpretation
 * pointer.
 */
export interface CellVersionNote {
  readonly kind: "classifier" | "runtime" | "resolution";
  readonly text: string;
}

export interface CellExportDiff {
  readonly addedIds: readonly string[];
  readonly removedIds: readonly string[];
  readonly changedIds: readonly string[];
  readonly statusChanges: readonly {
    readonly id: string;
    readonly from: string | null;
    readonly to: string | null;
  }[];
  readonly newlyEffective: number;
  readonly noLongerEffective: number;
  readonly activationChanged: number;
  readonly facetDeltas: Readonly<Record<string, number>>;
  readonly relationsAdded: readonly PflSnapshotRelation[];
  readonly relationsRemoved: readonly PflSnapshotRelation[];
  readonly findingsAdded: readonly PflFinding[];
  readonly findingsRemoved: readonly PflFinding[];
  readonly versionNotes: readonly CellVersionNote[];
}

/** Canonical JSON: object keys sorted recursively, code-unit order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted = Object.create(null) as Record<string, unknown>;
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const [key, item] of entries) sorted[key] = sortKeysDeep(item);
    return sorted;
  }
  return value;
}

function sameElement(a: PflSnapshotElement, b: PflSnapshotElement): boolean {
  return (
    a.observed.native.kind === b.observed.native.kind &&
    a.observed.native.scope === b.observed.native.scope &&
    a.observed.source.digest === b.observed.source.digest &&
    canonicalJson(a.observed.metadata) === canonicalJson(b.observed.metadata)
  );
}

/**
 * Byte-order key for one relation endpoint triple. JSON encoding is
 * injective, so two distinct (type, from, to) triples can never share a
 * key — concatenating the parts would let `("a", "bc", "d")` and
 * `("ab", "c", "d")` collapse into one entry and hide a real difference.
 */
export function relationKey(relation: PflSnapshotRelation): string {
  return JSON.stringify([relation.type, relation.from, relation.to]);
}

/** Byte-order comparator for relations, shared by diffing and reporting. */
export function byRelation(
  a: PflSnapshotRelation,
  b: PflSnapshotRelation,
): number {
  return (
    compareBytes(a.from, b.from) ||
    compareBytes(a.to, b.to) ||
    compareBytes(a.type, b.type)
  );
}

/** Byte-order comparator for findings, shared by diffing and reporting. */
export function byFinding(a: PflFinding, b: PflFinding): number {
  return (
    compareBytes(a.rule, b.rule) ||
    // Element ids are joined with a NUL separator, as pfl's own comparator
    // does: concatenating them directly would let ("ab", "c") and ("a",
    // "bc") order equal and leave the emitted order input-dependent.
    compareBytes(a.elementIds.join("\u0000"), b.elementIds.join("\u0000")) ||
    compareBytes(a.message, b.message)
  );
}

/**
 * Computes the directional A → B difference between two exports. Both
 * documents must already be bound to their cells and mutually comparable
 * (a shared verified source-project identity or equal observed
 * `data.project.id` values, plus equal `data.runtime.id`); the caller
 * enforces those contracts before calling.
 */
export function diffCellExports(
  before: PflExportDocument,
  after: PflExportDocument,
): CellExportDiff {
  const byIdA = new Map(
    before.data.elements.map((element) => [element.id, element]),
  );
  const byIdB = new Map(
    after.data.elements.map((element) => [element.id, element]),
  );

  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const changedIds: string[] = [];
  for (const element of before.data.elements) {
    const other = byIdB.get(element.id);
    if (other === undefined) removedIds.push(element.id);
    else if (!sameElement(element, other)) changedIds.push(element.id);
  }
  for (const element of after.data.elements) {
    if (!byIdA.has(element.id)) addedIds.push(element.id);
  }
  addedIds.sort(compareBytes);
  removedIds.sort(compareBytes);
  changedIds.sort(compareBytes);

  const resolvedA = new Map(
    before.data.elements
      .filter((element) => element.resolved !== null)
      .map((element) => [element.id, element.resolved!]),
  );
  const resolvedB = new Map(
    after.data.elements
      .filter((element) => element.resolved !== null)
      .map((element) => [element.id, element.resolved!]),
  );
  const resolvedIds = new Set([...resolvedA.keys(), ...resolvedB.keys()]);

  let newlyEffective = 0;
  let noLongerEffective = 0;
  let activationChanged = 0;
  const statusChanges: CellExportDiff["statusChanges"][number][] = [];
  for (const id of resolvedIds) {
    const elementA = resolvedA.get(id);
    const elementB = resolvedB.get(id);
    const statusA = elementA?.status ?? null;
    const statusB = elementB?.status ?? null;
    if (statusA !== "effective" && statusB === "effective") newlyEffective += 1;
    if (statusA === "effective" && statusB !== "effective")
      noLongerEffective += 1;
    if (
      elementA !== undefined &&
      elementB !== undefined &&
      elementA.activation !== elementB.activation
    )
      activationChanged += 1;
    if (elementA !== undefined && elementB !== undefined && statusA !== statusB)
      statusChanges.push({ id, from: statusA, to: statusB });
  }
  statusChanges.sort((a, b) => compareBytes(a.id, b.id));

  // A null-prototype record: a facet literally named `__proto__` is a
  // valid pfl facet name and must not be swallowed by the prototype
  // setter (pfl-export-contract: facet names are arbitrary strings).
  const facetDeltas: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  const facetCount = (document: PflExportDocument, facet: string): number =>
    document.data.elements.filter(
      (element) => element.interpretation?.facets.includes(facet) ?? false,
    ).length;
  const facets = new Set<string>();
  for (const document of [before, after])
    for (const element of document.data.elements)
      for (const facet of element.interpretation?.facets ?? [])
        facets.add(facet);
  for (const facet of [...facets].sort(compareBytes)) {
    const delta = facetCount(after, facet) - facetCount(before, facet);
    if (delta !== 0) facetDeltas[facet] = delta;
  }

  const inA = new Set(before.data.relations.map(relationKey));
  const inB = new Set(after.data.relations.map(relationKey));
  const relationsAdded = after.data.relations
    .filter((relation) => !inA.has(relationKey(relation)))
    .sort(byRelation);
  const relationsRemoved = before.data.relations
    .filter((relation) => !inB.has(relationKey(relation)))
    .sort(byRelation);

  const findingsA = new Set(before.data.findings.map(canonicalJson));
  const findingsB = new Set(after.data.findings.map(canonicalJson));
  const findingsAdded = after.data.findings
    .filter((finding) => !findingsA.has(canonicalJson(finding)))
    .sort(byFinding);
  const findingsRemoved = before.data.findings
    .filter((finding) => !findingsB.has(canonicalJson(finding)))
    .sort(byFinding);

  const versionNotes: CellVersionNote[] = [];
  if (
    before.data.interpretation.classifier.version !==
    after.data.interpretation.classifier.version
  )
    versionNotes.push({
      kind: "classifier",
      text: `classifier version differs: ${before.data.interpretation.classifier.version} → ${after.data.interpretation.classifier.version}`,
    });
  if (before.data.runtime.version !== after.data.runtime.version)
    versionNotes.push({
      kind: "runtime",
      text: `runtime version differs: ${before.data.runtime.version ?? "unknown"} → ${after.data.runtime.version ?? "unknown"}`,
    });
  if (
    before.data.resolution.semanticsVersion !==
    after.data.resolution.semanticsVersion
  )
    versionNotes.push({
      kind: "resolution",
      text: `resolution semantics differ: ${before.data.resolution.semanticsVersion} → ${after.data.resolution.semanticsVersion}`,
    });

  return {
    addedIds,
    removedIds,
    changedIds,
    statusChanges,
    newlyEffective,
    noLongerEffective,
    activationChanged,
    facetDeltas,
    relationsAdded,
    relationsRemoved,
    findingsAdded,
    findingsRemoved,
    versionNotes,
  };
}
