# Release checklist

Reproducible steps to cut the current release. Every step must pass in
order. The 1.0 release additionally requires the gate in
[the 1.0 contract](1.0-contract.md).

## 1. Clean install

```text
git clone <repo> && cd gatefold   # or a fresh checkout of the release commit
pnpm install --frozen-lockfile
```

## 2. Verification gate

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test --run
pnpm build
```

`pnpm ci:all` runs all five in this order and must stay in sync with the
release gate in [the 1.0 contract](1.0-contract.md).

## 3. Package validation

```text
npm pack --dry-run --json
```

`prepack` runs `npm run build`, so the tarball always carries a fresh `dist/`
even from a clean checkout. Confirm the tarball contains `LICENSE`,
`bin/gatefold.js`, `dist/` (compiled output and
`.d.ts` files), `docs/` (including `docs/release-notes/`),
`SECURITY.md`, `schema/` (`claim-result.v1.json` through
`claim-result.v10.json`, including `schema/examples/` and the v4
trace-comparison, v5 run-comparison, v6 evaluation, v7
evaluation-comparison, v8 audit, v9 cell, v9 cell-comparison, and v10
repeated-cells examples), `README.md`,
and `package.json`. All of `docs/` is shipped intentionally — keep only
public-facing documentation in that directory. The tarball must not contain
`test/`, `node_modules/`, `src/`, or any agent or review artifacts.

Also confirm in `package.json`:

- `name` is `@shimpeiws/gatefold`
- `version` is the intended release version
- `bin.gatefold` points to `bin/gatefold.js`
- `engines.node` is `>=22.12.0` (Node.js 20 reached end-of-life in April 2026;
  22.12 is the minimum the locked dev tooling supports)
- `license` is `MIT` and `publishConfig.access` is `public` (required for the
  first publish of a scoped package)

## 3.5. Visibility decision (recorded, issue #98)

**Decision: the repository is public before the first publish.** A
private repository would 404 every GitHub link on the npm page, break
the README hero image (a relative path npm resolves against the
repository), and block `npm publish --provenance`. Before flipping
visibility:

- Scan the full history for secrets (`gitleaks git .` — committed
  dot-paths are only `.github/workflows/ci.yml` and `.gitignore`;
  `AGENTS.md` and the review-loop notes become public deliberately).
- Confirm `package.json` `repository.url` is
  `git+https://github.com/shimpeiws/gatefold.git` so npm renders the
  README's relative links and `docs/assets/gatefold-top.jpg` against
  the public repository.
- Schema `$id` scheme (frozen by the 1.0 contract): resolvable raw URLs
  `https://raw.githubusercontent.com/shimpeiws/gatefold/main/schema/claim-result.vN.json`.
  Schema files are frozen append-only artifacts, so the `main`-anchored
  URL dereferences permanently; `$id` values are identifiers first and
  never encode a release tag.
- Publish account check: `npm whoami` returns `shimpeiws` and 2FA is
  enabled for publish; publish with `--provenance` when supported by
  the publishing runner.

## 4. Publish dry-run

```text
npm publish --dry-run
```

Must succeed without publishing anything. This validates the package metadata,
the file list, and the bin entry against the real registry client.

## 5. Smoke test the packed artifact

```text
TARBALL=$(npm pack --json | jq -r '.[0].filename')
npm install -g "./$TARBALL"
gatefold --help
gatefold pfl-report.json --format json    # report document
gatefold pfl-export.json --format json    # export document
gatefold pfl-diff.json --format json      # diff document
gatefold compare   --before export-a.json   --after export-b.json   --diff diff.json --format json          # three-document comparison (v3)
gatefold compare-traces --before trace-a.json --after trace-b.json --format json                          # two-trace comparison (v4)
gatefold compare-runs --before run-a-dir --after run-b-dir --format json                                     # two-run-directory comparison (v5)
gatefold evaluate-run --run run-dir --spec task-spec.json --format json                                      # deprecated criterion evaluation (v6, frozen)
gatefold evaluate-run --run run-dir --spec task-spec.json --check-report check-report.json --format json    # deprecated: evaluation with an external check report
gatefold compare-evaluations --before run-a-dir --after run-b-dir --spec task-spec.json --format json        # deprecated evaluation comparison (v7, frozen)
gatefold audit-run --run run-dir --format json                                                              # single-run evidence audit (v8)
gatefold audit-run --run run-dir --check-report check-report.json --format json                             # audit with an external check report
gatefold report-cell --run run-dir --format json                                                            # single-cell evidence account (v9)
gatefold report-cell --run run-dir --evaluation evaluation-result.json --format json                        # cell report with an evaluation
gatefold compare-cells --before a-run-dir --after b-run-dir --format json                                    # A → B cell comparison (v9)
gatefold report-cells --run a-run-dir --run b-run-dir --format json                                          # repeated-cells account (v10)
pfl report --json | gatefold -            # stdin transport
pfl export --json | gatefold -            # stdin transport
pfl diff --json | gatefold -              # stdin transport
npm uninstall -g @shimpeiws/gatefold
```

Confirm every claim in the JSON output carries a `ruleId`, evidence pointers,
and provenance. For the v3 comparison result, confirm `schemaVersion` is 3,
`inputs` records all three documents, and every evidence entry names a
`source` (`before`/`after`/`diff`). For the v4 trace-comparison result,
confirm `schemaVersion` is 4, `inputs` records `beforeTrace`/`afterTrace`,
and every evidence entry names a `source` (`beforeTrace`/`afterTrace`)
whose pointer resolves inside that trace. For the v5 run-comparison result,
confirm `schemaVersion` is 5, `inputs` records `beforeRun`/`afterRun`, and
every evidence entry names a `source` that resolves inside the named run's
trace, manifest, or verified patch bytes. For the v6 evaluation result,
confirm `schemaVersion` is 6, `inputs` records `run`, `spec`, and
`checkReports`, and every evaluation entry carries a `verdict` of
`pass`/`fail`/`unknown` with resolving evidence. For the v7
evaluation-comparison result, confirm `schemaVersion` is 7, `inputs`
records `beforeRun`/`afterRun`/`spec`, and every transition carries
`before`/`after` verdicts with resolving evidence. For the v8 audit result,
confirm `schemaVersion` is 8, `source.command` is `audit-run`, `inputs`
records `run` and `checkReports`, and every fact carries a `state` of
`verified`/`inconsistent`/`unverifiable`/`not-recorded`, a `completeness` of
`complete`/`partial`/`unknown`, and evidence whose pointer resolves inside
the named document. For the v9 cell results, confirm `schemaVersion` is 9,
`source.command` is `report-cell` or `compare-cells`, `inputs` records
`run` or `beforeRun`/`afterRun`, and every entry carries a `lane`, a
`state`, a `completeness`, and evidence whose `source` and `pointer`
resolve inside the named run's trace, manifest, or verified stored bytes —
with the manifest-recorded digest attached to every citation of stored
bytes. For the v10 repeated-cells result, confirm `schemaVersion` is 10,
`inputs.runs` records one descriptor per supplied directory labelled
`run1`…`runN`, and `set` lane entries state the supplied/bound/eligible
counts — unbound runs named as unchecked, never counted as absent
records.

## 6. Tag and publish

Only after steps 1–5 pass. Publishing runs in CI
(`.github/workflows/release.yml`) so the tagged commit is always the
published commit and the package carries npm provenance:

```text
git checkout main && git pull          # release commit = the merge of the version-bump PR
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow re-runs `pnpm ci:all` on the tagged commit, refuses the tag
when `vX.Y.Z` does not match `package.json` `version`, and runs
`npm publish --provenance --access public`.

One-time registry setup: on npmjs.com under the package's
Settings → Trusted Publishing, add GitHub Actions as the publisher with
repository `shimpeiws/gatefold` and workflow filename `release.yml`.
With that configured no `NODE_AUTH_TOKEN` secret is needed; without it
the publish step needs a granular automation token as `NODE_AUTH_TOKEN`.
Local `npm publish` cannot attach provenance (`provider: null`) — run
publishes through the tag, not from a checkout.
