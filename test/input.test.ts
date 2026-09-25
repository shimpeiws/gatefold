import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isSupportedPflVersion,
  PflExportError,
  parsePflExport,
  readPflExport,
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
