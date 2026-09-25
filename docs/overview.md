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

The initial implementation uses only the `pfl` export boundary. Future versions can add observed traces without changing the claim concept.

## Command

```text
gatefold <input.json> --format human
gatefold <input.json> --format json
```

The initial scaffold returns an empty claim collection. Analysis rules will be added after the input and claim schemas are stable.
