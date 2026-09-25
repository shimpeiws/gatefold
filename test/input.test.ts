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

  it("isSupportedPflVersion implements the >=1.0.0 <2.0.0 range", () => {
    for (const v of ["1.0.0", "1.2.3", "1.99.99"]) {
      expect(isSupportedPflVersion(v), v).toBe(true);
    }
    for (const v of ["0.9.9", "2.0.0", "1.0.0-alpha", "1.0", "v1.0.0", ""]) {
      expect(isSupportedPflVersion(v), v).toBe(false);
    }
  });
});
