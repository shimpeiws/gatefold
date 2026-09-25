import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { CLAIM_SCHEMA_VERSION } from "../src/domain/claim.js";
import type { AnalysisResult } from "../src/domain/claim.js";
import { assertValidResult } from "../src/domain/validate.js";
import { analyze } from "../src/application/analyze.js";

const root = new URL("../", import.meta.url);
const schemaPath = fileURLToPath(new URL("schema/claim-result.v1.json", root));
const examplesDir = fileURLToPath(new URL("schema/examples/", root));

const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const ajv = new Ajv2020({ strict: true });
const validate = ajv.compile(schema);

async function readExample(name: string): Promise<unknown> {
  return JSON.parse(await readFile(examplesDir + name, "utf8"));
}

describe("claim schema validation", () => {
  it("is a valid JSON Schema document", () => {
    expect(ajv.validateSchema(schema)).toBe(true);
  });

  it("names the same version in $id and schemaVersion", () => {
    expect(schema.$id).toContain(`v${schema.properties.schemaVersion.const}`);
    expect(schema.properties.schemaVersion.const).toBe(CLAIM_SCHEMA_VERSION);
  });

  it("accepts the committed valid example", async () => {
    const valid = await readExample("valid-result.json");
    expect(validate(valid)).toBe(true);
  });

  it("rejects every committed invalid example", async () => {
    const files = await readdir(examplesDir);
    const invalid = files.filter((f) => f.startsWith("invalid-"));
    expect(invalid.length).toBeGreaterThanOrEqual(3);
    for (const file of invalid) {
      const doc = await readExample(file);
      expect(validate(doc), file).toBe(false);
      expect(() => assertValidResult(doc as AnalysisResult), file).toThrow(
        "invalid analysis result",
      );
    }
  });

  it("rejects a claim without evidence", async () => {
    const doc = await readExample("invalid-no-evidence.json");
    expect(validate(doc)).toBe(false);
  });

  it("defines no scoring, intent, or trace fields", () => {
    const claimProps = Object.keys(schema.$defs.claim.properties);
    for (const banned of ["score", "quality", "intent", "trace"]) {
      for (const prop of claimProps) {
        expect(prop).not.toContain(banned);
      }
    }
    expect(schema.$defs.claim.properties.confidence.maximum).toBe(1);
    expect(schema.$defs.claim.properties.confidence.minimum).toBe(0);
  });

  it("validates a value typed as AnalysisResult", () => {
    const result: AnalysisResult = {
      schemaVersion: CLAIM_SCHEMA_VERSION,
      claims: [
        {
          claim: "The export contains 3 elements.",
          evidence: [{ pointer: "/data/elements", elementId: "stats" }],
          provenance: {
            sourceFile: "export.json",
            exportVersion: "0.1.1",
            transform: [],
          },
          confidence: 0.8,
        },
      ],
    };
    expect(validate(result)).toBe(true);
    expect(() => assertValidResult(result)).not.toThrow();
  });

  it("validates the analyze() output against the schema", async () => {
    const fixture = fileURLToPath(
      new URL("test/fixtures/pfl-export/valid-report-minimal.json", root),
    );
    const { readPflExport } = await import("../src/input/pfl-export.js");
    const result = analyze(await readPflExport(fixture));
    expect(validate(result)).toBe(true);
  });
});
