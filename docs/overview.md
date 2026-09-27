# Gatefold overview

Gatefold is an open-source judgement layer for coding-agent harnesses.

Gatefold reads a normalized harness export and emits claims. Each claim carries evidence, provenance, and confidence. Gatefold does not reduce a harness to one health score.

## v0.1 scope

The first release accepts a `pfl` JSON export and produces human-readable or machine-readable claims.

The first release describes what the export contains. It does not decide whether the harness is good or bad.

The first release excludes declared intent, `yuurei` trace input, and score calculation.

The full boundary — supported input, output guarantees, exclusions, compatibility policy, and the release gate — is defined in [v0.1 scope](v0.1-scope.md).

## Tool relationships

`pfl` provides the encoded harness representation. `yuurei` provides observed execution traces. Gatefold interprets these inputs.

The `pfl` export boundary came first; v0.5 adds the `yuurei` trace boundary for observed run comparison (`compare-traces`) without changing the claim concept.

## Command

```text
gatefold <input.json> --format human
gatefold <input.json> --format json --min-confidence 0.8
pfl report --json | gatefold -
gatefold compare --before a.json --after b.json --diff d.json
gatefold compare-traces --before a.trace.json --after b.trace.json
```

A lone `-` reads the export from standard input. After `--`, `-` names a file
literally.

`--min-confidence` keeps only claims at or above the threshold. Exit codes are stable: `0` success, `2` usage error, `3` input error, `4` internal error.

The descriptive rule set is documented in [rules](rules.md).
