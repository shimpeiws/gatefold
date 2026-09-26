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
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
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

const VALID_EXPORT_FIXTURES = [
  "valid-export.json",
  "valid-export-empty.json",
  "valid-export-partial.json",
];

const INVALID_EXPORT_FIXTURES = [
  "export-failure-document.json",
  "unsupported-command-diff.json",
  "export-invalid-shape.json",
  "export-mismatched-join.json",
  "export-wrong-enum.json",
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

  it("empty-file.json has no JSON content", async () => {
    const text = await readFixture("empty-file.json");
    expect(text.trim()).toBe("");
    expect(() => JSON.parse(text)).toThrow();
  });

  it("every fixture on disk is classified by this suite", async () => {
    const { readdir } = await import("node:fs/promises");
    const onDisk = await readdir(fileURLToPath(dir));
    expect(
      [
        ...VALID_FIXTURES,
        ...INVALID_FIXTURES,
        ...VALID_EXPORT_FIXTURES,
        ...INVALID_EXPORT_FIXTURES,
      ].sort(),
    ).toEqual(onDisk.sort());
  });
});

describe("pfl export snapshot fixtures", () => {
  const ORIGINS = [
    "project",
    "user",
    "managed",
    "plugin",
    "builtin",
    "unknown",
  ];
  const OBSERVED_STATUSES = [
    "observed",
    "unreadable",
    "unsupported",
    "skipped",
    "unknown",
  ];
  const INSPECTABILITIES = ["observable", "known-runtime-provided", "opaque"];
  const RELATION_TYPES = [
    "shadows",
    "overrides",
    "accumulates-with",
    "contains",
    "discovered-from",
    "resolves-to",
    "applies-to",
  ];

  it("valid export fixtures satisfy the v0.3 export contract", async () => {
    for (const name of VALID_EXPORT_FIXTURES) {
      const doc = await readJson(name);
      expect(inSupportedRange(doc.pflVersion), name).toBe(true);
      expect(doc.command, name).toBe("export");
      expect(doc.ok, name).toBe(true);
      expect(["complete", "partial", "unknown"], name).toContain(
        doc.completeness,
      );
      const data = doc.data as Record<string, any>;
      for (const key of [
        "project",
        "runtime",
        "snapshot",
        "resolution",
        "elements",
        "relations",
        "findings",
        "interpretation",
      ]) {
        expect(data[key], `${name} data.${key}`).toBeDefined();
      }
      expect(typeof data.runtime.version !== "undefined", name).toBe(true);
      expect(
        ["verified", "unverified"],
        `${name} adapter.runtimeCompatibility`,
      ).toContain(data.runtime.adapter.runtimeCompatibility);
      expect(
        ["verified", "unverified-runtime-version"],
        `${name} resolution.confidence`,
      ).toContain(data.resolution.confidence);
      const seenIds = new Set<string>();
      for (const [index, element] of (
        data.elements as Record<string, any>[]
      ).entries()) {
        const at = `${name} elements[${index}]`;
        expect(typeof element.id, at).toBe("string");
        expect(seenIds.has(element.id), `${at} duplicate id`).toBe(false);
        seenIds.add(element.id);
        expect(element.observed.id, at).toBe(element.id);
        expect(
          "resolved" in element && "interpretation" in element,
          `${at} required keys`,
        ).toBe(true);
        if (element.resolved !== null)
          expect(element.resolved.id, at).toBe(element.id);
        if (element.interpretation !== null)
          expect(element.interpretation.elementId, at).toBe(element.id);
        expect(ORIGINS, `${at} native.origin`).toContain(
          element.observed.native.origin,
        );
        expect(
          element.observed.native.scope === null ||
            typeof element.observed.native.scope === "string",
          `${at} native.scope`,
        ).toBe(true);
        expect(OBSERVED_STATUSES, `${at} observed.status`).toContain(
          element.observed.status,
        );
        expect(INSPECTABILITIES, `${at} inspectability`).toContain(
          element.observed.inspectability,
        );
      }
      for (const relation of data.relations as Record<string, any>[]) {
        expect(RELATION_TYPES, `${name} relation.type`).toContain(
          relation.type,
        );
        expect(typeof relation.from, name).toBe("string");
        expect(typeof relation.to, name).toBe("string");
      }
      expect(
        ["stored", "recomputed"],
        `${name} interpretation.origin`,
      ).toContain(data.interpretation.origin);
      expect(typeof data.interpretation.classifier.id, name).toBe("string");
      expect(typeof data.interpretation.classifier.version, name).toBe(
        "string",
      );
    }
  });

  it("partial export fixture exercises diagnostics and unknown fields", async () => {
    const doc = await readJson("valid-export-partial.json");
    expect(doc.completeness).toBe("partial");
    expect((doc.diagnostics as unknown[]).length).toBeGreaterThan(0);
    expect(doc.futureEnvelopeField).toBeDefined();
    const data = doc.data as Record<string, any>;
    expect(data.futureDataField).toBeDefined();
    expect(data.elements[0].futureElementField).toBeDefined();
    expect(
      data.elements.some(
        (element: Record<string, any>) =>
          element.resolved === null && element.interpretation === null,
      ),
    ).toBe(true);
  });

  it("empty export fixture carries zero contents in required arrays", async () => {
    const doc = await readJson("valid-export-empty.json");
    const data = doc.data as Record<string, any>;
    expect(data.elements).toEqual([]);
    expect(data.relations).toEqual([]);
    expect(data.findings).toEqual([]);
    expect(data.runtime.version).toBeNull();
  });

  it("invalid export fixtures violate the contract for distinct reasons", async () => {
    expect((await readJson("export-failure-document.json")).ok).toBe(false);
    expect((await readJson("unsupported-command-diff.json")).command).toBe(
      "diff",
    );
    const shape = (await readJson("export-invalid-shape.json")).data as Record<
      string,
      any
    >;
    expect(shape.snapshot === undefined).toBe(true);
    const joined = (await readJson("export-mismatched-join.json"))
      .data as Record<string, any>;
    expect(joined.elements[0].resolved.id).not.toBe(joined.elements[0].id);
    const badEnum = (await readJson("export-wrong-enum.json")).data as Record<
      string,
      any
    >;
    expect(OBSERVED_STATUSES).not.toContain(
      badEnum.elements[0].observed.status,
    );
  });
});
