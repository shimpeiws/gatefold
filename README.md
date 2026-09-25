# Gatefold

Gatefold is an evidence-backed judgement layer for coding-agent harnesses.
It reads a [`pfl`](docs/pfl-export-contract.md) JSON export and emits
descriptive claims — each with evidence, provenance, and confidence. It does
not score or rank harnesses.

## CLI usage

```text
gatefold <input.json>                          # human-readable claims
gatefold <input.json> --format json            # machine-readable, schema-validated
gatefold <input.json> --min-confidence 0.8     # drop claims below the threshold
```

Exit codes: `0` success, `2` usage error, `3` input error, `4` internal error.
Errors are written to stderr only.

## Development

Gatefold uses Node.js 20 or later and pnpm.

```text
pnpm install
pnpm ci:all    # typecheck, lint, format check, tests, build
```

## Documentation

- [Project overview](docs/overview.md)
- [v0.1 scope and acceptance criteria](docs/v0.1-scope.md)
- [Architecture](docs/architecture.md)
- [Claim model and schema](docs/claim-model.md)
- [pfl export contract](docs/pfl-export-contract.md)
- [Descriptive rules](docs/rules.md)
- [Release checklist](docs/release-checklist.md)

## License

[MIT](LICENSE)
