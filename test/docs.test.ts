import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scopePath = fileURLToPath(
  new URL("../docs/v0.1-scope.md", import.meta.url),
);
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

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

  it("pins the compatibility policy rules", async () => {
    const doc = await readFile(scopePath, "utf8");
    const policy = doc.slice(doc.indexOf("## Compatibility policy"));
    expect(policy).toContain("non-zero exit");
    expect(policy).toContain("ignore unknown fields");
    expect(policy).toContain("versioned");
  });

  it("keeps the release gate in sync with pnpm ci:all", async () => {
    const doc = await readFile(scopePath, "utf8");
    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    const ciAll = pkg.scripts["ci:all"];
    for (const check of [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm format:check",
      "pnpm test --run",
      "pnpm build",
    ]) {
      expect(doc).toContain(`\`${check}\``);
      expect(ciAll).toContain(check);
    }
    expect(doc).toContain("npm publish --dry-run");
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
