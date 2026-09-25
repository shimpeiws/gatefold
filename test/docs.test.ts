import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

const scopePath = fileURLToPath(
  new URL("../docs/v0.1-scope.md", import.meta.url),
);
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const contractPath = fileURLToPath(
  new URL("../docs/pfl-export-contract.md", import.meta.url),
);

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

describe("v0.2 scope document", () => {
  const v02ScopePath = fileURLToPath(
    new URL("../docs/v0.2-scope.md", import.meta.url),
  );

  it("exists and covers the required scope topics in English", async () => {
    const doc = await readFile(v02ScopePath, "utf8");
    for (const section of [
      "## Supported input",
      "## Output guarantees",
      "## Observation-certainty claims",
      "## Excluded features",
      "## Compatibility policy",
      "## Release gate",
    ]) {
      expect(doc).toContain(section);
    }
    for (const excluded of [
      "declared intent",
      "yuurei",
      "scoring",
      "optimization",
    ]) {
      expect(doc.toLowerCase()).toContain(excluded.toLowerCase());
    }
  });

  it("defines claim bounds for every completeness value", async () => {
    const doc = await readFile(v02ScopePath, "utf8");
    const section = doc.slice(doc.indexOf("## Observation-certainty claims"));
    for (const value of ["`complete`", "`partial`", "`unknown`"]) {
      expect(section).toContain(value);
    }
  });

  it("keeps the release gate in sync with pnpm ci:all", async () => {
    const doc = await readFile(v02ScopePath, "utf8");
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
    expect(doc).toContain("npm pack");
  });

  it("maps every v0.2 issue to the scope", async () => {
    const doc = await readFile(v02ScopePath, "utf8");
    const mapping = doc.slice(doc.indexOf("## Issue mapping"));
    for (const issue of [12, 13, 14, 15, 16, 17, 18, 19]) {
      expect(mapping).toContain(`#${issue}`);
    }
  });

  it("records out-of-scope work for a later milestone", async () => {
    const doc = await readFile(v02ScopePath, "utf8");
    expect(doc).toContain("## Out-of-scope record");
  });
});

describe("pfl export contract document", () => {
  it("covers the acceptance-relevant rules", async () => {
    const doc = await readFile(contractPath, "utf8");
    for (const section of [
      "## Accepted document",
      "## Envelope",
      "## Unknown fields",
      "## Compatibility",
      "## Evidence locations",
      "## Error behavior",
      "## Fixtures",
    ]) {
      expect(doc).toContain(section);
    }
    expect(doc).toContain(">=1.0.0 <2.0.0");
    expect(doc).toContain('"report"');
    expect(doc).toContain("ok: false");
  });
});

describe("release documentation", () => {
  it("release checklist enumerates every release-gate command in order", async () => {
    const checklist = await readFile(
      `${root}docs/release-checklist.md`,
      "utf8",
    );
    let position = 0;
    for (const step of [
      "pnpm install --frozen-lockfile",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm format:check",
      "pnpm test --run",
      "pnpm build",
      "npm pack",
      "npm publish --dry-run",
    ]) {
      const found = checklist.indexOf(step, position);
      expect(found, step).toBeGreaterThanOrEqual(position);
      position = found;
    }
  });

  it("README links to every doc in docs/", async () => {
    const readme = await readFile(`${root}README.md`, "utf8");
    const docs = (await readdir(`${root}docs`)).filter((f) =>
      f.endsWith(".md"),
    );
    expect(docs.length).toBeGreaterThanOrEqual(7);
    for (const doc of docs) {
      expect(readme, doc).toContain(`](docs/${doc})`);
    }
  });

  it("every relative markdown link in README and docs resolves", async () => {
    for (const file of [
      "README.md",
      ...(await readdir(`${root}docs`)).map((f) => `docs/${f}`),
    ]) {
      const text = await readFile(`${root}${file}`, "utf8");
      const linkPattern =
        /\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
      for (const [, raw] of text.matchAll(linkPattern)) {
        const target = raw.replace(/^<|>$/g, "");
        if (/^[a-z]+:/.test(target) || target.startsWith("#")) continue;
        const resolved = new URL(target, `file://${root}${file}`);
        await expect(
          access(fileURLToPath(resolved)),
          `${file} -> ${target}`,
        ).resolves.toBeUndefined();
      }
    }
  });

  it("contains no stale scaffold-era claims", async () => {
    for (const file of [
      "README.md",
      ...(await readdir(`${root}docs`))
        .filter((f) => f.endsWith(".md"))
        .map((f) => `docs/${f}`),
    ]) {
      const text = await readFile(`${root}${file}`, "utf8");
      expect(text, file).not.toContain("empty claim collection");
      expect(text, file).not.toMatch(/scaffold/i);
    }
  });
});
