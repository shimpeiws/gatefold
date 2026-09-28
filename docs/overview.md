# Gatefold overview

Gatefold is an open-source evidence layer for coding-agent harnesses:
it validates inputs, binds identity, audits stored records, and compares
what was observed — criterion verdicts belong to the separate `analyze`
layer (the v0.7 `evaluate-run`/`compare-evaluations` commands remain as a
deprecated, frozen compatibility surface; see
[the ownership decision](v0.7-scope.md#ownership-and-deprecation)).

Gatefold reads a normalized harness export and emits claims. Each claim carries evidence, provenance, and confidence. Gatefold does not reduce a harness to one health score.

## v0.1 scope

The first release accepts a `pfl` JSON export and produces human-readable or machine-readable claims.

The first release describes what the export contains. It does not decide whether the harness is good or bad.

The first release excludes declared intent, `yuurei` trace input, and score calculation.

The full boundary — supported input, output guarantees, exclusions, compatibility policy, and the release gate — is defined in [v0.1 scope](v0.1-scope.md).

## Tool relationships

`pfl` provides the encoded harness representation. `yuurei` provides observed execution traces. Gatefold interprets these inputs.

The `pfl` export boundary came first; v0.5 adds the `yuurei` trace boundary for observed run comparison (`compare-traces`), and v0.6 extends it to whole run directories (`compare-runs`) with digest-verified artifact evidence — without changing the claim concept.

## Command

```text
gatefold <input.json> --format human
gatefold <input.json> --format json --min-confidence 0.8
pfl report --json | gatefold -
gatefold compare --before a.json --after b.json --diff d.json
gatefold compare-traces --before a.trace.json --after b.trace.json
gatefold compare-runs --before a-run-dir --after b-run-dir
```

A lone `-` reads the export from standard input. After `--`, `-` names a file
literally.

`--min-confidence` keeps only claims at or above the threshold. Exit codes are stable: `0` success, `2` usage error, `3` input error, `4` internal error.

The descriptive rule set is documented in [rules](rules.md).
