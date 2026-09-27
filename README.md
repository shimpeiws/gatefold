# Gatefold

Gatefold is an evidence-backed judgement layer for coding-agent harnesses.
It reads a [`pfl`](docs/pfl-export-contract.md) JSON document — a
`pfl report --json` aggregate, a `pfl export --json` full snapshot, or a
`pfl diff --json` A → B comparison — and
emits descriptive claims, each with evidence, provenance, and confidence. It
does not score or rank harnesses.

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
```

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
- [Architecture](docs/architecture.md)
- [Claim model and schema](docs/claim-model.md)
- [pfl export contract](docs/pfl-export-contract.md)
- [yuurei trace contract](docs/yuurei-trace-contract.md)
- [Descriptive rules](docs/rules.md)
- [Release checklist](docs/release-checklist.md)

## License

[MIT](LICENSE)
