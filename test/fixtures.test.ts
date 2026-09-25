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

/** Mirrors the contract's accepted range: pflVersion >=1.0.0 <2.0.0. */
function inSupportedRange(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  return Number(match[1]) === 1;
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

const VALID_FIXTURES = [
  "valid-report.json",
  "valid-report-minimal.json",
  "valid-report-partial.json",
  "empty-report.json",
];

const INVALID_FIXTURES = [
  "unsupported-version.json",
  "unsupported-version-low.json",
  "wrong-command.json",
  "failure-document.json",
  "invalid-shape.json",
  "invalid-diagnostics.json",
  "non-object.json",
  "malformed.json",
  "empty-file.json",
];

describe("pfl export contract fixtures", () => {
  it("valid fixtures satisfy every contract requirement", async () => {
    for (const name of VALID_FIXTURES) {
      const doc = await readJson(name);
      expect(inSupportedRange(doc.pflVersion), name).toBe(true);
      expect(doc.command, name).toBe("report");
      expect(doc.ok, name).toBe(true);
      expect(["complete", "partial", "unknown"], name).toContain(
        doc.completeness,
      );
      expect(Array.isArray(doc.diagnostics), name).toBe(true);
      for (const diagnostic of doc.diagnostics as unknown[]) {
        const d = diagnostic as Record<string, unknown>;
        expect(["info", "warning", "error"], `${name} diagnostic`).toContain(
          d.severity,
        );
        expect(typeof d.code, `${name} diagnostic.code`).toBe("string");
        expect(typeof d.message, `${name} diagnostic.message`).toBe("string");
      }
      const data = doc.data as Record<string, unknown>;
      expect(typeof data.runtime, name).toBe("string");
      const project = data.project as Record<string, unknown>;
      expect(typeof project.id, name).toBe("string");
      expect(typeof project.displayName, name).toBe("string");
      const stats = data.stats as Record<string, unknown>;
      for (const key of [
        "observed",
        "effective",
        "shadowed",
        "conditional",
        "opaque",
      ]) {
        expect(isNonNegativeInteger(stats[key]), `${name} stats.${key}`).toBe(
          true,
        );
      }
      if (stats.byFacet !== undefined) {
        for (const [facet, count] of Object.entries(
          stats.byFacet as Record<string, unknown>,
        )) {
          expect(isNonNegativeInteger(count), `${name} byFacet.${facet}`).toBe(
            true,
          );
        }
      }
      expect(Array.isArray(data.findings), name).toBe(true);
      for (const finding of data.findings as unknown[]) {
        const f = finding as Record<string, unknown>;
        expect(typeof f.rule, `${name} finding.rule`).toBe("string");
        expect(typeof f.message, `${name} finding.message`).toBe("string");
        expect(Array.isArray(f.elementIds), `${name} finding.elementIds`).toBe(
          true,
        );
      }
      const interpretation = data.interpretation as Record<string, unknown>;
      expect(typeof interpretation.classifierVersion, name).toBe("string");
      expect(["stored", "recomputed"], name).toContain(interpretation.origin);
    }
  });

  it("partial-report fixture exercises unknown fields and diagnostics", async () => {
    const doc = await readJson("valid-report-partial.json");
    expect(doc.completeness).toBe("partial");
    expect(doc.futureField).toBeDefined();
    expect((doc.data as Record<string, unknown>).futureDataField).toBeDefined();
    expect((doc.diagnostics as unknown[]).length).toBeGreaterThan(0);
  });

  it("invalid fixtures violate the contract for distinct reasons", async () => {
    expect(
      inSupportedRange((await readJson("unsupported-version.json")).pflVersion),
    ).toBe(false);
    expect(
      inSupportedRange(
        (await readJson("unsupported-version-low.json")).pflVersion,
      ),
    ).toBe(false);
    expect((await readJson("wrong-command.json")).command).not.toBe("report");
    expect((await readJson("failure-document.json")).ok).toBe(false);
    const shape = (await readJson("invalid-shape.json")).data as Record<
      string,
      unknown
    >;
    expect(shape.findings === undefined || shape.project === undefined).toBe(
      true,
    );
    const diag = await readJson("invalid-diagnostics.json");
    expect(
      (diag.diagnostics as unknown[]).some(
        (d) =>
          typeof d !== "object" ||
          d === null ||
          typeof (d as Record<string, unknown>).message !== "string",
      ),
    ).toBe(true);
    expect(Array.isArray(await readJson("non-object.json"))).toBe(true);
  });

  it("malformed.json is not valid JSON", async () => {
    const text = await readFixture("malformed.json");
    expect(() => JSON.parse(text)).toThrow();
  });

  it("every fixture on disk is classified by this suite", async () => {
    const { readdir } = await import("node:fs/promises");
    const onDisk = await readdir(fileURLToPath(dir));
    expect([...VALID_FIXTURES, ...INVALID_FIXTURES].sort()).toEqual(
      onDisk.sort(),
    );
  });
});
