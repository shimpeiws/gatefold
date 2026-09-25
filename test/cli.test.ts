import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const input = fileURLToPath(
  new URL("fixtures/pfl-export/valid-report-minimal.json", import.meta.url),
);

describe("gatefold CLI", () => {
  it("returns JSON with a schema-versioned claim collection", async () => {
    const output = await runCli([input, "--format", "json"]);
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.claims)).toBe(true);
    expect(parsed.claims.length).toBeGreaterThan(0);
  });

  it("returns human-readable claims", async () => {
    const output = await runCli([input, "--format=human"]);
    expect(output).toContain("1. The export describes a 'codex' harness");
    expect(output).toContain("pfl observed 0 elements");
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
