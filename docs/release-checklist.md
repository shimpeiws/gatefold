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
`.d.ts` files), `docs/`, `schema/` (`claim-result.v1.json` through
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
- `bin.gatefold` points to `./bin/gatefold.js`
- `engines.node` is `>=22.12.0` (Node.js 20 reached end-of-life in April 2026;
  22.12 is the minimum the locked dev tooling supports)
- `license` is `MIT` and `publishConfig.access` is `public` (required for the
  first publish of a scoped package)

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

Only after steps 1–5 pass: tag the release commit and run the real publish
from a clean checkout. No manual build is needed first: `prepack` builds
`dist/` before the tarball is created.
