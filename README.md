# Gatefold

Gatefold is an evidence-backed judgement layer for coding-agent harnesses.

## Development

Gatefold uses Node.js 20 or later and pnpm.

```text
pnpm install
pnpm ci:all
```

## CLI usage

```text
gatefold path/to/pfl-export.json --format human
gatefold path/to/pfl-export.json --format json
```

The scaffold validates the input JSON and returns an empty claim collection. It does not yet implement descriptive analysis rules.

Read the [project overview](docs/overview.md), [v0.1 scope](docs/v0.1-scope.md), [architecture](docs/architecture.md), and [claim model](docs/claim-model.md) for the design.
