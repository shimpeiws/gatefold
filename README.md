# Gatefold

Gatefold is an evidence-backed judgement layer for coding-agent harnesses.
It reads a [`pfl`](docs/pfl-export-contract.md) JSON document — a
`pfl report --json` aggregate, a `pfl export --json` full snapshot, or a
`pfl diff --json` A → B comparison — and, since v0.5, a pair of
[`yuurei`](docs/yuurei-trace-contract.md) `trace.json` run records, and
since v0.6 a pair of whole
[`yuurei` run directories](docs/yuurei-run-contract.md) including their
artifact manifests and `patch.diff` records, and since v0.7 an explicit
[task-evaluation spec](docs/v0.7-scope.md) it can evaluate a
[seeded run](docs/yuurei-seeded-run-contract.md) against. It emits
descriptive claims, each with evidence, provenance, and confidence. It does
not score or rank harnesses.

## CLI usage

```text
gatefold <input.json>                          # human-readable claims
gatefold <input.json> --format json            # machine-readable, schema-validated
gatefold <input.json> --min-confidence 0.8     # drop claims below the threshold
pfl report --json | gatefold -                 # read a document from stdin
pfl export --json | gatefold -                 # full snapshot: elements, relations, findings
pfl diff --json   | gatefold -                 # A → B comparison
gatefold compare --before a.json --after b.json --diff d.json
                                               # contextual A → B comparison
                                               # across the three documents
gatefold compare-traces --before a.trace.json --after b.trace.json
                                               # observed A → B comparison of
                                               # two yuurei runs (schema v4)
gatefold compare-runs --before a-run-dir --after b-run-dir
                                               # A → B comparison of two
                                               # yuurei run directories,
                                               # artifacts included (schema v5)
gatefold evaluate-run --run run-dir --spec task-spec.json \
                      [--check-report report.json] ...
                                               # per-criterion pass/fail/unknown
                                               # verdicts (schema v6)
gatefold compare-evaluations --before a-run-dir --after b-run-dir \
                             --spec task-spec.json \
                             [--before-check-report f] [--after-check-report f] ...
                                               # per-criterion A → B verdict
                                               # transitions (schema v7)
```

`compare-traces` compares two yuurei `trace.json` runs only when they
recorded the same task content and compatible execution conditions; the
profile/harness variant is allowed to differ — that difference is the
subject of the comparison. Every claim cites JSON Pointers into the named
input trace (`beforeTrace`/`afterTrace`). Missing optional fields are
reported as unknown, `null` as unobserved; neither becomes a zero, a score,
or a verdict. See [v0.5 scope](docs/v0.5-scope.md) for the comparability and
result contract.

`compare-runs` takes two yuurei run directories. Each must contain
`trace.json` and `artifacts.json`; a `patch.diff` listed in the manifest is
read only after its stored bytes verify against the manifest's recorded
digest. The v0.5 comparability checks apply unchanged, then the generated
files each patch records are compared — files only on one side and files
whose content differs — with each claim citing the manifest JSON Pointer,
the artifact digest, and a bounded line/byte range into the stored patch.
Missing, truncated, digest-mismatched, and unverifiable artifacts are
reported as such, never as absent output. See
[v0.6 scope](docs/v0.6-scope.md) for the full contract.

`evaluate-run` binds a task-evaluation spec to one run directory: the
spec's `task.digest` (and `baseline.digest` when declared) must match the
run. Each declarative criterion resolves to `pass`, `fail`, or `unknown`
from verified evidence only — the baseline-relative `patch.diff`, the
verified `result.txt`, or an independently produced check report that
declares the run's subject digests. `compare-evaluations` applies the same
evaluation to two comparable runs and reports each criterion's A → B
transition. Missing, truncated, unverifiable, or contradictory evidence is
`unknown`, never a pass or fail; no aggregate score is emitted. See
[v0.7 scope](docs/v0.7-scope.md) and the
[seeded-run contract](docs/yuurei-seeded-run-contract.md).

Every claim carries a stable `ruleId`, evidence pointers, provenance, and a
confidence score — see [the claim model](docs/claim-model.md).

Exit codes: `0` success, `2` usage error, `3` input error, `4` internal error.
Errors are written to stderr only.

## Development

Gatefold uses Node.js 22.12 or later and pnpm.

```text
pnpm install
pnpm ci:all    # typecheck, lint, format check, tests, build
```

## Documentation

- [Project overview](docs/overview.md)
- [v0.1 scope and acceptance criteria](docs/v0.1-scope.md)
- [v0.2 scope and acceptance criteria](docs/v0.2-scope.md)
- [v0.3 scope and input contract](docs/v0.3-scope.md)
- [v0.4 scope and comparison contract](docs/v0.4-scope.md)
- [v0.5 scope and run-comparison contract](docs/v0.5-scope.md)
- [v0.6 scope and run-directory comparison contract](docs/v0.6-scope.md)
- [v0.7 scope and Outcome-evaluation contract](docs/v0.7-scope.md)
- [Architecture](docs/architecture.md)
- [Claim model and schema](docs/claim-model.md)
- [pfl export contract](docs/pfl-export-contract.md)
- [yuurei trace contract](docs/yuurei-trace-contract.md)
- [yuurei run-directory contract](docs/yuurei-run-contract.md)
- [yuurei seeded-run contract](docs/yuurei-seeded-run-contract.md)
- [Descriptive rules](docs/rules.md)
- [Release checklist](docs/release-checklist.md)

## License

[MIT](LICENSE)
