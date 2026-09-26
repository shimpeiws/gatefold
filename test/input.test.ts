import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeText } from "../src/domain/sanitize.js";
import {
  isSupportedPflVersion,
  PflExportError,
  parsePflExport,
  readPflExport,
  readPflExportStdin,
  STDIN_SOURCE,
} from "../src/input/pfl-export.js";

const dir = new URL("fixtures/pfl-export/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, dir));

const VALID = [
  "valid-report.json",
  "valid-report-minimal.json",
  "valid-report-partial.json",
  "empty-report.json",
];

function validDoc(): Record<string, any> {
  return {
    pflVersion: "1.0.0",
    command: "report",
    ok: true,
    completeness: "complete",
    diagnostics: [],
    data: {
      runtime: "codex",
      project: { id: "p", displayName: "d" },
      stats: {
        observed: 0,
        effective: 0,
        shadowed: 0,
        conditional: 0,
        opaque: 0,
      },
      findings: [],
      interpretation: { classifierVersion: "1", origin: "stored" },
    },
  };
}

describe("readPflExport contract", () => {
  it("loads every valid fixture as typed data", async () => {
    for (const name of VALID) {
      const result = await readPflExport(fixture(name));
      expect(result.pflVersion, name).toMatch(/^1\./);
      expect(result.data.runtime, name).toBeTruthy();
      expect(Array.isArray(result.data.findings), name).toBe(true);
      expect(Number.isInteger(result.data.stats.observed), name).toBe(true);
    }
  });

  it("keeps provenance metadata on the typed result", async () => {
    const path = fixture("valid-report-partial.json");
    const result = await readPflExport(path);
    expect(result.sourcePath).toBe(path);
    expect(result.pflVersion).toBe("1.2.3");
    expect(result.completeness).toBe("partial");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe("runtime-version-unverified");
  });

  it("ignores unknown envelope and data fields", async () => {
    await expect(
      readPflExport(fixture("valid-report-partial.json")),
    ).resolves.toBeDefined();
  });

  it.each([
    [
      "unsupported-version.json",
      "unsupported-version",
      "unsupported pflVersion",
    ],
    [
      "unsupported-version-low.json",
      "unsupported-version",
      "unsupported pflVersion",
    ],
    ["wrong-command.json", "unsupported-command", "unsupported pfl command"],
    ["failure-document.json", "export-failed", "failure document"],
    ["invalid-shape.json", "invalid-shape", "data.findings"],
    ["invalid-diagnostics.json", "invalid-shape", "diagnostics"],
    ["non-object.json", "invalid-shape", "top level"],
    ["malformed.json", "invalid-json", "not valid JSON"],
  ])("rejects %s with code %s", async (name, code, messagePart) => {
    const error = await readPflExport(fixture(name)).catch((e) => e);
    expect(error).toBeInstanceOf(PflExportError);
    expect((error as PflExportError).code).toBe(code);
    expect((error as PflExportError).message).toContain(messagePart);
  });

  it("rejects an unreadable file", async () => {
    const error = await readPflExport(fixture("does-not-exist.json")).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(PflExportError);
    expect((error as PflExportError).code).toBe("unreadable-file");
    expect((error as PflExportError).message).toContain("cannot read");
  });

  it("surfaces the pfl error code from a failure document", async () => {
    await expect(
      readPflExport(fixture("failure-document.json")),
    ).rejects.toThrow("SNAPSHOT_STORE_FAILED");
  });

  it("classifies missing/mistyped pflVersion as invalid-shape", () => {
    for (const doc of [
      { command: "report", ok: true },
      { pflVersion: 1, command: "report", ok: true },
      { pflVersion: "", command: "report", ok: true },
    ]) {
      const error = (() => {
        try {
          parsePflExport(doc, "inline");
          return null;
        } catch (e) {
          return e as PflExportError;
        }
      })();
      expect(error?.code).toBe("invalid-shape");
      expect(error?.message).toContain("pflVersion");
    }
  });

  it("parsePflExport validates without file I/O", () => {
    const doc = {
      pflVersion: "1.0.0",
      command: "report",
      ok: true,
      completeness: "complete",
      diagnostics: [],
      data: {
        runtime: "codex",
        project: { id: "p", displayName: "d" },
        stats: {
          observed: 0,
          effective: 0,
          shadowed: 0,
          conditional: 0,
          opaque: 0,
        },
        findings: [],
        interpretation: { classifierVersion: "1", origin: "stored" },
      },
    };
    const result = parsePflExport(doc, "inline");
    expect(result.sourcePath).toBe("inline");
  });

  it("keeps prototype-named byFacet keys as real own keys", () => {
    const doc = validDoc();
    doc.data.stats.byFacet = JSON.parse('{"__proto__": 2, "actions": 1}');
    const result = parsePflExport(doc, "inline");
    expect(
      Object.prototype.hasOwnProperty.call(
        result.data.stats.byFacet,
        "__proto__",
      ),
    ).toBe(true);
    expect(result.data.stats.byFacet?.["__proto__"]).toBe(2);
  });

  it("rejects empty strings in finding elementIds", () => {
    const doc = validDoc();
    doc.data.findings = [{ rule: "r", message: "m", elementIds: [""] }];
    expect(() => parsePflExport(doc, "inline")).toThrow(
      /elementIds.*non-empty/,
    );
  });

  it("rejects exports that exceed the resource ceilings", () => {
    const doc = validDoc();
    doc.data.findings = Array.from({ length: 10_001 }, () => ({
      rule: "r",
      message: "m",
      elementIds: [],
    }));
    expect(() => parsePflExport(doc, "inline")).toThrow(/at most/);
  });

  it("accepts a report citing exactly 10,000 element ids in total", () => {
    const doc = validDoc();
    doc.data.findings = Array.from({ length: 10 }, (_, f) => ({
      rule: "r",
      message: "m",
      elementIds: Array.from({ length: 1_000 }, (_, i) => `f${f}-e${i}`),
    }));
    const result = parsePflExport(doc, "inline");
    expect(
      result.data.findings.reduce((n, f) => n + f.elementIds.length, 0),
    ).toBe(10_000);
  });

  it("rejects more than 10,000 element ids spread across findings", () => {
    const doc = validDoc();
    doc.data.findings = [
      ...Array.from({ length: 10 }, (_, f) => ({
        rule: "r",
        message: "m",
        elementIds: Array.from({ length: 1_000 }, (_, i) => `f${f}-e${i}`),
      })),
      { rule: "r", message: "m", elementIds: ["one-too-many"] },
    ];
    const error = (() => {
      try {
        parsePflExport(doc, "inline");
        return null;
      } catch (e) {
        return e as PflExportError;
      }
    })();
    expect(error?.code).toBe("invalid-shape");
    expect(error?.message).toContain("at most 10000");
  });

  it("rejects metadata strings longer than the per-field character cap", () => {
    const over = "x".repeat(1_025);
    for (const mutate of [
      (doc: Record<string, any>) => {
        doc.data.interpretation.classifierVersion = over;
      },
      (doc: Record<string, any>) => {
        doc.data.runtimeName = over;
      },
      (doc: Record<string, any>) => {
        doc.data.observedSnapshotId = over;
      },
      (doc: Record<string, any>) => {
        doc.data.resolvedSnapshotId = over;
      },
      (doc: Record<string, any>) => {
        doc.data.confidence = over;
      },
      (doc: Record<string, any>) => {
        doc.pflVersion = `1.0.${"0".repeat(2_000)}`;
      },
    ]) {
      const doc = validDoc();
      mutate(doc);
      expect(() => parsePflExport(doc, "inline")).toThrow(/at most 1024/);
    }
    const atCap = validDoc();
    atCap.data.interpretation.classifierVersion = "x".repeat(1_024);
    atCap.data.runtimeName = "x".repeat(1_024);
    atCap.data.observedSnapshotId = "x".repeat(1_024);
    expect(() => parsePflExport(atCap, "inline")).not.toThrow();
  });

  it("accepts stdin chunks delivered as strings (setEncoding consumers)", async () => {
    async function* stringChunks(): AsyncGenerator<string> {
      const text = JSON.stringify(validDoc());
      yield text.slice(0, 10);
      yield text.slice(10);
    }
    const result = await readPflExportStdin(stringChunks());
    expect(result.sourcePath).toBe(STDIN_SOURCE);
    expect(result.pflVersion).toBe("1.0.0");
  });

  it("counts stdin bytes, not characters, when chunks arrive as strings", async () => {
    async function* bigString(): AsyncGenerator<string> {
      // 'é' is one UTF-16 code unit but two UTF-8 bytes: 9M chars ≈ 18 MB.
      yield "é".repeat(9_000_000);
    }
    await expect(readPflExportStdin(bigString())).rejects.toMatchObject({
      code: "invalid-shape",
    });
  });

  it("accepts a document with a leading UTF-8 BOM", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "gatefold-bom-"));
    const path = join(tmp, "bom.json");
    try {
      await writeFile(path, "\uFEFF" + JSON.stringify(validDoc()), "utf8");
      const result = await readPflExport(path);
      expect(result.pflVersion).toBe("1.0.0");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("still rejects a BOM appearing after the first character", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "gatefold-bom-"));
    const path = join(tmp, "mid-bom.json");
    try {
      const doc = JSON.stringify(validDoc());
      await writeFile(path, doc.slice(0, 1) + "\uFEFF" + doc.slice(1), "utf8");
      await expect(readPflExport(path)).rejects.toMatchObject({
        code: "invalid-json",
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non-safe integers in stats and byFacet counts", () => {
    const unsafe = validDoc();
    unsafe.data.stats.observed = 2 ** 53;
    expect(() => parsePflExport(unsafe, "inline")).toThrow(/safe integer/);

    const unsafeFacet = validDoc();
    unsafeFacet.data.stats.byFacet = { actions: Number.MAX_SAFE_INTEGER + 1 };
    expect(() => parsePflExport(unsafeFacet, "inline")).toThrow(/safe integer/);

    const safe = validDoc();
    safe.data.stats.observed = Number.MAX_SAFE_INTEGER;
    safe.data.stats.byFacet = { actions: Number.MAX_SAFE_INTEGER };
    expect(() => parsePflExport(safe, "inline")).not.toThrow();
  });

  it("sanitizes control characters in the input path on errors", async () => {
    const badPath = "missing-\x1b[2J-file.json";
    await expect(readPflExport(badPath)).rejects.toMatchObject({
      code: "unreadable-file",
    });
    await expect(readPflExport(badPath)).rejects.toThrow(/\\u001b/);
    try {
      await readPflExport(badPath);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    }
  });

  it("sanitizes untrusted export text in PflExportError messages", () => {
    const cases: Record<string, unknown>[] = [
      { ...validDoc(), command: "x\x1b[31m\u202e" },
      { ...validDoc(), pflVersion: "2.0.0\x1b[2J" },
      {
        ...validDoc(),
        ok: false,
        data: { error: { code: "E\x07", message: "boom\u2028\x1b[0m" } },
      },
    ];
    const withFacet = validDoc();
    withFacet.data.stats.byFacet = { "evil\x1b[2J\u202e": -1 };
    cases.push(withFacet);
    for (const doc of cases) {
      try {
        parsePflExport(doc, "inline");
        expect.unreachable("parsePflExport should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PflExportError);
        expect(sanitizeText((error as Error).message)).toBe(
          (error as Error).message,
        );
      }
    }
  });

  it("measures the size limit in bytes, not UTF-16 code units", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "gatefold-"));
    const path = join(tmp, "multibyte.json");
    try {
      // 6M three-byte characters: ~18 MiB on disk, but only 6M code units.
      const doc = { ...validDoc(), pad: "\u3042".repeat(6 * 1024 * 1024) };
      await writeFile(path, JSON.stringify(doc));
      await expect(readPflExport(path)).rejects.toMatchObject({
        code: "invalid-shape",
        message: expect.stringMatching(/byte limit/),
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("isSupportedPflVersion implements the >=1.0.0 <2.0.0 range", () => {
    for (const v of [
      "1.0.0",
      "1.2.3",
      "1.99.99",
      "1.0.0+build.1",
      "1.0.0+abc-def.123",
    ]) {
      expect(isSupportedPflVersion(v), v).toBe(true);
    }
    for (const v of [
      "0.9.9",
      "2.0.0",
      "1.0.0-alpha",
      "1.0",
      "v1.0.0",
      "",
      "1.0.0+",
      "2.0.0+build",
    ]) {
      expect(isSupportedPflVersion(v), v).toBe(false);
    }
  });
});

function validExportDoc(): Record<string, any> {
  return {
    pflVersion: "1.0.0",
    command: "export",
    ok: true,
    completeness: "complete",
    diagnostics: [],
    data: {
      project: { id: "p", displayName: "d" },
      runtime: {
        id: "claude-code",
        version: "2.0.0",
        adapter: {
          id: "claude-code",
          version: "0.1.1",
          runtimeCompatibility: "verified",
        },
      },
      snapshot: {
        observedSnapshotId: "obs_1",
        resolvedSnapshotId: "res_1",
        capturedAt: "2026-09-18T00:00:00.000Z",
        schemaVersion: "1",
      },
      resolution: { semanticsVersion: "2", confidence: "verified" },
      elements: [
        {
          id: "el_1",
          observed: {
            id: "el_1",
            native: { kind: "instructions", origin: "project", scope: "p" },
            source: { path: "CLAUDE.md" },
            inspectability: "observable",
            metadata: {},
            status: "observed",
          },
          resolved: {
            id: "el_1",
            status: "effective",
            activation: "always",
            resolution: { strategy: "accumulate" },
          },
          interpretation: {
            elementId: "el_1",
            facets: ["instructions"],
            confidence: "high",
            reason: "defines agent behavior",
          },
        },
      ],
      relations: [],
      findings: [],
      interpretation: {
        classifier: { id: "pfl-native", version: "5" },
        origin: "stored",
      },
    },
  };
}

const VALID_EXPORT = [
  "valid-export.json",
  "valid-export-empty.json",
  "valid-export-partial.json",
];

describe("pfl export snapshot contract", () => {
  it("loads every valid export fixture as typed data", async () => {
    for (const name of VALID_EXPORT) {
      const result = await readPflExport(fixture(name));
      expect(result.command, name).toBe("export");
      if (result.command !== "export") throw new Error("unreachable");
      expect(result.pflVersion, name).toMatch(/^1\./);
      expect(Array.isArray(result.data.elements), name).toBe(true);
      expect(Array.isArray(result.data.relations), name).toBe(true);
      expect(result.data.interpretation.classifier.id, name).toBeTruthy();
    }
  });

  it("loads exports from stdin with the same validation", async () => {
    async function* chunks(): AsyncGenerator<Buffer> {
      const text = JSON.stringify(validExportDoc());
      yield Buffer.from(text.slice(0, 100));
      yield Buffer.from(text.slice(100));
    }
    const result = await readPflExportStdin(chunks());
    expect(result.command).toBe("export");
    expect(result.sourcePath).toBe(STDIN_SOURCE);
  });

  it("dispatches on command: report and export are read by their own readers", () => {
    const report = parsePflExport(validDoc(), "inline");
    expect(report.command).toBe("report");
    if (report.command === "report")
      expect(typeof report.data.stats).toBe("object");
    const exported = parsePflExport(validExportDoc(), "inline");
    expect(exported.command).toBe("export");
    if (exported.command === "export")
      expect(Array.isArray(exported.data.elements)).toBe(true);
  });

  it.each(["diff", "inspect", "list", "show", 5, null])(
    "rejects command %s as unsupported-command",
    (command) => {
      const doc = validExportDoc();
      doc.command = command;
      const error = (() => {
        try {
          parsePflExport(doc, "inline");
          return null;
        } catch (e) {
          return e as PflExportError;
        }
      })();
      expect(error?.code).toBe("unsupported-command");
    },
  );

  it("rejects an export failure document with its pfl error", async () => {
    const error = await readPflExport(
      fixture("export-failure-document.json"),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(PflExportError);
    expect(error.code).toBe("export-failed");
    expect(error.message).toContain("SNAPSHOT_NOT_FOUND");
  });

  it.each([
    ["data", undefined],
    ["data.project", undefined],
    ["data.runtime.adapter", undefined],
    ["data.snapshot", undefined],
    ["data.resolution", undefined],
    ["data.elements", undefined],
    ["data.relations", undefined],
    ["data.findings", undefined],
    ["data.interpretation", undefined],
    ["data.interpretation.classifier", undefined],
    ["data.elements[0].observed", undefined],
    ["data.elements[0].resolved", undefined],
    ["data.elements[0].interpretation", undefined],
    ["data.elements[0].observed.native", undefined],
    ["data.elements[0].observed.source", undefined],
    ["data.elements[0].observed.metadata", undefined],
    ["data.elements[0].observed.status", undefined],
    ["data.elements[0].observed.inspectability", undefined],
    ["data.runtime.version", undefined],
    ["data.elements[0].observed.native.scope", undefined],
  ])("rejects export data missing %s", (path) => {
    const doc = validExportDoc();
    const segments = path.replace(/\]/g, "").split(/[.[]/);
    let node: any = doc;
    for (const segment of segments.slice(0, -1)) node = node[segment];
    delete node[segments[segments.length - 1]];
    const error = (() => {
      try {
        parsePflExport(doc, "inline");
        return null;
      } catch (e) {
        return e as PflExportError;
      }
    })();
    expect(error?.code, path).toBe("invalid-shape");
  });

  it.each([
    ["data.elements[0].observed.native.origin", "in-house"],
    ["data.elements[0].observed.status", "half-observed"],
    ["data.elements[0].observed.inspectability", "clear"],
    ["data.elements[0].observed.reason", "because"],
    ["data.elements[0].resolved.status", "live"],
    ["data.elements[0].resolved.activation", "sometimes"],
    ["data.elements[0].resolved.resolution.strategy", "merge"],
    ["data.elements[0].interpretation.confidence", "low"],
    ["data.resolution.confidence", "probably"],
    ["data.runtime.adapter.runtimeCompatibility", "maybe"],
    ["data.interpretation.origin", "guessed"],
    [
      "data.relations[0].type",
      "depends-on",
      [{ type: "shadows", from: "el_1", to: "el_1" }],
    ],
  ])("rejects invalid enum at %s", (path, bad, relations) => {
    const doc = validExportDoc();
    if (relations !== undefined) doc.data.relations = relations;
    const segments = path.replace(/\]/g, "").split(/[.[]/);
    let node: any = doc;
    for (const segment of segments.slice(0, -1)) node = node[segment];
    node[segments[segments.length - 1]] = bad;
    expect(() => parsePflExport(doc, "inline"), path).toThrow(
      /invalid|one of|must be/,
    );
  });

  it("rejects relation endpoints that name unknown element ids", () => {
    for (const mutate of [
      (doc: Record<string, any>) => {
        doc.data.relations = [
          { type: "shadows", from: "el_ghost", to: "el_1" },
        ];
      },
      (doc: Record<string, any>) => {
        doc.data.relations = [
          { type: "shadows", from: "el_1", to: "el_ghost" },
        ];
      },
      (doc: Record<string, any>) => {
        doc.data.elements = [];
        doc.data.relations = [{ type: "shadows", from: "el_1", to: "el_1" }];
      },
    ]) {
      const doc = validExportDoc();
      mutate(doc);
      const error = (() => {
        try {
          parsePflExport(doc, "inline");
          return null;
        } catch (e) {
          return e as PflExportError;
        }
      })();
      expect(error?.code).toBe("invalid-shape");
      expect(error?.message).toContain("is unknown");
    }
  });

  it("accepts every persisted relation type pfl can read", () => {
    const doc = validExportDoc();
    for (const type of [
      "shadows",
      "overrides",
      "accumulates-with",
      "contains",
      "discovered-from",
      "resolves-to",
      "applies-to",
    ]) {
      doc.data.relations = [{ type, from: "el_1", to: "el_1" }];
      expect(() => parsePflExport(doc, "inline"), type).not.toThrow();
    }
  });

  it("rejects mismatched joined ids, duplicate ids, and missing layer keys", () => {
    for (const mutate of [
      (doc: Record<string, any>) => {
        doc.data.elements[0].observed.id = "el_other";
      },
      (doc: Record<string, any>) => {
        doc.data.elements[0].resolved.id = "el_other";
      },
      (doc: Record<string, any>) => {
        doc.data.elements[0].interpretation.elementId = "el_other";
      },
      (doc: Record<string, any>) => {
        doc.data.elements.push(
          JSON.parse(JSON.stringify(doc.data.elements[0])),
        );
      },
      (doc: Record<string, any>) => {
        delete doc.data.elements[0].resolved;
      },
      (doc: Record<string, any>) => {
        delete doc.data.elements[0].interpretation;
      },
    ]) {
      const doc = validExportDoc();
      mutate(doc);
      const error = (() => {
        try {
          parsePflExport(doc, "inline");
          return null;
        } catch (e) {
          return e as PflExportError;
        }
      })();
      expect(error?.code).toBe("invalid-shape");
    }
  });

  it("accepts null layers and nullable scalars where the contract allows", () => {
    const doc = validExportDoc();
    doc.data.elements[0].resolved = null;
    doc.data.elements[0].interpretation = null;
    doc.data.runtime.version = null;
    doc.data.elements[0].observed.native.scope = null;
    const result = parsePflExport(doc, "inline");
    if (result.command === "export") {
      expect(result.data.elements[0].resolved).toBeNull();
      expect(result.data.elements[0].interpretation).toBeNull();
      expect(result.data.runtime.version).toBeNull();
      expect(result.data.elements[0].observed.native.scope).toBeNull();
    }
  });

  it("rejects null where the contract does not allow it", () => {
    for (const mutate of [
      (doc: Record<string, any>) => {
        doc.data.project = null;
      },
      (doc: Record<string, any>) => {
        doc.data.runtime.id = null;
      },
      (doc: Record<string, any>) => {
        doc.data.elements[0].observed = null;
      },
      (doc: Record<string, any>) => {
        doc.data.elements[0].observed.native = null;
      },
      (doc: Record<string, any>) => {
        doc.data.snapshot.capturedAt = null;
      },
      (doc: Record<string, any>) => {
        doc.data.elements[0].interpretation.reason = null;
      },
    ]) {
      const doc = validExportDoc();
      mutate(doc);
      expect(() => parsePflExport(doc, "inline")).toThrow(/invalid|must be/);
    }
  });

  it("enforces the export resource ceilings at their exact boundaries", () => {
    const element = () =>
      JSON.parse(JSON.stringify(validExportDoc().data.elements[0]));
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const e = element();
        e.id = `el_${i}`;
        e.observed.id = `el_${i}`;
        e.resolved.id = `el_${i}`;
        e.interpretation.elementId = `el_${i}`;
        return e;
      });

    const atElements = validExportDoc();
    atElements.data.elements = many(10_000);
    expect(() => parsePflExport(atElements, "inline")).not.toThrow();
    const overElements = validExportDoc();
    overElements.data.elements = many(10_001);
    expect(() => parsePflExport(overElements, "inline")).toThrow(/at most/);

    const atRelations = validExportDoc();
    atRelations.data.relations = Array.from({ length: 20_000 }, () => ({
      type: "shadows",
      from: "el_1",
      to: "el_1",
    }));
    expect(() => parsePflExport(atRelations, "inline")).not.toThrow();
    const overRelations = validExportDoc();
    overRelations.data.relations = Array.from({ length: 20_001 }, () => ({
      type: "shadows",
      from: "el_1",
      to: "el_1",
    }));
    expect(() => parsePflExport(overRelations, "inline")).toThrow(/at most/);
  });

  it("bounds nested metadata depth and node count per element", () => {
    const deep = (levels: number): unknown =>
      levels === 0 ? 1 : { next: deep(levels - 1) };
    const atDepth = validExportDoc();
    atDepth.data.elements[0].observed.metadata = deep(12);
    expect(() => parsePflExport(atDepth, "inline")).not.toThrow();
    const overDepth = validExportDoc();
    overDepth.data.elements[0].observed.metadata = deep(13);
    expect(() => parsePflExport(overDepth, "inline")).toThrow(/deeper/);

    const wide = validExportDoc();
    wide.data.elements[0].observed.metadata = {
      list: Array.from({ length: 10_001 }, () => 0),
    };
    expect(() => parsePflExport(wide, "inline")).toThrow(/at most/);
    const atNodes = validExportDoc();
    atNodes.data.elements[0].observed.metadata = {
      list: Array.from({ length: 9_998 }, () => 0),
    };
    expect(() => parsePflExport(atNodes, "inline")).not.toThrow();
  });

  it("caps displayed and provenance-repeated strings", () => {
    const over = "x".repeat(4_097);
    const atCap = "x".repeat(4_096);
    const overMeta = "x".repeat(1_025);

    const scalar = validExportDoc();
    scalar.data.elements[0].id = over;
    expect(() => parsePflExport(scalar, "inline")).toThrow(/at most 4096/);
    const okScalar = validExportDoc();
    okScalar.data.elements[0].id = atCap;
    okScalar.data.elements[0].observed.id = atCap;
    okScalar.data.elements[0].resolved.id = atCap;
    okScalar.data.elements[0].interpretation.elementId = atCap;
    expect(() => parsePflExport(okScalar, "inline")).not.toThrow();

    for (const mutate of [
      (doc: Record<string, any>) => {
        doc.data.snapshot.observedSnapshotId = overMeta;
      },
      (doc: Record<string, any>) => {
        doc.data.snapshot.resolvedSnapshotId = overMeta;
      },
      (doc: Record<string, any>) => {
        doc.data.interpretation.classifier.version = overMeta;
      },
    ]) {
      const doc = validExportDoc();
      mutate(doc);
      expect(() => parsePflExport(doc, "inline")).toThrow(/at most 1024/);
    }

    const semantics = validExportDoc();
    semantics.data.resolution.semanticsVersion = overMeta;
    expect(() => parsePflExport(semantics, "inline")).not.toThrow();
    semantics.data.resolution.semanticsVersion = over;
    expect(() => parsePflExport(semantics, "inline")).toThrow(/at most 4096/);
  });

  it("sanitizes untrusted export text in error messages", () => {
    const doc = validExportDoc();
    doc.data.elements[0].observed.id = "el_\x1b[2J\u202e";
    try {
      parsePflExport(doc, "inline");
      expect.unreachable("expected a join mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(PflExportError);
      expect(sanitizeText((error as Error).message)).toBe(
        (error as Error).message,
      );
    }
  });

  it("ignores unknown additive fields without echoing them", async () => {
    const result = await readPflExport(fixture("valid-export-partial.json"));
    expect(result.command).toBe("export");
    if (result.command === "export") {
      expect((result.data as Record<string, unknown>).futureDataField).toBe(
        undefined,
      );
      expect(
        (result.data.elements[0] as Record<string, unknown>).futureElementField,
      ).toBeUndefined();
      expect(
        (result.data.elements[0].observed as Record<string, unknown>)
          .futureObservedField,
      ).toBeUndefined();
    }
  });
});
