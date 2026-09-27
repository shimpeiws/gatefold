import { open } from "node:fs/promises";
import { sanitizeText } from "../domain/sanitize.js";

export type PflExportErrorCode =
  | "unreadable-file"
  | "invalid-json"
  | "invalid-shape"
  | "unsupported-command"
  | "export-failed"
  | "unsupported-version"
  | "mismatched-inputs";

export class PflExportError extends Error {
  readonly code: PflExportErrorCode;

  /** The message is sanitized: it may interpolate untrusted export text. */
  constructor(code: PflExportErrorCode, message: string) {
    super(sanitizeText(message));
    this.name = "PflExportError";
    this.code = code;
  }
}

export type Completeness = "complete" | "partial" | "unknown";

export interface PflDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface PflReportStats {
  readonly observed: number;
  readonly effective: number;
  readonly shadowed: number;
  readonly conditional: number;
  readonly opaque: number;
  readonly byFacet?: Readonly<Record<string, number>>;
}

export interface PflFinding {
  readonly rule: string;
  readonly message: string;
  readonly elementIds: readonly string[];
}

export interface PflReportData {
  readonly runtime: string;
  readonly runtimeName?: string;
  readonly project: { readonly id: string; readonly displayName: string };
  readonly observedSnapshotId?: string;
  readonly resolvedSnapshotId?: string;
  readonly confidence?: string;
  readonly stats: PflReportStats;
  readonly findings: readonly PflFinding[];
  readonly interpretation: {
    readonly classifierVersion: string;
    readonly origin: "stored" | "recomputed";
  };
}

/* ==== `pfl export` payload: the full joined snapshot (docs/v0.3-scope.md) ==== */

export interface PflSnapshotObserved {
  readonly id: string;
  readonly native: {
    readonly kind: string;
    readonly origin: string;
    readonly scope: string | null;
  };
  readonly source: {
    readonly path?: string;
    readonly digest?: string;
    readonly sizeBytes?: number;
    readonly symlink?: boolean;
  };
  readonly inspectability: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly reason?: string;
}

export interface PflSnapshotResolved {
  readonly id: string;
  readonly status: string;
  readonly activation: string;
  readonly applicability?: {
    readonly type: string;
    readonly target?: string;
  };
  readonly resolution: {
    readonly strategy: string;
    readonly reason?: string;
  };
}

export interface PflSnapshotInterpretation {
  readonly elementId: string;
  readonly facets: readonly string[];
  readonly confidence: string;
  readonly reason: string;
}

/**
 * One element's observed / resolved / interpretation layers joined by id.
 * `resolved` and `interpretation` are required keys whose values may be null:
 * null means pfl has no entry for that layer, not a negative property.
 */
export interface PflSnapshotElement {
  readonly id: string;
  readonly observed: PflSnapshotObserved;
  readonly resolved: PflSnapshotResolved | null;
  readonly interpretation: PflSnapshotInterpretation | null;
}

export interface PflSnapshotRelation {
  readonly type: string;
  readonly from: string;
  readonly to: string;
}

export interface PflSnapshotData {
  readonly project: {
    readonly id: string;
    readonly displayName: string;
  };
  readonly runtime: {
    readonly id: string;
    readonly version: string | null;
    readonly adapter: {
      readonly id: string;
      readonly version: string;
      readonly runtimeCompatibility: string;
    };
  };
  readonly snapshot: {
    readonly observedSnapshotId: string;
    readonly resolvedSnapshotId: string;
    readonly capturedAt: string;
    readonly schemaVersion: string;
  };
  readonly resolution: {
    readonly semanticsVersion: string;
    readonly confidence: string;
  };
  readonly elements: readonly PflSnapshotElement[];
  readonly relations: readonly PflSnapshotRelation[];
  readonly findings: readonly PflFinding[];
  readonly interpretation: {
    readonly classifier: {
      readonly id: string;
      readonly version: string;
    };
    readonly origin: "stored" | "recomputed";
  };
}

/* ==== `pfl diff` payload: one A → B comparison (docs/v0.3-scope.md) ==== */

export interface PflDiffStatusChange {
  readonly id: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface PflDiffInterpretationSide {
  readonly classifierVersion: string;
  readonly origin: "stored" | "recomputed";
}

/**
 * The comparison pfl already computed. A diff carries no element set, so
 * relation endpoints and finding element IDs are opaque references: they are
 * validated as strings, never resolved against a snapshot this document does
 * not contain.
 */
export interface PflDiffData {
  readonly runtime: string;
  readonly observedSnapshotIdA: string;
  readonly observedSnapshotIdB: string;
  readonly resolvedSnapshotIdA: string;
  readonly resolvedSnapshotIdB: string;
  readonly structural: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly addedIds: readonly string[];
    readonly removedIds: readonly string[];
    readonly changedIds: readonly string[];
  };
  readonly effective: {
    readonly newlyEffective: number;
    readonly noLongerEffective: number;
    readonly activationChanged: number;
    readonly statusChanges: readonly PflDiffStatusChange[];
  };
  readonly facetDeltas: Readonly<Record<string, number>>;
  readonly relations: {
    readonly added: readonly PflSnapshotRelation[];
    readonly removed: readonly PflSnapshotRelation[];
  };
  readonly findings: {
    readonly added: readonly PflFinding[];
    readonly removed: readonly PflFinding[];
  };
  readonly versionNotes: readonly string[];
  readonly interpretation: {
    readonly a: PflDiffInterpretationSide;
    readonly b: PflDiffInterpretationSide;
  };
}

interface PflDocumentBase {
  readonly sourcePath: string;
  readonly pflVersion: string;
  readonly completeness: Completeness;
  readonly diagnostics: readonly PflDiagnostic[];
}

/** A `pfl report --json` document (the v0.2 input). */
export interface PflReportDocument extends PflDocumentBase {
  readonly command: "report";
  readonly data: PflReportData;
}

/** A `pfl export --json` document (the v0.3 full snapshot input). */
export interface PflExportDocument extends PflDocumentBase {
  readonly command: "export";
  readonly data: PflSnapshotData;
}

/** A `pfl diff --json` document (the v0.3 comparison input). */
export interface PflDiffDocument extends PflDocumentBase {
  readonly command: "diff";
  readonly data: PflDiffData;
}

export type PflDocument =
  | PflReportDocument
  | PflExportDocument
  | PflDiffDocument;

/** @deprecated v0.2 name for a report document; use {@link PflReportDocument}. */
export type PflExport = PflReportDocument;

/** Resource ceilings for untrusted exports (see docs/pfl-export-contract.md). */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS = 1_000;
const MAX_FINDINGS = 10_000;
const MAX_ELEMENT_IDS = 1_000;
const MAX_TOTAL_ELEMENT_IDS = 10_000;
const MAX_BY_FACET_KEYS = 1_000;
/**
 * Character ceiling for metadata strings (`pflVersion`, `classifierVersion`,
 * `runtimeName`, snapshot ids, `confidence`). These values are copied into the
 * provenance of every claim, so an unbounded string would multiply a small
 * input into output too large to buffer.
 */
const MAX_METADATA_CHARS = 1_024;
/** Ceilings that apply to the `export` payload only (docs/v0.3-scope.md). */
const MAX_ELEMENTS = 10_000;
const MAX_RELATIONS = 20_000;
const MAX_METADATA_DEPTH = 12;
const MAX_METADATA_NODES = 10_000;
const MAX_ELEMENT_FACETS = 1_000;
/** Ceilings that apply to the `diff` payload only (docs/v0.3-scope.md). */
const MAX_DIFF_ARRAY = 10_000;
const MAX_FACET_DELTA_KEYS = 1_000;
/**
 * Character ceiling for strings displayed in or repeated across claims and
 * errors (ids, kinds, paths, messages, reasons, metadata leaves).
 */
const MAX_SCALAR_CHARS = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shapeError(field: string, expected: string): PflExportError {
  return new PflExportError(
    "invalid-shape",
    `pfl export field ${field} must be ${expected}`,
  );
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0)
    throw shapeError(path, "a non-empty string");
  return value;
}

function nonNegativeIntField(
  record: Record<string, unknown>,
  key: string,
  path = key,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw shapeError(path, "a non-negative safe integer");
  return value;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw shapeError(key, "a string");
  if (value.length > MAX_METADATA_CHARS)
    throw shapeError(
      key,
      `a string of at most ${MAX_METADATA_CHARS} characters`,
    );
  return value;
}

/** Required non-empty string capped at `max` characters. */
function boundedStringField(
  record: Record<string, unknown>,
  key: string,
  path = key,
  max = MAX_SCALAR_CHARS,
): string {
  const value = stringField(record, key, path);
  if (value.length > max)
    throw shapeError(path, `a string of at most ${max} characters`);
  return value;
}

/** Optional string capped at `max` characters. */
function optionalBoundedStringField(
  record: Record<string, unknown>,
  key: string,
  path = key,
  max = MAX_SCALAR_CHARS,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw shapeError(path, "a string");
  if (value.length > max)
    throw shapeError(path, `a string of at most ${max} characters`);
  return value;
}

/** Required string that may explicitly be null. */
function nullableStringField(
  record: Record<string, unknown>,
  key: string,
  path = key,
  max = MAX_SCALAR_CHARS,
): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") throw shapeError(path, "a string or null");
  if (value.length > max)
    throw shapeError(path, `a string of at most ${max} characters`);
  return value;
}

/** Required string whose value must be one of `allowed`. */
function enumField<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path = key,
): T {
  const value = record[key];
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw shapeError(path, `one of ${allowed.map((v) => `"${v}"`).join(", ")}`);
  return value as T;
}

/**
 * Shared envelope diagnostics. `scalarLimit` caps displayed strings; the v0.2
 * report contract leaves them uncapped, so only the export path passes one.
 */
function parseDiagnostics(
  value: unknown,
  scalarLimit?: number,
): readonly PflDiagnostic[] {
  if (!Array.isArray(value)) throw shapeError("diagnostics", "an array");
  if (value.length > MAX_DIAGNOSTICS)
    throw shapeError(
      "diagnostics",
      `an array with at most ${MAX_DIAGNOSTICS} items`,
    );
  const bounded = (record: Record<string, unknown>, key: string, at: string) =>
    scalarLimit === undefined
      ? stringField(record, key, at)
      : boundedStringField(record, key, at, scalarLimit);
  return value.map((item, index) => {
    const at = `diagnostics[${index}]`;
    if (!isRecord(item)) throw shapeError(at, "an object");
    const severity = item.severity;
    if (severity !== "info" && severity !== "warning" && severity !== "error")
      throw shapeError(`${at}.severity`, '"info", "warning", or "error"');
    const diagnostic: PflDiagnostic = {
      severity,
      code: bounded(item, "code", `${at}.code`),
      message: bounded(item, "message", `${at}.message`),
    };
    const path = item.path;
    if (path !== undefined) {
      if (typeof path !== "string") throw shapeError(`${at}.path`, "a string");
      if (scalarLimit !== undefined && path.length > scalarLimit)
        throw shapeError(
          `${at}.path`,
          `a string of at most ${scalarLimit} characters`,
        );
      return { ...diagnostic, path };
    }
    return diagnostic;
  });
}

/**
 * Shared `{ rule, message, elementIds }` list used by report, export, and
 * diff. `scalarLimit` caps displayed strings; the v0.2 report contract leaves
 * them uncapped, so only the export and diff paths pass one.
 */
function parseFindingList(
  value: unknown,
  scalarLimit?: number,
  path = "data.findings",
  budget: { total: number } = { total: 0 },
): readonly PflFinding[] {
  if (!Array.isArray(value)) throw shapeError(path, "an array");
  if (value.length > MAX_FINDINGS)
    throw shapeError(path, `an array with at most ${MAX_FINDINGS} items`);
  return value.map((item, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(item)) throw shapeError(at, "an object");
    const elementIds = item.elementIds;
    if (
      !Array.isArray(elementIds) ||
      elementIds.length > MAX_ELEMENT_IDS ||
      elementIds.some((id) => typeof id !== "string" || id.length === 0)
    )
      throw shapeError(
        `${at}.elementIds`,
        `an array of non-empty strings (at most ${MAX_ELEMENT_IDS})`,
      );
    budget.total += elementIds.length;
    if (budget.total > MAX_TOTAL_ELEMENT_IDS)
      throw shapeError(
        `${path}[*].elementIds`,
        `at most ${MAX_TOTAL_ELEMENT_IDS} ids in total across all findings`,
      );
    if (scalarLimit !== undefined)
      for (const [elementIndex, id] of elementIds.entries()) {
        if ((id as string).length > scalarLimit)
          throw shapeError(
            `${at}.elementIds[${elementIndex}]`,
            `a string of at most ${scalarLimit} characters`,
          );
      }
    return {
      rule:
        scalarLimit === undefined
          ? stringField(item, "rule", `${at}.rule`)
          : boundedStringField(item, "rule", `${at}.rule`, scalarLimit),
      message:
        scalarLimit === undefined
          ? stringField(item, "message", `${at}.message`)
          : boundedStringField(item, "message", `${at}.message`, scalarLimit),
      elementIds: elementIds as string[],
    };
  });
}

function parseReportData(value: unknown): PflReportData {
  if (!isRecord(value)) throw shapeError("data", "an object");
  const stats = value.stats;
  if (!isRecord(stats)) throw shapeError("data.stats", "an object");
  const byFacetValue = stats.byFacet;
  let byFacet: Record<string, number> | undefined;
  if (byFacetValue !== undefined) {
    if (!isRecord(byFacetValue))
      throw shapeError("data.stats.byFacet", "an object");
    if (Object.keys(byFacetValue).length > MAX_BY_FACET_KEYS)
      throw shapeError(
        "data.stats.byFacet",
        `an object with at most ${MAX_BY_FACET_KEYS} keys`,
      );
    // Null-prototype object: keeps keys like "__proto__" as real own keys.
    byFacet = Object.create(null) as Record<string, number>;
    for (const [facet, count] of Object.entries(byFacetValue)) {
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        throw shapeError(
          `data.stats.byFacet.${facet}`,
          "a non-negative safe integer",
        );
      byFacet[facet] = count;
    }
  }
  const findings = parseFindingList(value.findings);
  const interpretation = value.interpretation;
  if (!isRecord(interpretation))
    throw shapeError("data.interpretation", "an object");
  const classifierVersion = stringField(
    interpretation,
    "classifierVersion",
    "data.interpretation.classifierVersion",
  );
  if (classifierVersion.length > MAX_METADATA_CHARS)
    throw shapeError(
      "data.interpretation.classifierVersion",
      `a string of at most ${MAX_METADATA_CHARS} characters`,
    );
  const origin = interpretation.origin;
  if (origin !== "stored" && origin !== "recomputed")
    throw shapeError("data.interpretation.origin", '"stored" or "recomputed"');
  const project = value.project;
  if (!isRecord(project)) throw shapeError("data.project", "an object");
  return {
    runtime: stringField(value, "runtime", "data.runtime"),
    runtimeName: optionalStringField(value, "runtimeName"),
    project: {
      id: stringField(project, "id", "data.project.id"),
      displayName: stringField(
        project,
        "displayName",
        "data.project.displayName",
      ),
    },
    observedSnapshotId: optionalStringField(value, "observedSnapshotId"),
    resolvedSnapshotId: optionalStringField(value, "resolvedSnapshotId"),
    confidence: optionalStringField(value, "confidence"),
    stats: {
      observed: nonNegativeIntField(stats, "observed", "data.stats.observed"),
      effective: nonNegativeIntField(
        stats,
        "effective",
        "data.stats.effective",
      ),
      shadowed: nonNegativeIntField(stats, "shadowed", "data.stats.shadowed"),
      conditional: nonNegativeIntField(
        stats,
        "conditional",
        "data.stats.conditional",
      ),
      opaque: nonNegativeIntField(stats, "opaque", "data.stats.opaque"),
      ...(byFacet === undefined ? {} : { byFacet }),
    },
    findings,
    interpretation: {
      classifierVersion,
      origin,
    },
  };
}

/* Enum domains mirror pfl's core model types (docs/v0.3-scope.md). */
const SNAPSHOT_NATIVE_ORIGINS = [
  "project",
  "user",
  "managed",
  "plugin",
  "builtin",
  "unknown",
] as const;
const OBSERVED_STATUSES = [
  "observed",
  "unreadable",
  "unsupported",
  "skipped",
  "unknown",
] as const;
const OBSERVED_REASONS = [
  "symlink-not-followed",
  "hardlink-not-followed",
  "non-regular-file-not-opened",
  "limit-exceeded",
  "unsupported-by-adapter",
  "unreadable",
  "unknown",
] as const;
const INSPECTABILITIES = [
  "observable",
  "known-runtime-provided",
  "opaque",
] as const;
const RESOLVED_STATUSES = [
  "effective",
  "shadowed",
  "conditional",
  "unresolved",
  "unknown",
] as const;
const ACTIVATIONS = [
  "always",
  "conditional",
  "on-demand",
  "event-driven",
  "unknown",
] as const;
const APPLICABILITY_TYPES = [
  "global",
  "project",
  "directory-subtree",
  "tool-event",
  "config-rule",
  "runtime-defined",
  "unknown",
] as const;
const RESOLUTION_STRATEGIES = [
  "override",
  "accumulate",
  "available",
  "policy",
  "event-pipeline",
  "runtime-defined",
  "unknown",
] as const;
/**
 * pfl's reader accepts the schema-1 persisted relation set (the three current
 * types plus four withdrawn legacy types) because stored artifacts can still
 * carry them; an export projects stored artifacts, so the same set is accepted
 * here.
 */
const RELATION_TYPES = [
  "shadows",
  "overrides",
  "accumulates-with",
  "contains",
  "discovered-from",
  "resolves-to",
  "applies-to",
] as const;
const INTERPRETATION_CONFIDENCES = ["high", "medium", "unknown"] as const;
const RESOLUTION_CONFIDENCES = [
  "verified",
  "unverified-runtime-version",
] as const;
const RUNTIME_COMPATIBILITIES = ["verified", "unverified"] as const;
const INTERPRETATION_ORIGINS = ["stored", "recomputed"] as const;

/**
 * Walks an element's `metadata` tree: bounded safe JSON (string, number,
 * boolean, null, arrays, string-keyed objects) within the depth and node
 * ceilings. Pure validation — the tree is never turned into prose.
 */
function checkMetadata(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_METADATA_NODES)
    throw shapeError(
      path,
      `nested metadata with at most ${MAX_METADATA_NODES} nodes per element`,
    );
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return;
  if (typeof value === "string") {
    if (value.length > MAX_SCALAR_CHARS)
      throw shapeError(
        path,
        `a string of at most ${MAX_SCALAR_CHARS} characters`,
      );
    return;
  }
  if (Array.isArray(value)) {
    if (depth > MAX_METADATA_DEPTH)
      throw shapeError(
        path,
        `metadata nested no deeper than ${MAX_METADATA_DEPTH} levels`,
      );
    for (const [index, item] of value.entries())
      checkMetadata(item, `${path}[${index}]`, depth + 1, budget);
    return;
  }
  if (isRecord(value)) {
    if (depth > MAX_METADATA_DEPTH)
      throw shapeError(
        path,
        `metadata nested no deeper than ${MAX_METADATA_DEPTH} levels`,
      );
    for (const [key, item] of Object.entries(value)) {
      if (key.length > MAX_SCALAR_CHARS)
        throw shapeError(
          `${path}.${key.slice(0, 32)}…`,
          `a metadata key of at most ${MAX_SCALAR_CHARS} characters`,
        );
      checkMetadata(item, `${path}.${key}`, depth + 1, budget);
    }
    return;
  }
  throw shapeError(
    path,
    "safe JSON metadata (string, number, boolean, null, array, or object)",
  );
}

function parseSnapshotObserved(
  value: unknown,
  at: string,
): PflSnapshotObserved {
  if (!isRecord(value)) throw shapeError(at, "an object");
  const native = value.native;
  if (!isRecord(native)) throw shapeError(`${at}.native`, "an object");
  const source = value.source;
  if (!isRecord(source)) throw shapeError(`${at}.source`, "an object");
  const metadata = value.metadata;
  if (!isRecord(metadata)) throw shapeError(`${at}.metadata`, "an object");
  checkMetadata(metadata, `${at}.metadata`, 1, { nodes: 0 });
  const reason = value.reason;
  const parsed: PflSnapshotObserved = {
    id: boundedStringField(value, "id", `${at}.id`),
    native: {
      kind: boundedStringField(native, "kind", `${at}.native.kind`),
      origin: enumField(
        native,
        "origin",
        SNAPSHOT_NATIVE_ORIGINS,
        `${at}.native.origin`,
      ),
      scope: nullableStringField(native, "scope", `${at}.native.scope`),
    },
    source: {
      ...(source.path !== undefined
        ? {
            path: optionalBoundedStringField(
              source,
              "path",
              `${at}.source.path`,
            ),
          }
        : {}),
      ...(source.digest !== undefined
        ? {
            digest: optionalBoundedStringField(
              source,
              "digest",
              `${at}.source.digest`,
            ),
          }
        : {}),
      ...(source.sizeBytes !== undefined
        ? {
            sizeBytes: nonNegativeIntField(
              source,
              "sizeBytes",
              `${at}.source.sizeBytes`,
            ),
          }
        : {}),
      ...(source.symlink !== undefined
        ? {
            symlink: (() => {
              if (typeof source.symlink !== "boolean")
                throw shapeError(`${at}.source.symlink`, "a boolean");
              return source.symlink;
            })(),
          }
        : {}),
    },
    inspectability: enumField(
      value,
      "inspectability",
      INSPECTABILITIES,
      `${at}.inspectability`,
    ),
    metadata,
    status: enumField(value, "status", OBSERVED_STATUSES, `${at}.status`),
  };
  if (reason !== undefined)
    return {
      ...parsed,
      reason: enumField(value, "reason", OBSERVED_REASONS, `${at}.reason`),
    };
  return parsed;
}

function parseSnapshotResolved(
  value: unknown,
  at: string,
): PflSnapshotResolved {
  if (!isRecord(value)) throw shapeError(at, "an object");
  const resolution = value.resolution;
  if (!isRecord(resolution)) throw shapeError(`${at}.resolution`, "an object");
  const applicability = value.applicability;
  let parsedApplicability: PflSnapshotResolved["applicability"];
  if (applicability !== undefined) {
    if (!isRecord(applicability))
      throw shapeError(`${at}.applicability`, "an object");
    const type = enumField(
      applicability,
      "type",
      APPLICABILITY_TYPES,
      `${at}.applicability.type`,
    );
    const target = optionalBoundedStringField(
      applicability,
      "target",
      `${at}.applicability.target`,
    );
    parsedApplicability = target === undefined ? { type } : { type, target };
  }
  const reason = optionalBoundedStringField(
    resolution,
    "reason",
    `${at}.resolution.reason`,
  );
  return {
    id: boundedStringField(value, "id", `${at}.id`),
    status: enumField(value, "status", RESOLVED_STATUSES, `${at}.status`),
    activation: enumField(value, "activation", ACTIVATIONS, `${at}.activation`),
    ...(parsedApplicability === undefined
      ? {}
      : { applicability: parsedApplicability }),
    resolution: {
      strategy: enumField(
        resolution,
        "strategy",
        RESOLUTION_STRATEGIES,
        `${at}.resolution.strategy`,
      ),
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

function parseSnapshotInterpretation(
  value: unknown,
  at: string,
): PflSnapshotInterpretation {
  if (!isRecord(value)) throw shapeError(at, "an object");
  const facets = value.facets;
  if (!Array.isArray(facets) || facets.length > MAX_ELEMENT_FACETS)
    throw shapeError(
      `${at}.facets`,
      `an array of at most ${MAX_ELEMENT_FACETS} items`,
    );
  if (facets.some((facet) => typeof facet !== "string" || facet.length === 0))
    throw shapeError(`${at}.facets`, "an array of non-empty strings");
  for (const [index, facet] of facets.entries()) {
    if ((facet as string).length > MAX_SCALAR_CHARS)
      throw shapeError(
        `${at}.facets[${index}]`,
        `a string of at most ${MAX_SCALAR_CHARS} characters`,
      );
  }
  return {
    elementId: boundedStringField(value, "elementId", `${at}.elementId`),
    facets: facets as string[],
    confidence: enumField(
      value,
      "confidence",
      INTERPRETATION_CONFIDENCES,
      `${at}.confidence`,
    ),
    reason: boundedStringField(value, "reason", `${at}.reason`),
  };
}

function parseSnapshotElement(
  item: unknown,
  index: number,
  seenIds: Set<string>,
): PflSnapshotElement {
  const at = `data.elements[${index}]`;
  if (!isRecord(item)) throw shapeError(at, "an object");
  const id = boundedStringField(item, "id", `${at}.id`);
  if (seenIds.has(id))
    throw new PflExportError(
      "invalid-shape",
      `pfl export element ${at} duplicates element id '${id}'`,
    );
  seenIds.add(id);
  const observed = parseSnapshotObserved(item.observed, `${at}.observed`);
  if (observed.id !== id)
    throw new PflExportError(
      "invalid-shape",
      `pfl export element ${at} joins mismatched ids: observed.id '${observed.id}' is not element id '${id}'`,
    );
  if (!("resolved" in item))
    throw shapeError(
      `${at}.resolved`,
      "a required key (its value may be null)",
    );
  const resolved =
    item.resolved === null
      ? null
      : parseSnapshotResolved(item.resolved, `${at}.resolved`);
  if (resolved !== null && resolved.id !== id)
    throw new PflExportError(
      "invalid-shape",
      `pfl export element ${at} joins mismatched ids: resolved.id '${resolved.id}' is not element id '${id}'`,
    );
  if (!("interpretation" in item))
    throw shapeError(
      `${at}.interpretation`,
      "a required key (its value may be null)",
    );
  const interpretation =
    item.interpretation === null
      ? null
      : parseSnapshotInterpretation(
          item.interpretation,
          `${at}.interpretation`,
        );
  if (interpretation !== null && interpretation.elementId !== id)
    throw new PflExportError(
      "invalid-shape",
      `pfl export element ${at} joins mismatched ids: interpretation.elementId '${interpretation.elementId}' is not element id '${id}'`,
    );
  return { id, observed, resolved, interpretation };
}

/** One `{ type, from, to }` relation, shared by export and diff. */
function parseRelation(item: unknown, at: string): PflSnapshotRelation {
  if (!isRecord(item)) throw shapeError(at, "an object");
  return {
    type: enumField(item, "type", RELATION_TYPES, `${at}.type`),
    from: boundedStringField(item, "from", `${at}.from`),
    to: boundedStringField(item, "to", `${at}.to`),
  };
}

function parsePflSnapshotData(value: unknown): PflSnapshotData {
  if (!isRecord(value)) throw shapeError("data", "an object");
  const project = value.project;
  if (!isRecord(project)) throw shapeError("data.project", "an object");
  const runtime = value.runtime;
  if (!isRecord(runtime)) throw shapeError("data.runtime", "an object");
  const adapter = runtime.adapter;
  if (!isRecord(adapter)) throw shapeError("data.runtime.adapter", "an object");
  const snapshot = value.snapshot;
  if (!isRecord(snapshot)) throw shapeError("data.snapshot", "an object");
  const resolution = value.resolution;
  if (!isRecord(resolution)) throw shapeError("data.resolution", "an object");
  const elements = value.elements;
  if (!Array.isArray(elements)) throw shapeError("data.elements", "an array");
  if (elements.length > MAX_ELEMENTS)
    throw shapeError(
      "data.elements",
      `an array with at most ${MAX_ELEMENTS} items`,
    );
  const relations = value.relations;
  if (!Array.isArray(relations)) throw shapeError("data.relations", "an array");
  if (relations.length > MAX_RELATIONS)
    throw shapeError(
      "data.relations",
      `an array with at most ${MAX_RELATIONS} items`,
    );
  const interpretation = value.interpretation;
  if (!isRecord(interpretation))
    throw shapeError("data.interpretation", "an object");
  const classifier = interpretation.classifier;
  if (!isRecord(classifier))
    throw shapeError("data.interpretation.classifier", "an object");
  const seenIds = new Set<string>();
  return {
    project: {
      id: boundedStringField(project, "id", "data.project.id"),
      displayName: boundedStringField(
        project,
        "displayName",
        "data.project.displayName",
      ),
    },
    runtime: {
      id: boundedStringField(runtime, "id", "data.runtime.id"),
      version: nullableStringField(runtime, "version", "data.runtime.version"),
      adapter: {
        id: boundedStringField(adapter, "id", "data.runtime.adapter.id"),
        version: boundedStringField(
          adapter,
          "version",
          "data.runtime.adapter.version",
        ),
        runtimeCompatibility: enumField(
          adapter,
          "runtimeCompatibility",
          RUNTIME_COMPATIBILITIES,
          "data.runtime.adapter.runtimeCompatibility",
        ),
      },
    },
    snapshot: {
      // Snapshot ids are copied into every claim's provenance: provenance cap.
      observedSnapshotId: boundedStringField(
        snapshot,
        "observedSnapshotId",
        "data.snapshot.observedSnapshotId",
        MAX_METADATA_CHARS,
      ),
      resolvedSnapshotId: boundedStringField(
        snapshot,
        "resolvedSnapshotId",
        "data.snapshot.resolvedSnapshotId",
        MAX_METADATA_CHARS,
      ),
      capturedAt: boundedStringField(
        snapshot,
        "capturedAt",
        "data.snapshot.capturedAt",
      ),
      schemaVersion: boundedStringField(
        snapshot,
        "schemaVersion",
        "data.snapshot.schemaVersion",
      ),
    },
    resolution: {
      semanticsVersion: boundedStringField(
        resolution,
        "semanticsVersion",
        "data.resolution.semanticsVersion",
      ),
      confidence: enumField(
        resolution,
        "confidence",
        RESOLUTION_CONFIDENCES,
        "data.resolution.confidence",
      ),
    },
    elements: elements.map((item, index) =>
      parseSnapshotElement(item, index, seenIds),
    ),
    relations: relations.map((item, index) => {
      const at = `data.relations[${index}]`;
      const relation = parseRelation(item, at);
      if (!seenIds.has(relation.from))
        throw shapeError(
          `${at}.from`,
          `an element id present in data.elements ('${relation.from}' is unknown)`,
        );
      if (!seenIds.has(relation.to))
        throw shapeError(
          `${at}.to`,
          `an element id present in data.elements ('${relation.to}' is unknown)`,
        );
      return relation;
    }),
    findings: parseFindingList(value.findings, MAX_SCALAR_CHARS),
    interpretation: {
      classifier: {
        id: boundedStringField(
          classifier,
          "id",
          "data.interpretation.classifier.id",
        ),
        // Copied into every claim's provenance: provenance cap.
        version: boundedStringField(
          classifier,
          "version",
          "data.interpretation.classifier.version",
          MAX_METADATA_CHARS,
        ),
      },
      origin: enumField(
        interpretation,
        "origin",
        INTERPRETATION_ORIGINS,
        "data.interpretation.origin",
      ),
    },
  };
}

/** Required string or explicit null whose value must be one of `allowed`. */
function nullableEnumField<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path = key,
): T | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw shapeError(
      path,
      `null or one of ${allowed.map((v) => `"${v}"`).join(", ")}`,
    );
  return value as T;
}

/**
 * One structural ID list: bounded, non-empty bounded strings, unique within
 * the list. Pairwise disjointness across the three lists is checked by the
 * caller once all three are parsed.
 */
function parseDiffIdList(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const path = `data.structural.${key}`;
  const value = record[key];
  if (!Array.isArray(value)) throw shapeError(path, "an array");
  if (value.length > MAX_DIFF_ARRAY)
    throw shapeError(path, `an array with at most ${MAX_DIFF_ARRAY} items`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0)
      throw shapeError(`${path}[${index}]`, "a non-empty string");
    if (item.length > MAX_SCALAR_CHARS)
      throw shapeError(
        `${path}[${index}]`,
        `a string of at most ${MAX_SCALAR_CHARS} characters`,
      );
    if (seen.has(item))
      throw shapeError(
        `${path}[${index}]`,
        `a unique element id ('${item}' repeats)`,
      );
    seen.add(item);
    return item;
  });
}

/**
 * Facet names to signed integer deltas. Unknown facet names are tolerated:
 * pfl's facet set is additive, and a delta carries no detail beyond the count.
 */
function parseFacetDeltas(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) throw shapeError("data.facetDeltas", "an object");
  const keys = Object.keys(value);
  if (keys.length > MAX_FACET_DELTA_KEYS)
    throw shapeError(
      "data.facetDeltas",
      `an object with at most ${MAX_FACET_DELTA_KEYS} keys`,
    );
  const deltas = Object.create(null) as Record<string, number>;
  for (const [facet, delta] of Object.entries(value)) {
    if (facet.length > MAX_SCALAR_CHARS)
      throw shapeError(
        `data.facetDeltas.${facet.slice(0, 32)}…`,
        `a facet name of at most ${MAX_SCALAR_CHARS} characters`,
      );
    if (typeof delta !== "number" || !Number.isSafeInteger(delta))
      throw shapeError(`data.facetDeltas.${facet}`, "a safe integer");
    deltas[facet] = delta;
  }
  return deltas;
}

/** One side's interpretation provenance: `{ classifierVersion, origin }`. */
function parseDiffInterpretationSide(
  value: unknown,
  at: string,
): PflDiffInterpretationSide {
  if (!isRecord(value)) throw shapeError(at, "an object");
  return {
    // Copied into claim text per side: provenance cap.
    classifierVersion: boundedStringField(
      value,
      "classifierVersion",
      `${at}.classifierVersion`,
      MAX_METADATA_CHARS,
    ),
    origin: enumField(value, "origin", INTERPRETATION_ORIGINS, `${at}.origin`),
  };
}

function parseDiffData(value: unknown): PflDiffData {
  if (!isRecord(value)) throw shapeError("data", "an object");
  const structural = value.structural;
  if (!isRecord(structural)) throw shapeError("data.structural", "an object");
  const effective = value.effective;
  if (!isRecord(effective)) throw shapeError("data.effective", "an object");
  const relations = value.relations;
  if (!isRecord(relations)) throw shapeError("data.relations", "an object");
  const findings = value.findings;
  if (!isRecord(findings)) throw shapeError("data.findings", "an object");
  const versionNotes = value.versionNotes;
  if (!Array.isArray(versionNotes))
    throw shapeError("data.versionNotes", "an array");
  if (versionNotes.length > MAX_DIFF_ARRAY)
    throw shapeError(
      "data.versionNotes",
      `an array with at most ${MAX_DIFF_ARRAY} items`,
    );
  for (const [index, note] of versionNotes.entries()) {
    if (typeof note !== "string")
      throw shapeError(`data.versionNotes[${index}]`, "a string");
    if (note.length > MAX_SCALAR_CHARS)
      throw shapeError(
        `data.versionNotes[${index}]`,
        `a string of at most ${MAX_SCALAR_CHARS} characters`,
      );
  }
  const interpretation = value.interpretation;
  if (!isRecord(interpretation))
    throw shapeError("data.interpretation", "an object");

  const addedIds = parseDiffIdList(structural, "addedIds");
  const removedIds = parseDiffIdList(structural, "removedIds");
  const changedIds = parseDiffIdList(structural, "changedIds");
  const disjointPairs: readonly (readonly [string, readonly string[]])[] = [
    ["removedIds", removedIds],
    ["changedIds", changedIds],
  ];
  for (const [otherName, other] of disjointPairs) {
    const otherSet = new Set(other);
    for (const id of addedIds)
      if (otherSet.has(id))
        throw shapeError(
          "data.structural.addedIds",
          `disjoint from ${otherName} ('${id}' appears in both)`,
        );
  }
  const changedSet = new Set(changedIds);
  for (const id of removedIds)
    if (changedSet.has(id))
      throw shapeError(
        "data.structural.removedIds",
        `disjoint from changedIds ('${id}' appears in both)`,
      );
  for (const [countKey, ids] of [
    ["added", addedIds],
    ["removed", removedIds],
    ["changed", changedIds],
  ] as const) {
    const count = nonNegativeIntField(
      structural,
      countKey,
      `data.structural.${countKey}`,
    );
    if (count !== ids.length)
      throw shapeError(
        `data.structural.${countKey}`,
        `the length of ${countKey}Ids (${ids.length}), got ${count}`,
      );
  }

  const statusChanges = effective.statusChanges;
  if (!Array.isArray(statusChanges))
    throw shapeError("data.effective.statusChanges", "an array");
  if (statusChanges.length > MAX_DIFF_ARRAY)
    throw shapeError(
      "data.effective.statusChanges",
      `an array with at most ${MAX_DIFF_ARRAY} items`,
    );
  const seenChangeIds = new Set<string>();
  const parsedStatusChanges = statusChanges.map((item, index) => {
    const at = `data.effective.statusChanges[${index}]`;
    if (!isRecord(item)) throw shapeError(at, "an object");
    const id = boundedStringField(item, "id", `${at}.id`);
    if (seenChangeIds.has(id))
      throw shapeError(`${at}.id`, `a unique element id ('${id}' repeats)`);
    seenChangeIds.add(id);
    return {
      id,
      from: nullableEnumField(item, "from", RESOLVED_STATUSES, `${at}.from`),
      to: nullableEnumField(item, "to", RESOLVED_STATUSES, `${at}.to`),
    };
  });

  const diffFindingsBudget = { total: 0 };
  const parseRelationSide = (side: unknown, path: string) => {
    if (!Array.isArray(side)) throw shapeError(path, "an array");
    if (side.length > MAX_DIFF_ARRAY)
      throw shapeError(path, `an array with at most ${MAX_DIFF_ARRAY} items`);
    return side.map((item, index) => parseRelation(item, `${path}[${index}]`));
  };

  return {
    runtime: boundedStringField(value, "runtime", "data.runtime"),
    // Snapshot ids are copied into claim text per claim: provenance cap.
    observedSnapshotIdA: boundedStringField(
      value,
      "observedSnapshotIdA",
      "data.observedSnapshotIdA",
      MAX_METADATA_CHARS,
    ),
    observedSnapshotIdB: boundedStringField(
      value,
      "observedSnapshotIdB",
      "data.observedSnapshotIdB",
      MAX_METADATA_CHARS,
    ),
    resolvedSnapshotIdA: boundedStringField(
      value,
      "resolvedSnapshotIdA",
      "data.resolvedSnapshotIdA",
      MAX_METADATA_CHARS,
    ),
    resolvedSnapshotIdB: boundedStringField(
      value,
      "resolvedSnapshotIdB",
      "data.resolvedSnapshotIdB",
      MAX_METADATA_CHARS,
    ),
    structural: {
      added: addedIds.length,
      removed: removedIds.length,
      changed: changedIds.length,
      addedIds,
      removedIds,
      changedIds,
    },
    effective: {
      newlyEffective: nonNegativeIntField(
        effective,
        "newlyEffective",
        "data.effective.newlyEffective",
      ),
      noLongerEffective: nonNegativeIntField(
        effective,
        "noLongerEffective",
        "data.effective.noLongerEffective",
      ),
      activationChanged: nonNegativeIntField(
        effective,
        "activationChanged",
        "data.effective.activationChanged",
      ),
      statusChanges: parsedStatusChanges,
    },
    facetDeltas: parseFacetDeltas(value.facetDeltas),
    relations: {
      added: parseRelationSide(relations.added, "data.relations.added"),
      removed: parseRelationSide(relations.removed, "data.relations.removed"),
    },
    findings: {
      // A diff's two finding lists share one element-id budget: the
      // 10,000-id ceiling is per document, not per side.
      added: parseFindingList(
        findings.added,
        MAX_SCALAR_CHARS,
        "data.findings.added",
        diffFindingsBudget,
      ),
      removed: parseFindingList(
        findings.removed,
        MAX_SCALAR_CHARS,
        "data.findings.removed",
        diffFindingsBudget,
      ),
    },
    versionNotes: versionNotes as string[],
    interpretation: {
      a: parseDiffInterpretationSide(interpretation.a, "data.interpretation.a"),
      b: parseDiffInterpretationSide(interpretation.b, "data.interpretation.b"),
    },
  };
}

/** Accepted pflVersion range per docs/pfl-export-contract.md: >=1.0.0 <2.0.0. */
export function isSupportedPflVersion(version: string): boolean {
  // Semver build metadata (+...) carries no precedence; prereleases are
  // excluded because 1.0.0-alpha sorts below the supported range.
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  return match !== null && Number(match[1]) === 1;
}

/**
 * Validates a parsed JSON value against the pfl export contract
 * (docs/pfl-export-contract.md) and dispatches on its `command` to the
 * matching payload reader. Pure: no I/O.
 */
export function parsePflExport(
  value: unknown,
  sourcePath: string,
): PflDocument {
  if (!isRecord(value))
    throw new PflExportError(
      "invalid-shape",
      "pfl export must contain an object at the top level",
    );
  const pflVersion = value.pflVersion;
  if (typeof pflVersion !== "string" || pflVersion.length === 0)
    throw shapeError("pflVersion", "a non-empty string");
  if (pflVersion.length > MAX_METADATA_CHARS)
    throw shapeError(
      "pflVersion",
      `a string of at most ${MAX_METADATA_CHARS} characters`,
    );
  if (!isSupportedPflVersion(pflVersion))
    throw new PflExportError(
      "unsupported-version",
      `unsupported pflVersion: ${pflVersion} (supported: >=1.0.0 <2.0.0)`,
    );
  const command = value.command;
  if (command !== "report" && command !== "export" && command !== "diff")
    throw new PflExportError(
      "unsupported-command",
      `unsupported pfl command document: ${String(command)} (supported: report, export, diff)`,
    );
  if (value.ok !== true) {
    const error = isRecord(value.data) ? value.data.error : undefined;
    const detail = isRecord(error)
      ? `${String(error.code)}: ${String(error.message)}`
      : "unknown pfl failure";
    throw new PflExportError(
      "export-failed",
      `the pfl export is a failure document (${detail}); run pfl again and pass a successful ${command} document`,
    );
  }
  const completeness = value.completeness;
  if (
    completeness !== "complete" &&
    completeness !== "partial" &&
    completeness !== "unknown"
  )
    throw shapeError("completeness", '"complete", "partial", or "unknown"');
  const base = {
    sourcePath: sanitizeText(sourcePath),
    pflVersion,
    completeness: completeness as Completeness,
    diagnostics: parseDiagnostics(
      value.diagnostics,
      command === "report" ? undefined : MAX_SCALAR_CHARS,
    ),
  };
  if (command === "report")
    return { ...base, command, data: parseReportData(value.data) };
  if (command === "export")
    return { ...base, command, data: parsePflSnapshotData(value.data) };
  return { ...base, command, data: parseDiffData(value.data) };
}

class InputTooLargeError extends Error {}

/** provenance.sourceFile recorded for exports read from standard input. */
export const STDIN_SOURCE = "<stdin>";

/**
 * Reads at most MAX_FILE_BYTES bytes. Regular files are rejected by size
 * before reading; pipes and devices are read in chunks and cut off at the
 * limit, so an oversized or endless input never has to fit in memory.
 */
async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (info.isFile() && info.size > MAX_FILE_BYTES)
      throw new InputTooLargeError();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) throw new InputTooLargeError();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/** Reads standard input under the same byte ceiling as file input. */
async function readBoundedStdin(
  stream: AsyncIterable<Buffer | string> = process.stdin,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  // Chunks are strings when a consumer already called setEncoding('utf8'):
  // re-encode so the ceiling counts bytes, not UTF-16 code units.
  for await (const chunk of stream) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    total += buffer.length;
    if (total > MAX_FILE_BYTES) {
      const destroy = (stream as { destroy?: unknown }).destroy;
      if (typeof destroy === "function") (destroy as () => void).call(stream);
      throw new InputTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function parseExportContent(
  content: string,
  invalidJsonMessage: string,
  sourcePath: string,
): PflDocument {
  // A leading UTF-8 BOM (U+FEFF) is part of the transport encoding, not the
  // document: strip exactly one. A BOM anywhere else stays invalid JSON.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PflExportError("invalid-json", invalidJsonMessage);
  }

  return parsePflExport(value, sourcePath);
}

export async function readPflExport(path: string): Promise<PflDocument> {
  let content: string;
  try {
    content = (await readBounded(path)).toString("utf8");
  } catch (error) {
    if (error instanceof InputTooLargeError)
      throw new PflExportError(
        "invalid-shape",
        `input file exceeds the ${MAX_FILE_BYTES}-byte limit: ${path}`,
      );
    throw new PflExportError(
      "unreadable-file",
      `cannot read input file: ${path}`,
    );
  }

  return parseExportContent(
    content,
    `input file is not valid JSON: ${path}`,
    path,
  );
}

export async function readPflExportStdin(
  stream: AsyncIterable<Buffer | string> = process.stdin,
): Promise<PflDocument> {
  let content: string;
  try {
    content = (await readBoundedStdin(stream)).toString("utf8");
  } catch (error) {
    if (error instanceof InputTooLargeError)
      throw new PflExportError(
        "invalid-shape",
        `standard input exceeds the ${MAX_FILE_BYTES}-byte limit`,
      );
    throw new PflExportError("unreadable-file", "cannot read standard input");
  }

  return parseExportContent(
    content,
    "standard input is not valid JSON",
    STDIN_SOURCE,
  );
}
