import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readPflExport } from "../src/input/pfl-export.js";

describe("readPflExport", () => {
  it("reads a top-level object", async () => {
    const result = await readPflExport("test/fixtures/minimal-pfl-export.json");
    expect(result).toMatchObject({ schema_version: "draft" });
  });

  it("rejects invalid JSON", async () => {
    const path = "/tmp/gatefold-invalid.json";
    await writeFile(path, "not-json", "utf8");
    await expect(readPflExport(path)).rejects.toThrow("not valid JSON");
  });

  it("rejects non-object JSON", async () => {
    const path = "/tmp/gatefold-array.json";
    await writeFile(path, "[]", "utf8");
    await expect(readPflExport(path)).rejects.toThrow("top level");
  });
});
