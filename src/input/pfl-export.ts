import { open } from "node:fs/promises";
import { sanitizeText } from "../domain/sanitize.js";

export type PflExportErrorCode =
  | "unreadable-file"
  | "invalid-json"
  | "invalid-shape"
  | "unsupported-command"
  | "export-failed"
  | "unsupported-version";

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

export interface PflExport {
  readonly sourcePath: string;
  readonly pflVersion: string;
  readonly completeness: Completeness;
  readonly diagnostics: readonly PflDiagnostic[];
  readonly data: PflReportData;
}

/** Resource ceilings for untrusted exports (see docs/pfl-export-contract.md). */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS = 1_000;
const MAX_FINDINGS = 10_000;
const MAX_ELEMENT_IDS = 1_000;
const MAX_TOTAL_ELEMENT_IDS = 10_000;
const MAX_BY_FACET_KEYS = 1_000;

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
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw shapeError(path, "a non-negative integer");
  return value;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw shapeError(key, "a string");
  return value;
}

function parseDiagnostics(value: unknown): readonly PflDiagnostic[] {
  if (!Array.isArray(value)) throw shapeError("diagnostics", "an array");
  if (value.length > MAX_DIAGNOSTICS)
    throw shapeError(
      "diagnostics",
      `an array with at most ${MAX_DIAGNOSTICS} items`,
    );
  return value.map((item, index) => {
    const at = `diagnostics[${index}]`;
    if (!isRecord(item)) throw shapeError(at, "an object");
    const severity = item.severity;
    if (severity !== "info" && severity !== "warning" && severity !== "error")
      throw shapeError(`${at}.severity`, '"info", "warning", or "error"');
    const diagnostic: PflDiagnostic = {
      severity,
      code: stringField(item, "code", `${at}.code`),
      message: stringField(item, "message", `${at}.message`),
    };
    const path = item.path;
    if (path !== undefined) {
      if (typeof path !== "string") throw shapeError(`${at}.path`, "a string");
      return { ...diagnostic, path };
    }
    return diagnostic;
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
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
        throw shapeError(
          `data.stats.byFacet.${facet}`,
          "a non-negative integer",
        );
      byFacet[facet] = count;
    }
  }
  const findingsValue = value.findings;
  if (!Array.isArray(findingsValue))
    throw shapeError("data.findings", "an array");
  if (findingsValue.length > MAX_FINDINGS)
    throw shapeError(
      "data.findings",
      `an array with at most ${MAX_FINDINGS} items`,
    );
  let totalElementIds = 0;
  const findings = findingsValue.map((item, index) => {
    const at = `data.findings[${index}]`;
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
    totalElementIds += elementIds.length;
    if (totalElementIds > MAX_TOTAL_ELEMENT_IDS)
      throw shapeError(
        "data.findings[*].elementIds",
        `at most ${MAX_TOTAL_ELEMENT_IDS} ids in total across all findings`,
      );
    return {
      rule: stringField(item, "rule", `${at}.rule`),
      message: stringField(item, "message", `${at}.message`),
      elementIds: elementIds as string[],
    };
  });
  const interpretation = value.interpretation;
  if (!isRecord(interpretation))
    throw shapeError("data.interpretation", "an object");
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
      classifierVersion: stringField(
        interpretation,
        "classifierVersion",
        "data.interpretation.classifierVersion",
      ),
      origin,
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
 * (docs/pfl-export-contract.md). Pure: no I/O.
 */
export function parsePflExport(value: unknown, sourcePath: string): PflExport {
  if (!isRecord(value))
    throw new PflExportError(
      "invalid-shape",
      "pfl export must contain an object at the top level",
    );
  const pflVersion = value.pflVersion;
  if (typeof pflVersion !== "string" || pflVersion.length === 0)
    throw shapeError("pflVersion", "a non-empty string");
  if (!isSupportedPflVersion(pflVersion))
    throw new PflExportError(
      "unsupported-version",
      `unsupported pflVersion: ${pflVersion} (supported: >=1.0.0 <2.0.0)`,
    );
  if (value.command !== "report")
    throw new PflExportError(
      "unsupported-command",
      `unsupported pfl command document: ${String(value.command)} (supported: report)`,
    );
  if (value.ok !== true) {
    const error = isRecord(value.data) ? value.data.error : undefined;
    const detail = isRecord(error)
      ? `${String(error.code)}: ${String(error.message)}`
      : "unknown pfl failure";
    throw new PflExportError(
      "export-failed",
      `the pfl export is a failure document (${detail}); run pfl again and pass a successful report`,
    );
  }
  const completeness = value.completeness;
  if (
    completeness !== "complete" &&
    completeness !== "partial" &&
    completeness !== "unknown"
  )
    throw shapeError("completeness", '"complete", "partial", or "unknown"');
  return {
    sourcePath: sanitizeText(sourcePath),
    pflVersion,
    completeness,
    diagnostics: parseDiagnostics(value.diagnostics),
    data: parseReportData(value.data),
  };
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
async function readBoundedStdin(): Promise<Buffer> {
  const stdin = process.stdin;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    total += (chunk as Buffer).length;
    if (total > MAX_FILE_BYTES) {
      stdin.destroy();
      throw new InputTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks, total);
}

function parseExportContent(
  content: string,
  invalidJsonMessage: string,
  sourcePath: string,
): PflExport {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new PflExportError("invalid-json", invalidJsonMessage);
  }

  return parsePflExport(value, sourcePath);
}

export async function readPflExport(path: string): Promise<PflExport> {
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

export async function readPflExportStdin(): Promise<PflExport> {
  let content: string;
  try {
    content = (await readBoundedStdin()).toString("utf8");
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
