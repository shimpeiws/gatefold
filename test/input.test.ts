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

  it.each(["inspect", "list", "show", 5, null])(
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

  it("caps interpretation.facets at 1,000 items per element", () => {
    const atCap = validExportDoc();
    atCap.data.elements[0].interpretation.facets = Array.from(
      { length: 1_000 },
      (_, i) => `facet-${i}`,
    );
    expect(() => parsePflExport(atCap, "inline")).not.toThrow();
    const over = validExportDoc();
    over.data.elements[0].interpretation.facets = Array.from(
      { length: 1_001 },
      (_, i) => `facet-${i}`,
    );
    expect(() => parsePflExport(over, "inline")).toThrow(/at most 1000/);
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

    const longKey = validExportDoc();
    longKey.data.elements[0].observed.metadata = {
      nested: { ["k".repeat(4_097)]: true },
    };
    expect(() => parsePflExport(longKey, "inline")).toThrow(/at most 4096/);
    const atKey = validExportDoc();
    atKey.data.elements[0].observed.metadata = {
      ["k".repeat(4_096)]: true,
    };
    expect(() => parsePflExport(atKey, "inline")).not.toThrow();

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

    const diagnostics = validExportDoc();
    diagnostics.diagnostics = [
      { severity: "warning", code: "w", message: over },
    ];
    expect(() => parsePflExport(diagnostics, "inline")).toThrow(/at most 4096/);
    const reportLong = validDoc();
    reportLong.diagnostics = [
      { severity: "warning", code: "w", message: over },
    ];
    expect(() => parsePflExport(reportLong, "inline")).not.toThrow();
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

  it("keeps absent, null, and declared snapshot.sourceProject distinct", () => {
    const absent = parsePflExport(validExportDoc(), "inline");
    if (absent.command !== "export") throw new Error("unreachable");
    expect(absent.data.snapshot.sourceProject).toBeUndefined();

    const doc = validExportDoc();
    doc.data.snapshot.sourceProject = null;
    const nulled = parsePflExport(doc, "inline");
    if (nulled.command !== "export") throw new Error("unreachable");
    expect(nulled.data.snapshot.sourceProject).toBeNull();

    const declared = validExportDoc();
    declared.data.snapshot.sourceProject = {
      id: "git-0123456789abcdef",
      kind: "git-remote",
      remote: "github.com/owner/repo",
      issuer: "yuurei",
      contractVersion: 1,
      head: "0123456789abcdef0123456789abcdef01234567",
    };
    const parsed = parsePflExport(declared, "inline");
    if (parsed.command !== "export") throw new Error("unreachable");
    expect(parsed.data.snapshot.sourceProject).toEqual({
      id: "git-0123456789abcdef",
      kind: "git-remote",
      remote: "github.com/owner/repo",
      issuer: "yuurei",
      contractVersion: 1,
      head: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it.each([
    ["a non-object", "not-an-object", "sourceProject"],
    [
      "a malformed id",
      { id: "bogus", kind: "git-remote", issuer: "yuurei", contractVersion: 1 },
      "sourceProject.id",
    ],
    [
      "an id/kind prefix disagreement",
      {
        id: "git-0123456789abcdef",
        kind: "local-path",
        issuer: "yuurei",
        contractVersion: 1,
      },
      "sourceProject.id",
    ],
    [
      "a remote on a local-path declaration",
      {
        id: "path-0123456789abcdef",
        kind: "local-path",
        remote: "github.com/owner/repo",
        issuer: "yuurei",
        contractVersion: 1,
      },
      "sourceProject.remote",
    ],
    [
      "an empty remote",
      {
        id: "git-0123456789abcdef",
        kind: "git-remote",
        remote: "",
        issuer: "yuurei",
        contractVersion: 1,
      },
      "sourceProject.remote",
    ],
    [
      "a remote carrying control characters",
      {
        id: "git-0123456789abcdef",
        kind: "git-remote",
        remote: "github.com/o/r\x1b[2J",
        issuer: "yuurei",
        contractVersion: 1,
      },
      "sourceProject.remote",
    ],
    [
      "a missing issuer",
      { id: "git-0123456789abcdef", kind: "git-remote", contractVersion: 1 },
      "sourceProject.issuer",
    ],
    [
      "an issuer carrying control characters",
      {
        id: "git-0123456789abcdef",
        kind: "git-remote",
        issuer: "yuu\u202erei",
        contractVersion: 1,
      },
      "sourceProject.issuer",
    ],
    [
      "a missing contractVersion",
      { id: "git-0123456789abcdef", kind: "git-remote", issuer: "yuurei" },
      "sourceProject.contractVersion",
    ],
    [
      "an unsupported contractVersion",
      {
        id: "git-0123456789abcdef",
        kind: "git-remote",
        issuer: "yuurei",
        contractVersion: 2,
      },
      "sourceProject.contractVersion",
    ],
    [
      "an empty head",
      {
        id: "git-0123456789abcdef",
        kind: "git-remote",
        issuer: "yuurei",
        contractVersion: 1,
        head: "",
      },
      "sourceProject.head",
    ],
  ])("rejects sourceProject: %s", (_name, sourceProject, path) => {
    const doc = validExportDoc();
    doc.data.snapshot.sourceProject = sourceProject;
    const error = (() => {
      try {
        parsePflExport(doc, "inline");
        return null;
      } catch (e) {
        return e as PflExportError;
      }
    })();
    expect(error?.code, path).toBe("invalid-shape");
    expect(error?.message, path).toContain(path);
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

function validDiffDoc(): Record<string, any> {
  return {
    pflVersion: "1.0.0",
    command: "diff",
    ok: true,
    completeness: "complete",
    diagnostics: [],
    data: {
      runtime: "claude-code",
      observedSnapshotIdA: "obs_a",
      observedSnapshotIdB: "obs_b",
      resolvedSnapshotIdA: "res_a",
      resolvedSnapshotIdB: "res_b",
      structural: {
        added: 1,
        removed: 0,
        changed: 0,
        addedIds: ["el_added"],
        removedIds: [],
        changedIds: [],
      },
      effective: {
        newlyEffective: 1,
        noLongerEffective: 0,
        activationChanged: 0,
        statusChanges: [{ id: "el_shared", from: "shadowed", to: "effective" }],
      },
      facetDeltas: { instructions: 1, memory: -1 },
      relations: {
        added: [{ type: "overrides", from: "el_added", to: "el_base" }],
        removed: [],
      },
      findings: {
        added: [
          {
            rule: "shadowed-element",
            message: "el_added is shadowed",
            elementIds: ["el_added"],
          },
        ],
        removed: [],
      },
      versionNotes: ["classifier version differs: 5 → 6"],
      interpretation: {
        a: { classifierVersion: "5", origin: "stored" },
        b: { classifierVersion: "6", origin: "recomputed" },
      },
    },
  };
}

const VALID_DIFF = [
  "valid-diff.json",
  "valid-diff-empty.json",
  "valid-diff-partial.json",
];

describe("pfl diff contract", () => {
  it("loads every valid diff fixture as typed data", async () => {
    for (const name of VALID_DIFF) {
      const result = await readPflExport(fixture(name));
      expect(result.command, name).toBe("diff");
      expect(result.data.runtime, name).toBeTruthy();
    }
  });

  it("loads diffs from stdin with the same validation", async () => {
    async function* chunks(): AsyncGenerator<Buffer> {
      const text = await import("node:fs/promises").then((fs) =>
        fs.readFile(fixture("valid-diff.json"), "utf8"),
      );
      yield Buffer.from(text.slice(0, 100));
      yield Buffer.from(text.slice(100));
    }
    const result = await readPflExportStdin(chunks());
    expect(result.command).toBe("diff");
    expect(result.sourcePath).toBe(STDIN_SOURCE);
  });

  it("dispatches diff documents to the diff reader", () => {
    const diff = parsePflExport(validDiffDoc(), "inline");
    expect(diff.command).toBe("diff");
    if (diff.command === "diff") {
      expect(diff.data.structural.added).toBe(1);
      expect(diff.data.interpretation.a.origin).toBe("stored");
      expect(diff.data.interpretation.b.origin).toBe("recomputed");
    }
  });

  it("rejects a diff failure document with its pfl error", async () => {
    const error = await readPflExport(
      fixture("diff-failure-document.json"),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(PflExportError);
    expect(error.code).toBe("export-failed");
    expect(error.message).toContain("CONFIG_ERROR");
  });

  it("rejects diff documents missing required sections", () => {
    for (const key of [
      "runtime",
      "observedSnapshotIdA",
      "resolvedSnapshotIdB",
      "structural",
      "effective",
      "facetDeltas",
      "relations",
      "findings",
      "versionNotes",
      "interpretation",
    ]) {
      const doc = validDiffDoc();
      delete doc.data[key];
      expect(() => parsePflExport(doc, "inline"), key).toThrow(
        /invalid|must be/,
      );
    }
  });

  it("enforces structural count/list invariants", () => {
    const mismatch = validDiffDoc();
    mismatch.data.structural.added = 5;
    expect(() => parsePflExport(mismatch, "inline")).toThrow(/length/);

    const duplicated = validDiffDoc();
    duplicated.data.structural.addedIds = ["el_added", "el_added"];
    duplicated.data.structural.added = 2;
    expect(() => parsePflExport(duplicated, "inline")).toThrow(/unique/);

    const overlap = validDiffDoc();
    overlap.data.structural.removedIds = ["el_added"];
    overlap.data.structural.removed = 1;
    expect(() => parsePflExport(overlap, "inline")).toThrow(/disjoint/);

    const emptyId = validDiffDoc();
    emptyId.data.structural.addedIds = [""];
    expect(() => parsePflExport(emptyId, "inline")).toThrow(/non-empty/);

    const badCount = validDiffDoc();
    badCount.data.structural.changed = -1;
    expect(() => parsePflExport(badCount, "inline")).toThrow(/non-negative/);
  });

  it("validates statusChanges ids and statuses, allowing explicit nulls", () => {
    const doc = validDiffDoc();
    // The contract permits a null side even though pfl only emits
    // statusChanges for ids present on both snapshots; a null side would pair
    // with an added/removed id, which el_added is.
    doc.data.effective.statusChanges.push({
      id: "el_added",
      from: null,
      to: "effective",
    });
    const parsed = parsePflExport(doc, "inline");
    if (parsed.command === "diff")
      expect(parsed.data.effective.statusChanges[1].from).toBeNull();

    const badStatus = validDiffDoc();
    badStatus.data.effective.statusChanges[0].to = "enabled";
    expect(() => parsePflExport(badStatus, "inline")).toThrow(/one of/);

    const dupId = validDiffDoc();
    dupId.data.effective.statusChanges.push({
      id: "el_shared",
      from: "effective",
      to: "shadowed",
    });
    expect(() => parsePflExport(dupId, "inline")).toThrow(/unique/);

    const nonInt = validDiffDoc();
    nonInt.data.effective.newlyEffective = 1.5;
    expect(() => parsePflExport(nonInt, "inline")).toThrow(/non-negative/);
  });

  it("accepts signed facet deltas and unknown facets, rejects non-integers", () => {
    const doc = parsePflExport(validDiffDoc(), "inline");
    if (doc.command === "diff") expect(doc.data.facetDeltas.memory).toBe(-1);

    const bad = validDiffDoc();
    bad.data.facetDeltas.future = 1.5;
    expect(() => parsePflExport(bad, "inline")).toThrow(/safe integer/);
  });

  it("validates relations and findings on both sides", () => {
    const badType = validDiffDoc();
    badType.data.relations.added[0].type = "invents";
    expect(() => parsePflExport(badType, "inline")).toThrow(/one of/);

    const legacy = validDiffDoc();
    legacy.data.relations.added[0].type = "contains";
    expect(() => parsePflExport(legacy, "inline")).not.toThrow();

    const badFinding = validDiffDoc();
    badFinding.data.findings.removed = [{ rule: "x", message: "m" }];
    expect(() => parsePflExport(badFinding, "inline")).toThrow(/elementIds/);
  });

  it("validates interpretation provenance for both sides", () => {
    const bad = validDiffDoc();
    bad.data.interpretation.a.origin = "fresh";
    expect(() => parsePflExport(bad, "inline")).toThrow(/stored|recomputed/);

    const missing = validDiffDoc();
    delete missing.data.interpretation.b;
    expect(() => parsePflExport(missing, "inline")).toThrow(/must be/);
  });

  it("enforces diff resource ceilings at their exact boundaries", () => {
    const atIds = validDiffDoc();
    atIds.data.structural.addedIds = Array.from(
      { length: 10_000 },
      (_, i) => `el_${i}`,
    );
    atIds.data.structural.added = 10_000;
    expect(() => parsePflExport(atIds, "inline")).not.toThrow();
    const overIds = validDiffDoc();
    overIds.data.structural.addedIds = Array.from(
      { length: 10_001 },
      (_, i) => `el_${i}`,
    );
    overIds.data.structural.added = 10_001;
    expect(() => parsePflExport(overIds, "inline")).toThrow(/at most/);

    const overChanges = validDiffDoc();
    overChanges.data.effective.statusChanges = Array.from(
      { length: 10_001 },
      (_, i) => ({ id: `el_${i}`, from: "effective", to: "shadowed" }),
    );
    expect(() => parsePflExport(overChanges, "inline")).toThrow(/at most/);

    const overRelations = validDiffDoc();
    overRelations.data.relations.added = Array.from({ length: 10_001 }, () => ({
      type: "shadows",
      from: "a",
      to: "b",
    }));
    expect(() => parsePflExport(overRelations, "inline")).toThrow(/at most/);

    const overFindings = validDiffDoc();
    overFindings.data.findings.added = Array.from({ length: 10_001 }, () => ({
      rule: "r",
      message: "m",
      elementIds: [],
    }));
    expect(() => parsePflExport(overFindings, "inline")).toThrow(/at most/);

    const overNotes = validDiffDoc();
    overNotes.data.versionNotes = Array.from({ length: 10_001 }, () => "n");
    expect(() => parsePflExport(overNotes, "inline")).toThrow(/at most/);

    const overFacets = validDiffDoc();
    overFacets.data.facetDeltas = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, i) => [`f${i}`, 0]),
    );
    expect(() => parsePflExport(overFacets, "inline")).toThrow(/at most/);
    const atFacets = validDiffDoc();
    atFacets.data.facetDeltas = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, i) => [`f${i}`, 0]),
    );
    expect(() => parsePflExport(atFacets, "inline")).not.toThrow();
  });

  it("shares the total element-id budget across both finding sides", () => {
    const findingsWith = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({
        rule: "r",
        message: "m",
        elementIds: [`${prefix}${i}`],
      }));
    const over = validDiffDoc();
    over.data.findings.added = findingsWith(6_000, "a");
    over.data.findings.removed = findingsWith(6_000, "r");
    expect(() => parsePflExport(over, "inline")).toThrow(/at most/);

    const at = validDiffDoc();
    at.data.findings.added = findingsWith(6_000, "a");
    at.data.findings.removed = findingsWith(4_000, "r");
    expect(() => parsePflExport(at, "inline")).not.toThrow();
  });

  it("caps displayed and provenance-repeated diff strings", () => {
    const longNote = validDiffDoc();
    longNote.data.versionNotes = ["n".repeat(4_097)];
    expect(() => parsePflExport(longNote, "inline")).toThrow(/at most 4096/);
    const atNote = validDiffDoc();
    atNote.data.versionNotes = ["n".repeat(4_096)];
    expect(() => parsePflExport(atNote, "inline")).not.toThrow();

    const longSnapshotId = validDiffDoc();
    longSnapshotId.data.resolvedSnapshotIdA = "s".repeat(1_025);
    expect(() => parsePflExport(longSnapshotId, "inline")).toThrow(
      /at most 1024/,
    );

    const longClassifier = validDiffDoc();
    longClassifier.data.interpretation.b.classifierVersion = "c".repeat(1_025);
    expect(() => parsePflExport(longClassifier, "inline")).toThrow(
      /at most 1024/,
    );

    const longDiagnostic = validDiffDoc();
    longDiagnostic.diagnostics = [
      { severity: "warning", code: "c", message: "m".repeat(4_097) },
    ];
    expect(() => parsePflExport(longDiagnostic, "inline")).toThrow(
      /at most 4096/,
    );
  });

  it("sanitizes untrusted diff text in error messages", () => {
    const doc = validDiffDoc();
    doc.data.structural.addedIds = ["el_1\boverride"];
    doc.data.structural.removedIds = ["el_1\boverride"];
    doc.data.structural.removed = 1;
    const error = (() => {
      try {
        parsePflExport(doc, "inline");
        return null;
      } catch (e) {
        return e as PflExportError;
      }
    })();
    expect(error?.message).toContain("\\u0008");
    expect(error?.message).not.toContain("\b");
  });

  it("ignores unknown additive diff fields without echoing them", async () => {
    const result = await readPflExport(fixture("valid-diff-partial.json"));
    expect(result.command).toBe("diff");
    if (result.command === "diff") {
      const data = result.data as Record<string, unknown>;
      expect(data.futureDataField).toBeUndefined();
      expect(Object.keys(data.facetDeltas)).toContain("future-facet");
    }
    expect(
      (result as Record<string, unknown>).futureEnvelopeField,
    ).toBeUndefined();
  });
});
