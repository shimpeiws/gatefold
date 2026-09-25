import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = new URL("fixtures/pfl-export/", import.meta.url);

async function readFixture(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(name, dir)), "utf8");
}

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFixture(name)) as Record<string, unknown>;
}

const SUPPORTED_VERSION = /^1\./;

describe("pfl export contract fixtures", () => {
  it("valid fixtures satisfy every contract requirement", async () => {
    for (const name of [
      "valid-report.json",
      "valid-report-minimal.json",
      "empty-report.json",
    ]) {
      const doc = await readJson(name);
      expect(doc.pflVersion, name).toMatch(SUPPORTED_VERSION);
      expect(doc.command, name).toBe("report");
      expect(doc.ok, name).toBe(true);
      expect(["complete", "partial", "unknown"], name).toContain(
        doc.completeness,
      );
      expect(Array.isArray(doc.diagnostics), name).toBe(true);
      const data = doc.data as Record<string, unknown>;
      expect(typeof data.runtime, name).toBe("string");
      expect(typeof (data.project as { id: unknown }).id, name).toBe("string");
      const stats = data.stats as Record<string, unknown>;
      for (const key of [
        "observed",
        "effective",
        "shadowed",
        "conditional",
        "opaque",
      ]) {
        expect(Number.isInteger(stats[key]), `${name} stats.${key}`).toBe(true);
      }
      expect(Array.isArray(data.findings), name).toBe(true);
      const interpretation = data.interpretation as Record<string, unknown>;
      expect(typeof interpretation.classifierVersion, name).toBe("string");
      expect(["stored", "recomputed"], name).toContain(interpretation.origin);
    }
  });

  it("unsupported-version.json carries an out-of-range pflVersion", async () => {
    const doc = await readJson("unsupported-version.json");
    expect(doc.pflVersion).not.toMatch(SUPPORTED_VERSION);
  });

  it("wrong-command.json is a valid envelope for a non-report command", async () => {
    const doc = await readJson("wrong-command.json");
    expect(doc.ok).toBe(true);
    expect(doc.command).not.toBe("report");
    expect(doc.pflVersion).toMatch(SUPPORTED_VERSION);
  });

  it("failure-document.json is a well-formed ok:false document", async () => {
    const doc = await readJson("failure-document.json");
    expect(doc.ok).toBe(false);
    const error = (doc.data as { error: { code: unknown } }).error;
    expect(typeof error.code).toBe("string");
  });

  it("invalid-shape.json parses but lacks required data fields", async () => {
    const doc = await readJson("invalid-shape.json");
    expect(doc.command).toBe("report");
    const data = doc.data as Record<string, unknown>;
    expect(data.findings === undefined || data.project === undefined).toBe(
      true,
    );
  });

  it("malformed.json is not valid JSON", async () => {
    const text = await readFixture("malformed.json");
    expect(() => JSON.parse(text)).toThrow();
  });
});
