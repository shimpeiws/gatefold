import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const input = fileURLToPath(
  new URL("fixtures/pfl-export/valid-report-minimal.json", import.meta.url),
);

describe("gatefold CLI", () => {
  it("returns JSON with an empty claim collection", async () => {
    await expect(runCli([input, "--format", "json"])).resolves.toBe(
      '{\n  "schemaVersion": 1,\n  "claims": []\n}',
    );
  });

  it("returns a human-readable empty result", async () => {
    await expect(runCli([input, "--format=human"])).resolves.toBe(
      "No claims found.",
    );
  });

  it("prints usage for help", async () => {
    await expect(runCli(["--help"])).resolves.toContain("Usage: gatefold");
  });

  it("rejects unsupported formats", async () => {
    await expect(runCli([input, "--format", "yaml"])).rejects.toThrow(
      "either human or json",
    );
  });

  it("requires an input file", async () => {
    await expect(runCli([])).rejects.toThrow("input JSON file is required");
  });
});
