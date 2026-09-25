import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const scopePath = "docs/v0.1-scope.md";

describe("v0.1 scope document", () => {
  it("exists and covers the required scope topics in English", async () => {
    const doc = await readFile(scopePath, "utf8");
    for (const section of [
      "## Supported input",
      "## Output guarantees",
      "## Excluded features",
      "## Compatibility policy",
      "## Release gate",
    ]) {
      expect(doc).toContain(section);
    }
    for (const excluded of ["declared intent", "yuurei", "scoring"]) {
      expect(doc.toLowerCase()).toContain(excluded.toLowerCase());
    }
  });

  it("maps every v0.1 issue to the scope", async () => {
    const doc = await readFile(scopePath, "utf8");
    const mapping = doc.slice(doc.indexOf("## Issue mapping"));
    for (const issue of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(mapping).toContain(`#${issue}`);
    }
  });

  it("records out-of-scope work for a later milestone", async () => {
    const doc = await readFile(scopePath, "utf8");
    expect(doc).toContain("## Out-of-scope record");
  });
});
